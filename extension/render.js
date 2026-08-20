/**
 * Shared rendering for the popup and the on-page overlay.
 *
 * This is a CLASSIC script, not a module, and that is deliberate. MV3 content
 * scripts are loaded as classic scripts and cannot use `import`, while the
 * popup is a module — so a shared ES module could not serve both. Loading this
 * first in `content_scripts` and via a plain <script> in popup.html gives both
 * surfaces the same code through one global.
 *
 * It exists because the two surfaces had already drifted: every feature added
 * between 0.4 and 0.8 — vs-holding, the fees/IL decomposition, fee APR, the
 * range bar, the contrast and type fixes — landed only in the overlay, leaving
 * the popup on the 0.3-era layout despite being the only surface that can
 * inspect an arbitrary address.
 *
 * Everything here is a pure function of position data. No network, no chrome.*,
 * no DOM lookups.
 */
(() => {
    // Split deliberately. CSS_PANEL positions the overlay's own chrome — fixed
  // panels, gutter cards, the shadow-root reset — and must NOT reach the popup,
  // which has its own layout. CSS_COMPONENTS is the shared vocabulary (hero,
  // range bar, key/value rows, pills, tone colours) that both surfaces render.
  const TOKENS = `
:root, :host {
  color-scheme: light dark;
  --ground: #F5F3EE; --panel: #FFFDF9; --panel-2: #F1EEE8; --panel-3: #E8E3DA;
  --ink: #171714; --ink-2: #5D5A52; --ink-3: #817C71;
  --line: #DED8CD; --line-strong: #C9C0B2;
  --signal: #B96D0C; --signal-strong: #824600; --signal-soft: #F8E8CF;
  --good: #187458; --good-soft: #DCF1E8;
  --warn: #B44830; --warn-soft: #F8E1DB;
  --icon-ink: #0E1420;
  --shadow-sm: 0 1px 2px rgba(30,25,18,.05), 0 4px 12px rgba(30,25,18,.04);
  --shadow: 0 2px 4px rgba(30,25,18,.06), 0 18px 48px rgba(30,25,18,.14);
  --ui: "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, sans-serif;
  --mono: "Cascadia Mono", "SFMono-Regular", Consolas, ui-monospace, monospace;
}
@media (prefers-color-scheme: dark) {
  :root, :host {
    --ground: #0D121A; --panel: #151C26; --panel-2: #1C2532; --panel-3: #253140;
    --ink: #F4F1E9; --ink-2: #BAB5AA; --ink-3: #818C9B;
    --line: #2A3544; --line-strong: #3A4758;
    --signal: #E8A33D; --signal-strong: #FFD08A; --signal-soft: #392A18;
    --good: #4AC397; --good-soft: #173A31;
    --warn: #F0785C; --warn-soft: #40251F;
    --shadow-sm: 0 1px 2px rgba(0,0,0,.24), 0 5px 14px rgba(0,0,0,.16);
    --shadow: 0 2px 4px rgba(0,0,0,.28), 0 20px 54px rgba(0,0,0,.42);
  }
}
`;

  const CSS_COMPONENTS = TOKENS + `
.kv { display: flex; justify-content: space-between; gap: 12px; padding: 5px 12px; }
.kv > span:first-child { color: var(--ink-3); white-space: nowrap;
  font-family: var(--mono); font-size: 9.5px; letter-spacing: .065em; text-transform: uppercase; }
.num { font-variant-numeric: tabular-nums; text-align: right; font-family: var(--mono); }
.sep { height: 1px; background: var(--line); margin: 9px 12px; }
.pill { font-family: var(--mono); font-size: 10px; letter-spacing: .06em; text-transform: uppercase;
  padding: 4px 8px; border: 1px solid transparent; border-radius: 999px; background: var(--panel-2); color: var(--ink-2); white-space: nowrap; }
.pos, .up { color: var(--good); }
.neg, .down { color: var(--warn); }
.muted { color: var(--ink-2); }
.note { color: var(--ink-3); font-size: 11.5px; margin: 7px 12px 9px; line-height: 1.5; }
.err { color: var(--warn); }
@media (max-width: 1500px) { .panel { width: min(340px, calc(100vw - 24px)); } }
.pill.closed { border-color: var(--line); background: var(--panel-2); color: var(--ink-3); }
.pill.in-range { border-color: color-mix(in srgb, var(--good) 18%, transparent); background: var(--good-soft); color: var(--good); }
.pill.above, .pill.below { border-color: color-mix(in srgb, var(--warn) 18%, transparent); background: var(--warn-soft); color: var(--warn); }
.card-top { display: flex; align-items: center; gap: 7px; min-width: 0; padding: 12px 12px 10px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--panel-2) 48%, var(--panel)), var(--panel)); }
.pair { font-family: var(--ui); font-weight: 720; font-size: 14px; letter-spacing: -.02em; }
.fee { font-family: var(--mono); font-size: 10px; color: var(--ink-2);
  border: 1px solid var(--line); border-radius: 5px; padding: 2px 5px; background: var(--panel-2); }
.meter { padding: 11px 12px 13px; }
.track {
  position: relative; height: 30px; border-radius: 8px;
  background: repeating-linear-gradient(90deg, transparent 0, transparent calc(25% - 1px), color-mix(in srgb, var(--line) 55%, transparent) 25%), var(--panel-2);
  border: 1px solid var(--line); overflow: visible;
}
.band {
  position: absolute; top: 0; bottom: 0; border-radius: 3px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--good-soft) 68%, white), var(--good-soft));
  border-left: 2px solid var(--good); border-right: 2px solid var(--good);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--good) 8%, transparent);
}
.band.out { background: linear-gradient(180deg, color-mix(in srgb, var(--warn-soft) 70%, white), var(--warn-soft)); border-color: var(--warn); }
.now {
  position: absolute; top: -4px; bottom: -4px; width: 2px; background: var(--signal);
  box-shadow: 0 0 10px color-mix(in srgb, var(--signal) 38%, transparent);
  transform: translateX(-50%);
}
.now::after {
  content: ""; position: absolute; left: 50%; top: -1px; width: 8px; height: 8px;
  background: var(--signal); border: 2px solid var(--panel); border-radius: 50%; transform: translate(-50%, -85%);
  box-shadow: 0 2px 5px color-mix(in srgb, var(--signal) 35%, transparent);
}
.ticks {
  display: flex; justify-content: space-between; gap: 6px; margin-top: 7px;
  font-family: var(--mono); font-size: 9.5px; color: var(--ink-3);
  font-variant-numeric: tabular-nums;
}
.ticks > span:nth-child(2) { color: var(--signal); }
.stats { display: grid; grid-template-columns: 1fr 1fr; border-top: 1px solid var(--line); }
.stat { min-width: 0; padding: 11px 12px 12px; background: color-mix(in srgb, var(--panel-2) 28%, transparent); }
.stat + .stat { border-left: 1px solid var(--line); }
.stat-l {
  font-family: var(--mono); font-size: 9px; letter-spacing: .085em;
  text-transform: uppercase; color: var(--ink-3); display: block; margin-bottom: 4px;
}
.stat-v {
  display: block; overflow: hidden; font-family: var(--ui); font-weight: 720; font-size: 16px;
  font-variant-numeric: tabular-nums; letter-spacing: -.025em; text-overflow: ellipsis;
}
.stat-n { font-size: 10.5px; color: var(--ink-3); display: block; margin-top: 1px; }
.unit { font-size: 10px; color: var(--ink-3); font-weight: 400; }
.hero, .herolbl, .heroval, .herosub { } /* kept as aliases for older call sites */
.herolbl { font-family: var(--mono); font-size: 9.5px; letter-spacing: .08em;
  text-transform: uppercase; color: var(--ink-3); }
.heroval { font-family: var(--ui); font-weight: 650; font-size: 22px;
  font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: .01ms !important; } }
`;

  const CSS_PANEL = `
:host { all: initial; }
` + TOKENS + `
.panel {
    position: fixed; bottom: 16px; z-index: 2147483000;
    width: min(368px, calc(100vw - 32px));
    max-height: min(520px, 58vh); overflow-y: auto; overflow-x: hidden;
    background: var(--panel); color: var(--ink);
    border: 1px solid var(--line-strong); border-radius: 16px;
    box-shadow: var(--shadow);
    font: 13px/1.5 var(--ui);
    font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased;
  }
.panel::-webkit-scrollbar { width: 8px; }
.panel::-webkit-scrollbar-thumb { border: 2px solid var(--panel); border-radius: 99px; background: var(--line-strong); }
.hd {
    display: flex; align-items: center; justify-content: space-between;
    min-height: 50px; padding: 10px 12px; border-bottom: 1px solid var(--line);
    position: sticky; top: 0; z-index: 2;
    background: linear-gradient(120deg, color-mix(in srgb, var(--signal-soft) 42%, var(--panel)), var(--panel) 44%);
    border-radius: 16px 16px 0 0; backdrop-filter: blur(12px);
  }
.brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 720; letter-spacing: -.02em; }
.brand::before { content: ""; width: 22px; height: 22px; flex: none; border-radius: 6px;
  background: radial-gradient(circle at 50% 50%, var(--icon-ink) 0 17%, transparent 18%),
    linear-gradient(var(--icon-ink), var(--icon-ink)) 28% 50% / 2px 55% no-repeat,
    linear-gradient(var(--icon-ink), var(--icon-ink)) 72% 50% / 2px 55% no-repeat,
    var(--signal); box-shadow: 0 3px 9px color-mix(in srgb, var(--signal) 22%, transparent); }
.tag { padding: 3px 6px; border: 1px solid var(--line); border-radius: 999px; background: color-mix(in srgb, var(--panel) 70%, transparent);
  font-size: 8.5px; color: var(--ink-3); font-weight: 500; font-family: var(--mono); letter-spacing: .055em; text-transform: uppercase; }
.right { display: flex; align-items: center; gap: 6px; }
button {
    all: unset; display: inline-grid; width: 26px; height: 26px; place-items: center; cursor: pointer;
    border: 1px solid transparent; border-radius: 8px; color: var(--ink-3); font-size: 16px; line-height: 1;
  }
button:hover { border-color: var(--line); background: var(--panel-2); color: var(--ink); }
.bd { padding: 4px 0 11px; }
.collapsed .bd { display: none; }
.more {
  display: block; width: calc(100% - 24px); height: auto; margin: 9px 12px 4px;
  text-align: center; padding: 7px; border-radius: 8px;
  background: var(--panel-2); color: var(--ink-2);
  font-size: 11px; cursor: pointer; border: 1px solid var(--line);
}
.more:hover { border-color: var(--signal); background: var(--signal-soft); color: var(--signal-strong); }
.extra { display: none; margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--line); }
.showmore .extra { display: block; }
.grip {
  position: absolute; top: 0; width: 18px; height: 18px; cursor: nwse-resize;
  opacity: .35; touch-action: none;
}
.grip:hover { opacity: .9; }
.grip::after {
  content: ''; position: absolute; inset: 5px;
  border-top: 2px solid var(--ink-3); border-radius: 1px;
}
.grip.left { left: 0; cursor: nesw-resize; }
.grip.left::after { border-left: 2px solid var(--ink-3); }
.grip.right { right: 0; }
.grip.right::after { border-right: 2px solid var(--ink-3); }
.gc {
    position: fixed; z-index: 2147482000; pointer-events: none;
    overflow: hidden; background: linear-gradient(145deg, color-mix(in srgb, var(--panel-2) 28%, var(--panel)), var(--panel));
    border: 1px solid var(--line-strong); border-radius: 13px;
    padding: 11px 12px; font: 12px/1.45 var(--ui);
    color: var(--ink); box-shadow: var(--shadow); -webkit-font-smoothing: antialiased;
  }
.gc::after { content: ""; position: absolute; inset: 0 auto 0 0; width: 2px; background: var(--signal); opacity: .72; }
.gc-pair { font-size: 11.5px; color: var(--ink-2); font-weight: 720;
             white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gc-val { font-size: 22px; font-weight: 720; line-height: 1.15; margin: 3px 0 0;
            font-variant-numeric: tabular-nums; font-family: var(--ui); }
.gc-val.pos { color: var(--good); }
.gc-val.neg { color: var(--warn); }
.gc-lbl { font-size: 10px; letter-spacing: .08em; text-transform: uppercase;
            color: var(--ink-3); font-family: var(--mono); }
.gc-sub { font-size: 11px; color: var(--ink-3); margin-top: 4px;
            font-variant-numeric: tabular-nums; font-family: var(--mono); }
.gc-fee { color: var(--ink-3); font-weight: 400; }
.gc-bar { position: relative; height: 9px; background: var(--panel-2);
            border-radius: 4px; margin: 8px 0 3px; border: 1px solid var(--line); overflow: hidden; }
.gc-band { position: absolute; top: 0; bottom: 0; background: var(--good-soft);
  border-left: 2px solid var(--good); border-right: 2px solid var(--good); }
.gc-band.out { background: var(--warn-soft); border-color: var(--warn); }
.gc-mark { position: absolute; top: -2px; width: 2px; height: 12px;
             background: var(--signal); transform: translateX(-50%); }
.gc-dot { display:inline-block; width:5px; height:5px; border-radius:50%;
            margin-right:4px; vertical-align:middle; }
.gc-dot.in-range { background: var(--good); }
.gc-dot.closed { background: var(--ink-3); }
.gc-dot.below, .gc-dot.above { background: var(--warn); }
`;

  const CSS = CSS_PANEL + CSS_COMPONENTS;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function fmt(n, dp = 6) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    const a = Math.abs(n);
    if (a !== 0 && a < 1e-6) return n.toExponential(2);
    return n.toLocaleString('en-US', { maximumFractionDigits: a < 1 ? 8 : dp });
  }

  function humanSpan(days) {
    if (days < 1 / 24) return `${Math.round(days * 1440)}m`;
    if (days < 1) return `${Math.round(days * 24)}h`;
    if (days < 90) return `${days.toFixed(days < 10 ? 1 : 0)}d`;
    return `${(days / 365).toFixed(1)}y`;
  }

  function ageText(from, to) {
    if (!from) return null;
    const end = to || Math.floor(Date.now() / 1000);
    const days = (end - from) / 86400;
    const opened = new Date(from * 1000).toISOString().slice(0, 10);
    const dur = days < 1 ? `${Math.round(days * 24)}h`
      : days < 90 ? `${days.toFixed(days < 10 ? 1 : 0)}d`
      : `${(days / 365).toFixed(1)}y`;
    return { opened, dur };
  }

  function priceText(e) {
    if (!e) return '—';
    if (!e.exact) return `${esc(e.bound)} ${fmt(e.price, 8)}`;
    // A disagreement between the two independent solves is surfaced, never
    // averaged away into a clean-looking number.
    if (e.spread > 1e-6) return `${fmt(e.price, 8)} <span class="pill">±${(e.spread * 100).toFixed(4)}%</span>`;
    return fmt(e.price, 8);
  }

  /**
   * The headline. vs-HODL was previously the second-to-last row of a dense table,
   * which buried the one number that answers "was this worth doing" underneath
   * six that do not. It leads now, at a size that survives a glance.
   */
  const money = (v, dp) => (v < 0 ? '−' : '+') + '$' + Math.abs(v).toLocaleString('en-US',
    { minimumFractionDigits: dp ?? 2, maximumFractionDigits: dp ?? 2 });

  /**
   * The headline: one number, one qualifier, nothing else.
   *
   * This block previously carried eight figures and two paragraphs of
   * explanation — vs-holding, its token delta, its dollar value, fees, IL, fee
   * APR, total return, cost basis and worth-now. Every one of them was true and
   * the aggregate was unreadable, which is its own kind of wrong: a number
   * nobody finds is not informing anyone. Detail moved behind a toggle.
   *
   * Total return leads because it answers "did I make money". vs-holding sits
   * directly under it because it answers "was LPing the reason", and those two
   * routinely disagree in sign.
   */
  function hero(d, h, s1) {
    const v = h && h.vsHodl;
    const u = d.usd;
    const hasTotal = u && u.pnl !== null && u.pnl !== undefined;
    const hasVsUsd = u && u.vsHodl !== null && u.vsHodl !== undefined;
    const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'muted');

    const vsInner = h && h.unavailable
      ? ['muted', '—', 'lifetime history unavailable']
      : hasVsUsd
        ? [cls(u.vsHodl), money(u.vsHodl, Math.abs(u.vsHodl) < 10 ? 2 : 2), 'fees minus IL']
        : v
          ? [cls(v.pct), `${v.pct >= 0 ? '+' : ''}${v.pct.toFixed(2)}%`, 'fees minus IL']
          : ['muted', '—', 'no history'];

    const totInner = h && h.unavailable
      ? ['muted', '—', 'unavailable']
      : hasTotal
        ? [cls(u.pnl), money(u.pnl, Math.abs(u.pnl) < 10 ? 2 : 0),
           `${u.pnlPct >= 0 ? '+' : ''}${u.pnlPct.toFixed(2)}%`]
        : ['muted', '—', ''];

    return `<div class="stats">
      <div class="stat">
        <span class="stat-l">vs holding</span>
        <span class="stat-v ${vsInner[0]}">${vsInner[1]}</span>
        <span class="stat-n">${vsInner[2]}</span>
      </div>
      <div class="stat">
        <span class="stat-l">total return</span>
        <span class="stat-v ${totInner[0]}">${totInner[1]}</span>
        <span class="stat-n">${totInner[2]}</span>
      </div>
    </div>`;
  }

  /**
   * What the range actually traded.
   *
   * This is the clearest available explanation of an LP outcome, and it was
   * previously buried as two unlabelled deltas called "net vs deposited". A
   * concentrated position is a rebalancing machine: it sells whichever token is
   * rising and buys the other, continuously. Showing the two sides against each
   * other makes vs-holding self-evident instead of mysterious.
   *
   * It reconciles exactly — the USD offset between the two legs equals the
   * vs-holding delta, verified live at -$2.08 on both. Fees are included in
   * these deltas, which is why the wording is "more/less than you deposited"
   * rather than "sold/bought": that phrasing is precisely true.
   */
  function rebalance(d, h) {
    if (!h || h.unavailable || h.deposited0 === undefined) return null;
    if (d.collectable0 === null || d.collectable1 === null) return null;
    const net0 = h.received0 + (d.amount0 || 0) + d.collectable0 - h.deposited0;
    const net1 = h.received1 + (d.amount1 || 0) + d.collectable1 - h.deposited1;
    if (!net0 && !net1) return null;
    const u = d.usd;
    const v0 = u && u.price0 ? net0 * u.price0 : null;
    const v1 = u && u.price1 ? net1 * u.price1 : null;
    return { net0, net1, v0, v1, offset: v0 !== null && v1 !== null ? v0 + v1 : null };
  }

  /** Compact one-liner for the default view. */
  function rebalanceLine(d, h, s0, s1) {
    const r = rebalance(d, h);
    if (!r) return '';
    const sign = (n) => (n > 0 ? '+' : '');
    return `<div class="kv"><span>range shifted</span><span class="num">`
      + `<span class="${r.net0 > 0 ? 'pos' : 'neg'}">${sign(r.net0)}${fmt(r.net0)} ${esc(s0)}</span><br>`
      + `<span class="${r.net1 > 0 ? 'pos' : 'neg'}">${sign(r.net1)}${fmt(r.net1)} ${esc(s1)}</span>`
      + `</span></div>`;
  }

  /**
   * Everything the headline leaves out, shown only when asked for.
   * Same numbers as before; they simply no longer compete with the answer.
   */
  function details(d, h, s0, s1) {
    const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
    const v = h && h.vsHodl;
    const u = d.usd;
    const rows = [];

    if (v) {
      rows.push(`<div class="kv"><span>fees earned</span><span class="num pos">+${v.feesPct.toFixed(3)}%</span></div>`);
      rows.push(`<div class="kv"><span>impermanent loss</span><span class="num ${v.il > 0 ? 'neg' : ''}">${v.il > 0 ? '−' : '+'}${Math.abs(v.ilPct).toFixed(3)}%</span></div>`);
    }
    if (u && u.costBasis !== null && u.costBasis !== undefined
        && u.totalNow !== null && u.totalNow !== undefined) {
      rows.push(`<div class="kv"><span>cost basis</span><span class="num">$${u.costBasis.toLocaleString('en-US', { maximumFractionDigits: 2 })}${u.costBasisExact ? '' : '*'}</span></div>`);
      rows.push(`<div class="kv"><span>worth now</span><span class="num">$${u.totalNow.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span></div>`);
    }

    if (h && !h.unavailable) {
      const closed = d.status === 'closed' && h.exit;
      const drift = h.entry ? ((closed ? h.exit.price : d.price) / h.entry.price - 1) * 100 : null;
      const qual = h.entry && !h.entry.exact
        ? (h.entry.bound === 'at or below' ? 'at least ' : 'at most ') : '';
      // Every price here is token1-per-token0, and printing it bare is
      // genuinely unreadable: on a WETH/HMM pool a *negative* move means HMM
      // got stronger, which reads as a loss. This was misread in testing
      // against a token that was up 59% while the panel showed −34%. So the
      // unit travels with the number, and the drift states which side won.
      const unit = `${esc(s1)} per ${esc(s0)}`;
      rows.push('<div class="sep"></div>');
      rows.push(`<div class="kv"><span>${h.adds > 1 ? 'first add price' : 'entry price'}</span><span class="num">${priceText(h.entry)}<br><span class="unit">${unit}</span></span></div>`);
      if (h.adds > 1) rows.push(`<div class="kv"><span>liquidity additions</span><span class="num">${h.adds}</span></div>`);
      if (h.exit) rows.push(`<div class="kv"><span>exit price</span><span class="num">${priceText(h.exit)}<br><span class="unit">${unit}</span></span></div>`);
      if (drift !== null) {
        // Same move, stated as the token that actually appreciated.
        const winner = drift < 0
          ? `${esc(s1)} up ${(((1 / (1 + drift / 100)) - 1) * 100).toFixed(1)}% vs ${esc(s0)}`
          : `${esc(s0)} up ${drift.toFixed(1)}% vs ${esc(s1)}`;
        rows.push(`<div class="kv"><span>price ${closed ? 'entry to exit' : 'since entry'}</span><span class="num ${cls(drift)}">${esc(qual)}${drift > 0 ? '+' : ''}${drift.toFixed(2)}%<br><span class="unit">${unit}</span></span></div>`);
        rows.push(`<div class="note" style="margin-top:2px">i.e. ${winner}</div>`);
      }
      rows.push('<div class="sep"></div>');
      rows.push(`<div class="kv"><span>deposited</span><span class="num">${fmt(h.deposited0)} ${esc(s0)}<br>${fmt(h.deposited1)} ${esc(s1)}</span></div>`);
      rows.push(`<div class="kv"><span>collected</span><span class="num">${fmt(h.received0)} ${esc(s0)}<br>${fmt(h.received1)} ${esc(s1)}</span></div>`);
      const r = rebalance(d, h);
      if (r) {
        const usd = (n) => (n === null ? '' : `<span class="unit">${n < 0 ? '−' : '+'}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>`);
        rows.push('<div class="sep"></div>');
        rows.push(`<div class="herolbl" style="margin-bottom:4px">what your range traded</div>`);
        rows.push(`<div class="kv"><span>${r.net0 > 0 ? 'gained' : 'gave up'} ${esc(s0)}</span><span class="num ${cls(r.net0)}">${r.net0 > 0 ? '+' : ''}${fmt(r.net0)} ${usd(r.v0)}</span></div>`);
        rows.push(`<div class="kv"><span>${r.net1 > 0 ? 'gained' : 'gave up'} ${esc(s1)}</span><span class="num ${cls(r.net1)}">${r.net1 > 0 ? '+' : ''}${fmt(r.net1)} ${usd(r.v1)}</span></div>`);
        if (r.offset !== null) {
          rows.push(`<div class="kv"><span><b>net effect</b></span><span class="num ${cls(r.offset)}"><b>${r.offset < 0 ? '−' : '+'}$${Math.abs(r.offset).toLocaleString('en-US', { maximumFractionDigits: 2 })}</b></span></div>`);
          rows.push(`<div class="note" style="margin-top:2px">Your range sold whichever token was rising and bought the other. That trade is the vs-holding figure — fees included, both legs valued now.</div>`);
        }
      }
    }

    const caveats = [];
    if (v && v.apr !== null && v.aprDays !== null && v.aprDays < 7) {
      caveats.push(`*APR extrapolated from ${humanSpan(v.aprDays)} — a ×${Math.round(365.25 / v.aprDays)} annualisation, so a direction not a rate.`);
    }
    if (u && u.costBasis && !u.costBasisExact) caveats.push('*Cost basis is a bound: at least one liquidity addition was single-sided.');
    if (h && h.currentUnavailable) caveats.push('Current collectable amounts could not be read, so return and fee figures are withheld.');
    if (u && u.bridged) caveats.push('USD priced via the bridge origin chain; assumes the wrapped token holds its peg.');
    if (h && h.unavailable) caveats.push(`History unavailable — ${esc(h.unavailable)}`);

    return rows.join('') + (caveats.length ? `<div class="note">${caveats.join(' ')}</div>` : '');
  }

  function rangeBar(d, h) {
    const lo = Math.min(d.priceLower, d.priceUpper);
    const hi = Math.max(d.priceLower, d.priceUpper);
    if (!(lo > 0 && hi > lo && Number.isFinite(lo) && Number.isFinite(hi))) return '';

    const closed = d.status === 'closed' && h && h.exit;
    const nowP = closed ? h.exit.price : d.price;
    if (!(nowP > 0) || !Number.isFinite(nowP)) return '';

    const lnLo = Math.log(lo), lnHi = Math.log(hi), lnNow = Math.log(nowP);
    const span = lnHi - lnLo;
    const pad = span * 0.45;
    let viewLo = lnLo - pad, viewHi = lnHi + pad;
    if (lnNow < viewLo) viewLo = lnNow - pad * 0.2;
    if (lnNow > viewHi) viewHi = lnNow + pad * 0.2;
    const view = viewHi - viewLo || 1;
    const pct = (ln) => ((ln - viewLo) / view) * 100;
    const bandL = pct(lnLo), bandR = pct(lnHi), nowPct = pct(lnNow);
    const inRange = nowP >= lo && nowP <= hi;

    const s0 = d.token0Meta && d.token0Meta.symbol;
    const s1 = d.token1Meta && d.token1Meta.symbol;
    const unit = (s0 && s1) ? `<span class="unit">${esc(s1)} per ${esc(s0)}</span>` : '';

    return `<div class="meter">
      <div class="track">
        <div class="band ${inRange ? 'in' : 'out'}" style="left:${bandL.toFixed(2)}%;width:${(bandR - bandL).toFixed(2)}%"></div>
        <div class="now" style="left:${nowPct.toFixed(2)}%"></div>
      </div>
      <div class="ticks">
        <span>${fmt(lo, 6)}</span>
        <span>now ${fmt(nowP, 6)}</span>
        <span>${fmt(hi, 6)}</span>
      </div>
      ${unit ? `<div class="ticks" style="justify-content:center">${unit}</div>` : ''}
    </div>`;
  }

  globalThis.LPLens = { CSS, CSS_PANEL, CSS_COMPONENTS, details, rebalanceLine, esc, fmt, humanSpan, ageText, priceText, hero, rangeBar };
})();
