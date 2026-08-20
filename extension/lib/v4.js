/**
 * Uniswap v4 position reading.
 *
 * v4 differs from v3 in four ways that matter to a reader, and every one of
 * them was verified live on Robinhood Chain (2026-08-18) rather than assumed:
 *
 *  1. NO POOL CONTRACTS. All pools live in one singleton PoolManager and are
 *     addressed by `poolId = keccak256(abi.encode(PoolKey))`. v3 could ask
 *     `factory.getPool()`; v4 expects the caller to hash. Hence lib/keccak.js.
 *  2. THE POSITION MANAGER IS NOT ERC721Enumerable. `supportsInterface`
 *     returns false, so `tokenOfOwnerByIndex` — the whole basis of the v3 scan
 *     — does not exist. Positions are enumerated from `Transfer` logs instead,
 *     which works because ERC-721 indexes `tokenId` as topic3.
 *  3. STATE IS READ THROUGH StateView, a separate view contract, not from the
 *     pool.
 *  4. CURRENCIES MAY BE NATIVE. `address(0)` means the chain's native coin,
 *     which has no ERC-20 to ask for `symbol()` or `decimals()`.
 *
 * Two independent cross-checks guard the derivation, both confirmed on-chain:
 * the top 200 bits of the derived poolId must equal the truncated id that v4
 * stores separately in PositionInfo, and StateView's liquidity for the position
 * must equal the PositionManager's. Either mismatching means the poolId, the
 * ticks or the salt is wrong, and both would otherwise fail silently as zeros.
 *
 * NOT IMPLEMENTED: v4 lifetime history. Deposits and fee collection are emitted
 * by the PoolManager as `ModifyLiquidity`, keyed by poolId and salt rather than
 * by tokenId, so the v3 approach of one topic-filtered query per position does
 * not carry over. Positions report history as unavailable rather than showing a
 * partial or invented lifetime.
 */
import { ethCall, ethCallBatch, mapLimit } from './rpc.js';
import {
  words, toUint, toInt, toAddress, padWord, encAddress, encUint, dataOwnerOf,
} from './abi.js';
import { keccak256Hex } from './keccak.js';
import { positionAmounts, humanPrice, tickToPrice, scale } from './v3.js';
import { CHAINS } from './chains.js';
import { fetchTransfers } from './logs.js';

// Selectors derived with keccak256 and cross-checked against the in-production
// `PortfolioManager/scripts/robinhood_chain_lp.py`, which pins the same values.
export const V4 = {
  poolAndPositionInfo: '0x7ba03aad',  // getPoolAndPositionInfo(uint256)
  positionLiquidity: '0x1efeed33',    // getPositionLiquidity(uint256)
  getSlot0: '0xc815641c',             // getSlot0(bytes32)
  getPositionInfo: '0xdacf1d2f',      // getPositionInfo(bytes32,address,int24,int24,bytes32)
  getFeeGrowthInside: '0x53e9c1fb',   // getFeeGrowthInside(bytes32,int24,int24)
  balanceOf: '0x70a08231',
};

const Q128 = 1n << 128n;
const MAX256 = 1n << 256n;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function retryRead(fn, attempts = 4) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await fn(); }
    catch (err) {
      last = err;
      if (attempt + 1 < attempts) {
        const throttled = /429|rate|capacity/i.test(err.message || String(err));
        await wait((throttled ? 2000 : 200) * (attempt + 1));
      }
    }
  }
  throw last;
}

/** ABI int24: sign-extended across the full 256-bit word, not masked to 24 bits. */
const encInt = (v) => padWord(BigInt(v) < 0n ? MAX256 + BigInt(v) : BigInt(v));

/** int24 packed inside a larger value. */
const s24 = (v) => (v >= 0x800000n ? v - 0x1000000n : v);

/**
 * Decode `getPoolAndPositionInfo`.
 *
 * PositionInfo packs, from the most significant bit:
 *   200 bits poolId | 24 bits tickUpper | 24 bits tickLower | 8 bits subscriber
 */
