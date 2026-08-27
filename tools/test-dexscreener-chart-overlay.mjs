#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const overlay = readFileSync(new URL('../extension/overlay.js', import.meta.url), 'utf8');
const render = readFileSync(new URL('../extension/render.js', import.meta.url), 'utf8');
const pure = overlay.match(
  /\/\/ BEGIN PURE DEXSCREENER CHART GEOMETRY([\s\S]*?)\/\/ END PURE DEXSCREENER CHART GEOMETRY/,
);
assert.ok(pure, 'isolated overlay is missing its testable geometry block');
const recoveryPure = overlay.match(
  /\/\/ BEGIN PURE DEXSCREENER CHART RECOVERY([\s\S]*?)\/\/ END PURE DEXSCREENER CHART RECOVERY/,
);
assert.ok(recoveryPure, 'isolated overlay is missing its testable recovery planner');

const context = vm.createContext({});
vm.runInContext(`${pure[1]}
globalThis.__chart = {
  validateDexscreenerChartGeometry,
  formatDexscreenerChartValue,
  calculateDexscreenerChartShapes,
};`, context, { filename: 'dexscreener-chart-overlay.js' });
const { validateDexscreenerChartGeometry: validate,
  formatDexscreenerChartValue: format,
  calculateDexscreenerChartShapes: calculate } = context.__chart;
const plain = (value) => JSON.parse(JSON.stringify(value));

vm.runInContext(`${recoveryPure[1]}
globalThis.__recovery = planDexscreenerChartRecovery;`, context,
{ filename: 'dexscreener-chart-recovery.js' });
const recovery = (reason, misses, elapsed, hasVisual) => plain(
  context.__recovery(reason, misses, elapsed, hasVisual),
);
assert.deepEqual(recovery('chart-frame-ambiguous', 1, 0, true), {
  transient: true, keepVisual: true, delay: 100,
});
assert.deepEqual(recovery('coordinate-unavailable', 3, 300, true), {
  transient: true, keepVisual: true, delay: 150,
});
assert.deepEqual(recovery('coordinate-unavailable', 4, 500, true), {
  transient: true, keepVisual: false, delay: 400,
});
assert.deepEqual(recovery('unsupported-price-scale', 1, 0, true), {
  transient: false, keepVisual: false, delay: 750,
});
assert.deepEqual(recovery('no-response', 1, 0, false), {
  transient: true, keepVisual: false, delay: 100,
});

const href = 'https://dexscreener.com/robinhood/0x2b0d0183d017c58b924401ca8ac362f6e01f0e9e';
const expected = [{ id: 'r0', lo: 1, now: 2, hi: 3 }];
const response = {
  ok: true,
  data: {
    href,
    displayMode: 'price-usd',
    inverted: false,
    plot: { left: 100, top: 50, width: 800, height: 400 },
    ranges: [{
      id: 'r0', loY: 350, nowY: 225, hiY: 100,
      loValue: 2, nowValue: 4, hiValue: 6,
    }],
  },
};
const viewport = { width: 1200, height: 800 };
const accepted = plain(validate(response, href, expected, viewport));
assert.deepEqual(accepted, response.data,
  'valid worker geometry should survive isolated-world reconstruction');
const clampedAboveResponse = {
  ...response,
  data: {
    ...response.data,
    ranges: [{
      ...response.data.ranges[0],
      loY: -350, nowY: -350, hiY: -350,
    }],
  },
};
const clampedAbove = plain(validate(clampedAboveResponse, href, expected, viewport));
assert.ok(clampedAbove, 'bounded above-view sentinels must survive isolated validation');
assert.equal(plain(calculate(clampedAbove)).ranges[0].whollyAbove, true,
  'a clamped offscreen range must remain truthfully classified as above view');
