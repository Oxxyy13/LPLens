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
const DEXSCREENER_CACHE_MS = 60_000;

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
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'LPLENS_DEXSCREENER_POOL') return false;

  (async () => {
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
    const safe = JSON.parse(JSON.stringify({ address, positions }, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value));
    return { ok: true, data: safe };
  })().then(
    (result) => sendResponse(result),
    (err) => sendResponse({ ok: false, error: err.message || String(err) }),
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
 * Revoking the permission unregisters it immediately. Until then the extension
 * cannot read or alter any web page, and the install prompt says so.
 * ------------------------------------------------------------------------- */

const OVERLAY_ID = 'lplens-overlay';
const OVERLAY_ORIGIN = 'https://app.uniswap.org/*';
const PROJECTX_OVERLAY_ID = 'lplens-projectx-overlay';
const PROJECTX_OVERLAY_ORIGIN = 'https://www.prjx.com/*';
const DEXSCREENER_OVERLAY_ID = 'lplens-dexscreener-overlay';
const DEXSCREENER_OVERLAY_ORIGIN = 'https://dexscreener.com/*';
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
chrome.permissions.onRemoved.addListener(syncOverlayRegistration);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (['address', 'rpcOverrides', 'etherscanKey', 'licenseKey']
    .some((key) => Object.prototype.hasOwnProperty.call(changes, key))) {
    dexscreenerScanCache.clear();
  }
});
syncOverlayRegistration();
