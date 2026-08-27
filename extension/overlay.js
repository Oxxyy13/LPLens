/**
 * On-page overlay for app.uniswap.org position pages, the ProjectX portfolio
 * at www.prjx.com, and Dexscreener pair pages.
 *
 * SECURITY POSTURE — read this before changing anything here.
 *
 * This is the persistent LPLens code that runs on a web page, and it runs on
 * pages where transactions may get approved. Three properties keep that safe,
 * and all three are load-bearing:
 *
 *   1. ADDITIVE. It adds only LPLens-owned nodes and never moves or rewrites
 *      anything Uniswap rendered. It therefore cannot alter what you are shown
 *      before you sign.
 *   2. ISOLATED WORLD. This content script cannot see page JavaScript, so
 *      `window.ethereum` and the wallet remain unreachable from here. The
 *      local Dexscreener chart experiment asks the service worker for a
 *      one-shot chart measurement. It never injects from this file or creates
 *      a persistent bridge.
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
const {
  CSS, esc, fmt, humanSpan, ageText, priceText, hero, rangeBar, details,
  rebalanceLine, dexscreenerOrientation, dexscreenerRangeRuler,
} = globalThis.LPLens;

// The packager blocks this literal. This branch is a local feasibility build,
// not a Chrome Web Store candidate.
const LOCAL_CHART_EXPERIMENT = 'LPLENS_LOCAL_CHART_EXPERIMENT';

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
const DEXSCREENER_CHART_HOST_ID = 'lplens-dexscreener-chart-host';
// The list route is /positions with no position id after it.
const LIST_ROUTE = /^\/positions\/?$/;
const PROJECTX_ROUTE = /^\/portfolio\/?$/;
const ON_DEXSCREENER = location.hostname === 'dexscreener.com';
const DEXSCREENER_CHAIN_SLUGS = Object.freeze({
  ethereum: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum',
  polygon: 'polygon',
  hyperevm: 'hyperevm',
  hyperliquid: 'hyperevm',
  robinhood: 'robinhood',
  robinhoodchain: 'robinhood',
});
let lastKey = null;
let dexscreenerPanelResizeObserver = null;
let finishActiveDexscreenerPanelDrag = null;


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
  panel.className = `panel${ON_DEXSCREENER ? ' dexscreener-panel' : ''}`;
  shadow.appendChild(panel);
  host.__shadow = shadow;
  document.body.appendChild(host);
  if (ON_DEXSCREENER && typeof ResizeObserver === 'function') {
    if (dexscreenerPanelResizeObserver) dexscreenerPanelResizeObserver.disconnect();
    dexscreenerPanelResizeObserver = new ResizeObserver(() => {
      if (!panel.isConnected || panel.classList.contains('dragging')
          || !dexscreenerPanelPlacement) return;
      applyDexscreenerPanelPlacement(panel);
    });
    dexscreenerPanelResizeObserver.observe(panel);
  }
  return shadow;
}

// Collapsed state is remembered. Without this the panel reopened on every SPA
// navigation and every reload, so "get out of the way of the chart" had to be
// re-done constantly.
const PANEL_COLLAPSED_KEY = ON_DEXSCREENER
  ? 'dexscreenerPanelCollapsed'
  : 'panelCollapsed';
let collapsed = false;
let collapsedPreferenceGeneration = 0;
// Set once the user opens the panel by hand, so an automatic collapse from a
// tight layout never overrides a deliberate choice.
let userExpanded = false;
// Detail visibility is a preference, not per-position state.
let showDetails = false;
try {
  chrome.storage.local.get('showDetails', (s) => { showDetails = !!(s && s.showDetails); });
} catch { /* orphaned context */ }
try {
  const loadGeneration = collapsedPreferenceGeneration;
  chrome.storage.local.get(
    ON_DEXSCREENER ? [PANEL_COLLAPSED_KEY, 'panelCollapsed'] : PANEL_COLLAPSED_KEY,
    (s) => {
      if (loadGeneration !== collapsedPreferenceGeneration) return;
      // Migrate the old shared preference once, without continuing to let a
      // Dexscreener choice collapse the Uniswap or ProjectX panel too.
      const hasOwnPreference = Object.prototype.hasOwnProperty.call(
        s || {}, PANEL_COLLAPSED_KEY,
      );
      collapsed = ON_DEXSCREENER && !hasOwnPreference
        ? !!(s && s.panelCollapsed)
        : !!(s && s[PANEL_COLLAPSED_KEY]);
      if (ON_DEXSCREENER && !hasOwnPreference) {
        try { chrome.storage.local.set({ [PANEL_COLLAPSED_KEY]: collapsed }); } catch {}
      }
      const host = document.getElementById(HOST_ID);
      if (host) applyPanelCollapsedUI(host.__shadow.querySelector('.panel'), collapsed);
    },
  );
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

/* ---------------------------------------------------------------------------
 * Dexscreener panel placement.
 *
 * The chart uses nearly every useful pixel, so the overlay has to be movable.
 * Placement is Dexscreener-only: ProjectX must keep its forced-left dock and
 * Uniswap must keep measuring its gutters. Normalized coordinates survive
 * zoom and window-size changes, while every application is clamped on-screen.
 * ------------------------------------------------------------------------- */

const DEXSCREENER_PANEL_PLACEMENT_KEY = 'dexscreenerPanelPlacementV1';
const PANEL_VIEWPORT_MARGIN = 12;
let dexscreenerPanelPlacement = null;
let dexscreenerPanelPlacementGeneration = 0;

// BEGIN PURE OVERLAY PANEL PLACEMENT
function validPanelPlacement(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Number.isFinite(value.x) && Number.isFinite(value.y)
    && value.x >= 0 && value.x <= 1 && value.y >= 0 && value.y <= 1;
}

function resolvePanelPlacement(value, size, viewport, margin = 12) {
  if (!validPanelPlacement(value) || !size || !viewport
      || !Number.isFinite(size.width) || !Number.isFinite(size.height)
      || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)
      || !(size.width > 0) || !(size.height > 0)
      || !(viewport.width > 0) || !(viewport.height > 0)
      || !Number.isFinite(margin) || margin < 0) return null;
  const travelX = Math.max(0, viewport.width - size.width - margin * 2);
  const travelY = Math.max(0, viewport.height - size.height - margin * 2);
  return {
    left: margin + value.x * travelX,
    top: margin + value.y * travelY,
  };
}

