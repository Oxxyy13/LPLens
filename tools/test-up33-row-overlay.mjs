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
  globalThis.helpers = { parseUp33FlowKey, up33RightGutterPlacement };
`, context);
const { parseUp33FlowKey, up33RightGutterPlacement } = context.helpers;

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

const rowBlock = overlay.match(
  /function syncUp33Rows\(\) \{([\s\S]*?)\n\}\n\nasync function syncUp33Liquidity/,
);
assert.ok(rowBlock, 'UP33 row rematching function is missing');
assert.match(rowBlock[1], /button\[data-flow\^="cl-"\]/);
assert.match(rowBlock[1], /up33RowHasExactPositionId/,
  'the semantic flow key and visible NFT id must agree');
assert.match(rowBlock[1], /if \(visible\) selectorMismatch = true/,
  'a visible malformed or drifted row must restore the floating fallback');
assert.match(rowBlock[1], /if \(!measurable\) continue/,
  'fully hidden retained rows must not disable visible row cards');
assert.match(rowBlock[1], /up33PositionMap\.get\(positionId\)/,
  'page ids may only intersect the active-wallet result map');
assert.match(rowBlock[1], /up33RightGutterPlacement/);
assert.match(rowBlock[1], /setUp33FloatingVisible\(true\)/,
  'selector, wallet, or layout mismatch must retain the floating fallback');
assert.match(rowBlock[1], /className = 'gc dense up33-row'/);
assert.doesNotMatch(rowBlock[1], /sendMessage|fetch\(|innerText|window\.ethereum|chrome\.storage/,
  'DOM rematching must not refetch, read broad text, or access wallet state');

assert.match(overlay, /if \(ON_UP33 && UP33_LIST_ROUTE\.test\(location\.pathname\)\) \{\s*syncUp33Rows\(\)/,
  'UP33 React mutations must rematch locally without navigation');
assert.match(overlay, /function watchUp33RowGeometry\(rows\)/,
  'UP33 row and container size changes must reposition cards');
assert.match(overlay, /attributes: true[\s\S]*attributeFilter: \['class', 'style', 'hidden', 'aria-hidden'\]/,
  'UP33 class and style layout changes must trigger local realignment');
assert.match(overlay, /addEventListener\('scroll', \(\) => \{[\s\S]*?UP33_LIST_ROUTE[\s\S]*?scheduleList\(\)/,
  'scrolling a malformed row into view must recheck row safety locally');
assert.match(overlay, /addEventListener\('resize', \(\) => \{[\s\S]*?UP33_LIST_ROUTE[\s\S]*?scheduleList\(\)/,
  'responsive duplicate rows must be reselected after resize');
assert.match(overlay, /if \(ON_UP33\) \{[\s\S]*?up33Generation\+\+[\s\S]*?clearUp33Rows\(true, true\)/,
  'active-wallet changes must remove old-wallet row cards immediately');
assert.match(overlay, /function shutdownRevoked\(\) \{[\s\S]*?if \(ON_UP33\) clearUp33Rows\(true, true\)/,
  'permission revocation must disconnect UP33 geometry observers');
assert.match(worker, /positionId,/,
  'the sanitized response must carry the canonical public row identity');
assert.match(worker, /canonicalUint256OrNull/);
assert.match(render, /\.gc \{[\s\S]*?pointer-events: none/,
  'row cards must remain pointer-inert around Manage controls');
assert.match(render, /\.gc\.up33-row::before/,
  'UP33 row cards should be visibly identified as LPLens');

console.log('UP33 row overlay: strict identity, local matching, safe placement and fallback pass');
