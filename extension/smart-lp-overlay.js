// Optional, isolated-world panel. Never consult the site's wallet, React
// state, form values, row text, or transaction controls. No network here.
(() => {
  'use strict';
  if (window.top !== window || !globalThis.LPLens) return;
  const ORIGINS = ['https://stonkbrokers.io', 'https://www.stonkbrokers.io', 'https://www.stonkbrokers.cash'];
  if (!ORIGINS.includes(location.origin)) return;
  const HOST = 'lplens-smart-lp-host', PREF = 'smartLpPanelLayoutV1';
  if (document.getElementById(HOST)) return;
  const { CSS_COMPONENTS, esc, fmt, rangeBar, hero, details, priceOrientation, positionValueRow } = globalThis.LPLens;
  const host = document.createElement('div');
  host.id = HOST;
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;left:12px;bottom:12px;display:block;';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>${CSS_COMPONENTS}
    :host { color-scheme: light dark; }
    * { box-sizing:border-box; }
    [hidden] { display:none !important; }
    .smart-shell { width:min(350px,calc(100vw - 24px)); max-height:calc(100dvh - 24px);
      display:flex; flex-direction:column; border:1px solid var(--line-strong); border-top:3px solid var(--signal);
      border-radius:14px; background:var(--panel); color:var(--ink); box-shadow:var(--shadow); font:12px/1.4 var(--ui); }
    .smart-head { display:flex; align-items:center; gap:8px; padding:9px 10px; touch-action:none; cursor:move; user-select:none; }
    .smart-head strong { font-size:13px; flex:1; }
    .smart-head small { display:block; font:9px/1.4 var(--mono); color:var(--ink-3); }
    button { font:inherit; color:var(--ink-2); border:1px solid var(--line); background:var(--panel-2); border-radius:7px; cursor:pointer; padding:5px 8px; }
    button:hover,button:focus-visible { color:var(--signal-strong); outline-color:var(--signal); }
    button:disabled { opacity:.5; cursor:wait; }
    .smart-head button { min-width:28px; }
    .smart-body { overflow:auto; min-height:0; overscroll-behavior:contain; max-height:70dvh; border-top:1px solid var(--line); }
    .smart-context { padding:10px 12px; border-bottom:1px solid var(--line); }
    .smart-context p { margin:4px 0; }
    .smart-note { color:var(--ink-3); font-size:10.5px; }
    .smart-actions { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:8px; }
    .smart-cards { display:grid; gap:10px; padding:10px; }
    .position-card { min-width:0; border:1px solid var(--line); border-radius:10px; overflow:hidden; }
    .card-top { flex-wrap:wrap; gap:5px; padding:10px; }
    .card-top .pair { flex:1; overflow-wrap:anywhere; }
    .card-top .pill { font-size:8px; }
    .smart-strategy { padding:0 12px 8px; color:var(--ink-3); font-size:10px; }
    .smart-more { margin:8px 12px; }
    .smart-extra .kv { flex-wrap:wrap; gap:4px 8px; }
    .smart-extra .kv .num { margin-left:auto; max-width:100%; overflow-wrap:anywhere; }
    .stat-v { overflow:visible; overflow-wrap:anywhere; }
    .smart-shell.compact { width:min(235px,calc(100vw - 24px)); }
  </style><section class="smart-shell" aria-label="LPLens Smart LP positions">
    <header class="smart-head" title="Drag to move. Arrow keys move the focused header." tabindex="0" aria-label="Move LPLens panel with arrow keys">
      <strong>LPLens <small>Smart LP · read-only v${esc(chrome.runtime.getManifest().version)}</small></strong>
      <button type="button" data-collapse aria-label="Minimize LPLens" aria-expanded="true">−</button>
    </header><div class="smart-body"></div></section>`;
  const shell = shadow.querySelector('.smart-shell'), body = shadow.querySelector('.smart-body');
  const head = shadow.querySelector('.smart-head'), collapse = shadow.querySelector('[data-collapse]');
  let dead = false, generation = 0, busy = false, wasOnRoute = false, lastPath = '';
  let layout = { collapsed: false, x: null, y: null }, lastData = null, drag = null;
  const onRoute = () => /^\/locker\/smart-lp(?:\/.*)?$/.test(location.pathname);
  const validFraction = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

  function place() {
    const rect = host.getBoundingClientRect();
    const maxX = Math.max(12, innerWidth - rect.width - 12), maxY = Math.max(12, innerHeight - rect.height - 12);
    const x = validFraction(layout.x) ? 12 + layout.x * (maxX - 12) : 12;
    const y = validFraction(layout.y) ? 12 + layout.y * (maxY - 12) : maxY;
    host.style.left = `${x}px`; host.style.top = `${y}px`; host.style.bottom = 'auto';
  }
  async function persist() {
    try { await chrome.storage.local.set({ [PREF]: layout }); } catch { /* Extension may have reloaded. */ }
  }
  function paintLayout() {
    shell.classList.toggle('compact', layout.collapsed); body.hidden = layout.collapsed;
    collapse.textContent = layout.collapsed ? '+' : '−';
    collapse.setAttribute('aria-expanded', String(!layout.collapsed));
    collapse.setAttribute('aria-label', layout.collapsed ? 'Expand LPLens' : 'Minimize LPLens');
    place();
  }
  function clear(message) {
    lastData = null;
    body.innerHTML = `<div class="smart-context"><p>${esc(message)}</p>
      <p class="smart-note">Uses the active wallet selected in LPLens, not the site's connected wallet.</p>
      <button type="button" data-refresh ${busy ? 'disabled' : ''}>Refresh Smart LP</button></div>`;
    place();
  }
  function paint(data) {
    const positions = Array.isArray(data.positions) ? data.positions : [];
    body.innerHTML = `<div class="smart-context"><p>Active wallet: <b>${esc(data.walletLabel)}</b></p>
      <p class="smart-note">From LPLens Saved wallets. The site's connected wallet is not read.</p>
      <div class="smart-actions"><span class="smart-note">Updated ${esc(new Date(data.refreshedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</span>
      <button type="button" data-refresh>Refresh</button></div></div>
      ${data.unavailable ? `<p class="note err">${esc(data.unavailable)}</p>` : ''}
      ${!positions.length ? `<p class="note">${data.unavailable ? 'Vault ownership could not be fully checked.'
        : 'No Smart LP shares found for this active wallet.'}</p>` : ''}
      <div class="smart-cards">${positions.map((p) => {
        const h = p.history || {}, s0 = p.token0Meta.symbol, s1 = p.token1Meta.symbol;
        const invertedStatus = priceOrientation(p, h, s0, s1, true).status;
        const fees = Number.isFinite(p.usd?.collectable) ? '$' + fmt(p.usd.collectable, 2)
          : `${fmt(p.collectable0)} ${esc(s0)} + ${fmt(p.collectable1)} ${esc(s1)}`;
        return `<article class="position-card"><div class="card-top"><span class="pair">${esc(s0)} / ${esc(s1)}</span>
          <span class="pill ${esc(p.status)}"><span data-price-view="standard">${esc(p.status)}</span>
          <span data-price-view="inverse">${esc(invertedStatus)}</span></span></div>
          <div class="smart-strategy">${esc(p.vault.strategy)} · ${fmt(p.vault.sharePercent, 6)}% share</div>
          ${hero(p, h, s1)}${positionValueRow(p)}${rangeBar(p, h, true)}
          <div class="kv"><span>pending in vault</span><span class="num">${fees}</span></div>
          <button type="button" class="smart-more" aria-expanded="false">details</button>
          <div class="smart-extra" hidden>${details(p, h, s0, s1, true)}</div></article>`;
      }).join('')}</div>`;
    place();
  }
  async function refresh() {
    if (dead || busy || !onRoute()) return;
    const request = ++generation;
    busy = true; clear('Reading Smart LP for your active LPLens wallet…');
    try {
      const result = await chrome.runtime.sendMessage({ type: 'LPLENS_SMART_LP_PORTFOLIO' });
      if (dead || request !== generation || !onRoute()) return;
      busy = false;
      if (result?.permissionRevoked) return stop();
      if (result?.stale) return refresh();
      if (!result?.ok) return clear(result?.error || 'No response. Reload the extension and refresh this page.');
      lastData = result.data; paint(lastData);
    } catch {
      if (!dead && request === generation) { busy = false; clear('LPLens could not respond. Reload the extension and refresh this page.'); }
    }
  }
  function revoked(msg) {
    if (dead) return;
    if (msg?.type === 'LPLENS_SMART_LP_SCOPE_CHANGED') {
      generation++; busy = false; clear('Active wallet or settings changed. Refreshing…');
      void refresh();
    }
    if (msg?.type === 'LPLENS_OVERLAY_ACCESS_REVOKED' && msg.origins?.includes(`${location.origin}/*`)) stop();
  }
  function stop() {
    if (dead) return;
    dead = true; generation++; lastData = null; body.replaceChildren(); host.remove();
    clearInterval(timer);
    chrome.runtime.onMessage.removeListener(revoked);
    window.removeEventListener('resize', place); window.removeEventListener('pagehide', stop);
  }
  function watchPage() {
    if (dead) return;
    const route = onRoute();
    if (!route) {
      if (wasOnRoute) { generation++; busy = false; clear(''); host.remove(); }
      wasOnRoute = false; lastPath = location.pathname; return;
    }
    if (!host.isConnected) { document.documentElement.append(host); place(); }
    // Inspect only dialog visibility/boundaries, never its text or controls.
    // Do not cover disclaimers or signing/management dialogs.
    const modal = [...document.querySelectorAll('[role="dialog"][aria-modal="true"],dialog[open]')]
      .some((el) => { const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; });
    host.style.visibility = modal ? 'hidden' : 'visible';
    if (!wasOnRoute || lastPath !== location.pathname) {
      wasOnRoute = true; lastPath = location.pathname; generation++; busy = false; void refresh();
    }
  }
  shadow.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button === collapse) { layout.collapsed = !layout.collapsed; paintLayout(); persist(); }
    else if (button.hasAttribute('data-refresh')) void refresh();
    else if (button.classList.contains('smart-more')) {
      const extra = button.nextElementSibling; extra.hidden = !extra.hidden;
      button.textContent = extra.hidden ? 'details' : 'hide details';
      button.setAttribute('aria-expanded', String(!extra.hidden)); place();
    } else if (button.classList.contains('price-flip')) {
      const card = button.closest('.position-card');
      const inverse = card.classList.toggle('price-inverted');
      button.setAttribute('aria-pressed', String(inverse));
      button.setAttribute('aria-label', `Show prices as ${inverse ? button.dataset.priceStandard : button.dataset.priceInverse}`);
    }
  });
  function moveTo(x, y) {
    const r = host.getBoundingClientRect();
    const dx = Math.max(1, innerWidth - r.width - 24), dy = Math.max(1, innerHeight - r.height - 24);
    layout.x = Math.max(0, Math.min(1, (x - 12) / dx));
    layout.y = Math.max(0, Math.min(1, (y - 12) / dy)); place();
  }
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const r = host.getBoundingClientRect(); drag = { x: e.clientX - r.left, y: e.clientY - r.top };
    head.setPointerCapture(e.pointerId); e.preventDefault();
  });
  head.addEventListener('pointermove', (e) => { if (drag) moveTo(e.clientX - drag.x, e.clientY - drag.y); });
  const finishDrag = () => { if (drag) { drag = null; persist(); } };
  head.addEventListener('pointerup', finishDrag); head.addEventListener('pointercancel', finishDrag);
  head.addEventListener('lostpointercapture', finishDrag);
  head.addEventListener('keydown', (e) => {
    if (e.target !== head || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault(); const r = host.getBoundingClientRect();
    moveTo(r.left + (e.key === 'ArrowLeft' ? -20 : e.key === 'ArrowRight' ? 20 : 0),
      r.top + (e.key === 'ArrowUp' ? -20 : e.key === 'ArrowDown' ? 20 : 0)); persist();
  });
  chrome.runtime.onMessage.addListener(revoked);
  window.addEventListener('resize', place); window.addEventListener('pagehide', stop);
  const timer = setInterval(watchPage, 600);
  void chrome.storage.local.get(PREF).then((saved) => {
    if (dead) return;
    const p = saved[PREF] || {};
    layout = { collapsed: p.collapsed === true, x: validFraction(p.x) ? p.x : null, y: validFraction(p.y) ? p.y : null };
    paintLayout(); watchPage();
  }).catch(() => { if (!dead) { paintLayout(); watchPage(); } });
})();
