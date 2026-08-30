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

assert.equal(manifest.version, '0.31.0');
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
assert.match(panel, /id="refreshScope"/);
assert.match(panel, /<option value="wallet">Selected wallet<\/option>/);
assert.match(panel, /<option value="all">All saved wallets<\/option>/);
assert.match(panel, /id="go"[^>]*>Refresh current<\/button>/);
assert.match(panel, /id="scanAll"[^>]*>Full rescan<\/button>/);
assert.match(panel, /Current re-checks known open positions\. Full finds new, transferred, or reopened positions\./);
assert.match(popup, /id="scanNetworks"/);
assert.match(panel, /id="scanHint"[^>]*role="status"[^>]*aria-live="polite"/);
assert.match(panel, /id="status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
assert.match(popup, /id="status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
assert.match(panel, /id="snapshotStatus"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
assert.match(panel, /<summary>Saved wallets<\/summary>/);
assert.match(panel, /<summary><span>Chains<\/span><span id="scanNetworkSummary">All<\/span><\/summary>/);
assert.doesNotMatch(panel, /savedCount|Does not affect page overlays/);
assert.doesNotMatch(popup, /savedCount|Does not affect page overlays/);
assert.match(panel, /id="copyDiagnostics"/);
assert.match(panel, /Report a problem/);
assert.ok(panel.indexOf('id="copyDiagnostics"') > panel.indexOf('id="scanDetails"')
  && panel.indexOf('id="copyDiagnostics"')
    < panel.indexOf('</details>', panel.indexOf('id="scanDetails"')),
  'support actions must stay inside the collapsed panel details');
assert.match(controller, /chrome\.sidePanel\.open\(\{ windowId: currentWindowId \}\)/);
assert.doesNotMatch(controller, /function legacyScanPresentation/);
assert.match(controller, /Full rescan completed \$\{snapshotAge\(snapshot\.at\)\}/);
assert.match(controller, /Current positions refreshed \$\{snapshotAge\(snapshot\.at\)\}/);
assert.match(controller, /details:\s*issueLines\.filter\(Boolean\)\.join\('\\n'\)/);
assert.doesNotMatch(controller, /network scans|Saved view ·|Current view ·|\$\{inflight\} reading/);
assert.doesNotMatch(controller, /closed v3 hidden|closed v4 hidden|Skipped locally/);
assert.doesNotMatch(controller, /<div class="meta">#\$\{p\.tokenId\}/);
assert.match(controller, /showWalletAttribution: !selectOverlayWallet/,
  'Refresh all must force wallet attribution even when it currently contains one saved wallet');
assert.match(controller, /typeof showWalletAttribution === 'boolean'/,
  'portfolio rendering must honor the explicit refresh mode');
assert.match(controller, /sweepStatus\(states, jobs, latestPortfolioShowsWallet\)/,
  'one-wallet Refresh all issue details must retain wallet attribution too');
assert.match(controller, /jobIssueOutcome\(job, s, showWallet\)/,
  'issue labels must use the explicit refresh attribution mode');
assert.match(controller, /latestPortfolioShowsWallet,\s*\n\s*\);/,
  'single-wallet views must not repeat the wallet on every position card');
assert.match(controller, /cleanRestoredDashboard\(snapshot\.showWalletLabels\)/,
  'old saved dashboards must receive the compact presentation immediately');
assert.match(controller, /if \(!hiddenCount && showHidden\) showHidden\.checked = false/,
  'restoring the last hidden card must reset the now-hidden Show hidden toggle');
assert.match(controller, /const hiddenCount = hiddenCards\.length/,
  'an empty current view must not count unrelated hidden positions from other wallets');
assert.match(controller, /display\.state === 'partial'[\s\S]*'Partial total'/);
assert.match(controller, /display\.state === 'unavailable' \? 'Not enough data'/);
assert.match(controller, /async function setActiveAddress/);
assert.match(controller, /if \(selectOverlayWallet\) await setActiveAddress\(owners\[0\]\.address\)/,
  'only an explicit one-wallet load may select the overlay wallet');
assert.match(controller, /\{ selectOverlayWallet: true, mode: 'full' \}/,
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
assert.match(controller, /Chains changed\. Refresh to update\./,
  'a saved view must disclose when the local network scope changed');
assert.match(controller, /Scope changed\. Refresh to update\./,
  'a saved view must disclose when the wallet scope changed');
assert.match(controller, /readCurrentPositionJobs\(owners, chainKeys\)/,
  'fast refresh readiness must come from the operational ID index');
assert.match(controller, /mode === 'full' && state\.ok === false[\s\S]*markCurrentPositionScopeIncomplete/,
  'a failed Full rescan must disable fast refresh for that wallet and chain');
assert.match(controller, /await loadKnownSweep\(owners, chainKeys, currentScopes, progressOptions\)/,
  'Refresh current must use the known-position loader');
assert.match(controller, /await loadSweep\(owners, chainKeys, progressOptions\)/,
  'Full rescan must retain authoritative ownership discovery');
assert.match(controller, /preserveExistingView: canPreserveCurrentView/,
  'a failed fast refresh must preserve the saved dashboard');
assert.match(controller,
  /const preserveView = mode === 'current' && preserveExistingView\s*&& \(!snap\.complete \|\| snap\.issueCount > 0\)/,
  'an incomplete fast refresh must not replace the last good cards');
assert.match(controller,
  /refreshScope: renderedRefreshScope \|\| \(previous && previous\.refreshScope\)/,
  'hide and restore must preserve the saved wallet scope');
assert.match(controller,
  /refreshMode: renderedRefreshMode \|\| \(previous && previous\.refreshMode\) \|\| 'full'/,
  'hide and restore must preserve the saved refresh mode');
assert.match(controller, /\$\('scanNetworks'\)\.open = false/,
  'starting a refresh must collapse the network selector');
const startScanSource = controller.slice(
  controller.indexOf('async function startScan('),
  controller.indexOf("form.addEventListener('submit'"),
);
assert.ok(startScanSource.indexOf('if (scanBusy || dashboardMutationBusy) return;') >= 0);
assert.ok(startScanSource.indexOf('if (scanBusy || dashboardMutationBusy) return;')
    < startScanSource.indexOf('await Promise.all([scanPreferencesReady, refreshScopeReady]);'),
  'the scan lock must be acquired before the first await');
assert.ok(startScanSource.indexOf('scanBusy = true;')
    < startScanSource.indexOf('await Promise.all([scanPreferencesReady, refreshScopeReady]);'),
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
assert.match(hideSource, /at: previous && previous\.at/,
  'local hide and restore actions must preserve the on-chain refresh timestamp');
assert.match(hideSource, /issues: previousIssues/,
  'restored-card mutations must preserve prior partial-scan truth');
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
  refreshScope: 'all',
  refreshMode: 'current',
}), true);
let snapshot = await readDashboardSnapshot();
assert.equal(snapshot.html, '<div class="position-card">one</div>');
assert.equal(snapshot.summaryOnly, false);
assert.equal(snapshot.positions, 1);
assert.equal(snapshot.details, 'Ethereum: 1\nBase: nothing');
assert.equal(snapshot.issues, 0);
assert.equal(snapshot.showWalletLabels, null,
  'legacy snapshots must preserve their already-rendered wallet labels');
assert.deepEqual(snapshot.chains, ['ethereum', 'robinhood']);
assert.equal(snapshot.refreshScope, 'all');
assert.equal(snapshot.refreshMode, 'current');

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
assert.equal(snapshot.showWalletLabels, null,
  'legacy snapshots must retain their existing card attribution regardless of wallet count');
assert.deepEqual(snapshot.chains, ['base']);
assert.equal(snapshot.includeClosed, true);

const preservedRefreshAt = 1_234_567;
assert.equal(await writeDashboardSnapshot({
  at: preservedRefreshAt,
  html: '<div class="position-card">locally hidden</div>',
  status: 'local view mutation',
  details: 'sanitized issue',
  issues: 1,
  positions: 0,
  wallets: 1,
  showWalletLabels: true,
  chains: ['base'],
  includeClosed: false,
}), true);
snapshot = await readDashboardSnapshot();
assert.equal(snapshot.at, preservedRefreshAt,
  'local card mutations must not pretend on-chain data was refreshed');
assert.equal(snapshot.issues, 1, 'local card mutations must preserve partial-scan truth');
assert.equal(snapshot.showWalletLabels, true,
  'one-wallet Refresh all attribution must survive a panel reload');

console.log('side panel: manifest, launcher, filters and bounded local snapshot pass');
