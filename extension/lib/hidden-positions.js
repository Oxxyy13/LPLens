/**
 * Locally hidden position NFTs.
 *
 * Unsolicited LP NFTs cannot be identified safely from token names or missing
 * history alone. Hiding is therefore an explicit, reversible local choice.
 * Nothing is transferred, burned, or written to the wallet.
 */

import { CHAINS } from './chains.js';

export const HIDDEN_POSITIONS_KEY = 'hiddenPositionsV1';
export const MAX_HIDDEN_POSITIONS = 500;

const memory = { [HIDDEN_POSITIONS_KEY]: [] };
const store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
  ? chrome.storage.local
  : null;

const cleanPart = (value) => String(value || '').trim().toLowerCase();
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const LEGACY_KEY_RE = /^(0x[0-9a-f]{40}):([a-z0-9_-]+):([a-z0-9_-]+):(\d+)$/;
const SCOPED_KEY_RE =
  /^(0x[0-9a-f]{40}):([a-z0-9_-]+):(0x[0-9a-f]{40}):([a-z0-9_-]+):(\d+)$/;

function managerFor(position, chain, version) {
  if (position && position.manager !== undefined && position.manager !== null) {
    const explicit = cleanPart(position.manager);
    return ADDRESS_RE.test(explicit) ? explicit : null;
  }
  const config = CHAINS[chain];
  const fallback = version === 'v4' ? config?.v4PositionManager : config?.nfpm;
  const manager = cleanPart(fallback);
  return ADDRESS_RE.test(manager) ? manager : null;
}

export function positionHideKey(position) {
  const owner = cleanPart(position && (position.ownerAddress || position.address));
  const chain = cleanPart(position && position.chainKey);
  const version = cleanPart(position && (position.version || position.protocol || 'position'));
  const manager = managerFor(position, chain, version);
  const tokenId = String(position && position.tokenId !== undefined ? position.tokenId : '').trim();
  if (!ADDRESS_RE.test(owner) || !chain || !manager || !version || !/^\d+$/.test(tokenId)) {
    return null;
  }
  return `${owner}:${chain}:${manager}:${version}:${tokenId}`;
}

function cleanHiddenKey(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (SCOPED_KEY_RE.test(key)) return key;
  const legacy = key.match(LEGACY_KEY_RE);
  if (!legacy) return null;
  const [, owner, chain, version, tokenId] = legacy;
  const manager = managerFor(null, chain, version);
  // Old rows could only refer to the one manager configured at the time. Do
  // not let an unscoped token ID hide a same-numbered NFT in a new deployment.
  return manager ? `${owner}:${chain}:${manager}:${version}:${tokenId}` : null;
}

export function cleanHiddenKeys(values) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const key = cleanHiddenKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= MAX_HIDDEN_POSITIONS) break;
  }
  return out;
}

export async function loadHiddenPositions() {
  try {
    const saved = store
      ? await store.get([HIDDEN_POSITIONS_KEY])
      : memory;
    const raw = Array.isArray(saved && saved[HIDDEN_POSITIONS_KEY])
      ? saved[HIDDEN_POSITIONS_KEY] : [];
    const keys = cleanHiddenKeys(raw);
    if (store && JSON.stringify(keys) !== JSON.stringify(raw)) {
      await store.set({ [HIDDEN_POSITIONS_KEY]: keys });
    }
    return keys;
  } catch {
    return [];
  }
}

export async function setPositionHidden(key, hidden) {
  const clean = cleanHiddenKeys([key])[0];
  if (!clean) return loadHiddenPositions();
  const keys = new Set(await loadHiddenPositions());
  if (hidden) keys.add(clean); else keys.delete(clean);
  const next = [...keys].slice(-MAX_HIDDEN_POSITIONS);
  try {
    if (store) await store.set({ [HIDDEN_POSITIONS_KEY]: next });
    else memory[HIDDEN_POSITIONS_KEY] = next;
  } catch { /* hiding is a local convenience; a storage failure is non-fatal */ }
  return next;
}
