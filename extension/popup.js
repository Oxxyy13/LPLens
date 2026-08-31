import { loadKnownSweep, loadSweep, valueUsd } from './lib/positions.js';
import { CHAINS } from './lib/chains.js';
import {
  entitlement, historyRelayCredentials, GATING_ENABLED, gateHeadline, gateHint,
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
  markCurrentPositionScopeIncomplete, readCurrentPositionJobs,
  writeCurrentRefreshScope, writeFullDiscoveryScope,
} from './lib/current-position-index.js';
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
  PORTFOLIO_REFRESH_SCOPE_KEY,
  loadPortfolioRefreshScope,
  normalizePortfolioRefreshScope,
  saveDisabledPortfolioChains,
  savePortfolioRefreshScope,
} from './lib/scan-preferences.js';
import {
  portfolioJobIssue, portfolioScanSummary, restoredPortfolioSummary,
} from './lib/portfolio-presentation.js';
import {
  attachRefreshDeltas, readRefreshSamples, shouldAdvanceRefreshSamples,
  writeRefreshSamples,
} from './lib/refresh-deltas.js';
import {
  attachPositionLineage, completeLineageProofSet, discoverLineageCandidates,
  mergeLineageEdges,
  lineageProofKey, lineageReceiptGroupCount, MAX_LINEAGE_VALIDATIONS,
  proveLineageCandidates, readLineageState, relevantLineageEdges,
  validateLineageEdges, writeLineageEdges,
} from './lib/position-lineage.js';

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
let latestPortfolioShowsWallet = false;
let latestAccessState = 'unknown';
const ALL_CHAIN_KEYS = Object.freeze(Object.keys(CHAINS));
let disabledPortfolioChainKeys = [];
let scanPreferenceRevision = 0;
let scanPreferenceWritesPending = 0;
let scanPreferenceWriteQueue = Promise.resolve();
let scanBusy = false;
let dashboardMutationBusy = false;
let renderedChainKeys = null;
let renderedRefreshScope = null;
let renderedRefreshMode = null;
let dashboardStatusBase = '';
let portfolioRefreshScope = 'wallet';
let refreshScopeRevision = 0;
let currentIndexState = 'checking';
let currentIndexCheckRevision = 0;

const startupScanPreferenceRevision = scanPreferenceRevision;
const scanPreferencesReady = loadDisabledPortfolioChains(ALL_CHAIN_KEYS).then((disabled) => {
  if (scanPreferenceRevision === startupScanPreferenceRevision) {
    disabledPortfolioChainKeys = disabled;
  }
  paintNetworkControls();
  paintScanHint();
});

const startupRefreshScopeRevision = refreshScopeRevision;
const refreshScopeReady = SIDE_PANEL
  ? loadPortfolioRefreshScope().then((scope) => {
      if (refreshScopeRevision === startupRefreshScopeRevision) {
        portfolioRefreshScope = scope;
      }
      paintRefreshScope();
    })
  : Promise.resolve();

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
  updateHiddenCount();
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
  scanDetailsBodyEl.hidden = true;
}

function presentScanStatus(summary, detail = '', issues = 0) {
  statusEl.textContent = summary || '';
  if (!SIDE_PANEL || !scanDetailsEl) return;
  const body = String(detail || '').trim();
  scanDetailsBodyEl.textContent = body;
  scanDetailsBodyEl.hidden = !body;
  scanDetailsSummaryEl.textContent = issues
    ? `Details (${issues} issue${issues === 1 ? '' : 's'})`
    : 'Help & diagnostics';
  scanDetailsEl.hidden = false;
  if (!body) scanDetailsEl.open = false;
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
  await Promise.all([scanPreferencesReady, refreshScopeReady]);
  paintBook();
  paintScanHint();
  scheduleCurrentIndexCheck();
});

function selectedPortfolioChainKeys() {
  return enabledPortfolioChains(ALL_CHAIN_KEYS, disabledPortfolioChainKeys);
}

function selectedRefreshOwners() {
  if (SIDE_PANEL && portfolioRefreshScope === 'all') return [...book];
  const address = fieldAddress();
  if (!address) return [];
  const known = book.find((entry) => entry.address === address);
  return [{ address, label: known ? known.label : '' }];
}

function paintRefreshScope() {
  const select = $('refreshScope');
  if (!select) return;
  const walletOption = select.querySelector('option[value="wallet"]');
  const allOption = select.querySelector('option[value="all"]');
  const address = fieldAddress();
  if (walletOption) {
    walletOption.textContent = address
      ? `Selected wallet · ${shortAddr(address)}`
      : 'Selected wallet · enter address';
  }
  if (allOption) allOption.textContent = `All saved wallets · ${book.length}`;
  select.value = portfolioRefreshScope;
  select.disabled = !formUnlocked() || scanBusy || dashboardMutationBusy;
}

