/**
 * Background service worker.
 *
 * It exists for one reason: MV3 removed cross-origin privileges from content
 * scripts, so the overlay running on app.uniswap.org cannot call an RPC
 * directly — it would be subject to that page's CORS. All network access stays
 * in the extension context here, behind the manifest's host_permissions, and
 * the content script only ever receives finished data.
 *
 * This worker holds no wallet capability. It issues the methods in
 * RPC_METHODS (eth_call, eth_getLogs, eth_getBlockByNumber,
 * eth_getTransactionReceipt), all reads,
 * exactly as the popup does.
 */
import { loadPositionByVersion, loadPositions } from './lib/positions.js';
import { entitlement, historyRelayCredentials } from './lib/license.js';
import { CHAINS } from './lib/chains.js';

const inFlight = new Map();  // `${chain}:${tokenId}` -> Promise
const dexscreenerScanCache = new Map();
const dexscreenerPairCache = new Map();
const DEXSCREENER_CACHE_MS = 60_000;
const DEXSCREENER_PAIR_CACHE_MS = 10 * 60_000;
const DEXSCREENER_OVERLAY_ORIGIN = 'https://dexscreener.com/*';

async function dexscreenerPageAccess(sender) {
  try {
    const senderUrl = new URL(String(sender && sender.tab && sender.tab.url || ''));
    if (senderUrl.origin !== 'https://dexscreener.com') return false;
    return await chrome.permissions.contains({ origins: [DEXSCREENER_OVERLAY_ORIGIN] });
  } catch {
    return false;
  }
}

// Concurrency limit across ALL callers. One position load issues 6-10 fetches,
// so an unexpected burst of requests multiplies straight into the network
// stack. Without this and the in-flight map below, a content script that
// rescans in a loop can put thousands of concurrent fetches in flight and take
// the whole browser down rather than just wedging a tab.
const MAX_CONCURRENT = 4;
let active = 0;
const waiting = [];

function slot() {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else active--;
}

async function cachedDexscreenerPositions(chainKey, address, store) {
  const key = `${chainKey}:${address}`;
  const existing = dexscreenerScanCache.get(key);
  if (existing && existing.data && Date.now() - existing.at < DEXSCREENER_CACHE_MS) {
    return existing.data;
  }
  if (existing && existing.promise) return existing.promise;

  const promise = (async () => {
    await slot();
    try {
      const overrides = store.rpcOverrides || {};
      const historyRelay = await historyRelayCredentials();
      const result = await loadPositions(chainKey, address, {
        includeClosed: false,
        withUsd: true,
        rpcOverride: overrides[chainKey] || undefined,
        rpcOverrides: overrides,
        etherscanKey: store.etherscanKey || undefined,
        historyRelay,
      });
      return result.positions || [];
    } finally {
      release();
    }
  })();
  dexscreenerScanCache.set(key, { promise });
  try {
    const data = await promise;
    dexscreenerScanCache.set(key, { data, at: Date.now() });
    return data;
  } catch (err) {
    dexscreenerScanCache.delete(key);
    throw err;
  }
}

