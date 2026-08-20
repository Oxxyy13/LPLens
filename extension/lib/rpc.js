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
]);

export class RpcError extends Error {}

export async function rpcCall(url, method, params) {
  if (!RPC_METHODS.includes(method)) {
    throw new RpcError(`${method}: not an issued JSON-RPC method`);
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  if (!res.ok) {
    // The diagnosis is almost always in the body, not the status line: tier
    // limits, block-range caps and entitlement errors all arrive as a normal
    // JSON-RPC error alongside a 4xx. Throwing the bare status discards it.
    let detail = '';
    try {
      const body = await res.json();
      if (body && body.error && body.error.message) detail = ` — ${body.error.message}`;
    } catch { /* non-JSON body; the status is all we have */ }
    throw new RpcError(`${method}: HTTP ${res.status}${detail}`);
  }
  const json = await res.json();
  if (json.error) throw new RpcError(`${method}: ${json.error.message}`);
  return json.result;
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
 * eth_call. `from` matters for the collect() staticcall; `block` enables
 * archive reads, which is how historical USD prices are derived from a
 * reference pool's past state.
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
