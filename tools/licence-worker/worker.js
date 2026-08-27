/**
 * LPLens invite-only beta access check.
 *
 * POST / { key, installationId? } -> { valid, expires, reason }
 * POST /history { key, installationId, chainId, fields } -> provider logs
 * POST /blockscout remains a backwards-compatible alias for 0.27 clients.
 * POST /telemetry { key, version, surface, outcome, buckets, errors } -> ok
 *
 * Keys are stored as SHA-256 hex hashes, never plaintext. Add or revoke a
 * tester by editing KEYS and redeploying. Unknown hashes and expired keys
 * both answer valid: false; only a known expired entry names the date.
 */

export const KEYS = {
  // '<sha256 hex>': { label: 'Dave', expires: '2026-09-02' },
  '4da173b9c68092c107ed97299d649c48b7bdb9974d883398b2d4d4d830812f1e': { label: 'beta-001', expires: '2026-09-08' },
  '23b082839352b5aa097efe8a89836b4f48d2bc0896f77ee597edbfa5add5fffb': { label: 'beta-002', expires: '2026-09-08' },
  '21554fb69f9c37727db72020eef2ec2a51cd562ab106cb0c56a567d703d72587': { label: 'beta-003', expires: '2026-09-08' },
  '0c73a6ebca20a8c12a053fc96a8b9d60e6a383f79b6446dca8c548278ca4603f': { label: 'beta-004', expires: '2026-09-08' },
  '154091f4e547299cae430254259f6155717417657fd277e09a1e7a5d07af0795': { label: 'beta-005', expires: '2026-09-08' },
  'da1d4ef8e832f84d207e1f8b56b3beb500bc807abe5ab8e10dbbcb3fa622c02d': { label: 'beta-006', expires: '2026-09-08' },
  'a63479acc4ee626ab2f9b5aeac329c52c9e907c8f367afa7064faadb50c5dac9': { label: 'beta-007', expires: '2026-09-08' },
  'c7f3da3eecba8e2ba08e76125ba9bd5deb7f84d8f4d1c34a6c8682bc31258777': { label: 'cws-reviewer', expires: '2027-08-31' },
  '69448619e77f5ce22fbe0435871e8183a3b4f0ce341ae952e8c2db7c0f63e077': { label: 'owner-primary', expires: '2030-12-31' },
};

const GENERIC = 'This access key was not recognised.';
const INSTALLATION_ID = /^[A-Za-z0-9_-]{20,80}$/;
const DEFAULT_INSTALLATION_LIMIT = 5;
const ENFORCE_INSTALLATION_LIMITS = false;
const RELAY_REQUESTS_PER_LICENCE_PER_DAY = 1000;
const BLOCKSCOUT_PRO = 'https://api.blockscout.com/v2/api';
const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';
const MAX_BODY_BYTES = 8192;
const TELEMETRY_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const TELEMETRY_SURFACES = new Set(['popup', 'sidepanel']);
const TELEMETRY_OUTCOMES = new Set(['success', 'empty', 'partial', 'failed']);
const TELEMETRY_POSITION_BUCKETS = new Set(['0', '1', '2-5', '6-20', '21+']);
const TELEMETRY_DURATION_BUCKETS = new Set(['<5s', '5-15s', '15-30s', '30-60s', '60s+']);
const TELEMETRY_CHAINS = new Set([
  'ethereum', 'base', 'arbitrum', 'polygon', 'hyperevm', 'robinhood',
]);
const TELEMETRY_ERROR_CODES = new Set([
  'rate_limit', 'timeout', 'network', 'history', 'ownership', 'unreadable', 'rpc', 'unknown',
]);
const MAX_TELEMETRY_ERRORS = 16;

