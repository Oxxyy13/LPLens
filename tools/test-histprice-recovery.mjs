#!/usr/bin/env node
/**
 * Historical USD pricing: shared lookups, honest recovery, honest diagnosis.
 *
 * Three properties are pinned here, all of them about what happens when a
 * public index says no.
 *
 *  1. SHARING. Positions are priced two at a time and every position on a
 *     chain wants the same reference pool and the same reference price. Until
 *     the first answer lands the completed-value caches are empty, so each
 *     caller used to open its own request against exactly the endpoint most
 *     likely to rate-limit. Concurrent callers must now share one request —
 *     and each must still learn why a shared request came back empty, because
 *     a diagnosis delivered only to the first caller silently mislabels the
 *     rest as unexplained.
 *
 *  2. RECOVERY. A refusal is never cached and never left behind in the
 *     in-flight map, so the next attempt asks again and succeeds. Only proven
 *     immutable prices outlive a request.
 *
 *  3. DIAGNOSIS. "Gross additions unpriced" used to read the same for a pair
 *     with no dollar route, a basis that could only be bounded, and one
 *     refused request out of forty. Only the last is worth asking about again.
 *     The reasons are a closed vocabulary of slugs and must never carry an
 *     endpoint, key, address or wallet detail — this repository is public.
 *
 * Every fixture here is synthetic: invented chains, invented addresses,
 * invented amounts, no network.
 */
import assert from 'node:assert/strict';

globalThis.chrome = { storage: { local: {
  get: async () => ({}), set: async () => {}, remove: async () => {},
} } };

const { CHAINS } = await import('../extension/lib/chains.js');
const {
  refUsdAtBlock, PRICE_FAILURE, RETRYABLE_PRICE_FAILURES,
} = await import('../extension/lib/histprice.js');
const { attachUsd } = await import('../extension/lib/positions.js');

const REF = 'histprice_recovery_ref';
const BRIDGE = 'histprice_recovery_bridge';
const REF_RPC = 'https://reference.fixture.invalid/rpc';
const ALT_RPC = 'https://alternate.fixture.invalid/rpc';
const SLOW_RPC = 'https://held.fixture.invalid/rpc';
const BRIDGE_RPC = 'https://bridged.fixture.invalid/rpc';

const addr = (byte) => '0x' + String(byte).repeat(20);
const FACTORY = addr('a1');
const STABLE = addr('a2');
const WETH = addr('a3');
const REF_POOL = addr('a4');
const POSITION_POOL = addr('a5');
const ALT = addr('a6');
const ALT2 = addr('a7');
const ALT3 = addr('b1');

const SEL = {
  getPool: '0x1698ee82', token0: '0x0dfe1681', slot0: '0x3850c7bd',
};
const SWAP_TOPIC =
  '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

const word = (value) => BigInt(value).toString(16).padStart(64, '0');
// USDC-style stable sorted to token0, so the reference price inverts.
const sqrtForUsd = (usd) => BigInt(Math.round(Math.sqrt(1e12 / usd) * 2 ** 96));
const usdForSqrt = (sqrt) => 1e12 / ((Number(sqrt) / 2 ** 96) ** 2);

const LATEST_SQRT = sqrtForUsd(2200);
const HISTORICAL_SQRT = sqrtForUsd(2000);
const LATEST_USD = usdForSqrt(LATEST_SQRT);
const HISTORICAL_USD = usdForSqrt(HISTORICAL_SQRT);

CHAINS[REF] = {
  label: 'Histprice recovery reference fixture',
  factory: FACTORY,
  rpc: REF_RPC,
  usdRef: {
    stable: STABLE, weth: WETH, stableDecimals: 6, nativeEquivalent: true,
  },
};
CHAINS[BRIDGE] = {
  label: 'Histprice recovery bridged fixture',
  rpc: BRIDGE_RPC,
  usdRef: {
    stable: addr('a8'), weth: addr('a9'), stableDecimals: 6, via: REF,
  },
};

