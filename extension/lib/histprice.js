/**
 * Historical USD pricing, read from chain rather than fetched from a price API.
 *
 * This retires the project's oldest documented limitation. USD PnL was refused
 * because it needs a dollar mark at the moment each deposit happened, and no
 * keyless source provides one — pricing an old basket at today's rate is the
 * `token_delta × price_now` error. That was true of price *APIs*. It is not
 * true of the chain: a USDC/WETH pool's price at a historical block is the
 * dollar price of ETH at that block, exactly.
 *
 * HOW that price is read changed on 2026-08-23. It used to be `slot0` at a
 * historical block, which needs an archive node. It is now the pool's own
 * `Swap` event at or before that block, which needs only a log index — see
 * `poolSqrtAtBlock` for why the two are equivalent and why the `eth_call`
 * form had to go. Historical `eth_call` is no longer used for pricing on any
 * chain, and an archive RPC is no longer required for any of this.
 *
 * No CoinGecko, no additional DexScreener call, no new user-supplied key. The
 * authenticated Ethereum route pins the factory-verified USDC/WETH 0.05% pool;
 * other reference pools are derived from the v3 factory. Historically, all four
 * chains independently produce the same WETH price to within 0.4 basis points —
 * which is the cross-check that the derivation is right.
 *
 * BRIDGED ASSETS. Some chains do not have a trusted local dollar route for
 * their wrapped native asset. Robinhood Chain's WETH is one example, so that
 * asset is priced by mapping the local block to its timestamp, that timestamp
 * to an Ethereum block, and reading the Ethereum reference pool there. A
 * configured stablecoin on the same chain remains a direct $1 anchor.
 *
 * That last path carries an ASSUMPTION the same-chain path does not: that the
 * bridged token holds its peg to the asset it represents. Arbitrage makes that
 * reliable, but it is an assumption rather than a derivation, so results are
 * flagged `bridged` and the UI says so.
 *
 * WHAT IT CANNOT DO. Only positions with a leg in the reference token (WETH) or
 * in the stablecoin can be priced this way; anything else would need a second
 * hop through a pool that may not exist, and returns null instead of a guess.
 * A single-sided event yields a bounded pair price. A direct reference-token
 * leg or archival slot0 can still price its dollar flow exactly; otherwise the
 * bound is reported and LP return is withheld.
 */
import { ethCall, rpcCall } from './rpc.js';
import {
  words, toUint, toAddress, encAddress, encUint, SELECTOR,
} from './abi.js';
import { CHAINS } from './chains.js';
import { fetchLastLogBefore } from './logs.js';
import { humanPrice } from './v3.js';
import { protectedReferencePrice } from './reference-price.js';

const SEL_TOKEN0 = '0x0dfe1681';   // token0(), derived with keccak256

// Swap(address,address,int256,int256,uint160,uint128,int24), derived with
// keccak256 via lib/keccak.js on 2026-08-23 — never recalled.
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

/**
 * Why a historical dollar lookup produced nothing.
 *
 * Every path in this module fails closed to `null`, which is right for the
 * arithmetic and useless for the reader: "gross additions unpriced" reads the
 * same whether the pair simply has no dollar route or a public index refused
 * one request out of forty. The UI cannot offer a retry it cannot justify, so
 * a position that lost a single reference lookup stayed blank for the life of
 * the rendered list.
 *
 * This is a CLOSED vocabulary of slugs, deliberately. Text carrying an
 * endpoint, an API key, a pool address or a wallet identifier must never reach
 * a surface that renders, logs or exports it, and this repository is public.
 * `notePriceFailure` drops anything that is not one of these constants, so the
 * guarantee holds even if a future caller passes an exception through.
 */
export const PRICE_FAILURE = Object.freeze({
  /** The chain's reference pool could not be resolved from its factory. */
  REFERENCE_POOL: 'reference-pool-unavailable',
  /** The reference pool was known but its price at that block did not read. */
  REFERENCE_PRICE: 'reference-price-unavailable',
  /** A bridged asset's block/timestamp alignment did not resolve. */
  REFERENCE_TIME: 'reference-time-unavailable',
  /** The position's own pool had no readable Swap at or before the block. */
  POOL_PRICE: 'pool-price-unavailable',
  /** Neither leg is the reference token or the stablecoin: no dollar route. */
  UNSUPPORTED_PAIR: 'unsupported-pair',
});

/**
 * Failures a later attempt can plausibly recover from.
 *
 * Deliberately narrow. `UNSUPPORTED_PAIR` is a property of the pair and will
 * never improve. `POOL_PRICE` is excluded because `fetchLastLogBefore`
 * returns the same null for a provider refusal and for a pool that genuinely
 * did not trade inside the lookback window, so offering a retry would promise
 * a recovery this module cannot distinguish. Widening this set needs a source
 * that separates those two cases, not a guess here.
 */
export const RETRYABLE_PRICE_FAILURES = Object.freeze([
  PRICE_FAILURE.REFERENCE_POOL,
  PRICE_FAILURE.REFERENCE_PRICE,
  PRICE_FAILURE.REFERENCE_TIME,
]);

