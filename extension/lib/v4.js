/**
 * Uniswap v4 position reading.
 *
 * v4 differs from v3 in four ways that matter to a reader, and every one of
 * them was verified live on Robinhood Chain (2026-08-18) rather than assumed:
 *
 *  1. NO POOL CONTRACTS. All pools live in one singleton PoolManager and are
 *     addressed by `poolId = keccak256(abi.encode(PoolKey))`. v3 could ask
 *     `factory.getPool()`; v4 expects the caller to hash. Hence lib/keccak.js.
 *  2. THE POSITION MANAGER IS NOT ERC721Enumerable. `supportsInterface`
 *     returns false, so `tokenOfOwnerByIndex` — the whole basis of the v3 scan
 *     — does not exist. Positions are enumerated from `Transfer` logs instead,
 *     which works because ERC-721 indexes `tokenId` as topic3.
 *  3. STATE IS READ THROUGH StateView, a separate view contract, not from the
 *     pool.
 *  4. CURRENCIES MAY BE NATIVE. `address(0)` means the chain's native coin,
 *     which has no ERC-20 to ask for `symbol()` or `decimals()`.
 *
 * Two independent cross-checks guard the derivation, both confirmed on-chain:
 * the top 200 bits of the derived poolId must equal the truncated id that v4
 * stores separately in PositionInfo, and StateView's liquidity for the position
 * must equal the PositionManager's. Either mismatching means the poolId, the
 * ticks or the salt is wrong, and both would otherwise fail silently as zeros.
 *
 * v4 lifetime history is intentionally narrower than v3. PoolManager
 * `ModifyLiquidity` identifies an NFT with poolId + PositionManager +
 * `salt == bytes32(tokenId)`, but does not emit token amounts. For a mint the
 * receipt proves the principal directly. For later, simple additions LPLens
 * reads Blockscout's execution trace: PoolManager's exact return separates the
 * principal delta from fees accrued before PositionManager nets them together.
 * Removes, hooks and bundled actions remain fail-closed instead of turning
 * settlement transfers into invented proceeds.
 */
import { ethCall, ethCallBatch, mapLimit, rpcCall } from './rpc.js';
import {
  words, toUint, toInt, toAddress, padWord, encAddress, encUint, dataOwnerOf,
} from './abi.js';
import { keccak256Hex } from './keccak.js';
import {
  positionAmounts, humanPrice, tickToPrice, scale, sqrtRatioAtTick,
} from './v3.js';
import { CHAINS } from './chains.js';
import {
  fetchBlockCheckpoint, fetchFilteredLogs, fetchRecentFilteredLogs, fetchTokenTransfersRpc,
  fetchTransfers,
} from './logs.js';
import {
  readV4OwnershipCheckpoint, writeV4OwnershipCheckpoint,
} from './v4-ownership-cache.js';

// Selectors derived with keccak256 and cross-checked against the in-production
// `PortfolioManager/scripts/robinhood_chain_lp.py`, which pins the same values.
export const V4 = {
  poolAndPositionInfo: '0x7ba03aad',  // getPoolAndPositionInfo(uint256)
  positionLiquidity: '0x1efeed33',    // getPositionLiquidity(uint256)
  getSlot0: '0xc815641c',             // getSlot0(bytes32)
  getPositionInfo: '0xdacf1d2f',      // getPositionInfo(bytes32,address,int24,int24,bytes32)
  getFeeGrowthInside: '0x53e9c1fb',   // getFeeGrowthInside(bytes32,int24,int24)
  balanceOf: '0x70a08231',
};

export const V4_TOPIC = Object.freeze({
  modifyLiquidity: '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec',
  modifyPosition: '0x54e5dca345d804c4bcfd2d92dae077325838444a21d118beb4d25ec99a5788e5',
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
});

const Q128 = 1n << 128n;
const MAX256 = 1n << 256n;
const v4PoolLogCache = new Map();
const v4TraceCache = new Map();
const v4ReceiptCache = new Map();
const V4_TRACE_CACHE_MAX = 200;
const V4_RECEIPT_CACHE_MAX = 400;
const V4_RECEIPT_TTL_MS = 60_000;
const MAX_SIMPLE_V4_ADDS = 20;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MODIFY_LIQUIDITY_SELECTOR = '0x5a6bcfda';
const TRANSACTION_HASH_RE = /^0x[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const ADDRESS_TOPIC_RE = /^0x0{24}[0-9a-f]{40}$/;
const HEX_DATA_RE = /^0x(?:[0-9a-f]{2})*$/;
const PERMIT2_ADDRESS = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const PERMIT2_PERMIT_TOPIC =
  '0xc6a377bfc4eb120024a8ac08eef205be16b817020812c73223e81d1bdb9708ec';
const UINT160_MAX = (1n << 160n) - 1n;
const UINT48_MAX = (1n << 48n) - 1n;
const MAX_V4_RECEIPT_PAGES = 10;
const MAX_V4_RECEIPT_LOGS = 200;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function retryRead(fn, attempts = 4) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await fn(); }
    catch (err) {
      last = err;
      if (attempt + 1 < attempts) {
        const throttled = /429|rate|capacity/i.test(err.message || String(err));
        await wait((throttled ? 2000 : 200) * (attempt + 1));
      }
    }
  }
  throw last;
}

/** Share only an active pool-history read; completed snapshots are never reused. */
export function coalesceV4PoolLogTask(cacheKey, fromBlock, load) {
  let cached = v4PoolLogCache.get(cacheKey);
  if (!cached || !Number.isSafeInteger(cached.fromBlock)
      || cached.fromBlock > fromBlock) {
    const task = Promise.resolve().then(load);
    cached = { fromBlock, task };
    v4PoolLogCache.set(cacheKey, cached);
    const evict = () => {
      if (v4PoolLogCache.get(cacheKey)?.task === task) v4PoolLogCache.delete(cacheKey);
    };
    task.then(evict, evict);
    if (v4PoolLogCache.size > 100) {
      for (const key of [...v4PoolLogCache.keys()].slice(0, v4PoolLogCache.size - 100)) {
        v4PoolLogCache.delete(key);
      }
    }
  }
  return cached.task;
}

function cleanTransactionHash(value) {
  const hash = String(value || '').trim().toLowerCase();
  return TRANSACTION_HASH_RE.test(hash) ? hash : null;
}

function cleanAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  return ADDRESS_RE.test(address) ? address : null;
}

function receiptResult(value, transactionHash) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || cleanTransactionHash(value.transactionHash) !== transactionHash
      || value.status !== '0x1'
      || !Array.isArray(value.logs)) {
    throw new Error('receipt response did not match the requested transaction');
  }
  return value;
}

async function hostedV4Receipt(relay, chainId, transactionHash) {
  const receiptUrl = String(relay?.receiptUrl || '').trim();
  const key = String(relay?.key || '').trim();
  const installationId = String(relay?.installationId || '').trim();
  if (!receiptUrl || !key || !installationId || !chainId) {
    throw new Error('hosted receipt relay is not configured');
  }

  let response;
  try {
    response = await fetch(receiptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key,
        installationId,
        chainId: String(chainId),
        transactionHash,
      }),
    });
  } catch (err) {
    throw new Error(err.message || String(err));
  }
  let body = null;
  try { body = await response.json(); } catch { /* handled below */ }
  if (!response.ok) {
    throw new Error(body && (body.error || body.reason)
      ? String(body.error || body.reason) : `HTTP ${response.status}`);
  }
  return receiptResult(body?.result, transactionHash);
}

