/** Authenticated ETH reference reads; bounded local, canonically rechecked cache. */
import { rpcCall } from './rpc.js';
import { CHAINS } from './chains.js';
import { referenceQuery, referenceHeader, referenceProofPrice } from './reference-proof.js';

export const REFERENCE_CACHE_PREFIX = 'refprice:v1:1:';
const CACHE_LIMIT = 300;
const MIN_CACHE_AGE = 3600;
const pending = new Map();
const scopes = new Map();
let scopeCounter = 0;
let writeQueue = Promise.resolve();
let networkQueue = Promise.resolve();
let lastRequestAt = 0;
function scope(value) {
  if (!scopes.has(value)) scopes.set(value, ++scopeCounter);
  return scopes.get(value);
}
const storage = () => globalThis.chrome?.storage?.local;
const keyFor = (q) => REFERENCE_CACHE_PREFIX + (q.block ? `b:${q.block}` : `t:${q.timestamp}`);

async function cached(query, rpc) {
  const store = storage();
  if (!store) return null;
  try {
    const key = keyFor(query);
    const row = (await store.get(key))[key];
    if (!row || row.v !== 1 || !Number.isSafeInteger(row.at)
        || row.at > Date.now() || Date.now() / 1000 - row.proof?.block?.timestamp < MIN_CACHE_AGE
        || referenceProofPrice(row.proof, query) === null) return null;
    // One canonical anchor for a block query; two consecutive headers for time.
    // Failure to validate is a miss, never permission to use an old price.
    for (const expected of [row.proof.block, row.proof.nextBlock].filter(Boolean)) {
      const raw = await rpcCall(rpc, 'eth_getBlockByNumber',
        ['0x' + expected.number.toString(16), false]);
      const fresh = referenceHeader(raw, expected.number);
      if (!fresh || fresh.hash !== expected.hash || fresh.timestamp !== expected.timestamp
          || fresh.parentHash !== expected.parentHash) return null;
    }
    return row.proof;
  } catch { return null; }
}

async function remember(query, proof) {
  const store = storage();
  if (!store || referenceProofPrice(proof, query) === null
      || Date.now() / 1000 - proof.block.timestamp < MIN_CACHE_AGE) return;
  const write = async () => {
    try {
      await store.set({ [keyFor(query)]: { v: 1, at: Date.now(), proof } });
      const all = await store.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith(REFERENCE_CACHE_PREFIX));
      keys.sort((a, b) => (all[b]?.at || 0) - (all[a]?.at || 0));
      if (keys.length > CACHE_LIMIT) await store.remove(keys.slice(CACHE_LIMIT));
    } catch { /* storage is an optimization, never required for a fresh answer */ }
  };
  const task = writeQueue.then(write, write);
  writeQueue = task.catch(() => {});
  await task;
}

async function read(query, relay, rpc) {
  const hit = await cached(query, rpc);
  if (hit) return referenceProofPrice(hit, query);
  // Existing license endpoint only. Never forward credentials to a page/custom URL.
  const expected = 'https://lplens-beta.licence-worker.workers.dev/price';
  if (relay?.priceUrl !== expected || !relay.key || !relay.installationId) return null;
  const request = async () => {
    const gap = 300 - (Date.now() - lastRequestAt);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    lastRequestAt = Date.now();
    try {
      const response = await fetch(expected, {
        method: 'POST', credentials: 'omit', redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: relay.key, installationId: relay.installationId,
          chainId: '1', ...query }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!response.ok) return null;
      const text = await response.text();
      if (text.length > 6000) return null;
      const body = JSON.parse(text);
      if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'proof')) return null;
      const price = referenceProofPrice(body.proof, query);
      if (price === null) return null;
      await remember(query, body.proof);
      return price;
    } catch { return null; }
  };
  // No additional network retry loop. A manual retry or existing public
  // fallback can recover; an unavailable result is never cached.
  const task = networkQueue.then(request, request);
  networkQueue = task.catch(() => null);
  return task;
}

export async function protectedReferencePrice(rawQuery, opts = {}) {
  const query = referenceQuery(rawQuery);
  if (!query) return null;
  const relay = opts.historyRelay;
  const rpc = opts.rpcOverride || CHAINS.ethereum.rpc;
  const key = `${keyFor(query)}/${scope(rpc)}/${scope(relay?.priceUrl)}`
    + `/${scope(relay?.key)}/${scope(relay?.installationId)}`;
  if (pending.has(key)) return pending.get(key);
  const task = read(query, relay, rpc).finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}
