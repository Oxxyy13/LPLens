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
[data-price-view="inverse"] { display: none; }
.position-card.price-inverted [data-price-view="standard"] { display: none; }
.position-card.price-inverted [data-price-view="inverse"] { display: revert; }
.price-flip {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  width: 100%; margin: 7px 0 0; padding: 3px 6px; border: 0; border-radius: 6px;
  background: transparent; color: var(--ink-3); cursor: pointer;
  font: 10px/1.25 var(--mono); letter-spacing: .015em;
}
.price-flip:hover, .price-flip:focus-visible { background: var(--signal-soft); color: var(--signal-strong); }
.price-flip-mark { color: var(--signal); font-size: 13px; }
.dex-range {
  margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line);
}
.dex-range-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dex-range-title { font: 650 11px/1.2 var(--ui); color: var(--ink); }
.dex-range-scale { margin-left: 6px; padding: 2px 5px; border: 1px solid var(--line);
  border-radius: 999px; font: 8.5px/1.2 var(--mono); letter-spacing: .045em;
  text-transform: uppercase; color: var(--ink-3); }
.dex-range-unit { margin-top: 4px; font: 10px/1.35 var(--mono); color: var(--ink-3); }
.dex-range-plot {
  position: relative; height: 120px; margin: 9px 0 7px; overflow: hidden;
  border: 1px solid var(--line); border-radius: 9px;
  background:
    repeating-linear-gradient(0deg, transparent 0, transparent calc(25% - 1px),
      color-mix(in srgb, var(--line) 52%, transparent) 25%),
    linear-gradient(90deg, color-mix(in srgb, var(--panel-2) 72%, transparent), var(--panel));
}
.dex-range-axis { position: absolute; top: 0; bottom: 0; right: 96px; width: 1px; background: var(--line-strong); }
.dex-range-band {
  position: absolute; left: 10%; right: 96px; min-height: 3px;
  background: color-mix(in srgb, var(--good-soft) 80%, transparent);
  border-top: 2px solid var(--good); border-bottom: 2px solid var(--good);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--good) 10%, transparent);
}
.dex-range-band.out {
  background: color-mix(in srgb, var(--warn-soft) 78%, transparent);
  border-color: var(--warn);
}
.dex-range-now {
  position: absolute; left: 5%; right: 82px; height: 2px;
  background: var(--signal); transform: translateY(50%);
  box-shadow: 0 0 8px color-mix(in srgb, var(--signal) 32%, transparent);
}
.dex-range-now::after {
  content: ""; position: absolute; right: 14px; top: 50%; width: 7px; height: 7px;
  border: 2px solid var(--panel); border-radius: 50%; background: var(--signal);
  transform: translate(50%, -50%);
}
.dex-range-price { position: absolute; right: 5px; width: 84px; padding: 2px 4px;
  border: 1px solid var(--line); border-radius: 5px; background: color-mix(in srgb, var(--panel) 92%, transparent);
  color: var(--ink-3); transform: translateY(50%); font: 8px/1.15 var(--mono);
  font-variant-numeric: tabular-nums; }
.dex-range-price span { display: block; text-transform: uppercase; letter-spacing: .045em; }
.dex-range-price b { display: block; color: var(--ink-2); font-size: 10.5px; font-weight: 550; white-space: nowrap; }
.dex-range-price.now-label { z-index: 1; border-color: color-mix(in srgb, var(--signal) 54%, var(--line));
  color: var(--signal-strong); }
