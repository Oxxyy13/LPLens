/**
 * Consecutive accepted-refresh observations for the portfolio side panel.
 *
 * These samples are local display context, never accounting input. They are
 * deliberately separate from dashboardSnapshotV1, which contains escaped HTML,
 * and from the history cache, which is the canonical source for lifetime cash
 * flows. A missing or malformed sample simply means there is no comparison.
 */

import { CHAINS } from './chains.js';

export const REFRESH_DELTA_PREFIX = 'delta:v1:';
export const REFRESH_DELTA_SCHEMA = 1;
export const REFRESH_METRICS_VERSION = 1;
export const MAX_REFRESH_SAMPLES = 2_000;

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const CHAIN_RE = /^[a-z0-9-]{1,32}$/;
const memory = new Map();
const store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
  ? chrome.storage.local
  : null;

const finite = (value) => Number.isFinite(value) ? Number(value) : null;
const nonNegative = (value) => Number.isFinite(value) && value >= 0 ? Number(value) : null;
const cleanAddress = (value) => {
  const address = String(value || '').trim().toLowerCase();
  return ADDRESS_RE.test(address) ? address : null;
};
const cleanTokenId = (value) => {
  try {
    const tokenId = BigInt(value);
    return tokenId >= 0n ? tokenId.toString() : null;
  } catch {
    return null;
  }
};
const cleanInteger = (value) => Number.isInteger(Number(value)) ? Number(value) : null;

/**
 * Only a final side-panel view may become the next visible comparison point.
 * Popup scans can update the saved portfolio, but they must not silently move
 * a baseline whose comparison UI exists only in the side panel.
 */
export function shouldAdvanceRefreshSamples({
  sidePanel = false,
  allFailed = true,
  preservedCurrentView = true,
  progressivePaint = false,
  localMutation = false,
} = {}) {
  return sidePanel === true && allFailed === false && preservedCurrentView === false
    && progressivePaint === false && localMutation === false;
}

function managerFor(position) {
  const chainKey = String(position?.chainKey || '').trim().toLowerCase();
  const version = String(position?.version || position?.protocol || 'v3').trim().toLowerCase();
  const chain = CHAINS[chainKey];
  const manager = version === 'v4' ? chain?.v4PositionManager : chain?.nfpm;
  return cleanAddress(manager);
}

/** A manager-scoped identity. Token IDs are not unique across chains or versions. */
export function positionRefreshKey(position) {
  const owner = cleanAddress(position?.ownerAddress || position?.owner || position?.address);
  const chainKey = String(position?.chainKey || '').trim().toLowerCase();
  const version = String(position?.version || position?.protocol || 'v3').trim().toLowerCase();
  const manager = managerFor(position);
  const tokenId = cleanTokenId(position?.tokenId);
  if (!owner || !CHAIN_RE.test(chainKey) || !/^(?:v3|v4)$/.test(version)
      || !manager || tokenId === null) return null;
  return `${REFRESH_DELTA_PREFIX}${chainKey}:${manager}:${owner}:${version}:${tokenId}`;
}

/** Immutable position identity. Any mismatch starts a new baseline. */
export function positionRefreshIdentity(position) {
  const version = String(position?.version || position?.protocol || 'v3').trim().toLowerCase();
  const pool = version === 'v4'
    ? String(position?.poolId || '').trim().toLowerCase()
    : cleanAddress(position?.pool);
  const token0 = cleanAddress(position?.token0);
  const token1 = cleanAddress(position?.token1);
  const fee = cleanInteger(position?.fee);
  const tickLower = cleanInteger(position?.tickLower);
  const tickUpper = cleanInteger(position?.tickUpper);
  const validPool = version === 'v4' ? HASH_RE.test(pool) : !!pool;
  if (!validPool || !token0 || !token1 || fee === null || fee < 0
      || tickLower === null || tickUpper === null || tickLower >= tickUpper) return null;
  return [version, pool, token0, token1, fee, tickLower, tickUpper].join(':');
}

function exactReturn(position) {
  const history = position?.history || {};
  const usd = position?.usd || null;
  return !!(usd && !history.unavailable && !usd.returnUnavailable
    && usd.grossAddedExact === true && usd.collectedProceedsExact === true);
}