function panelPlacementFromRect(rect, viewport, margin = 12) {
  if (!rect || !viewport
      || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)
      || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)
      || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)
      || !(rect.width > 0) || !(rect.height > 0)
      || !(viewport.width > 0) || !(viewport.height > 0)
      || !Number.isFinite(margin) || margin < 0) return null;
  const travelX = Math.max(0, viewport.width - rect.width - margin * 2);
  const travelY = Math.max(0, viewport.height - rect.height - margin * 2);
  const x = travelX > 0 ? (rect.left - margin) / travelX : 0;
  const y = travelY > 0 ? (rect.top - margin) / travelY : 0;
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
  };
}
// END PURE OVERLAY PANEL PLACEMENT

function setPanelPixelPosition(panel, left, top) {
  if (!panel) return false;
  const rect = panel.getBoundingClientRect();
  const maxLeft = Math.max(PANEL_VIEWPORT_MARGIN,
    innerWidth - rect.width - PANEL_VIEWPORT_MARGIN);
  const maxTop = Math.max(PANEL_VIEWPORT_MARGIN,
    innerHeight - rect.height - PANEL_VIEWPORT_MARGIN);
  panel.style.left = clamp(left, PANEL_VIEWPORT_MARGIN, maxLeft) + 'px';
  panel.style.top = clamp(top, PANEL_VIEWPORT_MARGIN, maxTop) + 'px';
  // `bottom` exists in the shared stylesheet, so an empty inline value would
  // reactivate the dock and leave both top and bottom constraining the panel.
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  return true;
}

function applyDexscreenerPanelPlacement(panel) {
  if (!ON_DEXSCREENER || !panel || !validPanelPlacement(dexscreenerPanelPlacement)) return false;
  const rect = panel.getBoundingClientRect();
  const target = resolvePanelPlacement(
    dexscreenerPanelPlacement,
    { width: rect.width, height: rect.height },
    { width: innerWidth, height: innerHeight },
    PANEL_VIEWPORT_MARGIN,
  );
  return !!target && setPanelPixelPosition(panel, target.left, target.top);
}

function rememberDexscreenerPanelPlacement(panel) {
  if (!ON_DEXSCREENER || !panel) return;
  const next = panelPlacementFromRect(
    panel.getBoundingClientRect(),
    { width: innerWidth, height: innerHeight },
    PANEL_VIEWPORT_MARGIN,
  );
  if (!next) return;
  dexscreenerPanelPlacementGeneration += 1;
  dexscreenerPanelPlacement = next;
  applyDexscreenerPanelPlacement(panel);
  try { chrome.storage.local.set({ [DEXSCREENER_PANEL_PLACEMENT_KEY]: next }); } catch {}
}

try {
  if (ON_DEXSCREENER) {
    const loadGeneration = dexscreenerPanelPlacementGeneration;
    chrome.storage.local.get(DEXSCREENER_PANEL_PLACEMENT_KEY, (s) => {
      if (loadGeneration !== dexscreenerPanelPlacementGeneration) return;
      const saved = s && s[DEXSCREENER_PANEL_PLACEMENT_KEY];
      dexscreenerPanelPlacement = validPanelPlacement(saved) ? saved : null;
      const host = document.getElementById(HOST_ID);
      if (host && dexscreenerPanelPlacement) {
        applyDexscreenerPanelPlacement(host.__shadow.querySelector('.panel'));
      }
    });
  }
} catch { /* orphaned context; use automatic placement */ }

function applyPanelSize(panel) {
  // The legacy resize grip assumes a bottom-docked panel. Dexscreener is free
  // positioned now, and its compact mode is the supported smaller footprint.
  if (ON_DEXSCREENER || !panel || !panelSize) return false;
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

function attachDexscreenerPanelDrag(panel) {
  if (!ON_DEXSCREENER || !panel) return;
  const header = panel.querySelector('.hd');
  if (!header) return;
  header.classList.add('panel-drag-handle');
  header.title = 'Drag to move LPLens. Double-click to reset position.';

  header.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target && target.closest('button, a, input, select, textarea, [role="button"]')) return;

    event.preventDefault();
    event.stopPropagation();
    if (finishActiveDexscreenerPanelDrag) finishActiveDexscreenerPanelDrag();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    let finished = false;
    let dragOffsetLeft = 0;
    let dragOffsetTop = 0;
    try { header.setPointerCapture(pointerId); } catch {}

    const onMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      moveEvent.stopPropagation();
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      if (!moved) {
        moved = true;
        dexscreenerPanelPlacementGeneration += 1;
        const currentRect = panel.getBoundingClientRect();
        dragOffsetLeft = currentRect.left - moveEvent.clientX;
        dragOffsetTop = currentRect.top - moveEvent.clientY;
        panel.classList.add('dragging');
      }
      setPanelPixelPosition(
        panel,
        moveEvent.clientX + dragOffsetLeft,
        moveEvent.clientY + dragOffsetTop,
      );
      const livePlacement = panelPlacementFromRect(
        panel.getBoundingClientRect(),
        { width: innerWidth, height: innerHeight },
        PANEL_VIEWPORT_MARGIN,
      );
      if (livePlacement) dexscreenerPanelPlacement = livePlacement;
    };

    let complete;
    const finish = (finishEvent) => {
      if (finishEvent.pointerId !== undefined && finishEvent.pointerId !== pointerId) return;
      finishEvent.stopPropagation();
      complete();
    };
    complete = () => {
      if (finished) return;
      finished = true;
      header.removeEventListener('pointermove', onMove);
      header.removeEventListener('pointerup', finish);
      header.removeEventListener('pointercancel', finish);
      header.removeEventListener('lostpointercapture', finish);
      panel.classList.remove('dragging');
      if (moved) rememberDexscreenerPanelPlacement(panel);
      if (finishActiveDexscreenerPanelDrag === complete) {
        finishActiveDexscreenerPanelDrag = null;
      }
      try {
        if (header.hasPointerCapture(pointerId)) header.releasePointerCapture(pointerId);
      } catch {}
    };
    finishActiveDexscreenerPanelDrag = complete;

    header.addEventListener('pointermove', onMove);
    header.addEventListener('pointerup', finish);
    header.addEventListener('pointercancel', finish);
    header.addEventListener('lostpointercapture', finish);
  });

  header.addEventListener('dblclick', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target && target.closest('button, a, input, select, textarea, [role="button"]')) return;
    event.preventDefault();
    event.stopPropagation();
    dexscreenerPanelPlacementGeneration += 1;
    dexscreenerPanelPlacement = null;
    panel.style.left = '';
    panel.style.top = '';
    panel.style.right = '';
    panel.style.bottom = '';
    try { chrome.storage.local.remove(DEXSCREENER_PANEL_PLACEMENT_KEY); } catch {}
    placePanel(panel);
  });
}

