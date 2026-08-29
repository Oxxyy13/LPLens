#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const overlay = readFileSync(new URL('../extension/overlay.js', import.meta.url), 'utf8');
const render = readFileSync(new URL('../extension/render.js', import.meta.url), 'utf8');
const pure = overlay.match(
  /\/\/ BEGIN PURE OVERLAY PANEL PLACEMENT([\s\S]*?)\/\/ END PURE OVERLAY PANEL PLACEMENT/,
);
assert.ok(pure, 'overlay is missing its testable panel-placement block');

const context = vm.createContext({});
vm.runInContext(`${pure[1]}
globalThis.__panelPlacement = {
  validPanelPlacement,
  resolvePanelPlacement,
  panelPlacementFromRect,
};`, context, { filename: 'overlay-panel-placement.js' });
const plain = (value) => JSON.parse(JSON.stringify(value));
const { validPanelPlacement: valid, resolvePanelPlacement: resolve,
  panelPlacementFromRect: fromRect } = context.__panelPlacement;

assert.equal(valid({ x: 0, y: 1 }), true);
for (const invalid of [
  null, [], {}, { x: -0.01, y: 0 }, { x: 0, y: 1.01 },
  { x: Number.NaN, y: 0 }, { x: 0, y: Number.POSITIVE_INFINITY },
]) assert.equal(valid(invalid), false, `invalid placement survived: ${JSON.stringify(invalid)}`);

const viewport = { width: 1000, height: 800 };
const size = { width: 300, height: 400 };
assert.deepEqual(plain(resolve({ x: 0, y: 0 }, size, viewport, 12)), {
  left: 12, top: 12,
});
assert.deepEqual(plain(resolve({ x: 1, y: 1 }, size, viewport, 12)), {
  left: 688, top: 388,
});
assert.deepEqual(plain(resolve({ x: 0.5, y: 0.5 }, size, viewport, 12)), {
  left: 350, top: 200,
});

const stored = plain(fromRect({ left: 688, top: 388, ...size }, viewport, 12));
assert.deepEqual(stored, { x: 1, y: 1 }, 'bottom-right should remain an edge anchor');
assert.deepEqual(plain(resolve(stored, { width: 150, height: 42 }, viewport, 12)), {
  left: 838, top: 746,
}, 'compacting should retain the same bottom-right anchor');
assert.deepEqual(plain(resolve(stored, { width: 300, height: 400 },
  { width: 720, height: 620 }, 12)), { left: 408, top: 208 },
'viewport shrink should keep the panel fully recoverable');
assert.deepEqual(plain(resolve({ x: 1, y: 1 }, { width: 700, height: 600 },
  { width: 500, height: 400 }, 12)), { left: 12, top: 12 },
'a physically oversized panel should still retain its visible top-left control');
assert.equal(resolve({ x: 0, y: 0 }, { width: 0, height: 20 }, viewport, 12), null);
assert.equal(fromRect({ left: 0, top: 0, width: Number.NaN, height: 20 }, viewport, 12), null);

assert.match(overlay, /DEXSCREENER_PANEL_PLACEMENT_KEY = 'dexscreenerPanelPlacementV1'/);
assert.match(overlay, /PANEL_COLLAPSED_KEY = ON_DEXSCREENER[\s\S]*'dexscreenerPanelCollapsed'/);
assert.match(overlay, /if \(!ON_DEXSCREENER \|\| !panel\) return;/,
  'drag behavior must remain scoped to Dexscreener');
assert.match(overlay, /target\.closest\('button, a, input, select, textarea, \[role="button"\]'\)/,
  'the drag surface must not swallow its collapse control');
assert.match(overlay, /event\.button !== 0 \|\| event\.isPrimary === false/);
assert.match(overlay, /setPointerCapture\(pointerId\)/);
assert.match(overlay, /pointercancel/);
assert.match(overlay, /lostpointercapture/);
assert.match(overlay, /rememberDexscreenerPanelPlacement\(panel\)/);
assert.match(overlay, /chrome\.storage\.local\.set\(\{ \[DEXSCREENER_PANEL_PLACEMENT_KEY\]: next \}\)/);
assert.match(overlay, /if \(livePlacement\) dexscreenerPanelPlacement = livePlacement/,
  'an in-flight drag must remain the active placement before pointerup');
assert.match(overlay, /loadGeneration !== collapsedPreferenceGeneration/,
  'a delayed collapse read must not overwrite a newer user choice');
assert.match(overlay, /loadGeneration !== dexscreenerPanelPlacementGeneration/,
  'a delayed placement read must not undo a drag or reset');
assert.match(overlay, /panel\.style\.bottom = 'auto'/,
  'free placement must override the shared bottom dock instead of inheriting it');
assert.match(overlay, /new ResizeObserver\(\(\) => \{/);
assert.match(overlay, /panel\.classList\.contains\('dragging'\)/,
  'dynamic panel height must re-clamp without fighting an active drag');
assert.match(overlay, /dexscreenerPanelResizeObserver\.observe\(panel\)/,
  'range and details height changes must keep the saved panel on-screen');
assert.match(overlay, /if \(!ON_DEXSCREENER\) attachGrip/,
  'the bottom-docked resize grip must not run after free positioning');
assert.match(overlay, /aria-expanded/);
assert.match(overlay, /aria-label/);

assert.match(render, /\.panel\.dexscreener-panel\.collapsed\s*\{/);
assert.match(render, /width:\s*fit-content !important/);
assert.match(render, /\.panel\.dexscreener-panel\.collapsed \.chart-range-banner/);
assert.match(render, /\.dexscreener-panel \.panel-drag-handle \{ cursor: grab/);
assert.match(render, /button:focus-visible/);

const renderStart = overlay.indexOf('function render(html, openWhenOverlapping = false)');
const renderEnd = overlay.indexOf('// Showing the running version', renderStart);
const renderBlock = overlay.slice(renderStart, renderEnd);
assert.ok(renderStart > 0 && renderEnd > renderStart);
assert.match(renderBlock,
  /finishActiveDexscreenerPanelDrag\(\);[\s\S]*panel\.innerHTML = html/,
  'a response rerender must finish and persist an active drag before replacing its header');

console.log('overlay panel: Dex-only compact state, drag persistence and viewport clamping pass');
