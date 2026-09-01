/**
 * Last rendered portfolio view for the persistent side panel.
 *
 * Position objects contain BigInts and are intentionally not copied into
 * chrome.storage. The snapshot stores only the already-escaped HTML produced
 * by popup.js plus the honest scan status and a small amount of display
 * metadata. It is a convenience view, never an input to position arithmetic.
 * Every refresh still reads current on-chain state through loadSweep().
 *
 * The full HTML is bounded so a whale cannot exhaust chrome.storage.local.
 * When it is too large, the aggregate card is retained and the panel says the
 * individual cards need a refresh.
 */

export const DASHBOARD_SNAPSHOT_KEY = 'dashboardSnapshotV1';
export const MAX_SNAPSHOT_HTML = 1_500_000;
export const MAX_SNAPSHOT_DETAILS = 100_000;

const memory = {};
const store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
  ? chrome.storage.local
  : null;

function clean(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Number.isFinite(raw.at) || raw.at <= 0) return null;
  if (typeof raw.html !== 'string' || typeof raw.status !== 'string') return null;
  const chains = Array.isArray(raw.chains)
    ? [...new Set(raw.chains.filter((key) => (
        typeof key === 'string' && /^[a-z0-9-]{1,32}$/.test(key)
      )))].slice(0, 32)
    : null;
  const wallets = Number.isInteger(raw.wallets) && raw.wallets >= 0 ? raw.wallets : 0;
  return {
    at: raw.at,
    html: raw.html,
    status: raw.status,
    details: typeof raw.details === 'string' ? raw.details.slice(0, MAX_SNAPSHOT_DETAILS) : '',
    issues: Number.isInteger(raw.issues) && raw.issues >= 0 ? raw.issues : 0,
    positions: Number.isInteger(raw.positions) && raw.positions >= 0 ? raw.positions : 0,
    wallets,
    showWalletLabels: typeof raw.showWalletLabels === 'boolean'
      ? raw.showWalletLabels
      : null,
    chains,
    includeClosed: !!raw.includeClosed,
    refreshScope: raw.refreshScope === 'all' ? 'all' : 'wallet',
    refreshMode: raw.refreshMode === 'current' ? 'current' : 'full',
    summaryOnly: !!raw.summaryOnly,
  };
}

export async function readDashboardSnapshot() {
  try {
    const raw = store
      ? (await store.get(DASHBOARD_SNAPSHOT_KEY))[DASHBOARD_SNAPSHOT_KEY]
      : memory[DASHBOARD_SNAPSHOT_KEY];
    return clean(raw);
  } catch {
    return null;
  }
}

export async function writeDashboardSnapshot(snapshot) {
  const full = String(snapshot.html || '');
  const summary = String(snapshot.summaryHtml || '');
  const summaryOnly = full.length > MAX_SNAPSHOT_HTML;
  const value = clean({
    at: Number.isFinite(snapshot.at) && snapshot.at > 0 ? snapshot.at : Date.now(),
    html: summaryOnly ? summary : full,
    status: String(snapshot.status || ''),
    details: String(snapshot.details || '').slice(0, MAX_SNAPSHOT_DETAILS),
    issues: Number(snapshot.issues) || 0,
    positions: Number(snapshot.positions) || 0,
    wallets: Number(snapshot.wallets) || 0,
    showWalletLabels: typeof snapshot.showWalletLabels === 'boolean'
      ? snapshot.showWalletLabels
      : undefined,
    chains: Array.isArray(snapshot.chains) ? snapshot.chains : null,
    includeClosed: !!snapshot.includeClosed,
    refreshScope: snapshot.refreshScope,
    refreshMode: snapshot.refreshMode,
    summaryOnly,
  });
  if (!value) return false;
  try {
    if (store) await store.set({ [DASHBOARD_SNAPSHOT_KEY]: value });
    else memory[DASHBOARD_SNAPSHOT_KEY] = value;
    return true;
  } catch {
    return false;
  }
}

export function snapshotAge(at, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
