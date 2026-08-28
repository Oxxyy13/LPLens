import { loadSweep, valueUsd } from './lib/positions.js';
import { CHAINS } from './lib/chains.js';
import {
  entitlement, historyRelayCredentials,
  TRIAL_LENGTH_DAYS, GATING_ENABLED, gateHeadline, gateHint,
} from './lib/license.js';
import {
  loadBook, upsertWallet, removeWallet, dedupeBook, MAX_SAVED_ADDRESSES,
  normalizeAddress, shortAddr, walletName,
} from './lib/wallets.js';
import { aggregateReasonText, summarizeAggregate } from './lib/aggregate.js';
import {
  readDashboardSnapshot, writeDashboardSnapshot, snapshotAge,
} from './lib/dashboard-snapshot.js';
import {
  loadHiddenPositions, positionHideKey, setPositionHidden,
} from './lib/hidden-positions.js';
import {
  buildScanDiagnostic, copyDiagnosticReport, readDiagnosticReport, saveDiagnosticReport,
} from './lib/diagnostics.js';
import {
  sendScanTelemetry, telemetryEnabled as scanTelemetryEnabled,
} from './lib/telemetry.js';
import {
  DISABLED_PORTFOLIO_CHAINS_KEY,
  enabledPortfolioChains,
  loadDisabledPortfolioChains,
  normalizeDisabledPortfolioChains,
  portfolioChainSummary,
  saveDisabledPortfolioChains,
} from './lib/scan-preferences.js';

const $ = (id) => document.getElementById(id);
const form = $('form'), statusEl = $('status'), resultsEl = $('results');
const SIDE_PANEL = document.body.dataset.surface === 'sidepanel';
const snapshotStatusEl = $('snapshotStatus');
const scanDetailsEl = $('scanDetails');
const scanDetailsSummaryEl = $('scanDetailsSummary');
const scanDetailsBodyEl = $('scanDetailsBody');
const filterBar = $('filterBar');
let activePositionFilter = 'all';

// Shared renderer, loaded as a classic script by popup.html before this module.
// The popup and the on-page overlay had drifted badly — every feature from 0.4
// to 0.8 landed only in the overlay — so both now render through one copy.
const {
  esc, fmt, ageText, priceText, priceOrientation, hero, rangeBar, details,
  rebalanceLine, CSS_COMPONENTS,
} = globalThis.LPLens;

// The overlay renders inside a shadow root; the popup has none, so the shared
// component styles are injected once here. Only the components — the overlay's
// fixed-position panel and gutter rules would fight the popup's own layout.
document.head.appendChild(document.createElement('style')).textContent = CSS_COMPONENTS;
const usd = (n) =>
  n === null || n === undefined || !isFinite(n)
    ? null
    : '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let book = [];
// `address` is the backwards-compatible storage key used by the ProjectX and
// Dexscreener overlays. Treat it as an explicit selection, not whichever
// address happened to be scanned most recently.
let activeAddress = null;
let activeAddressRevision = 0;
let walletBookRevision = 0;
let hiddenPositionKeys = new Set();
let latestPositions = [];
let latestSweepText = '';
let latestSweepSummary = '';
let latestSweepDetails = '';
let latestSweepIssues = 0;
let latestAccessState = 'unknown';
const ALL_CHAIN_KEYS = Object.freeze(Object.keys(CHAINS));
let disabledPortfolioChainKeys = [];
let scanPreferenceRevision = 0;
let scanPreferenceWritesPending = 0;
let scanPreferenceWriteQueue = Promise.resolve();
let scanBusy = false;
let dashboardMutationBusy = false;
let renderedChainKeys = null;
let dashboardStatusBase = '';

const startupScanPreferenceRevision = scanPreferenceRevision;
const scanPreferencesReady = loadDisabledPortfolioChains(ALL_CHAIN_KEYS).then((disabled) => {
  if (scanPreferenceRevision === startupScanPreferenceRevision) {
    disabledPortfolioChainKeys = disabled;
  }
  paintNetworkControls();
  paintScanHint();
});

const OPTIONAL_PAGE_ORIGINS = Object.freeze({
  uniswap: 'https://app.uniswap.org/*',
  projectx: 'https://www.prjx.com/*',
  dexscreener: 'https://dexscreener.com/*',
});

async function optionalPageAccess() {
  const entries = await Promise.all(Object.entries(OPTIONAL_PAGE_ORIGINS).map(async ([name, origin]) => [
    name,
    await chrome.permissions.contains({ origins: [origin] }).catch(() => false),
  ]));
  return Object.fromEntries(entries);
}

async function recordScanDiagnostic(startedAt, final, includeClosed) {
  try {
    const enabled = await scanTelemetryEnabled();
    const report = buildScanDiagnostic({
      surface: SIDE_PANEL ? 'sidepanel' : 'popup',
      startedAt,
      jobs: final.jobs,
      states: final.states,
      positionCount: final.allPositions.length,
      hiddenCount: final.hiddenPositions.length,
      includeClosed,
      savedWalletCount: book.length,
      accessState: latestAccessState,
      telemetryEnabled: enabled,
      optionalPageAccess: await optionalPageAccess(),
    });
    await saveDiagnosticReport(report);
    void sendScanTelemetry(report);
  } catch {
    // Diagnostics and aggregate telemetry must never alter a portfolio result.
  }
}

const diagnosticStateEl = $('diagnosticState');
const copyDiagnosticsButton = $('copyDiagnostics');
if (copyDiagnosticsButton) {
  copyDiagnosticsButton.addEventListener('click', async () => {
    diagnosticStateEl.textContent = '';
    try {
      const report = await readDiagnosticReport();
      if (!report) {
        diagnosticStateEl.textContent = 'Run a scan first.';
        return;
      }
      await copyDiagnosticReport(report);
      diagnosticStateEl.textContent = 'Copied. No wallets or position IDs included.';
    } catch {
      diagnosticStateEl.textContent = 'Could not copy.';
    }
  });
}

const reportIssueLink = $('reportIssue');
if (reportIssueLink) {
  const version = chrome.runtime.getManifest().version;
  const params = new URLSearchParams({
    title: `[${version}] `,
    body: 'What happened?\n\nPaste the output from Copy diagnostics below. It contains no wallet addresses, token names, pool IDs, position IDs, access keys, or raw provider errors.\n\n',
  });
  reportIssueLink.href = `https://github.com/Oxxyy13/LPLens/issues/new?${params}`;
}

const hiddenReady = loadHiddenPositions().then((keys) => {
  hiddenPositionKeys = new Set(keys);
  const count = $('hiddenCount');
  if (count) count.textContent = String(hiddenPositionKeys.size);
  applyPositionFilter();
});

