import { CHAINS, MAX_POSITIONS } from './chains.js';
import {
  dataBalanceOf, dataTokenOfOwnerByIndex, dataPositions, dataSlot0,
  dataGetPool, dataCollect, dataOwnerOf, decodePositions, decodeSlot0, decodeCollect,
  decodeSymbol, SELECTOR, toUint, toAddress, words, encUint,
} from './abi.js';
import { ethCall, ethCallBatch, mapLimit } from './rpc.js';
import {
  fetchHistory, fetchRecentHistory, mergeHistoryEvents, hasNewHistoryEvent,
  solveSqrtPrice, accounting, reconciles, lifetimeFees,
} from './history.js';
import { fingerprint, readHistory, readHistoryAny, writeHistory } from './cache.js';
import { enumerateV4, loadV4Position, V4 } from './v4.js';
import {
  costBasisUsd, collectedProceedsUsd, strategyReturn, usdPairAt,
} from './histprice.js';
import { positionAmounts, humanPrice, scale, tickToPrice } from './v3.js';

const tokenCache = new Map(); // `${chain}:${addr}` -> {symbol, decimals}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function retryRead(fn, attempts = 3) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await fn(); }
    catch (err) {
      last = err;
      if (attempt + 1 < attempts) await wait(120 * (attempt + 1));
    }
  }
  throw last;
}

const isAlchemyRpc = (rpc) => {
  try { return new URL(rpc).hostname.toLowerCase().endsWith('.g.alchemy.com'); }
  catch { return false; }
};

/** Batch high-volume Alchemy eth_calls; public RPCs retain bounded singles. */
async function readMany(rpc, calls) {
  if (!isAlchemyRpc(rpc)) {
    return mapLimit(calls, 4, (call) => retryRead(() => ethCall(
      rpc, call.to, call.data, call.from, call.block || 'latest')));
  }

  const out = new Array(calls.length);
  for (let offset = 0; offset < calls.length; offset += 25) {
    const chunk = calls.slice(offset, offset + 25);
    let pending = chunk.map((call, index) => ({ call, index }));
    for (let attempt = 0; attempt < 4 && pending.length; attempt++) {
      let rows;
      try { rows = await ethCallBatch(rpc, pending.map((item) => item.call)); }
      catch {
        if (attempt < 3) await wait(2000 * (attempt + 1));
        continue;
      }
      const retry = [];
      for (let i = 0; i < pending.length; i++) {
        if (!rows[i] || rows[i].__error) retry.push(pending[i]);
        else out[offset + pending[i].index] = rows[i];
      }
      pending = retry;
      if (pending.length && attempt < 3) await wait(2000 * (attempt + 1));
    }
    for (const item of pending) {
      out[offset + item.index] = { __error: 'eth_call unreadable after retries' };
    }
    if (offset + chunk.length < calls.length) await wait(250);
  }
  return out;
}

