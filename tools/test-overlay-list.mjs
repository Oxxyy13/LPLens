#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const overlay = readFileSync(new URL('../extension/overlay.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../extension/sw.js', import.meta.url), 'utf8');

const matchBlock = worker.match(/const OVERLAY_MATCHES = Object\.freeze\((\[[\s\S]*?\])\);/);
assert.ok(matchBlock, 'service worker has no explicit overlay match list');
const matches = [...matchBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
assert.deepEqual(matches, [
  'https://app.uniswap.org/positions',
  'https://app.uniswap.org/positions/*',
], 'overlay must cover the bare list and only its detail descendants');

// Dynamic registrations survive extension updates. A changed match list must
// update the already-registered 0.27 content script rather than treating its
// mere presence as current.
assert.match(worker, /currentOverlayRegistration\(registered, matches\)/);
assert.match(worker, /chrome\.scripting\.updateContentScripts\(\[definition\]\)/);

// The list route must preserve the version parsed from every semantic link and
// send it to the same version-aware service-worker path used by detail pages.
assert.match(overlay, /version:\s*m\[1\]\.toLowerCase\(\)/);
assert.match(overlay, /version:\s*row\.version/);
assert.match(overlay, /res\.gated\s*&&\s*res\.entitlement/,
  'list cards must render access-gate replies instead of saying no response');
assert.doesNotMatch(overlay, /if\s*\(\s*row\.v4\s*\|\|/,
  'v4 list rows are still being skipped');

console.log('overlay list: bare route registration and v3/v4 dispatch pass');