// The reference chain has no configured explorer, so a bridged timestamp is
// aligned by the on-chain header search. Twelve-second blocks from genesis
// make that search exactly reproducible.
const REF_LATEST_BLOCK = 20_000_000;
const REF_BLOCK_SECONDS = 12;

// Three endpoints for the same fixture chain: the configured default, a
// corrected user override, and one that can be held mid-request on demand.
const REF_HOSTS = {
  [REF_RPC]: { count: 'refLogs', mode: 'refLogs' },
  [ALT_RPC]: { count: 'refLogsAlt', mode: 'refLogsAlt' },
  [SLOW_RPC]: { count: 'refLogsSlow', mode: 'refLogsSlow' },
};

const counts = {
  getPool: 0, token0: 0, slot0: 0, refLogs: 0, refLogsAlt: 0, refLogsSlow: 0,
  poolLogs: 0, bridgeBlock: 0, refBlock: 0, dexscreener: 0,
};
const mode = {
  refLogs: 'ok', refLogsAlt: 'ok', refLogsSlow: 'ok',
  poolLogs: 'ok', bridgeBlock: 'ok',
};
let dexscreenerPrices = {};
let slowGate = null;

const refusal = (body) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({
    jsonrpc: '2.0', id: body.id,
    error: { code: -32000, message: 'fixture provider refusal' },
  }),
});
const reply = (body, result) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ jsonrpc: '2.0', id: body.id, result }),
});
const swapLog = (address, block, sqrt) => ({
  address,
  topics: [SWAP_TOPIC],
  // amount0, amount1, sqrtPriceX96, liquidity, tick
  data: '0x' + word(1n) + word(1n) + word(sqrt) + word(1n) + word(0n),
  blockNumber: '0x' + block.toString(16),
  transactionHash: '0x' + 'ab'.repeat(32),
  logIndex: '0x0',
});

globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  if (url.startsWith('https://api.dexscreener.com/')) {
    counts.dexscreener++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        pairs: Object.entries(dexscreenerPrices).map(([token, priceUsd]) => ({
          chainId: 'fixture',
          baseToken: { address: token },
          priceUsd: String(priceUsd),
          liquidity: { usd: 250000 },
        })),
      }),
    };
  }

  const body = JSON.parse(init.body);
  if (url === BRIDGE_RPC) {
    if (body.method !== 'eth_getBlockByNumber') {
      throw new Error(`unexpected bridged method ${body.method}`);
    }
    counts.bridgeBlock++;
    if (mode.bridgeBlock !== 'ok') return refusal(body);
    return reply(body, { number: body.params[0], timestamp: '0x5f5e100' });
  }
  const host = REF_HOSTS[url];
  if (!host) throw new Error(`unexpected host ${url}`);

  if (body.method === 'eth_getBlockByNumber') {
    counts.refBlock++;
    const tag = body.params[0];
    const number = tag === 'latest' ? REF_LATEST_BLOCK : Number(BigInt(tag));
    return reply(body, {
      number: '0x' + number.toString(16),
      timestamp: '0x' + (number * REF_BLOCK_SECONDS).toString(16),
    });
  }

  if (body.method === 'eth_call') {
    const data = String(body.params[0].data || '');
    const to = String(body.params[0].to || '').toLowerCase();
    if (data.startsWith(SEL.getPool)) {
      counts.getPool++;
      return reply(body, '0x' + word(REF_POOL));
    }
    if (data.startsWith(SEL.token0)) {
      counts.token0++;
      return reply(body, '0x' + word(STABLE));
    }
    if (data.startsWith(SEL.slot0)) {
      counts.slot0++;
      assert.equal(to, REF_POOL, 'only the reference pool serves latest state');
      return reply(body, '0x' + word(LATEST_SQRT) + word(0n));
    }
    throw new Error(`unexpected selector ${data.slice(0, 10)}`);
  }

  if (body.method === 'eth_getLogs') {
    const filter = body.params[0];
    const address = String(filter.address || '').toLowerCase();
    const to = Number(BigInt(filter.toBlock));
    if (address === POSITION_POOL) {
      counts.poolLogs++;
      if (mode.poolLogs !== 'ok') return refusal(body);
      return reply(body, [swapLog(POSITION_POOL, to, HISTORICAL_SQRT)]);
    }
    assert.equal(address, REF_POOL, 'only known fixture pools are queried');
    counts[host.count]++;
    // Lets a request be parked mid-flight so a slower provider can settle
    // after a faster one has already proven the same block.
    if (url === SLOW_RPC && slowGate) await slowGate;
    if (mode[host.mode] !== 'ok') return refusal(body);
    return reply(body, [swapLog(REF_POOL, to, HISTORICAL_SQRT)]);
  }
  throw new Error(`unexpected method ${body.method}`);
};

