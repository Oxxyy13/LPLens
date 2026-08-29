/**
 * Locally hidden position NFTs.
 *
 * Unsolicited LP NFTs cannot be identified safely from token names or missing
 * history alone. Hiding is therefore an explicit, reversible local choice.
 * Nothing is transferred, burned, or written to the wallet.
 */

export const HIDDEN_POSITIONS_KEY = 'hiddenPositionsV1';
export const MAX_HIDDEN_POSITIONS = 500;

const memory = { [HIDDEN_POSITIONS_KEY]: [] };
const store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
  ? chrome.storage.local
  : null;

const cleanPart = (value) => String(value || '').trim().toLowerCase();

export function positionHideKey(position) {
  const owner = cleanPart(position && (position.ownerAddress || position.address));
  const chain = cleanPart(position && position.chainKey);
  const version = cleanPart(position && (position.version || position.protocol || 'position'));
  const tokenId = String(position && position.tokenId !== undefined ? position.tokenId : '').trim();
  if (!/^0x[0-9a-f]{40}$/.test(owner) || !chain || !version || !/^\d+$/.test(tokenId)) return null;
  return `${owner}:${chain}:${version}:${tokenId}`;
}

export function cleanHiddenKeys(values) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const key = String(raw || '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}:[a-z0-9_-]+:[a-z0-9_-]+:\d+$/.test(key) || seen.has(key)) continue;
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
    const keys = cleanHiddenKeys(saved && saved[HIDDEN_POSITIONS_KEY]);
    if (store && keys.length !== (saved && saved[HIDDEN_POSITIONS_KEY] || []).length) {
      await store.set({ [HIDDEN_POSITIONS_KEY]: keys });
    }
    return keys;
  } catch {
    return [];
  }
}

export async function setPositionHidden(key, hidden) {
  const clean = String(key || '').trim().toLowerCase();
  if (!cleanHiddenKeys([clean]).length) return loadHiddenPositions();
  const keys = new Set(await loadHiddenPositions());
  if (hidden) keys.add(clean); else keys.delete(clean);
  const next = [...keys].slice(-MAX_HIDDEN_POSITIONS);
  try {
    if (store) await store.set({ [HIDDEN_POSITIONS_KEY]: next });
    else memory[HIDDEN_POSITIONS_KEY] = next;
  } catch { /* hiding is a local convenience; a storage failure is non-fatal */ }
  return next;
}