async function blockscoutReceiptJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('malformed response');
    }
    return body;
  } finally { clearTimeout(timer); }
}

function blockscoutReceiptCursor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('malformed log pagination');
  }
  const allowed = new Set(['index', 'items_count', 'block_number']);
  const entries = Object.entries(value);
  if (!entries.length || entries.some(([key, raw]) => {
    const number = Number(raw);
    return !allowed.has(key) || !/^\d+$/.test(String(raw))
      || !Number.isSafeInteger(number) || number < 0;
  })) {
    throw new Error('malformed log pagination');
  }
  return Object.fromEntries(entries.map(([key, raw]) => [key, String(raw)]));
}

async function publicBlockscoutV4Receipt(chain, transactionHash) {
  const base = blockscoutV2(chain || {});
  if (!base) throw new Error('Blockscout receipt REST is not configured');
  const transactionUrl = `${base}/transactions/${transactionHash}`;
  const transaction = await blockscoutReceiptJson(transactionUrl);
  const from = cleanAddress(transaction.from?.hash);
  const to = cleanAddress(transaction.to?.hash);
  const blockNumber = Number(transaction.block_number);
  if (cleanTransactionHash(transaction.hash) !== transactionHash
      || transaction.status !== 'ok' || transaction.result !== 'success'
      || !from || !to || !Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error('transaction metadata did not prove a successful receipt');
  }

  const logs = [];
  const indexes = new Set();
  const cursors = new Set();
  let logUrl = `${transactionUrl}/logs`;
  for (let page = 0; page < MAX_V4_RECEIPT_PAGES; page++) {
    const body = await blockscoutReceiptJson(logUrl);
    if (!Array.isArray(body.items)
        || !Object.prototype.hasOwnProperty.call(body, 'next_page_params')) {
      throw new Error('transaction logs response may be incomplete');
    }
    for (const item of body.items) {
      const address = cleanAddress(item?.address?.hash || item?.address_hash?.hash);
      const itemHash = cleanTransactionHash(item?.transaction_hash);
      const topics = Array.isArray(item?.topics) ? [...item.topics] : null;
      while (topics?.length && topics[topics.length - 1] === null) topics.pop();
      const normalisedTopics = topics
        ? topics.map((topic) => String(topic || '').toLowerCase()) : null;
      const data = String(item?.data || '').toLowerCase();
      const index = Number(item?.index);
      if (!address || itemHash !== transactionHash || !normalisedTopics
          || normalisedTopics.length > 4
          || normalisedTopics.some((topic) => !TRANSACTION_HASH_RE.test(topic))
          || !HEX_DATA_RE.test(data) || !Number.isSafeInteger(index) || index < 0
          || indexes.has(index) || Number(item?.block_number) !== blockNumber) {
        throw new Error('transaction logs did not match the requested receipt');
      }
      indexes.add(index);
      logs.push({
        address,
        transactionHash: itemHash,
        logIndex: '0x' + index.toString(16),
        topics: normalisedTopics,
        data,
      });
      if (logs.length > MAX_V4_RECEIPT_LOGS) {
        throw new Error('transaction receipt exceeds the safe log limit');
      }
    }
    if (body.next_page_params === null) {
      logs.sort((a, b) => Number.parseInt(a.logIndex, 16) - Number.parseInt(b.logIndex, 16));
      return receiptResult({
        transactionHash,
        status: '0x1',
        from,
        to,
        blockNumber: '0x' + blockNumber.toString(16),
        logs,
      }, transactionHash);
    }
    const cursor = blockscoutReceiptCursor(body.next_page_params);
    const cursorKey = JSON.stringify(Object.entries(cursor).sort());
    if (cursors.has(cursorKey)) throw new Error('transaction log pagination repeated');
    cursors.add(cursorKey);
    const next = new URL(`${transactionUrl}/logs`);
    for (const [key, value] of Object.entries(cursor)) next.searchParams.set(key, value);
    logUrl = next.href;
  }
  throw new Error('transaction log pagination exceeded the safe page limit');
}

/**
 * Read an immutable v4 addition receipt. The chain RPC remains first choice,
 * followed by the chain's public Blockscout REST API. Licensed Robinhood reads
 * can use the authenticated, contract-allowlisted receipt relay as the final
 * fallback without exposing the shared Blockscout credential in this public
 * extension.
 */
export async function fetchV4Receipt(rpc, chain, transactionHash, opts = {}) {
  const hash = cleanTransactionHash(transactionHash);
  if (!hash) throw new Error('invalid v4 addition transaction hash');
  const relay = opts.historyRelay || opts.blockscoutRelay || null;
  const relayChainId = chain?.receiptRelayChainId || null;
  const receiptExplorer = blockscoutV2(chain || {});
  const cacheKey = [rpc, receiptExplorer || '-', relayChainId || '-',
    relay?.receiptUrl ? 'h' : '-', hash].join('|');
  const now = Date.now();
  const cached = v4ReceiptCache.get(cacheKey);
  if (cached && now - cached.at <= V4_RECEIPT_TTL_MS) return cached.task;

  const task = (async () => {
    const errors = [];
    try {
      const receipt = await rpcCall(rpc, 'eth_getTransactionReceipt', [hash]);
      return receiptResult(receipt, hash);
    } catch (err) {
      errors.push(err.message || String(err));
    }
    if (receiptExplorer) {
      try {
        return await publicBlockscoutV4Receipt(chain, hash);
      } catch (err) {
        errors.push(`public Blockscout receipt fallback: ${err.message || String(err)}`);
      }
    }
    if (!relay || !relayChainId) throw new Error(errors.join('; '));
    try {
      return await hostedV4Receipt(relay, relayChainId, hash);
    } catch (fallbackError) {
      errors.push(`hosted receipt fallback: ${fallbackError.message || String(fallbackError)}`);
      throw new Error(errors.join('; '));
    }
  })();
  v4ReceiptCache.set(cacheKey, { at: now, task });
  task.catch(() => {
    if (v4ReceiptCache.get(cacheKey)?.task === task) v4ReceiptCache.delete(cacheKey);
  });
  if (v4ReceiptCache.size > V4_RECEIPT_CACHE_MAX) {
    for (const old of [...v4ReceiptCache.keys()]
      .slice(0, v4ReceiptCache.size - V4_RECEIPT_CACHE_MAX)) v4ReceiptCache.delete(old);
  }
  return task;
}

/** ABI int24: sign-extended across the full 256-bit word, not masked to 24 bits. */
const encInt = (v) => padWord(BigInt(v) < 0n ? MAX256 + BigInt(v) : BigInt(v));

/** int24 packed inside a larger value. */
const s24 = (v) => (v >= 0x800000n ? v - 0x1000000n : v);

/**
 * Decode `getPoolAndPositionInfo`.
 *
 * PositionInfo packs, from the most significant bit:
 *   200 bits poolId | 24 bits tickUpper | 24 bits tickLower | 8 bits subscriber
 */
export function decodeV4Position(hex) {
  const w = words(hex);
  if (w.length < 6) return null;

  const info = toUint(w[5]);
  return {
    currency0: toAddress(w[0]),
    currency1: toAddress(w[1]),
    fee: Number(toUint(w[2])),
    tickSpacing: Number(toInt(w[3])),
    hooks: toAddress(w[4]),
    tickLower: Number(s24((info >> 8n) & 0xffffffn)),
    tickUpper: Number(s24((info >> 32n) & 0xffffffn)),
    // The poolId truncated to its top 200 bits — kept purely to verify the
    // hash we derive below.
    truncatedPoolId: info >> 56n,
    poolKeyWords: w.slice(0, 5),
  };
}

