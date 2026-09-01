#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const options = readFileSync(new URL('../extension/options.html', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const worker = readFileSync(new URL('./licence-worker/worker.js', import.meta.url), 'utf8');
const storeListingUrl = new URL('../docs/store-listing.md', import.meta.url);
// docs/ is intentionally local-only. Verify the Store packet when present,
// while keeping the public CI guard runnable from a clean repository checkout.
const storeListing = existsSync(storeListingUrl)
  ? readFileSync(storeListingUrl, 'utf8') : null;
const localStoreSurface = storeListing === null ? [] : [['Store listing', storeListing]];
const security = readFileSync(new URL('../SECURITY.md', import.meta.url), 'utf8');
const overlay = readFileSync(new URL('../extension/overlay.js', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const optionsJs = readFileSync(new URL('../extension/options.js', import.meta.url), 'utf8');

assert.match(worker, /Effective 31 August 2026/,
  'privacy policy effective date must match the local refresh-comparison boundary change');
assert.match(worker, /saved addresses and labels/i,
  'privacy policy must describe the current all-chain wallet selection model');
assert.match(worker, /separately selected active overlay wallet address/i,
  'privacy policy must disclose the active overlay wallet retained after a saved row is removed');
assert.doesNotMatch(worker, /chain you select and the address you look up are stored locally/i,
  'privacy policy still describes the retired chain picker');

// The implementation discovers list rows through semantic position links and
// uses a short visible label. Every user-facing privacy surface must say so.
assert.match(overlay, /querySelectorAll\('a\[href\*="\/positions\/v"\]'\)/);
assert.match(overlay, /anchor\.innerText/);
for (const [name, body] of [
  ['options', options], ['README', readme], ['privacy policy', worker],
]) {
  assert.match(body, /position links/i, `${name} omits position-link access`);
  assert.match(body, /first line of visible row text/i, `${name} omits visible-label access`);
}
for (const [name, body] of [
  ['options', options], ['README', readme], ['privacy policy', worker],
  ...localStoreSurface, ['SECURITY', security],
]) {
  assert.match(body, /up33\.xyz\/liquidity/i, `${name} omits the optional UP33 route`);
  assert.match(body, /data-flow[^.]{0,120}cl-[^.]{0,80}NFT\s+ID/i,
    `${name} omits the UP33 data-flow NFT-ID attribute read`);
  assert.match(body, /matching visible[^.]{0,80}#ID/i,
    `${name} omits the matching visible UP33 #ID check`);
  assert.match(body, /row geometry/i,
    `${name} omits the UP33 row-geometry read`);
  assert.match(body, /page-derived IDs[^.]{0,180}active-wallet scan/i,
    `${name} omits the active-wallet-only UP33 ID match`);
  assert.match(body, /page-derived IDs[^.]{0,220}not sent to a network or stored/i,
    `${name} omits the UP33 page-derived ID storage and network exclusion`);
  assert.match(body, /does not read[^.]{0,220}connected-wallet state[^.]{0,220}(?:forms|transaction controls)[^.]{0,220}(?:signing prompts|wallet provider)[^.]{0,220}(?:other UP33 page content|other page content)/i,
    `${name} omits UP33 wallet, control, provider, or unrelated-content exclusions`);
  assert.match(body, /UP33 v2 LP\s+and\s+liquidity-locker\s+positions\s+are\s+not\s+read/i,
    `${name} omits the UP33 unsupported-position boundary`);
}
for (const [name, body] of [
  ['options', options], ['README', readme], ['privacy policy', worker],
  ...localStoreSurface,
]) {
  assert.match(body, /direct UP33 NFT/i, `${name} omits direct UP33 provenance reads`);
  assert.match(body, /exact-token Transfer histor(?:y|ies)/i,
    `${name} omits exact-token UP33 Transfer history`);
  assert.match(body, /not sent (?:to|through).*LPLens|not sent through or stored by this Worker/i,
    `${name} omits the UP33 Transfer-row service exclusion`);
}

for (const falseClaim of [
  /no wallet connection, private key, signing, page content/i,
  /does not read Uniswap(?:’|')s page HTML/i,
  /never reads,\s*moves, or rewrites anything Uniswap rendered/i,
]) {
  assert.doesNotMatch(options + readme + worker, falseClaim);
}
for (const [name, body] of [['options', options], ['README', readme], ['privacy policy', worker]]) {
  assert.match(body, /most recent(?:ly)? rendered portfolio view/i,
    `${name} omits the local side-panel snapshot`);
  assert.match(body, /chain and pool identifier/i,
    `${name} omits the Dexscreener route values`);
  assert.match(body, /without the (?:active )?wallet address/i,
    `${name} omits the Dexscreener pair-request wallet exclusion`);
  assert.match(body, /api\.dexscreener\.com|Dexscreener(?:'s)? API/i,
    `${name} omits the Dexscreener pair-request destination`);
  assert.match(body, /current-position ID index/i,
    `${name} omits the local fast-refresh position index`);
  assert.match(body, /v4\s+ownership block checkpoint/i,
    `${name} omits the local v4 ownership checkpoint`);
}
for (const [name, body] of [
  ['options', options], ['README', readme], ['privacy policy', worker],
  ...localStoreSurface,
]) {
  assert.match(body, /per-position refresh comparison samples/i,
    `${name} omits the local consecutive-refresh sample`);
  assert.match(body, /receipt-proven v3 replacement links/i,
    `${name} omits the local verified-replacement graph`);
  assert.match(body, /not (?:sent in|sent with) telemetry/i,
    `${name} does not exclude the new local stores from telemetry`);
}
assert.match(panel, /No wallet connection or page access/i);
assert.match(options, /id="licenseKey"\s+type="password"/,
  'the saved LPLens access key must be masked when Options opens');
assert.match(options, /id="showLicense"/,
  'Options has no deliberate access-key reveal control');
assert.match(optionsJs, /showLicense\.checked \? 'text' : 'password'/,
  'the access-key reveal control does not restore masking');
console.log('privacy disclosure: optional overlay implementation and copy agree');