function setSnapshotStatus(text) {
  if (!snapshotStatusEl) return;
  snapshotStatusEl.textContent = text || '';
  snapshotStatusEl.hidden = !text;
}

function clearScanDetails() {
  if (!scanDetailsEl) return;
  scanDetailsEl.hidden = true;
  scanDetailsEl.open = false;
  scanDetailsBodyEl.textContent = '';
}

function presentScanStatus(summary, detail = '', issues = 0) {
  statusEl.textContent = summary || '';
  if (!SIDE_PANEL || !scanDetailsEl) return;
  const body = String(detail || '').trim();
  scanDetailsBodyEl.textContent = body;
  scanDetailsSummaryEl.textContent = issues
    ? `Scan details (${issues} issue${issues === 1 ? '' : 's'})`
    : 'Scan details';
  scanDetailsEl.hidden = !body;
  if (!body) scanDetailsEl.open = false;
}

function legacyScanPresentation(text) {
  const full = String(text || '').trim();
  const match = /^(\d+)\/(\d+)(?: · (\d+) in flight)?(?: · (\d+) shown)?/.exec(full);
  if (!match) return { summary: full, details: '', issues: 0 };
  const failures = (full.match(/ failed:/g) || []).length;
  const incomplete = (full.match(/\([^)]*(?:unreadable|beyond scan limit)[^)]*\)/g) || []).length;
  const issues = failures + incomplete;
  const parts = [`${match[1]}/${match[2]} scans`];
  if (match[3]) parts.push(`${match[3]} reading`);
  if (match[4]) parts.push(`${match[4]} positions`);
  if (issues) parts.push(`${issues} issue${issues === 1 ? '' : 's'}`);
  return { summary: parts.join(' · '), details: full, issues };
}

function filterTokens(p) {
  const tokens = [];
  if (p.status === 'in-range') tokens.push('in-range');
  if (p.status === 'below' || p.status === 'above') tokens.push('out-of-range');
  if (p.status === 'closed') tokens.push('closed');
  const h = p.history || {};
  const u = p.usd || {};
  if (h.unavailable || u.returnUnavailable
      || u.totalNow === null || u.totalNow === undefined) tokens.push('issues');
  return tokens.join(' ');
}

