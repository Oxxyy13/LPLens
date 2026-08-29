#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const renderSource = readFileSync(new URL('../extension/render.js', import.meta.url), 'utf8');
const overlaySource = readFileSync(new URL('../extension/overlay.js', import.meta.url), 'utf8');
const workerSource = readFileSync(new URL('../extension/sw.js', import.meta.url), 'utf8');
const pairCacheSource = readFileSync(new URL('../extension/lib/dexscreener.js', import.meta.url), 'utf8');
const context = vm.createContext({ globalThis: {} });
vm.runInContext(renderSource, context, { filename: 'render.js' });

const {
  dexscreenerOrientation,
  dexscreenerRangeRuler,
  logRangeScale,
} = context.globalThis.LPLens;

const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const HMM = '0x7fe995a80075df3dc8ae11a9b82c7fe4202cd87f';
const OTHER = '0x1111111111111111111111111111111111111111';
const ZERO = '0x0000000000000000000000000000000000000000';

const position = {
  tokenId: '737471',
  token0: WETH,
  token1: HMM,
  token0Meta: { symbol: 'WETH' },
  token1Meta: { symbol: 'HMM' },
  priceLower: 73089.502979,
  price: 117785.0378,
  priceUpper: 290503.540245,
  status: 'in-range',
  history: {},
};

const reciprocalPair = {
  baseToken: { address: HMM.toUpperCase().replace('0X', '0x'), symbol: 'HMM' },
  quoteToken: { address: WETH, symbol: 'WETH' },
};
const reciprocal = dexscreenerOrientation(position, reciprocalPair);
assert.equal(reciprocal.valid, true);
assert.equal(reciprocal.matched, true);
assert.equal(reciprocal.inverse, true);
assert.equal(reciprocal.unit, 'WETH per HMM');
assert.equal(reciprocal.status, 'in-range');
assert.ok(Math.abs(reciprocal.lo - 1 / position.priceUpper) < 1e-18);
assert.ok(Math.abs(reciprocal.now - 1 / position.price) < 1e-18);
assert.ok(Math.abs(reciprocal.hi - 1 / position.priceLower) < 1e-18);

const directPair = {
  baseToken: { address: WETH, symbol: 'WETH' },
  quoteToken: { address: HMM, symbol: 'HMM' },
};
const direct = dexscreenerOrientation(position, directPair);
assert.equal(direct.valid, true);
assert.equal(direct.inverse, false);
assert.equal(direct.unit, 'HMM per WETH');
assert.equal(direct.lo, position.priceLower);
assert.equal(direct.now, position.price);
assert.equal(direct.hi, position.priceUpper);

const symbolTrap = dexscreenerOrientation({
  ...position,
  token0Meta: { symbol: 'HMM' },
  token1Meta: { symbol: 'WETH' },
}, reciprocalPair);
assert.equal(symbolTrap.inverse, true, 'symbols must never decide orientation');

const mismatch = dexscreenerOrientation(position, {
  baseToken: { address: HMM, symbol: 'HMM' },
  quoteToken: { address: OTHER, symbol: 'OTHER' },
});
assert.equal(mismatch.valid, false);
assert.equal(mismatch.reason, 'pair-token-mismatch');

const nativePosition = { ...position, token0: ZERO };
assert.equal(dexscreenerOrientation(nativePosition, reciprocalPair, WETH).valid, true,
  'configured native/wrapped equivalence should match');
assert.equal(dexscreenerOrientation(nativePosition, reciprocalPair).valid, false,
  'native currency must not alias without an explicit wrapped address');
const ambiguousNative = dexscreenerOrientation({ ...position, token0: ZERO, token1: WETH }, {
  baseToken: { address: WETH, symbol: 'WETH' },
  quoteToken: { address: WETH, symbol: 'WETH' },
}, WETH);
assert.equal(ambiguousNative.valid, false, 'native/WETH ambiguity must fail closed');
assert.equal(ambiguousNative.reason, 'ambiguous-native-wrapped-pair');

const centered = logRangeScale({ valid: true, lo: 1, now: 10, hi: 100 });
assert.ok(Math.abs(centered.nowPct - 50) < 1e-12, 'log midpoint should be geometrically centered');
assert.ok(centered.loPct < centered.nowPct && centered.nowPct < centered.hiPct);
for (const value of [centered.loPct, centered.nowPct, centered.hiPct]) {
  assert.ok(Number.isFinite(value) && value >= 0 && value <= 100);
}
const below = logRangeScale({ valid: true, lo: 10, now: 1, hi: 100 });
const above = logRangeScale({ valid: true, lo: 1, now: 1000, hi: 100 });
assert.ok(below.nowPct < below.loPct, 'below-range marker should sit below the band');
assert.ok(above.nowPct > above.hiPct, 'above-range marker should sit above the band');
assert.equal(logRangeScale({ valid: true, lo: 1, now: 1, hi: 1 }), null);
assert.equal(logRangeScale({ valid: true, lo: 0, now: 1, hi: 2 }), null);
assert.equal(logRangeScale({ valid: true, lo: 1, now: 2, hi: Infinity }), null);
assert.equal(dexscreenerOrientation({ ...position, priceUpper: Infinity }, reciprocalPair).valid, false);
assert.equal(dexscreenerOrientation({ ...position, price: Number.NaN }, reciprocalPair).valid, false);

