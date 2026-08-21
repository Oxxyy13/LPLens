/**
 * LPLens invite-only beta access check.
 *
 * POST / { key, installationId? } -> { valid, expires, reason }
 * POST /blockscout { key, installationId, chainId, fields } -> Blockscout logs
 *
 * Keys are stored as SHA-256 hex hashes, never plaintext. Add or revoke a
 * tester by editing KEYS and redeploying. Unknown hashes and expired keys
 * both answer valid: false; only a known expired entry names the date.
 */

export const KEYS = {
  // '<sha256 hex>': { label: 'Dave', expires: '2026-09-02' },
  '31b6dcea491c6dae4db197a10c1459c9698e1bfec45b60f2123965fc9abcee9a': { label: 'tester-1', expires: '2026-09-02' },
  'c7f3da3eecba8e2ba08e76125ba9bd5deb7f84d8f4d1c34a6c8682bc31258777': { label: 'cws-reviewer', expires: '2027-08-31' },
};

const GENERIC = 'This access key was not recognised.';
const INSTALLATION_ID = /^[A-Za-z0-9_-]{20,80}$/;
const DEFAULT_INSTALLATION_LIMIT = 5;
const ENFORCE_INSTALLATION_LIMITS = false;
const RELAY_REQUESTS_PER_LICENCE_PER_DAY = 1000;
const BLOCKSCOUT_PRO = 'https://api.blockscout.com/v2/api';
const MAX_BODY_BYTES = 8192;

// The relay is deliberately not a general Blockscout proxy. Only the exact
// contracts and chains LPLens reads for v3 history and v4 ownership replay are
// accepted. A leaked beta code therefore cannot spend the shared key on other
// Blockscout products or arbitrary addresses. Keep these lowercase copies of
// CHAINS[k].nfpm and CHAINS[k].v4PositionManager; tools/test-blockscout-relay.mjs
// fails if they drift.
const RELAY_CONTRACTS = Object.freeze({
  '1': new Set([
    '0xc36442b4a4522e871399cd717abdd847ab11fe88',
    '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e',
  ]),
  '8453': new Set([
    '0x03a520b32c04bf3beef7beb72e919cf822ed34f1',
    '0x7c5f5a4bbd8fd63184577525326123b519429bdc',
  ]),
  '42161': new Set([
    '0xc36442b4a4522e871399cd717abdd847ab11fe88',
    '0xd88f38f930b7952f2db2432cb002e7abbf3dd869',
  ]),
  '137': new Set([
    '0xc36442b4a4522e871399cd717abdd847ab11fe88',
    '0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9',
  ]),
});

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
<p class="meta">Effective 21 August 2026. Contact: <a href="mailto:oxxyy13@gmail.com">oxxyy13@gmail.com</a>.</p>
<p>LPLens is a read-only Chrome extension that inspects Uniswap v3 and v4 liquidity-provider positions for an Ethereum-style address you paste. It never connects a wallet, never asks for a signature, and never sees a private key.</p>
<p>This policy uses the Chrome Web Store data-category names so the store listing and this page say the same things.</p>