export function decodeV4Position(hex) {
  const w = words(hex);
  if (w.length < 6) return null;

  const info = toUint(w[5]);
  return {
    currency0: toAddress(w[0]),
    currency1: toAddress(w[1]),
    fee: Number(toUint(w[2])),
    tickSpacing: Number(toInt(w[3])),
    hooks: toAddress(w[4]),
    tickLower: Number(s24((info >> 8n) & 0xffffffn)),
    tickUpper: Number(s24((info >> 32n) & 0xffffffn)),
    // The poolId truncated to its top 200 bits — kept purely to verify the
    // hash we derive below.
    truncatedPoolId: info >> 56n,
    poolKeyWords: w.slice(0, 5),
  };
}

/** poolId = keccak256(abi.encode(PoolKey)); the 5 words are already ABI-encoded. */
export function poolIdOf(poolKeyWords) {
  return keccak256Hex('0x' + poolKeyWords.join(''));
}

/** Native currency is address(0) and has no ERC-20 to interrogate. */
const isNative = (addr) => /^0x0{40}$/i.test(addr);

async function currencyMeta(rpc, chain, address, tokenMeta) {
  if (isNative(address)) {
    return { symbol: chain.nativeSymbol || 'ETH', decimals: 18, native: true };
  }
  return tokenMeta(address);
}

/**
 * Uncollected fees, from the difference between the pool's current fee growth
 * inside the range and the snapshot stored against the position.
 *
 * The subtraction is deliberately mod 2^256: fee growth accumulators are
 * allowed to overflow and wrap, and Uniswap's own maths relies on the wrapped
 * difference being correct.
 */
async function v4Fees(rpc, chain, poolId, tickLower, tickUpper, tokenId) {
  const sv = chain.v4StateView;
  const args = poolId.slice(2) + encInt(tickLower) + encInt(tickUpper);
  const [infoHex, insideHex] = await Promise.all([
    ethCall(rpc, sv, V4.getPositionInfo + poolId.slice(2)
      + encAddress(chain.v4PositionManager) + encInt(tickLower) + encInt(tickUpper)
      + encUint(tokenId)).catch(() => null),
    ethCall(rpc, sv, V4.getFeeGrowthInside + args).catch(() => null),
  ]);
  if (!infoHex || !insideHex) return null;

  const a = words(infoHex), b = words(insideHex);
  if (a.length < 3 || b.length < 2) return null;

  const liquidity = toUint(a[0]);
  const diff = (now, last) => (now - last + MAX256) % MAX256;
  return {
    liquidity,
    fees0: (liquidity * diff(toUint(b[0]), toUint(a[1]))) / Q128,
    fees1: (liquidity * diff(toUint(b[1]), toUint(a[2]))) / Q128,
  };
}

/**
 * Enumerate the v4 positions an address currently holds.
 *
 * Replays Transfer logs in order rather than counting them, because a token can
 * be received, sent away and received again. The result is checked against
 * `balanceOf`: a mismatch means the log source returned a partial set, and a
 * silently short list would read as "you have fewer positions" rather than as
 * an error.
 */