const KNOWN_PRICE_FAILURES = new Set(Object.values(PRICE_FAILURE));

/**
 * Record why a lookup failed, when the caller asked to be told.
 *
 * `opts.priceFailures` is an optional Set supplied by the caller. Callers that
 * do not pass one see exactly the previous behaviour, which keeps every
 * existing consumer and test of these exports unchanged.
 */
function notePriceFailure(opts, reason) {
  if (!reason || !KNOWN_PRICE_FAILURES.has(reason)) return null;
  const sink = opts && opts.priceFailures;
  if (sink && typeof sink.add === 'function') sink.add(reason);
  return null;
}

/**
 * Share one in-flight network resolution between concurrent callers.
 *
 * Positions are priced two at a time, and every position on a bridged chain
 * asks for the same reference pool and the same `latest` reference price. The
 * completed-value caches already dedupe those once the first answer lands;
 * until then each caller opened its own request against exactly the endpoint
 * most likely to rate-limit. Sharing the pending promise removes the duplicate
 * without adding a cache.
 *
 * Two properties matter. The entry is dropped the moment it settles, so a
 * refusal is never handed to a later caller and recovery is never poisoned —
 * only the existing success caches outlive a request. And the resolver returns
 * its diagnosis alongside its value rather than recording it, because a shared
 * promise must not give the first caller the reason and leave the rest with an
 * unexplained null.
 *
 * Sharing is keyed on the provider configuration as well as the chain, pool
 * and block. A completed price is a chain fact and stays endpoint-independent,
 * but a PENDING request is not: a user who has just corrected a failing RPC
 * override must not be made to wait on the old endpoint's doomed request
 * merely because the block matches. See `providerScope`.
 */
function shareInFlight(map, key, resolve) {
  const existing = map.get(key);
  if (existing) return existing;
  let task;
  const settle = () => { if (map.get(key) === task) map.delete(key); };
  task = (async () => resolve())().then(
    (value) => { settle(); return value; },
    (err) => { settle(); throw err; },
  );
  map.set(key, task);
  return task;
}

/**
 * Opaque, process-local stand-in for one endpoint or key.
 *
 * An RPC override can carry a credential in its path, and a configured
 * explorer key is a credential outright. Neither may appear in a map key that
 * some future diagnostic might print, so the scope is an arbitrary counter
 * value instead. This table is module-private, never exported, never
 * serialized, and holds only references to strings the caller already owns.
 */
const scopeTokens = new Map();
let nextScopeToken = 0;
function scopeToken(value) {
  if (!value) return '-';
  let token = scopeTokens.get(value);
  if (token === undefined) {
    token = `s${++nextScopeToken}`;
    scopeTokens.set(value, token);
  }
  return token;
}

/**
 * Which providers a pending lookup would actually use.
 *
 * Two callers may differ in their local RPC, in the origin-chain RPC a bridged
 * price needs, or in whether an explorer key is configured. Those requests can
 * succeed and fail independently, so they must not be coalesced into one.
 */
function providerScope(chainKey, opts = {}) {
  const chain = CHAINS[chainKey] || {};
  const via = chain.usdRef && chain.usdRef.via;
  const origin = via
    ? (opts.rpcOverrides && opts.rpcOverrides[via]) || (CHAINS[via] || {}).rpc
    : null;
  return [
    scopeToken(opts.rpcOverride || chain.rpc),
    scopeToken(origin),
    scopeToken(opts.etherscanKey || chain.etherscanKey),
    scopeToken(opts.historyRelay?.priceUrl),
    scopeToken(opts.historyRelay?.key),
    scopeToken(opts.historyRelay?.installationId),
  ].join('/');
}

/**
 * A v3 pool's price at a historical block, read as an EVENT rather than as
 * state.
 *
 * Only a swap moves `sqrtPriceX96` — mints and burns do not — so the last
 * `Swap` at or before a block carries exactly the `slot0` price at that
 * block. That equivalence is what makes this a derivation and not an
 * approximation, and it holds on a pruned node, because logs outlive state.
 *
 * This is now the ONLY historical price path. A historical `eth_call` was
 * retired for this purpose on 2026-08-23: `rpc.hyperliquid.xyz/evm` answers
 * one with LATEST state instead of refusing, so `slot0` at a mint block
 * returned today's price and the resulting USD basis was wrong by the whole
 * size of the move while still labelled exact. A silent wrong answer is worse
 * than none, and no cheap check distinguishes a lying node from an honest one
 * using only the methods `lib/rpc.js` permits. Reading the event instead
 * removes the question rather than guarding it.
 *
 * Returns null when no swap is found in range. Callers must fail closed.
 */