function applyPositionFilter(next = activePositionFilter) {
  activePositionFilter = next;
  const cards = [...resultsEl.querySelectorAll('.position-card')];
  const showHidden = !!($('showHidden') && $('showHidden').checked);
  for (const el of cards) {
    const tokens = String(el.dataset.positionFilters || '').split(/\s+/).filter(Boolean);
    const locallyHidden = el.dataset.hiddenPosition === 'true';
    el.hidden = (locallyHidden && !showHidden)
      || (next !== 'all' && !tokens.includes(next));
  }
  if (filterBar) {
    filterBar.hidden = cards.every((el) => el.dataset.hiddenPosition === 'true' && !showHidden);
    for (const button of filterBar.querySelectorAll('[data-position-filter]')) {
      const active = button.dataset.positionFilter === next;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  }
}

if ($('showHidden')) {
  $('showHidden').addEventListener('change', () => applyPositionFilter());
}

if (filterBar) {
  filterBar.addEventListener('click', (event) => {
    const button = event.target.closest && event.target.closest('[data-position-filter]');
    if (!button) return;
    applyPositionFilter(button.dataset.positionFilter || 'all');
  });
}

const openPanelButton = $('openPanel');
let currentWindowId = null;
if (openPanelButton) {
  if (!chrome.sidePanel || !chrome.sidePanel.open || !chrome.windows) {
    openPanelButton.disabled = true;
    openPanelButton.title = 'Portfolio panel requires Chrome 116 or newer';
  } else {
    chrome.windows.getCurrent().then((win) => {
      currentWindowId = win && win.id;
      if (!Number.isInteger(currentWindowId)) {
        openPanelButton.disabled = true;
        openPanelButton.title = 'Chrome did not provide the current window';
      }
    }).catch(() => {
      openPanelButton.disabled = true;
      openPanelButton.title = 'Chrome did not provide the current window';
    });
    openPanelButton.addEventListener('click', () => {
      if (!Number.isInteger(currentWindowId)) {
        statusEl.className = 'status error';
        statusEl.textContent = 'The portfolio panel is not ready yet. Try again.';
        return;
      }
      chrome.sidePanel.open({ windowId: currentWindowId }).catch((err) => {
        statusEl.className = 'status error';
        statusEl.textContent = 'Could not open the portfolio panel: ' + (err.message || err);
      });
    });
  }
}

const startupAddressRevision = activeAddressRevision;
const startupBookRevision = walletBookRevision;
chrome.storage.local.get(['chain'], async (s) => {
  const initialBook = await loadBook();
  const latest = await chrome.storage.local.get(['address']);
  // Another open surface may have changed either value while loadBook() was
  // awaiting storage. Never let this slower startup repaint or overwrite that
  // newer explicit choice.
  if (walletBookRevision === startupBookRevision) book = initialBook;
  if (activeAddressRevision === startupAddressRevision) {
    activeAddress = normalizeAddress(latest.address);
    // No implicit fallback. A saved wallet is not an overlay wallet until the
    // user selects it, and pre-filling one here would visually imply otherwise.
    $('address').value = activeAddress || '';
  }
  // Pre-0.22 stored a single-chain pick. The current selector uses a distinct,
  // versioned key; leaving `chain` around could silently pin older code.
  if (Object.prototype.hasOwnProperty.call(s, 'chain')) {
    chrome.storage.local.remove('chain');
  }
  await scanPreferencesReady;
  paintBook();
  paintScanHint();
});

function selectedPortfolioChainKeys() {
  return enabledPortfolioChains(ALL_CHAIN_KEYS, disabledPortfolioChainKeys);
}

function sameChainSelection(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((key, index) => key === b[index]);
}

function paintScanButtons() {
  const unlocked = formUnlocked();
  const busy = scanBusy || dashboardMutationBusy;
  const hasNetwork = selectedPortfolioChainKeys().length > 0;
  const go = $('go');
  const scanAll = $('scanAll');
  if (go) {
    go.disabled = !unlocked || busy || !hasNetwork;
    go.title = hasNetwork ? '' : 'Choose at least one network';
  }
  if (scanAll) {
    scanAll.disabled = !unlocked || busy || !hasNetwork || book.length === 0;
    if (!hasNetwork) scanAll.title = 'Choose at least one network';
    else if (!book.length) scanAll.title = 'Save at least one address first';
    else scanAll.title = 'Scan every saved wallet';
  }
}

function paintNetworkControls() {
  const list = $('scanNetworkList');
  const all = $('scanNetworkAll');
  const summary = $('scanNetworkSummary');
  if (!list || !all || !summary) return;
  const enabled = new Set(selectedPortfolioChainKeys());
  const interactive = formUnlocked() && !scanBusy && !dashboardMutationBusy;
  summary.textContent = portfolioChainSummary(ALL_CHAIN_KEYS, disabledPortfolioChainKeys);
  all.checked = enabled.size === ALL_CHAIN_KEYS.length;
  all.indeterminate = enabled.size > 0 && enabled.size < ALL_CHAIN_KEYS.length;
  all.disabled = !interactive;
  for (const input of list.querySelectorAll('input[type="checkbox"]')) {
    if (!ALL_CHAIN_KEYS.includes(input.value)) input.closest('.network-option')?.remove();
  }
  for (const key of ALL_CHAIN_KEYS) {
    let input = [...list.querySelectorAll('input[type="checkbox"]')]
      .find((candidate) => candidate.value === key);
    if (!input) {
      const label = document.createElement('label');
      label.className = 'network-option';
      input = document.createElement('input');
      input.type = 'checkbox';
      input.value = key;
      const name = document.createElement('span');
      name.textContent = chainLabel(key);
      label.append(input, name);
      list.appendChild(label);
    }
    input.checked = enabled.has(key);
    input.disabled = !interactive;
    input.setAttribute('aria-label', `Scan ${chainLabel(key)} portfolios`);
  }
  paintScanButtons();
}

function paintNetworkSelectionNotice() {
  if (!SIDE_PANEL || !Array.isArray(renderedChainKeys) || !dashboardStatusBase) return;
  const selected = selectedPortfolioChainKeys();
  if (sameChainSelection(renderedChainKeys, selected)) {
    setSnapshotStatus(dashboardStatusBase);
    return;
  }
  const lead = selected.length
    ? 'Network selection changed. Refresh to apply.'
    : 'Choose at least one network. Current view is unchanged.';
  setSnapshotStatus(`${lead} ${dashboardStatusBase}`);
}

async function updateDisabledPortfolioChains(disabled) {
  const desired = normalizeDisabledPortfolioChains(disabled, ALL_CHAIN_KEYS);
  disabledPortfolioChainKeys = desired;
  paintNetworkControls();
  paintScanHint();
  paintNetworkSelectionNotice();
  scanPreferenceWritesPending++;
  const write = scanPreferenceWriteQueue.then(() => (
    saveDisabledPortfolioChains(desired, ALL_CHAIN_KEYS)
  ));
  scanPreferenceWriteQueue = write.catch(() => {});
  try {
    await write;
  } catch {
    statusEl.className = 'status error';
    statusEl.textContent = 'Could not save the network selection.';
  } finally {
    scanPreferenceWritesPending--;
    if (scanPreferenceWritesPending === 0) {
      const stored = await loadDisabledPortfolioChains(ALL_CHAIN_KEYS);
      if (scanPreferenceWritesPending === 0) {
        disabledPortfolioChainKeys = stored;
        paintNetworkControls();
        paintScanHint();
        paintNetworkSelectionNotice();
      }
    }
  }
}

$('scanNetworkAll').addEventListener('change', async (event) => {
  await updateDisabledPortfolioChains(event.target.checked ? [] : ALL_CHAIN_KEYS);
});

$('scanNetworkList').addEventListener('change', async (event) => {
  if (!event.target.matches('input[type="checkbox"]')) return;
  const enabled = new Set([...$('scanNetworkList').querySelectorAll('input:checked')]
    .map((input) => input.value));
  await updateDisabledPortfolioChains(ALL_CHAIN_KEYS.filter((key) => !enabled.has(key)));
});

function paintScanHint() {
  const hint = $('scanHint');
  if (!hint) return;
  const closed = $('includeClosed').checked;
  const enabled = selectedPortfolioChainKeys();
  if (enabled.length && !closed) {
    hint.hidden = true;
    hint.textContent = '';
    hint.classList.remove('error');
    return;
  }
  hint.hidden = false;
  const bits = enabled.length ? [] : ['Choose at least one network to scan.'];
  if (closed) bits.push('Closed positions can make scans much slower.');
  hint.textContent = bits.join(' ');
  hint.classList.toggle('error', enabled.length === 0);
}
$('includeClosed').addEventListener('change', paintScanHint);
paintScanHint();

function fieldAddress() {
  return normalizeAddress($('address').value);
}

function paintActiveWallet() {
  const el = $('activeWallet');
  if (!el) return;
  const entry = activeAddress && book.find((wallet) => wallet.address === activeAddress);
  const identity = activeAddress
    ? `${entry && entry.label ? `${entry.label} · ` : ''}${shortAddr(activeAddress)}`
    : 'none selected';
  const typed = fieldAddress();
  const pending = !!(typed && typed !== activeAddress);
  el.textContent = `Overlay wallet: ${identity}${pending ? ' · typed wallet not selected yet' : ''}`;
  el.title = activeAddress || 'Choose a saved wallet or load one wallet to select it.';
  el.classList.toggle('pending', pending);
  el.classList.toggle('empty', !activeAddress);
}

async function setActiveAddress(value, { syncField = true } = {}) {
  const address = normalizeAddress(value);
  if (!address) return false;
  activeAddress = address;
  if (syncField) $('address').value = address;
  await chrome.storage.local.set({ address });
  paintBook();
  return true;
}

function formUnlocked() {
  return !$('address').disabled;
}

function paintAddButton() {
  const btn = $('addWallet');
  if (!btn) return;
  const addr = fieldAddress();
  const inBook = !!(addr && book.some((e) => e.address === addr));
  const full = book.length >= MAX_SAVED_ADDRESSES;
  const on = formUnlocked();
  let reason = '';
  if (!on) reason = 'Unlock the popup first';
  else if (!addr) reason = 'Enter a valid 0x address';
  else if (inBook) reason = 'Already saved';
  else if (full) reason = `Saved address book is full (${MAX_SAVED_ADDRESSES})`;
  btn.disabled = !!reason;
  btn.title = reason || 'Save this address';
}

function paintBook() {
  const n = book.length;
  const count = $('savedCount');
  if (count) count.textContent = String(n);
  const list = $('savedList');
  const unlocked = formUnlocked();
  list.replaceChildren();
  for (const e of book) {
    const row = document.createElement('div');
    row.className = 'saved-row';
    row.dataset.address = e.address;
    const active = e.address === activeAddress;
    row.classList.toggle('active', active);
    row.dataset.activeWallet = String(active);

    const lab = document.createElement('input');
    lab.type = 'text';
    lab.className = 'saved-label';
    lab.maxLength = 24;
    lab.placeholder = 'label';
    lab.value = e.label || '';
    lab.disabled = !unlocked;
    lab.setAttribute('aria-label', 'Label for ' + shortAddr(e.address));

    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'saved-load';
    load.textContent = shortAddr(e.address);
    load.title = active
      ? 'This wallet is used by the ProjectX and Dexscreener overlays'
      : 'Use this wallet for the ProjectX and Dexscreener overlays';
    load.setAttribute('aria-pressed', String(active));
    load.disabled = !unlocked;

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'saved-remove';
    rm.textContent = '×';
    rm.title = 'Remove';
    rm.setAttribute('aria-label', 'Remove ' + shortAddr(e.address));
    rm.disabled = !unlocked;

    row.append(lab, load, rm);
    list.appendChild(row);
  }
  paintAddButton();
  paintActiveWallet();
  paintNetworkControls();
  paintScanHint();
}

$('address').addEventListener('input', () => {
  paintAddButton();
  paintActiveWallet();
});

$('addWallet').addEventListener('click', async () => {
  if ($('addWallet').disabled) return;
  const r = await upsertWallet($('address').value, '');
  book = r.book;
  if (r.error) {
    paintBook();
    statusEl.className = 'status error';
    statusEl.textContent = r.error;
    return;
  }
  await setActiveAddress($('address').value);
  statusEl.className = 'status';
  statusEl.textContent = 'Saved and selected as the overlay wallet.';
  setTimeout(() => {
    if (statusEl.textContent === 'Saved and selected as the overlay wallet.') statusEl.textContent = '';
  }, 1800);
});

$('savedList').addEventListener('click', async (e) => {
  const row = e.target.closest && e.target.closest('.saved-row');
  if (!row) return;
  const addr = row.dataset.address;
  if (e.target.closest('.saved-remove')) {
    // Instant — an address costs nothing to re-add. No confirm(), no dialog.
    book = await removeWallet(addr);
    // Saving and selecting are independent. Removing a row must not rewrite
    // another open surface's newer selection, so an active wallet simply
    // remains active as an unsaved address until the user selects another.
    paintBook();
    if (addr === activeAddress) {
      statusEl.className = 'status';
      statusEl.textContent = 'Removed from saved wallets. It remains the overlay wallet.';
    }
    return;
  }
  if (e.target.closest('.saved-load')) {
    await setActiveAddress(addr);
    statusEl.className = 'status';
    statusEl.textContent = `Overlay wallet changed to ${shortAddr(addr)}.`;
  }
});

$('savedList').addEventListener('change', async (e) => {
  const input = e.target.closest && e.target.closest('.saved-label');
  if (!input) return;
  const row = input.closest('.saved-row');
  if (!row) return;
  const r = await upsertWallet(row.dataset.address, input.value);
  book = r.book;
  paintActiveWallet();
});

// Keep the popup and side panel in sync. Selecting a wallet in either surface
// updates an already-open Dexscreener or ProjectX overlay immediately through
// its own storage listener.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.address) {
      activeAddressRevision++;
      const next = normalizeAddress(changes.address.newValue);
      activeAddress = next;
      if (document.activeElement !== $('address')) $('address').value = next || '';
      paintBook();
    }
    if (changes.wallets) {
      walletBookRevision++;
      // Using the event's new value keeps Chrome's event order authoritative.
      // Starting an async load for every event could allow an older read to
      // finish after a newer one and repaint stale rows.
      book = dedupeBook(changes.wallets.newValue || []);
      paintBook();
    }
    if (changes[DISABLED_PORTFOLIO_CHAINS_KEY]) {
      scanPreferenceRevision++;
      const next = normalizeDisabledPortfolioChains(
        changes[DISABLED_PORTFOLIO_CHAINS_KEY].newValue,
        ALL_CHAIN_KEYS,
      );
      // Local writes are reconciled once their serialized queue drains. Ignore
      // intermediate storage echoes so a slower first write cannot repaint a
      // newer checkbox choice. External changes still apply immediately when
      // this surface has no preference write in flight.
      if (scanPreferenceWritesPending || sameChainSelection(next, disabledPortfolioChainKeys)) return;
      disabledPortfolioChainKeys = next;
      paintNetworkControls();
      paintScanHint();
      paintNetworkSelectionNotice();
    }
  });
} catch { /* preview harness or orphaned extension page */ }

