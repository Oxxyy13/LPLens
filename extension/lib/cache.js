/**
 * Persistent v3 history cache.
 *
 * A cached lifetime is only a canonical prefix, never proof that no later
 * events exist. Every deliberate position refresh verifies the stored anchor
 * block and replaces the tail after that anchor. This catches Collect-only and
 * offsetting Increase/Decrease sequences even when positions() finishes with
 * the same mutable values it had before the transactions.
 */

const PREFIX = 'hist:v2:';
const LEGACY_PREFIX = 'hist:';
const MAX_ENTRIES = 400;

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
  x: e.transactionHash || null,
  i: e.logIndex ?? null,
  l: String(e.liquidity),
  a0: String(e.amount0),
  a1: String(e.amount1),
}));

const unpack = (rows) => rows.map((r) => ({
  kind: r.k,
  block: r.b,
  time: r.t,
  transactionHash: r.x || null,
  logIndex: r.i ?? null,
  liquidity: BigInt(r.l),
  amount0: BigInt(r.a0),
  amount1: BigInt(r.a1),
}));

/**
 * Cheap mutable-state signal. It can reveal a change, but equality is not
 * treated as proof because multiple events can restore all five values.
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

/** Static NFT identity that prevents a recycled or misrouted row being used. */
export function historyIdentity(p) {
  const token0 = String(p.token0 || '').toLowerCase();
  const token1 = String(p.token1 || '').toLowerCase();
  const fee = Number(p.fee);
  const tickLower = Number(p.tickLower);
  const tickUpper = Number(p.tickUpper);
  if (!/^0x[0-9a-f]{40}$/.test(token0) || !/^0x[0-9a-f]{40}$/.test(token1)
      || !Number.isInteger(fee) || fee < 0
      || !Number.isInteger(tickLower) || !Number.isInteger(tickUpper)
      || tickLower >= tickUpper) return null;
  return [
    token0, token1, String(fee), String(tickLower), String(tickUpper),
  ].join(':');
}

const keyFor = (chainKey, nfpm, tokenId) => (
  `${PREFIX}${String(chainKey).toLowerCase()}:${String(nfpm).toLowerCase()}:${tokenId}`
);
const legacyKeyFor = (nfpm, tokenId) => (
  `${LEGACY_PREFIX}${String(nfpm).toLowerCase()}:${tokenId}`
);

/**
 * Last trusted canonical prefix for this exact chain and NFT identity.
 * Version-1 unnamespaced rows are deliberately ignored.
 */
export async function readHistoryAny(chainKey, nfpm, tokenId, identity) {
  const key = keyFor(chainKey, nfpm, tokenId);
  try {
    const hit = store ? (await store.get(key))[key] : memory.get(key);
    if (!identity || !hit || hit.v !== 2 || hit.identity !== identity
        || !Array.isArray(hit.events)
        || !Number.isSafeInteger(hit.checkedThrough)
        || !Number.isSafeInteger(hit.anchorBlock)
        || hit.checkedThrough < 0
        || hit.anchorBlock < 0
        || !/^0x[0-9a-f]{64}$/i.test(String(hit.anchorHash || ''))
        || hit.anchorBlock > hit.checkedThrough
        || hit.events.some((event) => !Number.isSafeInteger(event.b)
          || event.b < 0 || event.b > hit.checkedThrough)) return null;
    return {
      events: unpack(hit.events),
      source: hit.source,
      fingerprint: hit.fp,
      checkedThrough: hit.checkedThrough,
      anchorBlock: hit.anchorBlock,
      anchorHash: String(hit.anchorHash).toLowerCase(),
      cached: true,
    };
  } catch {
    return null;
  }
}

export async function writeHistory({
  chainKey, nfpm, tokenId, identity, fp, events, source,
  checkedThrough, anchorBlock, anchorHash,
}) {
  // A minted position always has at least one IncreaseLiquidity. Caching an
  // empty or partial result could make a transient provider failure persistent.
  if (!Array.isArray(events) || events.length === 0
      || !Number.isSafeInteger(checkedThrough)
      || !Number.isSafeInteger(anchorBlock)
      || checkedThrough < 0
      || anchorBlock < 0
      || anchorBlock > checkedThrough
      || events.some((event) => !Number.isSafeInteger(event.block)
        || event.block < 0 || event.block > checkedThrough)
      || !/^0x[0-9a-f]{64}$/i.test(String(anchorHash || ''))
      || !identity) return;

  const key = keyFor(chainKey, nfpm, tokenId);
  const value = {
    v: 2,
    identity,
    fp,
    source,
    at: Date.now(),
    checkedThrough,
    anchorBlock,
    anchorHash: String(anchorHash).toLowerCase(),
    events: pack(events),
  };
  try {
    if (!store) {
      memory.set(key, value);
      memory.delete(legacyKeyFor(nfpm, tokenId));
      return;
    }
    await store.set({ [key]: value });
    // Delete only this position's obsolete v1 row after its v2 replacement is
    // safely stored. Other v1 rows remain ignored until individually replaced.
    await store.remove(legacyKeyFor(nfpm, tokenId));
    await prunePrefix(PREFIX, MAX_ENTRIES);
  } catch {
    // Caching is an optimisation. Storage failures must not break a position.
  }
}

/** Drop the oldest v2 entries once the cache grows past MAX_ENTRIES. */
async function prunePrefix(prefix, max) {
  if (!store) return;
  const all = await store.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(prefix));
  if (keys.length <= max) return;
  keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
  await store.remove(keys.slice(0, keys.length - max));
}
