// JSON-RPC client. Runs from the popup (an extension page), so host_permissions
// in the manifest grant cross-origin access without a CORS preflight problem.
let nextId = 1;

/**
 * JSON-RPC methods this extension issues. All are reads — none can move a
 * token or sign anything. The options-page disclosure renders this list;
 * rpcCall refuses anything else, so a fourth method has to land here first
 * and the disclosure updates with it.
 */
export const RPC_METHODS = Object.freeze([
  'eth_call',
  'eth_getLogs',
  'eth_getBlockByNumber',
  'eth_getTransactionReceipt',
]);

export class RpcError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'RpcError';
    this.status = status;
    this.retryable = retryable;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RETRYABLE_HTTP = new Set([429, 502, 503, 504]);
const RPC_ATTEMPTS = 3;
const cooldownUntil = new Map();

function rpcOrigin(url) {
  try { return new URL(url).origin; }
  catch { return String(url); }
}

async function waitForCooldown(url) {
  const remaining = (cooldownUntil.get(rpcOrigin(url)) || 0) - Date.now();
  if (remaining > 0) await wait(remaining);
}

function retryDelay(res, attempt) {
  const header = res?.headers?.get?.('retry-after');
  if (header !== null && header !== undefined && header !== '') {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  return 750 * (2 ** attempt);
}

function extendCooldown(url, ms) {
  const origin = rpcOrigin(url);
  cooldownUntil.set(origin, Math.max(cooldownUntil.get(origin) || 0, Date.now() + ms));
}

const rateLimitMessage = (message) =>
  /rate.?limit|too many requests|public endpoint limit|capacity/i.test(String(message || ''));

export async function rpcCall(url, method, params) {
  if (!RPC_METHODS.includes(method)) {
    throw new RpcError(`${method}: not an issued JSON-RPC method`);
  }
  const payload = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params });
  let last = null;
  for (let attempt = 0; attempt < RPC_ATTEMPTS; attempt++) {
    await waitForCooldown(url);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
    } catch (err) {
      last = new RpcError(`${method}: ${err.message || String(err)}`, { retryable: true });
      if (attempt + 1 >= RPC_ATTEMPTS) throw last;
      extendCooldown(url, 750 * (2 ** attempt));
      continue;
    }

    let json = null;
    try { json = await res.json(); }
    catch { /* a non-JSON error still carries the HTTP status */ }

    if (!res.ok) {
      // The diagnosis is almost always in the body, not the status line: tier
      // limits, block-range caps and entitlement errors all arrive alongside a
      // 4xx. Preserve it while retrying only transient capacity responses.
      const detail = json?.error?.message ? ` — ${json.error.message}` : '';
      const retryable = RETRYABLE_HTTP.has(res.status);
      last = new RpcError(`${method}: HTTP ${res.status}${detail}`, {
        status: res.status, retryable,
      });
      if (!retryable || attempt + 1 >= RPC_ATTEMPTS) throw last;
      extendCooldown(url, retryDelay(res, attempt));
      continue;
    }

    if (!json) throw new RpcError(`${method}: malformed JSON response`);
    if (json.error) {
      const message = json.error.message || 'unknown JSON-RPC error';
      const retryable = rateLimitMessage(message);
      last = new RpcError(`${method}: ${message}`, { retryable });
      if (!retryable || attempt + 1 >= RPC_ATTEMPTS) throw last;
      extendCooldown(url, 750 * (2 ** attempt));
      continue;
    }
    return json.result;
  }
  throw last || new RpcError(`${method}: unavailable`);
}

/**
 * Batched read-only JSON-RPC. Every item is checked against the same method
 * allowlist as rpcCall; a per-item provider error is returned as `__error` so
 * callers can retry only the failed proof reads.
 */
export async function rpcBatch(url, requests) {
  for (const request of requests) {
    if (!RPC_METHODS.includes(request.method)) {
      throw new RpcError(`${request.method}: not an issued JSON-RPC method`);
    }
  }
  const payload = requests.map((request) => ({
    jsonrpc: '2.0', id: nextId++, method: request.method, params: request.params,
  }));
  const ids = payload.map((row) => row.id);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new RpcError(`batch: HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json)) throw new RpcError('batch: malformed response');
  const byId = new Map(json.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) return { __error: 'missing batch response' };
    if (row.error) return { __error: row.error.message || 'batch item failed' };
    return row.result;
  });
}

/**
 * eth_call. `from` matters for the collect() staticcall. An explicit `block`
 * remains supported for callers that need exact state, but historical USD
 * prices deliberately use Swap events: some RPCs silently answer an old-block
 * eth_call with latest state.
 */
export function ethCall(url, to, data, from, block = 'latest') {
  const tx = { to, data: data.startsWith('0x') ? data : '0x' + data };
  if (from) tx.from = from;
  return rpcCall(url, 'eth_call', [tx, block]);
}

export function ethCallBatch(url, calls) {
  return rpcBatch(url, calls.map(({ to, data, from, block = 'latest' }) => {
    const tx = { to, data: data.startsWith('0x') ? data : '0x' + data };
    if (from) tx.from = from;
    return { method: 'eth_call', params: [tx, block] };
  }));
}

/** Bounded-concurrency map. Public RPCs rate-limit aggressively. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        out[i] = { __error: err.message || String(err) };
      }
    }
  });
  await Promise.all(workers);
  return out;
}
