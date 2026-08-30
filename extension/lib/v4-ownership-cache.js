/**
 * Exact, block-anchored v4 ownership checkpoints.
 *
 * A row is eligible only when its token IDs were proven against balanceOf and
 * ownerOf at one captured block. Reuse always validates that block hash and
 * repeats the on-chain proof. A stale or malformed row is only a cache miss.
 */

export const V4_OWNERSHIP_PREFIX = 'v4own:v1:';
const VERSION = 1;
const MAX_IDS = 5_000;
const MAX_ENTRIES = 240;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const CHAIN_RE = /^[a-z0-9-]{1,32}$/;

const memory = new Map();
const store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
  ? chrome.storage.local
  : null;

const cleanAddress = (value) => {
  const address = String(value || '').trim().toLowerCase();
  return ADDRESS_RE.test(address) ? address : null;
};

const cleanChain = (value) => {
  const chain = String(value || '').trim().toLowerCase();
  return CHAIN_RE.test(chain) ? chain : null;
};

function canonicalIds(values, { rejectMalformed = false } = {}) {
  if (!Array.isArray(values) || values.length > MAX_IDS) return null;
  const ids = [];
  const seen = new Set();
  for (const raw of values) {
    let id;
    try {
      const parsed = BigInt(raw);
      if (parsed < 0n) throw new Error('negative');
      id = parsed.toString();
    } catch {
      if (rejectMalformed) return null;
      continue;
    }
    if (seen.has(id)) {
      if (rejectMalformed) return null;
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  ids.sort((a, b) => {
    const left = BigInt(a), right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  if (rejectMalformed && ids.some((id, index) => String(values[index]) !== id)) return null;
  return ids;
}

function keyFor(chainKey, manager, owner) {
  return `${V4_OWNERSHIP_PREFIX}${chainKey}:${manager}:${owner}`;
}

export async function readV4OwnershipCheckpoint({
  chainKey: chainValue, manager: managerValue, owner: ownerValue,
}) {
  const chainKey = cleanChain(chainValue);
  const manager = cleanAddress(managerValue);
  const owner = cleanAddress(ownerValue);
  if (!chainKey || !manager || !owner) return null;
  const key = keyFor(chainKey, manager, owner);
  try {
    const raw = store ? (await store.get(key))[key] : memory.get(key);
    if (!raw || raw.v !== VERSION
        || cleanChain(raw.chainKey) !== chainKey
        || cleanAddress(raw.manager) !== manager
        || cleanAddress(raw.owner) !== owner
        || !Number.isSafeInteger(raw.checkedThrough)
        || raw.checkedThrough < 0
        || !HASH_RE.test(String(raw.checkpointHash || '').toLowerCase())
        || !Number.isSafeInteger(raw.balanceOf)
        || raw.balanceOf < 0) return null;
    const ids = canonicalIds(raw.tokenIds, { rejectMalformed: true });
    if (!ids || ids.length !== raw.balanceOf) return null;
    return {
      chainKey,
      manager,
      owner,
      checkedThrough: raw.checkedThrough,
      checkpointHash: String(raw.checkpointHash).toLowerCase(),
      balanceOf: raw.balanceOf,
      tokenIds: ids.map(BigInt),
      source: typeof raw.source === 'string' ? raw.source.slice(0, 80) : 'checkpoint',
      at: Number.isFinite(raw.at) && raw.at > 0 ? raw.at : null,
    };
  } catch {
    return null;
  }
}

export async function writeV4OwnershipCheckpoint({
  chainKey: chainValue,
  manager: managerValue,
  owner: ownerValue,
  checkedThrough,
  checkpointHash,
  balanceOf,
  tokenIds,
  source,
  at = Date.now(),
}) {
  const chainKey = cleanChain(chainValue);
  const manager = cleanAddress(managerValue);
  const owner = cleanAddress(ownerValue);
  const hash = String(checkpointHash || '').toLowerCase();
  const ids = canonicalIds(tokenIds);
  if (!chainKey || !manager || !owner
      || !Number.isSafeInteger(checkedThrough) || checkedThrough < 0
      || !HASH_RE.test(hash)
      || !Number.isSafeInteger(balanceOf) || balanceOf < 0
      || !ids || ids.length !== balanceOf) return false;
  const key = keyFor(chainKey, manager, owner);
  const value = {
    v: VERSION,
    chainKey,
    manager,
    owner,
    checkedThrough,
    checkpointHash: hash,
    balanceOf,
    tokenIds: ids,
    source: String(source || 'ownerOf').slice(0, 80),
    at: Number.isFinite(at) && at > 0 ? at : Date.now(),
  };
  try {
    if (store) await store.set({ [key]: value });
    else memory.set(key, value);
    await prune();
    return true;
  } catch {
    return false;
  }
}

async function prune() {
  if (!store) {
    const rows = [...memory.entries()]
      .filter(([key]) => key.startsWith(V4_OWNERSHIP_PREFIX));
    if (rows.length <= MAX_ENTRIES) return;
    rows.sort((a, b) => ((a[1].at || 0) - (b[1].at || 0)));
    for (const [key] of rows.slice(0, rows.length - MAX_ENTRIES)) memory.delete(key);
    return;
  }
  const all = await store.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(V4_OWNERSHIP_PREFIX));
  if (keys.length <= MAX_ENTRIES) return;
  keys.sort((a, b) => ((all[a]?.at || 0) - (all[b]?.at || 0)));
  await store.remove(keys.slice(0, keys.length - MAX_ENTRIES));
}