<h2>Data categories we handle</h2>
<dl>
  <dt>Personally identifiable information</dt>
  <dd>The blockchain address you type or paste (an account identifier). We do not ask for your name, email, phone number, or government ID. The address is stored on your machine and sent to the services below so they can return that account’s public on-chain data.</dd>
  <dt>Authentication information</dt>
  <dd>If you use the invite-only beta, the access key you paste in options is sent to this Worker over HTTPS so we can check it is still valid. We store a SHA-256 hash of keys we have issued, not the plaintext, together with a label and an expiry date that the developer maintains. The extension also creates a random installation identifier. We store only its SHA-256 hash, first-seen time and last-seen time so we can count browser installations and investigate accidental code sharing. We do not fingerprint your browser or store your IP address. The access key and un-hashed installation identifier are also kept in <code>chrome.storage.local</code> on your computer.</dd>
  <dt>Financial and payment information</dt>
  <dd>We do not collect bank details, cards, or payment credentials. We do retrieve publicly recorded on-chain token balances, pool state, and Uniswap position events for the address you paste. Those figures are financial in nature. They come from public chain data, not from a payment processor.</dd>
  <dt>Web history</dt>
  <dd>Only if you turn on the optional overlay: the extension reads the URL of the Uniswap positions page you have open (<code>app.uniswap.org/positions/…</code>) so it can discover or load the matching chain and token id. That permission is off until you grant it in options. We do not collect browsing history for any other site, and we do not store or transmit your Uniswap browsing history.</dd>
  <dt>Website content</dt>
  <dd>On an individual position page, the overlay uses the URL. On the positions list, it reads position links whose paths identify v3 or v4 positions and the first line of visible row text so it can discover positions, label its panels, and place each panel beside the matching row. This page-derived label stays in the tab and is not sent to LPLens or a third party. The overlay does not read Uniswap balances, form fields, connected-wallet data, or signing prompts; it does not alter Uniswap’s content and only appends its own panel. Position amounts and history are loaded from public chain data through the extension’s background worker, not scraped from the page.</dd>
  <dt>User activity</dt>
  <dd>The chain you select and the address you look up are stored locally so you do not have to retype them. We do not run behavioural analytics or advertising. The limited operational installation and request counters are described below.</dd>
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
  <li>Etherscan and/or Blockscout, when lifetime event history or v4 position lists are fetched. History queries use the position-manager contract and the position’s token id; v4 enumeration also uses your address as a log-filter topic. By default, licensed builds send those log filters through this Worker to Blockscout Pro so the shared API credential never enters the extension. If that route is unavailable, the extension may fall back to a public Blockscout instance or the chain RPC. If you save an Etherscan API key in options, that key is sent directly to Etherscan.</li>
</ul>
<p>Those hosts are not operated by LPLens. They see ordinary HTTPS request metadata (including IP address) under their own policies.</p>

<h2>What this Worker receives</h2>
<p>This site provides the access check and the authenticated Blockscout relay. It receives the access key and random installation identifier when access is checked. For Blockscout history requests it also receives a chain id, a known Uniswap position-manager contract and event-log filters. A v3 filter identifies a public position NFT; a v4 ownership filter can contain the public address being inspected. The Worker forwards those filters to Blockscout Pro but does not store wallet addresses, token ids, contract filters, response bodies or IP addresses.</p>
<p>We retain hashed installation records and per-licence daily request totals to operate the beta, diagnose sharing and protect the shared API allowance. These are operational counters, not advertising or behavioural analytics. Cloudflare, which hosts the Worker, processes the HTTPS requests.</p>

<h2>What stays on your machine</h2>
<p><code>chrome.storage.local</code> may hold: the last address and chain, custom RPC URLs, an optional Etherscan key, the access key, the random installation identifier and last validation result, overlay layout preferences, and a cache of position event history. That data does not sync through LPLens servers. Clearing site data for the extension, or uninstalling it, removes it from the computer.</p>

<h2>What we do not do</h2>
<ul>
  <li>No advertising analytics, tracking pixels, browser fingerprinting, crash reporters, or ad networks. Operational counts are limited to hashed browser installations and per-licence relay-request totals.</li>
  <li>No sale of data. No server-side user account. No mailing list built from extension use.</li>
  <li>No wallet connection: the extension never calls <code>eth_requestAccounts</code>, <code>eth_sendTransaction</code>, or <code>personal_sign</code>, and the optional content script cannot reach <code>window.ethereum</code>.</li>
</ul>

<h2>Optional Uniswap overlay</h2>
<p>Access to <code>app.uniswap.org</code> is optional and off at install. Before Chrome asks for the permission, options explains the URL, link, and short visible-label access described above. Granting it lets LPLens show its panel on Uniswap position pages. Revoking it unregisters that content script immediately.</p>

<h2>Limited Use</h2>
<p>Data listed above is used only to provide LPLens’s single purpose: showing Uniswap v3 and v4 LP positions and lifetime figures for an address you choose, controlling beta access and protecting the shared history allowance. It is not used or transferred for advertising, credit, or unrelated profiling. Transfers to RPC providers, DexScreener, Etherscan, Blockscout, and this Worker happen only as needed for that purpose, or as required by law.</p>

<h2>Changes</h2>
<p>If this policy changes, the effective date at the top will change. There is no in-product mailing list; check this URL.</p>
<p>You may request deletion of a beta installation record by emailing the contact below with the neutral tester label you were given. Do not email an access key.</p>
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(entry.expires || ''))) {
    return { valid: false, expires: null, reason: GENERIC };
  }
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

