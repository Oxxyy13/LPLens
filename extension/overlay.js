/**
 * On-page overlay for app.uniswap.org position pages.
 *
 * SECURITY POSTURE — read this before changing anything here.
 *
 * This is the only LPLens code that runs on a web page, and it runs on the
 * page where transactions get approved. Three properties keep that safe, and
 * all three are load-bearing:
 *
 *   1. APPEND-ONLY. It adds exactly one node and never reads, moves, or
 *      rewrites anything Uniswap rendered. It therefore cannot alter what you
 *      are shown before you sign.
 *   2. ISOLATED WORLD. Content scripts cannot see page JavaScript, so
 *      `window.ethereum` and the wallet are unreachable from here by
 *      construction rather than by good behaviour.
 *   3. NO NETWORK. MV3 content scripts have no cross-origin privileges. Every
 *      RPC call happens in the service worker; this file only messages it.
 *
 * ANCHORING. Nothing here selects a Uniswap CSS class. Their markup is Tamagui
 * atomics (`_flexDirection-_lg_column`) and styled-components hashes
 * (`sc-dNFkOE`), both of which change between deploys. The URL carries chain
 * and tokenId and is a routing contract rather than a styling detail, so the
 * URL is the anchor and the panel is positioned independently of their tree.
 * Verified against the live site 2026-08-18.
 */

// Shared renderer, loaded ahead of this file by the manifest. Keeping these
// in one place is what stops the popup and the overlay drifting apart again.
const { CSS, esc, fmt, humanSpan, ageText, priceText, hero, rangeBar, details, rebalanceLine } = globalThis.LPLens;

// v4 reads through a different manager and view contract, but the URL shape
// is identical, so the route captures the version and passes it through.
const ROUTE = /^\/positions\/(v3|v4)\/([a-z0-9-]+)\/(\d+)/i;

// Uniswap URL slug -> LPLens chain key.
//
// Robinhood Chain was omitted here originally on the assumption that
// app.uniswap.org does not serve chain 4663. That was wrong — verified
// 2026-08-18, /positions/v3/robinhood/<id> renders a full position page. It is
// also the one chain where LPLens has lifetime history keylessly, so it is the
// best chain for the overlay rather than the worst.
const CHAIN_SLUGS = {
  ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum',
  polygon: 'polygon', robinhood: 'robinhood',
};

const HOST_ID = 'lplens-overlay-host';
const LIST_HOST_ID = 'lplens-list-host';
// The list route is /positions with no position id after it.
const LIST_ROUTE = /^\/positions\/?$/;
let lastKey = null;


function mount() {
  const existing = document.getElementById(HOST_ID);
  if (existing) return existing.__shadow;

  const host = document.createElement('div');
  host.id = HOST_ID;
  // Closed: nothing on the page can reach inside, and our styles cannot leak
  // out into theirs.
  const shadow = host.attachShadow({ mode: 'closed' });
  // Constructed stylesheets are not parsed from document source, so they avoid
  // the page CSP rules that can block an injected <style> tag.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  shadow.adoptedStyleSheets = [sheet];
  const panel = document.createElement('div');
  panel.className = 'panel';
  shadow.appendChild(panel);
  host.__shadow = shadow;
  document.body.appendChild(host);
  return shadow;
}

// Collapsed state is remembered. Without this the panel reopened on every SPA
// navigation and every reload, so "get out of the way of the chart" had to be
// re-done constantly.
let collapsed = false;
// Set once the user opens the panel by hand, so an automatic collapse from a
// tight layout never overrides a deliberate choice.
let userExpanded = false;
// Detail visibility is a preference, not per-position state.
let showDetails = false;
try {
  chrome.storage.local.get('showDetails', (s) => { showDetails = !!(s && s.showDetails); });
} catch { /* orphaned context */ }
try {
  chrome.storage.local.get('panelCollapsed', (s) => {
    collapsed = !!(s && s.panelCollapsed);
    const host = document.getElementById(HOST_ID);
    if (host) host.__shadow.querySelector('.panel').classList.toggle('collapsed', collapsed);
  });
} catch { /* orphaned context; default to open */ }

