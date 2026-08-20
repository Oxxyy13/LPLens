/**
 * LPLens invite-only beta access check.
 *
 * POST { key } -> { valid, expires, reason }
 *
 * Keys are stored as SHA-256 hex hashes, never plaintext. Add or revoke a
 * tester by editing KEYS and redeploying. Unknown hashes and expired keys
 * both answer valid: false; only a known expired entry names the date.
 */

export const KEYS = {
  // '<sha256 hex>': { label: 'Dave', expires: '2026-09-02' },
  '31b6dcea491c6dae4db197a10c1459c9698e1bfec45b60f2123965fc9abcee9a': { label: 'tester-1', expires: '2026-09-02' },
};

const GENERIC = 'This access key was not recognised.';

/** Self-contained privacy policy. No external CSS, fonts, or scripts. */
const PRIVACY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LPLens privacy policy</title>
<style>
  body { font: 16px/1.45 system-ui, sans-serif; color: #1a1a1a; max-width: 42rem;
         margin: 2rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.5rem; }
  h2 { font-size: 1.1rem; margin-top: 1.75rem; }
  dt { font-weight: 600; margin-top: 0.75rem; }
  dd { margin-left: 0; }
  .meta { color: #444; font-size: 0.9rem; }
</style>
</head>
<body>
<h1>LPLens privacy policy</h1>
<p class="meta">Effective 19 August 2026. Contact: <a href="mailto:oxxyy13@gmail.com">oxxyy13@gmail.com</a>.</p>
<p>LPLens is a read-only Chrome extension that inspects Uniswap v3 and v4 liquidity-provider positions for an Ethereum-style address you paste. It never connects a wallet, never asks for a signature, and never sees a private key.</p>
<p>This policy uses the Chrome Web Store data-category names so the store listing and this page say the same things.</p>

<h2>Data categories we handle</h2>
<dl>
  <dt>Personally identifiable information</dt>
  <dd>The blockchain address you type or paste (an account identifier). We do not ask for your name, email, phone number, or government ID. The address is stored on your machine and sent to the services below so they can return that account’s public on-chain data.</dd>
  <dt>Authentication information</dt>
  <dd>If you use the invite-only beta, the access key you paste in options is sent to this Worker over HTTPS so we can check it is still valid. We store a SHA-256 hash of keys we have issued, not the plaintext, together with a label and an expiry date that the developer maintains. The key is also kept in <code>chrome.storage.local</code> on your computer.</dd>
  <dt>Financial and payment information</dt>
  <dd>We do not collect bank details, cards, or payment credentials. We do retrieve publicly recorded on-chain token balances, pool state, and Uniswap position events for the address you paste. Those figures are financial in nature. They come from public chain data, not from a payment processor.</dd>
  <dt>Web history</dt>
  <dd>Only if you turn on the optional overlay: the extension reads the URL of the Uniswap position page you have open (<code>app.uniswap.org/positions/…</code>) so it can load the matching chain and token id. That permission is off until you grant it in options. We do not collect browsing history for any other site.</dd>
  <dt>Website content</dt>
  <dd>The overlay does not read Uniswap’s page HTML or alter amounts shown on that page. It appends its own panel. Position data is loaded from the chain via the extension’s background worker, not scraped from the page.</dd>
  <dt>User activity</dt>
  <dd>The chain you select and the address you look up are stored locally so you do not have to retype them. We do not run analytics, telemetry, or advertising.</dd>
  <dt>Health information</dt>
  <dd>Not collected.</dd>
  <dt>Personal communications</dt>
  <dd>Not collected.</dd>
  <dt>Location</dt>
  <dd>Not collected. Third-party HTTPS hosts you reach (below) may see your IP address as any website would; we do not ask for or store location.</dd>
</dl>

<h2>Where the address and related public data are sent</h2>
<p>To show positions, LPLens sends the address you pasted — and contract addresses derived from those positions — to:</p>
<ul>
  <li>the JSON-RPC endpoint for the selected chain (built-in public or Alchemy URLs, or a URL you set in options), using read-only methods <code>eth_call</code>, <code>eth_getLogs</code>, and <code>eth_getBlockByNumber</code>;</li>
  <li>DexScreener (<code>api.dexscreener.com</code>), which receives token contract addresses so the extension can fetch USD marks;</li>
  <li>Etherscan and/or Blockscout, when lifetime event history or v4 position lists are fetched. History queries use the position-manager contract and the position’s token id; v4 enumeration also uses your address as a log-filter topic. If you save an Etherscan API key in options, that key is sent with Etherscan requests.</li>
</ul>
<p>Those hosts are not operated by LPLens. They see ordinary HTTPS request metadata (including IP address) under their own policies.</p>

<h2>What this Worker receives</h2>
<p>This site is the access-check Worker. It receives the access key on <code>POST /</code> and answers whether it is valid and when it expires. Cloudflare, which hosts the Worker, processes the HTTP request. We do not use the Worker for analytics or ads.</p>

<h2>What stays on your machine</h2>
<p><code>chrome.storage.local</code> may hold: the last address and chain, custom RPC URLs, an optional Etherscan key, the access key and last validation result, overlay layout preferences, and a cache of position event history. That data does not sync through LPLens servers. Clearing site data for the extension, or uninstalling it, removes it.</p>

<h2>What we do not do</h2>
<ul>
  <li>No analytics, tracking pixels, crash reporters, or ad networks.</li>
  <li>No sale of data. No server-side user account. No mailing list built from extension use.</li>
  <li>No wallet connection: the extension never calls <code>eth_requestAccounts</code>, <code>eth_sendTransaction</code>, or <code>personal_sign</code>, and the optional content script cannot reach <code>window.ethereum</code>.</li>
</ul>

<h2>Optional Uniswap overlay</h2>
<p>Access to <code>app.uniswap.org</code> is optional and off at install. Granting it in options lets LPLens show its panel on Uniswap position pages. Revoking it unregisters that content script immediately.</p>

<h2>Limited Use</h2>
<p>Data listed above is used only to provide LPLens’s single purpose: showing Uniswap v3 and v4 LP positions and lifetime figures for an address you choose. It is not used or transferred for advertising, credit, or unrelated profiling. Transfers to RPC providers, DexScreener, Etherscan, Blockscout, and this Worker happen only as needed for that purpose, or as required by law.</p>

<h2>Changes</h2>
<p>If this policy changes, the effective date at the top will change. There is no in-product mailing list; check this URL.</p>
<p class="meta">LPLens. Questions: <a href="mailto:oxxyy13@gmail.com">oxxyy13@gmail.com</a>.</p>
</body>
</html>
`;

export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Last valid calendar day is inclusive (UTC date string YYYY-MM-DD). */
export function decide(entry, now = new Date()) {
  if (!entry) return { valid: false, expires: null, reason: GENERIC };
  const day = now.toISOString().slice(0, 10);
  if (day > entry.expires) {
    return {
      valid: false,
      expires: entry.expires,
      reason: `Your LPLens beta access ended on ${entry.expires}.`,
    };
  }
  return { valid: true, expires: entry.expires, reason: null };
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(), 'Content-Type': 'application/json' },
  });
}

function privacyResponse() {
  return new Response(PRIVACY_HTML, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}

export default {
  async fetch(request) {
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'GET' && path === '/privacy') {
      return privacyResponse();
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: cors() });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ valid: false, expires: null, reason: GENERIC }, 400);
    }

    const key = String(payload && payload.key != null ? payload.key : '').trim();
    if (!key) return json(decide(null));

    const hash = await sha256Hex(key);
    return json(decide(KEYS[hash]));
  },
};