async function cachedDexscreenerPair(chainKey, poolRef) {
  // This request contains only the two values already present in the pair-page
  // URL. The active LPLens wallet is deliberately not accepted by this helper.
  const key = `${chainKey}:${poolRef}`;
  const existing = dexscreenerPairCache.get(key);
  if (existing && Object.prototype.hasOwnProperty.call(existing, 'data')
      && Date.now() - existing.at < DEXSCREENER_PAIR_CACHE_MS) {
    return existing.data;
  }
  if (existing && existing.promise) return existing.promise;

  const promise = (async () => {
    const chain = CHAINS[chainKey];
    const apiChain = String(chain && chain.dexscreener || '').toLowerCase();
    if (!apiChain) return null;
    const url = `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(apiChain)}/${encodeURIComponent(poolRef)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Dexscreener pair lookup failed: HTTP ${response.status}`);
    const json = await response.json();
    const candidates = Array.isArray(json && json.pairs) ? json.pairs : [];
    const pair = candidates.find((item) =>
      String(item && item.pairAddress || '').toLowerCase() === poolRef);
    if (!pair) return null;

    const token = (value) => {
      const address = String(value && value.address || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) return null;
      return { address, symbol: String(value && value.symbol || '').slice(0, 32) };
    };
    const baseToken = token(pair.baseToken);
    const quoteToken = token(pair.quoteToken);
    const positiveNumber = (value) => {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? number : null;
    };
    return baseToken && quoteToken ? {
      baseToken,
      quoteToken,
      priceNative: positiveNumber(pair.priceNative),
      priceUsd: positiveNumber(pair.priceUsd),
      marketCap: positiveNumber(pair.marketCap),
      fdv: positiveNumber(pair.fdv),
    } : null;
  })();

  dexscreenerPairCache.set(key, { promise });
  try {
    const data = await promise;
    dexscreenerPairCache.set(key, { data, at: Date.now() });
    return data;
  } catch (err) {
    dexscreenerPairCache.delete(key);
    throw err;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'LPLENS_POSITION') return false;

  const key = `${msg.chain}:${msg.version || 'v3'}:${msg.tokenId}`;

  // Coalesce only concurrently in-flight requests. Completed results are not
  // cached: after Increase/Decrease/Collect, reloading the Uniswap page must
  // read the just-mined state rather than replay a plausible 30-second-old one.
  // Entitlement is checked inside the job, before any relay or RPC, so a
  // patched content script still gets nothing back and an expired key cannot
  // send address-bearing filters to the Worker.
  let job = inFlight.get(key);
  if (!job) {
    job = (async () => {
      try {
        const ent = await entitlement();
        // GATING_ENABLED false => allowed:true. Invite-only: needs_key /
        // misconfigured / invalid all have allowed:false and land here.
        if (!ent.allowed) return { ok: false, gated: true, entitlement: ent };
        await slot();
        try {
          const store = await chrome.storage.local.get(['rpcOverrides', 'etherscanKey']);
          const overrides = store.rpcOverrides || {};
          const historyRelay = await historyRelayCredentials();
          const data = await loadPositionByVersion(msg.chain, msg.version || 'v3', BigInt(msg.tokenId), {
            rpcOverride: overrides[msg.chain] || undefined,
            // Bridged USD pricing can need a second chain. Robinhood WETH, for
            // example, maps the local event time to Ethereum and reads the
            // historical USDC/WETH pool there. Passing only the local override
            // made the popup exact while the on-page overlay silently lost its
            // Ethereum archive endpoint and fell back to a vs-holding percent.
            rpcOverrides: overrides,
            etherscanKey: store.etherscanKey || undefined,
            historyRelay,
          });
          // BigInt does not survive structured clone to the content script.
          const safe = JSON.parse(JSON.stringify(data, (_k, v) =>
            typeof v === 'bigint' ? v.toString() : v));
          return { ok: true, data: safe };
        } finally {
          release();
        }
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, job);
  }

  job.then(
    (result) => sendResponse(result),
    (err) => sendResponse({ ok: false, error: err.message || String(err) }),
  );

  return true; // keep the message channel open for the async reply
});

// Dexscreener pair pages expose a chain slug and pool identifier in the URL.
// The content script passes only those two route values. As with ProjectX, the
// address comes exclusively from the active overlay-wallet selection in
// LPLens, never from the page or a connected wallet.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'LPLENS_DEXSCREENER_POOL') return false;

  (async () => {
    if (!(await dexscreenerPageAccess(sender))) {
      return {
        ok: false,
        permissionRevoked: true,
        error: 'Dexscreener page access is off. Re-enable it in Settings and refresh this page.',
      };
    }
    const ent = await entitlement();
    if (!ent.allowed) return { ok: false, gated: true, entitlement: ent };

    const chainKey = String(msg.chain || '').toLowerCase();
    const poolRef = String(msg.poolRef || '').toLowerCase();
    if (!CHAINS[chainKey] || !/^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(poolRef)) {
      return { ok: false, error: 'This Dexscreener pair route is not supported.' };
    }

    const store = await chrome.storage.local.get([
      'address', 'rpcOverrides', 'etherscanKey',
    ]);
    const address = String(store.address || '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      return { ok: false, error: 'Open LPLens and select an overlay wallet first.' };
    }

    const allPositions = await cachedDexscreenerPositions(chainKey, address, store);
    const positions = allPositions.filter((position) => {
      const id = String(position.version === 'v4' ? position.poolId : position.pool || '')
        .toLowerCase();
      return id === poolRef;
    });
    let pair = null;
    let pairError = null;
    if (positions.length) {
      try {
        pair = await cachedDexscreenerPair(chainKey, poolRef);
        if (!pair) pairError = 'pair-metadata-unavailable';
      } catch {
        pairError = 'pair-metadata-unavailable';
      }
    }
    const usdRef = CHAINS[chainKey].usdRef || {};
    const wrappedNative = usdRef.nativeEquivalent ? String(usdRef.weth || '').toLowerCase() : '';
    const safe = JSON.parse(JSON.stringify({ address, positions, pair, pairError, wrappedNative }, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value));
    return { ok: true, data: safe };
  })().then(
    (result) => sendResponse(result),
    (err) => sendResponse({ ok: false, error: err.message || String(err) }),
  );

  return true;
});

