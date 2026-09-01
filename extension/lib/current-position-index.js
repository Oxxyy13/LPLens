/**
 * Local operational index for the fast portfolio refresh.
 *
 * This is deliberately separate from dashboardSnapshotV1. The dashboard is
 * escaped display HTML and must never become position truth. This index stores
 * only wallet, chain, deployment and decimal token IDs proven by a full
 * rescan. A fast refresh still verifies custody and re-reads all current
 * position state. It cannot discover a new or reopened NFT; that remains Full
 * rescan's job.
 */

import { v3Deployment, v3DeploymentsFor } from './chains.js';

export const CURRENT_POSITION_INDEX_PREFIX = 'current:v1:';
export const CURRENT_POSITION_INDEX_VERSION = 2;
const LEGACY_VERSION = 1;
const VERSION = CURRENT_POSITION_INDEX_VERSION;
const MAX_IDS_PER_PROTOCOL = 5_000;
const MAX_SCOPES = 240;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const CHAIN_RE = /^[a-z0-9-]{1,32}$/;
const DEPLOYMENT_RE = /^[a-z0-9-]{1,64}$/;

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

function cleanAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  return ADDRESS_RE.test(address) ? address : null;
}

function cleanDeploymentId(value) {
  const deploymentId = String(value || '').trim().toLowerCase();
  return DEPLOYMENT_RE.test(deploymentId) ? deploymentId : null;
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

function configuredDeployment(chainKey, deploymentId, manager) {
  const cleanManager = cleanAddress(manager);
  const cleanId = cleanDeploymentId(deploymentId);
  if (cleanId) {
    const deployment = v3Deployment(chainKey, cleanId);
    if (!deployment || (cleanManager && cleanAddress(deployment.nfpm) !== cleanManager)) return null;
    return deployment;
  }
  if (cleanManager) {
    return v3DeploymentsFor(chainKey).find((deployment) => (
      cleanAddress(deployment.nfpm) === cleanManager
    )) || null;
  }
  return v3Deployment(chainKey);
}

function cleanV3Record(raw, chainKey) {
  const source = raw && typeof raw === 'object' ? raw : { tokenId: raw };
  const tokenId = cleanTokenId(source.tokenId ?? source.id);
  if (source.deploymentId !== undefined && !cleanDeploymentId(source.deploymentId)) return null;
  if (source.manager !== undefined && !cleanAddress(source.manager)) return null;
  if (source.custodian !== undefined && source.custodian !== null
      && !cleanAddress(source.custodian)) return null;
  const deployment = configuredDeployment(chainKey, source.deploymentId, source.manager);
  const manager = cleanAddress(deployment?.nfpm);
  const deploymentId = cleanDeploymentId(deployment?.id);
  const custody = source.custody === undefined
    ? 'wallet' : String(source.custody || '').trim().toLowerCase();
  const custodian = source.custodian === undefined || source.custodian === null
    ? null : cleanAddress(source.custodian);
  if (tokenId === null || !deploymentId || !manager || !['wallet', 'gauge'].includes(custody)) {
    return null;
  }
  // A gauge-held NFT cannot be proven from a wallet ownerOf check. Preserve it
  // only when the exact custody contract was discovered too.
  if (custody === 'gauge' && !custodian) return null;
  return {
    tokenId,
    deploymentId,
    manager,
    custody,
    ...(custodian ? { custodian } : {}),
  };
}

function v3RecordKey(record) {
  return [
    record.deploymentId,
    record.manager,
    record.custody,
    record.custodian || '',
    record.tokenId,
  ].join(':');
}

function v3NftKey(record) {
  return `${record.manager}:${record.tokenId}`;
}

function normalizeCurrentV3RecordSet(values, chainValue) {
  const chainKey = cleanChainKey(chainValue);
  if (!chainKey) return { records: [], rejected: true };
  const byNft = new Map();
  const conflicted = new Set();
  let rejected = false;
  for (const raw of Array.isArray(values) ? values : []) {
    const record = cleanV3Record(raw, chainKey);
    if (!record) { rejected = true; continue; }
    const nftKey = v3NftKey(record);
    if (conflicted.has(nftKey)) continue;
    const previous = byNft.get(nftKey);
    if (previous && v3RecordKey(previous) !== v3RecordKey(record)) {
      byNft.delete(nftKey);
      conflicted.add(nftKey);
      rejected = true;
      continue;
    }
    if (!previous) byNft.set(nftKey, record);
  }
  const records = [...byNft.values()].sort((a, b) => (
    a.deploymentId.localeCompare(b.deploymentId)
      || a.manager.localeCompare(b.manager)
      || (BigInt(a.tokenId) < BigInt(b.tokenId) ? -1 : BigInt(a.tokenId) > BigInt(b.tokenId) ? 1 : 0)
      || a.custody.localeCompare(b.custody)
      || String(a.custodian || '').localeCompare(String(b.custodian || ''))
  ));
  if (records.length > MAX_IDS_PER_PROTOCOL) rejected = true;
  return { records: records.slice(0, MAX_IDS_PER_PROTOCOL), rejected };
}

export function normalizeCurrentV3Records(values, chainValue) {
  return normalizeCurrentV3RecordSet(values, chainValue).records;
}

function legacyV3Ids(records, chainKey) {
  const deployment = v3Deployment(chainKey);
  const manager = cleanAddress(deployment?.nfpm);
  const deploymentId = cleanDeploymentId(deployment?.id);
  return normalizeCurrentPositionIds((records || []).filter((record) => (
    record.deploymentId === deploymentId && record.manager === manager
      && record.custody === 'wallet'
  )).map((record) => record.tokenId));
}

function isLegacyDefaultRecord(record, chainKey) {
  const deployment = v3Deployment(chainKey);
  return record.deploymentId === cleanDeploymentId(deployment?.id)
    && record.manager === cleanAddress(deployment?.nfpm) && record.custody === 'wallet';
}

function cleanV3Protocol(raw, chainKey) {
  if (!raw || typeof raw !== 'object') {
    return { complete: false, records: [], ids: [] };
  }
  const values = Array.isArray(raw.records) ? raw.records : raw.ids;
  const { records, rejected } = normalizeCurrentV3RecordSet(values, chainKey);
  return {
    complete: raw.complete === true && !rejected,
    records,
    // Compatibility for the shipped popup/current scanner. It receives only
    // default-manager, wallet-custodied IDs and therefore cannot accidentally
    // query an UP33 token ID against the Uniswap manager.
    ids: legacyV3Ids(records, chainKey),
  };
}

function cleanProtocol(raw) {
  if (!raw || typeof raw !== 'object') return { complete: false, ids: [] };
  return {
    complete: raw.complete === true,
    ids: normalizeCurrentPositionIds(raw.ids),
  };
}

function cleanScope(raw, owner, chainKey) {
  if (!raw || typeof raw !== 'object'
      || ![LEGACY_VERSION, VERSION].includes(raw.version)) return null;
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
    // v1 stored only IDs. They can safely mean only the chain's historical
    // default manager and direct wallet custody. No alternate deployment or
    // gauge ownership is inferred during migration.
    v3: cleanV3Protocol(raw.v3, chainKey),
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

function mergeV3Protocol(previous, incoming, chainKey) {
  const next = cleanV3Protocol(incoming, chainKey);
  if (next.complete) return next;
  const byNft = new Map((previous.records || []).map((record) => [v3NftKey(record), record]));
  for (const record of next.records) byNft.set(v3NftKey(record), record);
  const records = normalizeCurrentV3Records([...byNft.values()], chainKey);
  return {
    complete: false,
    records,
    ids: legacyV3Ids(records, chainKey),
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
    v3: { complete: false, records: [], ids: [] },
    v4: { complete: false, ids: [] },
  };
  const value = {
    ...previous,
    fullScanAt: Number.isFinite(at) && at > 0 ? at : Date.now(),
    v3: mergeV3Protocol(previous.v3, discovery.v3, chainKey),
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
  const hasExplicitRecords = Object.hasOwn(ids, 'v3Records')
    || (ids.v3 && typeof ids.v3 === 'object' && !Array.isArray(ids.v3));
  const incomingV3 = Object.hasOwn(ids, 'v3Records') ? ids.v3Records : ids.v3;
  let nextV3 = previous.v3;
  if (incomingV3 !== undefined && hasExplicitRecords) {
    nextV3 = cleanV3Protocol({
      complete: previous.v3.complete,
      ...(Array.isArray(incomingV3) ? { records: incomingV3 } : incomingV3),
    }, chainKey);
  } else if (Array.isArray(incomingV3)) {
    // The shipped v1 current scanner knows only the historical default
    // manager. Replace that subset but retain alternate-manager and gauge
    // records it cannot verify or disprove.
    const legacy = cleanV3Protocol({ complete: previous.v3.complete, ids: incomingV3 }, chainKey);
    const records = normalizeCurrentV3Records([
      ...previous.v3.records.filter((record) => !isLegacyDefaultRecord(record, chainKey)),
      ...legacy.records,
    ], chainKey);
    nextV3 = {
      complete: legacy.complete,
      records,
      ids: legacyV3Ids(records, chainKey),
    };
  }
  const value = {
    ...previous,
    refreshedAt: Number.isFinite(at) && at > 0 ? at : Date.now(),
    v3: nextV3,
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