function iso(now = new Date()) {
  return now.toISOString();
}

function installationLimit(entry) {
  const n = Number(entry && entry.maxInstallations);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_INSTALLATION_LIMIT;
}

async function trackInstallation(env, keyHash, entry, installationId, now = new Date()) {
  if (!env || !env.DB || !installationId) return null;
  if (!INSTALLATION_ID.test(installationId)) throw new Error('invalid installation identifier');

  const installationHash = await sha256Hex(installationId);
  const at = iso(now);
  await env.DB.prepare(`
    INSERT INTO installations
      (licence_hash, licence_label, installation_hash, first_seen, last_seen)
    VALUES (?1, ?2, ?3, ?4, ?4)
    ON CONFLICT (licence_hash, installation_hash)
    DO UPDATE SET last_seen = excluded.last_seen, licence_label = excluded.licence_label
  `).bind(keyHash, String(entry.label || 'unlabelled'), installationHash, at).run();

  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM installations
    WHERE licence_hash = ?1 AND revoked_at IS NULL
  `).bind(keyHash).first();
  return {
    count: Number(row && row.count || 0),
    limit: installationLimit(entry),
  };
}

async function authorise(key, installationId, env, now = new Date()) {
  const keyHash = await sha256Hex(key);
  const entry = KEYS[keyHash];
  const verdict = decide(entry, now);
  if (!verdict.valid) return { ...verdict, keyHash, entry: null, installation: null };

  let installation = null;
  if (installationId) {
    installation = await trackInstallation(env, keyHash, entry, installationId, now);
    if (ENFORCE_INSTALLATION_LIMITS
        && installation && installation.count > installation.limit) {
      return {
        valid: false,
        expires: verdict.expires,
        reason: 'This access key has reached its browser-installation limit. Ask Dan to reset an old installation.',
        keyHash,
        entry,
        installation,
      };
    }
  }
  return { ...verdict, keyHash, entry, installation };
}

const BLOCK = /^(?:latest|[0-9]{1,12})$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const TOPIC = /^0x[0-9a-f]{64}$/;
const FIELD_NAMES = new Set([
  'address', 'fromBlock', 'toBlock',
  'topic0', 'topic1', 'topic2', 'topic3',
  'topic0_1_opr', 'topic0_2_opr', 'topic0_3_opr',
  'topic1_2_opr', 'topic1_3_opr', 'topic2_3_opr',
]);

/** Validate and copy only the log query shape LPLens is allowed to relay. */
export function relayQuery(payload) {
  const chainId = String(payload && payload.chainId || '');
  const allowed = RELAY_CONTRACTS[chainId];
  const fields = payload && payload.fields;
  if (!allowed || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('unsupported Blockscout request');
  }
  for (const name of Object.keys(fields)) {
    if (!FIELD_NAMES.has(name)) throw new Error(`unsupported Blockscout field ${name}`);
  }

  const address = String(fields.address || '').toLowerCase();
  const fromBlock = String(fields.fromBlock ?? '0');
  const toBlock = String(fields.toBlock ?? 'latest');
  if (!ADDRESS.test(address) || !allowed.has(address)) throw new Error('contract is not allowlisted');
  if (!BLOCK.test(fromBlock) || !BLOCK.test(toBlock)) throw new Error('invalid block range');

  const clean = { address, fromBlock, toBlock };
  let topics = 0;
  for (const name of ['topic0', 'topic1', 'topic2', 'topic3']) {
    if (fields[name] === undefined || fields[name] === null || fields[name] === '') continue;
    const value = String(fields[name]).toLowerCase();
    if (!TOPIC.test(value)) throw new Error(`invalid ${name}`);
    clean[name] = value;
    topics++;
  }
  if (!topics) throw new Error('at least one topic is required');

  for (const name of [...FIELD_NAMES].filter((x) => x.endsWith('_opr'))) {
    if (fields[name] === undefined || fields[name] === null || fields[name] === '') continue;
    const value = String(fields[name]).toLowerCase();
    if (value !== 'and' && value !== 'or') throw new Error(`invalid ${name}`);
    clean[name] = value;
  }
  return { chainId, fields: clean };
}

async function takeRelayQuota(env, keyHash, entry, now = new Date()) {
  if (!env || !env.DB) throw new Error('relay usage database is unavailable');
  const day = now.toISOString().slice(0, 10);
  const row = await env.DB.prepare(`
    INSERT INTO relay_usage_daily
      (licence_hash, licence_label, day, requests, last_at)
    VALUES (?1, ?2, ?3, 1, ?4)
    ON CONFLICT (licence_hash, day)
    DO UPDATE SET requests = requests + 1,
                  last_at = excluded.last_at,
                  licence_label = excluded.licence_label
    RETURNING requests
  `).bind(keyHash, String(entry.label || 'unlabelled'), day, iso(now)).first();
  const requests = Number(row && row.requests || 0);
  return { allowed: requests <= RELAY_REQUESTS_PER_LICENCE_PER_DAY, requests };
}

async function readPayload(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) throw new Error('request body too large');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('request body too large');
  return JSON.parse(text);
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
    headers: {
      ...cors(),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function privacyResponse() {
  return new Response(PRIVACY_HTML, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}

async function validateRequest(payload, env) {
  const key = String(payload && payload.key != null ? payload.key : '').trim();
  const installationId = String(payload && payload.installationId || '').trim();
  if (!key) return json(decide(null));
  if (installationId && !INSTALLATION_ID.test(installationId)) {
    return json({ valid: false, expires: null, reason: GENERIC }, 400);
  }

  let auth;
  try {
    auth = await authorise(key, installationId, env);
  } catch {
    // Telemetry must never turn a valid beta code into an outage. The relay
    // itself fails closed when its usage database is unavailable, but the
    // basic licence verdict remains usable.
    const keyHash = await sha256Hex(key);
    auth = { ...decide(KEYS[keyHash]), installation: null };
  }
  return json({
    valid: auth.valid,
    expires: auth.expires || null,
    reason: auth.reason || null,
    installations: auth.installation ? auth.installation.count : null,
    installationLimit: auth.installation ? auth.installation.limit : null,
  });
}

async function relayRequest(payload, env) {
  const key = String(payload && payload.key != null ? payload.key : '').trim();
  const installationId = String(payload && payload.installationId || '').trim();
  if (!key || !INSTALLATION_ID.test(installationId)) {
    return json({ error: 'Access not granted.' }, 401);
  }

  let auth;
  try {
    auth = await authorise(key, installationId, env);
  } catch {
    return json({ error: 'Access verification is temporarily unavailable.' }, 503);
  }
  if (!auth.valid) return json({ error: auth.reason || GENERIC }, 403);

  let query;
  try { query = relayQuery(payload); }
  catch (err) { return json({ error: err.message || 'Invalid log query.' }, 400); }

  let quota;
  try { quota = await takeRelayQuota(env, auth.keyHash, auth.entry); }
  catch { return json({ error: 'History relay is temporarily unavailable.' }, 503); }
  if (!quota.allowed) {
    return json({ error: 'This access key reached its daily history allowance.' }, 429);
  }
  if (!env || !env.BLOCKSCOUT_PRO_API_KEY) {
    return json({ error: 'History relay is not configured.' }, 503);
  }

  const upstream = new URL(BLOCKSCOUT_PRO);
  const params = {
    chain_id: query.chainId,
    module: 'logs',
    action: 'getLogs',
    ...query.fields,
    apikey: env.BLOCKSCOUT_PRO_API_KEY,
  };
  for (const [name, value] of Object.entries(params)) upstream.searchParams.set(name, value);

  try {
    const response = await fetch(upstream, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (text.length > 5_000_000) throw new Error('upstream response too large');
    let body;
    try { body = JSON.parse(text); }
    catch { throw new Error('upstream returned non-JSON'); }
    return json(body, response.status);
  } catch {
    return json({ error: 'Blockscout Pro is temporarily unavailable.' }, 502);
  }
}

export default {
  async fetch(request, env = {}) {
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'GET' && path === '/privacy') return privacyResponse();
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: cors() });
    }

    let payload;
    try { payload = await readPayload(request); }
    catch {
      return path === '/blockscout'
        ? json({ error: 'Invalid request.' }, 400)
        : json({ valid: false, expires: null, reason: GENERIC }, 400);
    }

    if (path === '/') return validateRequest(payload, env);
    if (path === '/blockscout') return relayRequest(payload, env);
    return json({ error: 'Not found.' }, 404);
  },
};