function scheduleCurrentIndexCheck() {
  if (!SIDE_PANEL) return;
  const revision = ++currentIndexCheckRevision;
  currentIndexState = 'checking';
  paintScanButtons();
  void (async () => {
    await Promise.all([scanPreferencesReady, refreshScopeReady]);
    const owners = selectedRefreshOwners();
    const chains = selectedPortfolioChainKeys();
    let next = 'missing';
    if (owners.length && chains.length) {
      const jobs = await readCurrentPositionJobs(owners, chains);
      next = jobs.length === owners.length * chains.length && jobs.every((job) => job.ready)
        ? 'ready' : 'missing';
    }
    if (revision !== currentIndexCheckRevision) return;
    currentIndexState = next;
    paintScanButtons();
  })();
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
  const owners = SIDE_PANEL ? selectedRefreshOwners() : [];
  if (go) {
    if (SIDE_PANEL) {
      go.disabled = !unlocked || busy || !hasNetwork || !owners.length
        || $('includeClosed').checked || currentIndexState !== 'ready';
      if (!hasNetwork) go.title = 'Choose at least one network';
      else if (!owners.length) go.title = 'Choose a valid refresh scope';
      else if ($('includeClosed').checked) go.title = 'Use Full rescan to include closed positions';
      else if (currentIndexState === 'checking') go.title = 'Checking the current-position index';
      else if (currentIndexState !== 'ready') go.title = 'Run Full rescan once to discover positions';
      else go.title = 'Re-check known open positions without ownership discovery';
    } else {
      go.disabled = !unlocked || busy || !hasNetwork;
      go.title = hasNetwork ? '' : 'Choose at least one network';
    }
  }
  if (scanAll) {
    if (SIDE_PANEL) {
      scanAll.disabled = !unlocked || busy || !hasNetwork || !owners.length;
      if (!hasNetwork) scanAll.title = 'Choose at least one network';
      else if (!owners.length) scanAll.title = 'Choose a valid refresh scope';
      else scanAll.title = 'Discover new, transferred, or reopened positions';
    } else {
      scanAll.disabled = !unlocked || busy || !hasNetwork || book.length === 0;
      if (!hasNetwork) scanAll.title = 'Choose at least one network';
      else if (!book.length) scanAll.title = 'Save at least one address first';
      else scanAll.title = 'Scan every saved wallet';
    }
  }
  paintRefreshScope();
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
  const chainsMatch = sameChainSelection(renderedChainKeys, selected);
  const scopeMatches = !renderedRefreshScope || renderedRefreshScope === portfolioRefreshScope;
  if (chainsMatch && scopeMatches) {
    setSnapshotStatus(dashboardStatusBase);
    return;
  }
  const lead = selected.length
    ? (chainsMatch ? 'Scope changed. Refresh to update.'
      : scopeMatches ? 'Chains changed. Refresh to update.'
      : 'Scope and chains changed. Refresh to update.')
    : 'Choose at least one chain.';
  setSnapshotStatus(`${lead} ${dashboardStatusBase}`);
}

async function updateDisabledPortfolioChains(disabled) {
  const desired = normalizeDisabledPortfolioChains(disabled, ALL_CHAIN_KEYS);
  disabledPortfolioChainKeys = desired;
  paintNetworkControls();
  paintScanHint();
  paintNetworkSelectionNotice();
  scheduleCurrentIndexCheck();
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

if ($('refreshScope')) {
  $('refreshScope').addEventListener('change', async (event) => {
    refreshScopeRevision++;
    portfolioRefreshScope = normalizePortfolioRefreshScope(event.target.value);
    paintRefreshScope();
    paintNetworkSelectionNotice();
    scheduleCurrentIndexCheck();
    try {
      await savePortfolioRefreshScope(portfolioRefreshScope);
    } catch {
      statusEl.className = 'status error';
      statusEl.textContent = 'Could not save the refresh scope.';
    }
  });
}

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
$('includeClosed').addEventListener('change', paintScanButtons);
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
  el.classList.toggle('empty', !activeAddress && !pending);
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
  paintRefreshScope();
}

