#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  createDexscreenerPairCache,
  DEXSCREENER_QUOTE_TTL_MS,
} from '../extension/lib/dexscreener.js';

assert.equal(DEXSCREENER_QUOTE_TTL_MS, 30_000,
  'live Dexscreener quotes must expire after 30 seconds');

const POOL = '0x1111111111111111111111111111111111111111';
const BASE = '0x2222222222222222222222222222222222222222';
const QUOTE = '0x3333333333333333333333333333333333333333';

const response = ({ priceNative, priceUsd, marketCap, fdv = null }) => ({
  ok: true,
  json: async () => ({
    pairs: [{
      pairAddress: POOL,
      baseToken: { address: BASE, symbol: 'BASE' },
      quoteToken: { address: QUOTE, symbol: 'QUOTE' },
      priceNative,
      priceUsd,
      marketCap,
      fdv,
    }],
  }),
});

let clock = 0;
let calls = 0;
let releaseConcurrent;
const concurrentResponse = new Promise((resolve) => {
  releaseConcurrent = () => resolve(response({
    priceNative: '0.02', priceUsd: '60', marketCap: '9000000', fdv: '10000000',
  }));
});
const replies = [
  response({ priceNative: '0.01', priceUsd: '20', marketCap: '4000000', fdv: '5000000' }),
  concurrentResponse,
  { ok: false, status: 503 },
  response({ priceNative: '0.025', priceUsd: '80', marketCap: '12000000', fdv: '13000000' }),
];
const fetchImpl = async () => {
  const reply = replies[calls++];
  if (!reply) throw new Error('unexpected Dexscreener fetch');
  return await reply;
};

const cache = createDexscreenerPairCache({ fetchImpl, now: () => clock });
const first = await cache.get('robinhood', POOL);
assert.equal(calls, 1);
assert.deepEqual(first.baseToken, { address: BASE, symbol: 'BASE' });
assert.deepEqual(first.quoteToken, { address: QUOTE, symbol: 'QUOTE' });
assert.equal(first.quoteFresh, true);
assert.equal(first.priceNative, 0.01);
assert.equal(first.priceUsd, 20);
const firstUsdFactor = first.priceUsd / first.priceNative;
const firstMcapFactor = first.marketCap / first.priceNative;

clock = DEXSCREENER_QUOTE_TTL_MS - 1;
assert.equal((await cache.get('ROBINHOOD', POOL.toUpperCase())).quoteFresh, true);
assert.equal(calls, 1, 'fresh quote should reuse the cache');

clock = DEXSCREENER_QUOTE_TTL_MS;
const refreshA = cache.get('robinhood', POOL);
const refreshB = cache.get('robinhood', POOL);
await Promise.resolve();
assert.equal(calls, 2, 'concurrent expired-quote reads must coalesce one fetch');
releaseConcurrent();
const [secondA, secondB] = await Promise.all([refreshA, refreshB]);
assert.deepEqual(secondA, secondB);
assert.equal(secondA.quoteFresh, true);
assert.deepEqual(secondA.baseToken, first.baseToken,
  'immutable pair identity must survive quote refreshes');
assert.deepEqual(secondA.quoteToken, first.quoteToken);
assert.notEqual(secondA.priceUsd / secondA.priceNative, firstUsdFactor,
  'a changed quote must change the USD conversion factor');
assert.notEqual(secondA.marketCap / secondA.priceNative, firstMcapFactor,
  'a changed quote must change the market-cap conversion factor');

clock += DEXSCREENER_QUOTE_TTL_MS;
const failedRefresh = await cache.get('robinhood', POOL);
assert.equal(calls, 3);
assert.equal(failedRefresh.quoteFresh, false);
assert.equal(failedRefresh.priceNative, null);
assert.equal(failedRefresh.priceUsd, null);
assert.equal(failedRefresh.marketCap, null);
assert.equal(failedRefresh.fdv, null,
  'an expired quote must not be returned after refresh failure');
assert.deepEqual(failedRefresh.baseToken, first.baseToken,
  'refresh failure must retain already-proven pair identity');
assert.deepEqual(failedRefresh.quoteToken, first.quoteToken);

clock += 1_000;
const throttled = await cache.get('robinhood', POOL);
assert.equal(calls, 3, 'short failure throttle should avoid a retry storm');
assert.equal(throttled.quoteFresh, false);
assert.equal(throttled.priceUsd, null,
  'failure throttle must not extend the expired quote freshness');

clock += 1_001;
const recovered = await cache.get('robinhood', POOL);
assert.equal(calls, 4, 'quote should retry after the bounded failure throttle');
assert.equal(recovered.quoteFresh, true);
assert.equal(recovered.priceNative, 0.025);
assert.equal(recovered.priceUsd, 80);
assert.notEqual(recovered.priceUsd / recovered.priceNative,
  secondA.priceUsd / secondA.priceNative);

let coldCalls = 0;
const coldReplies = [
  { ok: false, status: 429 },
  response({ priceNative: '0.01', priceUsd: '25', marketCap: '5000000' }),
];
const coldCache = createDexscreenerPairCache({
  now: () => clock,
  fetchImpl: async () => coldReplies[coldCalls++],
});
await assert.rejects(() => coldCache.get('robinhood', POOL), /HTTP 429/);
const coldRecovered = await coldCache.get('robinhood', POOL);
assert.equal(coldCalls, 2,
  'a failed initial lookup must not create a sticky negative cache entry');
assert.equal(coldRecovered.quoteFresh, true);

let malformedCalls = 0;
const malformedReplies = [
  response({ priceNative: null, priceUsd: null, marketCap: null }),
  response({ priceNative: '0.03', priceUsd: '90', marketCap: '14000000' }),
];
const malformedCache = createDexscreenerPairCache({
  now: () => clock,
  fetchImpl: async () => malformedReplies[malformedCalls++],
});
await assert.rejects(
  () => malformedCache.get('robinhood', POOL),
  /live quote malformed/,
  'a cold partial response must fail instead of caching unproven token identity',
);
const malformedRecovered = await malformedCache.get('robinhood', POOL);
assert.equal(malformedCalls, 2,
  'a cold malformed quote must retry immediately instead of returning identity-only data');
assert.equal(malformedRecovered.quoteFresh, true);
assert.deepEqual(malformedRecovered.baseToken, { address: BASE, symbol: 'BASE' });
assert.deepEqual(malformedRecovered.quoteToken, { address: QUOTE, symbol: 'QUOTE' });

console.log('Dexscreener pair cache: identity persistence, live quote expiry, coalescing and retry pass');
