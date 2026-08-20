import { CHAINS, PUBLIC_RPC } from './lib/chains.js';
import { GATING_ENABLED, TRIAL_LENGTH_DAYS, entitlement } from './lib/license.js';
import { RPC_METHODS } from './lib/rpc.js';

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
     It is an opaque string &mdash; never a wallet, a signature, or a private key.`;
} else {
  licenseSection.hidden = true;
}

chrome.storage.local.get(['rpcOverrides', 'etherscanKey', 'licenseKey'], (s) => {
  const o = s.rpcOverrides || {};
  for (const k of keys) {
    // Only the user's saved override goes in the field. Never the live
    // CHAINS[k].rpc, which may carry a dev-fence credential.
    if (o[k]) document.getElementById(`rpc-${k}`).value = o[k];
  }
  if (s.etherscanKey) document.getElementById('etherscanKey').value = s.etherscanKey;
  if (GATING_ENABLED && s.licenseKey) document.getElementById('licenseKey').value = s.licenseKey;
});

const showEtherscan = document.getElementById('showEtherscan');
if (showEtherscan) {
  showEtherscan.addEventListener('change', () => {
    document.getElementById('etherscanKey').type = showEtherscan.checked ? 'text' : 'password';
  });
}

document.getElementById('save').addEventListener('click', () => {
  const rpcOverrides = {};
  for (const k of keys) {
    const v = document.getElementById(`rpc-${k}`).value.trim();
    if (v) rpcOverrides[k] = v;
  }
  const etherscanKey = document.getElementById('etherscanKey').value.trim();
  const payload = { rpcOverrides, etherscanKey };
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
const permBox = document.getElementById('overlayPerm');
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
  const granted = await chrome.permissions.contains({ origins: [OVERLAY_ORIGIN] });
  permBox.checked = granted;

  const pageAccess = granted
    ? `<li class="yes"><b>app.uniswap.org/positions/*</b> — can read and add to
         this page only. Nothing else on the web.</li>`
    : `<li class="no"><b>No web page at all.</b> The overlay is off, so no
         content script is registered anywhere.</li>`;

  const hosts = (mf.host_permissions || []).map((h) =>
    `<li class="net">${escape(h)}</li>`).join('');

  report.innerHTML = `
    <h3>Web pages it can read or modify</h3>
    <ul>${pageAccess}</ul>
    <h3>Servers it can send requests to</h3>
    <ul>${hosts}</ul>
    <h3>Browser permissions</h3>
    <ul>${(mf.permissions || []).map((p) => `<li>${escape(p)}</li>`).join('')}</ul>
    <h3>What it cannot do, structurally</h3>
    <ul class="cannot">
      <li>No wallet access. It never calls <code>eth_sendTransaction</code>,
          <code>personal_sign</code> or <code>eth_requestAccounts</code>, and a
          content script runs in an isolated world where
          <code>window.ethereum</code> is unreachable.</li>
      <li>The only JSON-RPC methods it issues are ${rpcMethodList(RPC_METHODS)}.
          All are reads; none can move a token or sign anything.</li>
      <li>No <code>tabs</code>, <code>activeTab</code>, <code>cookies</code>,
          <code>webRequest</code> or <code>&lt;all_urls&gt;</code> — so it cannot
          see your browsing, and cannot reach any exchange or wallet site.</li>
      <li>The overlay only appends its own panel. It never rewrites Uniswap's
          markup, so it cannot alter an address or amount shown to you.</li>
    </ul>`;
}

permBox.addEventListener('change', async () => {
  if (permBox.checked) {
    const ok = await chrome.permissions.request({ origins: [OVERLAY_ORIGIN] });
    if (!ok) permBox.checked = false;
  } else {
    await chrome.permissions.remove({ origins: [OVERLAY_ORIGIN] });
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
