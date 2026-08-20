import { CHAINS, MAX_POSITIONS } from './chains.js';
import {
  dataBalanceOf, dataTokenOfOwnerByIndex, dataPositions, dataSlot0,
  dataGetPool, dataCollect, dataOwnerOf, decodePositions, decodeSlot0, decodeCollect,
  decodeSymbol, SELECTOR, toUint, toAddress, words, encUint,
} from './abi.js';
import { ethCall, mapLimit } from './rpc.js';
import { fetchHistory, solveSqrtPrice, accounting, reconciles } from './history.js';
import { fingerprint, readHistory, writeHistory, readEnum, writeEnum } from './cache.js';
import { enumerateV4, loadV4Position, V4 } from './v4.js';
import { costBasisUsd, usdPairAt } from './histprice.js';
import { positionAmounts, humanPrice, scale, tickToPrice } from './v3.js';

const tokenCache = new Map(); // `${chain}:${addr}` -> {symbol, decimals}

async function tokenMeta(rpc, chainKey, addr) {
  const key = `${chainKey}:${addr.toLowerCase()}`;
  if (tokenCache.has(key)) return tokenCache.get(key);
  const [symRaw, decRaw] = await Promise.all([
    ethCall(rpc, addr, SELECTOR.symbol).catch(() => null),
    ethCall(rpc, addr, SELECTOR.decimals).catch(() => null),
  ]);
  const meta = {
    symbol: symRaw ? decodeSymbol(symRaw) : '?',
    decimals: decRaw ? Number(toUint(words(decRaw)[0] || '0')) : 18,
  };
  tokenCache.set(key, meta);
  return meta;
}

/**
 * How many chains `loadAllChains` runs at once.
 *
 * Per-chain work already uses mapLimit of 3–4, so five chains in parallel
 * would be ~20 concurrent RPC calls. Two chains keeps the peak around 8,
 * comparable to a single-chain scan, and is less likely to trip Base
 * Blockscout's ~10-request window — the all-chains path is what makes that
 * 429 likely. Single-chain loads are unchanged.
 */
export const ALL_CHAIN_CONCURRENCY = 2;

const CHUNK = 10;
const STOP_AFTER_CLOSED = 20;

function tagPosition(p, chainKey) {
  return { ...p, chainKey, version: p.version || 'v3' };
}

/**
 * Enumerate and mark every v3 position held by `owner` on one chain.
 * Read-only: eth_call and eth_getBalance style requests only. Nothing is signed.
 */
