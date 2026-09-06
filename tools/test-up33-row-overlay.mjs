#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const overlay = readFileSync(new URL('../extension/overlay.js', import.meta.url), 'utf8');
const render = readFileSync(new URL('../extension/render.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../extension/sw.js', import.meta.url), 'utf8');

const pureBlock = overlay.match(
  /\/\/ BEGIN PURE UP33 ROW ANCHORING([\s\S]*?)\/\/ END PURE UP33 ROW ANCHORING/,
);
assert.ok(pureBlock, 'UP33 row anchoring helpers must remain directly testable');
const context = vm.createContext({ BigInt, Math, Number, String });
vm.runInContext(`
  const GUTTER_GAP = 12;
  const GUTTER_MIN = 132;
  ${pureBlock[1]}
  globalThis.helpers = {
    parseUp33FlowKey, up33RightGutterPlacement, up33BoundarySafePlacement,
    up33ManageDetailPlacement,
  };
`, context);
const {
  parseUp33FlowKey, up33RightGutterPlacement, up33BoundarySafePlacement,
  up33ManageDetailPlacement,
} = context.helpers;

assert.equal(parseUp33FlowKey('cl-0'), '0');
assert.equal(parseUp33FlowKey('cl-77'), '77');
const maxUint256 = (1n << 256n) - 1n;
assert.equal(parseUp33FlowKey(`cl-${maxUint256}`), maxUint256.toString());
for (const bad of [
  '', '77', 'cl-', 'cl-01', 'cl--1', 'cl-1.5', 'cl-1e3', 'cl- 1',
  ' cl-1', 'cl-1 ', 'v2-77', 'lock-v3-77', 'cl-0x4d',
  `cl-${1n << 256n}`,
]) {
  assert.equal(parseUp33FlowKey(bad), null, `${bad} must fail closed`);
}

assert.deepEqual(
  JSON.parse(JSON.stringify(up33RightGutterPlacement(
    { right: 1300, width: 900, height: 76 }, 1600,
  ))),
  { left: 1312, width: 190 },
);
assert.deepEqual(
  JSON.parse(JSON.stringify(up33RightGutterPlacement(
    { right: 1430, width: 900, height: 76 }, 1600,
  ))),
  { left: 1442, width: 146 },
);
assert.equal(up33RightGutterPlacement(
  { right: 1450, width: 900, height: 76 }, 1600,
), null, 'less than the safe right-gutter width must use the floating fallback');
assert.equal(up33RightGutterPlacement(
  { right: 1000, width: 0, height: 76 }, 1600,
), null, 'zero-width React remnants must not anchor a card');
assert.equal(up33RightGutterPlacement(
  { right: 1000, width: 900, height: 0 }, 1600,
), null, 'zero-height React remnants must not anchor a card');
assert.deepEqual(
  JSON.parse(JSON.stringify(up33BoundarySafePlacement(
    { right: 1000, width: 900, height: 76 }, 1600, 1160,
  ))),
  { left: 958, width: 190 },
  'a right-side drawer must shift the card entirely to its left',
);
assert.deepEqual(
  JSON.parse(JSON.stringify(up33BoundarySafePlacement(
    { right: 700, width: 500, height: 76 }, 1600, 1000,
  ))),
  { left: 712, width: 190 },
  'a non-overlapping drawer must not disturb ordinary row alignment',
);
assert.equal(up33BoundarySafePlacement(
  { right: 100, width: 90, height: 76 }, 320, 150,
), null, 'a drawer with no safe left space must retain the floating fallback');
assert.deepEqual(
  JSON.parse(JSON.stringify(up33ManageDetailPlacement(1600, 1160))),
  { left: 764, width: 384 },
  'the expanded card must sit immediately left of the right-side drawer',
);
assert.deepEqual(
  JSON.parse(JSON.stringify(up33ManageDetailPlacement(800, 360))),
  { left: 12, width: 336 },
  'the expanded card may narrow without crossing the safe viewport margin',
);
assert.equal(up33ManageDetailPlacement(700, 260), null,
  'the expanded card must fail closed when no readable width remains');
assert.equal(up33ManageDetailPlacement(1600, 1600), null,
  'an offscreen dialog must not create an expanded card');