$('address').addEventListener('input', () => {
  paintAddButton();
  paintActiveWallet();
  paintRefreshScope();
  scheduleCurrentIndexCheck();
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
  scheduleCurrentIndexCheck();
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
    scheduleCurrentIndexCheck();
    if (addr === activeAddress) {
      statusEl.className = 'status';
      statusEl.textContent = 'Removed from saved wallets. It remains the overlay wallet.';
    }
    return;
  }
  if (e.target.closest('.saved-load')) {
    await setActiveAddress(addr);
    scheduleCurrentIndexCheck();
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
      scheduleCurrentIndexCheck();
    }
    if (changes.wallets) {
      walletBookRevision++;
      // Using the event's new value keeps Chrome's event order authoritative.
      // Starting an async load for every event could allow an older read to
      // finish after a newer one and repaint stale rows.
      book = dedupeBook(changes.wallets.newValue || []);
      paintBook();
      scheduleCurrentIndexCheck();
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
      scheduleCurrentIndexCheck();
    }
    if (changes[PORTFOLIO_REFRESH_SCOPE_KEY]) {
      refreshScopeRevision++;
      portfolioRefreshScope = normalizePortfolioRefreshScope(
        changes[PORTFOLIO_REFRESH_SCOPE_KEY].newValue,
      );
      paintRefreshScope();
      paintNetworkSelectionNotice();
      scheduleCurrentIndexCheck();
    }
    if (Object.keys(changes).some((key) => key.startsWith('current:v1:'))) {
      // A Full rescan writes one scope per completed wallet and chain. Avoid
      // launching an all-scope readiness read for every storage echo; the
      // scan's finally block performs one authoritative check after all writes.
      if (!scanBusy && !dashboardMutationBusy) scheduleCurrentIndexCheck();
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
  renderedRefreshScope = null;
  renderedRefreshMode = null;
  dashboardStatusBase = '';
  statusEl.className = 'status error';
  statusEl.textContent = ent.reason || gateHeadline(ent.state);
  clearScanDetails();
  resultsEl.innerHTML = paywall(ent);
  setSnapshotStatus('');
  applyPositionFilter('all');
}

function cleanRestoredDashboard(showWalletLabels) {
  const heading = resultsEl.querySelector('.totals-heading');
  if (heading) heading.textContent = 'Portfolio totals';
  for (const coverage of resultsEl.querySelectorAll('.tot-line.complete .tot-coverage')) {
    coverage.remove();
  }
  for (const coverage of resultsEl.querySelectorAll('.tot-line.partial .tot-coverage')) {
    coverage.textContent = 'Partial total';
  }
  for (const coverage of resultsEl.querySelectorAll('.tot-line.unavailable .tot-coverage')) {
    coverage.textContent = 'Not enough data';
  }
  for (const notes of resultsEl.querySelectorAll('.totals-notes')) notes.remove();
  for (const meta of resultsEl.querySelectorAll('.position-card .meta')) meta.remove();
  // Receipt and block-header proof is live-session state. Cached HTML must not
  // carry a prior session's verified claim across a reopen.
  for (const lineage of resultsEl.querySelectorAll('.position-lineage')) lineage.remove();

  if (showWalletLabels === false) {
    for (const label of resultsEl.querySelectorAll('.position-card .wallet-lbl')) label.remove();
  }
  for (const age of resultsEl.querySelectorAll('[data-refresh-baseline-at]')) {
    const at = Number(age.dataset.refreshBaselineAt);
    if (Number.isFinite(at) && at > 0) age.textContent = snapshotAge(at);
  }
}

function positionsWithoutLineage(positions) {
  return (positions || []).map((position) => {
    if (!position || !Object.hasOwn(position, 'lineage')) return position;
    const copy = { ...position };
    delete copy.lineage;
    return copy;
  });
}

function dashboardHtmlWithoutLiveProofs() {
  const clone = resultsEl.cloneNode(true);
  for (const lineage of clone.querySelectorAll('.position-lineage')) lineage.remove();
  return clone.innerHTML;
}

async function restoreDashboard() {
  if (!SIDE_PANEL) return;
  await Promise.all([scanPreferencesReady, refreshScopeReady]);
  const snapshot = await readDashboardSnapshot();
  if (!snapshot) {
    dashboardStatusBase = 'No saved portfolio yet. Refresh a wallet to begin.';
    renderedChainKeys = null;
    renderedRefreshScope = null;
    renderedRefreshMode = null;
    setSnapshotStatus(dashboardStatusBase);
    return;
  }
  resultsEl.innerHTML = snapshot.html;
  cleanRestoredDashboard(snapshot.showWalletLabels);
  reconcileHiddenCards();
  statusEl.className = 'status';
  const issueCount = Math.max(0, Number(snapshot.issues) || 0);
  const presentation = {
    summary: restoredPortfolioSummary({
      issueCount,
      visiblePositionCount: snapshot.positions,
      hasPositionCards: !!resultsEl.querySelector('.position-card'),
      summaryOnly: snapshot.summaryOnly,
    }),
    details: issueCount
      ? 'Some data was unavailable in this saved refresh. Refresh for current details.'
      : '',
    issues: issueCount,
  };
  presentScanStatus(presentation.summary, presentation.details, presentation.issues);
  $('includeClosed').checked = snapshot.includeClosed;
  paintScanHint();
  renderedChainKeys = Array.isArray(snapshot.chains) ? snapshot.chains : [...ALL_CHAIN_KEYS];
  renderedRefreshScope = snapshot.refreshScope;
  renderedRefreshMode = snapshot.refreshMode;
  dashboardStatusBase = dashboardSnapshotStatus(snapshot);
  setSnapshotStatus(dashboardStatusBase);
  paintNetworkSelectionNotice();
  applyPositionFilter('all');
}

function dashboardSnapshotStatus(snapshot) {
  const limited = snapshot.summaryOnly ? ' Refresh to load position cards.' : '';
  return snapshot.refreshMode === 'current'
    ? `Current positions refreshed ${snapshotAge(snapshot.at)}. Full rescan to discover portfolio changes.${limited}`
    : `Full rescan completed ${snapshotAge(snapshot.at)}.${limited}`;
}

// First paint (popup.html) already has the address + Load disabled and
// "Checking access…" in #status, so we never show a working form and then
// yank it. The verdict replaces that: a gate card, or the ordinary form.
(async function gateOnOpen() {
  await Promise.all([scanPreferencesReady, refreshScopeReady]);
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

async function persistPositionIndex(final, mode) {
  for (const state of Object.values(final.states || {})) {
    if (!state) continue;
    if (mode === 'full' && state.ok === false) {
      await markCurrentPositionScopeIncomplete({
        owner: state.owner,
        chainKey: state.chainKey,
      });
      continue;
    }
    if (state.ok !== true || !state.result) continue;
    if (mode === 'current' && state.result.currentIndex) {
      await writeCurrentRefreshScope({
        owner: state.owner,
        chainKey: state.chainKey,
        ids: state.result.currentIndex,
      });
    } else if (mode === 'full' && state.result.discovery) {
      await writeFullDiscoveryScope({
        owner: state.owner,
        chainKey: state.chainKey,
        discovery: state.result.discovery,
      });
    }
  }
}

async function startScan(
  owners,
  includeClosed,
  { selectOverlayWallet = false, mode = 'full' } = {},
) {
  if (scanBusy || dashboardMutationBusy) return;
  // Acquire the UI lock before the first await. This prevents two rapid clicks
  // from launching overlapping sweeps that race to repaint and save one view.
  scanBusy = true;
  const scanStartedAt = Date.now();
  const previousRefreshStatus = dashboardStatusBase;
  // A new attempt invalidates the last session proof immediately. If receipt
  // or header validation fails, the preserved cards remain useful but cannot
  // continue to claim a verified replacement.
  for (const lineage of resultsEl.querySelectorAll('.position-lineage')) lineage.remove();
  latestPositions = positionsWithoutLineage(latestPositions);
  const previousView = {
    html: dashboardHtmlWithoutLiveProofs(),
    latestPositions: [...latestPositions],
    latestSweepText,
    latestSweepSummary,
    latestSweepDetails,
    latestSweepIssues,
    latestPortfolioShowsWallet,
    renderedChainKeys: Array.isArray(renderedChainKeys) ? [...renderedChainKeys] : null,
    renderedRefreshScope,
    renderedRefreshMode,
  };
  const canPreserveCurrentView = mode === 'current' && !!previousView.html.trim();
  paintBook();
  try {
    await Promise.all([scanPreferencesReady, refreshScopeReady]);
    const chainKeys = [...selectedPortfolioChainKeys()];
    const scanRefreshScope = SIDE_PANEL
      ? portfolioRefreshScope
      : (selectOverlayWallet ? 'wallet' : 'all');
    if (!chainKeys.length) {
      statusEl.className = 'status error';
      statusEl.textContent = 'Choose at least one network to scan.';
      return;
    }
    $('scanNetworks').open = false;
    if (mode === 'current' && includeClosed) {
      statusEl.className = 'status error';
      statusEl.textContent = 'Use Full rescan when including closed positions.';
      return;
    }
    let currentScopes = null;
    if (mode === 'current') {
      currentScopes = await readCurrentPositionJobs(owners, chainKeys);
      if (currentScopes.length !== owners.length * chainKeys.length
          || currentScopes.some((job) => !job.ready)) {
        statusEl.className = 'status error';
        statusEl.textContent = 'Run Full rescan once to discover positions.';
        return;
      }
    }
    // A one-wallet load is also an explicit overlay-wallet choice. A multi-wallet
    // refresh must never change that choice as a side effect.
    statusEl.className = 'status';
    statusEl.textContent = mode === 'current'
      ? 'Refreshing known positions…'
      : 'Discovering positions…';
    clearScanDetails();
    if (mode === 'full') {
      resultsEl.innerHTML = '';
      renderedChainKeys = null;
      renderedRefreshScope = null;
      renderedRefreshMode = null;
      dashboardStatusBase = '';
      setSnapshotStatus(dashboardStatusBase);
      applyPositionFilter(activePositionFilter);
    }
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
      statusEl.textContent = mode === 'current'
        ? 'Refreshing known positions…'
        : 'Discovering positions…';
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
      showWalletAttribution: !selectOverlayWallet,
      mode,
      currentScopes,
      preserveExistingView: canPreserveCurrentView,
    });
    await persistPositionIndex(final, mode);
    const preservedCurrentView = mode === 'current'
      && final.issueCount > 0
      && canPreserveCurrentView;
    if (preservedCurrentView) {
      resultsEl.innerHTML = previousView.html;
      latestPositions = previousView.latestPositions;
      latestSweepText = previousView.latestSweepText;
      latestSweepSummary = previousView.latestSweepSummary;
      latestSweepDetails = previousView.latestSweepDetails;
      latestSweepIssues = previousView.latestSweepIssues;
      latestPortfolioShowsWallet = previousView.latestPortfolioShowsWallet;
      reconcileHiddenCards();
      applyPositionFilter(activePositionFilter);
    }
    // Consecutive-refresh deltas and cross-NFT lineage are presentation-only
    // context. They advance only when this result becomes the accepted view.
    // Progressive paints, failed scans, and a preserved prior dashboard never
    // change either local store.
    const acceptedAt = !final.allFailed && !preservedCurrentView ? Date.now() : null;
    const contextAcceptedAt = SIDE_PANEL ? acceptedAt : null;
    const deltaAcceptedAt = shouldAdvanceRefreshSamples({
      sidePanel: SIDE_PANEL,
      allFailed: final.allFailed,
      preservedCurrentView,
    }) ? acceptedAt : null;
    let acceptedLineage = null;
    let storedLineage = null;
    if (contextAcceptedAt) {
      const [previousSamples, lineageState] = await Promise.all([
        deltaAcceptedAt ? readRefreshSamples(final.allPositions) : Promise.resolve(new Map()),
        readLineageState(),
      ]);
      const previousLineage = lineageState.edges;
      const relevantPrevious = relevantLineageEdges(final.allPositions, previousLineage);
      const knownProofKeys = new Set(previousLineage.map(lineageProofKey).filter(Boolean));
      const newCandidates = lineageState.ok && mode === 'full' && includeClosed
        ? discoverLineageCandidates(final.allPositions, contextAcceptedAt)
          .filter((candidate) => !knownProofKeys.has(lineageProofKey(candidate)))
        : [];
      const previousGroups = lineageReceiptGroupCount(relevantPrevious);
      const expectedLineage = [...relevantPrevious, ...newCandidates];
      const lineageWithinBudget = lineageReceiptGroupCount(expectedLineage)
        <= MAX_LINEAGE_VALIDATIONS;
      const newProofBudget = lineageWithinBudget
        ? MAX_LINEAGE_VALIDATIONS - previousGroups : 0;
      const [verifiedPrevious, discoveredLineage] = await Promise.all([
        lineageState.ok && lineageWithinBudget ? validateLineageEdges(
          relevantPrevious,
          settings.rpcOverrides || {},
          MAX_LINEAGE_VALIDATIONS,
        ) : Promise.resolve([]),
        newProofBudget > 0
          ? proveLineageCandidates(newCandidates, settings.rpcOverrides || {}, newProofBudget)
          : Promise.resolve([]),
      ]);
      // Keep stored proofs when a provider cannot re-check them, but never
      // render or aggregate one until this refresh validates it again.
      storedLineage = lineageState.ok
        ? mergeLineageEdges(previousLineage, discoveredLineage) : null;
      acceptedLineage = lineageWithinBudget
        ? completeLineageProofSet(
          expectedLineage,
          mergeLineageEdges(verifiedPrevious, discoveredLineage),
        )
        : [];
      const withDeltas = deltaAcceptedAt
        ? attachRefreshDeltas(final.allPositions, previousSamples, deltaAcceptedAt)
        : final.allPositions;
      const withContext = attachPositionLineage(withDeltas, acceptedLineage);
      const shown = paintPortfolio(withContext);
      final.allPositions = withContext;
      final.positions = shown.visible;
      final.hiddenPositions = shown.hidden;
    }
    const saved = !final.allFailed && !preservedCurrentView && await writeDashboardSnapshot({
      at: acceptedAt,
      html: dashboardHtmlWithoutLiveProofs(),
      summaryHtml: totalsCard(final.positions),
      status: final.summary,
      details: final.details,
      issues: final.issueCount,
      positions: final.positions.length,
      wallets: owners.length,
      showWalletLabels: latestPortfolioShowsWallet,
      chains: chainKeys,
      includeClosed,
      refreshScope: scanRefreshScope,
      refreshMode: mode,
    });
    if (contextAcceptedAt) {
      const contextWrites = [];
      if (storedLineage) contextWrites.push(writeLineageEdges(storedLineage));
      if (deltaAcceptedAt) {
        contextWrites.push(writeRefreshSamples(final.allPositions, deltaAcceptedAt));
      }
      await Promise.all(contextWrites);
    }
    await recordScanDiagnostic(scanStartedAt, final, includeClosed);
    if (SIDE_PANEL) {
      if (preservedCurrentView) {
        renderedChainKeys = previousView.renderedChainKeys;
        renderedRefreshScope = previousView.renderedRefreshScope;
        renderedRefreshMode = previousView.renderedRefreshMode;
        dashboardStatusBase = previousRefreshStatus
          ? `Refresh incomplete. ${previousRefreshStatus}`
          : 'Refresh incomplete. The last saved view was kept.';
      } else {
        renderedChainKeys = final.allFailed ? null : chainKeys;
        renderedRefreshScope = final.allFailed ? null : scanRefreshScope;
        renderedRefreshMode = final.allFailed ? null : mode;
        if (final.allFailed) {
          dashboardStatusBase = previousRefreshStatus
            ? `Refresh failed. ${previousRefreshStatus}` : 'Refresh failed.';
        } else if (final.issueCount) {
          dashboardStatusBase = mode === 'current'
            ? 'Current refresh completed with missing chain data.'
            : 'Full rescan completed with missing chain data.';
        } else if (saved) {
          dashboardStatusBase = mode === 'current'
            ? 'Current positions refreshed just now. Full rescan to discover portfolio changes.'
            : 'Full rescan completed just now.';
        } else {
          dashboardStatusBase = mode === 'current'
            ? 'Current positions refreshed just now. Could not save this view locally.'
            : 'Full rescan completed just now. Could not save this view locally.';
        }
      }
      setSnapshotStatus(dashboardStatusBase);
      paintNetworkSelectionNotice();
    }
  } catch {
    statusEl.className = 'status error';
    presentScanStatus('Could not refresh positions.');
    if (SIDE_PANEL) {
      if (mode === 'current' && canPreserveCurrentView) {
        resultsEl.innerHTML = previousView.html;
        latestPositions = previousView.latestPositions;
        latestSweepText = previousView.latestSweepText;
        latestSweepSummary = previousView.latestSweepSummary;
        latestSweepDetails = previousView.latestSweepDetails;
        latestSweepIssues = previousView.latestSweepIssues;
        latestPortfolioShowsWallet = previousView.latestPortfolioShowsWallet;
        renderedChainKeys = previousView.renderedChainKeys;
        renderedRefreshScope = previousView.renderedRefreshScope;
        renderedRefreshMode = previousView.renderedRefreshMode;
        reconcileHiddenCards();
        applyPositionFilter(activePositionFilter);
      } else {
        renderedChainKeys = null;
        renderedRefreshScope = null;
        renderedRefreshMode = null;
      }
      dashboardStatusBase = previousRefreshStatus
        ? `Refresh failed. ${previousRefreshStatus}`
        : 'Refresh failed.';
      setSnapshotStatus(dashboardStatusBase);
      paintNetworkSelectionNotice();
    }
  } finally {
    scanBusy = false;
    reconcileHiddenCards();
    paintBook();
    scheduleCurrentIndexCheck();
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const includeClosed = $('includeClosed').checked;
  if (SIDE_PANEL) {
    const owners = selectedRefreshOwners();
    if (!owners.length) {
      statusEl.className = 'status error';
      statusEl.textContent = portfolioRefreshScope === 'all'
        ? 'Save at least one wallet first.'
        : 'That is not a valid 0x address.';
      return;
    }
    await startScan(owners, includeClosed, {
      selectOverlayWallet: portfolioRefreshScope === 'wallet',
      mode: 'current',
    });
    return;
  }
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
    { selectOverlayWallet: true, mode: 'full' },
  );
});