const reset = () => {
  for (const key of Object.keys(counts)) counts[key] = 0;
};
const near = (actual, expected, label) => assert.ok(
  Number.isFinite(actual) && Math.abs(actual - expected) < 1e-6,
  `${label}: got ${actual}, wanted ${expected}`);

/** A fresh sink per caller, exactly as `attachUsd` builds them. */
const sink = () => ({ priceFailures: new Set() });

// ---------------------------------------------------------------------------
// 1. Concurrent callers share one reference-pool discovery and one price read.
// ---------------------------------------------------------------------------
async function testConcurrentLookupsAreShared() {
  reset();
  const [a, b] = await Promise.all([
    refUsdAtBlock(REF, 4096, {}),
    refUsdAtBlock(REF, 4096, {}),
  ]);
  near(a, HISTORICAL_USD, 'first concurrent caller');
  near(b, HISTORICAL_USD, 'second concurrent caller');
  assert.equal(counts.getPool, 1, 'reference-pool discovery must not duplicate');
  assert.equal(counts.token0, 1, 'pool orientation must not duplicate');
  assert.equal(counts.refLogs, 1,
    'concurrent callers for one block must share one historical read');

  // A different block still pays for its own price, and only its own price.
  reset();
  near(await refUsdAtBlock(REF, 8192, {}), HISTORICAL_USD, 'second block');
  assert.equal(counts.getPool, 0, 'a proven reference pool is memoised');
  assert.equal(counts.refLogs, 1, 'each distinct block reads its own Swap');

  // And a repeat of a proven block costs nothing at all.
  reset();
  near(await refUsdAtBlock(REF, 4096, {}), HISTORICAL_USD, 'memoised block');
  assert.equal(counts.refLogs, 0, 'a proven historical price is immutable');
}

// ---------------------------------------------------------------------------
// 2. A refusal reaches every waiter, is never cached, and recovers next time.
// ---------------------------------------------------------------------------
async function testRefusalIsSharedThenRecovers() {
  reset();
  mode.refLogs = 'refuse';
  const first = sink();
  const second = sink();
  const [a, b] = await Promise.all([
    refUsdAtBlock(REF, 12288, first),
    refUsdAtBlock(REF, 12288, second),
  ]);
  assert.equal(a, null, 'a refused historical read must fail closed');
  assert.equal(b, null, 'a refused historical read must fail closed for both');
  assert.deepEqual([...first.priceFailures], [PRICE_FAILURE.REFERENCE_PRICE],
    'the caller that opened the shared request must be told why it failed');
  assert.deepEqual([...second.priceFailures], [PRICE_FAILURE.REFERENCE_PRICE],
    'a waiter on a shared request must be told why it failed too');

  mode.refLogs = 'ok';
  reset();
  const recovered = sink();
  near(await refUsdAtBlock(REF, 12288, recovered), HISTORICAL_USD,
    'a refused block must be retried, not remembered as unpriceable');
  assert.ok(counts.refLogs > 0, 'recovery must actually ask again');
  assert.equal(recovered.priceFailures.size, 0,
    'a successful lookup records no failure');
}

