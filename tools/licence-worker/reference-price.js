/** Fixed Ethereum reference proof. Not a generic RPC/explorer proxy. */
import {
  ETH_REFERENCE, referenceQuery, referenceHeader, referenceProofPrice,
} from '../../extension/lib/reference-proof.js';

const RPC_URL = 'https://api.blockscout.com/1/json-rpc';
const TIME_URL = 'https://api.blockscout.com/v2/api';
const HASH = /^0x[0-9a-fA-F]{64}$/;
let upstreamQueue = Promise.resolve();
let lastCallAt = 0;
let active = 0;

/** Strict API fields: no pool, topic, method, URL or arbitrary query params. */
export function priceQuery(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const names = Object.keys(payload);
  if (names.length !== 4 || !['key', 'installationId', 'chainId'].every((k) => names.includes(k))
      || names.some((k) => !['key', 'installationId', 'chainId', 'block', 'timestamp'].includes(k))
      || typeof payload.key !== 'string' || typeof payload.installationId !== 'string'
      || payload.chainId !== '1') return null;
  return referenceQuery(Object.hasOwn(payload, 'block')
    ? { block: payload.block } : { timestamp: payload.timestamp });
}

async function boundedJson(response) {
  if (!response.ok) {
    const error = new Error('provider');
    error.priceCode = response.status >= 300 && response.status < 400 ? 'provider-redirect'
      : response.status === 429 ? 'provider-rate-limit'
      : response.status === 401 || response.status === 403 ? 'provider-access'
      : 'provider-http';
    throw error;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) throw new Error('oversize');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { const error = new Error('provider JSON'); error.priceCode = 'provider-json'; throw error; }
}

function logNumber(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) return NaN;
  const result = Number(BigInt(value));
  return Number.isSafeInteger(result) && result >= 0 ? result : NaN;
}

function cleanLog(log, from, to) {
  if (!log || typeof log !== 'object' || Array.isArray(log)
      || String(log.address).toLowerCase() !== ETH_REFERENCE.pool
      || log.removed !== false || !Array.isArray(log.topics) || log.topics.length !== 3
      || log.topics[0]?.toLowerCase() !== ETH_REFERENCE.topic
      || !log.topics.every((t) => typeof t === 'string' && HASH.test(t))
      || typeof log.data !== 'string' || !/^0x[0-9a-fA-F]{320}$/.test(log.data)
      || typeof log.blockHash !== 'string' || !HASH.test(log.blockHash)
      || typeof log.transactionHash !== 'string' || !HASH.test(log.transactionHash)) {
    throw new Error('invalid log');
  }
  const blockNumber = logNumber(log.blockNumber), logIndex = logNumber(log.logIndex);
  if (!Number.isSafeInteger(blockNumber) || blockNumber < from || blockNumber > to
      || !Number.isSafeInteger(logIndex)) throw new Error('invalid log identity');
  return {
    blockNumber, blockHash: log.blockHash.toLowerCase(), logIndex,
    transactionHash: log.transactionHash.toLowerCase(),
    sqrtPriceX96: BigInt('0x' + log.data.slice(130, 194)).toString(),
  };
}