export async function loadPositions(chainKey, owner, opts = {}) {
  const chain = CHAINS[chainKey];
  if (!chain) throw new Error(`unknown chain ${chainKey}`);
  const rpc = opts.rpcOverride || chain.rpc;
  const includeClosed = !!opts.includeClosed;

  const balHex = await ethCall(rpc, chain.nfpm, dataBalanceOf(owner));
  const count = Number(toUint(words(balHex)[0] || '0'));

  if (count === 0) {
    return {
      chain: chainKey, count: 0, scanned: 0, truncated: false, stoppedEarly: false,
      positions: [], v4: { positions: [], held: 0, shown: 0, unavailable: null },
      enumSource: 'empty',
    };
  }

  // NFPM is ERC721Enumerable, so this avoids eth_getLogs range limits entirely.
  //
  // Scan DOWN from the newest index. `tokenOfOwnerByIndex` returns tokens in
  // acquisition order, so index 0 is the oldest position ever held and
  // `count - 1` the newest. Closed positions accumulate at the bottom of that
  // list while open ones cluster at the top, so scanning up from 0 spends the
  // entire cap on dead positions: verified 2026-08-18 against a Robinhood
  // Chain wallet holding 67 positions whose single open position sat at index
  // 66, which rendered as an empty list.
  //
  // Do NOT skip tokenIds whose previous positions() read looked closed. A
  // position with zero liquidity and zero owed is not permanently dead —
  // increaseLiquidity can be called on any tokenId whose NFT has not been
  // burned, so a "closed" position can come back to life and would then be
  // invisible until the cache happened to be rebuilt.
  let live;
  let scanned;
  let stoppedEarly;
  let enumSource;
  const truncated = count > MAX_POSITIONS;

  if (truncated) {
    // A capped walk is a partial list. Never cache it as complete. Keep the
    // interleaved tokenOfOwnerByIndex + positions() scan so early-stop can
    // still skip the tail of a 60-deep cap.
    enumSource = 'rpc';
    ({ live, scanned, stoppedEarly } = await scanInterleaved(
      rpc, chain, owner, count, includeClosed));
  } else {
    const resolved = await resolveCompleteIds(chainKey, owner, rpc, chain, count);
    enumSource = resolved.fromCache ? 'cache' : 'rpc';
    ({ live, scanned, stoppedEarly } = await walkPositions(
      rpc, chain.nfpm, resolved.tokenIds, includeClosed));
  }

  const enriched = await mapLimit(live, 3, (p) => enrichPosition(rpc, chain, chainKey, owner, p));

  const rendered = enriched.filter((p) => p && !p.__error);

  // Lifetime history is fetched only for positions that will actually render,
  // so its cost scales with what you see rather than with what was scanned —
  // one eth_getLogs per visible card. An endpoint that refuses wide ranges
  // degrades to `history.unavailable`; it never fails the whole load.
  // Wide eth_getLogs needs a better endpoint than present-state reads do, so
  // history gets its own source descriptor. Etherscan wins when a key exists;
  // a refusal (including the HTTP-200 Base paywall) falls through to
  // Blockscout when the chain has one, then to whichever RPC is in play.
  const source = historySource(chain, rpc, opts);
  const withHistory = await mapLimit(rendered, 3, (p) => attachHistory(source, chain, p));

  const v3Positions = withHistory.filter((p) => p && !p.__error);
  const v4 = await scanV4(chainKey, owner, opts);

  let positions = [
    ...v3Positions.map((p) => tagPosition(p, chainKey)),
    ...v4.positions.map((p) => tagPosition(p, chainKey)),
  ];
  // Popup aggregate totals need the same USD object the overlay already
  // attaches. Off by default so a caller that only wants enumeration is
  // not charged extra archive reads.
  if (opts.withUsd) {
    const priced = await mapLimit(positions, 2, async (p) => {
      try { return await attachUsd(chainKey, p, opts); }
      catch { return p; }
    });
    positions = priced.filter((p) => p && !p.__error);
  }

  return {
    chain: chainKey,
    count,
    scanned,
    truncated: truncated || count > scanned,
    stoppedEarly,
    enumSource,
    positions,
    v4,
  };
}

/**
 * Wallet × chain sweep. Jobs share ALL_CHAIN_CONCURRENCY so ten wallets
 * do not multiply the per-chain mapLimit. One address or one chain
 * throwing becomes `{ ok: false }` for that job and does not take down
 * the rest. onProgress fires as each job starts and finishes.
 */
export async function loadSweep(owners, chainKeys, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const jobs = [];
  const seen = new Set();
  for (const owner of owners || []) {
    const address = String(typeof owner === 'string' ? owner : owner.address || '')
      .trim().toLowerCase();
    if (!address || seen.has(address)) continue;
    seen.add(address);
    const label = typeof owner === 'string' ? '' : String(owner.label || '');
    for (const chainKey of chainKeys || []) jobs.push({ address, label, chainKey });
  }
  return mapLimit(jobs, ALL_CHAIN_CONCURRENCY, async (job) => {
    const meta = { owner: job.address, label: job.label, chainKey: job.chainKey };
    try { await onProgress({ ...meta, phase: 'start' }); } catch { /* UI must not fail the scan */ }
    try {
      const rpcOverride = (opts.rpcOverrides && opts.rpcOverrides[job.chainKey]) || null;
      const result = await loadPositions(job.chainKey, job.address, { ...opts, rpcOverride });
      result.positions = (result.positions || []).map((p) => ({
        ...p,
        ownerAddress: job.address,
        ownerLabel: job.label,
      }));
      const payload = { ...meta, ok: true, result };
      try { await onProgress(payload); } catch { /* */ }
      return payload;
    } catch (err) {
      const payload = { ...meta, ok: false, error: err.message || String(err) };
      try { await onProgress(payload); } catch { /* */ }
      return payload;
    }
  });
}

/**
 * All-chains sweep for one owner. Isolation and progress match loadSweep.
 */
export async function loadAllChains(owner, opts = {}) {
  return loadSweep([owner], Object.keys(CHAINS), opts);
}