/* ---------------------------------------------------------------------------
 * Manual resize.
 *
 * placePanel() picks a size that avoids Uniswap's content, but "avoids" and
 * "the size I want" are different things — on a position page the chart and the
 * panel compete for the same column, and only the person looking at it knows
 * which they want bigger right now.
 *
 * A manual size therefore overrides the automatic one and persists. Double-click
 * the grip to drop back to automatic.
 * ------------------------------------------------------------------------- */

let panelSize = null;      // {w, h} once the user has resized
try {
  chrome.storage.local.get('panelSize', (s) => {
    if (s && s.panelSize) {
      panelSize = s.panelSize;
      const host = document.getElementById(HOST_ID);
      if (host) applyPanelSize(host.__shadow.querySelector('.panel'));
    }
  });
} catch { /* orphaned context */ }

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function applyPanelSize(panel) {
  if (!panel || !panelSize) return false;
  panel.style.width = clamp(panelSize.w, 260, innerWidth - 32) + 'px';
  panel.style.maxHeight = clamp(panelSize.h, 140, innerHeight - 32) + 'px';
  return true;
}

function attachGrip(panel, dockedRight) {
  const grip = document.createElement('div');
  // The grip goes on the panel's inner top corner — the two edges that can
  // actually grow, given it is pinned to the bottom and to one side.
  grip.className = 'grip ' + (dockedRight ? 'left' : 'right');
  grip.title = 'Drag to resize · double-click to reset';
  panel.appendChild(grip);

  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const r0 = panel.getBoundingClientRect();
    const x0 = e.clientX, y0 = e.clientY;
    grip.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      // Docked right, dragging left widens; docked left, dragging right widens.
      const dx = dockedRight ? (x0 - ev.clientX) : (ev.clientX - x0);
      const dy = y0 - ev.clientY;          // pinned at the bottom: up = taller
      panelSize = {
        w: clamp(r0.width + dx, 260, innerWidth - 32),
        h: clamp(r0.height + dy, 140, innerHeight - 32),
      };
      applyPanelSize(panel);
    };
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      try { chrome.storage.local.set({ panelSize }); } catch {}
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
  });

  grip.addEventListener('dblclick', (e) => {
    e.preventDefault();
    panelSize = null;
    panel.style.width = '';
    panel.style.maxHeight = '';
    try { chrome.storage.local.remove('panelSize'); } catch {}
    placePanel(panel);
  });
}

/**
 * Adaptive placement for the detail panel.
 *
 * `left: 16px` was an assumption, not a measurement. Uniswap centres its
 * content, so the free margin depends on window width AND zoom: at 100% on a
 * 2333px window the left gutter is 607px and nothing collides, but zoomed in to
 * a 1866px viewport the column starts at x=373 and a 384px panel runs straight
 * into the chart.
 *
 * So measure the content column and dock into whichever side has more room,
 * narrowing to fit. If neither side can hold a usable panel the overlay has to
 * overlap, and it opens collapsed instead of covering the page uninvited.
 */
function placePanel(panel) {
  const main = document.querySelector('main');
  let left = 0, right = innerWidth;
  if (main) {
    const r = main.getBoundingClientRect();
    if (r.width > 200) { left = r.left; right = r.right; }
  }
  const GAP = 16, MIN = 264, MAX = 384;
  const roomLeft = Math.floor(left - GAP * 2);
  const roomRight = Math.floor(innerWidth - right - GAP * 2);

  const useRight = roomRight > roomLeft;
  const room = useRight ? roomRight : roomLeft;
  const width = Math.min(MAX, room);

  // A size the user chose by hand outranks the computed fit.
  if (applyPanelSize(panel)) {
    panel.style.left = useRight ? '' : GAP + 'px';
    panel.style.right = useRight ? GAP + 'px' : '';
    return true;
  }
  panel.style.width = width >= MIN ? width + 'px' : '';
  if (width >= MIN) {
    panel.style.left = useRight ? '' : GAP + 'px';
    panel.style.right = useRight ? GAP + 'px' : '';
    panel.dataset.overlapping = '';
  } else {
    // No usable gutter: sit bottom-right over the page, but start tucked away.
    panel.style.left = '';
    panel.style.right = GAP + 'px';
    panel.dataset.overlapping = '1';
  }
  return width >= MIN;
}