// ---------------------------------------------------------------------------
// 3. A bridged chain names the half of the bridge that failed, and recovers.
// ---------------------------------------------------------------------------
async function testBridgedTimeAlignmentFailure() {
  reset();
  mode.bridgeBlock = 'refuse';
  const failed = sink();
  assert.equal(await refUsdAtBlock(BRIDGE, 512, failed), null,
    'an unreadable local block time must not produce a dollar mark');
  assert.deepEqual([...failed.priceFailures], [PRICE_FAILURE.REFERENCE_TIME],
    'a failed block/time alignment is its own diagnosis');
  assert.ok(RETRYABLE_PRICE_FAILURES.includes(PRICE_FAILURE.REFERENCE_TIME),
    'a refused time alignment is worth asking about again');

  mode.bridgeBlock = 'ok';
  const recovered = sink();
  // The origin chain's block for that timestamp is found by the on-chain
  // header search, which is the last of the three mappers.
  const price = await refUsdAtBlock(BRIDGE, 512, recovered);
  assert.equal(recovered.priceFailures.size, 0,
    'the recovered bridged read records no failure');
  near(price, HISTORICAL_USD, 'recovered bridged price');
  assert.ok(counts.refBlock > 1, 'the header search aligned the timestamp');
}

// ---------------------------------------------------------------------------
// 4. Sharing stops at the provider boundary.
// ---------------------------------------------------------------------------
async function testDifferentProvidersAreNotShared() {
  reset();
  mode.refLogs = 'refuse';
  mode.refLogsAlt = 'refuse';
  const configured = { priceFailures: new Set() };
  const overridden = { priceFailures: new Set(), rpcOverride: ALT_RPC };
  const [a, b] = await Promise.all([
    refUsdAtBlock(REF, 36864, configured),
    refUsdAtBlock(REF, 36864, overridden),
  ]);
  assert.equal(a, null);
  assert.equal(b, null);
  assert.ok(counts.refLogs > 0, 'the configured endpoint was asked');
  assert.ok(counts.refLogsAlt > 0,
    'an override must open its own request, not wait on the other endpoint');
  assert.deepEqual([...configured.priceFailures],
    [PRICE_FAILURE.REFERENCE_PRICE]);
  assert.deepEqual([...overridden.priceFailures],
    [PRICE_FAILURE.REFERENCE_PRICE],
    'both provider configurations must receive their own diagnosis');

  // A corrected override succeeds on its own terms while the default is still
  // refusing, which is the whole point of not sharing the pending request.
  mode.refLogsAlt = 'ok';
  const fixed = { priceFailures: new Set(), rpcOverride: ALT_RPC };
  near(await refUsdAtBlock(REF, 40960, fixed), HISTORICAL_USD,
    'corrected override');
  assert.equal(fixed.priceFailures.size, 0);
  mode.refLogs = 'ok';
}

// ---------------------------------------------------------------------------
// 5. A late refusal cannot evict a price another provider already proved.
// ---------------------------------------------------------------------------
async function testLateFailureCannotEvictAProvenPrice() {
  reset();
  const block = 45056;
  let release;
  slowGate = new Promise((resolve) => { release = resolve; });
  mode.refLogsSlow = 'refuse';
  const held = { priceFailures: new Set(), rpcOverride: SLOW_RPC };
  const pending = refUsdAtBlock(REF, block, held);

  // The configured endpoint proves the block while the other is still parked.
  near(await refUsdAtBlock(REF, block, {}), HISTORICAL_USD, 'proven price');

  release();
  near(await pending, HISTORICAL_USD,
    'a refusal that lands late must yield the proven price, never null');
  assert.equal(held.priceFailures.size, 0,
    'a caller handed a verified price has nothing to report');

  reset();
  mode.refLogs = 'refuse';
  near(await refUsdAtBlock(REF, block, {}), HISTORICAL_USD,
    'the verified historical price survived the late refusal');
  assert.equal(counts.refLogs, 0, 'a proven block is never read again');
  mode.refLogs = 'ok';
  mode.refLogsSlow = 'ok';
  slowGate = null;
}

