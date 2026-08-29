#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const worker = readFileSync(new URL('../extension/sw.js', import.meta.url), 'utf8');
const bridge = worker.match(
  /\/\* BEGIN LPLENS DEXSCREENER MAIN-WORLD CHART BRIDGE[\s\S]*?\*\/([\s\S]*?)\/\* END LPLENS DEXSCREENER MAIN-WORLD CHART BRIDGE \*\//,
);
assert.ok(bridge, 'service worker is missing the production chart bridge');

const context = vm.createContext({ URL });
context.innerWidth = 1200;
context.innerHeight = 800;
context.getComputedStyle = (node) => node.__style || ({
  display: 'block', visibility: 'visible', opacity: '1',
});
vm.runInContext(`${bridge[1]}
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
  'request sanitizer must reconstruct only unlabelled bounds');
assert.equal(request.tabId, 17);
assert.equal(request.chainSlug, 'robinhood');
assert.equal(request.poolRef, '0x2b0d0183d017c58b924401ca8ac362f6e01f0e9e');
for (const secret of ['wallet', 'tokenId', 'pnl', 'accessKey', 'must-not-cross', 'priceUsd']) {
  assert.doesNotMatch(JSON.stringify(request), new RegExp(secret, 'i'));
}

assert.equal(sanitize({
  type: 'LPLENS_DEXSCREENER_CHART_GEOMETRY', href,
  ranges: [{ id: 'r1', lo: 1, now: 2, hi: 3 }],
}, sender).reason, 'invalid-ranges', 'unlabelled range ids must be sequential');
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

const titleNode = (input) => {
  const spec = typeof input === 'string' ? { title: input } : input;
  const rect = spec.rect || { left: 10, top: 10, width: 24, height: 24 };
  const node = {
    isConnected: spec.connected !== false,
    __style: {
      display: spec.display || 'block',
      visibility: spec.visibility || 'visible',
      opacity: spec.opacity ?? '1',
      contentVisibility: spec.contentVisibility || 'visible',
      pointerEvents: spec.pointerEvents || 'auto',
    },
    checkVisibility: () => spec.checkVisible !== false,
    getClientRects: () => spec.clientRects === false ? [] : [rect],
    getBoundingClientRect: () => rect,
    getAttribute: (name) => name === 'title' ? spec.title
      : name === 'aria-disabled' ? spec.ariaDisabled || null : null,
  };
  node.__paintChild = { __style: { ...node.__style } };
  node.contains = (candidate) => candidate === node || candidate === node.__paintChild;
  return node;
};
function installChart({
  pageHref = href,
  chartTitle = 'Switch to market cap chart',
  unitTitle = 'Switch to price in WETH',
  topTitles = [],
  frameTitles = null,
  scaleMode = 0,
  inverted = false,
  frameCount = 1,
  frameSpecs = null,
  elementsFromPoint = null,
  titleElementsFromPoint = null,
  plotRects = null,
  priceToCoordinate = (price) => 200 - price * 10,
  seriesClose = undefined,
  seriesLast = undefined,
  seriesReads = null,
} = {}) {
  const defaultPlotRects = plotRects || [{ left: 20, top: 40, width: 800, height: 400 }];
  const specs = frameSpecs || Array.from({ length: frameCount }, () => ({}));
  const makeFrame = (spec = {}) => {
    const privateScale = {
      priceToCoordinate: spec.priceToCoordinate || priceToCoordinate,
    };
    const chart = {
      getPanes: () => [{
        getMainSourcePriceScale: () => ({
          getMode: () => scaleMode,
          isInverted: () => inverted,
          _priceScale: privateScale,
        }),
      }],
    };
    const resolvedLast = Object.prototype.hasOwnProperty.call(spec, 'seriesLast')
      ? spec.seriesLast
      : seriesLast !== undefined
        ? seriesLast
        : seriesClose !== undefined
          ? { value: [0, 0, 0, 0, seriesClose] }
          : undefined;
    if (resolvedLast !== undefined) {
      chart.getSeries = () => ({
        data: () => ({
          last: () => {
            if (seriesReads) seriesReads.count += 1;
            return resolvedLast;
          },
        }),
      });
    }
    const plots = (spec.plotRects || defaultPlotRects).map((input) => {
      const plotSpec = input && input.rect ? input : { rect: input };
      const rect = plotSpec.rect;
      return {
        isConnected: plotSpec.connected !== false,
        __style: {
          display: plotSpec.display || 'block',
          visibility: plotSpec.visibility || 'visible',
          opacity: plotSpec.opacity ?? '1',
          contentVisibility: plotSpec.contentVisibility || 'visible',
        },
        checkVisibility: () => plotSpec.checkVisible !== false,
        getClientRects: () => plotSpec.clientRects === false ? [] : [rect],
        getBoundingClientRect: () => rect,
      };
    });
    const defaultFrameTitles = [chartTitle,
      ...(Array.isArray(unitTitle) ? unitTitle : [unitTitle])];
    const frameTitleNodes = (frameTitles || defaultFrameTitles).map(titleNode);
    const frameDocument = {
      querySelectorAll: (selector) => selector === '[title]' ? frameTitleNodes
        : selector === '.chart-markup-table.pane' ? plots : [],
      querySelector: (selector) => selector === '.chart-markup-table.pane' ? plots[0] : null,
      ...(titleElementsFromPoint ? {
        elementsFromPoint: (x, y) => titleElementsFromPoint(x, y, frameTitleNodes),
      } : {}),
    };
    const frameWindow = {
      innerWidth: spec.innerWidth || 1000,
      innerHeight: spec.innerHeight || 500,
      tradingViewApi: { activeChart: () => chart },
      getComputedStyle: (node) => node.__style,
    };
    return {
      isConnected: spec.connected !== false,
      checkVisibility: () => spec.checkVisible !== false,
      __style: {
        display: spec.display || 'block',
        visibility: spec.visibility || 'visible',
        opacity: spec.opacity ?? '1',
      },
      contentWindow: frameWindow,
      contentDocument: frameDocument,
      getBoundingClientRect: () => spec.rect
        || ({ left: 100, top: 50, width: 500, height: 250 }),
    };
  };
  const frames = specs.map(makeFrame);
  const topTitleNodes = topTitles.map(titleNode);
  context.location = { href: pageHref };
  context.document = {
    querySelectorAll: (selector) => {
      if (selector === 'iframe[title="Financial Chart"]') return frames;
      if (selector === '[title]') return topTitleNodes;
      return [];
    },
    ...(elementsFromPoint ? {
      elementsFromPoint: (x, y) => elementsFromPoint(x, y, frames),
    } : {}),
  };
}

installChart({ seriesClose: 4 });
const measured = plain(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: { priceNative: 2, priceUsd: 4, marketCap: 100, fdv: 110 },
}));
assert.deepEqual(measured, {
  ok: true,
  href,
  displayMode: 'price-usd',
  inverted: false,
  plot: { left: 110, top: 70, width: 400, height: 200 },
  ranges: [{
    id: 'r0', loY: 160, hiY: 140, nowY: 150,
    loValue: 2, hiValue: 6, nowValue: 4,
  }],
}, 'MAIN measurement must return top-page viewport coordinates');
assert.deepEqual(Object.keys(measured).sort(), [
  'displayMode', 'href', 'inverted', 'ok', 'plot', 'ranges',
]);
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
installChart({ frameTitles: [
  'Switch to market cap chart',
  'Switch to USD price',
  { title: 'Switch to price in WETH', display: 'none' },
] });
const nativeWithStaleControl = plain(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: {},
}));
assert.equal(nativeWithStaleControl.displayMode, 'price-native',
  'a hidden stale USD-mode control must not break native quote mode');
assert.deepEqual(nativeWithStaleControl.ranges.map(({ loValue, nowValue, hiValue }) =>
  ({ loValue, nowValue, hiValue })), [{ loValue: 1, nowValue: 2, hiValue: 3 }],
'native quote mode must retain exact on-chain values');
installChart({ frameTitles: [
  'Switch to market cap chart',
  'Switch to price in WETH',
  { title: 'Switch to USD price', visibility: 'hidden' },
], seriesClose: 10 });
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: { priceNative: 2, priceUsd: 10 },
}).displayMode, 'price-usd', 'a hidden stale native-mode control must not break USD mode');
installChart({ frameTitles: [
  'Switch to market cap chart',
  { title: 'Switch to price chart', opacity: '0' },
  'Switch to USD price',
] });
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: {},
}).displayMode, 'price-native', 'a hidden stale chart-kind control must be ignored');
for (const [label, hidden] of [
  ['ancestor visibility', { checkVisible: false }],
  ['client rectangles', { clientRects: false }],
  ['document connection', { connected: false }],
  ['content visibility', { contentVisibility: 'hidden' }],
  ['viewport intersection', { rect: { left: 1300, top: 10, width: 24, height: 24 } }],
]) {
  installChart({ frameTitles: [
    'Switch to market cap chart',
    'Switch to USD price',
    { title: 'Switch to price in WETH', ...hidden },
  ] });
  assert.equal(measure({
    href,
    ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
    pair: {},
  }).displayMode, 'price-native', `${label} must hide a stale mode control`);
}
installChart({
  frameTitles: [],
  topTitles: [
    'Switch to market cap chart',
    'Switch to USD price',
    { title: 'Switch to price in WETH', display: 'none' },
  ],
});
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: {},
}).displayMode, 'price-native', 'a visible outer toolbar remains a valid fallback');

const zeroRectTitles = [
  { title: 'Switch to market cap chart', rect: { left: 0, top: 0, width: 0, height: 0 } },
  { title: 'Switch to price in WETH', rect: { left: 0, top: 0, width: 0, height: 0 } },
];
const inferredPair = { priceNative: 2, priceUsd: 10, marketCap: 1_000 };
const inferFromClose = (close, now = 2, pair = inferredPair, extra = {}) => {
  installChart({
    frameTitles: zeroRectTitles,
    seriesClose: close,
    priceToCoordinate: (price) => 200 - Math.log(price) * 10,
    ...extra,
  });
  return plain(measure({
    href,
    ranges: [{ id: 'r0', lo: now / 2, now, hi: now * 1.5 }],
    pair,
  }));
};

for (const [displayMode, close] of [
  ['price-native', 2], ['price-usd', 10], ['mcap-native', 200], ['mcap-usd', 1_000],
]) {
  const inferred = inferFromClose(close);
  assert.equal(inferred.displayMode, displayMode,
    `a unique latest displayed close must recover ${displayMode} when title nodes have zero size`);
  assert.deepEqual(Object.keys(inferred).sort(), [
    'displayMode', 'href', 'inverted', 'ok', 'plot', 'ranges',
  ], 'the displayed close must not enter the MAIN result contract');
}

for (const [displayMode, close] of [
  ['price-native', 4], ['price-usd', 20], ['mcap-native', 400], ['mcap-usd', 2_000],
]) {
  assert.equal(inferFromClose(close, 4).displayMode, displayMode,
    'mode inference must use the on-chain current range value with cached metadata ratios');
}

for (const close of [2 * 1.19, 2 / 1.19]) {
  assert.equal(inferFromClose(close).displayMode, 'price-native',
    'a displayed close within the symmetric 20 percent gate must be accepted');
}
for (const close of [2 * 1.21, 2 / 1.21]) {
  assert.equal(inferFromClose(close).reason, 'unsupported-chart-mode',
    'a displayed close outside the symmetric 20 percent gate must fail closed');
}

assert.equal(inferFromClose(2, 2, {
  priceNative: 2, priceUsd: 2 * 1.49, marketCap: 1_000,
}).reason, 'unsupported-chart-mode',
'candidate modes separated by less than the 1.5x runner margin must remain ambiguous');
assert.equal(inferFromClose(2, 2, {
  priceNative: 2, priceUsd: 2 * 1.51, marketCap: 1_000,
}).displayMode, 'price-native',
'candidate modes beyond the 1.5x runner margin may be resolved');
assert.equal(inferFromClose(2, 2, {
  priceNative: 2, priceUsd: 2.02, marketCap: 1_000,
}).reason, 'unsupported-chart-mode', 'stable-quote-like native and USD modes must not be guessed');
assert.equal(inferFromClose(2, 2, {
  priceNative: 2, priceUsd: 10, marketCap: 10.1,
}).reason, 'unsupported-chart-mode', 'price and market-cap candidates must not be guessed when supply collides');

for (const pair of [
  { priceUsd: 10, marketCap: 1_000 },
  { priceNative: 2, marketCap: 1_000 },
  { priceNative: 2, priceUsd: 10 },
]) {
  assert.equal(inferFromClose(2, 2, pair).reason, 'unsupported-chart-mode',
    'incomplete pair metadata must disable displayed-close mode inference');
}

installChart({
  frameTitles: [
    'Switch to market cap chart',
    { title: 'Switch to price in WETH', rect: { left: 0, top: 0, width: 0, height: 0 } },
  ],
  seriesClose: 10,
  priceToCoordinate: (price) => 200 - Math.log(price) * 10,
});
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: { priceNative: 2, priceUsd: 10 },
}).displayMode, 'price-usd',
'a known price-chart signal must limit inference to candidates that do not need market cap');

installChart({
  frameTitles: [
    { title: 'Switch to market cap chart', rect: { left: 0, top: 0, width: 0, height: 0 } },
    'Switch to USD price',
  ],
  seriesClose: 200,
  priceToCoordinate: (price) => 200 - Math.log(price) * 10,
});
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: { priceUsd: 10, marketCap: 1_000 },
}).displayMode, 'mcap-native',
'a known native-unit signal must limit inference to candidates that do not need priceNative');

for (const seriesLast of [
  null, {}, { value: [] }, { value: [0, 0, 0, 0, 0] },
  { value: [0, 0, 0, 0, NaN] }, { value: [0, 0, 0, 0, Infinity] },
]) {
  assert.equal(inferFromClose(undefined, 2, inferredPair, { seriesLast }).reason,
    'unsupported-chart-mode', 'missing or malformed latest-series values must fail closed');
}

installChart({ unitTitle: 'Switch to USD price', seriesClose: 10 });
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: inferredPair,
}).reason, 'chart-mode-conflict',
'a displayed close must not override an exact contradictory title mode');

const seriesReads = { count: 0 };
inferFromClose(2, 2, inferredPair, { seriesReads });
assert.equal(seriesReads.count, 1,
  'mode inference may read only the latest series item once, never chart history');

const chartRect = { left: 10, top: 10, width: 24, height: 24 };
const unitRect = { left: 50, top: 10, width: 24, height: 24 };
installChart({
  frameTitles: [
    { title: 'Switch to market cap chart', rect: chartRect, ariaDisabled: 'true' },
    { title: 'Switch to price in WETH', rect: unitRect },
    { title: 'Switch to USD price', rect: unitRect, ariaDisabled: 'true' },
  ],
  titleElementsFromPoint: (x, _y, nodes) => x < 40 ? [nodes[0]] : [nodes[2], nodes[1]],
});
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: {},
}).displayMode, 'price-native',
'the top-painted replacement control must beat an overlapping stale control');

installChart({
  frameTitles: [
    { title: 'Switch to market cap chart', rect: chartRect },
    { title: 'Switch to USD price', rect: unitRect },
  ],
  titleElementsFromPoint: (x, _y, nodes) => [
    (x < 40 ? nodes[0] : nodes[1]).__paintChild,
  ],
});
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: {},
}).displayMode, 'price-native',
'a painted descendant must establish that its titled control is visible');

installChart({
  frameTitles: [
    { title: 'Switch to market cap chart', rect: chartRect },
    { title: 'Switch to USD price', rect: unitRect },
    { title: 'Switch to price in WETH', rect: unitRect },
  ],
  titleElementsFromPoint: (x, _y, nodes) => x < 40 ? [nodes[0]] : [nodes[2], nodes[1]],
  seriesClose: 10,
});
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: inferredPair,
}).displayMode, 'price-usd',
'top-painted mode resolution must work in the reverse unit state');

installChart({
  frameTitles: [
    { title: 'Switch to market cap chart', rect: chartRect },
    { title: 'Switch to USD price', rect: unitRect },
    { title: 'Switch to price in WETH', rect: { left: 90, top: 10, width: 24, height: 24 } },
  ],
  titleElementsFromPoint: (x, _y, nodes) => x < 40 ? [nodes[0]]
    : x < 80 ? [nodes[1]] : [nodes[2]],
  seriesClose: 2,
});
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: inferredPair,
}).reason, 'unsupported-chart-mode',
'separate top-painted contradictory controls must remain fail-closed');

installChart({ unitTitle: 'Switch to price in USD', scaleMode: 1 });
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: {},
}).ok, true, 'TradingView numeric mode 1 must preserve log-scale coordinates');
installChart({
  unitTitle: 'Switch to USD price',
  inverted: true,
  priceToCoordinate: (price) => 100 + price * 10,
});
const invertedNativeMeasured = plain(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: {},
}));
assert.equal(invertedNativeMeasured.inverted, true);
assert.ok(invertedNativeMeasured.ranges[0].hiY > invertedNativeMeasured.ranges[0].loY,
  'an inverted native scale must preserve its real coordinate direction');

installChart({ chartTitle: 'Switch to price chart', seriesClose: 100 });
const marketCapUsdMeasured = plain(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: { priceNative: 2, priceUsd: 4, marketCap: 100 },
}));
assert.equal(marketCapUsdMeasured.displayMode, 'mcap-usd');
assert.deepEqual(marketCapUsdMeasured.ranges.map(({ loValue, nowValue, hiValue }) =>
  ({ loValue, nowValue, hiValue })), [{ loValue: 50, nowValue: 100, hiValue: 150 }]);
installChart({
  chartTitle: 'Switch to price chart',
  unitTitle: 'Switch to USD price',
  seriesClose: 20,
});
const marketCapNativeMeasured = plain(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: { priceNative: 2, priceUsd: 10, marketCap: 100 },
}));
assert.equal(marketCapNativeMeasured.displayMode, 'mcap-native');
assert.deepEqual(marketCapNativeMeasured.ranges.map(({ loValue, nowValue, hiValue }) =>
  ({ loValue, nowValue, hiValue })), [{ loValue: 10, nowValue: 20, hiValue: 30 }]);

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
installChart({
  frameSpecs: [
    { checkVisible: false, priceToCoordinate: () => 999 },
    {},
  ],
  seriesClose: 4,
});
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: { priceNative: 2, priceUsd: 4 },
}).ranges[0].loY, 160,
'an ancestor-hidden stale chart frame must not block the visible replacement');
installChart({
  frameSpecs: [
    { priceToCoordinate: () => 999 },
    {},
  ],
  elementsFromPoint: (_x, _y, frames) => [frames[1], frames[0]],
  seriesClose: 4,
});
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: { priceNative: 2, priceUsd: 4 },
}).ranges[0].loY, 160, 'the topmost equal-size chart frame must win the overlap tie');
installChart({
  frameSpecs: [
    { rect: { left: 50, top: 50, width: 500, height: 250 } },
    { rect: { left: 650, top: 50, width: 500, height: 250 } },
  ],
  elementsFromPoint: (x, _y, frames) => x < 600 ? [frames[0]] : [frames[1]],
  seriesClose: 4,
});
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: { priceNative: 2, priceUsd: 4 },
}).reason, 'chart-frame-ambiguous',
'two genuinely top-visible equal-size charts must remain fail-closed');
installChart({
  frameSpecs: [
    { display: 'none', priceToCoordinate: () => 999 },
    {},
  ],
  seriesClose: 4,
});
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: { priceNative: 2, priceUsd: 4 },
}).ranges[0].loY, 160, 'a hidden stale chart frame must not block the visible replacement');
installChart({
  frameSpecs: [
    {},
    { rect: { left: 700, top: 50, width: 100, height: 50 }, priceToCoordinate: () => 999 },
  ],
  seriesClose: 4,
});
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: { priceNative: 2, priceUsd: 4 },
}).ranges[0].loY, 160, 'a dominant visible chart must beat a small transitional frame');
installChart({ plotRects: [
  { rect: { left: 20, top: 40, width: 900, height: 420 }, display: 'none' },
  { left: 30, top: 50, width: 700, height: 350 },
], seriesClose: 4 });
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: { priceNative: 2, priceUsd: 4 },
}).plot.width, 350, 'a hidden stale pane must not override the visible price pane');
installChart({ plotRects: [
  { left: 20, top: 40, width: 600, height: 250 },
  { left: 10, top: 10, width: 900, height: 450 },
], seriesClose: 4 });
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: { priceNative: 2, priceUsd: 4 },
}).plot.width, 300,
'the first visible price pane must stay paired with chart.getPanes()[0] when an indicator is larger');
installChart({
  unitTitle: 'Switch to price in USD',
  priceToCoordinate: (price) => -1_000_000 * price,
});
const extremeMeasured = plain(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: {},
}));
assert.deepEqual(extremeMeasured.ranges.map(({ loY, nowY, hiY }) => ({ loY, nowY, hiY })),
  [{ loY: -130, nowY: -130, hiY: -130 }],
  'extreme finite TradingView coordinates must clamp to a truthful above-view sentinel');
installChart({
  unitTitle: 'Switch to USD price',
  priceToCoordinate: (price) => 1_000_000 * price,
});
const extremeBelowMeasured = plain(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: {},
}));
assert.deepEqual(extremeBelowMeasured.ranges.map(({ loY, nowY, hiY }) =>
  ({ loY, nowY, hiY })), [{ loY: 470, nowY: 470, hiY: 470 }],
'extreme finite coordinates must clamp to a truthful below-view sentinel');
installChart({
  unitTitle: 'Switch to USD price',
  priceToCoordinate: () => 123,
});
assert.equal(measure({
  href,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
  pair: {},
}).reason, 'coordinate-unavailable',
'a constant interior coordinate must not masquerade as an aligned range');
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
}).reason, 'chart-mode-unverified',
'a converted chart without public quote evidence must fail before coordinate conversion');

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
    inverted: false,
    plot: { left: 110, top: 70, width: 400, height: 200 },
    ranges: [{
      id: 'r0', loY: 160, hiY: 140, nowY: 150,
      loValue: 2, hiValue: 6, nowValue: 4,
    }],
  },
}, 'worker must reconstruct the MAIN result instead of forwarding it');
const validatedNative = plain(validate(nativeWithStaleControl, validationRequest, {}));
assert.equal(validatedNative.ok, true,
  'native quote mode must pass the full MAIN-to-worker round trip without conversion metadata');
assert.equal(validatedNative.data.displayMode, 'price-native');
assert.equal(validatedNative.data.inverted, false);
const validatedInverted = plain(validate(invertedNativeMeasured, validationRequest, {}));
assert.equal(validatedInverted.ok, true,
  'an explicitly inverted native scale must survive worker reconstruction');
assert.equal(validatedInverted.data.inverted, true);
assert.equal(validate({ ...invertedNativeMeasured, inverted: false }, validationRequest, {}).reason,
'invalid-result', 'worker must reject an inversion flag that contradicts coordinate order');
assert.equal(validate(extremeMeasured, validationRequest, pairMetadata).ok, true,
  'worker validation must accept MAIN-clamped offscreen sentinels');
assert.equal(validate(extremeBelowMeasured, validationRequest, pairMetadata).ok, true,
  'worker validation must accept a below-view clamp sentinel');
assert.equal(validate({
  ...measured,
  ranges: [{ ...measured.ranges[0], loY: 200, nowY: 200, hiY: 200 }],
}, validationRequest, pairMetadata).reason, 'invalid-result',
'worker validation must reject a constant interior coordinate');
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

const bridgeSource = bridge[1];
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
assert.match(worker,
  /priceNative:\s*metadata && metadata\.quoteFresh === true[\s\S]*?finitePositive\(metadata\.priceNative\)/,
  'MAIN-world conversion payload must receive only a fresh native quote');
assert.match(worker,
  /marketCap:\s*metadata && metadata\.quoteFresh === true[\s\S]*?finitePositive\(metadata\.marketCap\)/,
  'MAIN-world conversion payload must receive only a fresh market-cap quote');

console.log('Dexscreener MAIN bridge: strict payload, chart conversion, viewport geometry and fail-closed validation pass');