const html = dexscreenerRangeRuler(position, reciprocalPair, WETH);
assert.match(html, /data-range-orientation="inverse"/);
assert.match(html, /WETH per HMM/);
assert.match(html, /own log scale/i);
assert.match(html, /Not chart-aligned/);
assert.match(html, /position|LP range/);
const unavailable = dexscreenerRangeRuler(position, null, WETH);
assert.match(unavailable, /will not guess from token symbols/);
const providerUnavailable = dexscreenerRangeRuler(
  position, null, WETH, 'pair-metadata-unavailable');
assert.match(providerUnavailable, /temporarily unavailable/);
assert.match(providerUnavailable, /metadata could not be read/);
const invalidRange = dexscreenerRangeRuler({ ...position, price: Number.NaN }, reciprocalPair, WETH);
assert.match(invalidRange, /Range data unavailable/);
const boundary = dexscreenerRangeRuler({
  ...position, price: position.priceLower, status: 'in-range',
}, reciprocalPair, WETH);
assert.doesNotMatch(boundary, /class="dex-range-price now-label"/,
  'near-boundary current labels must not cover a bound label');
assert.match(boundary, /Now [^<]+\. Not chart-aligned/);

const twoRanges = [
  position,
  { ...position, tokenId: '737472', priceLower: 80_000, priceUpper: 240_000 },
].map((item) => dexscreenerRangeRuler(item, reciprocalPair, WETH)).join('');
assert.equal((twoRanges.match(/class="dex-range"/g) || []).length, 2,
  'matching positions must render independently');

const dexStart = overlaySource.indexOf('* Dexscreener pair pages.');
const dexEnd = overlaySource.indexOf('async function syncList()', dexStart);
assert.ok(dexStart > 0 && dexEnd > dexStart);
const dexBlock = overlaySource.slice(dexStart, dexEnd);
for (const forbidden of [
  /contentDocument/, /contentWindow/, /innerText/, /window\.ethereum/,
  /tradingViewApi/, /TradingView/, /getContext\(/, /postMessage\(/, /fetch\(/,
]) {
  assert.doesNotMatch(dexBlock, forbidden, `Dexscreener content script crossed privacy boundary: ${forbidden}`);
}
assert.match(dexBlock, /type: 'LPLENS_DEXSCREENER_POOL',[\s\S]*chain: route\.chain,[\s\S]*poolRef: route\.poolRef/);
assert.match(dexBlock, /positions\.slice\(0, 8\)/);
assert.match(dexBlock, /more matching position/);
assert.match(overlaySource, /function dexscreenerPortfolioCard[\s\S]*position #/);

const pairStart = workerSource.indexOf('async function cachedDexscreenerPair');
const pairEnd = workerSource.indexOf("chrome.runtime.onMessage.addListener", pairStart);
const pairBlock = workerSource.slice(pairStart, pairEnd);
assert.match(pairBlock, /async function cachedDexscreenerPair\(chainKey, poolRef\)/);
assert.match(pairBlock, /return dexscreenerPairs\.get\(apiChain, poolRef\)/);
assert.match(pairCacheSource, /api\.dexscreener\.com\/latest\/dex\/pairs/);
assert.match(pairCacheSource, /AbortSignal\.timeout\(5_000\)/);
assert.doesNotMatch(pairBlock, /address,\s*store|store\.address|walletAddress|activeAddress/,
  'Dexscreener pair metadata request must not receive the active wallet');
assert.match(workerSource, /nativeEquivalent \? String\(usdRef\.weth/,
  'only configured native/wrapped equivalents may be aliased');
assert.match(workerSource, /if \(positions\.length\) \{[\s\S]*cachedDexscreenerPair\(chainKey, poolRef\)/,
  'pair metadata must be requested only after a matching position exists');
assert.match(workerSource, /pairError = 'pair-metadata-unavailable'/,
  'pair provider failures must be surfaced as a bounded category');

console.log('Dexscreener range: address orientation, reciprocal math, log geometry, cap and privacy pass');