/* BEGIN LPLENS DEXSCREENER MAIN-WORLD EXPERIMENT
 *
 * LPLENS_LOCAL_CHART_EXPERIMENT
 *
 * This is intentionally a local feasibility experiment. A single, synchronous
 * MAIN-world call measures Dexscreener's chart coordinate system, then exits.
 * It never installs a listener, sends a page message, creates a TradingView
 * drawing, or reads wallet/provider state. The caller still discloses the three
 * anonymous LP price bounds to page-world code, which is why this marker is a
 * hard packaging fence rather than a production feature flag.
 */
const LPLENS_LOCAL_CHART_EXPERIMENT = true;

function sanitizeDexscreenerChartRequest(msg, sender) {
  const fail = (reason) => ({ ok: false, reason });
  if (!msg || msg.type !== 'LPLENS_DEXSCREENER_CHART_GEOMETRY') {
    return fail('invalid-request');
  }

  const tabId = sender && sender.tab && sender.tab.id;
  const tabHref = sender && sender.tab && sender.tab.url;
  if (!Number.isInteger(tabId) || tabId < 0 || typeof tabHref !== 'string') {
    return fail('invalid-sender');
  }

  if (typeof msg.href !== 'string' || msg.href.length < 1 || msg.href.length > 2048
      || msg.href !== tabHref) {
    return fail('stale-route');
  }

  let url;
  try {
    url = new URL(msg.href);
  } catch {
    return fail('invalid-request');
  }
  if (url.origin !== 'https://dexscreener.com') return fail('invalid-request');
  const parts = url.pathname.split('/').filter(Boolean);
  const chainSlug = String(parts[0] || '').toLowerCase();
  const poolRef = String(parts[1] || '').toLowerCase();
  if (parts.length !== 2 || !/^[a-z0-9-]{1,40}$/.test(chainSlug)
      || !/^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(poolRef)) {
    return fail('invalid-request');
  }

  if (!Array.isArray(msg.ranges) || msg.ranges.length < 1 || msg.ranges.length > 3) {
    return fail('invalid-ranges');
  }
  const ranges = [];
  for (let index = 0; index < msg.ranges.length; index++) {
    const item = msg.ranges[index];
    const expectedId = `r${index}`;
    if (!item || typeof item !== 'object' || Array.isArray(item) || item.id !== expectedId) {
      return fail('invalid-ranges');
    }
    const { lo, now, hi } = item;
    if (![lo, now, hi].every((value) => typeof value === 'number'
        && Number.isFinite(value) && value > 0) || !(lo < hi)) {
      return fail('invalid-ranges');
    }
    // `now` may legitimately sit outside [lo, hi] for an out-of-range LP.
    ranges.push({ id: expectedId, lo, now, hi });
  }

  return {
    ok: true,
    tabId,
    href: msg.href,
    chainSlug,
    poolRef,
    ranges,
  };
}

