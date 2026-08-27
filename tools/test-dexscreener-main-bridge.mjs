#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const worker = readFileSync(new URL('../extension/sw.js', import.meta.url), 'utf8');
const experiment = worker.match(
  /\/\* BEGIN LPLENS DEXSCREENER MAIN-WORLD EXPERIMENT[\s\S]*?\*\/([\s\S]*?)\/\* END LPLENS DEXSCREENER MAIN-WORLD EXPERIMENT \*\//,
);
assert.ok(experiment, 'service worker is missing the fenced local chart experiment');

const context = vm.createContext({ URL });
vm.runInContext(`${experiment[1]}
globalThis.__bridge = {
  sanitizeDexscreenerChartRequest,
  measureDexscreenerChart,
  validateDexscreenerChartResult,
};`, context, { filename: 'dexscreener-main-bridge.js' });
const {
  sanitizeDexscreenerChartRequest: sanitize,
  measureDexscreenerChart: measure,
  validateDexscreenerChartResult: validate,
} = context.__bridge;
const plain = (value) => JSON.parse(JSON.stringify(value));

const href = 'https://dexscreener.com/robinhood/0x2b0d0183d017c58b924401ca8ac362f6e01f0e9e';
const sender = { tab: { id: 17, url: href } };
const request = sanitize({
  type: 'LPLENS_DEXSCREENER_CHART_GEOMETRY',
  href,
  ranges: [{
    id: 'r0', lo: 1, now: 4, hi: 3,
    wallet: '0x1111111111111111111111111111111111111111',
    tokenId: '737471',
    pnl: 123,
  }],
  accessKey: 'must-not-cross',
  pair: { priceUsd: 999 },
}, sender);
assert.equal(request.ok, true);
assert.deepEqual(plain(request.ranges), [{ id: 'r0', lo: 1, now: 4, hi: 3 }],
  'request sanitizer must reconstruct only anonymous bounds');
assert.equal(request.tabId, 17);
assert.equal(request.chainSlug, 'robinhood');
assert.equal(request.poolRef, '0x2b0d0183d017c58b924401ca8ac362f6e01f0e9e');
for (const secret of ['wallet', 'tokenId', 'pnl', 'accessKey', 'must-not-cross', 'priceUsd']) {
  assert.doesNotMatch(JSON.stringify(request), new RegExp(secret, 'i'));
}

assert.equal(sanitize({
  type: 'LPLENS_DEXSCREENER_CHART_GEOMETRY', href,
  ranges: [{ id: 'r1', lo: 1, now: 2, hi: 3 }],
}, sender).reason, 'invalid-ranges', 'anonymous range ids must be sequential');
assert.equal(sanitize({
  type: 'LPLENS_DEXSCREENER_CHART_GEOMETRY', href,
  ranges: [0, 1, 2, 3].map((n) => ({ id: `r${n}`, lo: 1, now: 2, hi: 3 })),
}, sender).reason, 'invalid-ranges', 'at most three bounds may cross into page world');
assert.equal(sanitize({
  type: 'LPLENS_DEXSCREENER_CHART_GEOMETRY', href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: Infinity }],
}, sender).reason, 'invalid-ranges');
assert.equal(sanitize({
  type: 'LPLENS_DEXSCREENER_CHART_GEOMETRY', href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
}, { tab: { id: 17, url: `${href}?stale=1` } }).reason, 'stale-route');
assert.equal(sanitize({
  type: 'LPLENS_DEXSCREENER_CHART_GEOMETRY',
  href: 'https://example.com/robinhood/0x2b0d0183d017c58b924401ca8ac362f6e01f0e9e',
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
}, { tab: { id: 17, url: 'https://example.com/robinhood/0x2b0d0183d017c58b924401ca8ac362f6e01f0e9e' } }).reason,
'invalid-request');

const titleNode = (title) => ({ getAttribute: (name) => name === 'title' ? title : null });
function installChart({
  pageHref = href,
  chartTitle = 'Switch to market cap chart',
  unitTitle = 'Switch to price in WETH',
  scaleMode = 0,
  frameCount = 1,
} = {}) {
  const privateScale = { priceToCoordinate: (price) => 200 - price * 10 };
  const chart = {
    getPanes: () => [{
      getMainSourcePriceScale: () => ({
        getMode: () => scaleMode,
        _priceScale: privateScale,
      }),
    }],
  };
  const plot = {
    getBoundingClientRect: () => ({ left: 20, top: 40, width: 800, height: 400 }),
  };
  const frameDocument = {
    querySelectorAll: (selector) => selector === '[title]' ? [] : [],
    querySelector: (selector) => selector === '.chart-markup-table.pane' ? plot : null,
  };
  const makeFrame = () => ({
    contentWindow: {
      innerWidth: 1000,
      innerHeight: 500,
      tradingViewApi: { activeChart: () => chart },
    },
    contentDocument: frameDocument,
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 500, height: 250 }),
  });
  const frames = Array.from({ length: frameCount }, makeFrame);
  context.location = { href: pageHref };
  context.document = {
    querySelectorAll: (selector) => {
      if (selector === 'iframe[title="Financial Chart"]') return frames;
      if (selector === '[title]') return [
        titleNode(chartTitle),
        ...(Array.isArray(unitTitle) ? unitTitle : [unitTitle]).map(titleNode),
      ];
      return [];
    },
  };
}