$('scanAll').addEventListener('click', async () => {
  if (SIDE_PANEL) {
    const owners = selectedRefreshOwners();
    if (!owners.length) {
      statusEl.className = 'status error';
      statusEl.textContent = portfolioRefreshScope === 'all'
        ? 'Save at least one wallet first.'
        : 'That is not a valid 0x address.';
      return;
    }
    await startScan(owners, $('includeClosed').checked, {
      selectOverlayWallet: portfolioRefreshScope === 'wallet',
      mode: 'full',
    });
    return;
  }
  if (!book.length) {
    statusEl.className = 'status error';
    statusEl.textContent = 'Save at least one address before scanning all wallets.';
    return;
  }
  await startScan(book, $('includeClosed').checked, { mode: 'full' });
});

function chainLabel(key) {
  return (CHAINS[key] && CHAINS[key].label) || key || '';
}

function jobKey(ev) {
  return `${ev.owner || ''}@${ev.chainKey}`;
}

function jobLabel(ev, showWallet = true) {
  if (!showWallet) return chainLabel(ev.chainKey);
  const w = (ev.label || '').trim() || shortAddr(ev.owner);
  return `${w} · ${chainLabel(ev.chainKey)}`;
}

// Routine successes stay out of the UI. Actual gaps remain visible with a
// friendly reason, while raw provider errors stay inside privacy-safe diagnostics.
function jobIssueOutcome(job, state, showWallet) {
  const issue = portfolioJobIssue(state);
  return issue ? `${jobLabel(job, showWallet)}: ${issue}` : '';
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
  const subtext = display.state === 'partial'
    ? 'Partial total'
    : display.state === 'unavailable' ? 'Not enough data' : '';
  const reason = aggregateReasonText(bucket);
  const aria = `${label}: ${display.value}. ${display.coverage}.${reason ? ` ${reason}.` : ''}`;
  const title = subtext
    ? ` title="${esc(`${display.coverage}.${reason ? ` ${reason}.` : ''}`)}"`
    : '';
  return `<div class="tot-line ${esc(display.state)}" role="group" data-total-metric="${esc(label)}"
      aria-label="${esc(aria)}"${title}>
    <span class="k">${esc(label)}</span>
    <span class="tot-value ${tone}">${esc(display.value)}</span>
    ${subtext ? `<span class="tot-coverage">${esc(subtext)}</span>` : ''}
  </div>`;
}

