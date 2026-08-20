import { loadSweep, valueUsd } from './lib/positions.js';
import { CHAINS } from './lib/chains.js';
import { entitlement, TRIAL_LENGTH_DAYS, GATING_ENABLED, gateHeadline, gateHint } from './lib/license.js';
import {
  loadBook, upsertWallet, removeWallet, MAX_SAVED_ADDRESSES, normalizeAddress,
  shortAddr, walletName,
} from './lib/wallets.js';
import { summarizeAggregate } from './lib/aggregate.js';

const $ = (id) => document.getElementById(id);
const form = $('form'), statusEl = $('status'), resultsEl = $('results');

// Shared renderer, loaded as a classic script by popup.html before this module.
// The popup and the on-page overlay had drifted badly — every feature from 0.4
// to 0.8 landed only in the overlay — so both now render through one copy.
const { esc, fmt, ageText, priceText, hero, rangeBar, details, rebalanceLine, CSS_COMPONENTS } = globalThis.LPLens;

// The overlay renders inside a shadow root; the popup has none, so the shared
// component styles are injected once here. Only the components — the overlay's
// fixed-position panel and gutter rules would fight the popup's own layout.
document.head.appendChild(document.createElement('style')).textContent = CSS_COMPONENTS;
const usd = (n) =>
  n === null || n === undefined || !isFinite(n)
    ? null
    : '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let book = [];

chrome.storage.local.get(['address', 'chain'], async (s) => {
  book = await loadBook();
  if (s.address) $('address').value = s.address;
  else if (book[0]) $('address').value = book[0].address;
  // Pre-0.22 stored a single-chain pick. Scanning is always every chain
  // now; leaving the key would let an old `chain: 'robinhood'` silently
  // pin a user to one network if anything still read it.
  if (Object.prototype.hasOwnProperty.call(s, 'chain')) {
    chrome.storage.local.remove('chain');
  }
  paintBook();
  paintScanHint();
});

function paintScanHint() {
  const hint = $('scanHint');
  if (!hint) return;
  const closed = $('includeClosed').checked;
  hint.hidden = false;
  const bits = [
    'Always scans Ethereum, Base, Arbitrum, Polygon and Robinhood.',
    'Empty is “nothing”; a failure is named.',
  ];
  if (closed) bits.push('Include closed walks up to 60 per chain — this can take a while.');
  hint.textContent = bits.join(' ');
}
$('includeClosed').addEventListener('change', paintScanHint);
paintScanHint();

function fieldAddress() {
  return normalizeAddress($('address').value);
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
    load.title = 'Use this address';
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
  const scanAll = $('scanAll');
  if (scanAll) {
    scanAll.disabled = !unlocked || n === 0;
    scanAll.title = n === 0 ? 'Save at least one address first' : 'Scan every saved wallet';
  }
  paintAddButton();
  paintScanHint();
}

$('address').addEventListener('input', paintAddButton);

$('addWallet').addEventListener('click', async () => {
  if ($('addWallet').disabled) return;
  const r = await upsertWallet($('address').value, '');
  book = r.book;
  paintBook();
  if (r.error) {
    statusEl.className = 'status error';
    statusEl.textContent = r.error;
    return;
  }
  statusEl.className = 'status';
  statusEl.textContent = 'Saved.';
  setTimeout(() => { if (statusEl.textContent === 'Saved.') statusEl.textContent = ''; }, 1500);
});

$('savedList').addEventListener('click', async (e) => {
  const row = e.target.closest && e.target.closest('.saved-row');
  if (!row) return;
  const addr = row.dataset.address;
  if (e.target.closest('.saved-remove')) {
    // Instant — an address costs nothing to re-add. No confirm(), no dialog.
    book = await removeWallet(addr);
    paintBook();
    paintAddButton();
    return;
  }
  if (e.target.closest('.saved-load')) {
    $('address').value = addr;
    paintAddButton();
  }
});

$('savedList').addEventListener('change', async (e) => {
  const input = e.target.closest && e.target.closest('.saved-label');
  if (!input) return;
  const row = input.closest('.saved-row');
  if (!row) return;
  const r = await upsertWallet(row.dataset.address, input.value);
  book = r.book;
});

function setFormInteractive(on) {
  $('address').disabled = !on;
  $('go').disabled = !on;
  paintBook();
}

