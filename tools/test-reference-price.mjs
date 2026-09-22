#!/usr/bin/env node
import assert from 'node:assert/strict';
import worker, { KEYS, sha256Hex } from './licence-worker/worker.js';
import { priceQuery } from './licence-worker/reference-price.js';
import { ETH_REFERENCE as REF, referenceProofPrice } from '../extension/lib/reference-proof.js';
import { CHAINS } from '../extension/lib/chains.js';

const KEY = 'synthetic-reference-fixture-access';
const SECRET = 'synthetic-provider-fixture';
KEYS[await sha256Hex(KEY)] = { label: 'reference-fixture', expires: '2099-12-31' };
const INSTALL = 'a'.repeat(32);
const B = 25_000_000, T = 1_788_000_000;
const hash = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const hex = (n) => '0x' + n.toString(16);
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const sqrt = 1_500_000_000_000_000_000_000_000_000n;
const header = (n) => ({ number: hex(n), hash: hash(n), parentHash: hash(n - 1),
  timestamp: hex(T + (n - B) * 12) });
const log = (n = B, i = 2) => ({ address: REF.pool, blockNumber: hex(n), blockHash: hash(n),
  logIndex: hex(i), transactionHash: hash(123456), removed: false,
  topics: [REF.topic, hash(123), hash(456)], data: '0x' + [1n, 1n, sqrt, 1n, 0n].map(word).join('') });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