// This function must remain self-contained: Chrome serializes only the
// function itself into Dexscreener's MAIN world, not this module's closure.
function measureDexscreenerChart(payload) {
  const fail = (reason) => ({ ok: false, reason });
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const positive = (value) => finite(value) && value > 0;

  try {
    if (!payload || typeof payload !== 'object' || payload.href !== location.href
        || !Array.isArray(payload.ranges) || payload.ranges.length < 1
        || payload.ranges.length > 3) {
      return fail('stale-route');
    }

    const ranges = [];
    for (let index = 0; index < payload.ranges.length; index++) {
      const item = payload.ranges[index];
      const expectedId = `r${index}`;
      if (!item || typeof item !== 'object' || item.id !== expectedId
          || !positive(item.lo) || !positive(item.now) || !positive(item.hi)
          || !(item.lo < item.hi)) {
        return fail('invalid-ranges');
      }
      ranges.push({ id: expectedId, lo: item.lo, now: item.now, hi: item.hi });
    }

    const pair = payload.pair && typeof payload.pair === 'object' ? payload.pair : {};
    const pairValue = (name) => positive(pair[name]) ? pair[name] : null;
    const frames = Array.from(document.querySelectorAll('iframe[title="Financial Chart"]'));
    const candidates = [];
    for (const frame of frames) {
      try {
        const frameWindow = frame.contentWindow;
        const frameDocument = frame.contentDocument;
        const api = frameWindow && frameWindow.tradingViewApi;
        if (!frameWindow || !frameDocument || !api || typeof api.activeChart !== 'function') continue;
        const chart = api.activeChart();
        if (chart) candidates.push({ frame, frameWindow, frameDocument, chart });
      } catch {
        // Cross-origin or incomplete frames are deliberately ignored.
      }
    }
    if (candidates.length !== 1) {
      return fail(candidates.length > 1 ? 'chart-frame-ambiguous' : 'chart-frame-unavailable');
    }

    const { frame, frameWindow, frameDocument, chart } = candidates[0];
    if (typeof chart.getPanes !== 'function') return fail('chart-api-unavailable');
    const panes = chart.getPanes();
    const pane = Array.isArray(panes) && panes[0];
    if (!pane || typeof pane.getMainSourcePriceScale !== 'function') {
      return fail('chart-api-unavailable');
    }
    const scaleFacade = pane.getMainSourcePriceScale();
    const rawMode = scaleFacade && typeof scaleFacade.getMode === 'function'
      ? scaleFacade.getMode() : null;
    const scaleMode = rawMode && typeof rawMode === 'object' ? rawMode.mode : rawMode;
    if (scaleMode !== 0 && scaleMode !== 1) return fail('unsupported-price-scale');
    const privateScale = scaleFacade && scaleFacade._priceScale;
    if (!privateScale || typeof privateScale.priceToCoordinate !== 'function') {
      return fail('chart-api-unavailable');
    }

    const titleRoots = [document, frameDocument];
    const titles = [];
    for (const root of titleRoots) {
      for (const node of Array.from(root.querySelectorAll('[title]'))) {
        const title = String(node.getAttribute('title') || '').trim();
        if (title) titles.push(title);
      }
    }
    const normalizedTitles = titles.map((title) => title.toLowerCase());
    const priceSignal = normalizedTitles.includes('switch to market cap chart');
    const marketCapSignal = normalizedTitles.includes('switch to price chart');
    if (priceSignal === marketCapSignal) return fail('unsupported-chart-mode');
    const chartKind = priceSignal ? 'price' : 'mcap';

    const unitSignals = new Set();
    for (const title of titles) {
      if (title.toLowerCase() === 'switch to usd price') {
        unitSignals.add('native');
        continue;
      }
      const match = /^switch to price in\s+(.+)$/i.exec(title);
      if (!match) continue;
      const target = match[1].trim().toLowerCase();
      unitSignals.add(target === 'usd' ? 'native' : 'usd');
    }
    if (unitSignals.size !== 1) return fail('unsupported-chart-mode');
    // The control title names the unit a click would switch *to*. Dexscreener's
    // live native-mode control currently says "Switch to USD price"; an older
    // layout said "Switch to price in USD". Both are the same native signal.
    const currentUnit = unitSignals.values().next().value;
    const displayMode = `${chartKind}-${currentUnit}`;

    const priceNative = pairValue('priceNative');
    const priceUsd = pairValue('priceUsd');
    const marketCap = pairValue('marketCap') || pairValue('fdv');
    let factor = 1;
    if (displayMode === 'price-usd') {
      if (!priceNative || !priceUsd) return fail('pair-conversion-unavailable');
      factor = priceUsd / priceNative;
    } else if (displayMode === 'mcap-usd') {
      if (!priceNative || !marketCap) return fail('pair-conversion-unavailable');
      factor = marketCap / priceNative;
    } else if (displayMode === 'mcap-native') {
      if (!priceUsd || !marketCap) return fail('pair-conversion-unavailable');
      factor = marketCap / priceUsd;
    }
    if (!positive(factor)) return fail('pair-conversion-unavailable');

    const plot = frameDocument.querySelector('.chart-markup-table.pane');
    if (!plot || typeof plot.getBoundingClientRect !== 'function'
        || typeof frame.getBoundingClientRect !== 'function') {
      return fail('chart-geometry-unavailable');
    }
    const frameRect = frame.getBoundingClientRect();
    const plotRect = plot.getBoundingClientRect();
    const frameWidth = frameWindow.innerWidth;
    const frameHeight = frameWindow.innerHeight;
    if (![frameRect.left, frameRect.top, frameRect.width, frameRect.height,
      plotRect.left, plotRect.top, plotRect.width, plotRect.height,
      frameWidth, frameHeight].every(finite)
        || frameRect.width <= 1 || frameRect.height <= 1
        || plotRect.width <= 1 || plotRect.height <= 1
        || frameWidth <= 1 || frameHeight <= 1) {
      return fail('chart-geometry-unavailable');
    }
    const scaleX = frameRect.width / frameWidth;
    const scaleY = frameRect.height / frameHeight;
    if (!positive(scaleX) || !positive(scaleY)) return fail('chart-geometry-unavailable');
    const viewportPlot = {
      left: frameRect.left + plotRect.left * scaleX,
      top: frameRect.top + plotRect.top * scaleY,
      width: plotRect.width * scaleX,
      height: plotRect.height * scaleY,
    };
    if (!Object.values(viewportPlot).every(finite)
        || viewportPlot.width <= 1 || viewportPlot.height <= 1) {
      return fail('chart-geometry-unavailable');
    }

    const coordinate = (displayValue) => {
      const local = privateScale.priceToCoordinate(displayValue, 0);
      return finite(local) ? viewportPlot.top + local * scaleY : null;
    };
    const measuredRanges = [];
    for (const range of ranges) {
      const loValue = range.lo * factor;
      const nowValue = range.now * factor;
      const hiValue = range.hi * factor;
      if (!positive(loValue) || !positive(nowValue) || !positive(hiValue)) {
        return fail('coordinate-unavailable');
      }
      const loY = coordinate(loValue);
      const nowY = coordinate(nowValue);
      const hiY = coordinate(hiValue);
      if (![loY, nowY, hiY].every(finite)) return fail('coordinate-unavailable');
      measuredRanges.push({
        id: range.id,
        loY,
        hiY,
        nowY,
        loValue,
        hiValue,
        nowValue,
      });
    }

    return {
      ok: true,
      href: payload.href,
      displayMode,
      plot: viewportPlot,
      ranges: measuredRanges,
    };
  } catch {
    return fail('measurement-failed');
  }
}