export async function enumerateV4(chainKey, owner, opts = {}) {
  const chain = CHAINS[chainKey];
  if (!chain || !chain.v4PositionManager) return { unavailable: 'no v4 deployment configured' };
  const rpc = opts.rpcOverride || chain.rpc;

  let onChainCount;
  try {
    const hex = await retryRead(() =>
      ethCall(rpc, chain.v4PositionManager, V4.balanceOf + encAddress(owner)));
    onChainCount = Number(toUint(words(hex)[0]));
  } catch (err) {
    return { unavailable: `v4 balance could not be verified — ${err.message || String(err)}` };
  }
  if (onChainCount === 0) {
    return { tokenIds: [], balanceOf: 0, reconciles: true, source: 'balanceOf' };
  }

  // A configured Alchemy RPC also exposes its NFT ownership index. It avoids
  // the full-history getLogs limits that break large v4 wallets. The index is
  // never trusted alone: ownerOf verifies every candidate and the final count
  // must equal balanceOf from the same RPC.
  let alchemyError = null;
  try {
    const indexed = await alchemyOwnedTokenIds(rpc, chain.v4PositionManager, owner);
    if (indexed) {
      const verified = await verifyOwnedIds(
        rpc, chain.v4PositionManager, owner, indexed.tokenIds);
      if (verified.unreadable === 0
          && verified.tokenIds.length === onChainCount
          && indexed.tokenIds.length === onChainCount) {
        return {
          tokenIds: verified.tokenIds,
          balanceOf: onChainCount,
          reconciles: true,
          source: 'alchemy-nft+ownerOf',
        };
      }
      alchemyError = `Alchemy NFT index gave ${indexed.tokenIds.length}, `
        + `ownerOf verified ${verified.tokenIds.length}, balanceOf reports ${onChainCount}`;
    }
  } catch (err) {
    // Never include the URL here: it contains the user's API key.
    alchemyError = `Alchemy NFT ownership lookup failed — ${err.message || String(err)}`;
  }

  const got = await fetchTransfers({
    contract: chain.v4PositionManager,
    owner,
    rpc: opts.rpcOverride || chain.logsRpc || chain.rpc,
    etherscanKey: opts.etherscanKey || chain.etherscanKey,
    etherscanChainId: chain.etherscanChainId,
    blockscout: chain.blockscout || null,
  });
  if (got.unavailable) {
    return {
      balanceOf: onChainCount,
      unavailable: [alchemyError, got.unavailable].filter(Boolean).join('; '),
    };
  }

  const held = new Set();
  for (const ev of got.events) {
    if (ev.direction === 'in') held.add(ev.tokenId);
    else held.delete(ev.tokenId);
  }

  return {
    tokenIds: [...held].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    balanceOf: onChainCount,
    reconciles: onChainCount === held.size,
    source: 'transfer-logs',
    indexWarning: alchemyError,
  };
}