/** poolId = keccak256(abi.encode(PoolKey)); the 5 words are already ABI-encoded. */
export function poolIdOf(poolKeyWords) {
  return keccak256Hex('0x' + poolKeyWords.join(''));
}

/** Native currency is address(0) and has no ERC-20 to interrogate. */
const isNative = (addr) => /^0x0{40}$/i.test(addr);

const dataWord = (data, index) => {
  const body = String(data || '').replace(/^0x/, '');
  const word = body.slice(index * 64, (index + 1) * 64);
  return word.length === 64 ? BigInt('0x' + word) : null;
};
const signed256 = (value) => value >= (1n << 255n) ? value - (1n << 256n) : value;
const addressTopic = (address) =>
  '0x' + String(address).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const logId = (log) => `${String(log.transactionHash || '').toLowerCase()}:${log.logIndex}`;

/** Decode and select the PoolManager events whose non-indexed salt is tokenId. */
export function decodeV4LiquidityLogs(logs, {
  poolId, positionManager, tokenId, tickLower, tickUpper,
}) {
  const wantPool = String(poolId).toLowerCase();
  const wantManager = addressTopic(positionManager);
  const wantToken = BigInt(tokenId);
  const events = [];
  for (const log of logs || []) {
    if (String(log.topics?.[0] || '').toLowerCase() !== V4_TOPIC.modifyLiquidity) continue;
    if (String(log.topics?.[1] || '').toLowerCase() !== wantPool) continue;
    if (String(log.topics?.[2] || '').toLowerCase() !== wantManager) continue;
    const lowerWord = dataWord(log.data, 0);
    const upperWord = dataWord(log.data, 1);
    const deltaWord = dataWord(log.data, 2);
    const salt = dataWord(log.data, 3);
    if ([lowerWord, upperWord, deltaWord, salt].some((value) => value === null)) continue;
    if (salt !== wantToken) continue;
    const lower = Number(signed256(lowerWord));
    const upper = Number(signed256(upperWord));
    if (lower !== tickLower || upper !== tickUpper) continue;
    events.push({
      block: log.block,
      time: log.time,
      transactionHash: log.transactionHash || null,
      logIndex: log.logIndex ?? null,
      poolId: wantPool,
      positionManager: String(positionManager).toLowerCase(),
      tickLower: lower,
      tickUpper: upper,
      liquidityDelta: signed256(deltaWord),
      tokenId: salt,
    });
  }
  return events.sort((a, b) =>
    (a.block - b.block) || ((a.logIndex ?? 0) - (b.logIndex ?? 0)));
}

const callDataWord = (input, index) => {
  const body = String(input || '').replace(/^0x/, '');
  const word = body.slice(8 + index * 64, 8 + (index + 1) * 64);
  return word.length === 64 ? BigInt('0x' + word) : null;
};

const signed128 = (value) => value >= (1n << 127n) ? value - (1n << 128n) : value;
const decodeBalanceDelta = (word) => ({
  amount0: signed128(word >> 128n),
  amount1: signed128(word & ((1n << 128n) - 1n)),
});

function proveAmounts({ liquidity, raw0, raw1, tickLower, tickUpper, decimals0, decimals1 }) {
  const fail = (unavailable) => ({ unavailable });
  const L = Number(liquidity);
  const sqrtA = sqrtRatioAtTick(tickLower);
  const sqrtB = sqrtRatioAtTick(tickUpper);
  let sqrtP;

  if (raw0 === null) {
    if (!(raw1 > 0)) return fail('the native mint amount cannot be isolated');
    sqrtP = sqrtA + raw1 / L;
    raw0 = L * (sqrtB - sqrtP) / (sqrtP * sqrtB);
  } else if (raw1 === null) {
    if (!(raw0 > 0)) return fail('the native mint amount cannot be isolated');
    sqrtP = 1 / (1 / sqrtB + raw0 / L);
    raw1 = L * (sqrtP - sqrtA);
  } else if (raw0 > 0 && raw1 > 0) {
    const from1 = sqrtA + raw1 / L;
    const from0 = 1 / (1 / sqrtB + raw0 / L);
    const spread = Math.abs(from1 - from0) / from1;
    if (spread > 1e-6) return fail('the settlement transfers do not match the liquidity delta');
    sqrtP = (from0 + from1) / 2;
  } else if (raw0 === 0 && raw1 > 0) {
    sqrtP = sqrtB;
  } else if (raw1 === 0 && raw0 > 0) {
    sqrtP = sqrtA;
  } else {
    return fail('the mint receipt contains no token settlement');
  }

  const epsilon = 1e-9;
  if (!Number.isFinite(sqrtP) || sqrtP < sqrtA * (1 - epsilon)
      || sqrtP > sqrtB * (1 + epsilon) || raw0 < 0 || raw1 < 0) {
    return fail('the proved mint amounts fall outside the position range');
  }
  const exactPrice = raw0 > 0 && raw1 > 0;
  return {
    amount0: scale(raw0, decimals0),
    amount1: scale(raw1, decimals1),
    entry: {
      sqrtP,
      price: sqrtP * sqrtP * Math.pow(10, decimals0 - decimals1),
      exact: exactPrice,
      ...(exactPrice ? {} : { bound: raw0 === 0 ? 'at or above' : 'at or below' }),
    },
  };
}

/**
 * Prove that a receipt contains only one simple action for this v4 NFT.
 *
 * Newer PositionManagers mirror PoolManager's event as `ModifyPosition`; older
 * deployments do not. Both shapes are accepted, but every emitted action and
 * currency transfer must still belong to this exact pool and token id.
 */