/**
 * Complete (owner, chain) tokenId list, newest first.
 *
 * Validation is 2 calls: balanceOf is already known; newest =
 * tokenOfOwnerByIndex(owner, count-1). balanceOf alone is not enough — a
 * burn plus a mint between views leaves the count identical, and
 * ERC721Enumerable appends the new token last, so the newest index is
 * exactly what catches that case.
 *
 * On a hit, tokenOfOwnerByIndex is not walked. positions() still is.
 */
async function resolveCompleteIds(chainKey, owner, rpc, chain, count) {
  let newest = null;
  try {
    newest = await readTokenAtIndex(rpc, chain.nfpm, owner, count - 1);
  } catch {
    newest = null;
  }

  const hit = await readEnum(chainKey, owner);
  if (
    hit
    && newest !== null
    && hit.count === count
    && hit.newest === String(newest)
    && hit.tokenIds.length === count
  ) {
    return {
      tokenIds: hit.tokenIds.map((id) => BigInt(id)),
      fromCache: true,
    };
  }

  const tokenIds = new Array(count);
  if (newest !== null) tokenIds[0] = newest; // newest first
  const missing = [];
  for (let i = 0; i < count; i++) {
    const index = count - 1 - i;
    if (i === 0 && newest !== null) continue;
    missing.push({ i, index });
  }
  const hexes = await mapLimit(missing, 4, (m) =>
    ethCall(rpc, chain.nfpm, dataTokenOfOwnerByIndex(owner, m.index))
  );
  let failed = false;
  for (let k = 0; k < missing.length; k++) {
    const h = hexes[k];
    if (typeof h !== 'string') { failed = true; continue; }
    tokenIds[missing[k].i] = toUint(words(h)[0]);
  }
  if (tokenIds.some((id) => id === undefined || id === null)) failed = true;

  if (!failed && newest !== null) {
    await writeEnum(chainKey, owner, {
      count,
      newest: String(newest),
      tokenIds: tokenIds.map(String),
    });
  }
  return { tokenIds: tokenIds.filter((id) => id !== undefined && id !== null), fromCache: false };
}

async function readTokenAtIndex(rpc, nfpm, owner, index) {
  const hex = await ethCall(rpc, nfpm, dataTokenOfOwnerByIndex(owner, index));
  return toUint(words(hex)[0]);
}

/** positions() walk over a known id list, newest first, with early-stop. */
async function walkPositions(rpc, nfpm, tokenIds, includeClosed) {
  const live = [];
  let scanned = 0;
  let consecutiveClosed = 0;
  let stoppedEarly = false;

  for (let off = 0; off < tokenIds.length; off += CHUNK) {
    const chunkIds = tokenIds.slice(off, off + CHUNK);
    const chunk = await mapLimit(chunkIds, 4, async (tokenId) => {
      const posHex = await ethCall(rpc, nfpm, dataPositions(tokenId));
      const pos = decodePositions(posHex);
      if (!pos) return null;
      return { tokenId, ...pos };
    });
    scanned += chunkIds.length;
    for (const p of chunk) {
      if (!p || p.__error) continue;
      const dead = p.liquidity === 0n && p.tokensOwed0 === 0n && p.tokensOwed1 === 0n;
      if (dead) consecutiveClosed++; else consecutiveClosed = 0;
      if (!dead || includeClosed) live.push(p);
    }
    if (!includeClosed && consecutiveClosed >= STOP_AFTER_CLOSED) {
      stoppedEarly = true;
      break;
    }
  }
  return { live, scanned, stoppedEarly };
}

/**
 * Truncated wallets (count > MAX_POSITIONS): interleave tokenOfOwnerByIndex
 * with positions() in chunks so early-stop can still skip the tail. The
 * resulting id list is partial, so it is never written to the enum cache.
 */