function render(html) {
  const shadow = mount();
  const panel = shadow.querySelector('.panel');
  panel.innerHTML = html;
  const fits = placePanel(panel);
  attachGrip(panel, !panel.style.left);
  panel.classList.toggle('collapsed', collapsed || (!fits && !userExpanded));
  const more = panel.querySelector('#lplens-more');
  if (more) {
    panel.classList.toggle('showmore', showDetails);
    more.textContent = showDetails ? 'hide details' : 'details';
    more.onclick = () => {
      showDetails = !showDetails;
      panel.classList.toggle('showmore', showDetails);
      more.textContent = showDetails ? 'hide details' : 'details';
      try { chrome.storage.local.set({ showDetails }); } catch {}
    };
  }
  const btn = panel.querySelector('#lplens-toggle');
  if (btn) {
    btn.textContent = collapsed ? '+' : '−';
    btn.title = collapsed ? 'expand' : 'collapse';
    btn.onclick = () => {
      collapsed = !collapsed;
      if (!collapsed) userExpanded = true;
      panel.classList.toggle('collapsed', collapsed);
      btn.textContent = collapsed ? '+' : '−';
      btn.title = collapsed ? 'expand' : 'collapse';
      try { chrome.storage.local.set({ panelCollapsed: collapsed }); } catch {}
    };
  }
}

// Showing the running version is not decoration: an MV3 service worker keeps
// executing its old modules until the extension is reloaded, so a stale build
// looks exactly like a broken one. This makes the difference visible.
const VERSION = (() => {
  try { return chrome.runtime.getManifest().version; } catch { return '?'; }
})();

const head = (right) => `
  <div class="hd">
    <span class="brand">LPLens <span class="tag">read-only v${esc(VERSION)}</span></span>
    <span class="right">${right || ''}<button id="lplens-toggle" title="collapse">-</button></span>
  </div>`;


/** Compact duration for a span given in days. */


/** Human age from a unix timestamp; null when the source gave no timestamps. */