export function validateSimpleV4Receipt({
  event, receipt, poolManager, positionManager, token0, token1, expectMint,
}) {
  const fail = (unavailable) => ({ unavailable });
  if (!event || !event.transactionHash || event.liquidityDelta <= 0n) {
    return fail('the v4 addition event is invalid');
  }
  if (!receipt || receipt.status !== '0x1' || !Array.isArray(receipt.logs)) {
    return fail('the v4 addition receipt is unavailable');
  }

  const pm = String(positionManager).toLowerCase();
  const manager = String(poolManager).toLowerCase();
  const managerTopic = addressTopic(manager);
  const tokenIdTopic = '0x' + BigInt(event.tokenId).toString(16).padStart(64, '0');
  const zeroTopic = '0x' + '0'.repeat(64);
  let mintCount = 0, modifyCount = 0, mirrorCount = 0;
  let mintOwnerTopic = null;
  const tokenAddresses = [token0, token1].map((token) => String(token).toLowerCase());
  const incoming = [0n, 0n];
  const incomingOwnerTopics = [null, null];
  const permits = [null, null];

  for (const log of receipt.logs) {
    const address = String(log.address || '').toLowerCase();
    const topic0 = String(log.topics?.[0] || '').toLowerCase();
    if (address === manager && topic0 === V4_TOPIC.modifyLiquidity) {
      modifyCount++;
      const lower = dataWord(log.data, 0), upper = dataWord(log.data, 1);
      const delta = dataWord(log.data, 2), salt = dataWord(log.data, 3);
      if (String(log.transactionHash || receipt.transactionHash || '').toLowerCase()
            !== String(event.transactionHash).toLowerCase()
          || String(log.topics?.[1] || '').toLowerCase() !== event.poolId
          || String(log.topics?.[2] || '').toLowerCase() !== addressTopic(positionManager)
          || lower === null || Number(signed256(lower)) !== event.tickLower
          || upper === null || Number(signed256(upper)) !== event.tickUpper
          || delta === null || signed256(delta) !== event.liquidityDelta
          || salt !== BigInt(event.tokenId)) {
        return fail('the transaction modified another v4 position');
      }
      continue;
    }
    if (address === pm && topic0 === V4_TOPIC.modifyPosition) {
      mirrorCount++;
      const lower = dataWord(log.data, 0), upper = dataWord(log.data, 1);
      const delta = dataWord(log.data, 2), salt = dataWord(log.data, 3);
      if (String(log.topics?.[1] || '').toLowerCase() !== event.poolId
          || lower === null || Number(signed256(lower)) !== event.tickLower
          || upper === null || Number(signed256(upper)) !== event.tickUpper
          || delta === null || signed256(delta) !== event.liquidityDelta
          || salt !== BigInt(event.tokenId)) {
        return fail('the PositionManager mirrored another v4 action');
      }
      continue;
    }
    if (address === pm && topic0 === V4_TOPIC.transfer
        && String(log.topics?.[1] || '').toLowerCase() === zeroTopic
        && String(log.topics?.[3] || '').toLowerCase() === tokenIdTopic) {
      const ownerTopic = String(log.topics?.[2] || '').toLowerCase();
      if (!ADDRESS_TOPIC_RE.test(ownerTopic)) {
        return fail('the v4 mint recipient is invalid');
      }
      if (mintOwnerTopic && mintOwnerTopic !== ownerTopic) {
        return fail('the receipt minted the v4 NFT to multiple recipients');
      }
      mintOwnerTopic = ownerTopic;
      mintCount++;
      continue;
    }
    if (address === PERMIT2_ADDRESS && topic0 === PERMIT2_PERMIT_TOPIC) {
      const topics = Array.isArray(log.topics) ? log.topics.map((topic) =>
        String(topic || '').toLowerCase()) : [];
      const ownerTopic = topics[1] || '';
      const tokenTopic = topics[2] || '';
      const spenderTopic = topics[3] || '';
      const side = tokenAddresses.findIndex((token) =>
        !isNative(token) && tokenTopic === addressTopic(token));
      const amount = dataWord(log.data, 0);
      const expiration = dataWord(log.data, 1);
      const nonce = dataWord(log.data, 2);
      if (!expectMint
          || String(log.transactionHash || '').toLowerCase()
            !== String(event.transactionHash).toLowerCase()
          || topics.length !== 4 || !ADDRESS_TOPIC_RE.test(ownerTopic)
          || side < 0 || spenderTopic !== addressTopic(positionManager)
          || !/^0x[0-9a-fA-F]{192}$/.test(String(log.data || ''))
          || amount === null || amount <= 0n || amount > UINT160_MAX
          || expiration === null || expiration > UINT48_MAX
          || nonce === null || nonce > UINT48_MAX || permits[side]) {
        return fail('the receipt contains an unrelated Permit2 authorization');
      }
      permits[side] = { ownerTopic, amount };
      continue;
    }
    const side = tokenAddresses.findIndex((token) => token === address && !isNative(token));
    if (side >= 0 && topic0 === V4_TOPIC.transfer) {
      const to = String(log.topics?.[2] || '').toLowerCase();
      const from = String(log.topics?.[1] || '').toLowerCase();
      const amount = dataWord(log.data, 0);
      if (amount === null || (to !== managerTopic && from !== managerTopic) || to === from) {
        return fail('the receipt contains a non-settlement token transfer');
      }
      if (expectMint && from === managerTopic) {
        return fail('the mint receipt contains an outgoing token transfer');
      }
      if (to === managerTopic) {
        if (!ADDRESS_TOPIC_RE.test(from)
            || (incomingOwnerTopics[side] && incomingOwnerTopics[side] !== from)) {
          return fail('the receipt contains settlement from multiple owners');
        }
        incomingOwnerTopics[side] = from;
        incoming[side] += amount;
      }
      continue;
    }
    return fail('the v4 addition receipt contains additional actions');
  }
  if (modifyCount !== 1 || mirrorCount > 1 || mintCount !== (expectMint ? 1 : 0)) {
    return fail(expectMint
      ? 'the receipt does not prove one NFT mint and one liquidity addition'
      : 'the receipt does not prove one isolated liquidity addition');
  }
  for (let side = 0; side < permits.length; side++) {
    const permit = permits[side];
    if (!permit) continue;
    const receiptFrom = cleanAddress(receipt.from);
    const receiptTo = cleanAddress(receipt.to);
    if (!receiptFrom || receiptTo !== pm || mintOwnerTopic !== addressTopic(receiptFrom)
        || incoming[side] <= 0n || incomingOwnerTopics[side] !== permit.ownerTopic
        || permit.ownerTopic !== mintOwnerTopic || permit.amount < incoming[side]) {
      return fail('the Permit2 authorization does not match the token settlement');
    }
  }
  return { incoming };
}

/** Prove the untouched one-add mint without relying on an explorer trace. */
export function inferSimpleV4Mint({
  event, receipt, poolManager, positionManager, token0, token1, hooks,
  liquidity, tickLower, tickUpper, decimals0, decimals1,
}) {
  const fail = (unavailable) => ({ unavailable });
  if (!event || event.liquidityDelta !== BigInt(liquidity)) {
    return fail('the mint liquidity does not reconcile with the current position');
  }
  if (!isNative(hooks)) return fail('hooked v4 pools can change settlement amounts');
  const checked = validateSimpleV4Receipt({
    event, receipt, poolManager, positionManager, token0, token1, expectMint: true,
  });
  if (checked.unavailable) return checked;
  const proved = proveAmounts({
    liquidity: event.liquidityDelta,
    raw0: isNative(token0) ? null : Number(checked.incoming[0]),
    raw1: isNative(token1) ? null : Number(checked.incoming[1]),
    tickLower, tickUpper, decimals0, decimals1,
  });
  return proved.unavailable ? proved : { ...proved, fees0: 0, fees1: 0,
    proof: 'single-mint receipt + liquidity math' };
}

function matchingTraceCalls(trace, event, poolManager, positionManager) {
  const matches = [];
  const walk = (call) => {
    if (!call || typeof call !== 'object') return;
    const input = String(call.input || '').toLowerCase();
    if (String(call.from || '').toLowerCase() === String(positionManager).toLowerCase()
        && String(call.to || '').toLowerCase() === String(poolManager).toLowerCase()
        && input.startsWith(MODIFY_LIQUIDITY_SELECTOR)) {
      const lower = callDataWord(input, 5), upper = callDataWord(input, 6);
      const delta = callDataWord(input, 7), salt = callDataWord(input, 8);
      if (lower !== null && Number(signed256(lower)) === event.tickLower
          && upper !== null && Number(signed256(upper)) === event.tickUpper
          && delta !== null && signed256(delta) === event.liquidityDelta
          && salt === BigInt(event.tokenId)) matches.push(call);
    }
    for (const child of call.calls || []) walk(child);
  };
  walk(trace);
  return matches;
}

/**
 * Exact principal and already-earned fees from PoolManager's trace return.
 * `callerDelta = principalDelta + feesAccrued`, so the two returned words make
 * the later addition a pair of honest same-block flows instead of a weighted
 * average or a guessed net transfer.
 */