async function poolSqrtAtBlock(chainKey, pool, block, opts = {}) {
  const chain = CHAINS[chainKey];
  if (!chain || !pool || block === null || block === undefined || block === 'latest') return null;
  const log = await fetchLastLogBefore({
    contract: pool,
    topics: [SWAP_TOPIC],
    block,
    rpc: opts.rpcOverride || chain.rpc,
    etherscanKey: opts.etherscanKey,
    etherscanChainId: chain.etherscanChainId,
    blockscout: chain.blockscout,
  });
  const w = log ? words(log.data) : [];
  if (w.length < 5) return null;              // sqrtPriceX96 is word 2 of five
  const sqrt = toUint(w[2]);
  return sqrt > 0n ? sqrt : null;
}

const poolCache = new Map();    // `${chain}` -> {pool, stableIsToken0, stableDecimals}
const priceCache = new Map();   // `${chain}:${block}` -> number | null
const positionPriceCache = new Map(); // `${chain}:${pool}:${block}` -> pool price
const timeBlockCache = new Map(); // `${chain}:${timestamp}` -> reference-chain block
const blockHeaderCache = new Map(); // `${chain}:${block}` -> {number,timestamp}
// Pending requests, keyed by provider scope as well as subject: see
// `providerScope`. Entries live only until the request settles.
const refPriceInFlight = new Map();      // `${chain}:${block}/${scope}`
const referencePoolInFlight = new Map(); // `${chain}/${scope}`
const positionPriceInFlight = new Map(); // `${chain}:${pool}:${block}/${scope}`
const LATEST_PRICE_TTL_MS = 60_000;
const ETHERSCAN_LOOKUP_GAP_MS = 350;
const BLOCKSCOUT_LOOKUP_GAP_MS = 250;
let etherscanLookupQueue = Promise.resolve();
let blockscoutLookupQueue = Promise.resolve();
let onChainLookupQueue = Promise.resolve();
let lastEtherscanLookupAt = 0;
let lastBlockscoutLookupAt = 0;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Serialize timestamp lookups so one multi-position scan stays under free-tier limits. */
async function referenceBlockAtTime(target, timestamp, key) {
  const cacheKey = `${target.etherscanChainId}:${timestamp}`;
  if (timeBlockCache.has(cacheKey)) return timeBlockCache.get(cacheKey);

  const lookup = async () => {
    if (timeBlockCache.has(cacheKey)) return timeBlockCache.get(cacheKey);
    const gap = Date.now() - lastEtherscanLookupAt;
    if (gap < ETHERSCAN_LOOKUP_GAP_MS) await wait(ETHERSCAN_LOOKUP_GAP_MS - gap);
    for (let attempt = 0; attempt < 3; attempt++) {
      lastEtherscanLookupAt = Date.now();
      try {
        const qs = new URLSearchParams({
          chainid: String(target.etherscanChainId), module: 'block',
          action: 'getblocknobytime', timestamp: String(timestamp),
          closest: 'before', apikey: key,
        });
        const res = await fetch(`https://api.etherscan.io/v2/api?${qs}`);
        const body = await res.json();
        if (body.status === '1') {
          const block = Number(body.result);
          if (block > 0) {
            timeBlockCache.set(cacheKey, block);
            return block;
          }
        }
      } catch { /* retry below */ }
      if (attempt < 2) await wait(500 * (attempt + 1));
    }
    return null;
  };

  const task = etherscanLookupQueue.then(lookup, lookup);
  etherscanLookupQueue = task.catch(() => null);
  return task;
}

/**
 * Keyless timestamp -> block lookup through the chain's public Blockscout.
 *
 * This is one indexed request. The former keyless-first path immediately ran
 * a ~25-read binary search against Ethereum dRPC for every historical cash-flow
 * time. A four-card Robinhood overlay exhausted dRPC's public-endpoint window,
 * withholding every dollar return and sometimes 429ing the final card. Keep
 * the exact on-chain search below as a fallback, not as the common path.
 */
export async function referenceBlockAtTimeBlockscout(target, timestamp) {
  if (!target?.blockscout || !Number.isFinite(Number(timestamp))) return null;
  const cacheKey = `${target.etherscanChainId || target.blockscout}:${timestamp}`;
  if (timeBlockCache.has(cacheKey)) return timeBlockCache.get(cacheKey);

  const lookup = async () => {
    if (timeBlockCache.has(cacheKey)) return timeBlockCache.get(cacheKey);
    const gap = Date.now() - lastBlockscoutLookupAt;
    if (gap < BLOCKSCOUT_LOOKUP_GAP_MS) {
      await wait(BLOCKSCOUT_LOOKUP_GAP_MS - gap);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      lastBlockscoutLookupAt = Date.now();
      try {
        const url = new URL(target.blockscout);
        url.searchParams.set('module', 'block');
        url.searchParams.set('action', 'getblocknobytime');
        url.searchParams.set('timestamp', String(timestamp));
        url.searchParams.set('closest', 'before');
        const res = await fetch(url);
        const body = await res.json();
        const raw = body?.result?.blockNumber ?? body?.result;
        const block = Number(raw);
        if (res.ok && body?.status === '1' && Number.isInteger(block) && block > 0) {
          timeBlockCache.set(cacheKey, block);
          return block;
        }
      } catch { /* retry below */ }
      if (attempt < 2) await wait(500 * (attempt + 1));
    }
    return null;
  };

  const task = blockscoutLookupQueue.then(lookup, lookup);
  blockscoutLookupQueue = task.catch(() => null);
  return task;
}

