import { CHAINS, PUBLIC_RPC } from './lib/chains.js';
import { GATING_ENABLED, TRIAL_LENGTH_DAYS, entitlement } from './lib/license.js';
import { RPC_METHODS } from './lib/rpc.js';
import { TELEMETRY_SETTING_KEY } from './lib/telemetry.js';

const escape = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const rpcsEl = document.getElementById('rpcs');
const keys = Object.keys(CHAINS);

// Placeholders are the public defaults, never CHAINS[k].rpc. In a dev
// build the TESTING ONLY fence rewrites those to keyed Alchemy URLs, and
// a placeholder sourced from the live value would print the key in the
// most-screenshotted page of the product. A user's own saved override is
// written to .value below — that is their input, not a secret we injected.
rpcsEl.innerHTML = keys.map((k) => `
  <div style="margin-bottom:6px">
    <div class="kv"><span>${escape(CHAINS[k].label)}</span></div>
    <input type="text" id="rpc-${k}" placeholder="${escape(PUBLIC_RPC[k] || '')}" autocomplete="off">
  </div>`).join('');

const licenseSection = document.getElementById('licenseSection');
if (GATING_ENABLED) {
  licenseSection.hidden = false;
  document.getElementById('licenseHeading').textContent = 'Access key';
  document.getElementById('licenseCopy').innerHTML =
    `This LPLens build is invite-only. Paste the access key you were sent.
     It is an opaque string &mdash; never a wallet, a signature, or a private key.
     A valid key is enough to load history; you do not need a Blockscout or Etherscan key.`;
} else {
  licenseSection.hidden = true;
}

chrome.storage.local.get(['rpcOverrides', 'etherscanKey', 'licenseKey', TELEMETRY_SETTING_KEY], (s) => {
  const o = s.rpcOverrides || {};
  for (const k of keys) {
    // Only the user's saved override goes in the field. Never the live
    // CHAINS[k].rpc, which may carry a dev-fence credential.
    if (o[k]) document.getElementById(`rpc-${k}`).value = o[k];
  }
  if (s.etherscanKey) document.getElementById('etherscanKey').value = s.etherscanKey;
  if (GATING_ENABLED && s.licenseKey) document.getElementById('licenseKey').value = s.licenseKey;
  document.getElementById('telemetryEnabled').checked = s[TELEMETRY_SETTING_KEY] !== false;
});

const showLicense = document.getElementById('showLicense');
if (showLicense) {
  showLicense.addEventListener('change', () => {
    document.getElementById('licenseKey').type = showLicense.checked ? 'text' : 'password';
  });
}

const showEtherscan = document.getElementById('showEtherscan');
if (showEtherscan) {
  showEtherscan.addEventListener('change', () => {
    document.getElementById('etherscanKey').type = showEtherscan.checked ? 'text' : 'password';
  });
}

const telemetryBox = document.getElementById('telemetryEnabled');
telemetryBox.addEventListener('change', () => {
  chrome.storage.local.set({ [TELEMETRY_SETTING_KEY]: telemetryBox.checked });
});

document.getElementById('save').addEventListener('click', () => {
  const rpcOverrides = {};
  for (const k of keys) {
    const v = document.getElementById(`rpc-${k}`).value.trim();
    if (v) rpcOverrides[k] = v;
  }
  const etherscanKey = document.getElementById('etherscanKey').value.trim();
  const payload = {
    rpcOverrides,
    etherscanKey,
    [TELEMETRY_SETTING_KEY]: document.getElementById('telemetryEnabled').checked,
  };
  // While gating is off, do not write licenseKey / licenseSeen — leftover
  // values from earlier testing stay in storage, ignored.
  if (GATING_ENABLED) {
    payload.licenseKey = document.getElementById('licenseKey').value.trim();
    payload.licenseSeen = null;
  }
  chrome.storage.local.set(payload, () => {
    document.getElementById('saved').textContent = 'Saved.';
    setTimeout(() => (document.getElementById('saved').textContent = ''), 1500);
  });
});