function totalsCard(positions) {
  const a = summarizeAggregate(positions);
  if (!a.n) return '';
  return `<section class="card totals" aria-labelledby="portfolioTotalsHeading">
    <div class="totals-heading" id="portfolioTotalsHeading">Portfolio totals</div>
    ${totalMetric('vs holding', a.vsHold)}
    ${totalMetric('LP return', a.totalReturn)}
    ${totalMetric('in positions', a.value)}
  </section>`;
}

function updateHiddenCount() {
  const count = $('hiddenCount');
  if (!count) return;
  const allCards = [...resultsEl.querySelectorAll('.position-card')];
  const hiddenCards = allCards.filter((cardEl) => cardEl.dataset.hiddenPosition === 'true');
  const hiddenCount = hiddenCards.length;
  count.textContent = String(hiddenCount);
  const showHidden = $('showHidden');
  if (!hiddenCount && showHidden) showHidden.checked = false;
  const option = $('showHiddenOption');
  if (option) option.hidden = hiddenCount === 0;
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
      return card(
        position, {}, !!(key && hiddenPositionKeys.has(key)), latestPortfolioShowsWallet,
      );
    }).join('');
  updateHiddenCount();
  applyPositionFilter();
  return { visible, hidden };
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

function sweepStatus(states, jobs, showWallet) {
  const issueLines = [];
  const positions = [];
  let done = 0;
  let failed = 0;
  let issueCount = 0;
  for (const job of jobs) {
    const s = states[jobKey(job)];
    if (jobHasIssue(s)) {
      issueCount++;
      issueLines.push(jobIssueOutcome(job, s, showWallet));
    }
    if (!s || s.phase === 'start') continue;
    if (s.ok === false) {
      done++;
      failed++;
    } else {
      done++;
      if (s.result && s.result.positions) positions.push(...s.result.positions);
    }
  }
  const complete = done === jobs.length;
  const allFailed = complete && failed === jobs.length;
  const summary = portfolioScanSummary({
    complete, allFailed, issueCount, positionCount: positions.length,
  });
  return {
    text: summary,
    summary,
    details: issueLines.filter(Boolean).join('\n'),
    complete,
    issueCount,
    failed: failed > 0,
    allFailed,
    positions,
  };
}

