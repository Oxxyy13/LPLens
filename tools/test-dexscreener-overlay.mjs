#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const worker = readFileSync(new URL('../extension/sw.js', import.meta.url), 'utf8');
const overlay = readFileSync(new URL('../extension/overlay.js', import.meta.url), 'utf8');
const options = readFileSync(new URL('../extension/options.html', import.meta.url), 'utf8');
const optionsScript = readFileSync(new URL('../extension/options.js', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const security = readFileSync(new URL('../SECURITY.md', import.meta.url), 'utf8');
const privacy = readFileSync(new URL('./licence-worker/worker.js', import.meta.url), 'utf8');

assert.ok(manifest.optional_host_permissions.includes('https://dexscreener.com/*'));
assert.ok(!(manifest.host_permissions || []).includes('https://dexscreener.com/*'),
  'Dexscreener page access must remain optional');
assert.match(worker, /msg\.type !== 'LPLENS_DEXSCREENER_POOL'/);
assert.match(worker, /position\.version === 'v4' \? position\.poolId : position\.pool/);
assert.match(worker, /DEXSCREENER_CACHE_MS = 60_000/);
assert.match(worker, /cachedDexscreenerPair\(chainKey, poolRef\)/);
assert.match(worker, /api\.dexscreener\.com\/latest\/dex\/pairs/);
assert.match(worker, /AbortSignal\.timeout\(5_000\)/);
assert.match(worker, /usdRef\.nativeEquivalent/);
assert.match(worker, /dexscreenerScanCache\.clear\(\)/);
assert.match(worker, /id: DEXSCREENER_OVERLAY_ID/);
assert.match(overlay, /const ON_DEXSCREENER = location\.hostname === 'dexscreener\.com'/);
assert.match(overlay, /\^0x\(\?:\[0-9a-f\]\{40\}\|\[0-9a-f\]\{64\}\)\$/);
assert.match(overlay, /type: 'LPLENS_DEXSCREENER_POOL'/);
assert.match(overlay, /dexscreenerPending/);
assert.match(overlay, /generation !== dexscreenerGeneration/);
assert.match(overlay, /dexscreenerRangeRuler\(position, pair, wrappedNative, pairError\)/);
assert.match(overlay, /positions\.slice\(0, 8\)/);
assert.match(overlay, /Local chart alignment shares up to three anonymous range bounds with this page/);
assert.match(overlay, /local-experiment-banner/);
assert.match(worker, /LPLENS_DEXSCREENER_CHART_GEOMETRY/);
assert.match(worker, /world:\s*'MAIN'/);
assert.match(worker, /async function dexscreenerPageAccess\(sender\)/);
assert.match(worker, /chrome\.permissions\.contains\(\{ origins: \[DEXSCREENER_OVERLAY_ORIGIN\] \}\)/);
assert.match(worker, /permissionRevoked: true/);
assert.match(worker, /LPLENS_OVERLAY_ACCESS_REVOKED/);
assert.doesNotMatch(overlay, /window\.ethereum\s*[.(=]/);
assert.match(overlay, /function shutdownRevoked\(\)/);
assert.match(overlay, /LPLENS_OVERLAY_ACCESS_REVOKED/);
assert.match(overlay, /async function sync\(\) \{\s*if \(torndown\) return;/);
assert.match(overlay, /async function syncDexscreener\(\) \{\s*if \(torndown\) return;/);
assert.match(overlay, /async function syncProjectXPortfolio\(\) \{\s*if \(torndown\) return;/);
assert.match(options, /id="dexscreenerOverlayPerm"/);
assert.match(options, /service worker also re-checks Dexscreener permission/i);
assert.match(optionsScript, /LPLENS_REVOKE_OVERLAY_ACCESS/);
assert.match(optionsScript, /The local chart experiment's one-shot MAIN-world function/);
assert.doesNotMatch(optionsScript, /reads no\s+Dexscreener page content/);

for (const [name, body] of [['Options', options], ['README', readme], ['privacy policy', privacy]]) {
  assert.match(body, /dexscreener\.com/i, `${name} omits the optional Dexscreener scope`);
  assert.match(body, /chain and pool identifier/i, `${name} omits the URL-only routing boundary`);
  assert.match(body, /active overlay wallet|active wallet/i,
    `${name} omits the explicit active-wallet behavior`);
  assert.match(body, /MAIN.world/i,
    `${name} omits the local chart experiment's page-world measurement`);
  assert.match(body, /anonymous LP (?:low, current, and high )?range|anonymous LP range numbers/i,
    `${name} omits the anonymous LP range disclosure`);
  assert.match(body, /no wallet address|without the (?:active )?wallet address/i,
    `${name} omits the wallet-address exclusion`);
}
for (const [name, body] of [
  ['Options', options], ['Options summary', optionsScript], ['README', readme],
  ['SECURITY', security], ['privacy policy', privacy],
]) {
  assert.match(body, /latest public chart close/i,
    `${name} omits the local experiment's displayed-close disclosure`);
}
console.log('Dexscreener overlay: optional permission, active wallet and local chart disclosure pass');