const rowBlock = overlay.match(
  /function syncUp33Rows\(\) \{([\s\S]*?)\n\}\n\nasync function syncUp33Liquidity/,
);
assert.ok(rowBlock, 'UP33 row rematching function is missing');
assert.match(rowBlock[1], /button\[data-flow\^="cl-"\]/);
assert.match(rowBlock[1], /up33RowHasExactPositionId/,
  'the semantic flow key and visible NFT id must agree');
assert.match(overlay, /function up33RowHasExactPositionId[\s\S]*?up33PositionIdLeafVisible\(leaf, anchor\)/,
  'a hidden exact NFT-id leaf must not validate a visible row');
assert.match(rowBlock[1], /if \(visible\) selectorMismatch = true/,
  'a visible malformed or drifted row must restore the floating fallback');
assert.match(rowBlock[1], /if \(!measurable\) continue/,
  'fully hidden retained rows must not disable visible row cards');
assert.match(rowBlock[1], /up33PositionMap\.get\(positionId\)/,
  'page ids may only intersect the active-wallet result map');
assert.match(rowBlock[1], /up33RowPlacement/);
assert.match(rowBlock[1], /const dialogOpen = up33DockedDialogLeft\(innerWidth\) < innerWidth/);
assert.match(rowBlock[1], /setUp33FloatingVisible\(!detailVisible && !dialogOpen\)/,
  'an open dialog with no safe card space must hide the larger fallback');
assert.match(rowBlock[1], /setUp33FloatingVisible\(true\)/,
  'selector, wallet, or layout mismatch must retain the floating fallback');