.dex-range-price.now-label b { color: var(--signal-strong); }
.dex-range-foot { margin-top: 5px; font: 10px/1.4 var(--mono); color: var(--ink-3); }
.dex-range-unavailable { padding: 9px; border: 1px dashed var(--line); border-radius: 8px; }
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
    box-sizing: border-box;
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
.gc-dense-metrics { display: none; }
.gc.dense { padding: 5px 8px; border-radius: 10px; }
.gc.dense .gc-pair { font-size: 10.5px; line-height: 1.2; }
.gc.dense .gc-main { display: flex; align-items: baseline; gap: 6px; white-space: nowrap; }
.gc.dense .gc-lbl { font-size: 8.5px; }
.gc.dense .gc-val { font-size: 17px; line-height: 1.15; margin: 1px 0 0; }
.gc.dense .gc-metrics, .gc.dense .gc-bar, .gc.dense .gc-status { display: none; }
.gc.dense .gc-dense-metrics {
  display: block; margin-top: 1px; font-size: 9.5px; line-height: 1.2;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.portfolio-card {
  position: relative; overflow: hidden; margin: 8px 10px; padding: 10px 11px;
  background: linear-gradient(145deg, color-mix(in srgb, var(--panel-2) 28%, var(--panel)), var(--panel));
  border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow-sm);
}
.portfolio-card::after { content: ""; position: absolute; inset: 0 auto 0 0;
  width: 2px; background: var(--signal); opacity: .72; }
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

  const invertBound = (bound) => ({
    'at or below': 'at or above',
    'at or above': 'at or below',
    'at most': 'at least',
    'at least': 'at most',
  }[bound] || bound);

  function orientPoint(point, inverse = false) {
    if (!point || !inverse) return point;
    const price = Number(point.price);
    if (!(price > 0) || !Number.isFinite(price)) return null;
    return { ...point, price: 1 / price, bound: invertBound(point.bound) };
  }

  /**
   * Price-display orientation only. Position arithmetic remains token1/token0;
   * this view helper reciprocates every displayed price as one consistent set.
   */
  function priceOrientation(d, h, s0, s1, inverse = false) {
    const rawLo = Math.min(d.priceLower, d.priceUpper);
    const rawHi = Math.max(d.priceLower, d.priceUpper);
    const closed = d.status === 'closed' && h && h.exit;
    const rawNow = closed ? h.exit.price : d.price;
    const valid = rawLo > 0 && rawHi > rawLo && Number.isFinite(rawLo) && Number.isFinite(rawHi)
      && rawNow > 0 && Number.isFinite(rawNow);
    const lo = valid ? (inverse ? 1 / rawHi : rawLo) : null;
    const hi = valid ? (inverse ? 1 / rawLo : rawHi) : null;
    const now = valid ? (inverse ? 1 / rawNow : rawNow) : null;
    const base = inverse ? s1 : s0;
    const quote = inverse ? s0 : s1;
    const status = inverse
      ? ({ below: 'above', above: 'below' }[d.status] || d.status)
      : d.status;
    return {
      valid, lo, hi, now, base, quote, status,
      unit: base && quote ? `${quote} per ${base}` : '',
      entry: orientPoint(h && h.entry, inverse),
      exit: orientPoint(h && h.exit, inverse),
    };
  }

  const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
  const ZERO_ADDRESS = /^0x0{40}$/;

  function currencyAddress(value, wrappedNative = '') {
    const address = String(value || '').toLowerCase();
    const wrapped = String(wrappedNative || '').toLowerCase();
    if (!EVM_ADDRESS.test(address)) return '';
    if (ZERO_ADDRESS.test(address) && EVM_ADDRESS.test(wrapped)) return wrapped;
    return address;
  }

  /**
   * Match LPLens's token1/token0 price to Dexscreener's quote/base display by
   * contract address. Symbols are labels only and never decide orientation.
   */
  function dexscreenerOrientation(d, pair, wrappedNative = '') {
    const token0 = currencyAddress(d && d.token0, wrappedNative);
    const token1 = currencyAddress(d && d.token1, wrappedNative);
    const baseAddress = currencyAddress(pair && pair.baseToken && pair.baseToken.address, wrappedNative);
    const quoteAddress = currencyAddress(pair && pair.quoteToken && pair.quoteToken.address, wrappedNative);
    const direct = token0 && token1 && token0 === baseAddress && token1 === quoteAddress;
    const inverse = token0 && token1 && token1 === baseAddress && token0 === quoteAddress;
    if (!!direct === !!inverse) {
      return {
        valid: false,
        matched: false,
        reason: direct ? 'ambiguous-native-wrapped-pair' : 'pair-token-mismatch',
      };
    }

    const s0 = d.token0Meta && d.token0Meta.symbol;
    const s1 = d.token1Meta && d.token1Meta.symbol;
    const oriented = priceOrientation(d, d.history || {}, s0, s1, !!inverse);
    if (!oriented.valid) return { ...oriented, matched: true, inverse: !!inverse };

    const base = String(pair.baseToken.symbol || oriented.base || '');
    const quote = String(pair.quoteToken.symbol || oriented.quote || '');
    return {
      ...oriented,
      matched: true,
      inverse: !!inverse,
      base,
      quote,
      unit: base && quote ? `${quote} per ${base}` : oriented.unit,
    };
  }

  /** An independent log scale owned by LPLens, never a claimed chart coordinate. */
  function logRangeScale(o) {
    if (!o || !o.valid || !(o.lo > 0) || !(o.hi > o.lo) || !(o.now > 0)
        || !Number.isFinite(o.lo) || !Number.isFinite(o.hi) || !Number.isFinite(o.now)) return null;
    const lnLo = Math.log(o.lo), lnHi = Math.log(o.hi), lnNow = Math.log(o.now);
    const span = lnHi - lnLo;
    const pad = span * 0.45;
    let viewLo = lnLo - pad, viewHi = lnHi + pad;
    if (lnNow < viewLo) viewLo = lnNow - pad * 0.2;
    if (lnNow > viewHi) viewHi = lnNow + pad * 0.2;
    const view = viewHi - viewLo || 1;
    const pct = (value) => clampPercent(((value - viewLo) / view) * 100);
    return {
      loPct: pct(lnLo),
      hiPct: pct(lnHi),
      nowPct: pct(lnNow),
      viewLo,
      viewHi,
    };
  }

  function clampPercent(value) {
    return Math.max(0, Math.min(100, value));
  }

  function dexscreenerRangeRuler(d, pair, wrappedNative = '', pairError = '') {
    const o = dexscreenerOrientation(d, pair, wrappedNative);
    if (!o.valid) {
      const unavailable = pairError === 'pair-metadata-unavailable'
        ? 'Range orientation is temporarily unavailable because Dexscreener pair metadata could not be read.'
        : o.matched
          ? 'Range data unavailable. LPLens will not draw an invalid scale.'
          : 'Pair orientation unavailable. LPLens will not guess from token symbols.';
      return `<div class="dex-range dex-range-unavailable">
        <div class="dex-range-head"><span class="dex-range-title">LP range</span></div>
        <div class="dex-range-foot">${esc(unavailable)}</div>
      </div>`;
    }

    const scale = logRangeScale(o);
    if (!scale) return '';
    const inRange = o.now >= o.lo && o.now <= o.hi;
    const status = o.status === 'in-range' ? 'in range'
      : o.status === 'below' ? 'below range'
      : o.status === 'above' ? 'above range'
      : String(o.status || 'open');
    const bandHeight = Math.max(0.5, scale.hiPct - scale.loPct);
    const nowNearLo = Math.abs(scale.nowPct - scale.loPct) < 16;
    const nowNearHi = Math.abs(scale.nowPct - scale.hiPct) < 16;
    const showNowLabel = !nowNearLo && !nowNearHi;
    const aria = `LPLens own log scale, not chart-aligned; LP range ${fmt(o.lo, 8)} to ${fmt(o.hi, 8)} ${o.unit}; current ${fmt(o.now, 8)}; ${status}`;
    const foot = showNowLabel
      ? 'Not chart-aligned. Exact on-chain range and current pool price.'
      : `Now ${fmt(o.now, 8)}. Not chart-aligned.`;

    return `<div class="dex-range" data-range-status="${esc(o.status)}" data-range-orientation="${o.inverse ? 'inverse' : 'direct'}">
      <div class="dex-range-head">
        <span><span class="dex-range-title">LP range</span><span class="dex-range-scale">own log scale</span></span>
        <span class="pill ${esc(o.status)}">${esc(status)}</span>
      </div>
      <div class="dex-range-unit">${esc(o.unit)}</div>
      <div class="dex-range-plot" role="img" aria-label="${esc(aria)}">
        <div class="dex-range-axis"></div>
        <div class="dex-range-band ${inRange ? '' : 'out'}" style="bottom:${scale.loPct.toFixed(2)}%;height:${bandHeight.toFixed(2)}%"></div>
        <div class="dex-range-now" style="bottom:${scale.nowPct.toFixed(2)}%"></div>
        <div class="dex-range-price" style="bottom:${scale.hiPct.toFixed(2)}%"><span>max</span><b>${fmt(o.hi, 8)}</b></div>
        ${showNowLabel ? `<div class="dex-range-price now-label" style="bottom:${scale.nowPct.toFixed(2)}%"><span>now</span><b>${fmt(o.now, 8)}</b></div>` : ''}
        <div class="dex-range-price" style="bottom:${scale.loPct.toFixed(2)}%"><span>min</span><b>${fmt(o.lo, 8)}</b></div>
      </div>
      <div class="dex-range-foot">${esc(foot)}</div>
    </div>`;
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
   * APR, LP return, gross additions and worth-now. Every one of them was true and
   * the aggregate was unreadable, which is its own kind of wrong: a number
   * nobody finds is not informing anyone. Detail moved behind a toggle.
   *
   * LP return leads because it answers "did the LP strategy make money". vs-holding sits
   * directly under it because it answers "was LPing the reason", and those two
   * routinely disagree in sign.
   */
  function hero(d, h, s1) {
    const v = h && h.vsHodl;
    const u = d.usd;
    const hasTotal = u && u.pnl !== null && u.pnl !== undefined;
    const hasVsUsd = u && u.vsHodl !== null && u.vsHodl !== undefined;
    const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'muted');
    const vsPct = v && Number.isFinite(v.pct)
      ? `${v.pct >= 0 ? '+' : ''}${v.pct.toFixed(2)}% · fees minus IL`
      : 'fees minus IL';

    const vsInner = h && h.unavailable
      ? ['muted', '—', 'lifetime history unavailable']
      : hasVsUsd
        ? [cls(u.vsHodl), money(u.vsHodl, Math.abs(u.vsHodl) < 10 ? 2 : 2), vsPct]
        : v
          ? [cls(v.pct), `${v.pct >= 0 ? '+' : ''}${v.pct.toFixed(2)}%`, 'fees minus IL']
          : ['muted', '—', 'no history'];

    const totInner = h && h.unavailable
      ? ['muted', '—', 'unavailable']
      : hasTotal
        ? [cls(u.pnl), money(u.pnl, Math.abs(u.pnl) < 10 ? 2 : 0),
           `${u.pnlPct >= 0 ? '+' : ''}${u.pnlPct.toFixed(2)}%`]
        : ['muted', '—', u && u.returnUnavailable ? esc(u.returnUnavailable) : ''];

    return `<div class="stats">
      <div class="stat">
        <span class="stat-l">vs holding</span>
        <span class="stat-v ${vsInner[0]}">${vsInner[1]}</span>
        <span class="stat-n">${vsInner[2]}</span>
      </div>
      <div class="stat">
        <span class="stat-l">LP return</span>
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
  function priceHistoryRows(d, h, s0, s1, inverse = false) {
    const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
    const o = priceOrientation(d, h, s0, s1, inverse);
    const closed = d.status === 'closed' && h.exit;
    const drift = o.entry && o.now ? (o.now / o.entry.price - 1) * 100 : null;
    const qual = o.entry && !o.entry.exact
      ? (o.entry.bound === 'at or below' ? 'at least ' : 'at most ') : '';
    const unit = `${esc(o.unit)}`;
    const rows = [];
    rows.push(`<div class="kv"><span>${h.adds > 1 ? 'first add price' : 'entry price'}</span><span class="num">${priceText(o.entry)}<br><span class="unit">${unit}</span></span></div>`);
    if (h.adds > 1) rows.push(`<div class="kv"><span>liquidity additions</span><span class="num">${h.adds}</span></div>`);
    if (o.exit) rows.push(`<div class="kv"><span>exit price</span><span class="num">${priceText(o.exit)}<br><span class="unit">${unit}</span></span></div>`);
    if (drift !== null) {
      const winner = drift < 0
        ? `${esc(o.quote)} up ${(((1 / (1 + drift / 100)) - 1) * 100).toFixed(1)}% vs ${esc(o.base)}`
        : `${esc(o.base)} up ${drift.toFixed(1)}% vs ${esc(o.quote)}`;
      rows.push(`<div class="kv"><span>price ${closed ? 'entry to exit' : 'since entry'}</span><span class="num ${cls(drift)}">${esc(qual)}${drift > 0 ? '+' : ''}${drift.toFixed(2)}%<br><span class="unit">${unit}</span></span></div>`);
      rows.push(`<div class="note" style="margin-top:2px">i.e. ${winner}</div>`);
    }
    return rows.join('');
  }

  function details(d, h, s0, s1, flippable = false) {
    const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
    const v = h && h.vsHodl;
    const u = d.usd;
    const rows = [];

    if (v) {
      rows.push(`<div class="kv"><span>fees earned</span><span class="num pos">+${v.feesPct.toFixed(3)}%</span></div>`);
      rows.push(`<div class="kv"><span>impermanent loss</span><span class="num ${v.il > 0 ? 'neg' : ''}">${v.il > 0 ? '−' : '+'}${Math.abs(v.ilPct).toFixed(3)}%</span></div>`);
    }
    const grossAdded = u && u.grossAdded !== undefined ? u.grossAdded : u && u.costBasis;
    const grossExact = u && u.grossAddedExact !== undefined
      ? u.grossAddedExact : u && u.costBasisExact;
    if (u && grossAdded !== null && grossAdded !== undefined
        && u.totalNow !== null && u.totalNow !== undefined) {
      rows.push(`<div class="kv"><span>gross added</span><span class="num">$${grossAdded.toLocaleString('en-US', { maximumFractionDigits: 2 })}${grossExact ? '' : '*'}</span></div>`);
      if (u.collectedProceeds !== null && u.collectedProceeds !== undefined) {
        const returnedLabel = h && h.feeCreditsOnAdd ? 'fees credited on adds' : 'cash returned';
        rows.push(`<div class="kv"><span>${returnedLabel}</span><span class="num">$${u.collectedProceeds.toLocaleString('en-US', { maximumFractionDigits: 2 })}${u.collectedProceedsExact ? '' : '*'}</span></div>`);
      }
      if (u.netCashIn !== null && u.netCashIn !== undefined) {
        rows.push(`<div class="kv"><span>net cash in</span><span class="num">${u.netCashIn < 0 ? '−' : ''}$${Math.abs(u.netCashIn).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span></div>`);
      }
      rows.push(`<div class="kv"><span>worth now</span><span class="num">$${u.totalNow.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span></div>`);
    }

    const capitalEvents = u && Array.isArray(u.capitalEvents) ? u.capitalEvents : [];
    if (capitalEvents.length > 1) {
      const when = (leg) => leg.time
        ? new Date(leg.time * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : `block ${Number(leg.block).toLocaleString('en-US')}`;
      rows.push('<div class="sep"></div>');
      rows.push('<div class="herolbl" style="margin-bottom:4px">capital additions</div>');
      for (const leg of capitalEvents) {
        const amounts = `${fmt(leg.amount0)} ${esc(s0)} + ${fmt(leg.amount1)} ${esc(s1)}`;
        rows.push(`<div class="kv"><span>${esc(leg.kind)}<br><span class="unit">${esc(when(leg))}</span></span>`
          + `<span class="num">$${leg.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${leg.exact ? '' : '*'}<br><span class="unit">${amounts}</span></span></div>`);
      }
      rows.push('<div class="note" style="margin-top:2px">Each addition keeps its own date and historical USD price; LP return uses the full cash-flow ledger.</div>');
    }

    if (h && !h.unavailable) {
      // Every price here is token1-per-token0, and printing it bare is
      // genuinely unreadable: on a WETH/HMM pool a *negative* move means HMM
      // got stronger, which reads as a loss. This was misread in testing
      // against a token that was up 59% while the panel showed −34%. So the
      // unit travels with the number, and the drift states which side won.
      rows.push('<div class="sep"></div>');
      const standardPrices = priceHistoryRows(d, h, s0, s1, false);
      if (flippable) {
        rows.push(`<div data-price-view="standard">${standardPrices}</div>`);
        rows.push(`<div data-price-view="inverse">${priceHistoryRows(d, h, s0, s1, true)}</div>`);
      } else {
        rows.push(standardPrices);
      }
      const priceGroups = d.status === 'closed' || !u ? [] : [
        u.tokenPriceChange,
        u.latestAddPriceChange,
      ].filter(Boolean);
      if (priceGroups.length) rows.push('<div class="sep"></div>');
      const usdPrice = (n) => `$${fmt(n, n < 1 ? 8 : 2)}`;
      for (const group of priceGroups) {
        const tokenMoves = [
          [s0, group.token0], [s1, group.token1],
        ].filter(([, move]) => move && Number.isFinite(move.pct));
        if (!tokenMoves.length) continue;
        rows.push(`<div class="herolbl" style="margin-bottom:4px${group === priceGroups[0] ? '' : ';margin-top:8px'}">token prices since ${esc(group.label)}</div>`);
        for (const [symbol, move] of tokenMoves) {
          rows.push(`<div class="kv"><span>${esc(symbol)} price</span><span class="num ${cls(move.pct)}">${move.pct > 0 ? '+' : ''}${move.pct.toFixed(2)}%<br><span class="unit">${usdPrice(move.from)} → ${usdPrice(move.to)}</span></span></div>`);
        }
      }
      if (u && u.tokenPriceChange && u.tokenPriceChange.label === 'first add') {
        rows.push('<div class="note" style="margin-top:2px">Since-opened market context stays anchored to the first add. LP return values each addition separately at its own block.</div>');
      }
      rows.push('<div class="sep"></div>');
      rows.push(`<div class="kv"><span>deposited</span><span class="num">${fmt(h.deposited0)} ${esc(s0)}<br>${fmt(h.deposited1)} ${esc(s1)}</span></div>`);
      rows.push(`<div class="kv"><span>${h.feeCreditsOnAdd ? 'fees credited' : 'collected'}</span><span class="num">${fmt(h.received0)} ${esc(s0)}<br>${fmt(h.received1)} ${esc(s1)}</span></div>`);
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
    if (u && grossAdded && !grossExact) caveats.push('*Gross added is a bound: at least one liquidity addition was single-sided and no exact archive price was available. LP return is withheld.');
    if (u && u.collectedProceeds !== null && !u.collectedProceedsExact) caveats.push('*Cash returned is bounded because an exact collection-time pool price was unavailable. LP return is withheld.');
    if (h && h.currentUnavailable) caveats.push('Current collectable amounts could not be read, so return and fee figures are withheld.');
    if (u && u.bridged) caveats.push('USD priced via the bridge origin chain; assumes the wrapped token holds its peg.');
    if (h && h.unavailable) caveats.push(`History unavailable — ${esc(h.unavailable)}`);

    return rows.join('') + (caveats.length ? `<div class="note">${caveats.join(' ')}</div>` : '');
  }

  function rangeView(o) {
    const scale = logRangeScale(o);
    if (!scale) return '';
    const bandL = scale.loPct, bandR = scale.hiPct, nowPct = scale.nowPct;
    const inRange = o.now >= o.lo && o.now <= o.hi;
    return `<div class="track">
        <div class="band ${inRange ? 'in' : 'out'}" style="left:${bandL.toFixed(2)}%;width:${(bandR - bandL).toFixed(2)}%"></div>
        <div class="now" style="left:${nowPct.toFixed(2)}%"></div>
      </div>
      <div class="ticks">
        <span>${fmt(o.lo, 6)}</span>
        <span>now ${fmt(o.now, 6)}</span>
        <span>${fmt(o.hi, 6)}</span>
      </div>`;
  }

  function rangeBar(d, h, flippable = false) {
    const s0 = d.token0Meta && d.token0Meta.symbol;
    const s1 = d.token1Meta && d.token1Meta.symbol;
    const standard = priceOrientation(d, h, s0, s1, false);
    if (!standard.valid) return '';
    if (!flippable) {
      return `<div class="meter">${rangeView(standard)}
        ${standard.unit ? `<div class="ticks" style="justify-content:center"><span class="unit">${esc(standard.unit)}</span></div>` : ''}
      </div>`;
    }

    const inverse = priceOrientation(d, h, s0, s1, true);
    return `<div class="meter">
      <div data-price-view="standard">${rangeView(standard)}</div>
      <div data-price-view="inverse">${rangeView(inverse)}</div>
      <button type="button" class="price-flip" aria-pressed="false"
        aria-label="Show prices as ${esc(inverse.unit)}"
        data-price-standard="${esc(standard.unit)}" data-price-inverse="${esc(inverse.unit)}">
        <span data-price-view="standard">${esc(standard.unit)}</span>
        <span data-price-view="inverse">${esc(inverse.unit)}</span>
        <span class="price-flip-mark" aria-hidden="true">⇄</span>
      </button>
    </div>`;
  }

  globalThis.LPLens = {
    CSS, CSS_PANEL, CSS_COMPONENTS, details, rebalanceLine, esc, fmt,
    humanSpan, ageText, priceText, priceOrientation, dexscreenerOrientation,
    logRangeScale, dexscreenerRangeRuler, hero, rangeBar,
  };
})();