// The relay is deliberately not a general Blockscout proxy. Only the exact
// contracts and chains LPLens reads for v3 history, v4 ownership replay and
// tightly filtered v4 liquidity history are
// accepted. A leaked beta code therefore cannot spend the shared key on other
// Blockscout products or arbitrary addresses. Keep these lowercase copies of
// CHAINS[k].nfpm, CHAINS[k].v4PositionManager and CHAINS[k].v4PoolManager;
// tools/test-blockscout-relay.mjs fails if they drift.
const RELAY_CONTRACTS = Object.freeze({
  '1': new Set([
    '0xc36442b4a4522e871399cd717abdd847ab11fe88',
    '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e',
    '0x000000000004444c5dc75cb358380d2e3de08a90',
  ]),
  '8453': new Set([
    '0x03a520b32c04bf3beef7beb72e919cf822ed34f1',
    '0x7c5f5a4bbd8fd63184577525326123b519429bdc',
    '0x498581ff718922c3f8e6a244956af099b2652b2b',
  ]),
  '42161': new Set([
    '0xc36442b4a4522e871399cd717abdd847ab11fe88',
    '0xd88f38f930b7952f2db2432cb002e7abbf3dd869',
    '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
  ]),
  '137': new Set([
    '0xc36442b4a4522e871399cd717abdd847ab11fe88',
    '0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9',
    '0x67366782805870060151383f4bbff9dab53e5cd6',
  ]),
  '999': new Set([
    '0xead19ae861c29bbb2101e834922b2feee69b9091',
  ]),
});
const MODIFY_LIQUIDITY_TOPIC =
  '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec';
