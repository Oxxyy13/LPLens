/**
 * Receipt-proven v3 position replacements remembered in local storage.
 *
 * A link requires one successful transaction containing exactly one v3
 * decrease, payout, successor NFT mint, and successor increase on the chain's
 * NonfungiblePositionManager. The old payout and new NFT must target the same
 * owner, and both positions must use the same pool. This proves a unique
 * same-transaction replacement, not that the collected fungible assets funded
 * the successor. v4 stays unsupported until removal history can meet the same
 * standard.
 */

import { CHAINS } from './chains.js';
import { TOPIC } from './history.js';
import { rpcCall } from './rpc.js';

export const POSITION_LINEAGE_KEY = 'positionLineageV1';
export const POSITION_LINEAGE_VERSION = 1;
export const MAX_LINEAGE_EDGES = 1_000;
export const MAX_LINEAGE_VALIDATIONS = 50;

const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const HASH_RE = /^0x[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const CHAIN_RE = /^[a-z0-9-]{1,32}$/;
const POSITION_KEY_RE =
  /^0x[0-9a-f]{40}:[a-z0-9-]{1,32}:0x[0-9a-f]{40}:v3:\d+$/;
const memory = { [POSITION_LINEAGE_KEY]: [] };
const store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
  ? chrome.storage.local
  : null;

const cleanHash = (value) => {
  const hash = String(value || '').trim().toLowerCase();
  return HASH_RE.test(hash) ? hash : null;
};
const cleanAddress = (value) => {
  const address = String(value || '').trim().toLowerCase();
  return ADDRESS_RE.test(address) ? address : null;
};
const cleanIndex = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0
  ? Number(value) : null;
const cleanUint = (value) => {
  try {
    const number = BigInt(value);
    return number >= 0n ? number.toString() : null;
  } catch {
    return null;
  }
};
const topicAddress = (topic) => {
  const value = String(topic || '').toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(value) ? cleanAddress(`0x${value.slice(-40)}`) : null;
};
const topicTokenId = (topic) => cleanUint(topic);
const dataWord = (data, index) => {
  const value = String(data || '');
  const word = value.slice(2 + index * 64, 2 + (index + 1) * 64);
  return /^[0-9a-fA-F]{64}$/.test(word) ? `0x${word}` : null;
};
const dataUint = (data, index) => cleanUint(dataWord(data, index));

function managerFor(position) {
  const chainKey = String(position?.chainKey || '').trim().toLowerCase();
  return cleanAddress(CHAINS[chainKey]?.nfpm);
}

/** Manager-scoped immutable NFT identity used only by the replacement graph. */
export function lineagePositionKey(position) {
  const owner = cleanAddress(position?.ownerAddress || position?.owner || position?.address);
  const chainKey = String(position?.chainKey || '').trim().toLowerCase();
  const version = String(position?.version || position?.protocol || '').trim().toLowerCase();
  const manager = managerFor(position);
  const tokenId = cleanUint(position?.tokenId);
  if (!owner || !CHAIN_RE.test(chainKey) || version !== 'v3' || !manager || tokenId === null) {
    return null;
  }
  return `${owner}:${chainKey}:${manager}:v3:${tokenId}`;
}

function exactHistory(position) {
  return !!(position?.history && !position.history.unavailable);
}

function closeParts(position) {
  if (!exactHistory(position) || position?.liquidity !== 0n
      || position?.tokensOwed0 !== 0n || position?.tokensOwed1 !== 0n) return null;
  const history = position.history;
  const event = history.closedAt;
  const transactionHash = cleanHash(event?.transactionHash);
  const block = cleanIndex(event?.block);
  const logIndex = cleanIndex(event?.logIndex);
  const collection = (history.collections || []).find((row) => (
    cleanHash(row.transactionHash) === transactionHash
      && cleanIndex(row.logIndex) !== null && cleanIndex(row.logIndex) > logIndex
  ));
  if (!transactionHash || block === null || logIndex === null || !collection) return null;
  return {
    transactionHash,
    block,
    closeLogIndex: logIndex,
    collectLogIndex: cleanIndex(collection.logIndex),
    decreaseLiquidity: cleanUint(event.liquidityRaw),
    decreaseAmount0: cleanUint(event.amount0Raw),
    decreaseAmount1: cleanUint(event.amount1Raw),
    collectAmount0: cleanUint(collection.amount0Raw),
    collectAmount1: cleanUint(collection.amount1Raw),
  };
}

function openParts(position) {
  if (!exactHistory(position)) return null;
  const event = position.history.deposits?.[0];
  const transactionHash = cleanHash(event?.transactionHash);
  const block = cleanIndex(event?.block);
  const logIndex = cleanIndex(event?.logIndex);
  if (!transactionHash || block === null || logIndex === null) return null;
  return {
    transactionHash,
    block,
    openLogIndex: logIndex,
    increaseLiquidity: cleanUint(event.liquidityRaw),
    increaseAmount0: cleanUint(event.amount0Raw),
    increaseAmount1: cleanUint(event.amount1Raw),
  };
}

function identityParts(position) {
  const key = lineagePositionKey(position);
  const owner = cleanAddress(position?.ownerAddress || position?.owner || position?.address);
  const chainKey = String(position?.chainKey || '').trim().toLowerCase();
  const manager = managerFor(position);
  const pool = cleanAddress(position?.pool);
  const tokenId = cleanUint(position?.tokenId);
  return key && owner && manager && pool && tokenId !== null
    ? { key, owner, chainKey, manager, pool, tokenId } : null;
}

/** Find unique loaded close/open pairs. They remain untrusted until receipt proof. */
export function discoverLineageCandidates(positions, at = Date.now()) {
  const closes = (positions || []).map((position) => {
    const identity = identityParts(position), close = closeParts(position);
    return identity && close ? { ...identity, ...close } : null;
  }).filter(Boolean);
  const opens = (positions || []).map((position) => {
    const identity = identityParts(position), open = openParts(position);
    return identity && open ? { ...identity, ...open } : null;
  }).filter(Boolean);
  const matchKey = (row) => [
    row.owner, row.chainKey, row.manager, row.pool, row.transactionHash, row.block,
  ].join('|');
  const opensByTransaction = new Map();
  for (const open of opens) {
    const key = matchKey(open);
    if (!opensByTransaction.has(key)) opensByTransaction.set(key, []);
    opensByTransaction.get(key).push(open);
  }
  const candidates = [];
  for (const close of closes) {
    for (const open of opensByTransaction.get(matchKey(close)) || []) {
      if (close.key === open.key || close.collectLogIndex >= open.openLogIndex) continue;
      const amounts = [
        close.decreaseLiquidity, close.decreaseAmount0, close.decreaseAmount1,
        close.collectAmount0, close.collectAmount1,
        open.increaseLiquidity, open.increaseAmount0, open.increaseAmount1,
      ];
      if (amounts.some((value) => value === null)) continue;
      candidates.push({
        version: POSITION_LINEAGE_VERSION,
        from: close.key,
        to: open.key,
        fromTokenId: close.tokenId,
        toTokenId: open.tokenId,
        owner: close.owner,
        chainKey: close.chainKey,
        manager: close.manager,
        pool: close.pool,
        transactionHash: close.transactionHash,
        block: close.block,
        closeLogIndex: close.closeLogIndex,
        collectLogIndex: close.collectLogIndex,
        openLogIndex: open.openLogIndex,
        decreaseLiquidity: close.decreaseLiquidity,
        decreaseAmount0: close.decreaseAmount0,
        decreaseAmount1: close.decreaseAmount1,
        collectAmount0: close.collectAmount0,
        collectAmount1: close.collectAmount1,
        increaseLiquidity: open.increaseLiquidity,
        increaseAmount0: open.increaseAmount0,
        increaseAmount1: open.increaseAmount1,
        at: Number.isFinite(at) && at > 0 ? Number(at) : Date.now(),
      });
    }
  }
  const fromCounts = new Map(), toCounts = new Map();
  for (const edge of candidates) {
    fromCounts.set(edge.from, (fromCounts.get(edge.from) || 0) + 1);
    toCounts.set(edge.to, (toCounts.get(edge.to) || 0) + 1);
  }
  return candidates.filter((edge) => fromCounts.get(edge.from) === 1 && toCounts.get(edge.to) === 1);
}

function receiptLog(log) {
  let logIndex = null;
  try { logIndex = cleanIndex(Number(BigInt(log?.logIndex))); } catch { /* malformed */ }
  return {
    address: cleanAddress(log?.address),
    topics: Array.isArray(log?.topics) ? log.topics.map((topic) => String(topic).toLowerCase()) : [],
    data: String(log?.data || '0x'),
    logIndex,
  };
}

function amountFingerprintMatches(candidate, decrease, collect, increase) {
  return dataUint(decrease.data, 0) === candidate.decreaseLiquidity
    && dataUint(decrease.data, 1) === candidate.decreaseAmount0
    && dataUint(decrease.data, 2) === candidate.decreaseAmount1
    && dataUint(collect.data, 1) === candidate.collectAmount0
    && dataUint(collect.data, 2) === candidate.collectAmount1
    && dataUint(increase.data, 0) === candidate.increaseLiquidity
    && dataUint(increase.data, 1) === candidate.increaseAmount0
    && dataUint(increase.data, 2) === candidate.increaseAmount1;
}

/** Pure full-receipt predicate, exported for deterministic regression tests. */
export function proveLineageReceipt(candidate, rawReceipt) {
  if (!candidate || !rawReceipt || !['0x1', '0x01'].includes(String(rawReceipt.status).toLowerCase())) {
    return null;
  }
  const transactionHash = cleanHash(rawReceipt.transactionHash);
  const blockHash = cleanHash(rawReceipt.blockHash);
  let block = null;
  try { block = Number(BigInt(rawReceipt.blockNumber)); } catch { /* malformed */ }
  if (transactionHash !== candidate.transactionHash || !blockHash || block !== candidate.block) return null;
  if (!Array.isArray(rawReceipt.logs)) return null;
  const receiptLogs = rawReceipt.logs.map(receiptLog);
  const isLifecycle = (log) => log.topics[0] === TOPIC.increase
    || log.topics[0] === TOPIC.decrease || log.topics[0] === TOPIC.collect
    || log.topics[0] === TRANSFER_TOPIC;
  // Do not let an otherwise recognizable manager action disappear from the
  // ambiguity count merely because its log index is malformed.
  if (receiptLogs.some((log) => (
    log.address === candidate.manager && isLifecycle(log) && log.logIndex === null
  ))) return null;
  const managerLogs = receiptLogs
    .filter((log) => log.address === candidate.manager && log.logIndex !== null);
  const actions = managerLogs.filter((log) => (
    log.topics[0] === TOPIC.increase || log.topics[0] === TOPIC.decrease
      || log.topics[0] === TOPIC.collect
  ));
  const transfers = managerLogs.filter((log) => log.topics[0] === TRANSFER_TOPIC);
  // Any extra position lifecycle action or NFT transfer makes the pairing
  // ambiguous, even when the two loaded cards happen to match.
  if (actions.length !== 3 || transfers.length !== 1) return null;
  const decrease = actions.find((log) => log.topics[0] === TOPIC.decrease
    && topicTokenId(log.topics[1]) === candidate.fromTokenId
    && log.logIndex === candidate.closeLogIndex);
  const collect = actions.find((log) => log.topics[0] === TOPIC.collect
    && topicTokenId(log.topics[1]) === candidate.fromTokenId
    && log.logIndex === candidate.collectLogIndex);
  const increase = actions.find((log) => log.topics[0] === TOPIC.increase
    && topicTokenId(log.topics[1]) === candidate.toTokenId
    && log.logIndex === candidate.openLogIndex);
  const mint = transfers[0];
  const collectRecipient = topicAddress(dataWord(collect?.data, 0));
  const mintFrom = topicAddress(mint?.topics[1]);
  const mintRecipient = topicAddress(mint?.topics[2]);
  const mintedTokenId = topicTokenId(mint?.topics[3]);
  if (!decrease || !collect || !increase
      || collectRecipient !== candidate.owner || mintFrom !== ZERO_ADDRESS
      || mintRecipient !== candidate.owner || mintedTokenId !== candidate.toTokenId
      || !(decrease.logIndex < collect.logIndex && collect.logIndex < mint.logIndex
        && mint.logIndex < increase.logIndex)
      || !amountFingerprintMatches(candidate, decrease, collect, increase)) return null;
  return { ...candidate, blockHash, proof: 'receipt-v1' };
}

/** Fetch and prove candidate receipts against the canonical block header. */
export async function proveLineageCandidates(
  candidates,
  rpcOverrides = {},
  maxValidations = MAX_LINEAGE_VALIDATIONS,
) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const limit = Number.isSafeInteger(maxValidations) && maxValidations >= 0
    ? maxValidations : 0;
  // Returning a prefix could manufacture a false graph head. Fail closed
  // before making any request when the candidate set exceeds its budget.
  if (lineageReceiptGroupCount(rows) > limit) return [];
  const out = [], byReceipt = new Map(), byHeader = new Map();
  for (const candidate of rows) {
    const rpc = rpcOverrides[candidate.chainKey] || CHAINS[candidate.chainKey]?.rpc;
    if (!rpc) continue;
    const key = `${candidate.chainKey}:${candidate.transactionHash}`;
    if (!byReceipt.has(key)) {
      byReceipt.set(key, rpcCall(rpc, 'eth_getTransactionReceipt', [candidate.transactionHash])
        .catch(() => null));
    }
    const edge = proveLineageReceipt(candidate, await byReceipt.get(key));
    if (!edge) continue;
    const headerKey = `${candidate.chainKey}:${candidate.block}`;
    if (!byHeader.has(headerKey)) {
      byHeader.set(headerKey, rpcCall(rpc, 'eth_getBlockByNumber', [
        `0x${BigInt(candidate.block).toString(16)}`, false,
      ]).catch(() => null));
    }
    const header = await byHeader.get(headerKey);
    let headerNumber = null;
    try { headerNumber = Number(BigInt(header?.number)); } catch { /* malformed */ }
    if (cleanHash(header?.hash) === edge.blockHash && headerNumber === candidate.block) {
      out.push(edge);
    }
  }
  return completeLineageProofSet(rows, out);
}