export function inferSimpleV4TraceAddition({
  event, trace, poolManager, positionManager, hooks,
  tickLower, tickUpper, decimals0, decimals1,
}) {
  const fail = (unavailable) => ({ unavailable });
  if (!event || event.liquidityDelta <= 0n) return fail('the v4 addition event is invalid');
  if (!isNative(hooks)) return fail('hooked v4 pools can change settlement amounts');
  const matches = matchingTraceCalls(trace, event, poolManager, positionManager);
  if (matches.length !== 1) {
    return fail('the execution trace does not isolate one matching v4 addition');
  }
  const callerWord = dataWord(matches[0].output, 0);
  const feesWord = dataWord(matches[0].output, 1);
  if (callerWord === null || feesWord === null) {
    return fail('the v4 trace is missing PoolManager balance deltas');
  }
  const caller = decodeBalanceDelta(callerWord);
  const fees = decodeBalanceDelta(feesWord);
  const principal0 = caller.amount0 - fees.amount0;
  const principal1 = caller.amount1 - fees.amount1;
  if (principal0 > 0n || principal1 > 0n || fees.amount0 < 0n || fees.amount1 < 0n
      || (principal0 === 0n && principal1 === 0n)) {
    return fail('the traced balance deltas are not a simple liquidity addition');
  }
  const proved = proveAmounts({
    liquidity: event.liquidityDelta,
    raw0: Number(-principal0), raw1: Number(-principal1),
    tickLower, tickUpper, decimals0, decimals1,
  });
  if (proved.unavailable) return proved;
  return {
    ...proved,
    fees0: scale(Number(fees.amount0), decimals0),
    fees1: scale(Number(fees.amount1), decimals1),
    proof: 'Blockscout trace balance deltas',
  };
}

function blockscoutV2(chain) {
  if (chain.blockscoutV2) return String(chain.blockscoutV2).replace(/\/$/, '');
  if (!chain.blockscout) return null;
  try { return new URL('/api/v2', chain.blockscout).href.replace(/\/$/, ''); }
  catch { return null; }
}

export async function fetchV4Trace(chain, transactionHash) {
  const base = blockscoutV2(chain);
  if (!base) throw new Error('Blockscout transaction traces are not configured');
  const key = `${base}:${String(transactionHash).toLowerCase()}`;
  if (v4TraceCache.has(key)) return v4TraceCache.get(key);
  const task = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${base}/transactions/${transactionHash}/raw-trace`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Blockscout trace HTTP ${response.status}`);
      const body = await response.json();
      if (!body || typeof body !== 'object' || body.error) {
        throw new Error(`Blockscout trace: ${body && body.error || 'malformed response'}`);
      }
      return body;
    } finally { clearTimeout(timer); }
  })();
  v4TraceCache.set(key, task);
  task.catch(() => v4TraceCache.delete(key));
  if (v4TraceCache.size > V4_TRACE_CACHE_MAX) {
    for (const old of [...v4TraceCache.keys()].slice(0, v4TraceCache.size - V4_TRACE_CACHE_MAX)) {
      v4TraceCache.delete(old);
    }
  }
  return task;
}

function v4VsHodl(position, history) {
  const price = position.price;
  if (!(price > 0) || position.collectable0 === null || position.collectable1 === null) {
    return null;
  }
  const hodl = history.deposited0 * price + history.deposited1;
  if (!(hodl > 0)) return null;
  // A later add crystallises the old position's fees in PoolManager's return
  // and normally nets them into the new principal. Model that as a same-block
  // fee credit plus gross addition: the two flows cancel for external cash,
  // while preserving a correct lifetime fee and vs-holding decomposition.
  const have = (history.received0 + position.amount0 + position.collectable0) * price
    + history.received1 + position.amount1 + position.collectable1;
  const fees = (history.received0 + position.collectable0) * price
    + history.received1 + position.collectable1;
  const delta = have - hodl;
  let apr = null, aprDays = null;
  if (history.adds === 1 && history.firstTime && Date.now() / 1000 > history.firstTime) {
    const years = (Date.now() / 1000 - history.firstTime) / 31557600;
    apr = fees / hodl / years * 100;
    aprDays = years * 365.25;
  }
  return {
    delta,
    pct: (have / hodl - 1) * 100,
    fees,
    feesPct: fees / hodl * 100,
    il: fees - delta,
    ilPct: (fees - delta) / hodl * 100,
    apr,
    aprDays,
    price,
    pricedAt: 'spot',
  };
}

