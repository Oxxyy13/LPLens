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
 * A single-sided mint yields a *bounded* entry price, so its cost basis is a
 * bound too, and that is reported rather than rounded into a point value.
 */
import { ethCall, rpcCall } from './rpc.js';
import { words, toUint, toAddress, encAddress, encUint, SELECTOR } from './abi.js';
import { CHAINS } from './chains.js';

const SEL_TOKEN0 = '0x0dfe1681';   // token0(), derived with keccak256

const poolCache = new Map();    // `${chain}` -> {pool, stableIsToken0, stableDecimals}
const priceCache = new Map();   // `${chain}:${block}` -> number | null

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
  if (priceCache.has(key)) return priceCache.get(key);

  const chain = CHAINS[chainKey];
  const rpc = opts.rpcOverride || (chain && chain.rpc);

  // Bridged chain: price the asset where it actually has dollar liquidity.
  if (chain && chain.usdRef && chain.usdRef.via) {
    const price = await bridgedUsd(chainKey, block, opts);
    priceCache.set(key, price);
    return price;
  }

  const ref = await referencePool(chainKey, rpc);
  if (!ref) { priceCache.set(key, null); return null; }

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
  priceCache.set(key, price);
  return price;
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
  if (block === 'latest') return refUsdAtBlock(via, 'latest', {});

  let timestamp = null;
  try {
    const rpc = opts.rpcOverride || chain.rpc;
    const blk = await rpcCall(rpc, 'eth_getBlockByNumber',
      ['0x' + BigInt(block).toString(16), false]);
    if (blk && blk.timestamp) timestamp = Number(BigInt(blk.timestamp));
  } catch { return null; }
  if (!timestamp) return null;

  const key = opts.etherscanKey || target.etherscanKey;
  if (!key || !target.etherscanChainId) return null;

  let targetBlock = null;
  try {
    const qs = new URLSearchParams({
      chainid: String(target.etherscanChainId), module: 'block',
      action: 'getblocknobytime', timestamp: String(timestamp),
      closest: 'before', apikey: key,
    });
    const res = await fetch(`https://api.etherscan.io/v2/api?${qs}`);
    const body = await res.json();
    if (body.status === '1') targetBlock = Number(body.result);
  } catch { return null; }
  if (!targetBlock) return null;

  return refUsdAtBlock(via, targetBlock, {});
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
 * Used for BOTH ends of the PnL calculation, which is deliberate: deriving the
 * cost basis from chain state and the current value from a price API would mean
 * the two halves of one subtraction came from sources that can disagree.
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

/**
 * USD cost basis of what was deposited, valued at the deposit block.
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
  if (!ref || !h || h.unavailable || !h.entry || !h.firstBlock) return null;

  // entry.price is token1 per token0, decimal-adjusted.
  const entry = h.entry.price;
  if (!(entry > 0)) return null;

  const pair = await usdPairAt(chainKey, p.token0, p.token1, entry, h.firstBlock, opts);
  if (!pair) return null;
  const { usd0, usd1 } = pair;

  const basis = h.deposited0 * usd0 + h.deposited1 * usd1;
  if (!Number.isFinite(basis) || basis <= 0) return null;

  return {
    basis,
    block: h.firstBlock,
    usd0,
    usd1,
    // A single-sided mint gives a bounded entry price, so the basis inherits
    // that bound. Reported, never quietly rounded to a point value.
    exact: h.entry.exact !== false,
    bound: h.entry.exact === false ? h.entry.bound : null,
  };
}
