/**
 * Historical USD pricing, read from chain rather than fetched from a price API.
 *
 * This retires the project's oldest documented limitation. USD PnL was refused
 * because it needs a dollar mark at the moment each deposit happened, and no
 * keyless source provides one — pricing an old basket at today's rate is the
 * `token_delta × price_now` error. That was true of price *APIs*. It is not
 * true of the chain: a USDC/WETH pool's `slot0` read at a historical block is
 * the dollar price of ETH at that block, exactly, and archive `eth_call` serves
 * it. Verified on Alchemy's free tier down to block 12,500,000 (May 2021).
 *
 * No CoinGecko, no additional DexScreener call, no new key. The reference pool
 * itself is derived from the v3 factory rather than hardcoded, and all four
 * chains independently produce the same WETH price to within 0.4 basis points —
 * which is the cross-check that the derivation is right.
 *
 * BRIDGED CHAINS. Some chains have no stablecoin liquidity at all — Robinhood
 * Chain's WETH trades against thirty memecoins and nothing dollar-denominated,
 * so there is no local pool to read a dollar price from. Its WETH is a bridged
 * asset, though, so the price exists on-chain on ETHEREUM. Those chains are
 * priced by mapping the local block to its timestamp, that timestamp to an
 * Ethereum block, and reading the Ethereum reference pool there.
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
  words, toUint, toAddress, encAddress, encUint, SELECTOR, decodeSlot0,
} from './abi.js';
import { CHAINS } from './chains.js';
import { humanPrice } from './v3.js';

const SEL_TOKEN0 = '0x0dfe1681';   // token0(), derived with keccak256

const poolCache = new Map();    // `${chain}` -> {pool, stableIsToken0, stableDecimals}
const priceCache = new Map();   // `${chain}:${block}` -> number | null
const positionPriceCache = new Map(); // `${chain}:${pool}:${block}` -> pool price
const timeBlockCache = new Map(); // `${chain}:${timestamp}` -> reference-chain block
const blockHeaderCache = new Map(); // `${chain}:${block}` -> {number,timestamp}
const LATEST_PRICE_TTL_MS = 60_000;
const ETHERSCAN_LOOKUP_GAP_MS = 350;
let etherscanLookupQueue = Promise.resolve();
let onChainLookupQueue = Promise.resolve();
let lastEtherscanLookupAt = 0;

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
async function referencePool(chainKey, rpc) {
  if (poolCache.has(chainKey)) return poolCache.get(chainKey);
  const chain = CHAINS[chainKey];
  const ref = chain && chain.usdRef;
  if (!ref) { poolCache.set(chainKey, null); return null; }

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
  poolCache.set(chainKey, resolved);
  return resolved;
}

/**
 * USD price of the reference token (WETH) at a given block.
 *
 * Historical prices are immutable, so the cache never needs invalidating —
 * unlike anything keyed on current state.
 */
export async function refUsdAtBlock(chainKey, block, opts = {}) {
  const key = `${chainKey}:${block}`;
  if (priceCache.has(key)) {
    const hit = priceCache.get(key);
    if (block !== 'latest') return hit;
    if (hit && Date.now() - hit.at < LATEST_PRICE_TTL_MS) return hit.price;
    priceCache.delete(key);
  }
  const remember = (price) => {
    // Null usually means a provider refusal or rate limit, not a chain fact.
    // Keeping it would make a transient failure stick for the service worker's
    // whole lifetime, so only successful immutable prices are memoised.
    if (price !== null && price !== undefined) {
      priceCache.set(key, block === 'latest' ? { price, at: Date.now() } : price);
    } else {
      priceCache.delete(key);
    }
    return price;
  };

  const chain = CHAINS[chainKey];
  const rpc = opts.rpcOverride || (chain && chain.rpc);

  // Bridged chain: price the asset where it actually has dollar liquidity.
  if (chain && chain.usdRef && chain.usdRef.via) {
    const price = await bridgedUsd(chainKey, block, opts);
    return remember(price);
  }

  const ref = await referencePool(chainKey, rpc);
  if (!ref) return remember(null);

  let price = null;
  try {
    const hex = await ethCall(rpc, ref.pool, SELECTOR.slot0, undefined,
      block === 'latest' ? 'latest' : '0x' + BigInt(block).toString(16));
    const sqrtP = Number(toUint(words(hex)[0])) / 2 ** 96;
    const raw = sqrtP * sqrtP;                       // raw token1 per token0
    const scale = 10 ** (18 - ref.stableDecimals);   // WETH is 18dp
    // Orientation depends on which side the stablecoin sorted to.
    price = ref.stableIsToken0 ? scale / raw : raw * scale;
    if (!Number.isFinite(price) || price <= 0) price = null;
  } catch {
    price = null;   // no archive access, or the pool did not exist yet
  }
  return remember(price);
}

/**
 * Price a bridged asset using the chain it was bridged from.
 *
 * Local block -> its timestamp (an RPC call, a chain fact) -> the reference
 * chain's block at that time (Etherscan's block lookup, also a chain fact, not
 * a price) -> the reference pool read there. No price API is involved at any
 * step; the dollar figure still comes out of a Uniswap pool.
 */