/* ---------------------------------------------------------------------------
 * Site-access controls and the permission report.
 *
 * The report is rendered FROM `chrome.runtime.getManifest()`, the live
 * permission state, and `RPC_METHODS` rather than written by hand. A
 * hand-written security claim drifts the moment someone adds a host or a
 * JSON-RPC method and forgets the copy; generating it means what is shown
 * is what is actually granted.
 * ------------------------------------------------------------------------- */

const OVERLAY_ORIGIN = 'https://app.uniswap.org/*';
const PROJECTX_OVERLAY_ORIGIN = 'https://www.prjx.com/*';
const DEXSCREENER_OVERLAY_ORIGIN = 'https://dexscreener.com/*';
const DEXSCREENER_CHART_CONSENT_KEY = 'dexscreenerChartConsentV1';
const permBox = document.getElementById('overlayPerm');
const projectxPermBox = document.getElementById('projectxOverlayPerm');
const dexscreenerPermBox = document.getElementById('dexscreenerOverlayPerm');
const dexscreenerChartConsentBox = document.getElementById('dexscreenerChartConsent');
const report = document.getElementById('permReport');

/** Oxford-comma join of RPC method names as <code> tags. Driven by RPC_METHODS. */
function rpcMethodList(methods) {
  const codes = methods.map((m) => `<code>${escape(m)}</code>`);
  if (codes.length <= 1) return codes[0] || '';
  if (codes.length === 2) return `${codes[0]} and ${codes[1]}`;
  return `${codes.slice(0, -1).join(', ')}, and ${codes[codes.length - 1]}`;
}

async function paintPermissions() {
  const mf = chrome.runtime.getManifest();
  const [granted, projectxGranted, dexscreenerGranted, chartConsentStore] = await Promise.all([
    chrome.permissions.contains({ origins: [OVERLAY_ORIGIN] }),
    chrome.permissions.contains({ origins: [PROJECTX_OVERLAY_ORIGIN] }),
    chrome.permissions.contains({ origins: [DEXSCREENER_OVERLAY_ORIGIN] }),
    chrome.storage.local.get(DEXSCREENER_CHART_CONSENT_KEY),
  ]);
  const chartConsented = chartConsentStore
    && chartConsentStore[DEXSCREENER_CHART_CONSENT_KEY] === true;
  permBox.checked = granted;
  projectxPermBox.checked = projectxGranted;
  dexscreenerPermBox.checked = dexscreenerGranted;
  dexscreenerChartConsentBox.checked = chartConsented;

  const pageRows = [];
  if (granted) pageRows.push(`<li class="yes"><b>app.uniswap.org position pages</b> — can read and add
    to the positions list and individual position pages only.</li>`);
  if (projectxGranted) pageRows.push(`<li class="yes"><b>www.prjx.com/portfolio</b> — can add the
    ProjectX panel. It uses the active overlay wallet selected in LPLens and does not read
    the connected wallet or ProjectX page content.</li>`);
  if (dexscreenerGranted) pageRows.push(`<li class="yes"><b>dexscreener.com pair pages</b> - can read
    the chain and pool identifier in the URL and append a matching-position panel.
    It sends those two route values, without the wallet address, to api.dexscreener.com to match
    token orientation. It uses the active overlay wallet selected in LPLens.</li>`);
  const pageAccess = pageRows.length ? pageRows.join('')
    : `<li class="no"><b>No web page at all.</b> All overlays are off, so no
         content script is registered anywhere.</li>`;
  const chartAccess = chartConsented
    ? `<li class="yes"><b>Separately approved.</b> While a matching overlay is open,
       a packaged short-lived MAIN-world function repeats so the range follows the chart.
       It receives up to three unlabelled ranges plus public pair-conversion values.
       The pool and bounds are public on-chain, so the page could correlate them to a
       position and owner. The latest public chart close stays inside the MAIN-world call;
       only validated chart mode, geometry and numeric coordinates return to the overlay.
       The call is not directly given a wallet address, position ID, PnL, access key,
       endpoint or provider key.
       ${dexscreenerGranted ? '' : 'It cannot run until Dexscreener site access is also enabled.'}</li>`
    : `<li class="no"><b>Off.</b> Site access alone uses LPLens's exact on-chain range ruler
       and does not start chart measurement.</li>`;

  const hosts = (mf.host_permissions || []).map((h) =>
    `<li class="net">${escape(h)}</li>`).join('');

  report.innerHTML = `
    <h3>Web pages it can read or modify</h3>
    <ul>${pageAccess}</ul>
    <h3>Dexscreener chart alignment</h3>
    <ul>${chartAccess}</ul>
    <h3>Servers it can send requests to</h3>
    <ul>${hosts}</ul>
    <h3>Browser permissions</h3>
    <ul>${(mf.permissions || []).map((p) => `<li>${escape(p)}</li>`).join('')}</ul>
    <h3>Safety boundaries</h3>
    <ul class="cannot">
      <li>No wallet access. It never calls <code>eth_sendTransaction</code>,
          <code>personal_sign</code> or <code>eth_requestAccounts</code>. Persistent
          content scripts run in an isolated world where <code>window.ethereum</code>
          is unreachable. The separately approved short-lived MAIN-world chart function
          is implemented not to read or call a wallet provider.</li>
      <li>The only JSON-RPC methods it issues are ${rpcMethodList(RPC_METHODS)}.
          All are reads; none can move a token or sign anything.</li>
      <li>No <code>tabs</code>, <code>activeTab</code>, <code>cookies</code>,
          <code>webRequest</code> or <code>&lt;all_urls&gt;</code>, so it cannot
          see browsing outside the sites you enable or reach an exchange or wallet site.</li>
      <li>An overlay adds only its own panel and, when separately approved, its own
          non-interactive chart graphic. It never rewrites the site's markup, so
          it cannot alter an address or amount shown to you.</li>
    </ul>`;
}

