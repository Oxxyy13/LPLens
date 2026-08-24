#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const options = readFileSync(new URL('../extension/options.html', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const worker = readFileSync(new URL('./licence-worker/worker.js', import.meta.url), 'utf8');
const overlay = readFileSync(new URL('../extension/overlay.js', import.meta.url), 'utf8');

// The implementation discovers list rows through semantic position links and
// uses a short visible label. Every user-facing privacy surface must say so.
assert.match(overlay, /querySelectorAll\('a\[href\*="\/positions\/v"\]'\)/);
assert.match(overlay, /anchor\.innerText/);
for (const [name, body] of [['options', options], ['README', readme], ['privacy policy', worker]]) {
  assert.match(body, /position links/i, `${name} omits position-link access`);
  assert.match(body, /first line of visible row text/i, `${name} omits visible-label access`);
}

for (const falseClaim of [
  /no wallet connection, private key, signing, page content/i,
  /does not read Uniswap(?:’|')s page HTML/i,
  /never reads,\s*moves, or rewrites anything Uniswap rendered/i,
]) {
  assert.doesNotMatch(options + readme + worker, falseClaim);
}
console.log('privacy disclosure: optional overlay implementation and copy agree');