async function runSweep(owners, chainKeys, opts) {
  const {
    showWalletAttribution,
    mode = 'full',
    currentScopes = null,
    preserveExistingView = false,
    ...loadOptions
  } = opts;
  const jobs = [];
  const seen = new Set();
  for (const o of owners) {
    if (seen.has(o.address)) continue;
    seen.add(o.address);
    for (const chainKey of chainKeys) jobs.push({ owner: o.address, label: o.label, chainKey });
  }
  latestPortfolioShowsWallet = typeof showWalletAttribution === 'boolean'
    ? showWalletAttribution
    : new Set(jobs.map((job) => job.owner).filter(Boolean)).size > 1;
  const states = {};
  const paint = () => {
    const snap = sweepStatus(states, jobs, latestPortfolioShowsWallet);
    const preserveView = mode === 'current' && preserveExistingView
      && (!snap.complete || snap.issueCount > 0);
    const shown = preserveView
      ? { visible: [], hidden: [] }
      : paintPortfolio(snap.positions);
    const text = snap.text;
    const summary = snap.summary;
    latestSweepText = snap.text;
    latestSweepSummary = snap.summary;
    latestSweepDetails = snap.details;
    latestSweepIssues = snap.issueCount;
    statusEl.className = snap.allFailed ? 'status error' : 'status';
    if (SIDE_PANEL) presentScanStatus(summary, snap.details, snap.issueCount);
    else statusEl.textContent = text;
    return {
      ...snap,
      text,
      summary,
      details: snap.details,
      positions: shown.visible,
      allPositions: snap.positions,
      hiddenPositions: shown.hidden,
    };
  };
  const progressOptions = {
    ...loadOptions,
    onProgress: async (ev) => {
      if (ev.phase === 'start') {
        states[jobKey(ev)] = { phase: 'start' };
        if (mode !== 'current') paint();
        return;
      }
      states[jobKey(ev)] = ev;
      paint();
    },
  };
  if (mode === 'current') {
    await loadKnownSweep(owners, chainKeys, currentScopes, progressOptions);
  } else {
    await loadSweep(owners, chainKeys, progressOptions);
  }
  return { ...paint(), jobs, states };
}