function validateDexscreenerChartResult(raw, expected, pairMetadata = {}) {
  const fail = (reason) => ({ ok: false, reason });
  const reasons = new Set([
    'stale-route', 'invalid-ranges', 'chart-frame-ambiguous',
    'chart-frame-unavailable', 'chart-api-unavailable',
    'unsupported-price-scale', 'unsupported-chart-mode',
    'pair-conversion-unavailable', 'chart-geometry-unavailable',
    'coordinate-unavailable', 'measurement-failed',
  ]);
  if (!raw || typeof raw !== 'object') return fail('invalid-result');
  if (raw.ok !== true) {
    return fail(reasons.has(raw.reason) ? raw.reason : 'invalid-result');
  }
  if (!expected || raw.href !== expected.href) return fail('stale-route');
  const modes = new Set(['price-native', 'price-usd', 'mcap-native', 'mcap-usd']);
  if (!modes.has(raw.displayMode)) return fail('invalid-result');
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const positive = (value) => finite(value) && value > 0;
  const pairValue = (name) => positive(pairMetadata && pairMetadata[name])
    ? pairMetadata[name] : null;
  const priceNative = pairValue('priceNative');
  const priceUsd = pairValue('priceUsd');
  const marketCap = pairValue('marketCap') || pairValue('fdv');
  let factor = 1;
  if (raw.displayMode === 'price-usd') {
    if (!priceNative || !priceUsd) return fail('invalid-result');
    factor = priceUsd / priceNative;
  } else if (raw.displayMode === 'mcap-usd') {
    if (!priceNative || !marketCap) return fail('invalid-result');
    factor = marketCap / priceNative;
  } else if (raw.displayMode === 'mcap-native') {
    if (!priceUsd || !marketCap) return fail('invalid-result');
    factor = marketCap / priceUsd;
  }
  if (!positive(factor)) return fail('invalid-result');
  const plot = raw.plot;
  if (!plot || typeof plot !== 'object'
      || ![plot.left, plot.top, plot.width, plot.height].every(finite)
      || Math.abs(plot.left) > 100_000 || Math.abs(plot.top) > 100_000
      || plot.width <= 1 || plot.width > 100_000
      || plot.height <= 1 || plot.height > 100_000) {
    return fail('invalid-result');
  }
  if (!Array.isArray(raw.ranges) || raw.ranges.length !== expected.ranges.length) {
    return fail('invalid-result');
  }
  const minY = plot.top - 10 * plot.height;
  const maxY = plot.top + 11 * plot.height;
  const ranges = [];
  for (let index = 0; index < raw.ranges.length; index++) {
    const item = raw.ranges[index];
    const expectedRange = expected.ranges[index];
    const expectedId = expectedRange.id;
    const expectedValues = [
      expectedRange.lo * factor,
      expectedRange.hi * factor,
      expectedRange.now * factor,
    ];
    const actualValues = [item && item.loValue, item && item.hiValue, item && item.nowValue];
    const closeEnough = actualValues.every((value, valueIndex) => {
      const target = expectedValues[valueIndex];
      return positive(value) && positive(target)
        && Math.abs(value - target) <= Math.max(1e-12, Math.abs(target) * 1e-9);
    });
    if (!item || typeof item !== 'object' || item.id !== expectedId
        || ![item.loY, item.hiY, item.nowY].every(finite)
        || [item.loY, item.hiY, item.nowY].some((value) => value < minY || value > maxY)
        || !closeEnough) {
      return fail('invalid-result');
    }
    ranges.push({
      id: expectedId,
      loY: item.loY,
      hiY: item.hiY,
      nowY: item.nowY,
      loValue: item.loValue,
      hiValue: item.hiValue,
      nowValue: item.nowValue,
    });
  }
  return {
    ok: true,
    data: {
      href: expected.href,
      displayMode: raw.displayMode,
      plot: {
        left: plot.left,
        top: plot.top,
        width: plot.width,
        height: plot.height,
      },
      ranges,
    },
  };
}
/* END LPLENS DEXSCREENER MAIN-WORLD EXPERIMENT */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'LPLENS_DEXSCREENER_CHART_GEOMETRY') return false;

  (async () => {
    if (!LPLENS_LOCAL_CHART_EXPERIMENT) return { ok: false, reason: 'experiment-disabled' };
    if (!(await dexscreenerPageAccess(sender))) {
      return { ok: false, reason: 'permission-revoked' };
    }
    const request = sanitizeDexscreenerChartRequest(msg, sender);
    if (!request.ok) return request;

    const aliases = { hyperliquid: 'hyperevm', robinhoodchain: 'robinhood' };
    const chainKey = aliases[request.chainSlug]
      || Object.keys(CHAINS).find((key) =>
        String(CHAINS[key] && CHAINS[key].dexscreener || '').toLowerCase() === request.chainSlug);
    if (!chainKey || !CHAINS[chainKey]) return { ok: false, reason: 'unsupported-route' };

    let metadata = null;
    try {
      metadata = await cachedDexscreenerPair(chainKey, request.poolRef);
    } catch {
      // Native-price chart coordinates need no conversion metadata. Let the
      // MAIN function decide whether the current chart mode can still work.
    }
    const finitePositive = (value) => typeof value === 'number'
      && Number.isFinite(value) && value > 0 ? value : null;
    const payload = {
      href: request.href,
      ranges: request.ranges.map(({ id, lo, now, hi }) => ({ id, lo, now, hi })),
      pair: {
        priceNative: finitePositive(metadata && metadata.priceNative),
        priceUsd: finitePositive(metadata && metadata.priceUsd),
        marketCap: finitePositive(metadata && metadata.marketCap),
        fdv: finitePositive(metadata && metadata.fdv),
      },
    };

    let timer = null;
    let timedOut = false;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('chart measurement timeout'));
        }, 2_500);
      });
      const execution = chrome.scripting.executeScript({
        target: { tabId: request.tabId, frameIds: [0] },
        world: 'MAIN',
        func: measureDexscreenerChart,
        args: [payload],
      });
      const injected = await Promise.race([execution, timeout]);
      if (!Array.isArray(injected) || injected.length !== 1) {
        return { ok: false, reason: 'invalid-result' };
      }
      return validateDexscreenerChartResult(injected[0].result, request, payload.pair);
    } catch {
      return { ok: false, reason: timedOut ? 'execution-timeout' : 'execution-failed' };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  })().then(
    (result) => sendResponse(result),
    () => sendResponse({ ok: false, reason: 'execution-failed' }),
  );

  return true;
});