function body(d) {
  const s0 = d.token0Meta.symbol, s1 = d.token1Meta.symbol;
  const h = d.history || {};
  const u = d.usd;

  // Deliberately short. The default view answers: did I make money, was LPing
  // the reason, am I still earning, and what is it worth. Everything else is
  // real but secondary, and lives behind the toggle.
  const quick = [];
  if (u && u.totalNow !== null && u.totalNow !== undefined) {
    quick.push(`<div class="kv"><span>value</span><span class="num">$${u.totalNow.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span></div>`);
  }
  if (d.collectable0 !== null) {
    const feeUsd = u && u.collectable !== null && u.collectable !== undefined
      ? `$${u.collectable.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
      : `${fmt(d.collectable0)} ${esc(s0)} + ${fmt(d.collectable1)} ${esc(s1)}`;
    quick.push(`<div class="kv"><span>claimable</span><span class="num">${feeUsd}</span></div>`);
  }

  const statusClass = ({ 'in-range': 'in-range', below: 'below', above: 'above', closed: 'closed' }[d.status]) || '';
  return head(`<span class="pill ${statusClass}">${esc(d.status)}</span>`) + `
    <div class="bd">
      <div class="card-top">
        <span class="pair">${esc(s0)} / ${esc(s1)}</span>
        <span class="fee">${(d.fee / 10000).toFixed(2)}%</span>
      </div>
      ${rangeBar(d, h)}
      ${hero(d, h, s1)}
      ${quick.join('')}
      ${rebalanceLine(d, h, s0, s1)}
      <button class="more" id="lplens-more">details</button>
      <div class="extra">${details(d, h, s0, s1)}</div>
    </div>`;
}

function teardown() {
  const host = document.getElementById(HOST_ID);
  if (host) host.remove();
  lastKey = null;
}

/* ---------------------------------------------------------------------------
 * List page (/positions)
 *
 * Anchoring, verified against the connected list 2026-08-18: every row card IS
 * an `a[href*="/positions/v"]`, and the href carries version, chain and
 * tokenId. Cards sit in the empty gutter left of Uniswap's centred column,
 * aligned to their row, so nothing is covered.
 *
 * LOOP SAFETY — the first version of this hung the browser, so the rules that
 * prevent it are load-bearing and must survive any edit here:
 *
 *   1. The host element is created ONCE and never removed while on this route.
 *      Every subsequent write happens inside its shadow root, and shadow trees
 *      are invisible to a MutationObserver watching the document. Previously
 *      each rescan removed and re-appended the host to document.body — two
 *      observed mutations, which re-fired the observer that triggered them.
 *   2. The rescan key must contain NOTHING that varies with layout.
 *      gutterWidth() is a float from getBoundingClientRect and jitters during
 *      layout settle, so including it made the key differ on every tick and
 *      rebuild forever. Layout changes are handled by repositioning, which
 *      writes only into the shadow root.
 *   3. Observer callbacks are debounced, and a rescan already in flight is
 *      never re-entered.
 * ------------------------------------------------------------------------- */

const GUTTER_MIN = 132;   // narrowest gutter worth rendering into
const GUTTER_GAP = 12;    // space between card and row
const LIST_DEBOUNCE_MS = 300;

let listScanned = null;   // href set of the last successful scan
let listBusy = false;     // a scan is in flight
let listTimer = null;
let gutterRows = [];
let gutterRaf = false;

/** Created once per list visit; never torn down mid-session. */
function listHost() {
  const existing = document.getElementById(LIST_HOST_ID);
  if (existing) return existing;
  const host = document.createElement('div');
  host.id = LIST_HOST_ID;
  const shadow = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  shadow.adoptedStyleSheets = [sheet];
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.style.display = 'none';
  shadow.appendChild(panel);
  const cards = document.createElement('div');
  cards.id = 'cards';
  shadow.appendChild(cards);
  host.__shadow = shadow;
  document.body.appendChild(host);   // the only observed mutation we make
  return host;
}

function teardownList() {
  const host = document.getElementById(LIST_HOST_ID);
  if (host) host.remove();
  gutterRows = [];
  listScanned = null;
}

function gutterWidth() {
  const first = document.querySelector('a[href*="/positions/v"]');
  if (!first) return 0;
  return Math.floor(first.getBoundingClientRect().left - GUTTER_GAP * 2);
}

function placeGutterCards() {
  gutterRaf = false;
  const w = Math.min(190, gutterWidth());
  if (w < GUTTER_MIN) return;
  for (const row of gutterRows) {
    if (!row.el || !row.anchor.isConnected) continue;
    const r = row.anchor.getBoundingClientRect();
    const onScreen = r.bottom > 0 && r.top < innerHeight && r.width > 0;
    row.el.style.display = onScreen ? 'block' : 'none';
    if (!onScreen) continue;
    row.el.style.width = w + 'px';
    row.el.style.left = Math.round(r.left - w - GUTTER_GAP) + 'px';
    row.el.style.top = Math.round(r.top) + 'px';
  }
}

const placeSoon = () => {
  if (gutterRaf) return;
  gutterRaf = true;
  requestAnimationFrame(placeGutterCards);
};

function gutterCard(row) {
  if (!row.data) {
    return `<div class="gc-pair">${esc(row.label || '')}</div><div class="gc-sub">reading…</div>`;
  }
  if (row.data.error) {
    return `<div class="gc-pair">${esc(row.label || '')}</div>
      <div class="gc-sub err">${esc(String(row.data.error)).slice(0, 42)}</div>`;
  }

  const d = row.data, h = d.history || {};
  const v = h.vsHodl;
  const u = d.usd;
  const closed = d.status === 'closed' && h.exit;
  const a = ageText(h.firstTime, closed ? h.lastTime : null);
  const dotClass = ({ 'in-range': 'in-range', below: 'below', above: 'above', closed: 'closed' }[d.status]) || 'closed';
  const tone = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
  const cash = (n) => (n < 0 ? '−' : '+') + '$' + Math.abs(n).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(n) < 1 ? 4 : 2 });

  // Mini range bar. Log scale, same as the detail panel: an out-of-range
  // position earns nothing, and a red marker pinned to the end says so at a
  // glance.
  const lo = Math.min(d.priceLower, d.priceUpper);
  const hi = Math.max(d.priceLower, d.priceUpper);
  let bar = '';
  if (lo > 0 && hi > lo && Number.isFinite(lo) && Number.isFinite(hi)) {
    const nowP = closed ? h.exit.price : d.price;
    const lnLo = Math.log(lo), lnHi = Math.log(hi), lnNow = Math.log(nowP);
    const span = lnHi - lnLo;
    const pad = span * 0.45;
    let viewLo = lnLo - pad, viewHi = lnHi + pad;
    if (lnNow < viewLo) viewLo = lnNow - pad * 0.2;
    if (lnNow > viewHi) viewHi = lnNow + pad * 0.2;
    const view = viewHi - viewLo || 1;
    const pct = (ln) => ((ln - viewLo) / view) * 100;
    const inRange = nowP >= lo && nowP <= hi;
    bar = `<div class="gc-bar"><div class="gc-band ${inRange ? '' : 'out'}" style="left:${pct(lnLo).toFixed(1)}%;width:${(pct(lnHi) - pct(lnLo)).toFixed(1)}%"></div><div class="gc-mark" style="left:${pct(lnNow).toFixed(1)}%"></div></div>`;
  }

  // Dollars lead. "Did I make money" is the first question anyone has on this
  // page, and showing only vs-holding answered a different one — a position up
  // $15.94 displayed as -3.4% and read as a loss. vs-holding stays directly
  // underneath, because the two genuinely disagree in sign and both matter.
  const hasTotal = u && u.pnl !== null && u.pnl !== undefined;
  const headline = hasTotal ? cash(u.pnl) : (v ? `${v.pct > 0 ? '+' : ''}${v.pct.toFixed(2)}%` : '—');
  const headTone = hasTotal ? tone(u.pnl) : (v ? tone(v.pct) : '');

  const lines = [];
  if (hasTotal) {
    lines.push(`<span class="${tone(u.pnlPct)}">${u.pnlPct >= 0 ? '+' : ''}${u.pnlPct.toFixed(1)}%</span> on gross added`);
  }
  if (v) {
    lines.push(`<span class="${tone(v.pct)}">${v.pct >= 0 ? '+' : ''}${v.pct.toFixed(2)}%</span> vs holding`);
  }
  if (v && v.apr !== null && v.apr !== undefined) {
    lines.push(`<span class="muted">${v.apr.toFixed(0)}% APR${v.aprDays !== null && v.aprDays < 7 ? '*' : ''}</span>`);
  }

  return `<div class="gc-pair"><span class="gc-dot ${dotClass}"></span>${esc(d.token0Meta.symbol)}/${esc(d.token1Meta.symbol)} <span class="gc-fee">${(d.fee / 10000).toFixed(2)}%</span></div>
    <div class="gc-lbl">${hasTotal ? 'LP return' : 'vs holding'}</div>
    <div class="gc-val ${headTone}">${headline}</div>
    ${lines.length ? `<div class="gc-sub">${lines.join('<br>')}</div>` : ''}
    ${bar}
    <div class="gc-sub">${esc([closed ? 'closed' : d.status, a ? a.dur : null].filter(Boolean).join(' · '))}</div>`;
}

async function syncList() {
  if (listBusy) return;
  const anchors = [...document.querySelectorAll('a[href*="/positions/v"]')];
  if (!anchors.length) return teardownList();

  // Layout-independent by design — see LOOP SAFETY note 2.
  const key = anchors.map((a) => a.getAttribute('href')).join('|');
  if (key === listScanned) return placeSoon();

  listBusy = true;
  try {
    listScanned = key;
    const shadow = listHost().__shadow;
    const cards = shadow.getElementById('cards');
    const panel = shadow.querySelector('.panel');

    const rows = [];
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') || '';
      const m = href.match(/^\/positions\/(v\d)\/([a-z0-9-]+)\/(\d+)/i);
      if (!m) continue;
      const chain = CHAIN_SLUGS[m[2].toLowerCase()];
      rows.push({
        href, anchor,
        label: (anchor.innerText || '').split('\n')[0].slice(0, 18),
        v4: m[1].toLowerCase() !== 'v3',
        chain,
        tokenId: m[3],
        // An unreadable row still gets a card saying why; a silently absent one
        // would read as "nothing to report" on a position we cannot see.
        data: chain ? null : { error: `chain ${m[2]} not supported` },
      });
    }
    if (!rows.length) return;

    const wide = gutterWidth() >= GUTTER_MIN;
    let paint;

    if (wide) {
      panel.style.display = 'none';
      cards.innerHTML = '';
      gutterRows = rows;
      for (const row of rows) {
        const el = document.createElement('div');
        el.className = 'gc';
        el.innerHTML = gutterCard(row);
        cards.appendChild(el);        // inside shadow: not observed
        row.el = el;
      }
      paint = () => {
        for (const row of rows) if (row.el) row.el.innerHTML = gutterCard(row);
        placeSoon();
      };
      placeSoon();
    } else {
      // Too narrow for a gutter, so the docked panel overlaps instead.
      gutterRows = [];
      cards.innerHTML = '';
      panel.style.display = '';
      if (innerWidth < 1500) panel.classList.add('collapsed');
      paint = () => {
        panel.innerHTML = head(`<span class="pill">${rows.length}</span>`) +
          `<div class="bd" style="padding:8px 10px">${rows.map(listCard).join('')}</div>`;
        const btn = panel.querySelector('#lplens-toggle');
        if (btn) btn.onclick = () => panel.classList.toggle('collapsed');
      };
      paint();
    }

    for (const row of rows) {
      if (row.v4 || !row.chain || row.data) continue;
      if (!contextAlive()) return shutdownOrphan('list');
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'LPLENS_POSITION', chain: row.chain, tokenId: row.tokenId,
        });
        row.data = res && res.ok ? res.data : { error: (res && res.error) || 'no response' };
      } catch (err) {
        if (isOrphanError(err)) return shutdownOrphan('list');
        row.data = { error: err.message || String(err) };
      }
      if (listScanned !== key) return;   // rows changed while we were fetching
      paint();
    }
  } finally {
    listBusy = false;
  }
}

const scheduleList = () => {
  clearTimeout(listTimer);
  listTimer = setTimeout(() => {
    if (torndown) return;
    if (!contextAlive()) return shutdownOrphan('list');
    if (LIST_ROUTE.test(location.pathname)) syncList();
  }, LIST_DEBOUNCE_MS);
};

addEventListener('scroll', placeSoon, { passive: true, capture: true });
addEventListener('resize', () => {
  placeSoon();
  // Zoom fires resize, and zoom is exactly what shrinks the gutter.
  const host = document.getElementById(HOST_ID);
  if (host) placePanel(host.__shadow.querySelector('.panel'));
}, { passive: true });

// Debounced, and it never reacts to our own writes: everything except the
// one-time host append happens inside the shadow root, which this cannot see.
const listObserver = new MutationObserver(scheduleList);
listObserver.observe(document.documentElement, { childList: true, subtree: true });

/**
 * Orphaned-content-script handling.
 *
 * Reloading or updating the extension leaves the previously injected content
 * script running in every open tab, but its `chrome.runtime` handle is dead —
 * any sendMessage throws "Extension context invalidated". This happens to every
 * user on every extension update, not just during development.
 *
 * Two things must follow from it. The panel has to say what actually happened
 * and what fixes it, rather than reporting "Failed:" as though the chain were
 * unreachable. And the orphan has to stop working: its poll timer and mutation
 * observer would otherwise keep running for the life of the tab, doing nothing
 * useful forever.
 */
const contextAlive = () => {
  try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; }
};

const isOrphanError = (err) =>
  /extension context invalidated|receiving end does not exist|message port closed/i
    .test(String((err && err.message) || err || ''));

let torndown = false;
function shutdownOrphan(target) {
  if (torndown) return;
  torndown = true;
  try { clearInterval(pollTimer); } catch {}
  try { clearTimeout(listTimer); } catch {}
  try { listObserver.disconnect(); } catch {}
  const html = head() + `<div class="bd"><div class="note">LPLens was reloaded or
    updated, so this page is running an old copy of it. <b>Refresh the page</b>
    to reconnect.</div></div>`;
  // Paint into whichever surface is on screen, then stop touching the page.
  try {
    if (target === 'list') {
      const host = document.getElementById(LIST_HOST_ID);
      if (host) {
        const sh = host.__shadow;
        sh.getElementById('cards').innerHTML = '';
        const panel = sh.querySelector('.panel');
        panel.style.display = '';
        panel.classList.remove('collapsed');
        panel.innerHTML = html;
      }
    } else {
      render(html);
    }
  } catch {}
}

async function sync() {
  if (LIST_ROUTE.test(location.pathname)) {
    teardown();
    return syncList();
  }
  teardownList();

  const m = location.pathname.match(ROUTE);
  if (!m) return teardown();

  const version = m[1].toLowerCase();
  const chain = CHAIN_SLUGS[m[2].toLowerCase()];
  const tokenId = m[3];
  if (!chain) return teardown();

  const key = `${chain}:${version}:${tokenId}`;
  if (key === lastKey) return;
  lastKey = key;

  render(head() + `<div class="bd"><div class="note">Reading position #${esc(tokenId)} on ${esc(chain)}…</div></div>`);

  if (!contextAlive()) return shutdownOrphan();
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'LPLENS_POSITION', chain, tokenId, version });
  } catch (err) {
    if (isOrphanError(err)) return shutdownOrphan();
    res = { ok: false, error: err.message || String(err) };
  }
  if (lastKey !== key) return; // navigated away while the read was in flight

  // A gated response is not an error: say what happened and what fixes it.
  // `allowed` is the live verdict — while GATING_ENABLED is false the worker
  // never sets gated, and state 'free' must not render as a trial expiry.
  if (res && res.gated && res.entitlement && !res.entitlement.allowed) {
    const e = res.entitlement || {};
    const lbl = e.state === 'misconfigured' ? 'this build is not finished'
      : e.state === 'needs_key' ? 'invite-only beta'
      : e.state === 'invalid' ? 'access not granted'
      : e.state === 'expired' ? 'trial ended'
      : 'access required';
    const hint = e.state === 'needs_key'
      ? ' Paste the access key you were sent into the extension\'s options.'
      : e.state === 'misconfigured'
        ? ' The access-check Worker has not been pointed at yet.'
        : ' Check options or ask Dan.';
    render(head() + `<div class="bd">
      <div class="hero"><div class="herolbl">${esc(lbl)}</div>
      <div class="heroval muted" style="font-size:18px">LPLens</div></div>
      <div class="note">${esc(e.reason || '')}${hint}</div></div>`);
    return;
  }
  if (!res || !res.ok) {
    render(head() + `<div class="bd"><div class="err">Failed: ${esc(res && res.error || 'no response')}</div></div>`);
    return;
  }
  render(body(res.data));
}

// SPA routing.
//
// Uniswap never reloads between positions, so the script must notice URL
// changes itself. The obvious approach — monkey-patching history.pushState —
// DOES NOT WORK here and was a real bug in the first version: content scripts
// run in an isolated world, so patching pushState rebinds it only in that
// world, while Uniswap's router calls the main world's copy. The patch never
// fired, and clicking into a position rendered nothing.
//
// popstate is a genuine event and does cross, so back/forward always worked,
// which made the breakage look intermittent rather than total.
//
// Polling location.href is the boring approach that actually holds: it needs no
// cooperation from the page, survives whatever router they ship next, and a
// string compare every 400ms is free.
const POLL_MS = 400;
let lastHref = location.href;

const pollTimer = setInterval(() => {
  if (!contextAlive()) return shutdownOrphan();
  if (location.href === lastHref) return;
  lastHref = location.href;
  sync();
}, POLL_MS);

// Kept as a fast path: popstate fires immediately, ahead of the next poll tick.
window.addEventListener('popstate', () => {
  lastHref = location.href;
  setTimeout(sync, 50);
});

sync();