/** At most 14 individually quota-charged upstream calls, 22 seconds total. */
export async function resolveReferenceProof(query, { secret, beforeFetch }) {
  if (!referenceQuery(query) || !secret || active >= 12) throw new Error('unavailable');
  if (query.timestamp && query.timestamp > Math.floor(Date.now() / 1000) - 120) return null;
  active++;
  const deadline = Date.now() + 22_000;
  let calls = 0;
  let phase = 'time';
  const request = (url, init = {}) => {
    const perform = async () => {
      if (++calls > 14 || Date.now() >= deadline) throw new Error('bounded');
      const delay = 250 - (Date.now() - lastCallAt);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      if (Date.now() >= deadline) throw new Error('bounded');
      await beforeFetch(); // every provider request, including failed ones
      lastCallAt = Date.now();
      let response;
      try {
        response = await fetch(url, {
          // Workers compatibility differs from browser fetch. Inspect and
          // reject 3xx explicitly; never forward the provider credential.
          ...init, redirect: 'manual',
          signal: AbortSignal.timeout(Math.max(1, Math.min(6000, deadline - Date.now()))),
        });
      } catch (error) {
        if (/different request|outside.*request/i.test(String(error?.message))) error.priceCode = 'runtime-request-context';
        else if (error?.name === 'TypeError') error.priceCode = 'provider-transport';
        throw error;
      }
      return boundedJson(response);
    };
    const task = upstreamQueue.then(perform, perform);
    upstreamQueue = task.catch(() => null);
    return task;
  };
  const rpc = async (method, params) => {
    const body = await request(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!body || body.jsonrpc !== '2.0' || body.id !== 1 || Object.hasOwn(body, 'error')) {
      const error = new Error('invalid RPC'); error.priceCode = 'provider-rpc'; throw error;
    }
    return body.result;
  };
  const headerAt = async (number) => {
    const header = referenceHeader(await rpc('eth_getBlockByNumber',
      ['0x' + number.toString(16), false]), number);
    if (!header) throw new Error('invalid header');
    return header;
  };
  try {
    let blockNumber = query.block;
    if (query.timestamp) {
      const url = new URL(TIME_URL);
      for (const [key, value] of Object.entries({ chain_id: '1', module: 'block',
        action: 'getblocknobytime', timestamp: String(query.timestamp), closest: 'before', apikey: secret })) {
        url.searchParams.set(key, value);
      }
      const body = await request(url, { headers: { Accept: 'application/json' } });
      const raw = body?.result?.blockNumber ?? body?.result;
      if (body?.status !== '1' || typeof raw !== 'string' || !/^[1-9][0-9]{0,9}$/.test(raw)) {
        const error = new Error('invalid time mapping'); error.priceCode = 'provider-time-response'; throw error;
      }
      blockNumber = Number(raw);
    }
    phase = 'header';
    const block = await headerAt(blockNumber);
    if (block.timestamp > Math.floor(Date.now() / 1000) - 120) return null;
    const nextBlock = query.timestamp ? await headerAt(blockNumber + 1) : null;
    if (nextBlock && (nextBlock.parentHash !== block.hash || block.timestamp > query.timestamp
        || nextBlock.timestamp <= query.timestamp)) return null;

    phase = 'logs';
    let chosen = null;
    // Expand only after complete empty windows. A saturated window is narrowed
    // towards the target, never used as a truncated "last" event. Any refused
    // newer interval stops this route; never skip a gap to return an older swap.
    for (const span of [64, 256, 1024, ETH_REFERENCE.maxLookback]) {
      let from = Math.max(1, blockNumber - span + 1);
      while (true) {
        const rows = await rpc('eth_getLogs', [{ address: ETH_REFERENCE.pool,
          fromBlock: '0x' + from.toString(16), toBlock: '0x' + blockNumber.toString(16),
          topics: [ETH_REFERENCE.topic] }]);
        if (!Array.isArray(rows) || rows.length > 1000) throw new Error('invalid logs');
        if (rows.length === 1000) {
          if (from === blockNumber) return null;
          from = Math.floor((from + blockNumber + 1) / 2);
          continue;
        }
        const logs = rows.map((row) => cleanLog(row, from, blockNumber));
        const identities = new Set(logs.map((l) => `${l.blockNumber}:${l.logIndex}`));
        if (identities.size !== logs.length) throw new Error('duplicate logs');
        logs.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
        chosen = logs[0] || null;
        // Saturation followed by an empty newest interval is ambiguous without
        // paging the older part. Withhold rather than expanding past that gap.
        if (!chosen && from !== Math.max(1, blockNumber - span + 1)) return null;
        break;
      }
      if (chosen) break;
    }
    if (!chosen) return null;
    phase = 'swap-header';
    const swapBlock = chosen.blockNumber === blockNumber ? block : await headerAt(chosen.blockNumber);
    const proof = { v: 1, chainId: '1', pool: ETH_REFERENCE.pool, block,
      nextBlock, swapBlock, swap: chosen };
    return referenceProofPrice(proof, query) === null ? null : proof;
  } catch (error) {
    if (!error.priceCode) {
      error.priceCode = /different request|outside.*request/i.test(String(error?.message))
        ? 'runtime-request-context' : error?.name === 'TypeError' ? 'runtime-type-error'
        : error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'provider-timeout' : `reference-${phase}-unavailable`;
    }
    throw error;
  } finally { active--; }
}

/** Closed diagnostic vocabulary. No provider text, paths, identifiers or keys. */
export function priceFailureCode(error) {
  return new Set(['provider-rate-limit', 'provider-access', 'provider-http', 'provider-timeout', 'provider-redirect',
    'provider-json', 'provider-rpc', 'provider-transport', 'provider-time-response',
    'runtime-type-error', 'runtime-request-context',
    'reference-time-unavailable', 'reference-header-unavailable', 'reference-logs-unavailable',
    'reference-swap-header-unavailable']).has(error?.priceCode)
    ? error.priceCode : 'reference-unavailable';
}