// ProjectX does not expose position NFT ids in stable portfolio links. Its
// overlay therefore scans only the active overlay wallet the user explicitly
// selected in LPLens; it never reads ProjectX's connected wallet or accepts an
// address from page content.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'LPLENS_PROJECTX_PORTFOLIO') return false;

  (async () => {
    const ent = await entitlement();
    if (!ent.allowed) return { ok: false, gated: true, entitlement: ent };

    const store = await chrome.storage.local.get([
      'address', 'rpcOverrides', 'etherscanKey',
    ]);
    const address = String(store.address || '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      return { ok: false, error: 'Open LPLens and select an overlay wallet first.' };
    }

    await slot();
    try {
      const overrides = store.rpcOverrides || {};
      const historyRelay = await historyRelayCredentials();
      const result = await loadPositions('hyperevm', address, {
        includeClosed: false,
        withUsd: true,
        rpcOverride: overrides.hyperevm || undefined,
        rpcOverrides: overrides,
        etherscanKey: store.etherscanKey || undefined,
        historyRelay,
      });
      const safe = JSON.parse(JSON.stringify({
        address,
        positions: result.positions || [],
        unavailable: result.v4 && result.v4.unavailable || null,
      }, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
      return { ok: true, data: safe };
    } finally {
      release();
    }
  })().then(
    (result) => sendResponse(result),
    (err) => sendResponse({ ok: false, error: err.message || String(err) }),
  );

  return true;
});


