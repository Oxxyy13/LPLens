import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const c = vm.createContext({});
vm.runInContext(readFileSync(new URL('../extension/render.js', import.meta.url), 'utf8'), c);
const { positionValue, positionValueRow } = c.LPLens;
const p = { amount0: 4, amount1: 5, collectable0: 1, collectable1: 2,
  usd: { totalNow: 17, price0: 2, price1: 1 }, history: { unavailable: 'no history' } };
assert.equal(positionValue(p).value, 17, 'current value does not depend on history');
assert.equal(positionValue({ ...p, usd: { ...p.usd, totalNow: null } }).value, 17,
  'fallback includes principal AND pending fees');
assert.equal(positionValue({ ...p, collectable0: null }).value, null,
  'never present principal as gross when fees are unreadable');
assert.equal(positionValue({ ...p, usd: { totalNow: 17, currentValueIncomplete: true } }).value, null);
assert.equal(positionValue({ ...p, usd: { totalNow: NaN } }).value, null);
assert.equal(positionValue({ ...p, usd: undefined }).value, null, 'no fabricated zero price');
assert.equal(positionValue({ ...p, usd: undefined }, 2, 1).value, 17);
assert.equal(positionValue({ amount0: 0, amount1: 0, collectable0: 0, collectable1: 0 }).value, 0);
assert.equal(positionValue({ ...p, usd: { totalNow: 0 } }).value, 0, 'real zero is retained');
assert.equal(positionValue({ ...p, vault: {} }).label, 'estimated exit value');
assert.match(positionValue({ ...p, vault: {} }).note, /after vault fees/);
assert.equal(positionValue({ ...p, vault: { valueUnavailable: 'failed' } }).value, null);
const gauge = positionValue({ ...p, custody: 'gauge', collectable0: null,
  usd: { value: 12, totalNow: null, currentValueIncomplete: true } });
assert.equal(gauge.value, 12); assert.equal(gauge.label, 'active liquidity');
assert.match(positionValueRow(p), /\$17/);
assert.match(positionValueRow(p), /Includes uncollected fees/);
const popup = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
assert.ok(popup.indexOf('${positionValueRow(p, p0, p1)}') < popup.indexOf('<div class="extra">'));
console.log('Position value: current totals, pending fees, unpriced/partial, zero, vault and gauge checks passed');