function setFormInteractive(on) {
  $('address').disabled = !on;
  paintBook();
}

function showGate(ent) {
  setFormInteractive(false);
  renderedChainKeys = null;
  dashboardStatusBase = '';
  statusEl.className = 'status error';
  statusEl.textContent = ent.reason || gateHeadline(ent.state);
  clearScanDetails();
  resultsEl.innerHTML = paywall(ent);
  setSnapshotStatus('');
  applyPositionFilter('all');
}

async function restoreDashboard() {
  if (!SIDE_PANEL) return;
  await scanPreferencesReady;
  const snapshot = await readDashboardSnapshot();
  if (!snapshot) {
    dashboardStatusBase = 'No saved portfolio view yet. Refresh one wallet or every saved wallet.';
    renderedChainKeys = null;
    setSnapshotStatus(dashboardStatusBase);
    return;
  }
  resultsEl.innerHTML = snapshot.html;
  reconcileHiddenCards();
  statusEl.className = 'status';
  const presentation = snapshot.details
    ? { summary: snapshot.status, details: snapshot.details, issues: snapshot.issues }
    : legacyScanPresentation(snapshot.status);
  presentScanStatus(presentation.summary, presentation.details, presentation.issues);
  $('includeClosed').checked = snapshot.includeClosed;
  paintScanHint();
  renderedChainKeys = Array.isArray(snapshot.chains) ? snapshot.chains : [...ALL_CHAIN_KEYS];
  const scope = `${snapshot.wallets} wallet${snapshot.wallets === 1 ? '' : 's'} · `
    + `${renderedChainKeys.length} network${renderedChainKeys.length === 1 ? '' : 's'} · `
    + `${snapshot.positions} position${snapshot.positions === 1 ? '' : 's'}`;
  const limited = snapshot.summaryOnly ? ' · summary only, refresh to load position cards' : '';
  const cards = [...resultsEl.querySelectorAll('.position-card')];
  const legacy = cards.length > 0 && !cards.some((cardEl) => cardEl.dataset.positionKey);
  const controls = legacy ? ' · refresh to enable card controls' : '';
  dashboardStatusBase = `Saved view · ${scope} · refreshed ${snapshotAge(snapshot.at)}${limited}${controls}`;
  setSnapshotStatus(dashboardStatusBase);
  paintNetworkSelectionNotice();
  applyPositionFilter('all');
}