/* ---------------------------------------------------------------------------
 * On-page overlay registration.
 *
 * The overlay is the only part of LPLens that can touch a web page, and a
 * content script that can modify a DEX page is a genuine attack vector
 * regardless of how this code behaves today — a later malicious update inherits
 * the same access, and extensions auto-update.
 *
 * So it is not granted at install. The manifest declares no `content_scripts`
 * at all; `https://app.uniswap.org/*` sits in `optional_host_permissions` and
 * the script is registered only once the user grants it, from the options page.
 * Revoking a permission tells any injected copy to shut down and unregisters
 * future injection. Worker handlers also re-check page permission so a stale
 * content script fails closed. Until access is granted, the extension cannot
 * read or alter any web page, and the install prompt says so.
 * ------------------------------------------------------------------------- */

const OVERLAY_ID = 'lplens-overlay';
const OVERLAY_ORIGIN = 'https://app.uniswap.org/*';
const PROJECTX_OVERLAY_ID = 'lplens-projectx-overlay';
const PROJECTX_OVERLAY_ORIGIN = 'https://www.prjx.com/*';
const DEXSCREENER_OVERLAY_ID = 'lplens-dexscreener-overlay';
// `/positions/*` does not match the bare `/positions` list route. Keep the
// exact list URL and its detail descendants explicit so the optional content
// script never widens beyond Uniswap's position surfaces.
const OVERLAY_MATCHES = Object.freeze([
  'https://app.uniswap.org/positions',
  'https://app.uniswap.org/positions/*',
]);
const OVERLAY_JS = Object.freeze(['render.js', 'overlay.js']);
const PROJECTX_OVERLAY_MATCHES = Object.freeze([
  'https://www.prjx.com/portfolio',
  'https://www.prjx.com/portfolio/*',
]);
const DEXSCREENER_OVERLAY_MATCHES = Object.freeze([
  'https://dexscreener.com/*',
]);
const OPTIONAL_OVERLAY_ORIGINS = new Set([
  OVERLAY_ORIGIN,
  PROJECTX_OVERLAY_ORIGIN,
  DEXSCREENER_OVERLAY_ORIGIN,
]);