// ---------------------------------------------------------------------------
// 6. Nothing but the closed slug vocabulary can escape.
// ---------------------------------------------------------------------------
function testReasonVocabularyIsClosedAndClean() {
  const slugs = Object.values(PRICE_FAILURE);
  assert.equal(new Set(slugs).size, slugs.length, 'slugs must be distinct');
  for (const slug of slugs) {
    assert.match(slug, /^[a-z][a-z-]*[a-z]$/,
      `${slug} must be a bare lower-case slug`);
    assert.ok(!/0x|http|key|token|wallet|\d/.test(slug),
      `${slug} must not carry an endpoint, key or identifier`);
  }
  for (const slug of RETRYABLE_PRICE_FAILURES) {
    assert.ok(slugs.includes(slug), `${slug} must be part of the vocabulary`);
  }
  assert.ok(!RETRYABLE_PRICE_FAILURES.includes(PRICE_FAILURE.UNSUPPORTED_PAIR),
    'a pair with no dollar route will not improve on a retry');
  assert.ok(!RETRYABLE_PRICE_FAILURES.includes(PRICE_FAILURE.POOL_PRICE),
    'an unread pool Swap and a quiet pool are indistinguishable from here');
}

// ---------------------------------------------------------------------------
// 5. attachUsd: a transient reference failure is unavailable AND retryable.
// ---------------------------------------------------------------------------
const referencePosition = (block) => ({
  chain: REF,
  tokenId: 1n,
  pool: POSITION_POOL,
  token0: ALT,
  token1: WETH,
  token0Meta: { symbol: 'ALT', decimals: 18 },
  token1Meta: { symbol: 'WETH', decimals: 18 },
  price: 0.5,
  amount0: 10,
  amount1: 5,
  collectable0: 0,
  collectable1: 0,
  history: {
    adds: 1,
    firstBlock: block,
    deposited0: 10,
    deposited1: 5,
    deposits: [{
      block, amount0: 10, amount1: 5, entry: { price: 0.5, exact: true },
    }],
    collections: [],
  },
});

async function testTransientBasisFailureIsRetryable() {
  reset();
  dexscreenerPrices = {};
  mode.refLogs = 'refuse';
  const priced = await attachUsd(REF, referencePosition(20480), {});
  mode.refLogs = 'ok';

  assert.equal(priced.usd.grossAdded, null, 'a refused basis must stay unpriced');
  assert.equal(priced.usd.pnl, null, 'no return without a complete basis');
  assert.equal(priced.usd.returnUnavailable, 'gross additions unpriced',
    'the existing wording is what surfaces render');
  assert.equal(priced.usd.returnRetryable, true,
    'a refused reference price is worth asking about again');
  assert.deepEqual(priced.usd.returnUnavailableReasons,
    [PRICE_FAILURE.REFERENCE_PRICE]);
  // The current mark is produced by a different read and survives.
  near(priced.usd.currentValue, 10 * (0.5 * LATEST_USD) + 5 * LATEST_USD,
    'current value must not be withheld because history was refused');
}