// First paint (popup.html) already has the address + Load disabled and
// "Checking access…" in #status, so we never show a working form and then
// yank it. The verdict replaces that: a gate card, or the ordinary form.
(async function gateOnOpen() {
  await scanPreferencesReady;
  if (!GATING_ENABLED) {
    latestAccessState = 'free';
    await hiddenReady;
    await restoreDashboard();
    setFormInteractive(true);
    if (!SIDE_PANEL) statusEl.textContent = '';
    return;
  }
  try {
    const ent = await entitlement();
    latestAccessState = ent.state || 'unknown';
    if (!ent.allowed) {
      showGate(ent);
      return;
    }
    statusEl.className = 'status';
    statusEl.textContent = '';
    clearScanDetails();
    resultsEl.innerHTML = '';
    await hiddenReady;
    await restoreDashboard();
    setFormInteractive(true);
  } catch (err) {
    showGate({
      allowed: false,
      state: 'invalid',
      reason: err.message || String(err),
    });
  }
})();

async function startScan(owners, includeClosed, { selectOverlayWallet = false } = {}) {
  if (scanBusy || dashboardMutationBusy) return;
  // Acquire the UI lock before the first await. This prevents two rapid clicks
  // from launching overlapping sweeps that race to repaint and save one view.
  scanBusy = true;
  const scanStartedAt = Date.now();
  paintBook();
  try {
    await scanPreferencesReady;
    const chainKeys = [...selectedPortfolioChainKeys()];
    if (!chainKeys.length) {
      statusEl.className = 'status error';
      statusEl.textContent = 'Choose at least one network to scan.';
      return;
    }
    $('scanNetworks').open = false;
    // A one-wallet load is also an explicit overlay-wallet choice. A multi-wallet
    // refresh must never change that choice as a side effect.
    statusEl.className = 'status';
    const nJobs = owners.length * chainKeys.length;
    statusEl.textContent =
      `Scanning ${owners.length} wallet${owners.length === 1 ? '' : 's'} on `
      + `${chainKeys.length} network${chainKeys.length === 1 ? '' : 's'} · ${nJobs} scans, 2 at a time…`;
    clearScanDetails();
    resultsEl.innerHTML = '';
    renderedChainKeys = null;
    dashboardStatusBase = SIDE_PANEL ? 'Refreshing on-chain data…' : '';
    setSnapshotStatus(dashboardStatusBase);
    applyPositionFilter(activePositionFilter);
    if (selectOverlayWallet) await setActiveAddress(owners[0].address);
    // Recheck on submit even though we already checked on open: a key can
    // expire (or be revoked) while the popup sits open. The second call is
    // cheap — licenseSeen caches for RECHECK_HOURS, so this is not a second
    // network round-trip on the normal path.
    const ent = await entitlement();
    latestAccessState = ent.state || 'unknown';
    if (GATING_ENABLED && !ent.allowed) {
      showGate(ent);
      return;
    }
    if (GATING_ENABLED && ent.state === 'trial') {
      statusEl.textContent = `Trial: ${ent.daysLeft} day${ent.daysLeft === 1 ? '' : 's'} left of ${TRIAL_LENGTH_DAYS} · reading network…`;
    }
    await hiddenReady;
    const settings = await chrome.storage.local.get(['rpcOverrides', 'etherscanKey']);
    const historyRelay = await historyRelayCredentials();
    const final = await runSweep(owners, chainKeys, {
      includeClosed,
      rpcOverrides: settings.rpcOverrides || {},
      etherscanKey: settings.etherscanKey || null,
      historyRelay,
      withUsd: true,
    });
    const saved = !final.allFailed && await writeDashboardSnapshot({
      html: resultsEl.innerHTML,
      summaryHtml: totalsCard(final.positions),
      status: final.summary,
      details: final.details,
      issues: final.issueCount,
      positions: final.positions.length,
      wallets: owners.length,
      chains: chainKeys,
      includeClosed,
    });
    await recordScanDiagnostic(scanStartedAt, final, includeClosed);
    if (SIDE_PANEL) {
      const scope = `${owners.length} wallet${owners.length === 1 ? '' : 's'} · `
        + `${chainKeys.length} network${chainKeys.length === 1 ? '' : 's'}`;
      renderedChainKeys = final.allFailed ? null : chainKeys;
      dashboardStatusBase = final.allFailed
        ? 'Refresh failed on every selected network · saved view was not replaced'
        : saved
        ? `Current view · ${scope} · refreshed just now`
        : `Current view · ${scope} · local snapshot could not be saved`;
      setSnapshotStatus(dashboardStatusBase);
      paintNetworkSelectionNotice();
    }
  } catch (err) {
    statusEl.className = 'status error';
    statusEl.textContent = 'Failed: ' + (err.message || err);
    clearScanDetails();
    if (SIDE_PANEL) {
      renderedChainKeys = null;
      dashboardStatusBase = 'Refresh failed · saved view was not replaced';
      setSnapshotStatus(dashboardStatusBase);
    }
  } finally {
    scanBusy = false;
    reconcileHiddenCards();
    paintBook();
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const includeClosed = $('includeClosed').checked;
  const typed = normalizeAddress($('address').value);
  if (!typed) {
    statusEl.className = 'status error';
    statusEl.textContent = 'That is not a valid 0x address.';
    return;
  }
  const known = book.find((e) => e.address === typed);
  await startScan(
    [{ address: typed, label: known ? known.label : '' }],
    includeClosed,
    { selectOverlayWallet: true },
  );
});

$('scanAll').addEventListener('click', async () => {
  if (!book.length) {
    statusEl.className = 'status error';
    statusEl.textContent = 'Save at least one address before scanning all wallets.';
    return;
  }
  await startScan(book, $('includeClosed').checked);
});

function chainLabel(key) {
  return (CHAINS[key] && CHAINS[key].label) || key || '';
}

function jobKey(ev) {
  return `${ev.owner || ''}@${ev.chainKey}`;
}

function jobLabel(ev) {
  const w = (ev.label || '').trim() || shortAddr(ev.owner);
  return `${w} · ${chainLabel(ev.chainKey)}`;
}