function cleanEdge(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== POSITION_LINEAGE_VERSION
      || raw.proof !== 'receipt-v1') return null;
  const from = String(raw.from || '').trim().toLowerCase();
  const to = String(raw.to || '').trim().toLowerCase();
  const owner = cleanAddress(raw.owner);
  const chainKey = String(raw.chainKey || '').trim().toLowerCase();
  const manager = cleanAddress(raw.manager);
  const expectedManager = cleanAddress(CHAINS[chainKey]?.nfpm);
  const pool = cleanAddress(raw.pool);
  const transactionHash = cleanHash(raw.transactionHash);
  const blockHash = cleanHash(raw.blockHash);
  const block = cleanIndex(raw.block);
  const closeLogIndex = cleanIndex(raw.closeLogIndex);
  const collectLogIndex = cleanIndex(raw.collectLogIndex);
  const openLogIndex = cleanIndex(raw.openLogIndex);
  const at = Number.isFinite(raw.at) && raw.at > 0 ? Number(raw.at) : null;
  const fromTokenId = cleanUint(raw.fromTokenId), toTokenId = cleanUint(raw.toTokenId);
  const fingerprintFields = [
    'decreaseLiquidity', 'decreaseAmount0', 'decreaseAmount1',
    'collectAmount0', 'collectAmount1',
    'increaseLiquidity', 'increaseAmount0', 'increaseAmount1',
  ];
  const fingerprints = Object.fromEntries(fingerprintFields.map((field) => [field, cleanUint(raw[field])]));
  if (!POSITION_KEY_RE.test(from) || !POSITION_KEY_RE.test(to) || from === to
      || !owner || !CHAIN_RE.test(chainKey) || !manager || manager !== expectedManager
      || !pool || !transactionHash || !blockHash || block === null
      || closeLogIndex === null || collectLogIndex === null || openLogIndex === null
      || !(closeLogIndex < collectLogIndex && collectLogIndex < openLogIndex)
      || !at || fromTokenId === null || toTokenId === null
      || Object.values(fingerprints).some((value) => value === null)
      || from !== `${owner}:${chainKey}:${manager}:v3:${fromTokenId}`
      || to !== `${owner}:${chainKey}:${manager}:v3:${toTokenId}`) return null;
  return {
    version: POSITION_LINEAGE_VERSION,
    from,
    to,
    fromTokenId,
    toTokenId,
    owner,
    chainKey,
    manager,
    protocol: 'v3',
    pool,
    transactionHash,
    block,
    blockHash,
    closeLogIndex,
    collectLogIndex,
    openLogIndex,
    ...fingerprints,
    proof: 'receipt-v1',
    at,
  };
}