// ---------------------------------------------------------------------------
// 6. attachUsd: an exact event-time basis is preserved unchanged.
// ---------------------------------------------------------------------------
async function testExactBasisIsPreserved() {
  reset();
  dexscreenerPrices = {};
  const priced = await attachUsd(REF, referencePosition(24576), {});

  assert.equal(priced.usd.returnUnavailable, null, 'an exact basis is available');
  assert.equal(priced.usd.returnRetryable, false);
  assert.deepEqual(priced.usd.returnUnavailableReasons, []);
  assert.equal(priced.usd.grossAddedExact, true);
  assert.equal(priced.usd.capitalEvents[0].source, 'event-math',
    'the event-solved ratio still prices the deposit');
  near(priced.usd.grossAdded,
    10 * (0.5 * HISTORICAL_USD) + 5 * HISTORICAL_USD, 'gross added');
  assert.ok(Number.isFinite(priced.usd.pnl), 'a complete basis yields a return');
}

// ---------------------------------------------------------------------------
// 7. attachUsd: a pair with no dollar route stays unavailable, not retryable.
// ---------------------------------------------------------------------------
async function testUnsupportedPairIsNotRetryable() {
  reset();
  // Tokens never quoted in an earlier group, so the short-lived DexScreener
  // memo cannot answer for them before the feed does.
  dexscreenerPrices = { [ALT2]: 3, [ALT3]: 7 };
  const position = referencePosition(28672);
  position.token0 = ALT2;
  position.token0Meta = { symbol: 'ALT2', decimals: 18 };
  position.token1 = ALT3;
  position.token1Meta = { symbol: 'ALT3', decimals: 18 };

  const priced = await attachUsd(REF, position, {});
  assert.equal(priced.usd.markSource, 'dexscreener',
    'a pair off the reference route still marks from the public feed');
  assert.equal(priced.usd.returnUnavailable, 'gross additions unpriced');
  assert.equal(priced.usd.returnRetryable, false,
    'no retry can invent a dollar route for this pair');
  assert.deepEqual(priced.usd.returnUnavailableReasons,
    [PRICE_FAILURE.UNSUPPORTED_PAIR]);
  near(priced.usd.currentValue, 10 * 3 + 5 * 7, 'current value from the feed');
}

// ---------------------------------------------------------------------------
// 8. attachUsd: a bounded addition stays bounded, and offers no retry.
// ---------------------------------------------------------------------------
async function testBoundedBasisStaysInexact() {
  reset();
  dexscreenerPrices = {};
  mode.poolLogs = 'refuse';
  const position = referencePosition(32768);
  position.history.deposits[0].entry = { price: 0.5, exact: false };
  const priced = await attachUsd(REF, position, {});
  mode.poolLogs = 'ok';

  assert.ok(counts.poolLogs > 0, 'the position pool was consulted');
  assert.equal(priced.usd.grossAddedExact, false,
    'a single-sided addition priced from an event bound is not exact');
  assert.ok(Number.isFinite(priced.usd.grossAdded),
    'the bound still produces a figure, it is simply not exact');
  assert.equal(priced.usd.returnUnavailable, 'gross additions are bounded');
  assert.equal(priced.usd.returnRetryable, false,
    'asking again returns the same bound');
  assert.deepEqual(priced.usd.returnUnavailableReasons,
    [PRICE_FAILURE.POOL_PRICE],
    'the unread pool Swap is reported without inviting a retry');
  assert.equal(priced.usd.pnl, null, 'a bounded basis withholds LP return');
}

try {
  await testConcurrentLookupsAreShared();
  await testRefusalIsSharedThenRecovers();
  await testBridgedTimeAlignmentFailure();
  await testDifferentProvidersAreNotShared();
  await testLateFailureCannotEvictAProvenPrice();
  testReasonVocabularyIsClosedAndClean();
  await testTransientBasisFailureIsRetryable();
  await testExactBasisIsPreserved();
  await testUnsupportedPairIsNotRetryable();
  await testBoundedBasisStaysInexact();
  console.log('histprice recovery: 8 regression groups passed — shared lookups,'
    + ' per-provider requests, uncached refusals, sanitized reasons');
} finally {
  delete CHAINS[REF];
  delete CHAINS[BRIDGE];
  delete globalThis.chrome;
}