function applyPanelCollapsedUI(panel, isCollapsed) {
  if (!panel) return;
  panel.classList.toggle('collapsed', isCollapsed);
  const button = panel.querySelector('#lplens-toggle');
  if (button) {
    button.textContent = isCollapsed ? '+' : '−';
    button.title = isCollapsed ? 'expand' : 'collapse';
    button.setAttribute('aria-expanded', String(!isCollapsed));
    button.setAttribute('aria-label', `${isCollapsed ? 'Expand' : 'Collapse'} LPLens panel`);
  }
  if (ON_DEXSCREENER && dexscreenerPanelPlacement) {
    applyDexscreenerPanelPlacement(panel);
  }
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

  // ProjectX keeps a floating Support control in the bottom-right corner. Its
  // layout can leave more apparent room on that side, but docking there puts
  // our collapse/expand button underneath the site's control. Keep ProjectX
  // on the browser's left edge; Uniswap retains adaptive gutter placement.
  const forceLeft = PROJECTX_ROUTE.test(location.pathname);
  const useRight = !forceLeft && roomRight > roomLeft;
  const room = useRight ? roomRight : roomLeft;
  const width = Math.min(MAX, room);

  panel.style.top = '';

  // A size the user chose by hand outranks the computed fit.
  if (applyPanelSize(panel)) {
    panel.style.left = useRight ? '' : GAP + 'px';
    panel.style.right = useRight ? GAP + 'px' : '';
    panel.style.bottom = GAP + 'px';
    return true;
  }
  panel.style.width = width >= MIN ? width + 'px' : '';

  // A dragged Dexscreener panel no longer belongs to either gutter. Its saved
  // normalized anchor is applied after width selection so zoom and compacting
  // cannot strand it off-screen.
  if (ON_DEXSCREENER && applyDexscreenerPanelPlacement(panel)) {
    panel.dataset.overlapping = '';
    return true;
  }

  panel.style.bottom = GAP + 'px';
  if (width >= MIN) {
    panel.style.left = useRight ? '' : GAP + 'px';
    panel.style.right = useRight ? GAP + 'px' : '';
    panel.dataset.overlapping = '';
  } else {
    // No usable gutter: overlap from the selected edge. ProjectX still stays
    // left so its toggle cannot collide with the site's Support control.
    panel.style.left = useRight ? '' : GAP + 'px';
    panel.style.right = useRight ? GAP + 'px' : '';
    panel.dataset.overlapping = '1';
  }
  return width >= MIN;
}

