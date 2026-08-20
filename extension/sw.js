/**
 * Background service worker.
 *
 * It exists for one reason: MV3 removed cross-origin privileges from content
 * scripts, so the overlay running on app.uniswap.org cannot call an RPC
 * directly — it would be subject to that page's CORS. All network access stays
 * in the extension context here, behind the manifest's host_permissions, and
 * the content script only ever receives finished data.
 *
 * This worker holds no wallet capability. It issues the methods in
 * RPC_METHODS (eth_call, eth_getLogs, eth_getBlockByNumber), all reads,
 * exactly as the popup does.
 */
import { loadPositionByVersion } from './lib/positions.js';
import { entitlement } from './lib/license.js';

const inFlight = new Map();  // `${chain}:${tokenId}` -> Promise

// Concurrency limit across ALL callers. One position load issues 6-10 fetches,
// so an unexpected burst of requests multiplies straight into the network
// stack. Without this and the in-flight map below, a content script that
// rescans in a loop can put thousands of concurrent fetches in flight and take
// the whole browser down rather than just wedging a tab.
const MAX_CONCURRENT = 4;
let active = 0;
const waiting = [];

function slot() {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else active--;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'LPLENS_POSITION') return false;

  const key = `${msg.chain}:${msg.version || 'v3'}:${msg.tokenId}`;

  // Coalesce only concurrently in-flight requests. Completed results are not
  // cached: after Increase/Decrease/Collect, reloading the Uniswap page must
  // read the just-mined state rather than replay a plausible 30-second-old one.
  // Gate here rather than in the UI: the check then covers every surface at
  // once, and a patched content script still gets nothing back.
  const gated = (async () => {
    const ent = await entitlement();
    // GATING_ENABLED false => allowed:true. Invite-only: needs_key /
    // misconfigured / invalid all have allowed:false and land here.
    if (!ent.allowed) return { ok: false, gated: true, entitlement: ent };
    return null;
  })();

  let job = inFlight.get(key);
  if (!job) {
    job = (async () => {
      await slot();
      try {
        const store = await chrome.storage.local.get(['rpcOverrides', 'etherscanKey']);
        const overrides = store.rpcOverrides || {};
        const data = await loadPositionByVersion(msg.chain, msg.version || 'v3', BigInt(msg.tokenId), {
          rpcOverride: overrides[msg.chain] || undefined,
          etherscanKey: store.etherscanKey || undefined,
        });
        // BigInt does not survive structured clone to the content script.
        const safe = JSON.parse(JSON.stringify(data, (_k, v) =>
          typeof v === 'bigint' ? v.toString() : v));
        return safe;
      } finally {
        release();
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, job);
  }

  gated.then((block) => {
    if (block) return sendResponse(block);
    return job.then(
      (data) => sendResponse({ ok: true, data }),
      (err) => sendResponse({ ok: false, error: err.message || String(err) }),
    );
  });

  return true; // keep the message channel open for the async reply
});


/* ---------------------------------------------------------------------------
 * On-page overlay registration.
 *
 * The overlay is the only part of LPLens that can touch a web page, and a
 * content script that can modify a DEX page is a genuine attack vector
 * regardless of how this code behaves today — a later malicious update inherits
 * the same access, and extensions auto-update.
 *
 * So it is not granted at install. The manifest declares no `content_scripts`
 * at all; `https://app.uniswap.org/*` sits in `optional_host_permissions` and
 * the script is registered only once the user grants it, from the options page.
 * Revoking the permission unregisters it immediately. Until then the extension
 * cannot read or alter any web page, and the install prompt says so.
 * ------------------------------------------------------------------------- */

const OVERLAY_ID = 'lplens-overlay';
const OVERLAY_ORIGIN = 'https://app.uniswap.org/*';

async function overlayRegistered() {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [OVERLAY_ID] });
    return existing.length > 0;
  } catch {
    return false;
  }
}

async function syncOverlayRegistration() {
  const granted = await chrome.permissions.contains({ origins: [OVERLAY_ORIGIN] });
  const registered = await overlayRegistered();

  if (granted && !registered) {
    await chrome.scripting.registerContentScripts([{
      id: OVERLAY_ID,
      matches: ['https://app.uniswap.org/positions/*'],
      js: ['render.js', 'overlay.js'],
      runAt: 'document_idle',
    }]);
  } else if (!granted && registered) {
    await chrome.scripting.unregisterContentScripts({ ids: [OVERLAY_ID] });
  }
}

chrome.runtime.onInstalled.addListener(syncOverlayRegistration);
chrome.runtime.onStartup.addListener(syncOverlayRegistration);
chrome.permissions.onAdded.addListener(syncOverlayRegistration);
chrome.permissions.onRemoved.addListener(syncOverlayRegistration);
syncOverlayRegistration();