const topicAddress = (address) =>
  '0x' + address.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const V4_HISTORY_FILTERS = Object.freeze({
  '1': {
    poolManager: '0x000000000004444c5dc75cb358380d2e3de08a90',
    positionManager: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e',
  },
  '8453': {
    poolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b',
    positionManager: '0x7c5f5a4bbd8fd63184577525326123b519429bdc',
  },
  '42161': {
    poolManager: '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
    positionManager: '0xd88f38f930b7952f2db2432cb002e7abbf3dd869',
  },
  '137': {
    poolManager: '0x67366782805870060151383f4bbff9dab53e5cd6',
    positionManager: '0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9',
  },
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
<p class="meta">Effective 27 August 2026. Contact: <a href="mailto:oxxyy13@gmail.com">oxxyy13@gmail.com</a>.</p>
<p>LPLens is a read-only Chrome extension that inspects Uniswap v3/v4 and ProjectX concentrated-liquidity positions for an Ethereum-style address you paste. It never connects a wallet, never asks for a signature, and never sees a private key.</p>
<p>This policy uses the Chrome Web Store data-category names so the store listing and this page say the same things.</p>

<h2>Data categories we handle</h2>
<dl>
  <dt>Personally identifiable information</dt>
  <dd>The blockchain address you type or paste (an account identifier). We do not ask for your name, email, phone number, or government ID. The address is stored on your machine and sent to the services below so they can return that account’s public on-chain data.</dd>
  <dt>Authentication information</dt>
  <dd>If you use the invite-only beta, the access key you paste in options is sent to this Worker over HTTPS so we can check it is still valid. We store a SHA-256 hash of keys we have issued, not the plaintext, together with a label and an expiry date that the developer maintains. The extension also creates a random installation identifier. We store only its SHA-256 hash, first-seen time and last-seen time so we can count browser installations and investigate accidental code sharing. We do not fingerprint your browser or store your IP address. The access key and un-hashed installation identifier are also kept in <code>chrome.storage.local</code> on your computer.</dd>
  <dt>Financial and payment information</dt>
  <dd>We do not collect bank details, cards, or payment credentials. We do retrieve publicly recorded on-chain token balances, pool state, and Uniswap or ProjectX position events for the address you paste. Those figures are financial in nature. They come from public chain data, not from a payment processor.</dd>
  <dt>Web history</dt>
  <dd>Only if you independently turn on an optional overlay: the extension reads whether you opened the Uniswap positions list or an individual position page (<code>app.uniswap.org/positions</code> and its position-detail paths), the ProjectX portfolio page (<code>www.prjx.com/portfolio</code>), or a Dexscreener pair page (<code>dexscreener.com</code>). Each site permission is off until you grant it in options. We do not collect browsing history for any other site, and we do not store or transmit browsing history from these sites.</dd>
  <dt>Website content</dt>
  <dd>On an individual Uniswap position page, the overlay uses the URL. On the Uniswap positions list, it reads position links whose paths identify v3 or v4 positions and the first line of visible row text so it can discover positions, label its panels, and place each panel beside the matching row. This page-derived label stays in the tab and is not sent to LPLens or a third party. ProjectX does not expose stable position-NFT links, so its overlay does not read ProjectX page content or the connected wallet; it displays the HyperEVM positions for the last address you explicitly loaded in LPLens. On Dexscreener, the overlay uses only the chain and pool identifier in the pair-page URL and does not read Dexscreener page content or its connected wallet. The overlays do not read balances, form fields, wallet-provider state, or signing prompts; they do not alter site content, and each only appends its own panel. Position amounts and history are loaded from public chain data through the extension’s background worker, not scraped from the page.</dd>
  <dt>User activity</dt>
  <dd>The address you look up is stored locally so you do not have to retype it. We do not run advertising analytics. If “Share anonymous scan outcomes” is on, the extension sends its version, popup or side-panel surface, success/empty/partial/failed outcome, coarse position-count and duration buckets, and allowlisted per-chain error categories. It never sends raw error text, wallet addresses, labels, token names, pool or position identifiers, custom endpoints, provider keys, or the random installation identifier with these scan events. The Worker stores only daily aggregate rows that have no access-code hash or installation hash column. You can turn this off in Settings.</dd>
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
  <li>the JSON-RPC endpoint for the selected chain (built-in public or Alchemy URLs, or a URL you set in options), using read-only methods <code>eth_call</code>, <code>eth_getLogs</code>, <code>eth_getBlockByNumber</code>, and <code>eth_getTransactionReceipt</code>;</li>
  <li>DexScreener (<code>api.dexscreener.com</code>), which receives token contract addresses so the extension can fetch USD marks;</li>
  <li>Etherscan and/or Blockscout, when lifetime event history, v4 position lists, or v4 addition proofs are fetched. v3 history queries use the position-manager contract and the position’s token id. v4 history queries use the PoolManager, pool id, and PositionManager, then match the token id locally from event data; v4 enumeration also uses your address as a log-filter topic. When a v4 NFT has later additions, its public transaction hashes are sent directly to the chain’s public Blockscout trace endpoint so PoolManager’s principal and already-earned fee deltas can be separated exactly. By default, licensed builds send allowlisted log filters through this Worker to Blockscout Pro on supported Uniswap chains and to Etherscan V2 for ProjectX on HyperEVM, so shared API credentials never enter the extension. If that route is unavailable, the extension may fall back to a public Blockscout instance or the chain RPC. If you save an Etherscan API key in options, that key is sent directly to Etherscan.</li>
</ul>
<p>Those hosts are not operated by LPLens. They see ordinary HTTPS request metadata (including IP address) under their own policies.</p>

<h2>What this Worker receives</h2>
<p>This site provides the access check, authenticated history relay and optional anonymous scan counters. It receives the access key and random installation identifier when access is checked. For history requests it also receives a chain id, an allowlisted Uniswap or ProjectX position-manager or PoolManager contract and event-log filters. A v3-family filter identifies a public position NFT; a v4 ownership filter can contain the public address being inspected; and a v4 history filter identifies a public pool and PositionManager. The Worker forwards those filters to Blockscout Pro or Etherscan V2 but does not store wallet addresses, token ids, contract filters, response bodies or IP addresses. A telemetry request includes the access key only for validation; it does not include the random installation identifier, and the stored aggregate scan rows contain neither the access-code hash nor an installation hash.</p>
<p>We retain hashed installation records and per-licence daily request totals to operate the beta, diagnose sharing and protect the shared API allowance. Separately, when enabled, we retain anonymous daily scan outcomes and allowlisted error-category totals to improve reliability. These are operational and product-quality counters, not advertising analytics. Cloudflare, which hosts the Worker, processes the HTTPS requests.</p>

<h2>What stays on your machine</h2>
<p><code>chrome.storage.local</code> may hold: saved addresses, custom RPC URLs, an optional Etherscan key, the access key, the random installation identifier and last validation result, overlay layout preferences, the anonymous-scan setting, a sanitized most-recent diagnostic summary, a cache of immutable position event history, and the most recent rendered portfolio view used by the browser side panel. The diagnostic summary contains no wallet address, token name, pool id, position id, key or raw error text, and it leaves the browser only if you explicitly copy and share it. Local data does not sync through LPLens servers. Completed portfolio views are not sent to or stored by LPLens. Clearing site data for the extension, or uninstalling it, removes the local data from the computer.</p>

<h2>What we do not do</h2>
<ul>
  <li>No advertising analytics, tracking pixels, browser fingerprinting, crash reporters, or ad networks. Operational data is limited to hashed browser installations, per-licence relay-request totals, and optional anonymous aggregate scan outcomes and error categories.</li>
  <li>No sale of data. No server-side user account. No mailing list built from extension use.</li>
  <li>No wallet connection: the extension never calls <code>eth_requestAccounts</code>, <code>eth_sendTransaction</code>, or <code>personal_sign</code>, and the optional content script cannot reach <code>window.ethereum</code>.</li>
</ul>

<h2>Optional on-page overlays</h2>
<p>Access to <code>app.uniswap.org</code>, <code>www.prjx.com</code> and <code>dexscreener.com</code> is separately optional and off at install. Before Chrome asks for a permission, Settings explains the access described above. Granting Uniswap access lets LPLens show its panel on Uniswap position pages; granting ProjectX access lets it show a last-loaded-address panel only on the ProjectX portfolio; granting Dexscreener access lets it show matching positions for the last-loaded address on pair pages. Revoking a permission unregisters only that site's content script immediately.</p>

<h2>Limited Use</h2>
<p>Data listed above is used only to provide LPLens’s single purpose: showing Uniswap and ProjectX concentrated-liquidity positions and lifetime figures for an address you choose, placing that context on optional protocol and Dexscreener pages, controlling beta access, protecting the shared history allowance, and improving scan reliability through the optional anonymous counters described above. It is not used or transferred for advertising, credit, or unrelated profiling. Transfers to RPC providers, DexScreener, Etherscan, Blockscout, and this Worker happen only as needed for that purpose, or as required by law.</p>

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
    throw new Error('unsupported history request');
  }
  for (const name of Object.keys(fields)) {
    if (!FIELD_NAMES.has(name)) throw new Error(`unsupported history field ${name}`);
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
  const v4 = V4_HISTORY_FILTERS[chainId];
  if (v4 && address === v4.poolManager) {
    const exact = clean.topic0 === MODIFY_LIQUIDITY_TOPIC
      && !!clean.topic1
      && clean.topic2 === topicAddress(v4.positionManager)
      && clean.topic0_1_opr === 'and'
      && clean.topic0_2_opr === 'and'
      && clean.topic1_2_opr === 'and'
      && !clean.topic3;
    if (!exact) throw new Error('v4 PoolManager requires the exact LPLens history filter');
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

  const useEtherscan = query.chainId === '999';
  const provider = useEtherscan ? {
    name: 'Etherscan',
    url: ETHERSCAN_V2,
    chainField: 'chainid',
    secret: env && env.ETHERSCAN_API_KEY,
  } : {
    name: 'Blockscout Pro',
    url: BLOCKSCOUT_PRO,
    chainField: 'chain_id',
    secret: env && env.BLOCKSCOUT_PRO_API_KEY,
  };
  if (!provider.secret) {
    return json({ error: 'History relay is not configured.' }, 503);
  }

  let quota;
  try { quota = await takeRelayQuota(env, auth.keyHash, auth.entry); }
  catch { return json({ error: 'History relay is temporarily unavailable.' }, 503); }
  if (!quota.allowed) {
    return json({ error: 'This access key reached its daily history allowance.' }, 429);
  }
  const upstream = new URL(provider.url);
  const params = {
    module: 'logs',
    action: 'getLogs',
    ...query.fields,
    apikey: provider.secret,
  };
  params[provider.chainField] = query.chainId;
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
    return json({ error: `${provider.name} is temporarily unavailable.` }, 502);
  }
}

/** Copy only the anonymous, allowlisted telemetry shape. */
export function telemetryEvent(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('invalid telemetry event');
  }
  const allowedTop = new Set([
    'key', 'version', 'surface', 'outcome', 'positionBucket', 'durationBucket', 'errors',
  ]);
  if (Object.keys(payload).some((name) => !allowedTop.has(name))) {
    throw new Error('unsupported telemetry field');
  }
  const version = String(payload.version || '');
  const surface = String(payload.surface || '');
  const outcome = String(payload.outcome || '');
  const positionBucket = String(payload.positionBucket || '');
  const durationBucket = String(payload.durationBucket || '');
  if (!TELEMETRY_VERSION.test(version)
      || !TELEMETRY_SURFACES.has(surface)
      || !TELEMETRY_OUTCOMES.has(outcome)
      || !TELEMETRY_POSITION_BUCKETS.has(positionBucket)
      || !TELEMETRY_DURATION_BUCKETS.has(durationBucket)) {
    throw new Error('invalid telemetry event');
  }

  const rawErrors = payload.errors === undefined ? [] : payload.errors;
  if (!Array.isArray(rawErrors) || rawErrors.length > MAX_TELEMETRY_ERRORS) {
    throw new Error('invalid telemetry errors');
  }
  const merged = new Map();
  for (const row of rawErrors) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || Object.keys(row).some((name) => !['chain', 'code', 'count'].includes(name))) {
      throw new Error('invalid telemetry error');
    }
    const chain = String(row.chain || '');
    const code = String(row.code || '');
    const count = Number(row.count);
    if (!TELEMETRY_CHAINS.has(chain) || !TELEMETRY_ERROR_CODES.has(code)
        || !Number.isInteger(count) || count < 1 || count > 20) {
      throw new Error('invalid telemetry error');
    }
    const key = `${chain}:${code}`;
    merged.set(key, Math.min(20, (merged.get(key) || 0) + count));
  }
  const errors = [...merged.entries()].map(([key, count]) => {
    const [chain, code] = key.split(':');
    return { chain, code, count };
  });
  return { version, surface, outcome, positionBucket, durationBucket, errors };
}

