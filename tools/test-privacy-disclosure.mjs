#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const options = readFileSync(new URL('../extension/options.html', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const worker = readFileSync(new URL('./licence-worker/worker.js', import.meta.url), 'utf8');
const storeListing = readFileSync(new URL('../docs/store-listing.md', import.meta.url), 'utf8');
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
  ['Store listing', storeListing],
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