/** Remove every ambiguous or cyclic edge rather than selecting one. */
export function normalizeLineageEdges(values) {
  const unique = new Map();
  for (const raw of Array.isArray(values) ? values : []) {
    const edge = cleanEdge(raw);
    if (edge) unique.set(`${edge.from}>${edge.to}`, edge);
  }
  const rows = [...unique.values()];
  const fromCounts = new Map(), toCounts = new Map();
  for (const edge of rows) {
    fromCounts.set(edge.from, (fromCounts.get(edge.from) || 0) + 1);
    toCounts.set(edge.to, (toCounts.get(edge.to) || 0) + 1);
  }
  let clean = rows.filter((edge) => fromCounts.get(edge.from) === 1 && toCounts.get(edge.to) === 1);
  const next = new Map(clean.map((edge) => [edge.from, edge.to]));
  const cyclic = new Set();
  for (const edge of clean) {
    const path = new Set();
    let key = edge.from;
    while (next.has(key)) {
      if (path.has(key)) {
        for (const member of path) cyclic.add(member);
        break;
      }
      path.add(key);
      key = next.get(key);
    }
  }
  clean = clean.filter((edge) => !cyclic.has(edge.from) && !cyclic.has(edge.to));
  return clean.sort((a, b) => a.block - b.block || a.closeLogIndex - b.closeLogIndex)
    .slice(-MAX_LINEAGE_EDGES);
}