async function removeOverlayPermission(origin) {
  try {
    await chrome.runtime.sendMessage({ type: 'LPLENS_REVOKE_OVERLAY_ACCESS', origin });
  } catch { /* the worker-side permission check still fails closed */ }
  await chrome.permissions.remove({ origins: [origin] });
}

permBox.addEventListener('change', async () => {
  if (permBox.checked) {
    const ok = await chrome.permissions.request({ origins: [OVERLAY_ORIGIN] });
    if (!ok) permBox.checked = false;
  } else {
    await removeOverlayPermission(OVERLAY_ORIGIN);
  }
  paintPermissions();
});

projectxPermBox.addEventListener('change', async () => {
  if (projectxPermBox.checked) {
    const ok = await chrome.permissions.request({ origins: [PROJECTX_OVERLAY_ORIGIN] });
    if (!ok) projectxPermBox.checked = false;
  } else {
    await removeOverlayPermission(PROJECTX_OVERLAY_ORIGIN);
  }
  paintPermissions();
});

dexscreenerPermBox.addEventListener('change', async () => {
  if (dexscreenerPermBox.checked) {
    const ok = await chrome.permissions.request({ origins: [DEXSCREENER_OVERLAY_ORIGIN] });
    if (!ok) dexscreenerPermBox.checked = false;
  } else {
    await removeOverlayPermission(DEXSCREENER_OVERLAY_ORIGIN);
  }
  paintPermissions();
});

dexscreenerChartConsentBox.addEventListener('change', async () => {
  if (dexscreenerChartConsentBox.checked) {
    await chrome.storage.local.set({
      [DEXSCREENER_CHART_CONSENT_KEY]: true,
    });
  } else {
    await chrome.storage.local.remove(DEXSCREENER_CHART_CONSENT_KEY);
  }
  paintPermissions();
});

paintPermissions();


/** Show the live entitlement so a user is never guessing about their status. */
(async () => {
  if (!GATING_ENABLED) return;
  const box = document.getElementById('licenseState');
  if (!box) return;
  try {
    const ent = await entitlement();
    box.textContent =
      ent.state === 'licensed'
        ? (ent.expires
            ? `Access active until ${ent.expires}${ent.offline ? ' (offline)' : ''}.`
            : (ent.offline ? 'Access active (offline; last checked key still valid).' : 'Access active.'))
      : ent.state === 'trial' ? `Trial: ${ent.daysLeft} of ${TRIAL_LENGTH_DAYS} days remaining.`
      : ent.state === 'free' ? ''
      : ent.reason || '';
  } catch { /* never block the options page on this */ }
})();