/** Return null when the RPC URL is not an Alchemy v2 endpoint. */
export async function alchemyOwnedTokenIds(rpc, contract, owner) {
  let parsed;
  try { parsed = new URL(rpc); } catch { return null; }
  if (!parsed.hostname.toLowerCase().endsWith('.g.alchemy.com')) return null;
  const match = parsed.pathname.match(/^\/v2\/([^/]+)\/?$/);
  if (!match) return null;

  const endpoint = new URL(`/nft/v3/${encodeURIComponent(match[1])}/getNFTsForOwner`, parsed.origin);
  endpoint.searchParams.set('owner', owner);
  endpoint.searchParams.append('contractAddresses[]', contract);
  endpoint.searchParams.set('withMetadata', 'false');
  endpoint.searchParams.set('pageSize', '100');

  const ids = new Set();
  let pageKey = null;
  for (let page = 0; page < 50; page++) {
    if (pageKey) endpoint.searchParams.set('pageKey', pageKey);
    const res = await retryRead(async () => {
      const response = await fetch(endpoint);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    });
    const body = await res.json();
    if (!Array.isArray(body.ownedNfts)) throw new Error('malformed response');
    for (const nft of body.ownedNfts) {
      const addr = nft && nft.contract && nft.contract.address;
      if (addr && String(addr).toLowerCase() !== contract.toLowerCase()) continue;
      if (nft && nft.tokenId !== undefined) ids.add(BigInt(nft.tokenId));
    }
    pageKey = body.pageKey || null;
    if (!pageKey) {
      return {
        tokenIds: [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      };
    }
  }
  throw new Error('pagination exceeded 50 pages');
}

export async function verifyOwnedIds(rpc, contract, owner, tokenIds) {
  const want = String(owner).toLowerCase();
  const rows = [];
  for (let offset = 0; offset < tokenIds.length; offset += 25) {
    const chunk = tokenIds.slice(offset, offset + 25);
    let pending = chunk.map((tokenId, index) => ({ tokenId, index }));
    const resolved = new Array(chunk.length);
    for (let attempt = 0; attempt < 4 && pending.length; attempt++) {
      let hexes;
      try {
        hexes = await ethCallBatch(rpc, pending.map(({ tokenId }) => ({
          to: contract, data: dataOwnerOf(tokenId),
        })));
      } catch {
        if (attempt < 3) await wait(2000 * (attempt + 1));
        continue;
      }
      const retry = [];
      for (let i = 0; i < pending.length; i++) {
        const item = pending[i], hex = hexes[i];
        if (!hex || hex.__error) retry.push(item);
        else resolved[item.index] = toAddress(words(hex)[0]).toLowerCase() === want
          ? item.tokenId : null;
      }
      pending = retry;
      if (pending.length && attempt < 3) await wait(2000 * (attempt + 1));
    }
    for (const item of pending) resolved[item.index] = { __error: 'ownerOf unreadable' };
    rows.push(...resolved);
    if (offset + chunk.length < tokenIds.length) await wait(250);
  }
  return {
    tokenIds: rows.filter((id) => typeof id === 'bigint'),
    unreadable: rows.filter((id) => id && id.__error).length,
  };
}

/** Read one v4 position. Shaped like a v3 position so the UI needs no branch. */
export async function loadV4Position(chainKey, tokenId, opts = {}) {
  const chain = CHAINS[chainKey];
  if (!chain || !chain.v4PositionManager) throw new Error(`no v4 deployment for ${chainKey}`);
  const rpc = opts.rpcOverride || chain.rpc;
  const pm = chain.v4PositionManager;

  const [infoHex, liqHex] = await Promise.all([
    ethCall(rpc, pm, V4.poolAndPositionInfo + encUint(tokenId)),
    ethCall(rpc, pm, V4.positionLiquidity + encUint(tokenId)),
  ]);

  const pos = decodeV4Position(infoHex);
  if (!pos) throw new Error(`v4 position ${tokenId} not readable on ${chainKey}`);
  const liquidity = toUint(words(liqHex)[0] || '0');

  const poolId = poolIdOf(pos.poolKeyWords);
  // Cross-check 1: the derived hash must agree with the id v4 stored itself.
  if (BigInt(poolId) >> 56n !== pos.truncatedPoolId) {
    throw new Error(`v4 poolId mismatch for ${tokenId} — derivation is wrong, refusing to read`);
  }

  const tokenMeta = opts.tokenMeta || (async () => ({ symbol: '?', decimals: 18 }));
  const [slotHex, m0, m1, fees] = await Promise.all([
    ethCall(rpc, chain.v4StateView, V4.getSlot0 + poolId.slice(2)),
    currencyMeta(rpc, chain, pos.currency0, tokenMeta),
    currencyMeta(rpc, chain, pos.currency1, tokenMeta),
    v4Fees(rpc, chain, poolId, pos.tickLower, pos.tickUpper, tokenId),
  ]);

  const sw = words(slotHex);
  const sqrtPriceX96 = toUint(sw[0]);
  const currentTick = Number(s24(toUint(sw[1]) & 0xffffffn));

  // Cross-check 2: StateView and the PositionManager must agree on liquidity.
  if (fees && fees.liquidity !== liquidity) {
    throw new Error(`v4 liquidity mismatch for ${tokenId} (StateView ${fees.liquidity} vs manager ${liquidity})`);
  }

  const amounts = positionAmounts({
    liquidity, tickLower: pos.tickLower, tickUpper: pos.tickUpper, sqrtPriceX96,
  });

  return {
    version: 'v4',
    tokenId,
    poolId,
    hooks: pos.hooks,
    token0: pos.currency0,
    token1: pos.currency1,
    fee: pos.fee,
    tickSpacing: pos.tickSpacing,
    tickLower: pos.tickLower,
    tickUpper: pos.tickUpper,
    liquidity,
    token0Meta: m0,
    token1Meta: m1,
    currentTick,
    price: humanPrice(sqrtPriceX96, m0.decimals, m1.decimals),
    priceLower: tickToPrice(pos.tickLower, m0.decimals, m1.decimals),
    priceUpper: tickToPrice(pos.tickUpper, m0.decimals, m1.decimals),
    amount0: scale(amounts.amount0, m0.decimals),
    amount1: scale(amounts.amount1, m1.decimals),
    status: amounts.status,
    collectable0: fees ? scale(Number(fees.fees0), m0.decimals) : null,
    collectable1: fees ? scale(Number(fees.fees1), m1.decimals) : null,
    // v4 lifetime events are emitted by the PoolManager keyed by poolId+salt,
    // not by tokenId, so the v3 one-query-per-position approach does not apply.
    history: {
      unavailable: 'v4 lifetime history is not implemented — v4 emits ModifyLiquidity '
        + 'from the PoolManager keyed by poolId and salt, not per tokenId',
    },
  };
}