async function tokenMeta(rpc, chainKey, addr) {
  const key = `${chainKey}:${addr.toLowerCase()}`;
  if (tokenCache.has(key)) return tokenCache.get(key);
  const [symRaw, decRaw] = await Promise.all([
    retryRead(() => ethCall(rpc, addr, SELECTOR.symbol)).catch(() => null),
    retryRead(() => ethCall(rpc, addr, SELECTOR.decimals)).catch(() => null),
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

// DexScreener mark memo, keyed `chain:token`. In memory only — prices are live
// numbers and must not survive into a later session from chrome.storage.
const PRICE_MEMO = new Map();
const PRICE_MEMO_TTL_MS = 60_000;
const PRICE_MEMO_MAX = 500;

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
    // Zero v3 NFTs does NOT mean zero positions. v4 holdings live in a
    // different contract and are found through Transfer logs, not through this
    // balanceOf, so v4 must still be scanned. This used to return here with a
    // hardcoded empty v4, which rendered a v4-only wallet as "no positions" —
    // and with `unavailable: null` it asserted zero rather than admitting it
    // had not looked. Silently claiming an empty result is the one failure
    // this project does not accept.
    const v4 = await scanV4(chainKey, owner, opts);
    let positions = v4.positions.map((p) => tagPosition(p, chainKey));
    if (opts.withUsd) {
      positions = (await mapLimit(positions, 2, async (p) => {
        try { return await attachUsd(chainKey, p, opts); }
        catch { return p; }
      })).filter((p) => p && !p.__error);
    }
    return {
      chain: chainKey, count: 0, scanned: 0, truncated: false, stoppedEarly: false,
      attempted: 0, enumUnreadable: 0, positionUnreadable: 0, closedHidden: 0,
      positions, v4,
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
  // Re-enumerate ownership on every load. ERC721Enumerable uses swap-and-pop:
  // mint D then transfer B can change [A,B,C] to [A,D,C] while both balanceOf
  // and the newest token stay unchanged. No constant-size cache sentinel can
  // prove the set did not change.
  const v3 = await scanV3Holdings(rpc, chain, owner, count, includeClosed);
  const { live, scanned } = v3;

  const enriched = await mapLimit(live, 3, (p) =>
    retryRead(() => enrichPosition(rpc, chain, chainKey, owner, p), 2));

  const rendered = enriched.filter((p) => p && !p.__error);
  const enrichUnreadable = enriched.length - rendered.length;

  // Lifetime history is fetched only for positions that will actually render,
  // so its cost scales with what you see rather than with what was scanned —
  // one eth_getLogs per visible card. An endpoint that refuses wide ranges
  // degrades to `history.unavailable`; it never fails the whole load.
  // Wide eth_getLogs needs a better endpoint than present-state reads do, so
  // history gets its own source descriptor. Etherscan wins when a user key
  // exists; a refusal (including the HTTP-200 Base paywall) falls through to
  // the licensed Blockscout Pro relay, then public Blockscout, then RPC.
  const source = historySource(chain, rpc, opts);
  const withHistory = await mapLimit(rendered, 3, (p) => attachHistory(source, chain, p));

  const v3Positions = withHistory.filter((p) => p && !p.__error);
  const historyUnreadable = withHistory.length - v3Positions.length;
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
    attempted: v3.attempted,
    enumUnreadable: v3.enumUnreadable,
    positionUnreadable: v3.positionUnreadable + enrichUnreadable + historyUnreadable,
    closedHidden: v3.closedHidden,
    truncated: count > v3.attempted,
    stoppedEarly: false,
    enumSource: 'rpc-verified',
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
 * Current v3 holdings, newest first.
 *
 * Every ownership index is read on every scan, followed by positions() for
 * every id. Closed NFTs are read too because increaseLiquidity can revive any
 * unburned token. Failures are counted instead of being filtered away.
 */
export async function scanV3Holdings(rpc, chain, owner, count, includeClosed = false) {
  const attempted = Math.min(count, MAX_POSITIONS);
  const indexes = Array.from({ length: attempted }, (_, i) => count - 1 - i);
  const idHexes = await readMany(rpc, indexes.map((index) => ({
    to: chain.nfpm, data: dataTokenOfOwnerByIndex(owner, index),
  })));

  const tokenIds = [];
  let enumUnreadable = 0;
  for (const hex of idHexes) {
    if (!hex || hex.__error) { enumUnreadable++; continue; }
    try { tokenIds.push(toUint(words(hex)[0])); }
    catch { enumUnreadable++; }
  }

  const live = [];
  let scanned = 0;
  let positionUnreadable = 0;
  let closedHidden = 0;
  const posHexes = await readMany(rpc, tokenIds.map((tokenId) => ({
    to: chain.nfpm, data: dataPositions(tokenId),
  })));
  for (let i = 0; i < tokenIds.length; i++) {
    const hex = posHexes[i];
    if (!hex || hex.__error) { positionUnreadable++; continue; }
    const pos = decodePositions(hex);
    if (!pos) { positionUnreadable++; continue; }
    const p = { tokenId: tokenIds[i], ...pos };
    scanned++;
    const dead = p.liquidity === 0n && p.tokensOwed0 === 0n && p.tokensOwed1 === 0n;
    if (dead && !includeClosed) closedHidden++;
    if (!dead || includeClosed) live.push(p);
  }
  return { live, attempted, scanned, enumUnreadable, positionUnreadable, closedHidden };
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
  // In-memory dedupe across a scan. attachUsd runs once per position, so 20
  // positions used to mean 20 DexScreener requests even though nearly all of
  // them share WETH or a stablecoin. Scanning five chains for several wallets
  // multiplies that, and DexScreener is the request budget most likely to be
  // throttled. Short TTL because these are live marks; failures are never
  // cached, so a throttled request retries rather than sticking as "unpriced".
  const fresh = {};
  const missing = [];
  const nowMs = Date.now();
  for (const a of new Set(addresses.map((x) => String(x).toLowerCase()))) {
    const hit = PRICE_MEMO.get(`${chainKey}:${a}`);
    if (hit && nowMs - hit.at < PRICE_MEMO_TTL_MS) fresh[a] = hit.usd;
    else missing.push(a);
  }
  if (!missing.length) return fresh;
  const MIN_LIQUIDITY_USD = 5000;
  const MATERIAL_SHARE = 0.20;   // pools worth comparing against the deepest
  const MAX_DISPERSION = 0.25;   // beyond this, refuse to pick

  const out = {};
  // Only what the memo did not already have. 30 is DexScreener's documented
  // per-request address limit.
  const unique = missing;

  for (let i = 0; i < unique.length; i += 30) {
    const batch = unique.slice(i, i + 30);
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

    // Cache this batch. A token DexScreener answered for but did not price is
    // memoised as undefined so it is not re-requested once per position; a
    // batch that threw never reaches here, so a throttled request retries.
    const at = Date.now();
    for (const token of batch) PRICE_MEMO.set(`${chainKey}:${token}`, { usd: out[token], at });
    if (PRICE_MEMO.size > PRICE_MEMO_MAX) {
      for (const k of [...PRICE_MEMO.keys()].slice(0, PRICE_MEMO.size - PRICE_MEMO_MAX)) {
        PRICE_MEMO.delete(k);
      }
    }
  }
  return { ...fresh, ...out };
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
    return {
      positions: [], held: 0, shown: 0, closedHidden: 0, unreadable: 0,
      unavailable: null,
    };
  }
  const rpc = opts.rpcOverride || chain.rpc;

  const found = await enumerateV4(chainKey, owner, opts);
  if (found.unavailable) {
    return {
      positions: [], held: found.balanceOf ?? null, shown: 0,
      closedHidden: 0, unreadable: found.balanceOf ?? null,
      unavailable: found.unavailable,
    };
  }
  // A short list would read as "you hold fewer positions"; say so instead.
  if (!found.reconciles) {
    return {
      positions: [], held: found.balanceOf, shown: 0,
      closedHidden: 0,
      unreadable: Math.max(0, found.balanceOf - found.tokenIds.length),
      unavailable: `v4 enumeration incomplete — Transfer logs give ${found.tokenIds.length}`
        + ` positions but balanceOf reports ${found.balanceOf}`,
    };
  }

  const liquidityHexes = await readMany(rpc, found.tokenIds.map((tokenId) => ({
    to: chain.v4PositionManager, data: V4.positionLiquidity + encUint(tokenId),
  })));
  const checked = found.tokenIds.map((tokenId, index) => {
    const hex = liquidityHexes[index];
    if (!hex || hex.__error) return { __error: hex && hex.__error || 'liquidity unreadable' };
    return { tokenId, closed: toUint(words(hex)[0] || '0') === 0n };
  });
  const liquidityUnreadable = checked.filter((row) => row && row.__error).length;
  const readable = checked.filter((row) => row && !row.__error);
  const closedHidden = opts.includeClosed ? 0 : readable.filter((row) => row.closed).length;
  const wanted = readable
    .filter((row) => opts.includeClosed || !row.closed)
    .map((row) => row.tokenId);

  const loaded = await mapLimit(wanted, 3, (tokenId) =>
    retryRead(() => loadV4Position(chainKey, tokenId, {
      ...opts,
      tokenMeta: (addr) => tokenMeta(rpc, chainKey, addr),
    }), 2));

  const positions = loaded.filter((p) => p && !p.__error);
  const loadUnreadable = loaded.length - positions.length;
  return {
    positions,
    held: found.balanceOf,
    shown: positions.length,
    closedHidden,
    unreadable: liquidityUnreadable + loadUnreadable,
    source: found.source,
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
 *   currentValue — active liquidity plus claimable amounts, marked now.
 *   grossAdded   — every addition valued at its own block.
 *   cashReturned — every collection valued at its own block.
 *   pnl          — currentValue + cashReturned − grossAdded.
 *
 * Historical collections are never marked today. Once value leaves an LP it
 * stops accruing to that position; assuming it remains held double-counts it
 * when the owner rebalances into another NFT.
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
  // historical cash flows are produced the same way. DexScreener only fills the gap for
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

  // Strategy cash flows use event-time dollars on both sides. An addition is
  // capital entering the LP; a Collect is capital leaving it. Once collected,
  // tokens are no longer assumed to remain in the wallet forever — doing that
  // double-counts them when they are re-used in a new NFT.
  let basis = null;
  try { basis = await costBasisUsd(chainKey, p, opts); } catch { basis = null; }
  let proceeds = null;
  try { proceeds = await collectedProceedsUsd(chainKey, p, opts); } catch { proceeds = null; }

  // Decreased-but-uncollected principal lives in collectable, so a remove does
  // not change return until the assets actually leave the position.
  const currentNow = p.collectable0 === null || p.collectable1 === null
    ? null
    : mark(
      (p.amount0 || 0) + p.collectable0,
      (p.amount1 || 0) + p.collectable1,
    );
  const ret = strategyReturn(basis, proceeds, currentNow);
  let returnUnavailable = null;
  if (!basis) returnUnavailable = 'gross additions unpriced';
  else if (!basis.exact) returnUnavailable = 'gross additions are bounded';
  else if (!proceeds) returnUnavailable = 'collected proceeds unpriced';
  else if (!proceeds.exact) returnUnavailable = 'collected proceeds are bounded';
  else if (currentNow === null) returnUnavailable = 'current collectable unavailable';

  return {
    ...p,
    usd: {
      price0: p0 ?? null,
      price1: p1 ?? null,
      markSource: chainPair ? 'pool' : 'dexscreener',
      bridged: !!(CHAINS[chainKey] && CHAINS[chainKey].usdRef && CHAINS[chainKey].usdRef.via),
      grossAdded: basis ? basis.basis : null,
      grossAddedExact: basis ? basis.exact : null,
      grossAddedBound: basis ? basis.bound : null,
      collectedProceeds: proceeds ? proceeds.proceeds : null,
      collectedProceedsExact: proceeds ? proceeds.exact : null,
      netCashIn: basis && proceeds && basis.exact && proceeds.exact
        ? basis.basis - proceeds.proceeds : null,
      returnUnavailable,
      pnl: ret.pnl,
      pnlPct: ret.pnlPct,
      currentValue: currentNow,
      // Compatibility aliases for existing local harnesses and old consumers.
      // UI copy no longer calls gross additions a cost basis.
      costBasis: basis ? basis.basis : null,
      costBasisExact: basis ? basis.exact : null,
      costBasisBound: basis ? basis.bound : null,
      totalNow: currentNow,
      // vsHodl.delta is denominated in token1, so it converts with p1 alone.
      vsHodl: v && p1 !== undefined ? v.delta * p1 : null,
      value: mark(p.amount0, p.amount1),
      collectable: mark(p.collectable0, p.collectable1),
      fees: h.fees0 !== undefined && h.fees0 !== null && p1 !== undefined
        ? mark(h.fees0, h.fees1) : null,
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
    blockscoutRelay: opts.blockscoutRelay || null,
    blockscoutChainId: chain.etherscanChainId || null,
    blockscout: chain.blockscout || null,
  };
}

/**
 * Present-state enrichment for one decoded position: pool, price, range,
 * composition, collectable. Shared by the address scan and the single-token
 * lookup so the two paths cannot drift apart.
 */
async function enrichPosition(rpc, chain, chainKey, owner, p) {
  const poolHex = await retryRead(() =>
    ethCall(rpc, chain.factory, dataGetPool(p.token0, p.token1, p.fee)));
  const pool = toAddress(words(poolHex)[0]);
  if (/^0x0{40}$/.test(pool)) return { ...p, error: 'pool not found' };

  const [slotHex, t0, t1, collectHex] = await Promise.all([
    retryRead(() => ethCall(rpc, pool, dataSlot0())),
    tokenMeta(rpc, chainKey, p.token0),
    tokenMeta(rpc, chainKey, p.token1),
    // from == owner is required; collect() checks the caller is approved.
    retryRead(() => ethCall(rpc, chain.nfpm, dataCollect(p.tokenId, owner), owner))
      .catch(() => null),
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
    collectableRaw0: collectable ? collectable.amount0 : null,
    collectableRaw1: collectable ? collectable.amount1 : null,
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
    const previous = await readHistoryAny(chain.nfpm, p.tokenId);
    const [full, recent] = await Promise.all([
      fetchHistory(source, chain.nfpm, p.tokenId),
      fetchRecentHistory(source, chain.nfpm, p.tokenId),
    ]);

    // A complete lifetime result is the base. If it is unavailable, a stale
    // complete cache plus newly mined RPC events is also sufficient. Recent
    // events alone are never mistaken for an old NFT's whole lifetime.
    if (!full.unavailable) {
      h = {
        events: mergeHistoryEvents(
          previous && previous.events, full.events, recent && recent.events),
        source: [full.source, recent && !recent.unavailable ? recent.source : null]
          .filter(Boolean).join('+'),
      };
    } else if (previous && recent && !recent.unavailable
        && hasNewHistoryEvent(previous.events, recent.events)) {
      h = {
        events: mergeHistoryEvents(previous.events, recent.events),
        source: `${previous.source || 'cache'}+${recent.source}`,
      };
    } else {
      h = {
        unavailable: [full.unavailable, recent && recent.unavailable]
          .filter(Boolean).join('; ') || 'history refresh unavailable',
      };
    }

    // A fingerprint miss proves positions() changed. If no source contains a
    // new event yet, do not cache old figures under the new fingerprint.
    if (!h.unavailable && previous
        && !hasNewHistoryEvent(previous.events, h.events)) {
      return {
        ...p,
        history: { unavailable: 'latest transaction is not indexed yet — retry in a moment' },
      };
    }
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
  const deposits = h.events.filter((e) => e.kind === 'increase').map((e) => ({
    block: e.block,
    time: e.time,
    transactionHash: e.transactionHash || null,
    logIndex: e.logIndex ?? null,
    amount0: scale(Number(e.amount0), d0),
    amount1: scale(Number(e.amount1), d1),
    entry: priced(e),
  }));
  const collections = h.events.filter((e) => e.kind === 'collect').map((e) => {
    // A DecreaseLiquidity in the same transaction gives the exact pool price
    // for a collect that mixes returned principal with fees. Fee-only collects
    // have no such event; historical slot0 pricing gets a chance later.
    const paired = e.transactionHash
      ? [...h.events].reverse().find((candidate) => candidate.kind === 'decrease'
        && candidate.transactionHash === e.transactionHash
        && (candidate.logIndex ?? -1) < (e.logIndex ?? Number.MAX_SAFE_INTEGER))
      : null;
    return {
      block: e.block,
      time: e.time,
      transactionHash: e.transactionHash || null,
      logIndex: e.logIndex ?? null,
      amount0: scale(Number(e.amount0), d0),
      amount1: scale(Number(e.amount1), d1),
      entry: paired ? priced(paired) : null,
    };
  });
  const fee0 = p.collectableRaw0 === null
    ? null : lifetimeFees(acct.received0, p.collectableRaw0, acct.withdrawn0);
  const fee1 = p.collectableRaw1 === null
    ? null : lifetimeFees(acct.received1, p.collectableRaw1, acct.withdrawn1);
  const fees0 = fee0 === null ? null : scale(Number(fee0), d0);
  const fees1 = fee1 === null ? null : scale(Number(fee1), d1);
  const currentUnavailable = p.collectable0 === null || p.collectable1 === null;
  const historyForComparison = {
    deposited0: scale(Number(acct.deposited0), d0),
    deposited1: scale(Number(acct.deposited1), d1),
    received0: scale(Number(acct.received0), d0),
    received1: scale(Number(acct.received1), d1),
    fees0,
    fees1,
    firstTime: acct.firstTime,
    lastTime: acct.lastTime,
    exit: p.liquidity === 0n && lastRemove ? priced(lastRemove) : null,
    adds: acct.adds,
  };

  return {
    ...p,
    history: {
      entry: firstAdd ? priced(firstAdd) : null,
      // An exit price only exists once the position is actually closed.
      exit: p.liquidity === 0n && lastRemove ? priced(lastRemove) : null,
      deposits,
      collections,
      deposited0: scale(Number(acct.deposited0), d0),
      deposited1: scale(Number(acct.deposited1), d1),
      received0: scale(Number(acct.received0), d0),
      received1: scale(Number(acct.received1), d1),
      fees0,
      fees1,
      adds: acct.adds,
      firstBlock: acct.firstBlock,
      firstTime: acct.firstTime,
      lastTime: acct.lastTime,
      currentUnavailable,
      source: h.source + (h.cached ? ' (cached)' : ''),
      vsHodl: currentUnavailable ? null : vsHodl(p, historyForComparison),
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

  if (p.collectable0 === null || p.collectable1 === null
      || h.fees0 === null || h.fees1 === null) return null;

  const have0 = h.received0 + (p.amount0 || 0) + p.collectable0;
  const have1 = h.received1 + (p.amount1 || 0) + p.collectable1;

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
  const fees = h.fees0 * price + h.fees1;
  const il = fees - delta;   // positive means IL cost you

  // Realised fee yield over the position's ACTUAL life, which is a different
  // and more honest number than Uniswap's trailing-24h APR: it is what this
  // position really earned, not what the pool paid yesterday. Null without
  // timestamps rather than guessed from block heights.
  let apr = null, aprDays = null;
  const end = closed ? h.lastTime : Math.floor(Date.now() / 1000);
  if (h.adds === 1 && h.firstTime && end && end > h.firstTime) {
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
