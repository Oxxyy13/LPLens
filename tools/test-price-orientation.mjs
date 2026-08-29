#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/render.js', import.meta.url), 'utf8');
const controller = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
const context = vm.createContext({ globalThis: {} });
vm.runInContext(source, context, { filename: 'render.js' });

const {
  priceOrientation, rangeBar, details, hero,
} = context.globalThis.LPLens;

const position = {
  status: 'below',
  priceLower: 2,
  price: 4,
  priceUpper: 8,
  token0Meta: { symbol: 'CASHCAT' },
  token1Meta: { symbol: 'WETH' },
  usd: { vsHodl: 19.77, pnl: 200, pnlPct: 6.56 },
};
const history = {
  adds: 1,
  entry: { price: 2, exact: true, spread: 0 },
  exit: null,
  vsHodl: { pct: 6.56, feesPct: 6.96, il: 0.004, ilPct: -0.4 },
};

const standard = priceOrientation(position, history, 'CASHCAT', 'WETH', false);
const inverse = priceOrientation(position, history, 'CASHCAT', 'WETH', true);
assert.equal(standard.unit, 'WETH per CASHCAT');
assert.equal(inverse.unit, 'CASHCAT per WETH');
assert.equal(standard.status, 'below');
assert.equal(inverse.status, 'above');
assert.equal(standard.lo, 2);
assert.equal(standard.now, 4);
assert.equal(standard.hi, 8);
assert.equal(inverse.lo, 0.125);
assert.equal(inverse.now, 0.25);
assert.equal(inverse.hi, 0.5);
assert.equal(inverse.entry.price, 0.5);

const bounded = priceOrientation({ ...position }, {
  ...history, entry: { price: 2, exact: false, bound: 'at or below', spread: 0 },
}, 'CASHCAT', 'WETH', true);
assert.equal(bounded.entry.price, 0.5);
assert.equal(bounded.entry.bound, 'at or above');

const range = rangeBar(position, history, true);
assert.match(range, /class="price-flip"/);
assert.match(range, />WETH per CASHCAT</);
assert.match(range, />CASHCAT per WETH</);
assert.match(range, /now 4/);
assert.match(range, /now 0\.25/);

const detail = details(position, history, 'CASHCAT', 'WETH', true);
assert.match(detail, /data-price-view="standard"/);
assert.match(detail, /data-price-view="inverse"/);
assert.match(detail, /WETH per CASHCAT/);
assert.match(detail, /CASHCAT per WETH/);
assert.match(detail, /0\.5/);

const headline = hero(position, history, 'WETH');
assert.match(headline, />\+\$19\.77</);
assert.match(headline, /\+6\.56% · fees minus IL/);

assert.match(controller, /rangeBar\(p, h, flippable\)/);
assert.match(controller, /details\(p, h, s0, s1, flippable\)/);
assert.match(controller, /classList\.toggle\('price-inverted'\)/);
assert.match(controller, /button\.dataset\.priceStandard/);
assert.match(controller, /button\.dataset\.priceInverse/);

console.log('price orientation: reciprocal range, entry, status, details and vs-holding percent pass');
