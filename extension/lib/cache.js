/**
 * Persistent history cache.
 *
 * Lifetime events are immutable: a position's past never changes, and its
 * present only changes when someone interacts with it. Re-fetching the entire
 * history on every view is therefore pure waste — and it is the single largest
 * cost in the whole extension, because it is the one call that needs a paid or
 * rate-limited endpoint.
 *
 * The invalidation signal is free. `positions(tokenId)` is already fetched on
 * every load, and `liquidity`, `feeGrowthInside{0,1}LastX128` and
 * `tokensOwed{0,1}` are written by every operation that emits an
 * IncreaseLiquidity, DecreaseLiquidity or Collect event — and by nothing else.
 * Fees accruing in the pool do not touch them. So a fingerprint over those five
 * fields changes exactly when new events exist, and the cache can be trusted
 * without a single extra request.
 *
 * Verified against a live 5% withdrawal on Robinhood position 718740: the
 * decrease and collect at block 39913466 moved liquidity and tokensOwed, which
 * is precisely what invalidates this.
 *
 * Deliberately NOT "cache closed positions forever, re-poll open ones". That
 * rule sounds equivalent and is worse: it re-fetches every open position on
 * every view, which is the common case.
 */

const PREFIX = 'hist:';
const ENUM_PREFIX = 'enum:';
const MAX_ENTRIES = 400;   // keeps chrome.storage.local well clear of its quota
const MAX_ENUM_ENTRIES = 200;

// Falls back to memory outside an extension context so the module stays usable
// in tests and in node.
const memory = new Map();
const store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
  ? chrome.storage.local
  : null;

/** BigInt does not survive structured clone or JSON, so amounts ride as strings. */
const pack = (events) => events.map((e) => ({
  k: e.kind,
  b: e.block,
  t: e.time,
  l: String(e.liquidity),
  a0: String(e.amount0),
  a1: String(e.amount1),
}));

const unpack = (rows) => rows.map((r) => ({
  kind: r.k,
  block: r.b,
  time: r.t,
  liquidity: BigInt(r.l),
  amount0: BigInt(r.a0),
  amount1: BigInt(r.a1),
}));

/**
 * Fingerprint of the mutable half of a position. Changes if and only if the
 * position was touched, which is exactly when its event history grows.
 */
export function fingerprint(p) {
  return [
    p.liquidity,
    p.feeGrowthInside0LastX128,
    p.feeGrowthInside1LastX128,
    p.tokensOwed0,
    p.tokensOwed1,
  ].map((v) => (v === undefined ? '?' : String(v))).join(':');
}

const keyFor = (nfpm, tokenId) => `${PREFIX}${String(nfpm).toLowerCase()}:${tokenId}`;

/** Cached events for this position, or null when absent or stale. */
export async function readHistory(nfpm, tokenId, fp) {
  const key = keyFor(nfpm, tokenId);
  try {
    const hit = store ? (await store.get(key))[key] : memory.get(key);
    if (!hit || hit.fp !== fp || !Array.isArray(hit.events)) return null;
    return { events: unpack(hit.events), source: hit.source, cached: true };
  } catch {
    return null;   // a broken cache must never break a load
  }
}

export async function writeHistory(nfpm, tokenId, fp, events, source) {
  // A minted position always has at least one IncreaseLiquidity. Caching
  // an empty set would stick a false "no activity" across sessions.
  if (!Array.isArray(events) || events.length === 0) return;
  const key = keyFor(nfpm, tokenId);
  const value = { fp, source, at: Date.now(), events: pack(events) };
  try {
    if (!store) {
      memory.set(key, value);
      return;
    }
    await store.set({ [key]: value });
    await prune();
  } catch {
    // Quota exceeded or storage unavailable: caching is an optimisation, so
    // failing to cache is not an error worth surfacing.
  }
}

/** Drop the oldest entries once the cache grows past MAX_ENTRIES. */
async function prune() {
  await prunePrefix(PREFIX, MAX_ENTRIES);
}

async function prunePrefix(prefix, max) {
  if (!store) return;
  const all = await store.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(prefix));
  if (keys.length <= max) return;
  keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
  await store.remove(keys.slice(0, keys.length - max));
}

/* ---------------------------------------------------------------------------
 * Enumeration cache: (owner, chain) -> complete tokenId list.
 *
 * This removes the tokenOfOwnerByIndex half of a v3 scan, not both halves.
 * positions(tokenId) still runs every load because liquidity, tokensOwed and
 * fee growth change constantly. The saving is roughly half of enumeration,
 * not all of it.
 *
 * Do NOT skip IDs previously seen as closed. A position with zero liquidity
 * and zero owed is not permanently dead — increaseLiquidity can be called on
 * any tokenId whose NFT has not been burned, so a "closed" position can come
 * back to life and would then be invisible until the cache happened to be
 * rebuilt.
 *
 * A partial list must never be stored as complete. The writer refuses any
 * entry whose tokenIds.length !== count. Truncated scans (count above the
 * MAX_POSITIONS cap) are the caller's problem: they simply must not call
 * writeEnum.
 * ------------------------------------------------------------------------- */

const enumKeyFor = (chainKey, owner) =>
  `${ENUM_PREFIX}${chainKey}:${String(owner).toLowerCase()}`;

/** Cached complete tokenId list for this owner on this chain, or null. */
export async function readEnum(chainKey, owner) {
  const key = enumKeyFor(chainKey, owner);
  try {
    const hit = store ? (await store.get(key))[key] : memory.get(key);
    if (!hit || !Array.isArray(hit.tokenIds) || hit.tokenIds.length !== hit.count) {
      return null;
    }
    return hit;
  } catch {
    return null;
  }
}

/**
 * Persist a complete enumeration. No-op when the list is empty, partial, or
 * storage is unavailable. tokenIds are decimal strings, newest first.
 */
export async function writeEnum(chainKey, owner, entry) {
  if (!entry || !Array.isArray(entry.tokenIds)) return;
  if (!entry.count || entry.tokenIds.length !== entry.count) return;
  if (entry.newest === undefined || entry.newest === null) return;
  const key = enumKeyFor(chainKey, owner);
  const value = {
    count: entry.count,
    newest: String(entry.newest),
    tokenIds: entry.tokenIds.map((id) => String(id)),
    at: Date.now(),
  };
  try {
    if (!store) {
      memory.set(key, value);
      return;
    }
    await store.set({ [key]: value });
    await prunePrefix(ENUM_PREFIX, MAX_ENUM_ENTRIES);
  } catch {
    // Caching is an optimisation; failing to cache is not a load error.
  }
}