async function stopRevokedOverlayTabs(origins) {
  const revoked = [...new Set(Array.isArray(origins) ? origins : [])]
    .filter((origin) => OPTIONAL_OVERLAY_ORIGINS.has(origin));
  if (!revoked.length) return;

  let tabs;
  try {
    // This path runs before options removes the permission, so Chrome can
    // still apply the URL filter without the broad `tabs` permission.
    tabs = await chrome.tabs.query({ url: revoked });
  } catch {
    // A user can also revoke access from Chrome's own site controls. Afterward
    // URL filtering may be unavailable, so broadcast only the origin names;
    // unrelated tabs have no LPLens content-script receiver.
    tabs = await chrome.tabs.query({});
  }
  await Promise.allSettled((tabs || []).map((tab) => Number.isInteger(tab.id)
    ? chrome.tabs.sendMessage(tab.id, {
      type: 'LPLENS_OVERLAY_ACCESS_REVOKED',
      origins: revoked,
    })
    : Promise.resolve()));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'LPLENS_REVOKE_OVERLAY_ACCESS') return false;
  const fromExtensionPage = String(sender && sender.url || '')
    .startsWith(chrome.runtime.getURL(''));
  if (!fromExtensionPage) return false;
  const origin = String(msg.origin || '');
  if (!OPTIONAL_OVERLAY_ORIGINS.has(origin)) {
    sendResponse({ ok: false });
    return false;
  }
  stopRevokedOverlayTabs([origin]).then(
    () => sendResponse({ ok: true }),
    () => sendResponse({ ok: false }),
  );
  return true;
});

async function overlayRegistration(id) {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    return existing[0] || null;
  } catch {
    return null;
  }
}

const sameStrings = (actual, expected) =>
  Array.isArray(actual) && actual.length === expected.length
  && expected.every((value, index) => actual[index] === value);

function currentOverlayRegistration(script, matches) {
  return !!script
    && sameStrings(script.matches, matches)
    && sameStrings(script.js, OVERLAY_JS)
    && script.runAt === 'document_idle';
}

async function syncOneOverlay({ id, origin, matches }) {
  const granted = await chrome.permissions.contains({ origins: [origin] });
  const registered = await overlayRegistration(id);
  const definition = {
    id,
    matches: [...matches],
    js: [...OVERLAY_JS],
    runAt: 'document_idle',
  };

  if (granted && !registered) {
    await chrome.scripting.registerContentScripts([definition]);
  } else if (granted && !currentOverlayRegistration(registered, matches)) {
    // Dynamic registrations persist across extension updates. Reconcile the
    // old 0.27 definition or the new list-page match would never take effect.
    await chrome.scripting.updateContentScripts([definition]);
  } else if (!granted && registered) {
    await chrome.scripting.unregisterContentScripts({ ids: [id] });
  }
}

async function syncOverlayRegistration() {
  await syncOneOverlay({ id: OVERLAY_ID, origin: OVERLAY_ORIGIN, matches: OVERLAY_MATCHES });
  await syncOneOverlay({
    id: PROJECTX_OVERLAY_ID,
    origin: PROJECTX_OVERLAY_ORIGIN,
    matches: PROJECTX_OVERLAY_MATCHES,
  });
  await syncOneOverlay({
    id: DEXSCREENER_OVERLAY_ID,
    origin: DEXSCREENER_OVERLAY_ORIGIN,
    matches: DEXSCREENER_OVERLAY_MATCHES,
  });
}

chrome.runtime.onInstalled.addListener(syncOverlayRegistration);
chrome.runtime.onStartup.addListener(syncOverlayRegistration);
chrome.permissions.onAdded.addListener(syncOverlayRegistration);
chrome.permissions.onRemoved.addListener((removed) => {
  void stopRevokedOverlayTabs(removed && removed.origins);
  void syncOverlayRegistration();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (['address', 'rpcOverrides', 'etherscanKey', 'licenseKey']
    .some((key) => Object.prototype.hasOwnProperty.call(changes, key))) {
    dexscreenerScanCache.clear();
  }
});
syncOverlayRegistration();
