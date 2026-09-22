#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const overlay = readFileSync(new URL('../extension/overlay.js', import.meta.url), 'utf8');
const block = (name) => {
  const start = overlay.indexOf(`// BEGIN ${name}`);
  const end = overlay.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `missing testable ${name}`);
  return overlay.slice(start, end);
};
const calls = [];
const timers = [];
let clock = 50_000;
let reply;
let paints = 0;
const ctx = vm.createContext({
  console, Number, String,
  Date: { now: () => clock },
  torndown: false, listGeneration: 1, listRows: [],
  LIST_ROUTE: /^\/positions\/?$/, LIST_RETRY_COOLDOWN_MS: 10_000,
  location: { pathname: '/positions' },
  listPaint: () => paints++,
  contextAlive: () => true,
  shutdownOrphan: () => { ctx.torndown = true; },
  isOrphanError: () => false,
  setTimeout: (fn, ms) => { const id = timers.length; timers.push({ fn, ms }); return id; },
  clearTimeout() {},
  chrome: { runtime: { sendMessage: (msg) => {
    calls.push(msg);
    return new Promise((resolve) => { reply = resolve; });
  } } },
});
vm.runInContext(`${block('PURE LIST RETURN STATE')}
${block('UNISWAP LIST ROW READ')}
globalThis.api = { listReturnState, retryListRow, readListRow };`, ctx);
const { listReturnState: state, retryListRow: retry, readListRow: read } = ctx.api;
const missing = () => ({ history: { vsHodl: { pct: 5 } },
  usd: { pnl: null, returnUnavailable: 'gross additions unpriced', value: 100,
    returnUnavailableReasons: ['reference-price-unavailable'], returnRetryable: true } });
const success = () => ({ history: { vsHodl: { pct: 5 } }, usd: { pnl: 4, pnlPct: 4 } });
const row = (tokenId = '42', version = 'v4') => {
  const href = `/positions/${version}/robinhood/${tokenId}`;
  return { chain: 'robinhood', tokenId, version, href, allowRetry: true,
    data: missing(), anchor: { isConnected: true, getAttribute: () => href } };
};

assert.equal(state(success()), null);
assert.equal(state({ usd: { pnl: 0 } }), null, 'a proved zero remains a return');
assert.notEqual(state({ usd: { pnl: NaN } }), null);
assert.notEqual(state({ usd: { pnl: Infinity } }), null);
assert.equal(state(missing()).label, 'Prices missing');
assert.equal(state({ ...missing(), history: { unavailable: 'private raw error' } }).label, 'History missing');
assert.equal(state({ usd: { pnl: null, returnUnavailable: 'gross additions are bounded' } }).canRetry, false);
assert.equal(state({ usd: { pnl: null, returnUnavailable: 'collected proceeds are bounded' } }).canRetry, false);
assert.equal(state({ usd: null }).canRetry, false);
assert.equal(state({ usd: { pnl: null, returnUnavailable: 'gross additions unpriced',
  returnRetryable: false } }).canRetry, false);
assert.equal(state({ usd: { pnl: null, returnUnavailable: 'gross additions unpriced',
  returnUnavailableReasons: ['unsupported-pair'], returnRetryable: false } }).label, 'No USD route');
assert.equal(state({ history: { unavailable: 'Unsupported lifecycle' } }).canRetry, false);
assert.equal(state({ history: { unavailable: 'history RPC failed' }, usd: { returnRetryable: false } }).canRetry, true,
  'retrying position history is distinct from a pricing-only retry flag');
assert.doesNotMatch(JSON.stringify(state({ error: 'https://secret.fixture.invalid/?apikey=redacted' })),
  /apikey|fixture|redacted/, 'raw provider errors must not become list copy');

const first = row();
const second = row('43', 'v3');
ctx.listRows = [first, second];
const pending = retry(first, 1);
assert.equal(calls.length, 1);
assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
  type: 'LPLENS_POSITION', chain: 'robinhood', tokenId: '42', version: 'v4',
});
assert.equal(first.reading, true);
assert.equal(first.data.usd.value, 100, 'retry preserves the readable card while waiting');
await retry(first, 1);
assert.equal(calls.length, 1, 'double clicks coalesce locally');
reply({ ok: true, data: success() });
await pending;
assert.equal(first.data.usd.pnl, 4);
assert.equal(second.data.usd.pnl, null, 'only the clicked position is requested');
assert.equal(first.reading, false);
for (const timer of [...timers]) timer.fn();
assert.equal(calls.length, 1, 'cooldown timers may repaint but never fetch');

first.data = missing();
await retry(first, 1);
assert.equal(calls.length, 1, 'cooldown prevents a rapid retry loop');
clock += 10_001;
const stale = retry(first, 1);
ctx.listGeneration = 2;
reply({ ok: true, data: success() });
await stale;
assert.equal(first.data.usd.pnl, null, 'late response from a previous generation is discarded');
assert.equal(calls.length, 2);

ctx.listGeneration = 1;
clock += 10_001;
ctx.location.pathname = '/positions/v3/robinhood/43';
await retry(first, 1);
assert.equal(calls.length, 2, 'retry cannot run after leaving the list');
ctx.location.pathname = '/positions';
first.anchor.isConnected = false;
await retry(first, 1);
assert.equal(calls.length, 2, 'a detached row cannot authorize a retry');
first.anchor.isConnected = true;
first.anchor.getAttribute = () => '/positions/v4/robinhood/99';
await retry(first, 1);
assert.equal(calls.length, 2, 'a changed position link invalidates the request');
first.anchor.getAttribute = () => first.href;
first.gated = true;
await retry(first, 1);
assert.equal(calls.length, 2, 'access failures do not offer a retry loop');
first.gated = false;

const gated = read(second, 1);
reply({ gated: true, entitlement: { allowed: false } });
await gated;
assert.equal(second.gated, true);
assert.ok(second.data.error);
assert.ok(paints > 0);
assert.match(overlay, /event\.isTrusted !== true/);
assert.match(overlay, /shadow\.addEventListener\('click', handleListRetry\)/);
assert.match(overlay, /listRows = \[\];\s*listPaint = null/);
assert.match(overlay, /for \(const row of listRows\) clearTimeout\(row\.retryTimer\)/);
console.log('overlay return recovery: honest labels, single-row retry, cooldown, gates and stale-response rejection pass');