const clampedBelowResponse = {
  ...response,
  data: {
    ...response.data,
    ranges: [{
      ...response.data.ranges[0],
      loY: 850, nowY: 850, hiY: 850,
    }],
  },
};
const clampedBelow = plain(validate(clampedBelowResponse, href, expected, viewport));
assert.ok(clampedBelow, 'bounded below-view sentinels must survive isolated validation');
assert.equal(plain(calculate(clampedBelow)).ranges[0].whollyBelow, true);
assert.equal(validate({ ...response, data: { ...response.data,
  ranges: [{ ...response.data.ranges[0], loY: 200, nowY: 200, hiY: 200 }] } },
href, expected, viewport), null,
'a constant interior coordinate must not masquerade as an aligned range');

assert.equal(validate(response, `${href}?stale=1`, expected, viewport), null,
  'a stale route must not paint');
assert.equal(validate({ ...response, data: { ...response.data, displayMode: 'unknown' } },
  href, expected, viewport), null, 'unknown chart modes must fail closed');
assert.equal(validate({ ...response, data: { ...response.data,
  ranges: [{ ...response.data.ranges[0], id: 'r1' }] } }, href, expected, viewport), null,
'unknown anonymous ids must not paint');
assert.equal(validate({ ...response, data: { ...response.data,
  ranges: [{ ...response.data.ranges[0], hiValue: 7 }] } }, href, expected, viewport), null,
'page-world values must retain one worker-known multiplicative scale');
assert.equal(validate({ ...response, data: { ...response.data,
  ranges: [{ ...response.data.ranges[0], hiY: 360 }] } }, href, expected, viewport), null,
'an inverted or malformed coordinate order must fail closed');
const invertedResponse = {
  ...response,
  data: {
    ...response.data,
    inverted: true,
    ranges: [{
      ...response.data.ranges[0], loY: 100, nowY: 225, hiY: 350,
    }],
  },
};
assert.ok(validate(invertedResponse, href, expected, viewport),
  'an explicitly inverted chart scale must retain aligned geometry');
assert.equal(validate({
  ...invertedResponse,
  data: {
    ...invertedResponse.data,
    ranges: [{ ...invertedResponse.data.ranges[0], loY: 200, nowY: 200, hiY: 200 }],
  },
}, href, expected, viewport), null,
'an inverted constant interior coordinate must fail closed too');
assert.equal(validate({ ...response, data: { ...response.data, inverted: true } },
  href, expected, viewport), null, 'an inversion flag must match coordinate direction');
assert.equal(validate({ ...response, data: { ...response.data,
  ranges: [{ ...response.data.ranges[0], nowY: Infinity }] } }, href, expected, viewport), null,
'non-finite current coordinates must fail closed');
assert.equal(validate({ ...response, data: { ...response.data,
  plot: { left: 1300, top: 50, width: 800, height: 400 } } }, href, expected, viewport), null,
'a plot wholly outside the viewport must not paint');

const usdLayout = plain(calculate(accepted));
assert.equal(usdLayout.equiv, true);
assert.equal(usdLayout.modeText, 'CURRENT USD EQUIV');
assert.equal(usdLayout.xStart, 576, 'current-equivalent modes should use the chart edge only');
assert.equal(usdLayout.ranges[0].hiLabel, '$6');
assert.equal(usdLayout.ranges[0].loLabel, '$2');
assert.equal(usdLayout.ranges[0].whollyAbove, false);
assert.equal(usdLayout.ranges[0].whollyBelow, false);

const native = plain(calculate({ ...accepted, displayMode: 'price-native' }));
assert.equal(native.equiv, false);
assert.equal(native.xStart, 0, 'native quote mode should align across the full candle plot');
assert.equal(native.ranges[0].hiLabel, '6');
assert.equal(format(2_500_000, 'mcap-usd'), '$2.5M');
assert.equal(format(2_500_000, 'mcap-native'), '2.5M',
  'native market cap must not imply dollars');
assert.equal(format(0.000003442298841, 'price-native'), '0.000003442');
const nativeResponse = {
  ...response,
  data: {
    ...response.data,
    displayMode: 'price-native',
    ranges: [{
      ...response.data.ranges[0], loValue: 1, nowValue: 2, hiValue: 3,
    }],
  },
};
const acceptedNative = plain(validate(nativeResponse, href, expected, viewport));
assert.ok(acceptedNative, 'native values must pass the full worker-to-overlay validation path');
assert.equal(plain(calculate(acceptedNative)).xStart, 0);