/**
 * "Base: nothing" vs "Base failed: …" must stay distinguishable — and so must
 * "Base: 60" vs "Base: 60, and 91 more we did not scan plus 230 v4 we could
 * not read at all".
 *
 * `lib/positions.js` computes exactly which holdings it failed to render
 * (`result.truncated`, `result.v4.unavailable`, `v4.held` vs `v4.shown`) and
 * this function used to discard all of it, reporting only the rendered count.
 * A bare count reads as "this is all of it", which on a real wallet was wildly
 * false: measured 2026-08-20 against Dan's address, Base held 151 v3 positions
 * (60 scanned) and 230 v4 positions that Blockscout rate-limited away, and the
 * popup said "Base: 60" with no qualifier. Silently showing part of someone's
 * portfolio as though it were the whole thing is the one failure this project
 * does not accept.
 */
function jobOutcome(job, s) {
  const name = jobLabel(job);
  if (!s || s.phase === 'start') return `${name} reading`;
  if (s.ok === false) return `${name} failed: ${s.error || 'unknown error'}`;
  const r = s.result || {};
  const n = r.positions ? r.positions.length : 0;

  const gaps = [];
  if (r.count > (r.attempted ?? r.scanned)) {
    gaps.push(`${r.count - (r.attempted ?? r.scanned)} v3 beyond scan limit`);
  }
  if (r.enumUnreadable) gaps.push(`${r.enumUnreadable} v3 ownership unreadable`);
  if (r.positionUnreadable) gaps.push(`${r.positionUnreadable} v3 unreadable`);
  if (r.closedHidden) gaps.push(`${r.closedHidden} closed v3 hidden`);
  const v4 = r.v4;
  if (v4) {
    // held unknown in the enumeration-failed case, so do not imply a number.
    if (v4.unavailable) gaps.push(v4.held ? `${v4.held} v4 unreadable` : 'v4 unreadable');
    else {
      if (v4.unreadable) gaps.push(`${v4.unreadable} v4 unreadable`);
      if (v4.closedHidden) gaps.push(`${v4.closedHidden} closed v4 hidden`);
    }
  }

  const base = n ? `${name}: ${n}` : `${name}: nothing`;
  return gaps.length ? `${base} (${gaps.join(', ')})` : base;
}

function jobHasIssue(s) {
  if (!s || s.phase === 'start') return false;
  if (s.ok === false) return true;
  const r = s.result || {};
  if (r.count > (r.attempted ?? r.scanned)) return true;
  if (r.enumUnreadable || r.positionUnreadable) return true;
  const v4 = r.v4;
  return !!(v4 && (v4.unavailable || v4.unreadable));
}

function totalMetric(label, bucket) {
  const display = bucket.display;
  const tone = ({ up: 'positive', down: 'negative', muted: 'muted' })[display.tone] || 'muted';
  const coverage = display.state === 'partial'
    ? `Partial · ${display.coverage}`
    : display.coverage;
  const aria = `${label}: ${display.value}. ${coverage}.`;
  return `<div class="tot-line ${esc(display.state)}" role="group" data-total-metric="${esc(label)}"
      aria-label="${esc(aria)}">
    <span class="k">${esc(label)}</span>
    <span class="tot-value ${tone}">${esc(display.value)}</span>
    <span class="tot-coverage">${esc(coverage)}</span>
  </div>`;
}

function totalMetricNote(label, bucket) {
  if (bucket.display.state === 'complete') return '';
  const reason = aggregateReasonText(bucket);
  if (!reason) return '';
  const state = bucket.display.state === 'partial' ? 'partial' : 'unavailable';
  return `<div><strong>${esc(label)} ${state}:</strong> ${esc(reason)}.</div>`;
}

function totalsCard(positions) {
  const a = summarizeAggregate(positions);
  if (!a.n) return '';
  const notes = [
    totalMetricNote('Vs holding', a.vsHold),
    totalMetricNote('LP return', a.totalReturn),
    totalMetricNote('Position value', a.value),
  ].filter(Boolean).join('');
  return `<section class="card totals" aria-labelledby="portfolioTotalsHeading">
    <div class="totals-heading" id="portfolioTotalsHeading"><span>Portfolio totals</span><span>all unhidden positions</span></div>
    ${totalMetric('vs holding', a.vsHold)}
    ${totalMetric('LP return', a.totalReturn)}
    ${totalMetric('in positions', a.value)}
    ${notes ? `<div class="totals-notes">${notes}</div>` : ''}
  </section>`;
}

function updateHiddenCount() {
  const count = $('hiddenCount');
  if (!count) return;
  const allCards = [...resultsEl.querySelectorAll('.position-card')];
  const hiddenCards = allCards.filter((cardEl) => cardEl.dataset.hiddenPosition === 'true');
  count.textContent = String(allCards.length ? hiddenCards.length : hiddenPositionKeys.size);
}

function paintPortfolio(positions) {
  latestPositions = Array.isArray(positions) ? positions : [];
  const visible = [];
  const hidden = [];
  for (const position of latestPositions) {
    const key = positionHideKey(position);
    (key && hiddenPositionKeys.has(key) ? hidden : visible).push(position);
  }
  resultsEl.innerHTML = totalsCard(visible)
    + latestPositions.map((position) => {
      const key = positionHideKey(position);
      return card(position, {}, !!(key && hiddenPositionKeys.has(key)));
    }).join('');
  updateHiddenCount();
  applyPositionFilter();
  return { visible, hidden };
}

function hiddenStatus(text, total, visible, hidden) {
  let next = String(text || '');
  if (total) {
    next = next.replace(`${total} shown`, `${visible} shown`);
    next = next.replace(`${total} positions`, `${visible} positions`);
  }
  if (hidden) next += ` · ${hidden} hidden locally`;
  return next;
}

function reconcileHiddenCards() {
  for (const cardEl of resultsEl.querySelectorAll('.position-card[data-position-key]')) {
    const hidden = hiddenPositionKeys.has(String(cardEl.dataset.positionKey || '').toLowerCase());
    cardEl.dataset.hiddenPosition = String(hidden);
    const button = cardEl.querySelector('.hide-position');
    if (button) {
      button.textContent = hidden ? 'restore' : 'hide';
      button.setAttribute('aria-label', `${hidden ? 'Restore' : 'Hide'} this position in this browser`);
      button.disabled = scanBusy || dashboardMutationBusy;
      button.title = scanBusy || dashboardMutationBusy
        ? 'Wait for the portfolio update to finish'
        : `${hidden ? 'Restore' : 'Hide'} this position in local portfolio views`;
    }
  }
  updateHiddenCount();
  applyPositionFilter();
}