export function mergeLineageEdges(previous, discovered) {
  return normalizeLineageEdges([...(previous || []), ...(discovered || [])]);
}

const PROOF_FINGERPRINT_FIELDS = [
  'from', 'to', 'transactionHash', 'block',
  'closeLogIndex', 'collectLogIndex', 'openLogIndex',
  'decreaseLiquidity', 'decreaseAmount0', 'decreaseAmount1',
  'collectAmount0', 'collectAmount1',
  'increaseLiquidity', 'increaseAmount0', 'increaseAmount1',
];

/** Stable identity for deduplicating a stored proof from fresh discovery. */
export function lineageProofKey(value) {
  if (!value || typeof value !== 'object') return null;
  const fields = PROOF_FINGERPRINT_FIELDS.map((field) => String(value[field] ?? ''));
  return fields.some((field) => !field) ? null : fields.join('|').toLowerCase();
}

/** Number of distinct receipt validations represented by a set of rows. */
export function lineageReceiptGroupCount(values) {
  const groups = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const chainKey = String(value?.chainKey || '').trim().toLowerCase();
    const transactionHash = cleanHash(value?.transactionHash);
    if (CHAIN_RE.test(chainKey) && transactionHash) groups.add(`${chainKey}:${transactionHash}`);
  }
  return groups.size;
}