async function bridgedUsd(chainKey, block, opts = {}) {
  const chain = CHAINS[chainKey];
  const via = chain.usdRef.via;
  const target = CHAINS[via];
  if (!target) return null;

  // 'latest' needs no time alignment.
  const viaOpts = {
    ...opts,
    rpcOverride: opts.rpcOverrides?.[via] || undefined,
  };
  if (block === 'latest') return refUsdAtBlock(via, 'latest', viaOpts);

  let timestamp = null;
  try {
    const rpc = opts.rpcOverride || chain.rpc;
    const blk = await rpcCall(rpc, 'eth_getBlockByNumber',
      ['0x' + BigInt(block).toString(16), false]);
    if (blk && blk.timestamp) timestamp = Number(BigInt(blk.timestamp));
  } catch { return null; }
  if (!timestamp) return null;

  const key = opts.etherscanKey || target.etherscanKey;
  let targetBlock = key && target.etherscanChainId
    ? await referenceBlockAtTime(target, timestamp, key) : null;
  if (!targetBlock) {
    targetBlock = await referenceBlockOnChain(via, target, timestamp, viaOpts);
  }
  if (!targetBlock) return null;

  return refUsdAtBlock(via, targetBlock, viaOpts);
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
  if (!ref || !(poolPrice > 0)) return null;

  const t0 = String(token0).toLowerCase();
  const t1 = String(token1).toLowerCase();
  const weth = (ref.weth || '').toLowerCase();
  // Bridged chains have no local stablecoin at all; absent, not empty.
  const stable = (ref.stable || '').toLowerCase();

  if (stable && t1 === stable) return { usd0: poolPrice, usd1: 1 };
  if (stable && t0 === stable) return { usd0: 1, usd1: 1 / poolPrice };
  if (weth && (t1 === weth || t0 === weth)) {
    const wethUsd = await refUsdAtBlock(chainKey, block, opts);
    if (!wethUsd) return null;
    return t1 === weth
      ? { usd0: poolPrice * wethUsd, usd1: wethUsd }
      : { usd0: wethUsd, usd1: wethUsd / poolPrice };
  }
  return null;
}

/** Exact position-pool price at a historical block, when the RPC is archival. */
async function positionPoolPrice(chainKey, p, block, opts = {}) {
  if (!p.pool || block === null || block === undefined) return null;
  const key = `${chainKey}:${String(p.pool).toLowerCase()}:${block}`;
  if (positionPriceCache.has(key)) return positionPriceCache.get(key);
  const chain = CHAINS[chainKey];
  const rpc = opts.rpcOverride || (chain && chain.rpc);
  if (!rpc) return null;
  try {
    const hex = await ethCall(rpc, p.pool, SELECTOR.slot0, undefined,
      '0x' + BigInt(block).toString(16));
    const slot = decodeSlot0(hex);
    const price = humanPrice(
      slot.sqrtPriceX96, p.token0Meta.decimals, p.token1Meta.decimals);
    if (!(price > 0) || !Number.isFinite(price)) return null;
    positionPriceCache.set(key, price);
    return price;
  } catch {
    // Do not cache failure: a later configured archive endpoint may succeed.
    return null;
  }
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
  const tokens = [String(p.token0).toLowerCase(), String(p.token1).toLowerCase()];
  const amounts = [flow.amount0, flow.amount1];
  const weth = String(ref.weth || '').toLowerCase();
  const stable = String(ref.stable || '').toLowerCase();
  let wethUsd;
  const out = [];
  for (let i = 0; i < 2; i++) {
    if (stable && tokens[i] === stable) out[i] = 1;
    else if (weth && tokens[i] === weth) {
      if (wethUsd === undefined) wethUsd = await refUsdAtBlock(chainKey, flow.block, opts);
      if (!(wethUsd > 0)) return null;
      out[i] = wethUsd;
    } else if (amounts[i] === 0) out[i] = 0;
    else return null;
  }
  return { usd0: out[0], usd1: out[1], exact: true, source: 'direct-reference' };
}

/**
 * Historical USD pair for one Increase/Collect cash flow.
 *
 * Exact event math is cheapest and needs no archive node. Direct reference
 * tokens come next. A historical slot0 read resolves otherwise-underdetermined
 * single-sided adds and fee-only collects when an archive RPC is configured.
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

  const poolPrice = await positionPoolPrice(chainKey, p, flow.block, opts);
  if (poolPrice) {
    const pair = await usdPairAt(
      chainKey, p.token0, p.token1, poolPrice, flow.block, opts);
    if (pair) return { ...pair, exact: true, source: 'archive-slot0' };
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
  if (!ref || !h || h.unavailable) return null;
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
  const legs = [];
  for (const deposit of deposits) {
    const pair = await priceAt(deposit);
    if (!pair) return null;
    const value = deposit.amount0 * pair.usd0 + deposit.amount1 * pair.usd1;
    if (!Number.isFinite(value) || value < 0) return null;
    basis += value;
    if (pair.exact === false || (pair.exact === undefined
        && (!deposit.entry || deposit.entry.exact === false))) exact = false;
    legs.push({
      block: deposit.block, value, usd0: pair.usd0, usd1: pair.usd1,
      exact: pair.exact !== false, source: pair.source || null,
    });
  }
  if (!(basis > 0)) return null;
  return {
    basis,
    block: deposits[0].block,
    exact,
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
  if (!collections.length) return { proceeds: 0, exact: true, bound: null, legs: [] };

  let proceeds = 0;
  let exact = true;
  const legs = [];
  for (const flow of collections) {
    const pair = await historicalPairAt(chainKey, p, flow, opts);
    if (!pair) return null;
    const value = flow.amount0 * pair.usd0 + flow.amount1 * pair.usd1;
    if (!Number.isFinite(value) || value < 0) return null;
    proceeds += value;
    if (pair.exact === false) exact = false;
    legs.push({
      block: flow.block, value, usd0: pair.usd0, usd1: pair.usd1,
      exact: pair.exact !== false, source: pair.source || null,
    });
  }
  return {
    proceeds,
    exact,
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
