#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const worker = readFileSync(new URL('../extension/sw.js', import.meta.url), 'utf8');
const overlay = readFileSync(new URL('../extension/overlay.js', import.meta.url), 'utf8');
const options = readFileSync(new URL('../extension/options.html', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const privacy = readFileSync(new URL('./licence-worker/worker.js', import.meta.url), 'utf8');

assert.ok(manifest.optional_host_permissions.includes('https://dexscreener.com/*'));
assert.ok(!(manifest.host_permissions || []).includes('https://dexscreener.com/*'),
  'Dexscreener page access must remain optional');
assert.match(worker, /msg\.type !== 'LPLENS_DEXSCREENER_POOL'/);
assert.match(worker, /position\.version === 'v4' \? position\.poolId : position\.pool/);
assert.match(worker, /DEXSCREENER_CACHE_MS = 60_000/);
assert.match(worker, /dexscreenerScanCache\.clear\(\)/);
assert.match(worker, /id: DEXSCREENER_OVERLAY_ID/);
assert.match(overlay, /const ON_DEXSCREENER = location\.hostname === 'dexscreener\.com'/);
assert.match(overlay, /\^0x\(\?:\[0-9a-f\]\{40\}\|\[0-9a-f\]\{64\}\)\$/);
assert.match(overlay, /type: 'LPLENS_DEXSCREENER_POOL'/);
assert.match(overlay, /dexscreenerPending/);
assert.match(overlay, /generation !== dexscreenerGeneration/);
assert.match(overlay, /Dexscreener page content and wallet data are not read/);
assert.doesNotMatch(overlay, /window\.ethereum\s*[.(=]/);
assert.match(options, /id="dexscreenerOverlayPerm"/);

for (const [name, body] of [['Options', options], ['README', readme], ['privacy policy', privacy]]) {
  assert.match(body, /dexscreener\.com/i, `${name} omits the optional Dexscreener scope`);
  assert.match(body, /chain and pool identifier/i, `${name} omits the URL-only routing boundary`);
  assert.match(body, /last address/i, `${name} omits the last-LPLens-address behavior`);
}
console.log('Dexscreener overlay: optional permission, URL-only route and local-address dispatch pass');