/**
 * Return proofs only when every planned edge was proven. This deliberately
 * fails the whole set closed so a missing tail cannot manufacture a false
 * graph head or an incomplete "combined" return.
 */
export function completeLineageProofSet(expected, proven) {
  const expectedRows = Array.isArray(expected) ? expected : [];
  const expectedKeys = expectedRows.map(lineageProofKey);
  if (expectedKeys.some((key) => !key)) return [];
  const wanted = new Set(expectedKeys);
  if (!wanted.size) return [];
  const clean = normalizeLineageEdges(proven);
  const byKey = new Map(clean.map((edge) => [lineageProofKey(edge), edge]));
  if ([...wanted].some((key) => !byKey.has(key))) return [];
  return normalizeLineageEdges([...wanted].map((key) => byKey.get(key)));
}

/** Keep only graph components that touch a position in the accepted view. */
export function relevantLineageEdges(positions, edges) {
  const clean = normalizeLineageEdges(edges);
  const members = new Set((positions || []).map(lineagePositionKey).filter(Boolean));
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of clean) {
      if (!members.has(edge.from) && !members.has(edge.to)) continue;
      if (!members.has(edge.from)) { members.add(edge.from); changed = true; }
      if (!members.has(edge.to)) { members.add(edge.to); changed = true; }
    }
  }
  return clean.filter((edge) => members.has(edge.from) && members.has(edge.to));
}

export async function readLineageState() {
  try {
    const raw = store
      ? (await store.get(POSITION_LINEAGE_KEY))[POSITION_LINEAGE_KEY]
      : memory[POSITION_LINEAGE_KEY];
    return { ok: true, edges: normalizeLineageEdges(raw) };
  } catch {
    return { ok: false, edges: [] };
  }
}

export async function readLineageEdges() {
  return (await readLineageState()).edges;
}

export async function writeLineageEdges(edges) {
  const proposed = normalizeLineageEdges(edges);
  try {
    const current = store
      ? normalizeLineageEdges((await store.get(POSITION_LINEAGE_KEY))[POSITION_LINEAGE_KEY])
      : normalizeLineageEdges(memory[POSITION_LINEAGE_KEY]);
    const value = mergeLineageEdges(current, proposed);
    if (store) await store.set({ [POSITION_LINEAGE_KEY]: value });
    else memory[POSITION_LINEAGE_KEY] = value;
    return value.length;
  } catch {
    return 0;
  }
}