async function scanInterleaved(rpc, chain, owner, count, includeClosed) {
  const scanCap = Math.min(count, MAX_POSITIONS);
  const live = [];
  let scanned = 0;
  let consecutiveClosed = 0;
  let stoppedEarly = false;

  for (let off = 0; off < scanCap; off += CHUNK) {
    const size = Math.min(CHUNK, scanCap - off);
    const idxs = Array.from({ length: size }, (_, i) => count - 1 - off - i);

    const idHexes = await mapLimit(idxs, 4, (i) =>
      ethCall(rpc, chain.nfpm, dataTokenOfOwnerByIndex(owner, i))
    );
    const tokenIds = idHexes
      .filter((h) => typeof h === 'string')
      .map((h) => toUint(words(h)[0]));

    const chunk = await mapLimit(tokenIds, 4, async (tokenId) => {
      const posHex = await ethCall(rpc, chain.nfpm, dataPositions(tokenId));
      const pos = decodePositions(posHex);
      if (!pos) return null;
      return { tokenId, ...pos };
    });
    scanned += size;

    for (const p of chunk) {
      if (!p || p.__error) continue;
      const dead = p.liquidity === 0n && p.tokensOwed0 === 0n && p.tokensOwed1 === 0n;
      if (dead) consecutiveClosed++; else consecutiveClosed = 0;
      if (!dead || includeClosed) live.push(p);
    }

    if (!includeClosed && consecutiveClosed >= STOP_AFTER_CLOSED) {
      stoppedEarly = true;
      break;
    }
  }
  return { live, scanned, stoppedEarly };
}

/**
 * Best-effort USD marks from DexScreener.
 *
 * Two guards, and both are load-bearing. Without them this returned prices
 * wrong by orders of magnitude — a real defect, not a hypothetical:
 *
 *  1. CHAIN. DexScreener returns pairs across every chain it indexes, and the
 *     same address frequently exists elsewhere as a bridged or copycat token.
 *     Querying Ethereum WETH returns six PulseChain pairs BEFORE the real ones,
 *     so taking the first pair marked WETH at $0.0000122 instead of $1,932.99.
 *  2. LIQUIDITY. Among pairs on the right chain, a thin pool can quote almost
 *     anything. The deepest qualifying pair wins, and pairs below a floor are
 *     ignored entirely.
 *
 * A dispersion check then compares the deepest pair against other materially
 * liquid ones. If they disagree substantially the token is left UNPRICED rather
 * than marked at a number no one can stand behind — an absent mark renders as
 * "unpriced", which is honest, whereas a wrong mark silently corrupts every
 * dollar figure derived from it.
 *
 * Mirrors the guard structure already proven in
 * `PortfolioManager/scripts/robinhood_chain_lp.py`.
 */
