#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const popup = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../extension/popup.css', import.meta.url), 'utf8');
const overlay = readFileSync(new URL('../extension/overlay.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));

assert.equal(manifest.version, '0.28.1');
assert.match(html, /id="activeWallet"[^>]*role="status"[^>]*>ProjectX wallet: none selected</);
assert.match(css, /\.active-wallet\.pending/);
assert.match(css, /\.active-wallet\.empty/);
assert.match(css, /\.saved-row\.active \.saved-load/);

assert.match(popup, /removeWallet, dedupeBook,/);
assert.match(popup, /activeAddress = normalizeAddress\(latest\.address\)/,
  'startup must restore the explicit legacy-compatible address key');
assert.doesNotMatch(popup, /else if \(book\[0\]\)/,
  'startup must not make the first saved wallet look selected');
assert.match(popup, /ProjectX wallet: \$\{identity\}/);
assert.match(popup, /typed wallet not selected yet/);
assert.match(popup, /row\.classList\.toggle\('active', active\)/);
assert.match(popup, /load\.setAttribute\('aria-pressed', String\(active\)\)/);

const addressWrites = popup.match(/chrome\.storage\.local\.set\(\{ address \}\)/g) || [];
assert.equal(addressWrites.length, 1,
  'only the explicit selection helper may write the ProjectX address key');
assert.match(popup, /async function setActiveAddress[\s\S]*chrome\.storage\.local\.set\(\{ address \}\)/);
assert.match(popup, /if \(e\.target\.closest\('\.saved-load'\)\) \{\s*await setActiveAddress\(addr\)/,
  'clicking a saved wallet must select it immediately');
assert.match(popup, /await setActiveAddress\(\$\('address'\)\.value\)/,
  'saving a new wallet must select it');
assert.match(popup, /Removed from saved wallets\. It remains the ProjectX wallet\./,
  'removing a saved row must not silently change the active wallet');

assert.match(popup,
  /async function startScan\(owners, includeClosed, \{ selectOverlayWallet = false \} = \{\}\)/);
assert.match(popup, /if \(selectOverlayWallet\) await setActiveAddress\(owners\[0\]\.address\)/);
assert.match(popup, /\{ selectOverlayWallet: true \}/,
  'loading the typed wallet must explicitly select it');
assert.match(popup, /await startScan\(book, \$\('includeClosed'\)\.checked\)/,
  'Scan all must use the non-selecting default, including for a one-wallet book');
assert.doesNotMatch(popup, /owners\.length === 1[^\n]*address/,
  'scan cardinality must never choose the active wallet');

assert.match(popup, /chrome\.storage\.onChanged\.addListener/);
assert.match(popup, /if \(document\.activeElement !== \$\('address'\)\)/,
  'external selections must not overwrite a wallet while the user is typing');
assert.match(overlay, /changes\.address[\s\S]*lastKey = null;[\s\S]*sync\(\)/,
  'an already-open ProjectX overlay must refresh when the selection changes');
assert.doesNotMatch(popup, /chrome\.storage\.local\.clear\(/,
  'the hotfix must not clear access keys or any other local state');

// Exercise the real ProjectX refresh controller with a deliberately unresolved
// first request. This is the slow 120-NFT case: a wallet change must queue one
// replacement request, discard the old response, and render only the new one.
const projectxBlock = overlay.match(
  /let projectxBusy = false;[\s\S]*?\n}\n\nasync function syncList\(\)/,
);
assert.ok(projectxBlock, 'could not isolate the ProjectX refresh controller');
const controller = projectxBlock[0].replace(/\n\nasync function syncList\(\)$/, '');
const requests = [];
const renders = [];
const context = vm.createContext({
  chrome: {
    runtime: {
      sendMessage: () => new Promise((resolve) => requests.push(resolve)),
    },
  },
  contextAlive: () => true,
  shutdownOrphan: () => {},
  isOrphanError: () => false,
  teardownList: () => {},
  render: (markup) => renders.push(markup),
  head: (markup) => markup,
  esc: (value) => String(value),
  portfolioCard: () => '',
});
vm.runInContext(`
  let lastKey = null;
  ${controller}
  globalThis.startProjectX = syncProjectXPortfolio;
  globalThis.changeProjectXWallet = () => {
    lastKey = null;
    return syncProjectXPortfolio();
  };
`, context);

const firstRequest = context.startProjectX();
assert.equal(requests.length, 1, 'first ProjectX request did not start');
await context.changeProjectXWallet();
assert.equal(requests.length, 1, 'wallet change started a concurrent ProjectX request');
requests[0]({ ok: true, data: { address: '0x' + '1'.repeat(40), positions: [] } });
await firstRequest;
for (let i = 0; i < 5 && requests.length < 2; i++) {
  await new Promise((resolve) => setImmediate(resolve));
}
assert.equal(requests.length, 2, 'wallet change during a scan did not queue a replacement');
requests[1]({ ok: true, data: { address: '0x' + '2'.repeat(40), positions: [] } });
for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
const rendered = renders.join('\n');
assert.doesNotMatch(rendered, /0x1111…1111/, 'stale ProjectX wallet rendered after selection changed');
assert.match(rendered, /0x2222…2222/, 'replacement ProjectX wallet did not render');

console.log('Active ProjectX wallet: explicit selection and Scan all isolation pass');