function sweepStatus(states, jobs) {
  const bits = [];
  const failed = [];
  const positions = [];
  let done = 0;
  let inflight = 0;
  let issueCount = 0;
  for (const job of jobs) {
    const s = states[jobKey(job)];
    bits.push(jobOutcome(job, s));
    if (jobHasIssue(s)) issueCount++;
    if (!s || s.phase === 'start') inflight++;
    else if (s.ok === false) {
      done++;
      failed.push(`${jobLabel(job)} failed: ${s.error || 'unknown error'}`);
    } else {
      done++;
      if (s.result && s.result.positions) positions.push(...s.result.positions);
    }
  }
  const head = [`${done}/${jobs.length} network scans`];
  if (inflight) head.push(`${inflight} in flight`);
  if (positions.length) head.push(`${positions.length} shown`);
  else if (done === jobs.length) head.push('0 positions shown');
  const line = [...head, ...bits].join(' · ');
  const complete = done === jobs.length;
  const summary = complete ? [] : [`${done}/${jobs.length} network scans`];
  if (inflight) summary.push(`${inflight} reading`);
  if (positions.length) summary.push(`${positions.length} position${positions.length === 1 ? '' : 's'}`);
  else if (complete) summary.push('0 positions shown');
  if (issueCount) summary.push(`${issueCount} issue${issueCount === 1 ? '' : 's'}`);
  const allFailed = done === jobs.length && failed.length === jobs.length;
  return {
    text: line,
    summary: summary.join(' · '),
    details: bits.join('\n'),
    issueCount,
    failed: failed.length > 0,
    allFailed,
    positions,
  };
}

async function runSweep(owners, chainKeys, opts) {
  const jobs = [];
  const seen = new Set();
  for (const o of owners) {
    if (seen.has(o.address)) continue;
    seen.add(o.address);
    for (const chainKey of chainKeys) jobs.push({ owner: o.address, label: o.label, chainKey });
  }
  const states = {};
  const selectedSet = new Set(chainKeys);
  const skipped = ALL_CHAIN_KEYS.filter((key) => !selectedSet.has(key));
  const skippedLine = skipped.length
    ? `Skipped locally: ${skipped.map(chainLabel).join(', ')}`
    : '';
  const paint = () => {
    const snap = sweepStatus(states, jobs);
    const detailText = [snap.details, skippedLine].filter(Boolean).join('\n');
    const shown = paintPortfolio(snap.positions);
    const text = hiddenStatus(
      snap.text, snap.positions.length, shown.visible.length, shown.hidden.length,
    );
    const summary = hiddenStatus(
      snap.summary, snap.positions.length, shown.visible.length, shown.hidden.length,
    );
    latestSweepText = snap.text;
    latestSweepSummary = snap.summary;
    latestSweepDetails = detailText;
    latestSweepIssues = snap.issueCount;
    statusEl.className = snap.allFailed ? 'status error' : 'status';
    if (SIDE_PANEL) presentScanStatus(summary, detailText, snap.issueCount);
    else statusEl.textContent = text;
    return {
      ...snap,
      text,
      summary,
      details: detailText,
      positions: shown.visible,
      allPositions: snap.positions,
      hiddenPositions: shown.hidden,
    };
  };
  await loadSweep(owners, chainKeys, {
    ...opts,
    onProgress: async (ev) => {
      if (ev.phase === 'start') {
        states[jobKey(ev)] = { phase: 'start' };
        paint();
        return;
      }
      states[jobKey(ev)] = ev;
      paint();
    },
  });
  return { ...paint(), jobs, states };
}

/**
 * One position card.
 *
 * Composed from the shared renderer so the popup shows exactly what the overlay
 * shows, plus the one thing only this surface has: USD marks from DexScreener,
 * which the overlay does not fetch. Unpriced legs render "unpriced" rather than
 * $0 — a missing mark must never look like a zero balance.
 */
function card(p, prices, locallyHidden = false) {
  const table = (p.chainKey && prices[p.chainKey] && typeof prices[p.chainKey] === 'object')
    ? prices[p.chainKey] : prices;
  const s0 = p.token0Meta.symbol, s1 = p.token1Meta.symbol;
  const p0 = table[p.token0.toLowerCase()], p1 = table[p.token1.toLowerCase()];
  const h = p.history || {};
  const u = p.usd;
  const standardPrice = priceOrientation(p, h, s0, s1, false);
  const inversePrice = priceOrientation(p, h, s0, s1, true);
  const flippable = standardPrice.valid && inversePrice.valid;
  const priceViews = (standard, inverse) => flippable
    ? `<span data-price-view="standard">${standard}</span><span data-price-view="inverse">${inverse}</span>`
    : standard;

  // Same restraint as the overlay: answer the question, then offer the rest.
  const value = u && u.totalNow !== null && u.totalNow !== undefined
    ? '$' + u.totalNow.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : (valueUsd(p.amount0, p.amount1, p0, p1) !== null
        ? usd(valueUsd(p.amount0, p.amount1, p0, p1)) : 'unpriced');

  const fees = u && u.collectable !== null && u.collectable !== undefined
    ? '$' + u.collectable.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : `${fmt(p.collectable0)} ${esc(s0)} + ${fmt(p.collectable1)} ${esc(s1)}`;

  const entryValue = (point) => point
    ? (point.exact
        ? fmt(point.price, 8)
        : `${esc(point.bound)} ${fmt(point.price, 8)}`)
    : (h.unavailable ? '—' : '—');
  const entryNoteValue = (point) => point && !point.exact
    ? (point.bound === 'at or below' ? 'at least' : point.bound === 'at or above' ? 'at most' : point.bound)
    : (point ? 'solved from mint' : (h.unavailable ? 'unavailable' : ''));
  const entry = priceViews(entryValue(standardPrice.entry), entryValue(inversePrice.entry));
  const entryNote = priceViews(entryNoteValue(standardPrice.entry), entryNoteValue(inversePrice.entry));

  const statusClass = ({ 'in-range': 'in-range', below: 'below', above: 'above', closed: 'closed' }[p.status]) || '';
  const hideKey = positionHideKey(p);
  const statusText = priceViews(esc(standardPrice.status), esc(inversePrice.status));
  const currentPrice = priceViews(fmt(standardPrice.now, 8), fmt(inversePrice.now, 8));
  const rangePrice = priceViews(
    `${fmt(standardPrice.lo, 8)} – ${fmt(standardPrice.hi, 8)}`,
    `${fmt(inversePrice.lo, 8)} – ${fmt(inversePrice.hi, 8)}`,
  );

  return `
    <div class="card position-card" data-position-filters="${filterTokens(p)}"
      data-position-key="${esc(hideKey || '')}" data-hidden-position="${locallyHidden ? 'true' : 'false'}">
      <div class="card-top">
        <span class="pair">${esc(s0)} / ${esc(s1)}</span>
        <span class="fee">${(p.fee / 10000).toFixed(2)}%</span>
        <span class="wallet-lbl">${esc(walletName(p))}</span>
        <span class="chain-lbl">${esc(chainLabel(p.chainKey))}</span>
        <span class="pill ${statusClass}">${statusText}</span>
      </div>
      ${rangeBar(p, h, flippable)}
      ${hero(p, h, s1)}
      <div class="stats">
        <div class="stat">
          <span class="stat-l">collectable</span>
          <span class="stat-v muted">${fees}</span>
        </div>
        <div class="stat">
          <span class="stat-l">entry</span>
          <span class="stat-v muted">${entry}</span>
          <span class="stat-n">${entryNote}</span>
        </div>
      </div>
      ${rebalanceLine(p, h, s0, s1)}
      <div class="card-actions">
        <button class="more" data-more="${p.tokenId}">details</button>
        ${hideKey ? `<button type="button" class="hide-position"
          ${scanBusy || dashboardMutationBusy ? 'disabled' : ''}
          aria-label="${locallyHidden ? 'Restore' : 'Hide'} ${esc(s0)} / ${esc(s1)} in this browser"
          title="${scanBusy || dashboardMutationBusy ? 'Wait for the portfolio update to finish' : `${locallyHidden ? 'Restore' : 'Hide'} this position in local portfolio views`}">${locallyHidden ? 'restore' : 'hide'}</button>` : ''}
      </div>
      <div class="extra">
        <div class="kv"><span>value</span><span class="num">${value}</span></div>
        <div class="kv"><span>current price</span><span class="num">${currentPrice}</span></div>
        <div class="kv"><span>range</span><span class="num">${rangePrice}</span></div>
        <div class="kv"><span>holds</span><span class="num">${fmt(p.amount0)} ${esc(s0)}<br>${fmt(p.amount1)} ${esc(s1)}</span></div>
        <div class="meta">#${p.tokenId}${p.protocol || p.version ? ' · ' : ''}${p.protocol ? esc(p.protocol) + ' ' : ''}${p.version ? esc(p.version) : ''}</div>
        ${details(p, h, s0, s1, flippable)}
      </div>
    </div>`;
}