function showGate(ent) {
  setFormInteractive(false);
  statusEl.className = 'status error';
  statusEl.textContent = ent.reason || gateHeadline(ent.state);
  resultsEl.innerHTML = paywall(ent);
}

// First paint (popup.html) already has the address + Load disabled and
// "Checking access…" in #status, so we never show a working form and then
// yank it. The verdict replaces that: a gate card, or the ordinary form.
(async function gateOnOpen() {
  if (!GATING_ENABLED) {
    setFormInteractive(true);
    statusEl.textContent = '';
    return;
  }
  try {
    const ent = await entitlement();
    if (!ent.allowed) {
      showGate(ent);
      return;
    }
    setFormInteractive(true);
    statusEl.className = 'status';
    statusEl.textContent = '';
    resultsEl.innerHTML = '';
  } catch (err) {
    showGate({
      allowed: false,
      state: 'invalid',
      reason: err.message || String(err),
    });
  }
})();

async function startScan(owners, includeClosed) {
  chrome.storage.local.set({
    address: owners.length === 1 ? owners[0].address : ($('address').value || ''),
  });
  $('go').disabled = true;
  $('scanAll').disabled = true;
  statusEl.className = 'status';
  const chainKeys = Object.keys(CHAINS);
  const nJobs = owners.length * chainKeys.length;
  statusEl.textContent =
    `Scanning ${owners.length} wallet${owners.length === 1 ? '' : 's'} × ${chainKeys.length} chains (${nJobs} jobs, 2 at a time)…`;
  resultsEl.innerHTML = '';
  try {
    // Recheck on submit even though we already checked on open: a key can
    // expire (or be revoked) while the popup sits open. The second call is
    // cheap — licenseSeen caches for RECHECK_HOURS, so this is not a second
    // network round-trip on the normal path.
    const ent = await entitlement();
    if (GATING_ENABLED && !ent.allowed) {
      showGate(ent);
      return;
    }
    if (GATING_ENABLED && ent.state === 'trial') {
      statusEl.textContent = `Trial — ${ent.daysLeft} day${ent.daysLeft === 1 ? '' : 's'} left of ${TRIAL_LENGTH_DAYS} · reading chain…`;
    }
    const settings = await chrome.storage.local.get(['rpcOverrides', 'etherscanKey']);
    await runSweep(owners, Object.keys(CHAINS), {
      includeClosed,
      rpcOverrides: settings.rpcOverrides || {},
      etherscanKey: settings.etherscanKey || null,
      withUsd: true,
    });
  } catch (err) {
    statusEl.className = 'status error';
    statusEl.textContent = 'Failed: ' + (err.message || err);
  } finally {
    if (!$('address').disabled) {
      $('go').disabled = false;
      $('scanAll').disabled = book.length === 0;
    }
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
  await startScan([{ address: typed, label: known ? known.label : '' }], includeClosed);
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

function totalsCard(positions) {
  const a = summarizeAggregate(positions);
  if (!a.n) return '';
  return `<div class="card totals">
    <div class="tot-line"><span class="k">vs holding</span>${esc(a.vsLine.replace(/^vs holding\s*/, ''))}</div>
    <div class="tot-line"><span class="k">total return</span>${esc(a.returnLine.replace(/^total return\s*/, ''))}</div>
    <div class="tot-line"><span class="k">now</span>${esc(a.valueLine.replace(/^now\s*/, ''))}</div>
  </div>`;
}

function sweepStatus(states, jobs) {
  const bits = [];
  const failed = [];
  const positions = [];
  let done = 0;
  let inflight = 0;
  for (const job of jobs) {
    const s = states[jobKey(job)];
    bits.push(jobOutcome(job, s));
    if (!s || s.phase === 'start') inflight++;
    else if (s.ok === false) {
      done++;
      failed.push(`${jobLabel(job)} failed: ${s.error || 'unknown error'}`);
    } else {
      done++;
      if (s.result && s.result.positions) positions.push(...s.result.positions);
    }
  }
  const head = [`${done}/${jobs.length}`];
  if (inflight) head.push(`${inflight} in flight`);
  if (positions.length) head.push(`${positions.length} shown`);
  else if (done === jobs.length && !failed.length) {
    head.push('No Uniswap v3 position NFTs held');
  }
  const line = [...head, ...bits].join(' · ');
  const allFailed = done === jobs.length && failed.length === jobs.length;
  return { text: line, failed: failed.length > 0, allFailed, positions };
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
  const paint = () => {
    const snap = sweepStatus(states, jobs);
    statusEl.className = snap.allFailed ? 'status error' : 'status';
    statusEl.textContent = snap.text;
    resultsEl.innerHTML = totalsCard(snap.positions)
      + snap.positions.map((p) => card(p, {})).join('');
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
  paint();
}

/**
 * One position card.
 *
 * Composed from the shared renderer so the popup shows exactly what the overlay
 * shows, plus the one thing only this surface has: USD marks from DexScreener,
 * which the overlay does not fetch. Unpriced legs render "unpriced" rather than
 * $0 — a missing mark must never look like a zero balance.
 */
function card(p, prices) {
  const table = (p.chainKey && prices[p.chainKey] && typeof prices[p.chainKey] === 'object')
    ? prices[p.chainKey] : prices;
  const s0 = p.token0Meta.symbol, s1 = p.token1Meta.symbol;
  const p0 = table[p.token0.toLowerCase()], p1 = table[p.token1.toLowerCase()];
  const h = p.history || {};
  const u = p.usd;
  const lo = Math.min(p.priceLower, p.priceUpper);
  const hi = Math.max(p.priceLower, p.priceUpper);

  // Same restraint as the overlay: answer the question, then offer the rest.
  const value = u && u.totalNow !== null && u.totalNow !== undefined
    ? '$' + u.totalNow.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : (valueUsd(p.amount0, p.amount1, p0, p1) !== null
        ? usd(valueUsd(p.amount0, p.amount1, p0, p1)) : 'unpriced');

  const fees = u && u.collectable !== null && u.collectable !== undefined
    ? '$' + u.collectable.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : `${fmt(p.collectable0)} ${esc(s0)} + ${fmt(p.collectable1)} ${esc(s1)}`;

  const entry = h.entry
    ? (h.entry.exact
        ? fmt(h.entry.price, 8)
        : `${esc(h.entry.bound)} ${fmt(h.entry.price, 8)}`)
    : (h.unavailable ? '—' : '—');
  const entryNote = h.entry && !h.entry.exact
    ? (h.entry.bound === 'at or below' ? 'at least' : h.entry.bound === 'at or above' ? 'at most' : h.entry.bound)
    : (h.entry ? 'solved from mint' : (h.unavailable ? 'unavailable' : ''));

  const statusClass = ({ 'in-range': 'in-range', below: 'below', above: 'above', closed: 'closed' }[p.status]) || '';

  return `
    <div class="card">
      <div class="card-top">
        <span class="pair">${esc(s0)} / ${esc(s1)}</span>
        <span class="fee">${(p.fee / 10000).toFixed(2)}%</span>
        <span class="wallet-lbl">${esc(walletName(p))}</span>
        <span class="chain-lbl">${esc(chainLabel(p.chainKey))}</span>
        <span class="pill ${statusClass}">${esc(p.status)}</span>
      </div>
      ${rangeBar(p, h)}
      ${hero(p, h, s1)}
      <div class="stats">
        <div class="stat">
          <span class="stat-l">collectable</span>
          <span class="stat-v muted">${fees}</span>
        </div>
        <div class="stat">
          <span class="stat-l">entry</span>
          <span class="stat-v muted">${entry}</span>
          <span class="stat-n">${esc(entryNote)}</span>
        </div>
      </div>
      ${rebalanceLine(p, h, s0, s1)}
      <button class="more" data-more="${p.tokenId}">details</button>
      <div class="extra">
        <div class="kv"><span>value</span><span class="num">${value}</span></div>
        <div class="kv"><span>current price</span><span class="num">${fmt(p.price, 8)}</span></div>
        <div class="kv"><span>range</span><span class="num">${fmt(lo, 8)} – ${fmt(hi, 8)}</span></div>
        <div class="kv"><span>holds</span><span class="num">${fmt(p.amount0)} ${esc(s0)}<br>${fmt(p.amount1)} ${esc(s1)}</span></div>
        <div class="meta">#${p.tokenId}${p.version ? ' · ' + esc(p.version) : ''}</div>
        ${details(p, h, s0, s1)}
      </div>
    </div>`;
}

// One handler for every card, added once rather than per render.
document.addEventListener('click', (e) => {
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
