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
const v4 = readFileSync(new URL('../extension/lib/v4.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url)));

assert.match(worker, /Effective 4 September 2026/,
  'privacy policy effective date must match the external Revert-link disclosure change');
assert.match(worker, /saved addresses and labels/i,
  'privacy policy must describe the current all-chain wallet selection model');
assert.match(worker, /separately selected active overlay wallet address/i,
  'privacy policy must disclose the active overlay wallet retained after a saved row is removed');
assert.doesNotMatch(worker, /chain you select and the address you look up are stored locally/i,
  'privacy policy still describes the retired chain picker');

for (const [name, body] of [
  ['options', options], ['README', readme], ['privacy policy', worker],
  ...localStoreSurface, ['SECURITY', security],
]) {
  assert.match(body, /(?:user-clicked|unless you click|until the user (?:opens|clicks))[^.]{0,100}Revert|Revert[^.]{0,160}(?:user-clicked|unless you click|until the user (?:opens|clicks))/i,
    `${name} omits the explicit Revert navigation choice`);
  assert.match(body, /public network and (?:position )?NFT ID/i,
    `${name} omits the Revert URL fields`);
  assert.match(body, /(?:does\s+not\s+contact|no\s+request\s+goes\s+to)\s+Revert[^.]{0,120}(?:click|opens)/i,
    `${name} omits Revert's click-only network boundary`);
  assert.match(body, /(?:no\s+Revert\s+(?:site|host)\s+permission|adds\s+no\s+Revert\s+site\s+permission|requests\s+no\s+Revert\s+site\s+permission)/i,
    `${name} omits the absence of Revert page permission`);
  assert.match(body, /wallet\s+connection[^.]{0,160}(?:approval|signature)[^.]{0,160}transaction[^.]{0,160}(?:Revert|outside\s+LPLens|not\s+in\s+LPLens)/i,
    `${name} omits the external wallet-action boundary`);
}
assert.equal(
  [...(manifest.host_permissions || []), ...(manifest.optional_host_permissions || [])]
    .some((host) => /revert\.finance/i.test(host)),
  false,
  'manifest must not grant Revert page access for a user-clicked external link',
);

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
  assert.match(body, /Manage drawer/i,
    `${name} omits the UP33 Manage drawer`);
  assert.match(body, /(?:drawer|dialog)[^.]{0,180}(?:contributes|reads)[^.]{0,180}(?:visible\s+boundary|boundary geometry)/i,
    `${name} omits the UP33 Manage-drawer boundary read`);
  assert.match(body, /(?:does not read|are not read|never)\s+dialog contents|dialog contents\s+(?:are not read|is not read)/i,
    `${name} omits the UP33 dialog-content exclusion`);
  assert.match(body, /page-derived IDs[^.]{0,180}active-wallet scan/i,
    `${name} omits the active-wallet-only UP33 ID match`);
  assert.match(body, /(?:NFT|row) ID[^.]{0,240}(?:memory|in memory)[^.]{0,120}(?:five\s+seconds|5\s+seconds)[^.]{0,220}(?:associate|associating)/i,
    `${name} omits the bounded UP33 drawer-association state`);
  assert.match(body, /Once matched[^.]{0,240}(?:NFT|position|selected)[^.]{0,180}(?:memory|in memory)[^.]{0,180}(?:drawer close|drawer closes)[^.]{0,260}(?:route|context|active wallet)/i,
    `${name} omits the matched UP33 selection lifetime`);
  assert.match(body, /(?:(?:state|ID and click state)[^.]{0,180}not persisted|Neither state is persisted)[^.]{0,120}(?:transmitted|sent to any network)/i,
    `${name} omits the UP33 selected-ID persistence and transmission exclusions`);
  assert.match(body, /(?:drawer close|drawer closes)[^.]{0,260}(?:route|active wallet)[^.]{0,260}(?:revoc|revok|site access)/i,
    `${name} omits the UP33 selection-clearing conditions`);
  assert.match(body, /Opening the validated drawer[^.]{0,240}(?:fresh|refresh)[^.]{0,200}(?:UP33|active overlay wallet)[^.]{0,180}custody proofs[^.]{0,80}not reused/i,
    `${name} omits the automatic UP33 Manage-open refresh`);
  assert.match(body, /allowlisted|explicit allowlist/i,
    `${name} omits the expanded UP33 display-field allowlist`);
  assert.match(body, /does not read[^.]{0,220}connected-wallet state[^.]{0,220}(?:forms|transaction controls)[^.]{0,220}(?:signing prompts|wallet provider)[^.]{0,220}(?:other UP33 page content|other page content)/i,
    `${name} omits UP33 wallet, control, provider, or unrelated-content exclusions`);
  assert.match(body, /UP33 v2 LP\s+and\s+liquidity-locker\s+positions\s+are\s+not\s+read/i,
    `${name} omits the UP33 unsupported-position boundary`);
}

assert.match(optionsJs, /public NFT ID[^.]{0,180}(?:memory|in memory)[^.]{0,120}five seconds[^.]{0,220}associate/i,
  'granted-permission report omits bounded UP33 drawer association');
assert.match(optionsJs, /Once matched[^.]{0,240}selected public NFT ID[^.]{0,180}memory[^.]{0,180}drawer close/i,
  'granted-permission report omits matched UP33 selection lifetime');
assert.match(optionsJs, /(?:not\s+persisted|Neither state is persisted),\s*transmitted,\s*or\s*included\s+in\s+telemetry/i,
  'granted-permission report omits UP33 selection exclusions');

const clickSelection = overlay.match(/addEventListener\('click',[\s\S]*?\}, \{ passive: true, capture: true \}\);/);
assert.ok(clickSelection, 'UP33 trusted-click selection handler is missing');
assert.match(clickSelection[0], /event\.isTrusted\s*!==\s*true/,
  'UP33 selection must reject synthetic clicks');