/** JSON-safe sample of the metrics shown in one accepted view. */
export function captureRefreshSample(position, at = Date.now()) {
  const key = positionRefreshKey(position);
  const identity = positionRefreshIdentity(position);
  if (!key || !identity || !Number.isFinite(at) || at <= 0) return null;
  const history = position.history || {};
  const usd = position.usd || null;
  const returnExact = exactReturn(position);
  const historyUsable = !history.unavailable && history.currentUnavailable !== true;
  return {
    schema: REFRESH_DELTA_SCHEMA,
    metricsVersion: REFRESH_METRICS_VERSION,
    key,
    at: Number(at),
    identity,
    status: ['in-range', 'below', 'above', 'closed'].includes(position.status)
      ? position.status : null,
    currentValueUsd: nonNegative(usd?.currentValue ?? usd?.totalNow),
    lpReturnUsd: returnExact ? finite(usd?.pnl) : null,
    vsHoldingUsd: historyUsable ? finite(usd?.vsHodl) : null,
    fees0: historyUsable ? nonNegative(history.fees0) : null,
    fees1: historyUsable ? nonNegative(history.fees1) : null,
    price0Usd: nonNegative(usd?.price0),
    price1Usd: nonNegative(usd?.price1),
    adds: Number.isInteger(history.adds) && history.adds >= 0 ? history.adds : null,
    collections: Array.isArray(history.collections) ? history.collections.length : null,
    grossAddedUsd: returnExact ? nonNegative(usd?.grossAdded) : null,
    collectedProceedsUsd: returnExact ? nonNegative(usd?.collectedProceeds) : null,
  };
}

function cleanSample(raw, expectedKey = null) {
  if (!raw || typeof raw !== 'object' || raw.schema !== REFRESH_DELTA_SCHEMA
      || raw.metricsVersion !== REFRESH_METRICS_VERSION
      || typeof raw.key !== 'string' || !raw.key.startsWith(REFRESH_DELTA_PREFIX)
      || (expectedKey && raw.key !== expectedKey)
      || !Number.isFinite(raw.at) || raw.at <= 0
      || typeof raw.identity !== 'string' || raw.identity.length > 500) return null;
  const status = raw.status === null || ['in-range', 'below', 'above', 'closed'].includes(raw.status)
    ? raw.status : null;
  const nullable = (value, allowNegative = false) => {
    if (value === null) return null;
    if (!Number.isFinite(value) || (!allowNegative && value < 0)) return undefined;
    return Number(value);
  };
  const value = {
    schema: REFRESH_DELTA_SCHEMA,
    metricsVersion: REFRESH_METRICS_VERSION,
    key: raw.key,
    at: Number(raw.at),
    identity: raw.identity,
    status,
    currentValueUsd: nullable(raw.currentValueUsd),
    lpReturnUsd: nullable(raw.lpReturnUsd, true),
    vsHoldingUsd: nullable(raw.vsHoldingUsd, true),
    fees0: nullable(raw.fees0),
    fees1: nullable(raw.fees1),
    price0Usd: nullable(raw.price0Usd),
    price1Usd: nullable(raw.price1Usd),
    adds: raw.adds === null ? null : cleanInteger(raw.adds),
    collections: raw.collections === null ? null : cleanInteger(raw.collections),
    grossAddedUsd: nullable(raw.grossAddedUsd),
    collectedProceedsUsd: nullable(raw.collectedProceedsUsd),
  };
  if (Object.values(value).some((entry) => entry === undefined)
      || (value.adds !== null && value.adds < 0)
      || (value.collections !== null && value.collections < 0)) return null;
  return value;
}

const difference = (current, previous) => (
  Number.isFinite(current) && Number.isFinite(previous) ? current - previous : null
);

function feeValue(delta, price) {
  if (!Number.isFinite(delta)) return { value: null, valid: false };
  if (Math.abs(delta) < 1e-12) return { value: 0, valid: true };
  if (!Number.isFinite(price)) return { value: null, valid: false };
  return { value: delta * price, valid: true };
}