async function telemetryRequest(payload, env) {
  const key = String(payload && payload.key != null ? payload.key : '').trim();
  if (!key) return json({ error: 'Access not granted.' }, 401);

  let auth;
  try { auth = await authorise(key, '', env); }
  catch { return json({ error: 'Access verification is temporarily unavailable.' }, 503); }
  if (!auth.valid) return json({ error: auth.reason || GENERIC }, 403);

  let event;
  try { event = telemetryEvent(payload); }
  catch (err) { return json({ error: err.message || 'Invalid telemetry event.' }, 400); }
  if (!env || !env.DB) return json({ error: 'Telemetry database is unavailable.' }, 503);

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const at = iso(now);
  try {
    await env.DB.prepare(`
      INSERT INTO scan_outcomes_daily
        (day, extension_version, surface, outcome, position_bucket, duration_bucket, scans, last_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)
      ON CONFLICT (day, extension_version, surface, outcome, position_bucket, duration_bucket)
      DO UPDATE SET scans = scans + 1, last_at = excluded.last_at
    `).bind(
      day, event.version, event.surface, event.outcome,
      event.positionBucket, event.durationBucket, at,
    ).run();
    for (const error of event.errors) {
      await env.DB.prepare(`
        INSERT INTO scan_errors_daily
          (day, extension_version, surface, chain_key, error_code, occurrences, last_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT (day, extension_version, surface, chain_key, error_code)
        DO UPDATE SET occurrences = occurrences + excluded.occurrences,
                      last_at = excluded.last_at
      `).bind(
        day, event.version, event.surface, error.chain, error.code, error.count, at,
      ).run();
    }
  } catch {
    return json({ error: 'Telemetry database is temporarily unavailable.' }, 503);
  }
  return json({ ok: true });
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
      return path === '/blockscout' || path === '/history' || path === '/telemetry'
        ? json({ error: 'Invalid request.' }, 400)
        : json({ valid: false, expires: null, reason: GENERIC }, 400);
    }

    if (path === '/') return validateRequest(payload, env);
    if (path === '/blockscout' || path === '/history') return relayRequest(payload, env);
    if (path === '/telemetry') return telemetryRequest(payload, env);
    return json({ error: 'Not found.' }, 404);
  },
};