/** Re-fetch receipt and block header before a remembered edge may render. */
export async function validateLineageEdges(
  edges,
  rpcOverrides = {},
  maxValidations = MAX_LINEAGE_VALIDATIONS,
) {
  const clean = normalizeLineageEdges(edges);
  const groups = new Map();
  for (const edge of clean) {
    const key = `${edge.chainKey}:${edge.transactionHash}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(edge);
  }
  const limit = Number.isSafeInteger(maxValidations) && maxValidations >= 0
    ? maxValidations : 0;
  // Never validate a prefix of a connected history and then present the
  // truncated component as complete. An over-budget graph renders no claim.
  if (groups.size > limit) return [];
  const valid = [];
  for (const rows of groups.values()) {
    const edge = rows[0];
    const rpc = rpcOverrides[edge.chainKey] || CHAINS[edge.chainKey]?.rpc;
    if (!rpc) continue;
    try {
      const [receipt, header] = await Promise.all([
        rpcCall(rpc, 'eth_getTransactionReceipt', [edge.transactionHash]),
        rpcCall(rpc, 'eth_getBlockByNumber', [
          `0x${BigInt(edge.block).toString(16)}`, false,
        ]),
      ]);
      const headerHash = cleanHash(header?.hash);
      const receiptHash = cleanHash(receipt?.blockHash);
      let headerNumber = null;
      try { headerNumber = Number(BigInt(header?.number)); } catch { /* malformed */ }
      if (headerHash !== edge.blockHash || receiptHash !== edge.blockHash
          || headerNumber !== edge.block) continue;
      for (const candidate of rows) {
        const reproved = proveLineageReceipt(candidate, receipt);
        if (reproved && reproved.blockHash === candidate.blockHash) valid.push(candidate);
      }
    } catch { /* unavailable proof does not render */ }
  }
  return completeLineageProofSet(clean, valid);
}

function exactPnl(position) {
  const history = position?.history || {};
  const usd = position?.usd || null;
  return usd && !history.unavailable && !usd.returnUnavailable
    && usd.grossAddedExact === true && usd.collectedProceedsExact === true
    && Number.isFinite(usd.pnl) ? usd.pnl : null;
}

/** Attach presentation-only history metadata without changing portfolio totals. */
export function attachPositionLineage(positions, edges) {
  const byKey = new Map((positions || []).map((position) => [lineagePositionKey(position), position]));
  const cleanEdges = normalizeLineageEdges(edges).filter((edge) => {
    const from = byKey.get(edge.from), to = byKey.get(edge.to);
    return (!from || cleanAddress(from.pool) === edge.pool)
      && (!to || cleanAddress(to.pool) === edge.pool);
  });
  if (!cleanEdges.length) return [...(positions || [])];
  const adjacency = new Map(), outgoing = new Map();
  for (const edge of cleanEdges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set());
    adjacency.get(edge.from).add(edge.to);
    adjacency.get(edge.to).add(edge.from);
    outgoing.set(edge.from, edge.to);
  }
  const metadata = new Map(), visited = new Set();
  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue;
    const stack = [start], members = [];
    while (stack.length) {
      const key = stack.pop();
      if (visited.has(key)) continue;
      visited.add(key);
      members.push(key);
      for (const next of adjacency.get(key) || []) stack.push(next);
    }
    const heads = members.filter((key) => !outgoing.has(key));
    if (members.length < 2 || heads.length !== 1) continue;
    const loaded = members.map((key) => byKey.get(key)).filter(Boolean);
    const complete = loaded.length === members.length;
    const pnls = complete ? loaded.map(exactPnl) : [];
    const combinedPnl = complete && pnls.every(Number.isFinite)
      ? pnls.reduce((sum, value) => sum + value, 0) : null;
    for (const key of members) {
      if (!byKey.has(key)) continue;
      metadata.set(key, {
        isHead: key === heads[0],
        memberCount: members.length,
        loadedCount: loaded.length,
        complete,
        combinedPnl,
        proof: 'verified same-transaction replacement',
      });
    }
  }
  return (positions || []).map((position) => {
    const lineage = metadata.get(lineagePositionKey(position));
    return lineage ? { ...position, lineage } : position;
  });
}