installChart();
const measured = plain(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: { priceNative: 2, priceUsd: 4, marketCap: 100, fdv: 110 },
}));
assert.deepEqual(measured, {
  ok: true,
  href,
  displayMode: 'price-usd',
  plot: { left: 110, top: 70, width: 400, height: 200 },
  ranges: [{
    id: 'r0', loY: 160, hiY: 140, nowY: 150,
    loValue: 2, hiValue: 6, nowValue: 4,
  }],
}, 'MAIN measurement must return top-page viewport coordinates');
assert.deepEqual(Object.keys(measured).sort(), ['displayMode', 'href', 'ok', 'plot', 'ranges']);
assert.deepEqual(Object.keys(measured.plot).sort(), ['height', 'left', 'top', 'width']);
assert.deepEqual(Object.keys(measured.ranges[0]).sort(), [
  'hiValue', 'hiY', 'id', 'loValue', 'loY', 'nowValue', 'nowY',
],
  'MAIN result contract must not acquire token, wallet or PnL fields');

installChart({ unitTitle: 'Switch to price in USD' });
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: {},
}).displayMode, 'price-native', 'native quote mode needs no pair-price conversion');
installChart({ unitTitle: 'Switch to USD price' });
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: {},
}).displayMode, 'price-native',
'the exact live Dexscreener title must identify native quote mode');
installChart({ unitTitle: ['Switch to USD price', 'Switch to price in WETH'] });
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: {},
}).reason, 'unsupported-chart-mode', 'contradictory unit controls must fail closed');
installChart({ unitTitle: 'Switch to price in USD', scaleMode: 1 });
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: {},
}).ok, true, 'TradingView numeric mode 1 must preserve log-scale coordinates');

installChart({ chartTitle: 'Switch to price chart' });
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: { priceNative: 2, priceUsd: 4, marketCap: 100 },
}).displayMode, 'mcap-usd');

installChart({ scaleMode: 2 });
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: {},
}).reason, 'unsupported-price-scale');
installChart({ frameCount: 2 });
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: {},
}).reason, 'chart-frame-ambiguous');
installChart({ pageHref: `${href}?moved=1` });
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: {},
}).reason, 'stale-route');
installChart();
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: {},
}).reason, 'pair-conversion-unavailable');

const validationRequest = {
  ...request,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
};
const pairMetadata = { priceNative: 2, priceUsd: 4, marketCap: 100, fdv: 110 };
const validated = plain(validate({
  ...measured,
  wallet: '0x1111111111111111111111111111111111111111',
  ranges: [{ ...measured.ranges[0], tokenId: '737471' }],
}, validationRequest, pairMetadata));
assert.deepEqual(validated, {
  ok: true,
  data: {
    href,
    displayMode: 'price-usd',
    plot: { left: 110, top: 70, width: 400, height: 200 },
    ranges: [{
      id: 'r0', loY: 160, hiY: 140, nowY: 150,
      loValue: 2, hiValue: 6, nowValue: 4,
    }],
  },
}, 'worker must reconstruct the MAIN result instead of forwarding it');
assert.equal(validate({ ...measured, href: `${href}?stale=1` }, validationRequest, pairMetadata).reason,
'stale-route');
assert.equal(validate({
  ...measured,
  ranges: [{ id: 'r0', loY: Infinity, hiY: 1, nowY: 2 }],
}, validationRequest, pairMetadata).reason, 'invalid-result');
assert.equal(validate({
  ...measured,
  ranges: [{ id: 'r0', loY: -2_000, hiY: 1, nowY: 2 }],
}, validationRequest, pairMetadata).reason, 'invalid-result',
'page-world coordinates must stay near the measured plot');
assert.equal(validate({
  ...measured,
  ranges: [{ ...measured.ranges[0], loValue: 999 }],
}, validationRequest, pairMetadata).reason, 'invalid-result',
'page-world labels must match worker-known conversion inputs');

const bridgeSource = experiment[1];
for (const forbidden of [
  /postMessage\s*\(/,
  /addEventListener\s*\(/,
  /create(?:MultiPoint)?Shape\s*\(/i,
  /window\.ethereum/,
  /localStorage/,
  /\.innerText\b/,
  /\.textContent\b/,
  /\bethereum\s*[.(\[]/i,
]) {
  assert.doesNotMatch(bridgeSource, forbidden,
    `MAIN bridge acquired a forbidden persistent or wallet-facing capability: ${forbidden}`);
}
assert.match(worker, /target:\s*\{ tabId: request\.tabId, frameIds: \[0\] \}/);
assert.match(worker, /world:\s*'MAIN'/);
assert.match(worker, /func:\s*measureDexscreenerChart/);
assert.match(worker, /Promise\.race\(\[execution, timeout\]\)/);
assert.match(worker, /timedOut \? 'execution-timeout' : 'execution-failed'/);
assert.doesNotMatch(worker, /allFrames:\s*true/);
assert.match(worker, /priceNative:\s*positiveNumber\(pair\.priceNative\)/);
assert.match(worker, /marketCap:\s*positiveNumber\(pair\.marketCap\)/);

console.log('Dexscreener MAIN bridge: strict payload, chart conversion, viewport geometry and fail-closed validation pass');