assert.match(rowBlock[1], /className = 'gc dense up33-row'/);
assert.doesNotMatch(rowBlock[1], /sendMessage|fetch\(|innerText|window\.ethereum|chrome\.storage/,
  'DOM rematching must not refetch, read broad text, or access wallet state');

assert.match(overlay, /if \(ON_UP33 && UP33_LIST_ROUTE\.test\(location\.pathname\)\) \{\s*syncUp33Rows\(\)/,
  'UP33 React mutations must rematch locally without navigation');
assert.match(overlay, /function watchUp33RowGeometry\(rows\)/,
  'UP33 row and container size changes must reposition cards');
assert.match(overlay, /function up33DockedDialogLeft\(viewportWidth\)/);
assert.match(overlay, /querySelectorAll\('\[role="dialog"\]'\)/,
  'UP33 placement may inspect only the semantic dialog boundary');
assert.match(overlay, /const viewportRight = Number\(viewportWidth\)/);
assert.match(overlay, /rect\.right >= viewportRight - 2/,
  'every dialog candidate must be tested against the immutable viewport edge');
const dialogGeometryBlock = overlay.match(
  /function up33VisibleDockedDialogLeft\(dialog, viewportWidth\) \{([\s\S]*?)\n\}\n\nfunction up33DockedDialogs/,
);
assert.ok(dialogGeometryBlock, 'semantic dialog geometry helper is missing');
assert.doesNotMatch(dialogGeometryBlock[1], /textContent|innerText|innerHTML|dialog\.querySelector/,
  'Manage matching must never read dialog content');
assert.match(dialogGeometryBlock[1], /dialog\.isConnected/,
  'a detached former Manage dialog must stop matching immediately');
assert.match(dialogGeometryBlock[1], /horizontalOverlap >= Math\.min\(GUTTER_MIN, rect\.width\)/,
  'an offscreen translated drawer must not count as a visible right boundary');
assert.match(dialogGeometryBlock[1], /aria-hidden/,
  'aria-hidden semantic dialogs must fail closed');
assert.match(dialogGeometryBlock[1], /style\.display === 'none'/);
assert.match(dialogGeometryBlock[1], /style\.visibility === 'hidden'/);
assert.match(dialogGeometryBlock[1], /opacity\) && opacity <= 0/,
  'transparent mounted dialogs must fail closed');
assert.match(overlay, /\['transitionend', 'transitioncancel', 'animationend', 'animationcancel'\]/,
  'animated drawers must trigger a final geometry check');
assert.match(overlay, /target\.closest\('\[role="dialog"\]'\)/,
  'motion rechecks must be limited to the semantic dialog subtree');
assert.match(overlay, /rect\.right < innerWidth - 2/,
  'motion rechecks must ignore dialogs that do not reach the right edge');
assert.match(overlay, /attributes: true[\s\S]*attributeFilter: \['class', 'style', 'hidden', 'aria-hidden'\]/,
  'UP33 class and style layout changes must trigger local realignment');
assert.match(overlay, /addEventListener\('scroll', \(\) => \{[\s\S]*?UP33_LIST_ROUTE[\s\S]*?scheduleList\(\)/,
  'scrolling a malformed row into view must recheck row safety locally');
assert.match(overlay, /addEventListener\('resize', \(\) => \{[\s\S]*?UP33_LIST_ROUTE[\s\S]*?scheduleList\(\)/,
  'responsive duplicate rows must be reselected after resize');
assert.match(overlay, /if \(ON_UP33\) \{[\s\S]*?up33Generation\+\+[\s\S]*?clearUp33Rows\(true, true\)/,
  'active-wallet changes must remove old-wallet row cards immediately');
assert.match(overlay, /if \(!UP33_LIST_ROUTE\.test\(location\.pathname\)\) \{\s*clearUp33ManageSelection\(\)/,
  'leaving the exact UP33 list route must clear the memory-only Manage selection');
assert.match(overlay, /function shutdownRevoked\(\) \{[\s\S]*?if \(ON_UP33\) clearUp33Rows\(true, true\)/,
  'permission revocation must disconnect UP33 geometry observers');
assert.match(overlay, /addEventListener\('click',[\s\S]*?target\.closest\('button\[data-flow\^="cl-"\]'\)[\s\S]*?up33RowHasExactPositionId/,
  'expanded detail must start only from the exact validated public CL row the user clicked');
const manageClickBlock = overlay.match(
  /addEventListener\('click', \(event\) => \{([\s\S]*?)\n\}, \{ passive: true, capture: true \}\);/,
);
assert.ok(manageClickBlock, 'memory-only UP33 Manage activation listener is missing');
assert.doesNotMatch(manageClickBlock[1], /sendMessage|fetch\(|chrome\.storage|localStorage|sessionStorage|telemetry/i,
  'selecting a Manage row must not persist or transmit the public position ID');
assert.match(overlay, /addEventListener\('click',[\s\S]*?if \(event\.isTrusted !== true\) return;/,
  'synthetic page clicks must fail closed before selecting a Manage position');
assert.match(overlay, /up33RowHasExactPositionId\(anchor, positionId\)[\s\S]*?if \(!up33PositionMap\.has\(positionId\)\) return;[\s\S]*?up33PendingPositionId = positionId/,
  'an unowned public row ID must be rejected before it enters selection memory');
assert.match(overlay, /if \(up33DockedDialogLeft\(innerWidth\) < innerWidth\) \{\s*clearUp33ManageSelection\(\);[\s\S]*?return;/,
  'a row activated behind an already-open dialog must clear stale detail and fail closed');
assert.match(overlay, /function reconcileUp33ManageSelection\(\)/);
assert.match(overlay, /if \(!dialogOpen\) \{\s*if \(up33ManageDialogOpen\) clearUp33ManageSelection\(\)/,
  'closing the right-docked dialog must clear its selected position immediately');
assert.match(overlay, /let up33ManageDialogElement = null;/,
  'Manage selection must retain the exact geometry-only dialog reference');
assert.match(overlay, /if \(up33ManageDialogElement\) \{[\s\S]*?up33VisibleDockedDialogLeft\(\s*up33ManageDialogElement, innerWidth,[\s\S]*?clearUp33ManageSelection\(\)/,
  'another dialog must not extend the selected Manage drawer lifetime');
assert.match(overlay, /up33ManageDialogElement = dialogs\[0\]\.dialog;\s*up33ManagePositionId = up33PendingPositionId/,
  'promotion must bind the exact newly observed dialog element before exposing detail');
const selectionClearBlock = overlay.match(
  /function clearUp33ManageSelection\(\) \{([\s\S]*?)\n\}/,
);
assert.ok(selectionClearBlock, 'memory-only Manage selection reset is missing');
assert.doesNotMatch(selectionClearBlock[1], /chrome\.storage|localStorage|sessionStorage/,
  'the selected public position ID must never be persisted');
assert.match(overlay, /Date\.now\(\) - up33PendingPositionAt <= UP33_MANAGE_ACTIVATION_MS/,
  'an unrelated later dialog must not consume a stale row activation');
assert.match(overlay, /function renderUp33ManageDetail\(\)[\s\S]*?up33PositionMap\.get\(selection\.positionId\)/,
  'expanded detail may use only an ID already present in the sanitized active-wallet map');
assert.match(overlay, /function placeUp33ManageDetail\(\)[\s\S]*?up33PositionMap\.has\(selection\.positionId\)/,
  'placement must not redisplay a selected ID omitted by a fresh active-wallet scan');
assert.match(overlay, /if \(!data \|\| !placement\) \{[\s\S]*?if \(!data\) stale\.remove\(\)/,
  'a fresh scan that omits the selected ID must remove its stale detail node');
const positionMapBlock = overlay.match(
  /function up33MapPositions\(positions\) \{([\s\S]*?)\n\}/,
);
assert.ok(positionMapBlock, 'sanitized UP33 response-map helper is missing');
vm.runInContext(
  `function up33MapPositions(positions) {${positionMapBlock[1]}\n}`
    + '\nglobalThis.mapUp33Positions = up33MapPositions;',
  context,
);
const twoRows = context.mapUp33Positions([
  { positionId: '113960', marker: 'selected' },
  { positionId: '113938', marker: 'other-valid-row' },
]);
assert.equal(twoRows.get('113960').marker, 'selected');
assert.equal(twoRows.get('113938').marker, 'other-valid-row');
const afterOmission = context.mapUp33Positions([
  { positionId: '113938', marker: 'other-valid-row' },
]);
assert.equal(afterOmission.has('113960'), false,
  'a fresh two-row scan omission must invalidate the previously selected position');
assert.equal(afterOmission.get('113938').marker, 'other-valid-row',
  'omitting the selected position must not invalidate another proven row');
assert.match(overlay, /function up33ManageDetailCard\(d, positionId, freshness = \{\}\)/);
const manageRefreshBlock = overlay.match(
  /async function refreshUp33ManageSnapshot\(positionId\) \{([\s\S]*?)\n\}\n\nfunction reconcileUp33ManageSelection/,
);
assert.ok(manageRefreshBlock, 'one-shot Manage-open refresh is missing');
assert.match(manageRefreshBlock[1], /sendMessage\(\{ type: 'LPLENS_UP33_LIQUIDITY' \}\)/,
  'Manage refresh must rescan only the worker-selected active wallet');
assert.doesNotMatch(manageRefreshBlock[1], /sendMessage\(\{[^}]*positionId/,
  'the page-derived public row ID must not enter the worker request');
assert.match(manageRefreshBlock[1], /renderUp33FloatingSnapshot\(\s*positions,[\s\S]*?syncUp33Rows\(\)/,
  'the same fresh response must repaint the floating fallback before it can reappear');
assert.equal((manageRefreshBlock[1].match(/sendMessage\(/g) || []).length, 1,
  'Manage association must issue exactly one automatic refresh request');
const floatingSnapshotBlock = overlay.match(
  /function renderUp33FloatingSnapshot\(positionsValue, unavailableValue, walletLabelValue\) \{([\s\S]*?)\n\}\n\nasync function refreshUp33ManageSnapshot/,
);
assert.ok(floatingSnapshotBlock, 'shared UP33 floating-snapshot renderer is missing');
assert.doesNotMatch(floatingSnapshotBlock[1], /sendMessage|fetch\(|chrome\.storage|localStorage|sessionStorage/,
  'repainting a fresh fallback must not trigger a request or persist page state');
assert.match(overlay, /up33ManagePositionId = up33PendingPositionId;\s*up33PendingPositionId = null;\s*up33PendingPositionAt = 0;\s*void refreshUp33ManageSnapshot/,
  'promotion must clear pending click state and start one refresh');
assert.match(overlay, /card\.dataset\.renderRevision !== renderRevision/,
  'unchanged page mutations must reuse the expanded detail DOM');
assert.doesNotMatch(rowBlock[1], /cards\.innerHTML = ''/,
  'local row rematching must not destroy the expanded detail node');
assert.match(overlay, /Reopen Manage after a transaction to refresh again\./,
  'the expanded card must explain how to refresh after an action');
assert.match(worker, /positionId,/,
  'the sanitized response must carry the canonical public row identity');
assert.match(worker, /canonicalUint256OrNull/);
assert.match(worker, /events\.slice\(0, 12\)/,
  'page-facing capital additions must stay bounded');
assert.match(worker, /up33TokenMoveGroup/,
  'page-facing token price context must cross only through an allowlist');
assert.match(render, /\.gc \{[\s\S]*?pointer-events: none/,
  'row cards must remain pointer-inert around Manage controls');
assert.match(render, /\.gc\.up33-row::before/,
  'UP33 row cards should be visibly identified as LPLens');
assert.match(render, /\.gc\.up33-manage-detail/,
  'the Manage view needs a distinct expanded-card presentation');

const visibleIdBlock = overlay.match(
  /(function up33PositionIdLeafVisible\(leaf, anchor\) \{[\s\S]*?)\n\nfunction chooseUp33RowAnchor/,
);
assert.ok(visibleIdBlock, 'visible UP33 row-id matcher must remain directly testable');
const visibilityContext = vm.createContext({
  Number,
  String,
  innerWidth: 1600,
  innerHeight: 900,
  getComputedStyle: (node) => node.computedStyle || ({
    display: 'inline', visibility: 'visible', contentVisibility: 'visible', opacity: '1',
  }),
});
vm.runInContext(`${visibleIdBlock[1]}\nglobalThis.rowHasId = up33RowHasExactPositionId;`, visibilityContext);
const visibleStyle = {
  display: 'inline', visibility: 'visible', contentVisibility: 'visible', opacity: '1',
};
const anchor = {
  tagName: 'BUTTON', parentElement: null, hidden: false, computedStyle: visibleStyle,
  getAttribute: () => null,
  getBoundingClientRect: () => ({
    left: 100, right: 900, top: 100, bottom: 180, width: 800, height: 80,
  }),
  contains: (node) => node === anchor || anchor.leaves.includes(node) || node === anchor.wrapper,
  querySelectorAll: () => anchor.leaves,
};
const visibleLeaf = {
  children: [], textContent: '#113960', parentElement: anchor, hidden: false,
  computedStyle: visibleStyle, getAttribute: () => null,
  getBoundingClientRect: () => ({
    left: 120, right: 180, top: 120, bottom: 134, width: 60, height: 14,
  }),
};
anchor.leaf = visibleLeaf;
anchor.wrapper = null;
anchor.leaves = [visibleLeaf];
assert.equal(visibilityContext.rowHasId(anchor, '113960'), true,
  'a visible exact leaf must validate');

const hiddenLeaf = {
  children: [], parentElement: anchor, hidden: true, computedStyle: visibleStyle,
  get textContent() { throw new Error('hidden row text must not be read'); },
  getAttribute: () => null,
  getBoundingClientRect: () => ({
    left: 120, right: 180, top: 120, bottom: 134, width: 60, height: 14,
  }),
};
const visibleWrongLeaf = {
  children: [], textContent: '#999999', parentElement: anchor, hidden: false,
  computedStyle: visibleStyle, getAttribute: () => null,
  getBoundingClientRect: () => ({
    left: 120, right: 180, top: 120, bottom: 134, width: 60, height: 14,
  }),
};
anchor.leaves = [hiddenLeaf, visibleWrongLeaf];
assert.equal(visibilityContext.rowHasId(anchor, '113960'), false,
  'a hidden exact leaf beside visible misleading text must fail closed');

const detailBlock = overlay.match(
  /(function up33DetailNumber\(value\) \{[\s\S]*?\n\})\n\nfunction portfolioCard/,
);
assert.ok(detailBlock, 'UP33 Manage-detail renderer must remain directly testable');
vm.runInContext(render, context);
Object.assign(context, context.LPLens);
vm.runInContext(`${detailBlock[1]}\nglobalThis.renderUp33Detail = up33ManageDetailCard;`, context);

const richDetail = context.renderUp33Detail({
  protocol: 'UP33', custody: 'wallet', status: 'in-range', fee: 10_165,
  price: 0.00048822, priceLower: 0.00031, priceUpper: 0.00072,
  amount0: 0.051, amount1: 103.25,
  collectable0: 0.0013, collectable1: 2.9,
  token0Meta: { symbol: 'WETH' }, token1Meta: { symbol: 'UP' },
  history: {
    unavailable: null, currentUnavailable: false,
    entry: { price: 0.00040211, exact: true, bound: null, spread: 0 },
    deposited0: 0.06, deposited1: 92, received0: 0.008, received1: 4,
    feeCreditsOnAdd: false,
    vsHodl: { pct: -4.36, feesPct: 12.5, ilPct: 16.86 },
  },
  usd: {
    pnl: 25.48, pnlPct: 17.02, vsHodl: -4.12,
    grossAdded: 149.7, grossAddedExact: true,
    collectedProceeds: 10.2, collectedProceedsExact: true,
    netCashIn: 139.5, totalNow: 175.18, value: 170.74, collectable: 4.44,
    currentValueIncomplete: false,
    capitalEvents: [{
      kind: 'opened', block: 17_854_321, time: 1_785_686_400,
      amount0: 0.06, amount1: 92, value: 149.7, exact: true,
    }],
    tokenPriceChange: {
      label: 'opened', token0: { from: 2480, to: 2525, pct: 1.81 },
      token1: { from: 0.997, to: 1.233, pct: 23.67 },
    },
  },
  rewards: [{ symbol: 'UP', amount: 1.25 }],
}, '113960', { readAt: 1_785_686_400_000, refreshing: false, error: '' });
for (const expected of [
  'LPLens',
  'On-chain read 2026-08-02 16:00:00 UTC',
  'Reopen Manage after a transaction to refresh again.',
  'LP return', '+$25.48', '+17.02% on gross added',
  'vs holding', '−$4.12', '−4.36%',
  'gross added', '$149.70', 'current value', '$175.18',
  'active liquidity', '$170.74', 'collectable', '$4.44',
  'cash returned', '$10.20', 'net cash in', '$139.50',
  'entry', '0.00040211', 'current', '0.00048822', 'range',
  'gross deposited', 'active tokens', 'collected', 'range shifted',
  'capital additions', 'token price context', 'since opened',
  'fees earned', '+12.500%', 'impermanent loss', '−16.860%',
  'pending UP', '1.25 UP', 'excluded from LP return',
]) {
  assert.match(richDetail, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    `expanded detail must render ${expected}`);
}

const ilGainDetail = context.renderUp33Detail({
  protocol: 'UP33', custody: 'wallet', status: 'in-range', fee: 3000,
  price: 1, priceLower: 0.5, priceUpper: 2,
  amount0: 1, amount1: 1, collectable0: 0, collectable1: 0,
  token0Meta: { symbol: 'UP' }, token1Meta: { symbol: 'WETH' },
  history: { vsHodl: { ilPct: -2.5 } },
  usd: {}, rewards: [],
}, '78');
assert.match(ilGainDetail, /impermanent loss[\s\S]*?<b class="pos">\+2\.500%<\/b>/,
  'a negative IL cost must render as a positive contribution, not a forced loss');

const unavailableDetail = context.renderUp33Detail({
  protocol: 'UP33', custody: 'gauge', status: 'above', fee: 3000,
  price: 2, priceLower: 1, priceUpper: 1.5,
  amount0: null, amount1: null, collectable0: null, collectable1: null,
  token0Meta: { symbol: '<UP&"' }, token1Meta: { symbol: 'WETH' },
  history: {
    unavailable: 'Staked position lifetime return is unavailable.',
    currentUnavailable: true, entry: null, vsHodl: null,
  },
  usd: {
    pnl: null, pnlPct: null, vsHodl: null, grossAdded: null,
    totalNow: null, value: 12.5, collectable: null,
    currentValueIncomplete: true,
  },
  rewards: [], rewardsUnavailable: 'Pending UP rewards could not be read.',
}, '77', {
  readAt: 1_785_686_400_000,
  refreshing: false,
  error: 'Automatic on-chain refresh failed. Reopen Manage to try again.',
});
assert.match(unavailableDetail, /LP return[\s\S]*?unavailable[\s\S]*?Staked position lifetime return is unavailable\./,
  'an unavailable return must name its safe reason in the expanded view');
assert.match(unavailableDetail, /UP33 does not expose the user trading-fee balance while this position is staked\./,
  'staked current-fee unavailability must remain explicit');
assert.match(unavailableDetail, /Pending UP rewards could not be read\./,
  'reward-read failure must remain explicit');
assert.match(unavailableDetail, /Automatic on-chain refresh failed\. Reopen Manage to try again\./,
  'a refresh failure must use fixed page-facing copy');
assert.match(unavailableDetail, /Complete current position value is unavailable\./,
  'an incomplete current total must remain explicit');
assert.match(unavailableDetail, /&lt;UP&amp;&quot;/,
  'even allowlisted token labels must be escaped before rendering');
assert.doesNotMatch(unavailableDetail, /<UP|<script|onerror=/,
  'page-facing labels must not become markup');

console.log('UP33 row overlay: strict identity, local matching, safe placement and fallback pass');