async function v4History(rpc, chain, position, opts) {
  if (!chain.v4PoolManager) return { unavailable: 'v4 PoolManager is not configured' };
  const historyRpc = opts.rpcOverride || chain.logsRpc || rpc;
  const historyFromBlock = chain.v4HistoryMintBoundRpc
    ? await verifiedV4MintBlock(historyRpc, chain.v4PositionManager, position.tokenId)
    : 0;
  const topics = [
    V4_TOPIC.modifyLiquidity,
    position.poolId,
    addressTopic(chain.v4PositionManager),
  ];
  const source = {
    contract: chain.v4PoolManager,
    topics,
    rpc: historyRpc,
    etherscanKey: opts.etherscanKey || chain.etherscanKey || null,
    etherscanChainId: chain.etherscanChainId || null,
    historyRelay: opts.historyRelay || opts.blockscoutRelay || null,
    historyRelayChainId: chain.etherscanChainId || null,
    blockscout: chain.blockscout || null,
  };
  // Several NFTs commonly share one pool. The PoolManager filter returns that
  // pool's PositionManager events and salt is matched locally, so cards asking
  // concurrently share one in-flight network request. Completed snapshots are
  // never retained: a fee-only v4 action can change PnL without changing the
  // position's liquidity, so even a ten-second result cache can look reconciled
  // while being stale on the next deliberate refresh.
  const cacheKey = [
    chain.v4PoolManager.toLowerCase(), chain.v4PositionManager.toLowerCase(),
    position.poolId.toLowerCase(),
    source.etherscanKey ? 'e' : '-', source.historyRelay ? 'h' : '-',
    source.blockscout ? 'b' : '-',
  ].join(':');
  // An earlier verified mint bound is a safe superset for every newer NFT in
  // the same pool. The reverse is unsafe, so replace a newer cached bound when
  // an older position asks for its history.
  const poolLogTask = coalesceV4PoolLogTask(cacheKey, historyFromBlock, () => Promise.all([
      fetchFilteredLogs({ ...source, fromBlock: historyFromBlock }),
      fetchRecentFilteredLogs({
        contract: chain.v4PoolManager,
        topics,
        rpc: opts.rpcOverride || chain.logsRpc || rpc,
      }),
    ]));
  const [full, recent] = await poolLogTask;
  if (full.unavailable) {
    return { unavailable: full.unavailable };
  }

  const merged = new Map();
  for (const log of [...(full.logs || []), ...(recent.logs || [])]) merged.set(logId(log), log);
  const events = decodeV4LiquidityLogs([...merged.values()], {
    poolId: position.poolId,
    positionManager: chain.v4PositionManager,
    tokenId: position.tokenId,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
  });
  if (!events.length) {
    return { unavailable: 'zero matching v4 lifetime events — history is incomplete' };
  }
  const net = events.reduce((sum, event) => sum + event.liquidityDelta, 0n);
  if (net !== position.liquidity) {
    return { unavailable: 'v4 event history does not reconcile with current liquidity' };
  }
  if (events.some((event) => event.liquidityDelta <= 0n)) {
    return {
      unavailable: `v4 lifecycle verified (${events.length} actions), but exact return currently `
        + 'supports additions only; removes and fee-only actions remain unavailable',
    };
  }
  if (events.length > MAX_SIMPLE_V4_ADDS) {
    return { unavailable: `v4 lifecycle has ${events.length} additions; the safe trace limit is `
      + MAX_SIMPLE_V4_ADDS };
  }
  if (new Set(events.map((event) => String(event.transactionHash).toLowerCase())).size
      !== events.length) {
    return { unavailable: 'multiple v4 additions in one transaction cannot be isolated safely' };
  }

  const receipts = [];
  try {
    for (const event of events) {
      receipts.push(await fetchV4Receipt(rpc, chain, event.transactionHash, opts));
    }
  } catch (err) {
    return { unavailable: `v4 addition receipt unavailable — ${err.message || String(err)}` };
  }

  const proofs = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i], receipt = receipts[i];
    if (i === 0) {
      const mint = inferSimpleV4Mint({
        event, receipt,
        poolManager: chain.v4PoolManager,
        positionManager: chain.v4PositionManager,
        token0: position.token0,
        token1: position.token1,
        hooks: position.hooks,
        // The first delta is the mint's liquidity; current liquidity includes
        // every later addition and is reconciled independently above.
        liquidity: event.liquidityDelta,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        decimals0: position.token0Meta.decimals,
        decimals1: position.token1Meta.decimals,
      });
      if (mint.unavailable) return { unavailable: mint.unavailable };
      proofs.push(mint);
      continue;
    }

    const checked = validateSimpleV4Receipt({
      event, receipt,
      poolManager: chain.v4PoolManager,
      positionManager: chain.v4PositionManager,
      token0: position.token0,
      token1: position.token1,
      expectMint: false,
    });
    if (checked.unavailable) return { unavailable: checked.unavailable };
    let trace;
    try { trace = await fetchV4Trace(chain, event.transactionHash); }
    catch (err) {
      return { unavailable: `v4 addition trace unavailable — ${err.message || String(err)}` };
    }
    const added = inferSimpleV4TraceAddition({
      event, trace,
      poolManager: chain.v4PoolManager,
      positionManager: chain.v4PositionManager,
      hooks: position.hooks,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      decimals0: position.token0Meta.decimals,
      decimals1: position.token1Meta.decimals,
    });
    if (added.unavailable) return { unavailable: added.unavailable };
    proofs.push(added);
  }

  const blocks = new Map();
  await Promise.all(events.filter((event) => !event.time).map(async (event) => {
    if (blocks.has(event.block)) return;
    blocks.set(event.block, null);
    try {
      const block = await rpcCall(rpc, 'eth_getBlockByNumber', [
        '0x' + BigInt(event.block).toString(16), false,
      ]);
      if (block?.timestamp) blocks.set(event.block, Number(BigInt(block.timestamp)));
    } catch { /* a missing timestamp never becomes an invented date */ }
  }));

  const deposits = events.map((event, i) => ({
    block: event.block,
    time: event.time || blocks.get(event.block) || null,
    transactionHash: event.transactionHash,
    logIndex: event.logIndex,
    amount0: proofs[i].amount0,
    amount1: proofs[i].amount1,
    entry: proofs[i].entry,
  }));
  const collections = events.flatMap((event, i) => (
    proofs[i].fees0 > 0 || proofs[i].fees1 > 0 ? [{
      block: event.block,
      time: event.time || blocks.get(event.block) || null,
      transactionHash: event.transactionHash,
      logIndex: event.logIndex,
      amount0: proofs[i].fees0,
      amount1: proofs[i].fees1,
      entry: proofs[i].entry,
      kind: 'fees-credited-on-add',
    }] : []
  ));
  const total = (key, rows) => rows.reduce((sum, row) => sum + row[key], 0);
  const deposited0 = total('amount0', deposits), deposited1 = total('amount1', deposits);
  const received0 = total('amount0', collections), received1 = total('amount1', collections);
  const currentUnavailable = position.collectable0 === null || position.collectable1 === null;
  const history = {
    entry: proofs[0].entry,
    exit: null,
    deposits,
    collections,
    deposited0,
    deposited1,
    received0,
    received1,
    fees0: currentUnavailable ? null : received0 + position.collectable0,
    fees1: currentUnavailable ? null : received1 + position.collectable1,
    adds: events.length,
    firstBlock: events[0].block,
    firstTime: deposits[0].time,
    lastTime: deposits[deposits.length - 1].time,
    currentUnavailable,
    feeCreditsOnAdd: collections.length > 0,
    proof: events.length === 1 ? proofs[0].proof
      : `${events.length} isolated addition receipts + Blockscout trace balance deltas`,
    source: [full.source, recent && !recent.unavailable ? recent.source : null]
      .filter(Boolean).join('+') + (events.length > 1 ? '+blockscout-trace' : ''),
  };
  history.vsHodl = v4VsHodl(position, history);
  return history;
}

/**
 * Prove the earliest safe PoolManager-history block from this exact ERC-721.
 *
 * A wallet's first incoming transfer is not enough because the NFT may have a
 * prior owner. Only the canonical zero-address mint from global token history
 * is accepted. Any missing or malformed proof returns block zero, which is the
 * slower but complete fallback.
 */
export async function verifiedV4MintBlock(rpc, positionManager, tokenId) {
  const transfers = await fetchTokenTransfersRpc({
    contract: positionManager,
    tokenId,
    rpc,
    fromBlock: 0,
    toBlock: 'latest',
    requireNonEmpty: true,
  });
  if (transfers.unavailable) return 0;
  const events = transfers.events || [];
  const mints = events.filter((event) => event.from === ZERO_ADDRESS);
  if (mints.length !== 1 || events[0] !== mints[0]) return 0;
  return Number.isSafeInteger(mints[0].block) && mints[0].block >= 0 ? mints[0].block : 0;
}

async function currencyMeta(rpc, chain, address, tokenMeta) {
  if (isNative(address)) {
    return { symbol: chain.nativeSymbol || 'ETH', decimals: 18, native: true };
  }
  return tokenMeta(address);
}

/**
 * Uncollected fees, from the difference between the pool's current fee growth
 * inside the range and the snapshot stored against the position.
 *
 * The subtraction is deliberately mod 2^256: fee growth accumulators are
 * allowed to overflow and wrap, and Uniswap's own maths relies on the wrapped
 * difference being correct.
 */
async function v4Fees(rpc, chain, poolId, tickLower, tickUpper, tokenId) {
  const sv = chain.v4StateView;
  const args = poolId.slice(2) + encInt(tickLower) + encInt(tickUpper);
  const [infoHex, insideHex] = await Promise.all([
    ethCall(rpc, sv, V4.getPositionInfo + poolId.slice(2)
      + encAddress(chain.v4PositionManager) + encInt(tickLower) + encInt(tickUpper)
      + encUint(tokenId)).catch(() => null),
    ethCall(rpc, sv, V4.getFeeGrowthInside + args).catch(() => null),
  ]);
  if (!infoHex || !insideHex) return null;

  const a = words(infoHex), b = words(insideHex);
  if (a.length < 3 || b.length < 2) return null;

  const liquidity = toUint(a[0]);
  const diff = (now, last) => (now - last + MAX256) % MAX256;
  return {
    liquidity,
    fees0: (liquidity * diff(toUint(b[0]), toUint(a[1]))) / Q128,
    fees1: (liquidity * diff(toUint(b[1]), toUint(a[2]))) / Q128,
  };
}

const sortUniqueTokenIds = (values) => [...new Set((values || []).map(String))]
  .map(BigInt)
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function replayTransfers(seed, events) {
  const held = new Set(sortUniqueTokenIds(seed).map(String));
  for (const event of events || []) {
    const id = BigInt(event.tokenId).toString();
    if (event.direction === 'in') held.add(id);
    else held.delete(id);
  }
  return sortUniqueTokenIds([...held]);
}