function signedMoney(value) {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const digits = abs < 100 ? 2 : 0;
  const body = '$' + abs.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return value > 0 ? `+${body}` : value < 0 ? `−${body}` : body;
}

const deltaTone = (value) => value > 0 ? 'up' : value < 0 ? 'down' : 'muted';
const readableRangeStatus = (status) => ({
  'in-range': 'in range', below: 'below', above: 'above', closed: 'closed',
})[status] || 'unknown';
const inverseRangeStatus = (status) => status === 'below' ? 'above' : status === 'above' ? 'below' : status;

function refreshDeltaBlock(position, priceViews, s0, s1) {
  if (!SIDE_PANEL || !position.refreshDelta) return '';
  const delta = position.refreshDelta;
  if (delta.baseline) {
    return `<section class="refresh-delta baseline" aria-label="Since last refresh tracking">
      <span class="refresh-delta-title">Since last refresh</span>
      <span class="refresh-delta-empty">Tracking started. Refresh again to compare.</span>
    </section>`;
  }
  const metric = (label, value) => Number.isFinite(value)
    ? `<span class="refresh-delta-metric"><small>${esc(label)}</small><b class="${deltaTone(value)}">${esc(signedMoney(value))}</b></span>`
    : '';
  let fees = metric('fees', delta.feesGainedUsd);
  if (!fees && !delta.feesRevised) {
    const tokenBits = [];
    if (Number.isFinite(delta.fees0Delta) && Math.abs(delta.fees0Delta) > 1e-12) {
      tokenBits.push(`${delta.fees0Delta > 0 ? '+' : ''}${fmt(delta.fees0Delta)} ${esc(s0)}`);
    }
    if (Number.isFinite(delta.fees1Delta) && Math.abs(delta.fees1Delta) > 1e-12) {
      tokenBits.push(`${delta.fees1Delta > 0 ? '+' : ''}${fmt(delta.fees1Delta)} ${esc(s1)}`);
    }
    if (tokenBits.length) {
      fees = `<span class="refresh-delta-metric"><small>fees</small><b class="up">${tokenBits.join(' + ')}</b></span>`;
    }
  }
  const transition = delta.statusChanged
    ? priceViews(
      `${esc(readableRangeStatus(delta.fromStatus))} → ${esc(readableRangeStatus(delta.toStatus))}`,
      `${esc(readableRangeStatus(inverseRangeStatus(delta.fromStatus)))} → ${esc(readableRangeStatus(inverseRangeStatus(delta.toStatus)))}`,
    ) : '';
  const notes = [
    transition ? `<span>range ${transition}</span>` : '',
    delta.cashFlowChanged ? '<span>cash flow changed</span>' : '',
    delta.feesRevised ? '<span>fee history was revised</span>' : '',
  ].filter(Boolean).join(' · ');
  const metrics = [
    metric('LP return', delta.lpReturnUsd),
    metric('vs hold', delta.vsHoldingUsd),
    fees,
    metric('value', delta.positionValueUsd),
  ].filter(Boolean).join('');
  return `<section class="refresh-delta" aria-label="Changes since the previous accepted refresh">
    <span class="refresh-delta-title">Since <span data-refresh-baseline-at="${delta.fromAt}">${esc(snapshotAge(delta.fromAt))}</span></span>
    ${metrics ? `<span class="refresh-delta-grid">${metrics}</span>`
      : '<span class="refresh-delta-empty">No comparable metrics this refresh.</span>'}
    ${notes ? `<span class="refresh-delta-notes">${notes}</span>` : ''}
  </section>`;
}