/**
 * Highest block whose timestamp is <= target. The caller supplies a bracket
 * and a header reader, which keeps the binary-search contract independently
 * testable without network access.
 */
export async function findBlockAtOrBefore(timestamp, low, high, headerAt) {
  let lo = low, hi = high;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const header = await headerAt(mid);
    if (!header || !Number.isFinite(header.timestamp)) return null;
    if (header.timestamp <= timestamp) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Keyless timestamp -> block lookup using eth_getBlockByNumber only. */
async function referenceBlockOnChain(chainKey, target, timestamp, opts = {}) {
  const cacheKey = `${target.etherscanChainId || chainKey}:${timestamp}`;
  if (timeBlockCache.has(cacheKey)) return timeBlockCache.get(cacheKey);

  const lookup = async () => {
    if (timeBlockCache.has(cacheKey)) return timeBlockCache.get(cacheKey);
    const rpc = opts.rpcOverride || target.rpc;
    if (!rpc) return null;

    const headerAt = async (block) => {
      const key = `${chainKey}:${block}`;
      if (blockHeaderCache.has(key)) return blockHeaderCache.get(key);
      try {
        const raw = await rpcCall(rpc, 'eth_getBlockByNumber',
          ['0x' + BigInt(block).toString(16), false]);
        if (!raw?.number || !raw?.timestamp) return null;
        const header = {
          number: Number(BigInt(raw.number)),
          timestamp: Number(BigInt(raw.timestamp)),
        };
        blockHeaderCache.set(key, header);
        return header;
      } catch { return null; }
    };

    let latestRaw;
    try {
      latestRaw = await rpcCall(rpc, 'eth_getBlockByNumber', ['latest', false]);
    } catch { return null; }
    if (!latestRaw?.number || !latestRaw?.timestamp) return null;
    const latest = {
      number: Number(BigInt(latestRaw.number)),
      timestamp: Number(BigInt(latestRaw.timestamp)),
    };
    blockHeaderCache.set(`${chainKey}:${latest.number}`, latest);
    if (timestamp >= latest.timestamp) return latest.number;

    // Recent LP activity is the common case. Start with a generous ~7-hour
    // Ethereum window, then expand exponentially for older positions. The
    // bracket is verified by timestamp before binary search, so 12 seconds is
    // only a performance estimate, never a correctness assumption.
    const age = latest.timestamp - timestamp;
    let span = Math.max(2048, Math.ceil(age / 12) * 4);
    let low = Math.max(0, latest.number - span);
    let lowHeader = await headerAt(low);
    while (low > 0 && lowHeader && lowHeader.timestamp > timestamp) {
      span *= 4;
      low = Math.max(0, latest.number - span);
      lowHeader = await headerAt(low);
    }
    if (!lowHeader || lowHeader.timestamp > timestamp) return null;

    const block = await findBlockAtOrBefore(timestamp, low, latest.number, headerAt);
    if (block !== null) timeBlockCache.set(cacheKey, block);
    return block;
  };

  // Multiple cards can ask for bridged prices together. Serialize this small
  // proof so public RPC rate limits do not turn concurrency into false gaps.
  const task = onChainLookupQueue.then(lookup, lookup);
  onChainLookupQueue = task.catch(() => null);
  return task;
}

/** Resolve the chain's USDC/WETH reference pool from the factory, once. */
export async function referencePool(chainKey, rpc) {
  if (poolCache.has(chainKey)) return poolCache.get(chainKey);
  const chain = CHAINS[chainKey];
  const ref = chain && chain.usdRef;
  if (!ref) { poolCache.set(chainKey, null); return null; }

  // Three fee tiers times two reads is the most expensive thing this module
  // does per chain, and every position on that chain needs the same answer.
  return shareInFlight(referencePoolInFlight, `${chainKey}/${scopeToken(rpc)}`, async () => {
    if (poolCache.has(chainKey)) return poolCache.get(chainKey);
    let resolved = null;
    for (const fee of [500, 3000, 100]) {
      try {
        const hex = await ethCall(rpc, chain.factory,
          SELECTOR.getPool + encAddress(ref.stable) + encAddress(ref.weth) + encUint(fee));
        const pool = toAddress(words(hex)[0] || '');
        if (/^0x0{40}$/i.test(pool)) continue;
        const t0 = toAddress(words(await ethCall(rpc, pool, SEL_TOKEN0))[0]);
        resolved = {
          pool,
          stableIsToken0: t0.toLowerCase() === ref.stable.toLowerCase(),
          stableDecimals: ref.stableDecimals ?? 6,
        };
        break;
      } catch { /* try the next fee tier */ }
    }
    // A configured reference pool can be deployed later, and a zero response
    // is indistinguishable from a lagging or misbehaving RPC. Only a
    // successfully decoded nonzero pool is immutable enough to cache.
    if (resolved) poolCache.set(chainKey, resolved);
    return resolved;
  });
}

/**
 * USD price of the reference token (WETH) at a given block.
 *
 * Historical prices are immutable, so the cache never needs invalidating —
 * unlike anything keyed on current state.
 */
export async function refUsdAtBlock(chainKey, block, opts = {}) {
  const { price, failure } = await refUsdResult(chainKey, block, opts);
  // Noted here rather than inside the shared resolution, so that every waiter
  // on one coalesced request learns why it came back empty.
  if (price === null || price === undefined) notePriceFailure(opts, failure);
  return price;
}

/** `refUsdAtBlock` plus its diagnosis, shared across concurrent callers. */
async function refUsdResult(chainKey, block, opts = {}) {
  const key = `${chainKey}:${block}`;
  const proofRoute = block !== 'latest' && opts.historyRelay?.priceUrl
    && (chainKey === 'ethereum' || CHAINS[chainKey]?.usdRef?.via === 'ethereum');
  if (priceCache.has(key) && !proofRoute) {
    const hit = priceCache.get(key);
    // Only proven prices are ever stored, so a hit is never a cached refusal.
    if (block !== 'latest') return { price: hit, failure: null };
    if (hit && Date.now() - hit.at < LATEST_PRICE_TTL_MS) {
      return { price: hit.price, failure: null };
    }
    priceCache.delete(key);
  }
  return shareInFlight(refPriceInFlight, `${key}/${providerScope(chainKey, opts)}`,
    () => resolveRefUsd(chainKey, key, block, opts));
}

async function resolveRefUsd(chainKey, key, block, opts) {
  const proofRoute = block !== 'latest' && opts.historyRelay?.priceUrl
    && (chainKey === 'ethereum' || CHAINS[chainKey]?.usdRef?.via === 'ethereum');
  // A second caller can have landed the answer while this one queued.
  if (priceCache.has(key) && block !== 'latest' && !proofRoute) {
    return { price: priceCache.get(key), failure: null };
  }
  const remember = (price) => {
    // Null usually means a provider refusal or rate limit, not a chain fact.
    // Keeping it would make a transient failure stick for the service worker's
    // whole lifetime, so only successful immutable prices are memoised.
    if (price !== null && price !== undefined) {
      if (!proofRoute) priceCache.set(key, block === 'latest' ? { price, at: Date.now() } : price);
      return price;
    }
    // A failure never evicts and never overwrites. Requests on different
    // providers run independently, so a slow refusal can land after a fast
    // success for the same immutable block; deleting here would throw away a
    // verified price. Expiring a stale `latest` mark belongs in the lookup,
    // which already does it, and writing nothing still leaves a failed
    // historical block free to be retried.
    if (block !== 'latest' && priceCache.has(key) && !proofRoute) return priceCache.get(key);
    return null;
  };

  const chain = CHAINS[chainKey];
  const rpc = opts.rpcOverride || (chain && chain.rpc);

  // `remember` can hand back a price another provider proved while this
  // attempt was failing, so the diagnosis follows what the caller actually
  // receives rather than what this attempt managed on its own.
  const settled = (price, failure) => {
    const kept = remember(price);
    return { price: kept, failure: kept === null ? failure : null };
  };

  // Bridged chain: price the asset where it actually has dollar liquidity.
  if (chain && chain.usdRef && chain.usdRef.via) {
    const bridged = await bridgedUsd(chainKey, block, opts);
    if (bridged.protected) return { price: bridged.price, failure: null };
    return settled(bridged.price, bridged.failure);
  }

  if (chainKey === 'ethereum' && block !== 'latest') {
    const protectedPrice = await protectedReferencePrice({ block: Number(block) }, opts);
    if (protectedPrice !== null) return { price: protectedPrice, failure: null };
  }

  const ref = await referencePool(chainKey, rpc);
  if (!ref) {
    // A chain with no configured reference has no dollar route at all; a
    // configured one that did not resolve is a lookup that can be retried.
    return settled(null, chain && chain.usdRef
      ? PRICE_FAILURE.REFERENCE_POOL : PRICE_FAILURE.UNSUPPORTED_PAIR);
  }

  // Latest is state every node serves; anything historical is read as a Swap
  // event, because a historical eth_call cannot be trusted (see
  // poolSqrtAtBlock).
  let sqrtX96 = null;
  try {
    if (block === 'latest') {
      const hex = await ethCall(rpc, ref.pool, SELECTOR.slot0, undefined, 'latest');
      sqrtX96 = toUint(words(hex)[0]);
    } else {
      sqrtX96 = await poolSqrtAtBlock(chainKey, ref.pool, block, opts);
    }
  } catch {
    sqrtX96 = null;
  }
  if (!sqrtX96) return settled(null, PRICE_FAILURE.REFERENCE_PRICE);

  let price = null;
  const sqrtP = Number(sqrtX96) / 2 ** 96;
  const raw = sqrtP * sqrtP;                       // raw token1 per token0
  const scale = 10 ** (18 - ref.stableDecimals);   // WETH is 18dp
  // Orientation depends on which side the stablecoin sorted to.
  price = ref.stableIsToken0 ? scale / raw : raw * scale;
  if (!Number.isFinite(price) || price <= 0) price = null;
  return settled(price, PRICE_FAILURE.REFERENCE_PRICE);
}

/**
 * Price a bridged asset using the chain it was bridged from.
 *
 * Local block -> its timestamp (an RPC call, a chain fact) -> the reference
 * chain's block at that time (Etherscan when configured, otherwise public
 * Blockscout, with an on-chain binary search last) -> the reference pool read
 * there. These mapping services supply a block number, not a price; the dollar
 * figure still comes out of a Uniswap pool.
 */
async function bridgedUsd(chainKey, block, opts = {}) {
  const chain = CHAINS[chainKey];
  const via = chain.usdRef.via;
  const target = CHAINS[via];
  if (!target) return { price: null, failure: PRICE_FAILURE.UNSUPPORTED_PAIR };

  // 'latest' needs no time alignment. The origin chain reports its own
  // diagnosis; this side adds nothing to it. The sink is dropped because the
  // caller of the bridged read records the outcome once, for every waiter.
  const viaOpts = {
    ...opts,
    priceFailures: null,
    rpcOverride: opts.rpcOverrides?.[via] || undefined,
  };
  if (block === 'latest') return refUsdResult(via, 'latest', viaOpts);

  let timestamp = null;
  try {
    const rpc = opts.rpcOverride || chain.rpc;
    const blk = await rpcCall(rpc, 'eth_getBlockByNumber',
      ['0x' + BigInt(block).toString(16), false]);
    if (blk && blk.timestamp) timestamp = Number(BigInt(blk.timestamp));
  } catch { return { price: null, failure: PRICE_FAILURE.REFERENCE_TIME }; }
  if (!timestamp) return { price: null, failure: PRICE_FAILURE.REFERENCE_TIME };

  if (via === 'ethereum') {
    const protectedPrice = await protectedReferencePrice({ timestamp }, viaOpts);
    if (protectedPrice !== null) return { price: protectedPrice, failure: null, protected: true };
  }

  const key = opts.etherscanKey || target.etherscanKey;
  let targetBlock = key && target.etherscanChainId
    ? await referenceBlockAtTime(target, timestamp, key) : null;
  if (!targetBlock) {
    targetBlock = await referenceBlockAtTimeBlockscout(target, timestamp);
  }
  if (!targetBlock) {
    targetBlock = await referenceBlockOnChain(via, target, timestamp, viaOpts);
  }
  // Every mapper refused. A past timestamp always has a block, so this is a
  // failed lookup rather than a fact about the chain.
  if (!targetBlock) return { price: null, failure: PRICE_FAILURE.REFERENCE_TIME };

  return refUsdResult(via, targetBlock, viaOpts);
}

/**
 * Dollar prices for a position's two tokens at one moment, derived from the
 * pool ratio at that moment plus the reference pool.
 *
 * `poolPrice` is token1 per token0, decimal-adjusted — the position's own
 * entry price for a historical moment, or its current price for now. One leg
 * must be the reference token or the stablecoin; otherwise there is no path to
 * dollars that does not involve inventing one, and null is returned.
 *
 * Used for every historical cash-flow leg and for the current mark. Mixing an
 * event-time source with an unrelated current price feed would make one return
 * subtraction depend on sources that can disagree.
 */
export async function usdPairAt(chainKey, token0, token1, poolPrice, block, opts = {}) {
  const chain = CHAINS[chainKey];
  const ref = chain && chain.usdRef;
  if (!ref) return notePriceFailure(opts, PRICE_FAILURE.UNSUPPORTED_PAIR);
  // A missing ratio is the caller's own gap, not a property of this pair.
  if (!(poolPrice > 0)) return null;

  const weth = (ref.weth || '').toLowerCase();
  const normaliseToken = (token) => {
    const address = String(token).toLowerCase();
    // v4 represents the native coin as address(0). On chains whose USD
    // reference explicitly marks wrapped-native equivalence, ETH and WETH
    // (or HYPE and WHYPE) have the same unit price. Polygon deliberately does
    // not set this flag: its native POL is not the configured WETH reference.
    if (ref.nativeEquivalent && /^0x0{40}$/.test(address)) return weth;
    return address;
  };
  const t0 = normaliseToken(token0);
  const t1 = normaliseToken(token1);
  // A stable address is optional, but when present it is the exact verified
  // contract address. Token symbols never participate in this trust decision.
  const stable = (ref.stable || '').toLowerCase();

  if (stable && t1 === stable) {
    return { usd0: poolPrice, usd1: 1, bridged: false };
  }
  if (stable && t0 === stable) {
    return { usd0: 1, usd1: 1 / poolPrice, bridged: false };
  }
  if (weth && (t1 === weth || t0 === weth)) {
    const wethUsd = await refUsdAtBlock(chainKey, block, opts);
    if (!wethUsd) return null;
    return t1 === weth
      ? { usd0: poolPrice * wethUsd, usd1: wethUsd, bridged: !!ref.via }
      : { usd0: wethUsd, usd1: wethUsd / poolPrice, bridged: !!ref.via };
  }
  // Neither leg is the reference token or the stablecoin. Reaching dollars
  // would need a second hop through a pool that may not exist, so there is
  // nothing here for a later attempt to recover.
  return notePriceFailure(opts, PRICE_FAILURE.UNSUPPORTED_PAIR);
}

/** Exact position-pool price at a historical block, read as a `Swap` event. */
async function positionPoolPrice(chainKey, p, block, opts = {}) {
  if (!p.pool || block === null || block === undefined) {
    return { price: null, failure: null };
  }
  const key = `${chainKey}:${String(p.pool).toLowerCase()}:${block}`;
  if (positionPriceCache.has(key)) {
    return { price: positionPriceCache.get(key), failure: null };
  }
  const chain = CHAINS[chainKey];
  if (!chain) return { price: null, failure: null };
  // Several flows of one position, and several positions in one pool, land on
  // the same block often enough to be worth sharing the pending log query.
  const pending = `${key}/${providerScope(chainKey, opts)}`;
  return shareInFlight(positionPriceInFlight, pending, async () => {
    if (positionPriceCache.has(key)) {
      return { price: positionPriceCache.get(key), failure: null };
    }
    try {
      // Was a historical eth_call, which carried the same silent-latest-state
      // defect as the reference read and would have stamped a single-sided add
      // or fee-only collect exact on a present-day price.
      const sqrtX96 = await poolSqrtAtBlock(chainKey, p.pool, block, opts);
      if (!sqrtX96) return { price: null, failure: PRICE_FAILURE.POOL_PRICE };
      const price = humanPrice(
        sqrtX96, p.token0Meta.decimals, p.token1Meta.decimals);
      if (!(price > 0) || !Number.isFinite(price)) {
        return { price: null, failure: PRICE_FAILURE.POOL_PRICE };
      }
      positionPriceCache.set(key, price);
      return { price, failure: null };
    } catch {
      // Do not cache failure: a transient index refusal is not a chain fact.
      return { price: null, failure: PRICE_FAILURE.POOL_PRICE };
    }
  });
}

/**
 * Price a flow without needing the pair ratio when every non-zero leg is
 * already a dollar reference (stablecoin or WETH). This makes a single-sided
 * WETH/USDC flow exact even when the position pool has no archival RPC.
 */
async function directPairAt(chainKey, p, flow, opts = {}) {
  const chain = CHAINS[chainKey];
  const ref = chain && chain.usdRef;
  if (!ref) return null;
  const weth = String(ref.weth || '').toLowerCase();
  const tokens = [p.token0, p.token1].map((token) => {
    const address = String(token).toLowerCase();
    return ref.nativeEquivalent && /^0x0{40}$/.test(address) ? weth : address;
  });
  const amounts = [flow.amount0, flow.amount1];
  const stable = String(ref.stable || '').toLowerCase();
  let wethUsd;
  let bridged = false;
  const out = [];
  for (let i = 0; i < 2; i++) {
    // A zero leg does not need a price. In particular, do not make an
    // origin-chain request or attach its caveat to a cash flow that did not
    // actually contain the bridged reference asset.
    if (amounts[i] === 0) out[i] = 0;
    else if (stable && tokens[i] === stable) out[i] = 1;
    else if (weth && tokens[i] === weth) {
      if (wethUsd === undefined) wethUsd = await refUsdAtBlock(chainKey, flow.block, opts);
      if (!(wethUsd > 0)) return null;
      out[i] = wethUsd;
      bridged ||= !!ref.via;
    } else return null;
  }
  return {
    usd0: out[0], usd1: out[1], exact: true, source: 'direct-reference', bridged,
  };
}

/**
 * Historical USD pair for one Increase/Collect cash flow.
 *
 * Exact event math is cheapest and needs no network call at all. Direct
 * reference tokens come next. The pool's own historical `Swap` price then
 * resolves otherwise-underdetermined single-sided adds and fee-only collects.
 * The event's range bound is the final fallback and stays explicitly inexact.
 */
async function historicalPairAt(chainKey, p, flow, opts = {}) {
  if (flow.entry && flow.entry.exact && flow.entry.price > 0) {
    const pair = await usdPairAt(
      chainKey, p.token0, p.token1, flow.entry.price, flow.block, opts);
    return pair ? { ...pair, exact: true, source: 'event-math' } : null;
  }

  const direct = await directPairAt(chainKey, p, flow, opts);
  if (direct) return direct;

  const pool = await positionPoolPrice(chainKey, p, flow.block, opts);
  if (pool.price) {
    const pair = await usdPairAt(
      chainKey, p.token0, p.token1, pool.price, flow.block, opts);
    if (pair) return { ...pair, exact: true, source: 'pool-swap-event' };
  } else {
    // Recorded, but not treated as retryable: an unreadable pool and a pool
    // that simply did not trade in the window look identical from here.
    notePriceFailure(opts, pool.failure);
  }

  if (flow.entry && flow.entry.price > 0) {
    const pair = await usdPairAt(
      chainKey, p.token0, p.token1, flow.entry.price, flow.block, opts);
    return pair ? { ...pair, exact: false, source: 'event-bound' } : null;
  }
  return null;
}

/**
 * Gross USD value added to the LP, with each addition valued at its block.
 *
 * The position's own entry price supplies the ratio between its two tokens at
 * that moment — exactly, solved from the mint event — and the reference pool
 * supplies one side in dollars. Together they price both legs with no external
 * feed involved.
 *
 * Returns null when neither leg is the reference token or the stablecoin.
 */
export async function costBasisUsd(chainKey, p, opts = {}) {
  const chain = CHAINS[chainKey];
  const ref = chain && chain.usdRef;
  const h = p.history;
  if (!ref) return notePriceFailure(opts, PRICE_FAILURE.UNSUPPORTED_PAIR);
  // Missing history is not a pricing failure; the caller already says so.
  if (!h || h.unavailable) return null;
  const deposits = h.deposits && h.deposits.length ? h.deposits : (
    h.entry && h.firstBlock ? [{
      block: h.firstBlock, amount0: h.deposited0, amount1: h.deposited1, entry: h.entry,
    }] : []);
  return sumDepositBasis(deposits,
    (deposit) => historicalPairAt(chainKey, p, deposit, opts));
}

/** Sum each liquidity addition at its own historical block and pool price. */
export async function sumDepositBasis(deposits, priceAt) {
  if (!Array.isArray(deposits) || !deposits.length) return null;
  let basis = 0;
  let exact = true;
  let bridged = false;
  const legs = [];
  for (const deposit of deposits) {
    const pair = await priceAt(deposit);
    if (!pair) return null;
    const value = deposit.amount0 * pair.usd0 + deposit.amount1 * pair.usd1;
    if (!Number.isFinite(value) || value < 0) return null;
    basis += value;
    bridged ||= pair.bridged === true;
    if (pair.exact === false || (pair.exact === undefined
        && (!deposit.entry || deposit.entry.exact === false))) exact = false;
    legs.push({
      block: deposit.block, value, usd0: pair.usd0, usd1: pair.usd1,
      exact: pair.exact !== false, source: pair.source || null,
      bridged: pair.bridged === true,
      time: deposit.time || null,
      transactionHash: deposit.transactionHash || null,
      amount0: deposit.amount0,
      amount1: deposit.amount1,
      poolPrice: deposit.entry && deposit.entry.price > 0 ? deposit.entry.price : null,
    });
  }
  if (!(basis > 0)) return null;
  return {
    basis,
    block: deposits[0].block,
    exact,
    bridged,
    bound: exact ? null : 'one or more liquidity additions were single-sided',
    legs,
  };
}

/** Collected principal and fees, valued when they actually left the LP. */
export async function collectedProceedsUsd(chainKey, p, opts = {}) {
  const chain = CHAINS[chainKey];
  const h = p.history;
  if (!chain?.usdRef || !h || h.unavailable) return null;
  const collections = Array.isArray(h.collections) ? h.collections : [];
  if (!collections.length) {
    return { proceeds: 0, exact: true, bridged: false, bound: null, legs: [] };
  }

  let proceeds = 0;
  let exact = true;
  let bridged = false;
  const legs = [];
  for (const flow of collections) {
    const pair = await historicalPairAt(chainKey, p, flow, opts);
    if (!pair) return null;
    const value = flow.amount0 * pair.usd0 + flow.amount1 * pair.usd1;
    if (!Number.isFinite(value) || value < 0) return null;
    proceeds += value;
    bridged ||= pair.bridged === true;
    if (pair.exact === false) exact = false;
    legs.push({
      block: flow.block, value, usd0: pair.usd0, usd1: pair.usd1,
      exact: pair.exact !== false, source: pair.source || null,
      bridged: pair.bridged === true,
    });
  }
  return {
    proceeds,
    exact,
    bridged,
    bound: exact ? null : 'one or more collections could only be bounded',
    legs,
  };
}

/**
 * LP strategy cash-flow return. Collections stop participating in LP return
 * at the block they leave the position; they are not assumed to remain held.
 */
export function strategyReturn(grossAdded, collected, currentValue) {
  if (!grossAdded || !collected || currentValue === null || currentValue === undefined) {
    return { pnl: null, pnlPct: null };
  }
  if (!grossAdded.exact || !collected.exact || !(grossAdded.basis > 0)) {
    return { pnl: null, pnlPct: null };
  }
  const pnl = currentValue + collected.proceeds - grossAdded.basis;
  return { pnl, pnlPct: pnl / grossAdded.basis * 100 };
}
