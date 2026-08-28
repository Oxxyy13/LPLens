#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MAX_SNAPSHOT_HTML, readDashboardSnapshot, snapshotAge, writeDashboardSnapshot,
} from '../extension/lib/dashboard-snapshot.js';

const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url)));
const panel = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const popup = readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf8');
const controller = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
const panelCss = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');

assert.equal(manifest.version, '0.30.0');
assert.ok(Number(manifest.minimum_chrome_version) >= 116);
assert.ok(manifest.permissions.includes('sidePanel'));
assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
assert.match(popup, /id="openPanel"/);
assert.match(panel, /data-surface="sidepanel"/);
assert.match(panel, /data-position-filter="in-range"/);
assert.match(panel, /data-position-filter="out-of-range"/);
assert.match(panel, /data-position-filter="issues"/);
assert.match(panel, /id="showHidden"/);
assert.match(panel, /id="activeWallet"/);
assert.match(popup, /id="activeWallet"/);
assert.match(panel, /id="scanDetails"/);
assert.match(panel, /id="scanDetailsBody"/);
assert.match(panel, /id="scanNetworks"/);
assert.match(panel, /id="scanNetworkAll"/);
assert.match(panel, /id="scanNetworkList"/);
assert.match(popup, /id="scanNetworks"/);
assert.match(panel, /id="scanHint"[^>]*role="status"[^>]*aria-live="polite"/);
assert.match(panel, /Does not affect page overlays/);
assert.match(panel, /id="copyDiagnostics"/);
assert.match(panel, /What did LPLens get wrong\?/);
assert.match(controller, /chrome\.sidePanel\.open\(\{ windowId: currentWindowId \}\)/);
assert.match(controller, /function legacyScanPresentation/);
assert.match(controller, /refresh to enable card controls/);
assert.match(controller, /details:\s*bits\.join\('\\n'\)/);
assert.match(controller, /async function setActiveAddress/);
assert.match(controller, /if \(selectOverlayWallet\) await setActiveAddress\(owners\[0\]\.address\)/,
  'only an explicit one-wallet load may select the overlay wallet');
assert.match(controller, /\{ selectOverlayWallet: true \}/,
  'the one-wallet form must explicitly request overlay selection');
assert.doesNotMatch(controller, /owners\.length === 1.*setActiveAddress/,
  'Scan all with one saved wallet must not change the overlay wallet');
assert.match(controller, /await setActiveAddress\(addr\)/,
  'clicking a saved wallet must select it immediately');
assert.doesNotMatch(controller, /address:\s*owners\.length === 1/,
  'multi-wallet refresh must not silently rewrite the active wallet');
assert.match(controller, /chrome\.storage\.onChanged\.addListener/,
  'open popup and side-panel surfaces must follow active-wallet changes');
