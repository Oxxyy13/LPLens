/**
 * Local operational index for the fast portfolio refresh.
 *
 * This is deliberately separate from dashboardSnapshotV1. The dashboard is
 * escaped display HTML and must never become position truth. This index stores
 * only wallet, chain, protocol and decimal token IDs proven by a full rescan.
 * A fast refresh still verifies ownership and re-reads all current position
 * state. It cannot discover a new or reopened NFT; that remains Full rescan's
 * job.
 */

export const CURRENT_POSITION_INDEX_PREFIX = 'current:v1:';
const VERSION = 1;
const MAX_IDS_PER_PROTOCOL = 5_000;
const MAX_SCOPES = 240;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const CHAIN_RE = /^[a-z0-9-]{1,32}$/;

const memory = new Map();
const store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
  ? chrome.storage.local
  : null;

function cleanOwner(value) {
  const owner = String(value || '').trim().toLowerCase();
  return ADDRESS_RE.test(owner) ? owner : null;
}

function cleanChainKey(value) {
  const chainKey = String(value || '').trim().toLowerCase();
  return CHAIN_RE.test(chainKey) ? chainKey : null;
}

function cleanTokenId(value) {
  try {
    const id = BigInt(value);
    return id >= 0n ? id.toString() : null;
  } catch {
    return null;
  }
}