let quota = 0, upstream = 0, mode = 'ok', logsRead = 0, relayCalls = 0, canonicalReads = 0;
let canonical = 'ok', badClientResponse = false;
const sentBodies = [], boundValues = [];
const env = { BLOCKSCOUT_PRO_API_KEY: SECRET, DB: {
  prepare: (sql) => ({ bind: (...args) => { boundValues.push(args); return {
    run: async () => ({}),
    first: async () => sql.includes('INSERT INTO relay_usage_daily')
      ? { requests: ++quota } : { count: 1 },
  }; } }),
} };
const savedFetch = globalThis.fetch, savedTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => savedTimeout(fn, ms <= 300 ? 0 : ms, ...args);
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === 'lplens-beta.licence-worker.workers.dev') {
    relayCalls++; sentBodies.push(JSON.parse(init.body));
    assert.equal(init.redirect, 'error');
    if (badClientResponse) return json({ proof: { v: 0, error: SECRET } });
    return worker.fetch(new Request(url, init), env);
  }
  if (url.hostname === 'ethereum-rpc.publicnode.com') {
    canonicalReads++;
    const body = JSON.parse(init.body);
    assert.equal(body.method, 'eth_getBlockByNumber');
    const n = Number(BigInt(body.params[0]));
    const h = header(n);
    if (canonical === 'reorg') h.hash = hash(n + 1000);
    if (canonical === 'wrong-time') h.timestamp = hex(T + 900);
    if (canonical === 'unreadable') return json({ jsonrpc: '2.0', id: body.id, result: null });
    return json({ jsonrpc: '2.0', id: body.id, result: h });
  }
  if (url.hostname === 'rpc.mainnet.chain.robinhood.com') {
    const body = JSON.parse(init.body);
    assert.equal(body.method, 'eth_getBlockByNumber');
    return json({ jsonrpc: '2.0', id: body.id, result: { number: body.params[0], timestamp: hex(T + 5) } });
  }
  assert.equal(url.hostname, 'api.blockscout.com', 'no arbitrary upstream');
  assert.equal(init.redirect, 'manual', 'never forward provider credentials through a redirect');
  upstream++;
  if (mode === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://evil.invalid' } });
  if (mode === 'provider-error') return json({ error: SECRET }, 429);
  if (mode === 'non-json') return new Response('bad ' + SECRET);
  if (url.pathname === '/v2/api') {
    assert.equal(url.searchParams.get('apikey'), SECRET);
    assert.equal(url.searchParams.get('chain_id'), '1');
    assert.equal(url.searchParams.get('module'), 'block');
    assert.equal(url.searchParams.get('action'), 'getblocknobytime');
    assert.equal(url.searchParams.get('closest'), 'before');
    return json({ status: '1', result: String(B) });
  }
  assert.equal(url.pathname, '/1/json-rpc');
  assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${SECRET}`);
  const body = JSON.parse(init.body);
  const reply = (result) => json({ jsonrpc: '2.0', id: body.id, result });
  if (body.method === 'eth_getBlockByNumber') {
    const n = Number(BigInt(body.params[0]));
    const h = header(n);
    if (mode === 'wrong-header-number') h.number = hex(n + 1);
    if (mode === 'wrong-next' && n === B + 1) h.parentHash = hash(9);
    if (mode === 'wrong-time') h.timestamp = hex(T + 1000);
    if (mode === 'recent') h.timestamp = hex(Math.floor(Date.now() / 1000) - 200);
    return reply(h);
  }
  assert.equal(body.method, 'eth_getLogs', 'no historical eth_call / general RPC');
  logsRead++;
  const filter = body.params[0];
  assert.equal(filter.address, REF.pool);
  assert.deepEqual(filter.topics, [REF.topic]);
  assert.ok(Number(BigInt(filter.toBlock)) - Number(BigInt(filter.fromBlock)) < 4096);
  if (mode === 'empty') return reply([]);
  if (mode === 'saturated') return reply(Array.from({ length: 1000 }, (_, i) => log(B, i)));
  if (mode === 'narrow' && logsRead === 1) return reply(Array.from({ length: 1000 }, (_, i) => log(B, i)));
  if (mode === 'gap') return json({ error: SECRET }, 503);
  const row = log(mode === 'older' ? B - 1 : B);
  if (mode === 'wrong-pool') row.address = hash(1).slice(0, 42);
  if (mode === 'wrong-topic') row.topics[0] = hash(1);
  if (mode === 'removed') row.removed = true;
  if (mode === 'wrong-hash') row.blockHash = hash(1);
  if (mode === 'future-log') row.blockNumber = hex(B + 1);
  if (mode === 'malformed') row.data = '0x';
  if (mode === 'zero-price') row.data = '0x' + [1, 1, 0, 1, 0].map(word).join('');
  if (mode === 'duplicate') return reply([row, row]);
  return reply([row]);
};
const payload = (query = { block: B }) => ({ key: KEY, installationId: INSTALL, chainId: '1', ...query });
const call = (body = payload()) => worker.fetch(new Request('https://test.invalid/price', {
  method: 'POST', body: JSON.stringify(body),
}), env);

try {
  assert.equal(REF.token0, CHAINS.ethereum.usdRef.stable.toLowerCase());
  assert.equal(REF.token1, CHAINS.ethereum.usdRef.weth.toLowerCase());
  for (const invalid of [null, [], {}, payload({ block: 'latest' }), payload({ block: -1 }),
    payload({ block: 1.1 }), payload({ timestamp: T, block: B }),
    { ...payload(), chainId: '8453' }, { ...payload(), url: 'https://evil.invalid' },
    { ...payload(), address: REF.pool }, { ...payload(), topic0: REF.topic },
    { ...payload(), method: 'eth_call' }, { ...payload(), wallet: REF.token0 }]) {
    assert.equal(priceQuery(invalid), null);
    assert.equal((await call(invalid)).status, 400);
  }
  assert.equal(upstream, 0, 'bad requests cannot spend credits');
  assert.equal((await call({ ...payload(), key: 'invalid' })).status, 403);
  assert.equal((await call({ ...payload(), installationId: '' })).status, 401);
  assert.equal(upstream, 0, 'auth failures cannot spend credits');
  const response = await call(payload({ timestamp: T + 5 }));
  assert.equal(response.status, 200);
  const { proof } = await response.json();
  assert.ok(referenceProofPrice(proof, { timestamp: T + 5 }) > 0);
  assert.equal(quota, upstream, 'charge each time, header and log request');
  assert.equal(upstream, 4, 'one time lookup, two headers, one complete log window');
  assert.equal(JSON.stringify(proof).includes(SECRET), false);
  assert.equal(referenceProofPrice(proof, { timestamp: T + 12 }), null, 'no newer timestamp reuse');
  assert.equal(referenceProofPrice(proof, { block: B }), null, 'query identity is exact');
  for (const defect of ['wrong-pool', 'wrong-topic', 'removed', 'wrong-hash', 'future-log',
    'malformed', 'zero-price', 'duplicate', 'wrong-header-number', 'wrong-next',
    'wrong-time', 'provider-error', 'non-json', 'empty', 'saturated', 'gap', 'redirect']) {
    mode = defect; logsRead = 0;
    const before = upstream;
    const failed = await call(payload({ timestamp: T + 5 }));
    assert.notEqual(failed.status, 200, defect);
    assert.equal((await failed.text()).includes(SECRET), false, 'sanitized errors');
    assert.ok(upstream - before <= 14, 'bounded provider work');
    if (defect === 'gap') assert.equal(logsRead, 1, 'refused newest interval cannot skip backwards');
  }
  for (const success of ['older', 'narrow']) {
    mode = success; logsRead = 0;
    assert.equal((await call()).status, 200, success);
  }
  mode = 'ok'; quota = 1000;
  const beforeQuota = upstream;
  assert.equal((await call()).status, 429);
  assert.equal(upstream, beforeQuota, 'quota denied before provider work');
  quota = 0;

  const backing = { licenseKey: 'unchanged', savedWallets: ['unrelated'] };
  globalThis.chrome = { storage: { local: {
    get: async (keys) => keys === null ? structuredClone(backing)
      : Object.fromEntries((typeof keys === 'string' ? [keys] : keys)
        .filter((k) => Object.hasOwn(backing, k)).map((k) => [k, structuredClone(backing[k])])),
    set: async (values) => Object.assign(backing, structuredClone(values)),
    remove: async (keys) => { for (const k of Array.isArray(keys) ? keys : [keys]) delete backing[k]; },
  } } };
  const { protectedReferencePrice, REFERENCE_CACHE_PREFIX } = await import('../extension/lib/reference-price.js');
  const opts = { historyRelay: { priceUrl: 'https://lplens-beta.licence-worker.workers.dev/price',
    key: KEY, installationId: INSTALL } };
  const q = { timestamp: T + 5 };
  const beforeShared = upstream;
  const prices = await Promise.all(Array.from({ length: 6 }, () => protectedReferencePrice(q, opts)));
  assert.ok(prices.every((p) => p > 0 && p === prices[0]));
  assert.equal(upstream - beforeShared, 4, 'concurrent same-config readers share work');
  assert.equal(relayCalls, 1);
  const cacheKey = REFERENCE_CACHE_PREFIX + `t:${T + 5}`;
  assert.ok(backing[cacheKey]);
  assert.equal(JSON.stringify(backing[cacheKey]).includes(KEY), false);
  assert.equal(JSON.stringify(backing[cacheKey]).includes(INSTALL), false);
  const restarted = await import('../extension/lib/reference-price.js?restarted');
  const beforeCache = upstream;
  assert.equal(await restarted.protectedReferencePrice(q, opts), prices[0]);
  assert.equal(upstream, beforeCache, 'persistent success avoids Pro after module restart');
  assert.equal(canonicalReads, 2, 'consecutive canonical headers rechecked');

  const { refUsdAtBlock } = await import('../extension/lib/histprice.js');
  const beforePipeline = canonicalReads;
  assert.equal(await refUsdAtBlock('robinhood', 100, opts), prices[0]);
  assert.equal(await refUsdAtBlock('robinhood', 100, opts), prices[0]);
  assert.equal(canonicalReads - beforePipeline, 4, 'bridged pipeline cannot bypass cache revalidation with a bare in-memory float');

  for (const defect of ['reorg', 'wrong-time', 'unreadable']) {
    canonical = defect;
    const count = relayCalls;
    assert.equal(await protectedReferencePrice(q, opts), prices[0]);
    assert.equal(relayCalls, count + 1, 'invalid cache must obtain fresh proof');
  }
  canonical = 'ok';
  backing[cacheKey].proof.pool = REF.token0;
  const beforeCorrupt = relayCalls;
  assert.equal(await protectedReferencePrice(q, opts), prices[0]);
  assert.equal(relayCalls, beforeCorrupt + 1, 'corrupt pool proof rejected');
  delete backing[cacheKey];
  badClientResponse = true;
  assert.equal(await protectedReferencePrice(q, opts), null);
  assert.equal(backing[cacheKey], undefined, 'malformed response is not cached');
  badClientResponse = false;
  assert.equal(await protectedReferencePrice(q, opts), prices[0], 'failure remains retryable');
  delete backing[cacheKey];
  assert.equal(await protectedReferencePrice(q, { historyRelay: { ...opts.historyRelay,
    priceUrl: 'https://evil.invalid/price' } }), null, 'no credential redirect');
  for (let i = 0; i < 305; i++) backing[REFERENCE_CACHE_PREFIX + `b:${i}`] = { at: i };
  assert.equal(await protectedReferencePrice(q, opts), prices[0]);
  assert.equal(Object.keys(backing).filter((k) => k.startsWith(REFERENCE_CACHE_PREFIX)).length, 300);
  assert.equal(backing.licenseKey, 'unchanged');
  assert.deepEqual(backing.savedWallets, ['unrelated']);
  assert.ok(sentBodies.every((b) => Object.keys(b).sort().join(',') === 'chainId,installationId,key,timestamp'));
  mode = 'recent';
  assert.ok(await protectedReferencePrice({ block: B }, opts) > 0);
  assert.equal(backing[REFERENCE_CACHE_PREFIX + `b:${B}`], undefined, 'recent proof is not persisted');
  assert.ok(boundValues.flat().every((v) => v !== KEY && v !== INSTALL && v !== SECRET), 'DB hashes only');
  console.log('reference price: constrained relay, bounded complete logs, quota, exact time, canonical proof cache and recovery pass');
} finally {
  globalThis.fetch = savedFetch; globalThis.setTimeout = savedTimeout;
  delete globalThis.chrome;
  delete KEYS[await sha256Hex(KEY)];
}