function render(html, openWhenOverlapping = false) {
  const shadow = mount();
  const panel = shadow.querySelector('.panel');
  // A network response can rerender the initial Checking card while the user
  // is dragging it. Finish that gesture first so replacing the header cannot
  // redock the panel or strand its old pointer capture.
  if (ON_DEXSCREENER && finishActiveDexscreenerPanelDrag) {
    finishActiveDexscreenerPanelDrag();
  }
  panel.innerHTML = html;
  const fits = placePanel(panel);
  if (!ON_DEXSCREENER) attachGrip(panel, !panel.style.left);
  const startsCollapsed = collapsed || (!fits && !userExpanded && !openWhenOverlapping);
  applyPanelCollapsedUI(panel, startsCollapsed);
  attachDexscreenerPanelDrag(panel);
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
    btn.onclick = () => {
      collapsedPreferenceGeneration += 1;
      collapsed = !panel.classList.contains('collapsed');
      if (!collapsed) userExpanded = true;
      applyPanelCollapsedUI(panel, collapsed);
      try { chrome.storage.local.set({ [PANEL_COLLAPSED_KEY]: collapsed }); } catch {}
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
  <div class="hd${ON_DEXSCREENER ? ' local-experiment-header' : ''}">
    <span class="brand">LPLens <span class="tag">read-only v${esc(VERSION)}</span></span>
    ${ON_DEXSCREENER ? '<span class="panel-drag-mark" aria-hidden="true">⠿</span>' : ''}
    <span class="right">${right || ''}<button id="lplens-toggle" type="button"
      title="collapse" aria-expanded="true" aria-label="Collapse LPLens panel">−</button></span>
    ${ON_DEXSCREENER ? '<span class="local-experiment-banner">local chart experiment</span>' : ''}
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
  if (finishActiveDexscreenerPanelDrag) finishActiveDexscreenerPanelDrag();
  stopDexscreenerChartSession();
  dexscreenerHref = '';
  if (dexscreenerPanelResizeObserver) {
    dexscreenerPanelResizeObserver.disconnect();
    dexscreenerPanelResizeObserver = null;
  }
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
    // Uniswap changed /positions from ~166px cards to 64px table rows in
    // August 2026. A full gutter card beside every dense row overlaps the next
    // one. Geometry chooses presentation; the route remains the semantic
    // anchor, so no generated Uniswap class name enters this decision.
    const dense = r.height < 92;
    row.el.classList.toggle('dense', dense);
    row.el.style.height = dense ? Math.floor(r.height) + 'px' : '';
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

function gutterCard(row, includeRange = true) {
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
  if (includeRange && lo > 0 && hi > lo && Number.isFinite(lo) && Number.isFinite(hi)) {
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
  // The headline has one semantic contract: dollar LP return. A missing USD
  // leg must not replace it with the differently-scoped vs-holding percent;
  // that made two otherwise identical cards answer different questions in the
  // largest type. Keep vs holding below and show an honest dash here.
  const headline = hasTotal ? cash(u.pnl) : '—';
  const headTone = hasTotal ? tone(u.pnl) : '';

  const lines = [];
  const denseLines = [];
  if (hasTotal) {
    lines.push(`<span class="${tone(u.pnlPct)}">${u.pnlPct >= 0 ? '+' : ''}${u.pnlPct.toFixed(1)}%</span> on gross added`);
    denseLines.push(`<span class="${tone(u.pnlPct)}">${u.pnlPct >= 0 ? '+' : ''}${u.pnlPct.toFixed(1)}%</span> gross`);
  }
  if (v) {
    lines.push(`<span class="${tone(v.pct)}">${v.pct >= 0 ? '+' : ''}${v.pct.toFixed(2)}%</span> vs holding`);
    denseLines.push(`<span class="${tone(v.pct)}">${v.pct >= 0 ? '+' : ''}${v.pct.toFixed(2)}%</span> hold`);
  }
  if (v && v.apr !== null && v.apr !== undefined) {
    lines.push(`<span class="muted">${v.apr.toFixed(0)}% APR${v.aprDays !== null && v.aprDays < 7 ? '*' : ''}</span>`);
  }

  return `<div class="gc-pair"><span class="gc-dot ${dotClass}"></span>${esc(d.token0Meta.symbol)}/${esc(d.token1Meta.symbol)} <span class="gc-fee">${(d.fee / 10000).toFixed(2)}%</span></div>
    <div class="gc-main"><div class="gc-lbl">LP return</div><div class="gc-val ${headTone}">${headline}</div></div>
    ${lines.length ? `<div class="gc-sub gc-metrics">${lines.join('<br>')}</div>` : ''}
    ${denseLines.length ? `<div class="gc-sub gc-dense-metrics">${denseLines.join(' · ')}</div>` : ''}
    ${bar}
    <div class="gc-sub gc-status">${esc([closed ? 'closed' : d.status, a ? a.dur : null].filter(Boolean).join(' · '))}</div>`;
}

function portfolioCard(position) {
  return `<div class="portfolio-card">${gutterCard({ data: position })}</div>`;
}

function dexscreenerPortfolioCard(position, pair, wrappedNative, pairError, rangeId = '') {
  const tokenId = position && position.tokenId !== undefined ? String(position.tokenId) : '';
  return `<div class="portfolio-card"${rangeId ? ` data-dex-range-id="${esc(rangeId)}"` : ''}>
    ${gutterCard({ data: position }, false)}
    ${tokenId ? `<div class="gc-sub">position #${esc(tokenId)}</div>` : ''}
    ${dexscreenerRangeRuler(position, pair, wrappedNative, pairError)}
    ${rangeId ? `<div class="dex-range-aligned">
      <span class="dex-range-aligned-copy">Range drawn on chart</span>
      <span class="dex-range-aligned-mode">chart scale pending</span>
    </div><div class="gc-sub dex-chart-status" hidden></div>` : ''}
  </div>`;
}

/**
 * ProjectX portfolio (/portfolio)
 *
 * ProjectX renders its position actions inline and does not put NFT ids in
 * stable semantic links. Reading the connected wallet would violate LPLens's
 * no-wallet boundary, so this panel instead asks the service worker for the
 * active overlay wallet explicitly selected in LPLens. No ProjectX page
 * content is needed or sent anywhere.
 */
let projectxBusy = false;
let projectxPending = false;
async function syncProjectXPortfolio() {
  if (torndown) return;
  const key = 'projectx:portfolio';
  if (projectxBusy) {
    projectxPending = true;
    return;
  }
  if (lastKey === key) return;
  projectxBusy = true;
  lastKey = key;
  teardownList();
  render(head('<span class="pill">ProjectX</span>') +
    '<div class="bd"><div class="note">Reading the active wallet selected in LPLens…</div></div>', true);

  try {
    if (!contextAlive()) return shutdownOrphan();
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'LPLENS_PROJECTX_PORTFOLIO' });
    } catch (err) {
      if (isOrphanError(err)) return shutdownOrphan();
      res = { ok: false, error: err.message || String(err) };
    }
    if (torndown) return;
    if (lastKey !== key) return;

    if (res && res.gated && res.entitlement && !res.entitlement.allowed) {
      const e = res.entitlement || {};
      render(head('<span class="pill">ProjectX</span>') + `<div class="bd">
        <div class="note">${esc(e.reason || 'LPLens access is required.')} Check Options or ask Dan.</div>
      </div>`, true);
      return;
    }
    if (!res || !res.ok) {
      render(head('<span class="pill">ProjectX</span>') + `<div class="bd">
        <div class="err note">${esc(res && res.error || 'no response')}</div>
      </div>`, true);
      return;
    }

    const positions = Array.isArray(res.data && res.data.positions) ? res.data.positions : [];
    const address = String(res.data && res.data.address || '');
    const short = address.length === 42 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
    const content = positions.length
      ? positions.map(portfolioCard).join('')
      : '<div class="note">No open ProjectX positions found for the active wallet.</div>';
    render(head(`<span class="pill">ProjectX · ${positions.length}</span>`) + `<div class="bd">
      <div class="note">Active wallet: <span class="num">${esc(short)}</span>. ProjectX wallet data is not read.</div>
      ${content}
    </div>`, true);
  } finally {
    projectxBusy = false;
    if (torndown) {
      projectxPending = false;
      return;
    }
    if (projectxPending) {
      projectxPending = false;
      lastKey = null;
      void syncProjectXPortfolio();
    }
  }
}

/* ---------------------------------------------------------------------------
 * Local-only Dexscreener chart alignment experiment.
 *
 * The persistent content script stays in Chrome's isolated world. It sends
 * only anonymous numeric ranges plus the exact URL to the service worker. The
 * worker performs a one-shot chart measurement and returns viewport geometry.
 * This layer treats that response as hostile input, paints its own SVG, and
 * never touches the chart, the page's JavaScript, or a wallet provider.
 * ------------------------------------------------------------------------- */

// BEGIN PURE DEXSCREENER CHART RECOVERY
const DEXSCREENER_CHART_POLL_MS = 750;
const DEXSCREENER_CHART_RETRY_MS = [100, 200, 400];
const DEXSCREENER_CHART_NOTICE_MS = 1_500;
const DEXSCREENER_CHART_TRANSIENT_FAILURES = new Set([
  'chart-frame-ambiguous', 'chart-frame-unavailable', 'chart-api-unavailable',
  'unsupported-chart-mode', 'chart-mode-conflict',
  'chart-geometry-unavailable', 'coordinate-unavailable',
  'measurement-failed', 'execution-timeout', 'execution-failed', 'invalid-result',
  'isolated-validation-failed', 'paint-failed',
]);

function planDexscreenerChartRecovery(reason, misses, elapsed) {
  const transient = reason === 'no-response'
    || DEXSCREENER_CHART_TRANSIENT_FAILURES.has(reason);
  const retryIndex = Math.max(0, misses - 1);
  const retry = transient && retryIndex < DEXSCREENER_CHART_RETRY_MS.length
    ? DEXSCREENER_CHART_RETRY_MS[retryIndex]
    : DEXSCREENER_CHART_POLL_MS;
  return {
    transient,
    showFailure: !transient || elapsed >= DEXSCREENER_CHART_NOTICE_MS,
    showAligning: transient && elapsed < DEXSCREENER_CHART_NOTICE_MS,
    delay: retry,
  };
}
// END PURE DEXSCREENER CHART RECOVERY

const DEXSCREENER_CHART_CSS = `
:host {
  all: initial !important; position: fixed !important; inset: 0 !important;
  width: 100vw !important; height: 100vh !important; pointer-events: none !important;
  z-index: 2147482500 !important; contain: strict !important;
}
svg { position: fixed; display: block; overflow: hidden; pointer-events: none; }
.range-band { stroke: none; }
.range-boundary { fill: none; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.range-bracket { fill: none; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.range-label, .mode-label {
  font-family: "Cascadia Mono", "SFMono-Regular", Consolas, ui-monospace, monospace;
  font-size: 10px; font-weight: 700; letter-spacing: .035em;
  paint-order: stroke; stroke: rgba(8, 12, 18, .94); stroke-width: 3px; stroke-linejoin: round;
}
.mode-label { font-size: 9px; fill: #FFD08A; }
`;

let dexscreenerChartTimer = null;
let dexscreenerChartSession = null;

// BEGIN PURE DEXSCREENER CHART GEOMETRY
const DEXSCREENER_CHART_MODES = new Set([
  'price-native', 'price-usd', 'mcap-native', 'mcap-usd',
]);

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateDexscreenerChartGeometry(response, expectedHref, expectedRanges, viewport) {
  const data = response && response.ok === true && response.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)
      || data.href !== expectedHref || !DEXSCREENER_CHART_MODES.has(data.displayMode)
      || typeof data.inverted !== 'boolean') return null;
  const plot = data.plot;
  if (!plot || typeof plot !== 'object' || Array.isArray(plot)) return null;
  const { left, top, width, height } = plot;
  if (![left, top, width, height].every(finiteNumber)
      || width < 120 || height < 100 || width > 20000 || height > 20000
      || Math.abs(left) > 100000 || Math.abs(top) > 100000
      || !viewport || !finiteNumber(viewport.width) || !finiteNumber(viewport.height)
      || left + width <= 0 || top + height <= 0 || left >= viewport.width || top >= viewport.height) return null;

  const rows = data.ranges;
  const expectedIds = new Set(expectedRanges.map((range) => range.id));
  if (!Array.isArray(rows) || rows.length !== expectedIds.size || rows.length > 3) return null;
  const minY = top - height;
  const maxY = top + 2 * height;
  const seen = new Set();
  const normalized = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const expected = expectedRanges[index];
    const ordered = [
      { value: row && row.loValue, y: row && row.loY },
      { value: row && row.nowValue, y: row && row.nowY },
      { value: row && row.hiValue, y: row && row.hiY },
    ].sort((a, b) => a.value - b.value);
    const coordinateOrderValid = ordered.every((point, pointIndex) => pointIndex === 0
      || (data.inverted ? point.y >= ordered[pointIndex - 1].y
        : point.y <= ordered[pointIndex - 1].y));
    const collapsedAtSentinel = row && row.loY === row.hiY
      && (row.loY === minY || row.loY === maxY);
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || typeof row.id !== 'string' || row.id !== expected.id
        || !expectedIds.has(row.id) || seen.has(row.id)
        || !finiteNumber(row.loY) || !finiteNumber(row.hiY) || !finiteNumber(row.nowY)
        || !finiteNumber(row.loValue) || !finiteNumber(row.hiValue) || !finiteNumber(row.nowValue)
        || !(row.loValue > 0) || !(row.hiValue > row.loValue) || !(row.nowValue > 0)
        || [row.loY, row.hiY, row.nowY].some((value) => value < minY || value > maxY)) return null;
    const factors = [row.loValue / expected.lo, row.hiValue / expected.hi,
      row.nowValue / expected.now];
    const factor = factors[0];
    if (!(factor > 0) || factors.some((value) => !finiteNumber(value)
        || Math.abs(value - factor) > Math.max(1e-12, Math.abs(factor) * 1e-9))
        || !coordinateOrderValid
        || (row.loY === row.hiY && !collapsedAtSentinel)) return null;
    seen.add(row.id);
    normalized.push({
      id: row.id, loY: row.loY, hiY: row.hiY, nowY: row.nowY,
      loValue: row.loValue, hiValue: row.hiValue, nowValue: row.nowValue,
    });
  }
  if (seen.size !== expectedIds.size) return null;
  return {
    href: expectedHref,
    displayMode: data.displayMode,
    inverted: data.inverted,
    plot: { left, top, width, height },
    ranges: normalized,
  };
}

function compactChartNumber(value, significant = 4) {
  if (value >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (value >= 1) return value.toLocaleString('en-US', { maximumFractionDigits: 6 });
  if (value >= 1e-6) return Number(value.toPrecision(significant)).toString();
  return value.toExponential(2);
}

function formatDexscreenerChartValue(value, displayMode) {
  if (displayMode.startsWith('mcap-')) {
    const tiers = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (const [divisor, suffix] of tiers) {
      if (value >= divisor) {
        const compact = `${Number((value / divisor).toPrecision(3))}${suffix}`;
        return displayMode === 'mcap-usd' ? `$${compact}` : compact;
      }
    }
    const compact = compactChartNumber(value);
    return displayMode === 'mcap-usd' ? `$${compact}` : compact;
  }
  return displayMode === 'price-usd' ? `$${compactChartNumber(value)}` : compactChartNumber(value);
}

function calculateDexscreenerChartShapes(geometry) {
  const { top, width, height } = geometry.plot;
  const equiv = geometry.displayMode !== 'price-native';
  const modeText = geometry.displayMode === 'price-usd' ? 'CURRENT USD EQUIV'
    : geometry.displayMode.startsWith('mcap-') ? 'CURRENT MCAP EQUIV' : '';
  const xStart = equiv ? width * 0.72 : 0;
  const xEnd = width - 3;
  return {
    equiv, modeText, xStart, xEnd,
    ranges: geometry.ranges.map((range) => {
      const hiY = range.hiY - top;
      const loY = range.loY - top;
      const rawTop = Math.min(hiY, loY);
      const rawBottom = Math.max(hiY, loY);
      const clippedTop = Math.max(0, rawTop);
      const clippedBottom = Math.min(height, rawBottom);
      const bandHeight = Math.max(2.5, clippedBottom - clippedTop);
      return {
        id: range.id, hiY, loY, rawTop, rawBottom,
        hiLabel: formatDexscreenerChartValue(range.hiValue, geometry.displayMode),
        loLabel: formatDexscreenerChartValue(range.loValue, geometry.displayMode),
        whollyAbove: rawBottom < 0,
        whollyBelow: rawTop > height,
        rangeSpansView: rawTop < 0 && rawBottom > height,
        bandHeight,
        bandY: Math.max(0, Math.min(height - bandHeight,
          (clippedTop + clippedBottom - bandHeight) / 2)),
      };
    }),
  };
}
// END PURE DEXSCREENER CHART GEOMETRY

function chartLayerHost() {
  const existing = document.getElementById(DEXSCREENER_CHART_HOST_ID);
  if (existing) return existing.__shadow ? existing : null;
  const host = document.createElement('div');
  host.id = DEXSCREENER_CHART_HOST_ID;
  host.dataset.experiment = LOCAL_CHART_EXPERIMENT;
  host.setAttribute('aria-hidden', 'true');
  for (const [name, value] of Object.entries({
    all: 'initial', position: 'fixed', inset: '0', width: '100vw', height: '100vh',
    pointerEvents: 'none', zIndex: '2147482500', contain: 'strict',
  })) host.style.setProperty(name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), value, 'important');
  const shadow = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(DEXSCREENER_CHART_CSS);
  shadow.adoptedStyleSheets = [sheet];
  host.__shadow = shadow;
  document.documentElement.appendChild(host);
  return host;
}

function resetDexscreenerAlignedCards() {
  const panelHost = document.getElementById(HOST_ID);
  const panelShadow = panelHost && panelHost.__shadow;
  if (!panelShadow) return;
  for (const card of panelShadow.querySelectorAll('[data-dex-range-id]')) {
    card.classList.remove('chart-range-aligned');
    const mode = card.querySelector('.dex-range-aligned-mode');
    if (mode) mode.textContent = 'chart scale pending';
    const status = card.querySelector('.dex-chart-status');
    if (status) {
      status.classList.remove('is-aligning');
      status.hidden = true;
      status.textContent = '';
    }
  }
}

function showDexscreenerChartFailure(reason) {
  const panelHost = document.getElementById(HOST_ID);
  const panelShadow = panelHost && panelHost.__shadow;
  if (!panelShadow) return;
  const safeReason = /^[a-z0-9-]{1,48}$/.test(String(reason || ''))
    ? String(reason) : 'unknown';
  for (const card of panelShadow.querySelectorAll('[data-dex-range-id]')) {
    const status = card.querySelector('.dex-chart-status');
    if (!status) continue;
    status.classList.remove('is-aligning');
    status.textContent = `chart: ${safeReason}`;
    status.hidden = false;
  }
}

function clearDexscreenerChartVisual() {
  const host = document.getElementById(DEXSCREENER_CHART_HOST_ID);
  if (host && host.__shadow) host.remove();
  resetDexscreenerAlignedCards();
}

function showDexscreenerChartAligning() {
  const panelHost = document.getElementById(HOST_ID);
  const panelShadow = panelHost && panelHost.__shadow;
  if (!panelShadow) return;
  for (const card of panelShadow.querySelectorAll('[data-dex-range-id]')) {
    const status = card.querySelector('.dex-chart-status');
    if (!status) continue;
    status.classList.add('is-aligning');
    status.textContent = 'chart aligning';
    status.hidden = false;
  }
}

function stopDexscreenerChartSession() {
  if (dexscreenerChartTimer !== null) clearTimeout(dexscreenerChartTimer);
  dexscreenerChartTimer = null;
  dexscreenerChartSession = null;
  clearDexscreenerChartVisual();
}

function prepareDexscreenerChartRanges(positions, pair, wrappedNative) {
  const ranges = [];
  const rangeIdByIndex = new Map();
  for (let i = 0; i < positions.length && ranges.length < 3; i++) {
    const oriented = dexscreenerOrientation(positions[i], pair, wrappedNative);
    if (!oriented || !oriented.valid || !finiteNumber(oriented.lo)
        || !finiteNumber(oriented.hi) || !finiteNumber(oriented.now)
        || !(oriented.lo > 0) || !(oriented.hi > oriented.lo) || !(oriented.now > 0)) continue;
    const id = `r${ranges.length}`;
    ranges.push({ id, lo: oriented.lo, hi: oriented.hi, now: oriented.now });
    rangeIdByIndex.set(i, id);
  }
  return { ranges, rangeIdByIndex };
}

function appendSvg(parent, name, attrs = {}, text = '') {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text) node.textContent = text;
  parent.appendChild(node);
  return node;
}

function paintDexscreenerChartGeometry(geometry) {
  const { left, top, width, height } = geometry.plot;
  const layout = calculateDexscreenerChartShapes(geometry);
  const { equiv, modeText, xStart, xEnd } = layout;
  const colors = ['#E8A33D', '#55C3B4', '#B4A0FF'];
  const dashes = ['', '8 5', '2 5'];
  const host = chartLayerHost();
  if (!host || !host.__shadow) return false;
  host.style.setProperty('opacity', '1', 'important');
  const shadow = host.__shadow;
  const svg = appendSvg(document.createDocumentFragment(), 'svg', {
    viewBox: `0 0 ${width} ${height}`,
    width, height,
    style: `left:${left}px;top:${top}px;width:${width}px;height:${height}px`,
  });
  svg.setAttribute('aria-hidden', 'true');

  if (equiv) {
    appendSvg(svg, 'rect', {
      x: xStart, y: 0, width: Math.max(0, width - xStart), height,
      fill: 'rgba(232, 163, 61, .025)',
    });
    appendSvg(svg, 'line', {
      x1: xStart, x2: xStart, y1: 0, y2: height,
      class: 'range-bracket', stroke: 'rgba(232, 163, 61, .45)', 'stroke-dasharray': '3 5',
    });
    appendSvg(svg, 'text', { x: xStart + 7, y: 14, class: 'mode-label' }, modeText);
  }

  layout.ranges.forEach((range, index) => {
    const color = colors[index] || colors[0];
    const dash = dashes[index] || '';
    const { hiY, loY, whollyAbove, whollyBelow } = range;
    const labelX = xEnd - (index * 9);

    const label = (y, value, anchor = 'end') => appendSvg(svg, 'text', {
      x: anchor === 'end' ? labelX : xStart + 7,
      y: Math.max(11, Math.min(height - 5, y)),
      class: 'range-label', fill: color, 'text-anchor': anchor,
    }, value);

    if (whollyAbove || whollyBelow) {
      const edgeY = whollyAbove ? 1.5 + index * 3 : height - 1.5 - index * 3;
      appendSvg(svg, 'line', {
        x1: xStart, x2: xEnd, y1: edgeY, y2: edgeY,
        class: 'range-boundary', stroke: color, 'stroke-dasharray': dash || '4 4',
      });
      const maxY = whollyAbove ? 12 + index * 26 : height - 20 - index * 26;
      const minY = whollyAbove ? 24 + index * 26 : height - 7 - index * 26;
      label(maxY, `${whollyAbove ? '▲' : '▼'} LP MAX ${range.hiLabel} ${whollyAbove ? 'ABOVE' : 'BELOW'}`);
      label(minY, `${whollyAbove ? '▲' : '▼'} LP MIN ${range.loLabel} ${whollyAbove ? 'ABOVE' : 'BELOW'}`);
      return;
    }

    appendSvg(svg, 'rect', {
      x: xStart, y: range.bandY, width: Math.max(0, xEnd - xStart), height: range.bandHeight,
      class: 'range-band', fill: color, opacity: index === 0 ? '.09' : '.055',
    });

    if (range.rangeSpansView) {
      label(26 + index * 13, 'LP RANGE EXTENDS BEYOND VIEW');
    }

    const narrow = Math.abs(loY - hiY) < 20;
    const drawBound = (y, kind, valueLabel) => {
      if (y >= 0 && y <= height) {
        appendSvg(svg, 'line', {
          x1: xStart, x2: xEnd, y1: y, y2: y,
          class: 'range-boundary', stroke: color, 'stroke-dasharray': dash,
        });
        const labelY = narrow
          ? (hiY + loY) / 2 + (kind === 'MAX' ? -5 : 12)
          : y + (kind === 'MAX' ? -5 : 12);
        label(labelY, `LP ${kind} ${valueLabel}`);
      } else {
        const above = y < 0;
        label(above ? 12 + index * 13 : height - 7 - index * 13,
          `${above ? '▲' : '▼'} LP ${kind} ${valueLabel} ${above ? 'ABOVE' : 'BELOW'} VIEW`);
      }
    };
    drawBound(hiY, 'MAX', range.hiLabel);
    drawBound(loY, 'MIN', range.loLabel);
  });

  shadow.replaceChildren(svg);

  const alignedIds = new Set(geometry.ranges.map((range) => range.id));
  const panelHost = document.getElementById(HOST_ID);
  const panelShadow = panelHost && panelHost.__shadow;
  if (!panelShadow) return true;
  const alignedMode = geometry.displayMode === 'price-native' ? 'exact native scale'
    : geometry.displayMode === 'price-usd' ? 'current USD equivalent'
      : 'current market cap equivalent';
  for (const card of panelShadow.querySelectorAll('[data-dex-range-id]')) {
    const aligned = alignedIds.has(String(card.dataset.dexRangeId || ''));
    card.classList.toggle('chart-range-aligned', aligned);
    const mode = card.querySelector('.dex-range-aligned-mode');
    if (mode && aligned) mode.textContent = alignedMode;
    const status = card.querySelector('.dex-chart-status');
    if (status) {
      status.classList.remove('is-aligning');
      status.hidden = true;
      status.textContent = '';
    }
  }
  return true;
}

function scheduleDexscreenerChartGeometry(session, delay = DEXSCREENER_CHART_POLL_MS) {
  if (dexscreenerChartSession !== session) return;
  if (dexscreenerChartTimer !== null) clearTimeout(dexscreenerChartTimer);
  dexscreenerChartTimer = setTimeout(() => {
    dexscreenerChartTimer = null;
    void refreshDexscreenerChartGeometry(session);
  }, delay);
}

async function refreshDexscreenerChartGeometry(session) {
  if (dexscreenerChartSession !== session || session.href !== location.href
      || session.generation !== dexscreenerGeneration || lastKey !== session.key) {
    if (dexscreenerChartSession === session) stopDexscreenerChartSession();
    return;
  }
  if (!contextAlive()) return shutdownOrphan();
  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: 'LPLENS_DEXSCREENER_CHART_GEOMETRY',
      href: session.href,
      ranges: session.ranges.map(({ id, lo, hi, now }) => ({ id, lo, hi, now })),
    });
  } catch (err) {
    if (isOrphanError(err)) return shutdownOrphan();
    response = null;
  }
  if (dexscreenerChartSession !== session || session.href !== location.href
      || session.generation !== dexscreenerGeneration || lastKey !== session.key) return;
  if (response && response.reason === 'permission-revoked') return shutdownRevoked();
  const geometry = validateDexscreenerChartGeometry(
    response, session.href, session.ranges, { width: innerWidth, height: innerHeight },
  );
  let painted = false;
  try {
    painted = Boolean(geometry && paintDexscreenerChartGeometry(geometry));
  } catch {
    painted = false;
  }
  if (painted) {
    session.misses = 0;
    session.firstMissAt = 0;
    session.lastFailure = '';
    scheduleDexscreenerChartGeometry(session);
    return;
  }

  const reason = response && typeof response.reason === 'string'
    ? response.reason
    : response && response.ok === true
      ? geometry ? 'paint-failed' : 'isolated-validation-failed'
      : 'no-response';
  session.misses += 1;
  session.lastFailure = reason;
  const now = Date.now();
  if (!session.firstMissAt) session.firstMissAt = now;
  const elapsed = now - session.firstMissAt;
  const recovery = planDexscreenerChartRecovery(reason, session.misses, elapsed);
  clearDexscreenerChartVisual();
  if (recovery.showFailure) showDexscreenerChartFailure(reason);
  else if (recovery.showAligning) showDexscreenerChartAligning();
  scheduleDexscreenerChartGeometry(session, recovery.delay);
}

function startDexscreenerChartSession(key, generation, href, ranges) {
  stopDexscreenerChartSession();
  if (!ranges.length) return;
  const session = {
    key, generation, href,
    ranges: ranges.slice(0, 3).map(({ id, lo, hi, now }) => ({ id, lo, hi, now })),
    misses: 0,
    firstMissAt: 0,
    lastFailure: '',
  };
  dexscreenerChartSession = session;
  void refreshDexscreenerChartGeometry(session);
}

/**
 * Dexscreener pair pages.
 *
 * Only the route is used: /<chain>/<pool-address-or-v4-pool-id>. The address
 * still comes from LPLens local storage through the service worker. The local
 * experiment also requests chart-scale geometry through the worker. This
 * isolated script reads no page text, connected wallet or provider object.
 */
let dexscreenerBusy = false;
let dexscreenerPending = false;
let dexscreenerGeneration = 0;
let dexscreenerHref = '';
function dexscreenerRoute() {
  if (!ON_DEXSCREENER) return null;
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const chain = DEXSCREENER_CHAIN_SLUGS[String(parts[0] || '').toLowerCase()];
  const poolRef = String(parts[1] || '').toLowerCase();
  if (!chain || !/^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(poolRef)) return null;
  return { chain, poolRef };
}

async function syncDexscreener() {
  if (torndown) return;
  const route = dexscreenerRoute();
  if (!route) return teardown();
  const key = `dexscreener:${route.chain}:${route.poolRef}`;
  const href = location.href;
  if (dexscreenerHref && dexscreenerHref !== href) {
    stopDexscreenerChartSession();
    if (lastKey === key) lastKey = null;
  }
  if (dexscreenerBusy) {
    if (lastKey !== key || dexscreenerHref !== href) {
      lastKey = key;
      dexscreenerPending = true;
    }
    return;
  }
  if (lastKey === key && dexscreenerHref === href) return;
  dexscreenerBusy = true;
  lastKey = key;
  dexscreenerHref = href;
  const generation = dexscreenerGeneration;
  teardownList();
  render(head('<span class="pill">Dexscreener</span>')
    + '<div class="bd"><div class="note">Checking the active wallet selected in LPLens for this pool…</div></div>');

  try {
    if (!contextAlive()) return shutdownOrphan();
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'LPLENS_DEXSCREENER_POOL',
        chain: route.chain,
        poolRef: route.poolRef,
      });
    } catch (err) {
      if (isOrphanError(err)) return shutdownOrphan();
      res = { ok: false, error: err.message || String(err) };
    }
    if (torndown) return;
    if (lastKey !== key || generation !== dexscreenerGeneration || href !== location.href) return;
    if (res && res.permissionRevoked) return shutdownRevoked();

    if (res && res.gated && res.entitlement && !res.entitlement.allowed) {
      stopDexscreenerChartSession();
      const e = res.entitlement || {};
      render(head('<span class="pill">Dexscreener</span>') + `<div class="bd">
        <div class="note">${esc(e.reason || 'LPLens access is required.')} Check Settings or ask Dan.</div>
      </div>`);
      return;
    }
    if (!res || !res.ok) {
      stopDexscreenerChartSession();
      render(head('<span class="pill">Dexscreener</span>') + `<div class="bd">
        <div class="err note">${esc(res && res.error || 'no response')}</div>
      </div>`);
      return;
    }

    const positions = Array.isArray(res.data && res.data.positions) ? res.data.positions : [];
    const pair = res.data && res.data.pair || null;
    const pairError = String(res.data && res.data.pairError || '');
    const wrappedNative = String(res.data && res.data.wrappedNative || '');
    const address = String(res.data && res.data.address || '');
    const short = address.length === 42 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
    const shown = positions.slice(0, 8);
    const prepared = prepareDexscreenerChartRanges(shown, pair, wrappedNative);
    const overflow = positions.length - shown.length;
    const content = positions.length
      ? shown.map((position, index) => dexscreenerPortfolioCard(
        position, pair, wrappedNative, pairError, prepared.rangeIdByIndex.get(index) || '',
      )).join('')
        + (overflow > 0 ? `<div class="note">${overflow} more matching position${overflow === 1 ? '' : 's'} not shown here.</div>` : '')
      : '<div class="note">No open matching position for the active wallet. Switch it in LPLens Saved wallets if this LP belongs to another address.</div>';
    render(head(`<span class="pill">Dexscreener · ${positions.length}</span>`) + `<div class="bd">
      <div class="note">Active wallet: <span class="num">${esc(short)}</span>. Local chart alignment shares up to three anonymous range bounds with this page. Dexscreener wallet data is not read.</div>
      ${content}
    </div>`);
    startDexscreenerChartSession(key, generation, href, prepared.ranges);
  } finally {
    dexscreenerBusy = false;
    if (torndown) {
      dexscreenerPending = false;
      return;
    }
    if (dexscreenerPending) {
      dexscreenerPending = false;
      lastKey = null;
      void syncDexscreener();
    }
  }
}

async function syncList() {
  if (torndown) return;
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
        version: m[1].toLowerCase(),
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
          `<div class="bd">${rows.map((row) =>
            `<div class="portfolio-card">${gutterCard(row)}</div>`).join('')}</div>`;
        const btn = panel.querySelector('#lplens-toggle');
        if (btn) btn.onclick = () => panel.classList.toggle('collapsed');
      };
      paint();
    }

    for (const row of rows) {
      if (!row.chain || row.data) continue;
      if (!contextAlive()) return shutdownOrphan('list');
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'LPLENS_POSITION', chain: row.chain, tokenId: row.tokenId,
          version: row.version,
        });
        if (res && res.gated && res.entitlement && !res.entitlement.allowed) {
          row.data = { error: res.entitlement.reason || 'LPLens access is required; check Options.' };
        } else {
          row.data = res && res.ok ? res.data : { error: (res && res.error) || 'no response' };
        }
      } catch (err) {
        if (isOrphanError(err)) return shutdownOrphan('list');
        row.data = { error: err.message || String(err) };
      }
      if (torndown) return;
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
  stopDexscreenerChartSession();
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
  try {
    if (dexscreenerPanelResizeObserver) dexscreenerPanelResizeObserver.disconnect();
  } catch {}
}

function shutdownRevoked() {
  if (torndown) return;
  torndown = true;
  try { clearInterval(pollTimer); } catch {}
  try { clearTimeout(listTimer); } catch {}
  try { listObserver.disconnect(); } catch {}
  try { teardown(); } catch {}
  try { teardownList(); } catch {}
}

async function sync() {
  if (torndown) return;
  if (ON_DEXSCREENER) {
    return syncDexscreener();
  }
  if (PROJECTX_ROUTE.test(location.pathname)) {
    return syncProjectXPortfolio();
  }
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

// If the user selects another active wallet in the popup or side panel, the
// overlay follows that explicit choice without reading the site's wallet state.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.address
        || (!PROJECTX_ROUTE.test(location.pathname) && !ON_DEXSCREENER)) return;
    if (ON_DEXSCREENER) {
      dexscreenerGeneration++;
      stopDexscreenerChartSession();
      if (dexscreenerBusy) dexscreenerPending = true;
    }
    lastKey = null;
    sync();
  });
} catch { /* orphaned context */ }

try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'LPLENS_OVERLAY_ACCESS_REVOKED'
        || !Array.isArray(msg.origins)) return false;
    if (msg.origins.includes(`${location.origin}/*`)) shutdownRevoked();
    return false;
  });
} catch { /* orphaned context */ }

window.addEventListener('pagehide', () => {
  stopDexscreenerChartSession();
});

sync();