function lineageBlock(position) {
  const lineage = position.lineage;
  if (!SIDE_PANEL || !lineage || !lineage.isHead) return '';
  const count = lineage.memberCount;
  const combined = Number.isFinite(lineage.combinedPnl)
    ? `<span class="lineage-return"><small>combined LP return</small><b class="${deltaTone(lineage.combinedPnl)}">${esc(signedMoney(lineage.combinedPnl))}</b></span>`
    : '<span class="lineage-missing">Full rescan with closed positions to update the combined return.</span>';
  return `<section class="position-lineage" aria-label="Verified position replacement history">
    <span class="lineage-title">Strategy history · ${count} NFTs</span>
    <span class="lineage-proof" title="Receipt proof shows one close, payout, successor NFT mint, and open in the same transaction. It does not prove the same fungible assets funded the new NFT.">verified same transaction</span>
    ${combined}
  </section>`;
}

/**
 * One position card.
 *
 * Composed from the shared renderer so the popup shows exactly what the overlay
 * shows, plus the one thing only this surface has: USD marks from DexScreener,
 * which the overlay does not fetch. Unpriced legs render "unpriced" rather than
 * $0 — a missing mark must never look like a zero balance.
 */
function card(p, prices, locallyHidden = false, showWallet = true) {
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
        ${showWallet ? `<span class="wallet-lbl">${esc(walletName(p))}</span>` : ''}
        <span class="chain-lbl">${esc(chainLabel(p.chainKey))}</span>
        <span class="pill ${statusClass}">${statusText}</span>
      </div>
      ${rangeBar(p, h, flippable)}
      ${hero(p, h, s1)}
      ${refreshDeltaBlock(p, priceViews, s0, s1)}
      ${lineageBlock(p)}
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
        const text = latestSweepText;
        const summary = latestSweepSummary;
        if (SIDE_PANEL) presentScanStatus(summary, latestSweepDetails, latestSweepIssues);
        else statusEl.textContent = text;
        const previous = await readDashboardSnapshot();
        await writeDashboardSnapshot({
          at: previous && previous.at,
          html: dashboardHtmlWithoutLiveProofs(),
          summaryHtml: totalsCard(shown.visible),
          status: summary,
          details: latestSweepDetails,
          issues: latestSweepIssues,
          positions: shown.visible.length,
          wallets: previous && previous.wallets || 1,
          showWalletLabels: latestPortfolioShowsWallet,
          chains: renderedChainKeys || (previous && previous.chains) || selectedPortfolioChainKeys(),
          includeClosed: $('includeClosed').checked,
          refreshScope: renderedRefreshScope || (previous && previous.refreshScope)
            || portfolioRefreshScope,
          refreshMode: renderedRefreshMode || (previous && previous.refreshMode) || 'full',
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
        const previousIssues = previous && previous.issues || 0;
        const previousDetails = previousIssues
          ? 'Some data was unavailable in this saved refresh. Refresh for current details.'
          : '';
        presentScanStatus('Hidden preference saved locally.', previousDetails, previousIssues);
        dashboardStatusBase = previous
          ? dashboardSnapshotStatus(previous)
          : 'Refresh to recalculate portfolio totals.';
        renderedChainKeys = renderedChainKeys
          || (previous && previous.chains)
          || selectedPortfolioChainKeys();
        renderedRefreshScope = renderedRefreshScope
          || (previous && previous.refreshScope)
          || portfolioRefreshScope;
        renderedRefreshMode = renderedRefreshMode
          || (previous && previous.refreshMode)
          || 'full';
        setSnapshotStatus(dashboardStatusBase);
        paintNetworkSelectionNotice();
        await writeDashboardSnapshot({
          at: previous && previous.at,
          html: dashboardHtmlWithoutLiveProofs(),
          summaryHtml: '',
          status: statusEl.textContent,
          details: previousDetails,
          issues: previousIssues,
          positions: visibleCount,
          wallets: previous && previous.wallets || 1,
          showWalletLabels: previous && previous.showWalletLabels,
          chains: renderedChainKeys || (previous && previous.chains) || selectedPortfolioChainKeys(),
          includeClosed: $('includeClosed').checked,
          refreshScope: renderedRefreshScope,
          refreshMode: renderedRefreshMode,
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