assert.match(clickSelection[0], /up33PositionMap\.has\(positionId\)/,
  'UP33 selection must intersect the clicked ID with the active-wallet result');
assert.doesNotMatch(clickSelection[0], /chrome\.storage|sendMessage|fetch\s*\(/,
  'UP33 selection state must not be stored, transmitted, or sent to telemetry');
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
assert.match(v4, /receiptUrl[^]*chainId:\s*String\(chainId\)[^]*transactionHash/i,
  'v4 receipt fallback must send only the documented public receipt identity');
for (const [name, body] of [
  ['options', options], ['README', readme], ['privacy policy', worker],
  ...localStoreSurface, ['SECURITY', security],
]) {
  assert.match(body, /(?:public\s+transaction\s+and\s+log\s+records[^.]{0,160}public\s+Blockscout v2|public\s+Blockscout v2[^.]{0,160}(?:transaction\s+and\s+log|transaction\/log))[^.]{0,160}(?:REST|API|endpoints)/i,
    `${name} omits the public Blockscout v2 transaction/log receipt fallback`);
  assert.match(body, /public\s+Blockscout v2[\s\S]{0,900}(?:authenticated LPLens Worker|authenticated Worker|this authenticated Worker|receipt route)/i,
    `${name} does not put public Blockscout v2 before the hosted receipt fallback`);
  assert.match(body, /chain id\s+4663/i,
    `${name} omits the receipt relay chain id`);
  assert.match(body, /public\s+transaction\s+hash/i,
    `${name} omits the receipt relay transaction hash`);
  assert.match(body, /access\s+key[\s\S]{0,220}random\s+installation\s+(?:ID|identifier)|random\s+installation\s+(?:ID|identifier)[\s\S]{0,220}access\s+key/i,
    `${name} omits the receipt relay authentication fields`);
  assert.match(body, /exact\s+successful\s+receipt[\s\S]{0,100}Blockscout\s+Pro|Blockscout\s+Pro[\s\S]{0,100}exact\s+successful\s+receipt/i,
    `${name} omits the exact successful Blockscout Pro receipt`);
  assert.match(body, /ModifyLiquidity[\s\S]{0,180}(?:attributed to|PositionManager-attributed)[\s\S]{0,100}(?:configured )?PositionManager|PositionManager-attributed[\s\S]{0,100}ModifyLiquidity/i,
    `${name} omits the strict PositionManager-attributed ModifyLiquidity check`);
  assert.match(body, /(?:does not store|stores neither)[^.]{0,120}(?:transaction\s+hash|hash)[^.]{0,100}(?:receipt|receipt\s+body)/i,
    `${name} omits receipt-relay non-retention`);
  assert.doesNotMatch(body, /chain id 4663[^.]{0,120}(?:wallet address|private key)/i,
    `${name} overstates the receipt relay payload`);
  assert.match(body, /(?:chain id\s+4663[^.]{0,220}(?:public\s+)?transaction\s+hash|(?:public\s+)?transaction\s+hash[^.]{0,220}chain id\s+4663)/i,
    `${name} omits the receipt relay request fields`);
}
assert.match(options, /id="licenseKey"\s+type="password"/,
  'the saved LPLens access key must be masked when Options opens');
assert.match(options, /id="showLicense"/,
  'Options has no deliberate access-key reveal control');
assert.match(optionsJs, /showLicense\.checked \? 'text' : 'password'/,
  'the access-key reveal control does not restore masking');
console.log('privacy disclosure: optional overlay implementation and copy agree');