export function normalizeCurrentPositionIds(values) {
  const ids = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const id = cleanTokenId(raw);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_IDS_PER_PROTOCOL) break;
  }
  return ids.sort((a, b) => {
    const left = BigInt(a), right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function cleanProtocol(raw) {
  if (!raw || typeof raw !== 'object') return { complete: false, ids: [] };
  return {
    complete: raw.complete === true,
    ids: normalizeCurrentPositionIds(raw.ids),
  };
}

function cleanScope(raw, owner, chainKey) {
  if (!raw || typeof raw !== 'object' || raw.version !== VERSION) return null;
  const storedOwner = cleanOwner(raw.owner);
  const storedChain = cleanChainKey(raw.chainKey);
  if (storedOwner !== owner || storedChain !== chainKey) return null;
  return {
    version: VERSION,
    owner,
    chainKey,
    fullScanAt: Number.isFinite(raw.fullScanAt) && raw.fullScanAt > 0
      ? raw.fullScanAt : null,
    refreshedAt: Number.isFinite(raw.refreshedAt) && raw.refreshedAt > 0
      ? raw.refreshedAt : null,
    v3: cleanProtocol(raw.v3),
    v4: cleanProtocol(raw.v4),
  };
}

function keyFor(owner, chainKey) {
  return `${CURRENT_POSITION_INDEX_PREFIX}${chainKey}:${owner}`;
}

async function readRaw(key) {
  if (!store) return memory.get(key);
  return (await store.get(key))[key];
}

async function writeRaw(key, value) {
  if (!store) {
    memory.set(key, value);
    return;
  }
  await store.set({ [key]: value });
}

export async function readCurrentPositionScope(ownerValue, chainValue) {
  const owner = cleanOwner(ownerValue);
  const chainKey = cleanChainKey(chainValue);
  if (!owner || !chainKey) return null;
  try {
    return cleanScope(await readRaw(keyFor(owner, chainKey)), owner, chainKey);
  } catch {
    return null;
  }
}

function mergeProtocol(previous, incoming) {
  const next = cleanProtocol(incoming);
  if (next.complete) return next;
  return {
    // Preserve every known ID, but fail closed for readiness. The latest Full
    // rescan did not prove this protocol exhaustive, even if an older scan did.
    complete: false,
    ids: normalizeCurrentPositionIds([...previous.ids, ...next.ids]),
  };
}

/**
 * Apply one full-discovery job. Complete protocol discovery replaces that
 * protocol's IDs, including a proven empty set. Partial discovery only merges
 * newly proven IDs, never deletes an earlier known position, and disables the
 * fast path until another complete Full rescan succeeds.
 */
export async function writeFullDiscoveryScope({
  owner: ownerValue, chainKey: chainValue, discovery, at = Date.now(),
}) {
  const owner = cleanOwner(ownerValue);
  const chainKey = cleanChainKey(chainValue);
  if (!owner || !chainKey || !discovery || typeof discovery !== 'object') return false;
  const previous = await readCurrentPositionScope(owner, chainKey) || {
    version: VERSION,
    owner,
    chainKey,
    fullScanAt: null,
    refreshedAt: null,
    v3: { complete: false, ids: [] },
    v4: { complete: false, ids: [] },
  };
  const value = {
    ...previous,
    fullScanAt: Number.isFinite(at) && at > 0 ? at : Date.now(),
    v3: mergeProtocol(previous.v3, discovery.v3),
    v4: mergeProtocol(previous.v4, discovery.v4),
  };
  try {
    await writeRaw(keyFor(owner, chainKey), value);
    await pruneScopes();
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace the open-ID subset after a fast refresh. Callers preserve unreadable
 * IDs in these arrays; only a proven transfer or proven close may remove one.
 */
export async function writeCurrentRefreshScope({
  owner: ownerValue, chainKey: chainValue, ids, at = Date.now(),
}) {
  const owner = cleanOwner(ownerValue);
  const chainKey = cleanChainKey(chainValue);
  if (!owner || !chainKey || !ids || typeof ids !== 'object') return false;
  const previous = await readCurrentPositionScope(owner, chainKey);
  if (!previous) return false;
  const value = {
    ...previous,
    refreshedAt: Number.isFinite(at) && at > 0 ? at : Date.now(),
    v3: { ...previous.v3, ids: normalizeCurrentPositionIds(ids.v3 ?? previous.v3.ids) },
    v4: { ...previous.v4, ids: normalizeCurrentPositionIds(ids.v4 ?? previous.v4.ids) },
  };
  try {
    await writeRaw(keyFor(owner, chainKey), value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep remembered IDs after a failed Full rescan, but require another complete
 * discovery before the fast path can run again.
 */
export async function markCurrentPositionScopeIncomplete({
  owner: ownerValue, chainKey: chainValue,
}) {
  const owner = cleanOwner(ownerValue);
  const chainKey = cleanChainKey(chainValue);
  if (!owner || !chainKey) return false;
  const previous = await readCurrentPositionScope(owner, chainKey);
  if (!previous) return false;
  const value = {
    ...previous,
    v3: { ...previous.v3, complete: false },
    v4: { ...previous.v4, complete: false },
  };
  try {
    await writeRaw(keyFor(owner, chainKey), value);
    return true;
  } catch {
    return false;
  }
}

/** Read every requested wallet x chain scope without inventing empty rows. */
export async function readCurrentPositionJobs(owners, chainKeys) {
  const jobs = [];
  const seen = new Set();
  for (const rawOwner of owners || []) {
    const owner = cleanOwner(typeof rawOwner === 'string' ? rawOwner : rawOwner?.address);
    if (!owner || seen.has(owner)) continue;
    seen.add(owner);
    for (const rawChain of chainKeys || []) {
      const chainKey = cleanChainKey(rawChain);
      if (!chainKey) continue;
      const scope = await readCurrentPositionScope(owner, chainKey);
      jobs.push({
        owner,
        chainKey,
        scope,
        ready: !!(scope && scope.v3.complete && scope.v4.complete),
      });
    }
  }
  return jobs;
}

async function pruneScopes() {
  if (!store) {
    if (memory.size <= MAX_SCOPES) return;
    const rows = [...memory.entries()]
      .filter(([key]) => key.startsWith(CURRENT_POSITION_INDEX_PREFIX))
      .sort((a, b) => ((a[1].fullScanAt || 0) - (b[1].fullScanAt || 0)));
    for (const [key] of rows.slice(0, Math.max(0, rows.length - MAX_SCOPES))) {
      memory.delete(key);
    }
    return;
  }
  const all = await store.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(CURRENT_POSITION_INDEX_PREFIX));
  if (keys.length <= MAX_SCOPES) return;
  keys.sort((a, b) => ((all[a]?.fullScanAt || 0) - (all[b]?.fullScanAt || 0)));
  await store.remove(keys.slice(0, keys.length - MAX_SCOPES));
}
