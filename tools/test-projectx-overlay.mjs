#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const worker = readFileSync(new URL('../extension/sw.js', import.meta.url), 'utf8');
const overlay = readFileSync(new URL('../extension/overlay.js', import.meta.url), 'utf8');
const options = readFileSync(new URL('../extension/options.html', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const privacy = readFileSync(new URL('./licence-worker/worker.js', import.meta.url), 'utf8');

assert.ok(manifest.optional_host_permissions.includes('https://www.prjx.com/*'),
  'ProjectX must remain optional site access');
assert.doesNotMatch(JSON.stringify(manifest.host_permissions || []), /prjx\.com/,
  'ProjectX was widened into install-time host permissions');

const block = worker.match(/const PROJECTX_OVERLAY_MATCHES = Object\.freeze\((\[[\s\S]*?\])\);/);
assert.ok(block, 'ProjectX overlay has no explicit match list');
const matches = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
assert.deepEqual(matches, [
  'https://www.prjx.com/portfolio',
  'https://www.prjx.com/portfolio/*',
]);
assert.match(worker, /msg\.type !== 'LPLENS_PROJECTX_PORTFOLIO'/);
assert.match(worker, /chrome\.storage\.local\.get\(\[\s*'address'/);
assert.match(worker, /loadPositions\('hyperevm', address/);

assert.match(overlay, /const PROJECTX_ROUTE = \/\^\\\/portfolio/);
assert.match(overlay, /type: 'LPLENS_PROJECTX_PORTFOLIO'/);
assert.match(overlay, /ProjectX wallet data is not read/);
assert.match(overlay, /const forceLeft = PROJECTX_ROUTE\.test\(location\.pathname\)/,
  'ProjectX panel must stay on the left, clear of the site Support control');
assert.match(overlay, /const useRight = !forceLeft && roomRight > roomLeft/,
  'ProjectX left docking must override adaptive right-gutter placement');
assert.doesNotMatch(overlay, /window\.ethereum\s*[.(=]/,
  'ProjectX overlay gained wallet-provider access');
assert.match(options, /id="projectxOverlayPerm"/);

for (const [name, body] of [['options', options], ['README', readme], ['privacy policy', privacy]]) {
  assert.match(body, /www\.prjx\.com\/portfolio/i, `${name} omits the ProjectX page scope`);
  assert.match(body, /active overlay wallet|active wallet/i,
    `${name} omits the explicit active-wallet behavior`);
  assert.match(body, /does not read ProjectX page content|ProjectX[^.]{0,100}reads no page content/i,
    `${name} omits the ProjectX page-content boundary`);
}

console.log('ProjectX overlay: optional permission, explicit active wallet and portfolio dispatch pass');