export async function usdPrices(chainKey, addresses) {
  const chain = CHAINS[chainKey];
  const wantChain = chain && chain.dexscreener;
  const MIN_LIQUIDITY_USD = 5000;
  const MATERIAL_SHARE = 0.20;   // pools worth comparing against the deepest
  const MAX_DISPERSION = 0.25;   // beyond this, refuse to pick

  const out = {};
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))];

  for (let i = 0; i < unique.length; i += 8) {
    const batch = unique.slice(i, i + 8);
    let json;
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch.join(',')}`);
      json = await res.json();
    } catch {
      continue;   // keyless best-effort; absence is "no mark", never 0
    }

    const byToken = new Map();
    for (const pair of json.pairs || []) {
      if (wantChain && String(pair.chainId || '').toLowerCase() !== wantChain) continue;
      const base = pair.baseToken && pair.baseToken.address && pair.baseToken.address.toLowerCase();
      const price = Number(pair.priceUsd);
      const liq = Number((pair.liquidity && pair.liquidity.usd) || 0);
      if (!base || !batch.includes(base) || !(price > 0) || !(liq >= MIN_LIQUIDITY_USD)) continue;
      if (!byToken.has(base)) byToken.set(base, []);
      byToken.get(base).push({ price, liq });
    }

    for (const [token, pairs] of byToken) {
      pairs.sort((a, b) => b.liq - a.liq);
      const best = pairs[0];
      const material = pairs.filter((p) => p.liq >= best.liq * MATERIAL_SHARE);
      const worst = material.reduce(
        (acc, p) => Math.max(acc, Math.abs(p.price - best.price) / best.price), 0);
      if (worst > MAX_DISPERSION) continue;   // leave unpriced rather than guess
      out[token] = best.price;
    }
  }
  return out;
}


/**
 * Value a position in USD, or refuse to.
 *
 * A missing price is NOT zero. Treating an unpriced leg as $0 silently
 * understates the position — the same fail-silent class as a scan that
 * overwrites a good mark with 0. If a leg holds a non-zero amount and has no
 * mark, this returns null and the caller must render "unpriced".
 */
export function valueUsd(amount0, amount1, price0, price1) {
  const missing0 = price0 === undefined && amount0 !== 0;
  const missing1 = price1 === undefined && amount1 !== 0;
  if (missing0 || missing1) return null;
  return (price0 ?? 0) * amount0 + (price1 ?? 0) * amount1;
}

/**
 * v4 half of an address sweep.
 *
 * Kept separate from the v3 scan because almost nothing carries over: the v4
 * PositionManager is not ERC721Enumerable, so holdings come from Transfer logs,
 * and there is no per-tokenId event history to attach.
 *
 * Liquidity is checked first, one cheap call per token, so only positions that
 * will actually render pay for the full read. A 22-position wallet costs 22
 * calls to filter instead of ~110 to load everything.
 */
async function scanV4(chainKey, owner, opts = {}) {
  const chain = CHAINS[chainKey];
  if (!chain || !chain.v4PositionManager) {
    return { positions: [], held: 0, shown: 0, unavailable: null };
  }
  const rpc = opts.rpcOverride || chain.rpc;

  const found = await enumerateV4(chainKey, owner, opts);
  if (found.unavailable) {
    return { positions: [], held: 0, shown: 0, unavailable: found.unavailable };
  }
  // A short list would read as "you hold fewer positions"; say so instead.
  if (!found.reconciles) {
    return {
      positions: [], held: found.balanceOf, shown: 0,
      unavailable: `v4 enumeration incomplete — Transfer logs give ${found.tokenIds.length}`
        + ` positions but balanceOf reports ${found.balanceOf}`,
    };
  }

  const live = await mapLimit(found.tokenIds, 4, async (tokenId) => {
    const hex = await ethCall(rpc, chain.v4PositionManager, V4.positionLiquidity + encUint(tokenId));
    const liquidity = toUint(words(hex)[0] || '0');
    return liquidity === 0n && !opts.includeClosed ? null : tokenId;
  });
  const wanted = live.filter((t) => t && !t.__error);

  const loaded = await mapLimit(wanted, 3, (tokenId) =>
    loadV4Position(chainKey, tokenId, {
      ...opts,
      tokenMeta: (addr) => tokenMeta(rpc, chainKey, addr),
    }));

  return {
    positions: loaded.filter((p) => p && !p.__error),
    held: found.tokenIds.length,
    shown: loaded.filter((p) => p && !p.__error).length,
    unavailable: null,
  };
}


/**
 * USD marks for one position.
 *
 * What is honest here, and what is not, comes down to WHEN each side is priced.
 *
 *   vsHoldUsd  — the vs-HODL delta converted at today's price. Legitimate,
 *                because vs-HODL already values both baskets at one moment;
 *                this only restates that single-moment result in dollars.
 *   valueUsd   — what the position is worth right now. A plain current mark.
 *   feesUsd    — fees earned, valued today. Tokens you actually hold.
 *
 * What is deliberately NOT here is "dollars made since deposit", i.e.
 * value_now_usd − value_at_deposit_usd. That needs a USD mark at the deposit
 * block, and pricing the old basket at today's rate instead is exactly the
 * `token_delta × price_now` error this project exists to avoid.
 *
 * Marks come from DexScreener and are best-effort: an unpriced leg yields null,
 * never zero, because a missing price must not read as a worthless position.
 */
export async function attachUsd(chainKey, p, opts = {}) {
  let prices = {};
  try {
    prices = await usdPrices(chainKey, [p.token0, p.token1]);
  } catch {
    return { ...p, usd: null };
  }
  // Chain-derived marks are preferred over DexScreener: they come from the
  // position's own pool plus the USD reference, so the current value and the
  // cost basis are produced the same way. DexScreener only fills the gap for
  // pairs with no leg in the reference token or the stablecoin.
  let chainPair = null;
  try {
    chainPair = await usdPairAt(chainKey, p.token0, p.token1, p.price, 'latest', opts);
  } catch { chainPair = null; }

  const p0 = chainPair ? chainPair.usd0 : prices[p.token0.toLowerCase()];
  const p1 = chainPair ? chainPair.usd1 : prices[p.token1.toLowerCase()];
  if (p0 === undefined && p1 === undefined) return { ...p, usd: null };

  const h = p.history || {};
  const v = h.vsHodl;
  const mark = (a0, a1) => {
    if (a0 === null || a1 === null || a0 === undefined || a1 === undefined) return null;
    if ((a0 !== 0 && p0 === undefined) || (a1 !== 0 && p1 === undefined)) return null;
    return (p0 ?? 0) * a0 + (p1 ?? 0) * a1;
  };

  // True USD PnL: what everything is worth now, against what it cost at the
  // deposit block. The cost basis comes from chain state at that block, not
  // from today's price applied backwards.
  let basis = null;
  try { basis = await costBasisUsd(chainKey, p, opts); } catch { basis = null; }

  const nowAll = mark(
    (h.received0 ?? 0) + (p.amount0 || 0) + (p.collectable0 || 0),
    (h.received1 ?? 0) + (p.amount1 || 0) + (p.collectable1 || 0),
  );

  return {
    ...p,
    usd: {
      price0: p0 ?? null,
      price1: p1 ?? null,
      markSource: chainPair ? 'pool' : 'dexscreener',
      bridged: !!(CHAINS[chainKey] && CHAINS[chainKey].usdRef && CHAINS[chainKey].usdRef.via),
      costBasis: basis ? basis.basis : null,
      costBasisExact: basis ? basis.exact : null,
      costBasisBound: basis ? basis.bound : null,
      // Everything you hold or have taken out, valued now, minus what it cost.
      pnl: basis && nowAll !== null ? nowAll - basis.basis : null,
      pnlPct: basis && nowAll !== null ? (nowAll / basis.basis - 1) * 100 : null,
      totalNow: nowAll,
      // vsHodl.delta is denominated in token1, so it converts with p1 alone.
      vsHodl: v && p1 !== undefined ? v.delta * p1 : null,
      value: mark(p.amount0, p.amount1),
      collectable: mark(p.collectable0, p.collectable1),
      fees: h.fees0 !== undefined && p1 !== undefined ? mark(h.fees0, h.fees1) : null,
      deposited: h.deposited0 !== undefined ? mark(h.deposited0, h.deposited1) : null,
    },
  };
}

/** Where history logs should come from for this chain and these options. */
function historySource(chain, rpc, opts) {
  return {
    rpc: opts.rpcOverride || chain.logsRpc || rpc,
    etherscanKey: opts.etherscanKey || chain.etherscanKey || null,
    etherscanChainId: chain.etherscanChainId || null,
    blockscout: chain.blockscout || null,
  };
}

/**
 * Present-state enrichment for one decoded position: pool, price, range,
 * composition, collectable. Shared by the address scan and the single-token
 * lookup so the two paths cannot drift apart.
 */
async function enrichPosition(rpc, chain, chainKey, owner, p) {
  const poolHex = await ethCall(rpc, chain.factory, dataGetPool(p.token0, p.token1, p.fee));
  const pool = toAddress(words(poolHex)[0]);
  if (/^0x0{40}$/.test(pool)) return { ...p, error: 'pool not found' };

  const [slotHex, t0, t1, collectHex] = await Promise.all([
    ethCall(rpc, pool, dataSlot0()),
    tokenMeta(rpc, chainKey, p.token0),
    tokenMeta(rpc, chainKey, p.token1),
    // from == owner is required; collect() checks the caller is approved.
    ethCall(rpc, chain.nfpm, dataCollect(p.tokenId, owner), owner).catch(() => null),
  ]);

  const slot = decodeSlot0(slotHex);
  const amounts = positionAmounts({ ...p, sqrtPriceX96: slot.sqrtPriceX96 });
  const collectable = collectHex ? decodeCollect(collectHex) : null;

  return {
    ...p,
    pool,
    token0Meta: t0,
    token1Meta: t1,
    currentTick: slot.tick,
    price: humanPrice(slot.sqrtPriceX96, t0.decimals, t1.decimals),
    priceLower: tickToPrice(p.tickLower, t0.decimals, t1.decimals),
    priceUpper: tickToPrice(p.tickUpper, t0.decimals, t1.decimals),
    amount0: scale(amounts.amount0, t0.decimals),
    amount1: scale(amounts.amount1, t1.decimals),
    status: amounts.status,
    // Deliberately named "collectable", not "fees": collect() returns
    // principal owed + fees when a decreaseLiquidity is pending.
    collectable0: collectable ? scale(Number(collectable.amount0), t0.decimals) : null,
    collectable1: collectable ? scale(Number(collectable.amount1), t1.decimals) : null,
  };
}

/**
 * Lifetime history for one enriched position. One eth_getLogs. An endpoint
 * that refuses wide ranges degrades to `history.unavailable` rather than
 * failing the position.
 */
async function attachHistory(source, chain, p) {
  // The cache check is free: the fingerprint comes from `positions(tokenId)`,
  // which this load already fetched. A hit skips the only request that needs a
  // keyed or rate-limited endpoint.
  const fp = fingerprint(p);
  let h = await readHistory(chain.nfpm, p.tokenId, fp);
  // A cache entry that no longer explains on-chain liquidity is treated as a
  // miss, not trusted. Belt and braces behind the fingerprint. An empty set
  // is also a miss: a minted position cannot have zero lifetime events, and
  // a pre-fix cache entry must not stick a false "no activity".
  if (h && (!h.events.length || !reconciles(h.events, p.liquidity))) h = null;

  if (!h) {
    h = await fetchHistory(source, chain.nfpm, p.tokenId);
    if (!h.unavailable && (!h.events || h.events.length === 0)) {
      return {
        ...p,
        history: {
          unavailable: 'zero lifetime events — a minted position must have at '
            + 'least one IncreaseLiquidity',
        },
      };
    }
    if (!h.unavailable && !reconciles(h.events, p.liquidity)) {
      // Never cache an incomplete set, and never quietly derive numbers from
      // one — a truncated history produces confident, wrong figures.
      return {
        ...p,
        history: {
          unavailable: 'event history incomplete — the log source returned a '
            + 'partial set, so entry price and PnL cannot be trusted for this position',
        },
      };
    }
    if (!h.unavailable) await writeHistory(chain.nfpm, p.tokenId, fp, h.events, h.source);
  }
  if (h.unavailable) return { ...p, history: { unavailable: h.unavailable } };

  const acct = accounting(h.events);
  const d0 = p.token0Meta.decimals, d1 = p.token1Meta.decimals;
  const priced = (ev) => {
    const r = solveSqrtPrice({ ...ev, tickLower: p.tickLower, tickUpper: p.tickUpper });
    return r ? { ...r, price: r.sqrtP * r.sqrtP * Math.pow(10, d0 - d1) } : null;
  };

  const firstAdd = h.events.find((e) => e.kind === 'increase');
  const lastRemove = [...h.events].reverse().find((e) => e.kind === 'decrease');

  return {
    ...p,
    history: {
      entry: firstAdd ? priced(firstAdd) : null,
      // An exit price only exists once the position is actually closed.
      exit: p.liquidity === 0n && lastRemove ? priced(lastRemove) : null,
      deposited0: scale(Number(acct.deposited0), d0),
      deposited1: scale(Number(acct.deposited1), d1),
      received0: scale(Number(acct.received0), d0),
      received1: scale(Number(acct.received1), d1),
      fees0: scale(Number(acct.fees0), d0),
      fees1: scale(Number(acct.fees1), d1),
      adds: acct.adds,
      firstBlock: acct.firstBlock,
      firstTime: acct.firstTime,
      lastTime: acct.lastTime,
      source: h.source + (h.cached ? ' (cached)' : ''),
      vsHodl: vsHodl(p, {
        deposited0: scale(Number(acct.deposited0), d0),
        deposited1: scale(Number(acct.deposited1), d1),
        received0: scale(Number(acct.received0), d0),
        received1: scale(Number(acct.received1), d1),
        fees0: scale(Number(acct.fees0), d0),
        fees1: scale(Number(acct.fees1), d1),
        collectable0: p.collectable0 || 0,
        collectable1: p.collectable1 || 0,
        firstTime: acct.firstTime,
        lastTime: acct.lastTime,
        exit: p.liquidity === 0n && lastRemove ? priced(lastRemove) : null,
      }),
    },
  };
}

/**
 * Position value against simply having held the deposit — impermanent loss,
 * net of fees. This is the number an LP actually wants, and it needs no
 * historical USD at all.
 *
 * Why this is legitimate where `token_delta × price_now` is not: both baskets
 * are valued at ONE price. That is a same-moment comparison of two portfolios,
 * not a historical quantity delta multiplied by today's mark. The refusal
 * elsewhere in this project is about the latter and does not apply here.
 *
 * WHICH price is a correctness question, not a detail. A closed position
 * stopped being exposed at its exit price; valuing its deposit basket at spot
 * charges it with market moves that happened after it ceased to exist. Measured
 * on position 961877 the difference is the whole conclusion: +0.022% priced at
 * exit (fees beat IL), −0.470% priced at spot (a loss that never happened).
 *
 * Denominated in token1. Returns null when there is nothing to compare.
 */
function vsHodl(p, h) {
  const closed = p.liquidity === 0n && h.exit;
  const price = closed ? h.exit.price : p.price;
  if (!price || !Number.isFinite(price)) return null;

  const have0 = h.received0 + (p.amount0 || 0) + (p.collectable0 || 0);
  const have1 = h.received1 + (p.amount1 || 0) + (p.collectable1 || 0);

  const hodl = h.deposited0 * price + h.deposited1;
  const have = have0 * price + have1;
  if (!hodl) return null;

  const delta = have - hodl;

  // Decomposition. A position's value satisfies
  //     value_now = value_hodl + fees_earned - impermanent_loss
  // so with fees known exactly (Collect minus Decrease, plus what is still
  // claimable), IL is the remainder rather than a separate estimate. Reporting
  // only the net hides which of the two is driving it — a position can be up
  // on huge fees despite severe IL, or barely up because neither happened, and
  // those call for opposite decisions.
  const fees = (h.fees0 + h.collectable0) * price + (h.fees1 + h.collectable1);
  const il = fees - delta;   // positive means IL cost you

  // Realised fee yield over the position's ACTUAL life, which is a different
  // and more honest number than Uniswap's trailing-24h APR: it is what this
  // position really earned, not what the pool paid yesterday. Null without
  // timestamps rather than guessed from block heights.
  let apr = null, aprDays = null;
  const end = closed ? h.lastTime : Math.floor(Date.now() / 1000);
  if (h.firstTime && end && end > h.firstTime) {
    const years = (end - h.firstTime) / 31557600;
    if (years > 0) {
      apr = (fees / hodl) / years * 100;
      // The sample window travels with the number. Annualising a few hours
      // multiplies them by thousands — a 4h sample carries a x2192 factor — so
      // an APR from a young position is an extrapolation, not a yield. Callers
      // must be able to say so rather than print a confident percentage.
      aprDays = years * 365.25;
    }
  }

  return {
    delta,
    pct: (have / hodl - 1) * 100,
    fees,
    feesPct: (fees / hodl) * 100,
    il,
    ilPct: (il / hodl) * 100,
    apr,
    aprDays,
    price,
    pricedAt: closed ? 'exit' : 'spot',
  };
}

/**
 * Load exactly one position by tokenId, with no owner known up front.
 *
 * This is the path the on-page overlay uses: a Uniswap position URL carries
 * chain and tokenId but not the owner, and `collect()` must be staticcalled
 * as the owner, so ownerOf is read first. Everything after that is the same
 * code the popup runs.
 */
export async function loadPositionByVersion(chainKey, version, tokenId, opts = {}) {
  if (String(version).toLowerCase() === 'v4') {
    const chain = CHAINS[chainKey];
    const rpc = opts.rpcOverride || (chain && chain.rpc);
    const v4pos = await loadV4Position(chainKey, tokenId, {
      ...opts,
      tokenMeta: (addr) => tokenMeta(rpc, chainKey, addr),
    });
    return opts.withUsd === false ? v4pos : attachUsd(chainKey, v4pos, opts);
  }
  return loadPosition(chainKey, tokenId, opts);
}

export async function loadPosition(chainKey, tokenId, opts = {}) {
  const chain = CHAINS[chainKey];
  if (!chain) throw new Error(`unknown chain ${chainKey}`);
  const rpc = opts.rpcOverride || chain.rpc;

  const [posHex, ownerHex] = await Promise.all([
    ethCall(rpc, chain.nfpm, dataPositions(tokenId)),
    ethCall(rpc, chain.nfpm, dataOwnerOf(tokenId)).catch(() => null),
  ]);

  const pos = decodePositions(posHex);
  if (!pos) throw new Error(`position ${tokenId} not readable on ${chainKey}`);
  const owner = ownerHex ? toAddress(words(ownerHex)[0]) : null;

  const enriched = await enrichPosition(rpc, chain, chainKey, owner, { tokenId, ...pos });
  if (enriched.error) return { ...enriched, owner };
  const full = await attachHistory(historySource(chain, rpc, opts), chain, enriched);
  const priced = opts.withUsd === false ? full : await attachUsd(chainKey, full, opts);
  return { ...priced, owner, version: 'v3' };
}
