/**
 * Saved-address book.
 *
 * LPLens has no wallet connection and never will, so the only addresses it
 * knows are the ones the user typed. This book is how more than one of those
 * survives a popup close.
 *
 * STORAGE IS chrome.storage.local ONLY. Do not "improve" this into
 * chrome.storage.sync. Sync would copy the list into the user's Google
 * account and off the device, which contradicts the privacy policy and the
 * options-page claim that this data stays on the machine. Dan chose local
 * explicitly.
 */

export const MAX_SAVED_ADDRESSES = 20;
export const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

const memory = { wallets: [], walletsMigrated: false, address: undefined };
const store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
  ? chrome.storage.local
  : null;

function emptyBook() {
  return [];
}

/** Lowercase 0x + 40 hex, or null. Accepts any case. */
export function normalizeAddress(value) {
  const s = String(value || '').trim();
  if (!ADDR_RE.test(s)) return null;
  return s.toLowerCase();
}

function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const address = normalizeAddress(raw.address);
  if (!address) return null;
  const label = String(raw.label || '').trim().slice(0, 24);
  return { address, label };
}

/**
 * Dedupe by lowercase address, first occurrence wins (migration order).
 * Later duplicates are dropped, never scanned twice.
 */
export function dedupeBook(entries) {
  const out = [];
  const seen = new Set();
  for (const raw of entries || []) {
    const e = cleanEntry(raw);
    if (!e || seen.has(e.address)) continue;
    seen.add(e.address);
    out.push(e);
    if (out.length >= MAX_SAVED_ADDRESSES) break;
  }
  return out;
}

async function readStore(keys) {
  try {
    if (!store) {
      const o = {};
      for (const k of keys) o[k] = memory[k];
      return o;
    }
    return await store.get(keys);
  } catch {
    return {};
  }
}

async function writeStore(obj) {
  try {
    if (!store) Object.assign(memory, obj);
    else await store.set(obj);
  } catch { /* book is convenience; failing to persist is not a load error */ }
}

/**
 * Load the book. On first run, the legacy single `address` becomes the first
 * entry so a user who already typed one does not lose it. The migration flag
 * prevents a later empty book from resurrecting that leftover.
 */
export async function loadBook() {
  const s = await readStore(['wallets', 'walletsMigrated', 'address']);
  if (s.walletsMigrated && Array.isArray(s.wallets)) {
    const book = dedupeBook(s.wallets);
    if (book.length !== (s.wallets || []).length) await writeStore({ wallets: book });
    return book;
  }
  const book = [];
  const legacy = normalizeAddress(s.address);
  if (legacy) book.push({ address: legacy, label: '' });
  await writeStore({ wallets: book, walletsMigrated: true });
  return book;
}

export async function saveBook(entries) {
  const book = dedupeBook(entries);
  await writeStore({ wallets: book, walletsMigrated: true });
  return book;
}

/**
 * Add or update by lowercase address. If the book is at the cap and this
 * address is new, returns { book, error } without writing a 21st entry.
 */
export async function upsertWallet(address, label) {
  const addr = normalizeAddress(address);
  if (!addr) return { book: await loadBook(), error: 'That is not a valid 0x address.' };
  const book = await loadBook();
  const i = book.findIndex((e) => e.address === addr);
  const entry = { address: addr, label: String(label || '').trim().slice(0, 24) };
  if (i >= 0) {
    book[i] = entry;
  } else if (book.length >= MAX_SAVED_ADDRESSES) {
    return {
      book,
      error: `Saved address book is full (${MAX_SAVED_ADDRESSES}). Remove one to add another.`,
    };
  } else {
    book.push(entry);
  }
  return { book: await saveBook(book), error: null };
}

export async function removeWallet(address) {
  const addr = normalizeAddress(address);
  const book = await loadBook();
  if (!addr) return book;
  return saveBook(book.filter((e) => e.address !== addr));
}

export function shortAddr(address) {
  const s = String(address || '');
  if (s.length < 12) return s;
  return s.slice(0, 6) + '…' + s.slice(-4);
}

export function walletName(entryOrPos) {
  if (!entryOrPos) return '';
  const label = (entryOrPos.ownerLabel || entryOrPos.label || '').trim();
  if (label) return label;
  return shortAddr(entryOrPos.ownerAddress || entryOrPos.address || '');
}