assert.match(controller, /runSweep\(owners, chainKeys,/,
  'a portfolio sweep must use the captured local network selection');
assert.doesNotMatch(controller, /runSweep\(owners, Object\.keys\(CHAINS\)/,
  'a portfolio sweep must not silently restore all networks');
assert.match(controller, /Network selection changed\. Refresh to apply\./,
  'a saved view must disclose when the local network scope changed');
assert.match(controller, /\$\('scanNetworks'\)\.open = false/,
  'starting a refresh must collapse the network selector');
const startScanSource = controller.slice(
  controller.indexOf('async function startScan('),
  controller.indexOf("form.addEventListener('submit'"),
);
assert.ok(startScanSource.indexOf('if (scanBusy || dashboardMutationBusy) return;') >= 0);
assert.ok(startScanSource.indexOf('if (scanBusy || dashboardMutationBusy) return;')
    < startScanSource.indexOf('await scanPreferencesReady;'),
  'the scan lock must be acquired before the first await');
assert.ok(startScanSource.indexOf('scanBusy = true;')
    < startScanSource.indexOf('await scanPreferencesReady;'),
  'rapid clicks must not launch overlapping sweeps');
const gateSource = controller.slice(
  controller.indexOf('(async function gateOnOpen()'),
  controller.indexOf('async function startScan('),
);
assert.ok(gateSource.lastIndexOf('await restoreDashboard();')
    < gateSource.lastIndexOf('setFormInteractive(true);'),
  'the form must remain locked until the saved dashboard finishes restoring');
const hideSource = controller.slice(
  controller.indexOf("document.addEventListener('click'"),
  controller.indexOf("const flip = e.target.closest"),
);
assert.ok(hideSource.indexOf('if (scanBusy || dashboardMutationBusy) return;')
    < hideSource.indexOf('setPositionHidden(key, hide)'),
  'the hidden preference must not change while a sweep owns the dashboard snapshot');
assert.ok(hideSource.indexOf('dashboardMutationBusy = true;')
    < hideSource.indexOf('setPositionHidden(key, hide)'),
  'a hide operation must lock scans before its first storage await');
assert.match(hideSource, /finally\s*\{\s*dashboardMutationBusy = false;/,
  'a hide operation must always release its dashboard mutation lock');
assert.match(controller, /button\.disabled = scanBusy \|\| dashboardMutationBusy/,
  'hide controls must visibly remain locked for the full sweep');
const networkControlsSource = controller.slice(
  controller.indexOf('function paintNetworkControls()'),
  controller.indexOf('function paintNetworkSelectionNotice()'),
);
assert.doesNotMatch(networkControlsSource, /replaceChildren/,
  'repainting network choices must preserve the focused checkbox');
assert.match(controller, /<section class="card totals" aria-labelledby=/,
  'portfolio totals must expose a labelled semantic region');
assert.match(controller, /class="tot-line \$\{esc\(display\.state\)\}" role="group"/,
  'each aggregate metric must expose a named accessibility group');
assert.match(controller, /book = dedupeBook\(changes\.wallets\.newValue \|\| \[\]\)/,
  'open popup and side-panel address books must stay in sync');
assert.match(controller, /activeAddressRevision === startupAddressRevision/,
  'a slower startup must not overwrite a newer active-wallet event');
assert.match(controller, /It remains the overlay wallet/,
  'removing a saved row must not silently replace the active wallet');
assert.match(panelCss, /body\.sidepanel \.hide-position\s*\{\s*display:\s*block/);
assert.match(panelCss, /body\.sidepanel \.position-card\s*\{\s*container-type:\s*inline-size/);
assert.match(panelCss, /@container \(max-width: 380px\)/);

assert.equal(snapshotAge(1_000_000, 1_030_000), 'just now');
assert.equal(snapshotAge(1_000_000, 1_420_000), '7m ago');
assert.equal(snapshotAge(1_000_000, 8_200_000), '2h ago');

assert.equal(await writeDashboardSnapshot({
  html: '<div class="position-card">one</div>',
  summaryHtml: '<div class="totals">summary</div>',
  status: 'complete',
  details: 'Ethereum: 1\nBase: nothing',
  issues: 0,
  positions: 1,
  wallets: 1,
  chains: ['ethereum', 'robinhood'],
  includeClosed: false,
}), true);
let snapshot = await readDashboardSnapshot();
assert.equal(snapshot.html, '<div class="position-card">one</div>');
assert.equal(snapshot.summaryOnly, false);
assert.equal(snapshot.positions, 1);
assert.equal(snapshot.details, 'Ethereum: 1\nBase: nothing');
assert.equal(snapshot.issues, 0);
assert.deepEqual(snapshot.chains, ['ethereum', 'robinhood']);

assert.equal(await writeDashboardSnapshot({
  html: 'x'.repeat(MAX_SNAPSHOT_HTML + 1),
  summaryHtml: '<div class="totals">bounded summary</div>',
  status: 'large portfolio complete',
  positions: 1000,
  wallets: 20,
  chains: ['base'],
  includeClosed: true,
}), true);
snapshot = await readDashboardSnapshot();
assert.equal(snapshot.html, '<div class="totals">bounded summary</div>');
assert.equal(snapshot.summaryOnly, true);
assert.equal(snapshot.positions, 1000);
assert.equal(snapshot.wallets, 20);
assert.deepEqual(snapshot.chains, ['base']);
assert.equal(snapshot.includeClosed, true);

console.log('side panel: manifest, launcher, filters and bounded local snapshot pass');