const outside = plain(calculate({
  ...accepted,
  ranges: [{ ...accepted.ranges[0], hiY: -50, loY: -10 }],
}));
assert.equal(outside.ranges[0].whollyAbove, true);
const spans = plain(calculate({
  ...accepted,
  ranges: [{ ...accepted.ranges[0], hiY: -50, loY: 500 }],
}));
assert.equal(spans.ranges[0].rangeSpansView, true);
assert.equal(spans.ranges[0].bandY, 0);
assert.equal(spans.ranges[0].bandHeight, 400);

const refreshStart = overlay.indexOf('async function refreshDexscreenerChartGeometry');
const refreshEnd = overlay.indexOf('function startDexscreenerChartSession', refreshStart);
assert.ok(refreshStart > 0 && refreshEnd > refreshStart);
const refresh = overlay.slice(refreshStart, refreshEnd);
assert.match(refresh, /type:\s*'LPLENS_DEXSCREENER_CHART_GEOMETRY'/);
assert.match(refresh, /href:\s*session\.href/);
assert.match(refresh, /ranges:\s*session\.ranges\.map/);
for (const forbidden of [
  /wallet/i, /tokenId/i, /PnL/i, /accessKey/i, /rpc/i, /endpoint/i, /pair:/i,
]) {
  assert.doesNotMatch(refresh, forbidden,
    `chart request acquired a sensitive field: ${forbidden}`);
}
for (const forbidden of [
  /tradingViewApi/, /contentWindow/, /contentDocument/, /postMessage\s*\(/,
  /window\.ethereum\s*[.(=]/, /create(?:MultiPoint)?Shape\s*\(/i,
]) {
  assert.doesNotMatch(overlay, forbidden,
    `isolated overlay crossed into page-world chart state: ${forbidden}`);
}
assert.match(overlay, /attachShadow\(\{ mode: 'closed' \}\)/);
assert.match(overlay, /pointerEvents:\s*'none'/);
assert.match(overlay, /DEXSCREENER_CHART_POLL_MS = 750/);
assert.match(overlay, /DEXSCREENER_CHART_RETRY_MS = \[100, 200, 400\]/);
assert.match(overlay, /DEXSCREENER_CHART_GRACE_MS = 450/);
assert.match(refresh, /session\.misses \+= 1/);
assert.match(refresh, /session\.firstMissAt/);
assert.match(refresh, /markDexscreenerChartRealigning\(\)/);
assert.match(refresh, /isolated-validation-failed/);
assert.match(refresh, /paint-failed/);
assert.match(refresh, /showDexscreenerChartFailure\(reason\)/,
  'a stable local experiment failure must name its reason in the card');
assert.match(refresh, /scheduleDexscreenerChartGeometry\(session, recovery\.delay\)/);
assert.match(overlay, /if \(!panelShadow\) return true;/,
  'a successful SVG paint must survive a temporary panel rerender');
assert.match(overlay, /session\.generation !== dexscreenerGeneration/);
assert.match(overlay, /window\.addEventListener\('pagehide',[\s\S]*stopDexscreenerChartSession/);
assert.match(overlay, /changes\.address[\s\S]*stopDexscreenerChartSession/);
assert.match(overlay, /LOCAL_CHART_EXPERIMENT = 'LPLENS_LOCAL_CHART_EXPERIMENT'/);
assert.match(overlay, /local-experiment-banner/);
assert.match(overlay, /Range drawn on chart/);
assert.match(overlay, /class="gc-sub dex-chart-status" hidden/);
assert.match(render, /\.portfolio-card\.chart-range-aligned \.dex-range \{ display: none; \}/);

console.log('Dexscreener chart overlay: validation, clipping, mode copy, privacy and lifecycle pass');