async function v4BalanceAt(rpc, manager, owner, blockTag) {
  const hex = await retryRead(() => ethCall(
    rpc, manager, V4.balanceOf + encAddress(owner), null, blockTag,
  ));
  const count = Number(toUint(words(hex)[0]));
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid balanceOf result');
  return count;
}

async function proveOwnedSet(rpc, manager, owner, candidates, balanceOf, blockTag) {
  const ids = sortUniqueTokenIds(candidates);
  const verified = await verifyOwnedIds(rpc, manager, owner, ids, blockTag);
  return {
    tokenIds: verified.tokenIds,
    unreadable: verified.unreadable,
    exact: verified.unreadable === 0 && verified.tokenIds.length === balanceOf,
  };
}

async function transferWindow(chain, owner, opts, rpc, fromBlock, toBlock) {
  if (fromBlock > toBlock) return { events: [], source: 'empty-tail' };
  const args = {
    contract: chain.v4PositionManager,
    owner,
    rpc: opts.rpcOverride || chain.logsRpc || chain.rpc,
    etherscanKey: opts.etherscanKey || chain.etherscanKey,
    etherscanChainId: chain.etherscanChainId,
    historyRelay: opts.historyRelay || opts.blockscoutRelay || null,
    historyRelayChainId: chain.etherscanChainId || null,
    blockscout: chain.blockscout || null,
    fromBlock,
    toBlock,
  };
  const indexed = await fetchTransfers(args);
  const recentFrom = Math.max(fromBlock, toBlock - 127);
  const recent = await fetchTransfers({
    ...args,
    rpc,
    etherscanKey: null,
    historyRelay: null,
    blockscout: null,
    fromBlock: recentFrom,
    rpcOnly: true,
  });
  if (indexed.unavailable) {
    if (!recent.unavailable && recentFrom === fromBlock) return recent;
    return indexed;
  }
  if (recent.unavailable) return indexed;
  return {
    events: [
      ...indexed.events.filter((event) => event.block < recentFrom),
      ...recent.events,
    ],
    source: `${indexed.source}+recent-rpc`,
    fromBlock,
    toBlock,
  };
}

async function saveOwnershipProof({
  chainKey, manager, owner, rpc, head, balanceOf, tokenIds, source,
}) {
  // The result is still usable if local storage fails. Only persist after the
  // captured block and its balance are confirmed unchanged.
  const stable = await fetchBlockCheckpoint(rpc, head.block);
  if (stable.unavailable || stable.hash !== head.hash) return;
  try {
    if (await v4BalanceAt(rpc, manager, owner, '0x' + BigInt(head.block).toString(16))
        !== balanceOf) return;
  } catch { return; }
  await writeV4OwnershipCheckpoint({
    chainKey,
    manager,
    owner,
    checkedThrough: head.block,
    checkpointHash: head.hash,
    balanceOf,
    tokenIds,
    source,
  });
}

/**
 * Enumerate v4 ownership at one captured block. Every accepted candidate set
 * is proven complete by balanceOf plus ownerOf. A persistent exact checkpoint
 * avoids replaying Transfer history for an unchanged wallet.
 */
export async function enumerateV4(chainKey, owner, opts = {}) {
  const chain = CHAINS[chainKey];
  if (!chain || !chain.v4PositionManager) return { unavailable: 'no v4 deployment configured' };
  const rpc = opts.rpcOverride || chain.rpc;
  const manager = chain.v4PositionManager;
  const head = await fetchBlockCheckpoint(rpc, 'latest');
  if (head.unavailable) return { unavailable: `v4 head could not be verified: ${head.unavailable}` };
  const blockTag = '0x' + BigInt(head.block).toString(16);

  let onChainCount;
  try {
    onChainCount = await v4BalanceAt(rpc, manager, owner, blockTag);
  } catch (err) {
    return { unavailable: `v4 balance could not be verified: ${err.message || String(err)}` };
  }

  const accept = async (proof, source, indexWarning = null) => {
    await saveOwnershipProof({
      chainKey, manager, owner, rpc, head,
      balanceOf: onChainCount, tokenIds: proof.tokenIds, source,
    });
    return {
      tokenIds: proof.tokenIds,
      verifiedTokenIds: proof.tokenIds,
      balanceOf: onChainCount,
      reconciles: true,
      source,
      indexWarning,
      checkedThrough: head.block,
    };
  };

  if (onChainCount === 0) {
    return accept({ tokenIds: [], exact: true, unreadable: 0 }, 'balanceOf+checkpoint');
  }

  let checkpointError = null;
  const checkpoint = await readV4OwnershipCheckpoint({ chainKey, manager, owner });
  if (checkpoint && checkpoint.checkedThrough <= head.block) {
    const anchor = await fetchBlockCheckpoint(rpc, checkpoint.checkedThrough);
    if (!anchor.unavailable && anchor.hash === checkpoint.checkpointHash) {
      const direct = await proveOwnedSet(
        rpc, manager, owner, checkpoint.tokenIds, onChainCount, blockTag,
      );
      if (direct.exact) return accept(direct, 'ownership-checkpoint+ownerOf');

      const tail = await transferWindow(
        chain, owner, opts, rpc, checkpoint.checkedThrough + 1, head.block,
      );
      if (!tail.unavailable) {
        const candidates = replayTransfers(checkpoint.tokenIds, tail.events);
        const extended = await proveOwnedSet(
          rpc, manager, owner, candidates, onChainCount, blockTag,
        );
        if (extended.exact) return accept(extended, 'ownership-checkpoint+tail+ownerOf');
        checkpointError = `checkpoint tail verified ${extended.tokenIds.length}, `
          + `balanceOf reports ${onChainCount}`;
      } else {
        checkpointError = `checkpoint tail unavailable: ${tail.unavailable}`;
      }
    } else {
      checkpointError = 'ownership checkpoint was invalidated by a block change';
    }
  }

  // A configured Alchemy RPC also exposes its NFT ownership index. It is never
  // trusted alone; the same captured-block ownerOf proof remains mandatory.
  let alchemyError = null;
  try {
    const indexed = await alchemyOwnedTokenIds(rpc, manager, owner);
    if (indexed) {
      const verified = await proveOwnedSet(
        rpc, manager, owner, indexed.tokenIds, onChainCount, blockTag,
      );
      if (verified.exact) return accept(verified, 'alchemy-nft+ownerOf', checkpointError);
      alchemyError = `Alchemy NFT index gave ${indexed.tokenIds.length}, `
        + `ownerOf verified ${verified.tokenIds.length}, balanceOf reports ${onChainCount}`;
    }
  } catch (err) {
    // Never include the URL here: it contains the user's API key.
    alchemyError = `Alchemy NFT ownership lookup failed: ${err.message || String(err)}`;
  }

  const got = await transferWindow(chain, owner, opts, rpc, 0, head.block);
  if (got.unavailable) {
    return {
      balanceOf: onChainCount,
      unavailable: [checkpointError, alchemyError, got.unavailable].filter(Boolean).join('; '),
    };
  }
  const candidates = replayTransfers([], got.events);
  const verified = await proveOwnedSet(
    rpc, manager, owner, candidates, onChainCount, blockTag,
  );
  if (verified.exact) {
    return accept(verified, 'transfer-logs+ownerOf', [checkpointError, alchemyError]
      .filter(Boolean).join('; ') || null);
  }
  return {
    tokenIds: candidates,
    verifiedTokenIds: verified.tokenIds,
    balanceOf: onChainCount,
    reconciles: false,
    source: 'transfer-logs+ownerOf',
    indexWarning: [
      checkpointError,
      alchemyError,
      `ownerOf verified ${verified.tokenIds.length}, balanceOf reports ${onChainCount}`,
    ].filter(Boolean).join('; '),
    checkedThrough: head.block,
  };
}