/** Compare two consecutive accepted samples without filling any missing value. */
export function compareRefreshSamples(previousRaw, currentRaw) {
  const previous = cleanSample(previousRaw);
  const current = cleanSample(currentRaw);
  if (!previous || !current || previous.key !== current.key
      || previous.identity !== current.identity || current.at <= previous.at) return null;
  const fees0Delta = difference(current.fees0, previous.fees0);
  const fees1Delta = difference(current.fees1, previous.fees1);
  const feeRevision = (Number.isFinite(fees0Delta) && fees0Delta < -1e-10)
    || (Number.isFinite(fees1Delta) && fees1Delta < -1e-10);
  const leg0 = feeValue(fees0Delta, current.price0Usd);
  const leg1 = feeValue(fees1Delta, current.price1Usd);
  const feesGainedUsd = !feeRevision && leg0.valid && leg1.valid
    ? leg0.value + leg1.value : null;
  const additionsChanged = previous.adds !== null && current.adds !== null
    && previous.adds !== current.adds;
  const collectionsChanged = previous.collections !== null && current.collections !== null
    && previous.collections !== current.collections;
  const cashFlowChanged = additionsChanged || collectionsChanged
    || (Number.isFinite(previous.grossAddedUsd) && Number.isFinite(current.grossAddedUsd)
      && Math.abs(previous.grossAddedUsd - current.grossAddedUsd) > 0.005)
    || (Number.isFinite(previous.collectedProceedsUsd)
      && Number.isFinite(current.collectedProceedsUsd)
      && Math.abs(previous.collectedProceedsUsd - current.collectedProceedsUsd) > 0.005);
  return {
    fromAt: previous.at,
    toAt: current.at,
    elapsedMs: current.at - previous.at,
    positionValueUsd: difference(current.currentValueUsd, previous.currentValueUsd),
    lpReturnUsd: difference(current.lpReturnUsd, previous.lpReturnUsd),
    vsHoldingUsd: difference(current.vsHoldingUsd, previous.vsHoldingUsd),
    feesGainedUsd,
    fees0Delta: feeRevision ? null : fees0Delta,
    fees1Delta: feeRevision ? null : fees1Delta,
    feesRevised: feeRevision,
    fromStatus: previous.status,
    toStatus: current.status,
    statusChanged: !!(previous.status && current.status && previous.status !== current.status),
    cashFlowChanged,
    additionsChanged,
    collectionsChanged,
  };
}

export async function readRefreshSamples(positions) {
  const keys = [...new Set((positions || []).map(positionRefreshKey).filter(Boolean))];
  const out = new Map();
  try {
    if (!store) {
      for (const key of keys) {
        const sample = cleanSample(memory.get(key), key);
        if (sample) out.set(key, sample);
      }
      return out;
    }
    const rows = keys.length ? await store.get(keys) : {};
    for (const key of keys) {
      const sample = cleanSample(rows[key], key);
      if (sample) out.set(key, sample);
    }
  } catch { /* a comparison cache failure is non-fatal */ }
  return out;
}

/** Attach ephemeral display deltas. The position arithmetic is never changed. */
export function attachRefreshDeltas(positions, previousByKey, at = Date.now()) {
  return (positions || []).map((position) => {
    const current = captureRefreshSample(position, at);
    if (!current) return position;
    const previous = previousByKey instanceof Map ? previousByKey.get(current.key) : null;
    const delta = previous ? compareRefreshSamples(previous, current) : null;
    return {
      ...position,
      refreshDelta: delta || { baseline: true, fromAt: null, toAt: current.at },
    };
  });
}

async function pruneSamples() {
  if (!store) {
    if (memory.size <= MAX_REFRESH_SAMPLES) return;
    const rows = [...memory.entries()].sort((a, b) => (a[1]?.at || 0) - (b[1]?.at || 0));
    for (const [key] of rows.slice(0, rows.length - MAX_REFRESH_SAMPLES)) memory.delete(key);
    return;
  }
  const all = await store.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(REFRESH_DELTA_PREFIX));
  if (keys.length <= MAX_REFRESH_SAMPLES) return;
  keys.sort((a, b) => ((all[a]?.at || 0) - (all[b]?.at || 0)));
  await store.remove(keys.slice(0, keys.length - MAX_REFRESH_SAMPLES));
}

/** Commit only positions from an accepted view as the next comparison baseline. */
export async function writeRefreshSamples(positions, at = Date.now()) {
  const values = {};
  for (const position of positions || []) {
    const sample = captureRefreshSample(position, at);
    if (sample) values[sample.key] = sample;
  }
  const entries = Object.entries(values);
  if (!entries.length) return 0;
  try {
    if (store) await store.set(values);
    else for (const [key, value] of entries) memory.set(key, value);
    await pruneSamples();
    return entries.length;
  } catch {
    return 0;
  }
}