// One handler for every card, added once rather than per render.
document.addEventListener('click', async (e) => {
  const hideButton = e.target.closest && e.target.closest('.hide-position');
  if (hideButton) {
    // Hiding changes aggregate membership and its persisted snapshot. Acquire
    // the same UI mutation lock before the first await so a refresh cannot
    // begin inside this storage transaction, or vice versa.
    if (scanBusy || dashboardMutationBusy) return;
    const cardEl = hideButton.closest('.position-card');
    const key = String(cardEl && cardEl.dataset.positionKey || '').toLowerCase();
    if (!key) return;
    const hide = cardEl.dataset.hiddenPosition !== 'true';
    dashboardMutationBusy = true;
    reconcileHiddenCards();
    paintBook();
    try {
      hiddenPositionKeys = new Set(await setPositionHidden(key, hide));
      updateHiddenCount();

      if (latestPositions.length) {
        const shown = paintPortfolio(latestPositions);
        const text = hiddenStatus(
          latestSweepText, latestPositions.length, shown.visible.length, shown.hidden.length,
        );
        const summary = hiddenStatus(
          latestSweepSummary, latestPositions.length, shown.visible.length, shown.hidden.length,
        );
        if (SIDE_PANEL) presentScanStatus(summary, latestSweepDetails, latestSweepIssues);
        else statusEl.textContent = text;
        const previous = await readDashboardSnapshot();
        await writeDashboardSnapshot({
          html: resultsEl.innerHTML,
          summaryHtml: totalsCard(shown.visible),
          status: summary,
          details: latestSweepDetails,
          issues: latestSweepIssues,
          positions: shown.visible.length,
          wallets: previous && previous.wallets || 1,
          chains: renderedChainKeys || (previous && previous.chains) || selectedPortfolioChainKeys(),
          includeClosed: $('includeClosed').checked,
        });
      } else {
        cardEl.dataset.hiddenPosition = String(hide);
        hideButton.textContent = hide ? 'restore' : 'hide';
        hideButton.setAttribute('aria-label', `${hide ? 'Restore' : 'Hide'} this position in this browser`);
        hideButton.title = `${hide ? 'Restore' : 'Hide'} this position in local portfolio views`;
        const totals = resultsEl.querySelector('.totals');
        if (totals) totals.remove();
        applyPositionFilter();
        const visibleCount = resultsEl.querySelectorAll('.position-card[data-hidden-position="false"]').length;
        const previous = await readDashboardSnapshot();
        statusEl.textContent = 'Hidden preference saved locally. Refresh to recalculate portfolio totals.';
        clearScanDetails();
        dashboardStatusBase = statusEl.textContent;
        renderedChainKeys = renderedChainKeys
          || (previous && previous.chains)
          || selectedPortfolioChainKeys();
        setSnapshotStatus(dashboardStatusBase);
        paintNetworkSelectionNotice();
        await writeDashboardSnapshot({
          html: resultsEl.innerHTML,
          summaryHtml: '',
          status: statusEl.textContent,
          details: '',
          issues: 0,
          positions: visibleCount,
          wallets: previous && previous.wallets || 1,
          chains: renderedChainKeys || (previous && previous.chains) || selectedPortfolioChainKeys(),
          includeClosed: $('includeClosed').checked,
        });
      }
    } finally {
      dashboardMutationBusy = false;
      reconcileHiddenCards();
      paintBook();
    }
    return;
  }
  const flip = e.target.closest && e.target.closest('.price-flip');
  if (flip) {
    const card = flip.closest('.position-card');
    if (!card) return;
    const inverted = card.classList.toggle('price-inverted');
    for (const button of card.querySelectorAll('.price-flip')) {
      button.setAttribute('aria-pressed', String(inverted));
      const next = inverted ? button.dataset.priceStandard : button.dataset.priceInverse;
      button.setAttribute('aria-label', `Show prices as ${next}`);
    }
    return;
  }
  const btn = e.target.closest && e.target.closest('.more');
  if (!btn) return;
  const card = btn.closest('.card');
  const open = card.classList.toggle('showmore');
  btn.textContent = open ? 'hide details' : 'details';
});

/**
 * Access-gate copy. Invite-only beta, not a purchase: no pricing, no "buy".
 */
function paywall(ent) {
  return `
    <div class="card">
      <h2><span>${esc(gateHeadline(ent.state))}</span></h2>
      <div class="note">${esc(ent.reason || '')}</div>
      <div class="note" style="margin-top:8px">
        ${esc(gateHint(ent.state))}
        Open <a href="options.html" target="_blank">options</a>.
      </div>
    </div>`;
}