/** Return null when the RPC URL is not an Alchemy v2 endpoint. */
export async function alchemyOwnedTokenIds(rpc, contract, owner) {
  let parsed;
  try { parsed = new URL(rpc); } catch { return null; }
  if (!parsed.hostname.toLowerCase().endsWith('.g.alchemy.com')) return null;
  const match = parsed.pathname.match(/^\/v2\/([^/]+)\/?$/);
  if (!match) return null;

  const endpoint = new URL(`/nft/v3/${encodeURIComponent(match[1])}/getNFTsForOwner`, parsed.origin);
  endpoint.searchParams.set('owner', owner);
  endpoint.searchParams.append('contractAddresses[]', contract);
  endpoint.searchParams.set('withMetadata', 'false');
  endpoint.searchParams.set('pageSize', '100');

  const ids = new Set();
  let pageKey = null;
  for (let page = 0; page < 50; page++) {
    if (pageKey) endpoint.searchParams.set('pageKey', pageKey);
    const res = await retryRead(async () => {
      const response = await fetch(endpoint);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    });
    const body = await res.json();
    if (!Array.isArray(body.ownedNfts)) throw new Error('malformed response');
    for (const nft of body.ownedNfts) {
      const addr = nft && nft.contract && nft.contract.address;
      if (addr && String(addr).toLowerCase() !== contract.toLowerCase()) continue;
      if (nft && nft.tokenId !== undefined) ids.add(BigInt(nft.tokenId));
    }
    pageKey = body.pageKey || null;
    if (!pageKey) {
      return {
        tokenIds: [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      };
    }
  }
  throw new Error('pagination exceeded 50 pages');
}

export async function verifyOwnedIds(rpc, contract, owner, tokenIds, block = 'latest') {
  const want = String(owner).toLowerCase();
  const rows = [];
  for (let offset = 0; offset < tokenIds.length; offset += 25) {
    const chunk = tokenIds.slice(offset, offset + 25);
    let pending = chunk.map((tokenId, index) => ({ tokenId, index }));
    const resolved = new Array(chunk.length);
    for (let attempt = 0; attempt < 4 && pending.length; attempt++) {
      let hexes;
      try {
        hexes = await ethCallBatch(rpc, pending.map(({ tokenId }) => ({
          to: contract, data: dataOwnerOf(tokenId), block,
        })));
      } catch {
        if (attempt < 3) await wait(2000 * (attempt + 1));
        continue;
      }
      const retry = [];
      for (let i = 0; i < pending.length; i++) {
        const item = pending[i], hex = hexes[i];
        if (!hex || hex.__error) retry.push(item);
        else resolved[item.index] = toAddress(words(hex)[0]).toLowerCase() === want
          ? item.tokenId : null;
      }
      pending = retry;
      if (pending.length && attempt < 3) await wait(2000 * (attempt + 1));
    }
    // Providers that reject JSON-RPC batches may still serve the exact same
    // proof as scalar eth_call. Retry only unresolved items and keep the block
    // tag fixed so balanceOf and ownerOf describe one state.
    for (const item of pending) {
      try {
        const hex = await retryRead(() => ethCall(
          rpc, contract, dataOwnerOf(item.tokenId), null, block,
        ), 2);
        resolved[item.index] = toAddress(words(hex)[0]).toLowerCase() === want
          ? item.tokenId : null;
      } catch {
        resolved[item.index] = { __error: 'ownerOf unreadable' };
      }
    }
    rows.push(...resolved);
    if (offset + chunk.length < tokenIds.length) await wait(250);
  }
  return {
    tokenIds: rows.filter((id) => typeof id === 'bigint'),
    unreadable: rows.filter((id) => id && id.__error).length,
  };
}

/** Read one v4 position. Shaped like a v3 position so the UI needs no branch. */
export async function loadV4Position(chainKey, tokenId, opts = {}) {
  const chain = CHAINS[chainKey];
  if (!chain || !chain.v4PositionManager) throw new Error(`no v4 deployment for ${chainKey}`);
  const rpc = opts.rpcOverride || chain.rpc;
  const pm = chain.v4PositionManager;

  const [infoHex, liqHex] = await Promise.all([
    ethCall(rpc, pm, V4.poolAndPositionInfo + encUint(tokenId)),
    ethCall(rpc, pm, V4.positionLiquidity + encUint(tokenId)),
  ]);

  const pos = decodeV4Position(infoHex);
  if (!pos) throw new Error(`v4 position ${tokenId} not readable on ${chainKey}`);
  const liquidity = toUint(words(liqHex)[0] || '0');

  const poolId = poolIdOf(pos.poolKeyWords);
  // Cross-check 1: the derived hash must agree with the id v4 stored itself.
  if (BigInt(poolId) >> 56n !== pos.truncatedPoolId) {
    throw new Error(`v4 poolId mismatch for ${tokenId} — derivation is wrong, refusing to read`);
  }

  const tokenMeta = opts.tokenMeta || (async () => ({ symbol: '?', decimals: 18 }));
  const [slotHex, m0, m1, fees] = await Promise.all([
    ethCall(rpc, chain.v4StateView, V4.getSlot0 + poolId.slice(2)),
    currencyMeta(rpc, chain, pos.currency0, tokenMeta),
    currencyMeta(rpc, chain, pos.currency1, tokenMeta),
    v4Fees(rpc, chain, poolId, pos.tickLower, pos.tickUpper, tokenId),
  ]);

  const sw = words(slotHex);
  const sqrtPriceX96 = toUint(sw[0]);
  const currentTick = Number(s24(toUint(sw[1]) & 0xffffffn));

  // Cross-check 2: StateView and the PositionManager must agree on liquidity.
  if (fees && fees.liquidity !== liquidity) {
    throw new Error(`v4 liquidity mismatch for ${tokenId} (StateView ${fees.liquidity} vs manager ${liquidity})`);
  }

  const amounts = positionAmounts({
    liquidity, tickLower: pos.tickLower, tickUpper: pos.tickUpper, sqrtPriceX96,
  });

  const position = {
    version: 'v4',
    tokenId,
    poolId,
    hooks: pos.hooks,
    token0: pos.currency0,
    token1: pos.currency1,
    fee: pos.fee,
    tickSpacing: pos.tickSpacing,
    tickLower: pos.tickLower,
    tickUpper: pos.tickUpper,
    liquidity,
    token0Meta: m0,
    token1Meta: m1,
    currentTick,
    price: humanPrice(sqrtPriceX96, m0.decimals, m1.decimals),
    priceLower: tickToPrice(pos.tickLower, m0.decimals, m1.decimals),
    priceUpper: tickToPrice(pos.tickUpper, m0.decimals, m1.decimals),
    amount0: scale(amounts.amount0, m0.decimals),
    amount1: scale(amounts.amount1, m1.decimals),
    status: amounts.status,
    collectable0: fees ? scale(Number(fees.fees0), m0.decimals) : null,
    collectable1: fees ? scale(Number(fees.fees1), m1.decimals) : null,
  };
  try {
    position.history = await v4History(rpc, chain, position, opts);
  } catch (err) {
    // Present state remains useful even when the strictly optional proof path
    // fails. Never let a history provider take down the position card.
    position.history = { unavailable: err.message || String(err) };
  }
  return position;
}
