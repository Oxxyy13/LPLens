#!/usr/bin/env node
import assert from 'node:assert/strict';

const storage = {};
let storageFails = false;
globalThis.chrome = {
  storage: { local: {
    async get(key) {
      if (storageFails) throw new Error('storage unavailable');
      return Object.hasOwn(storage, key) ? { [key]: storage[key] } : {};
    },
    async set(values) {
      if (storageFails) throw new Error('storage unavailable');
      Object.assign(storage, values);
    },
  } },
};

const lineage = await import(`../extension/lib/position-lineage.js?t=${Date.now()}`);
const { CHAINS } = await import('../extension/lib/chains.js');
const { TOPIC } = await import('../extension/lib/history.js');

const OWNER = `0x${'11'.repeat(20)}`;
const POOL = `0x${'22'.repeat(20)}`;
const TOKEN0 = `0x${'33'.repeat(20)}`;
const TOKEN1 = `0x${'44'.repeat(20)}`;
const TX = `0x${'55'.repeat(32)}`;
const BLOCK_HASH = `0x${'66'.repeat(32)}`;
const MANAGER = CHAINS.ethereum.nfpm.toLowerCase();
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const topicAddress = (address) => `0x${address.slice(2).padStart(64, '0')}`;
const topicId = (id) => `0x${word(id)}`;
const data = (...values) => `0x${values.map(word).join('')}`;
const addrWord = (address) => address.slice(2).padStart(64, '0');

function position(tokenId, overrides = {}) {
  return {
    ownerAddress: OWNER,
    chainKey: 'ethereum',
    version: 'v3',
    tokenId: BigInt(tokenId),
    pool: POOL,
    token0: TOKEN0,
    token1: TOKEN1,
    fee: 3000,
    tickLower: -120,
    tickUpper: 120,
    liquidity: 100n,
    tokensOwed0: 0n,
    tokensOwed1: 0n,
    status: 'in-range',
    history: {
      deposits: [{
        block: 100,
        transactionHash: TX,
        logIndex: tokenId === 2 ? 13 : 1,
        liquidityRaw: tokenId === 2 ? '80' : '100',
        amount0Raw: tokenId === 2 ? '35' : '50',
        amount1Raw: tokenId === 2 ? '45' : '50',
      }],
      collections: [],
    },
    usd: {
      pnl: tokenId === 1 ? 10 : 5,
      grossAddedExact: true,
      collectedProceedsExact: true,
      returnUnavailable: null,
    },
    ...overrides,
  };
}

const oldPosition = position(1, {
  liquidity: 0n,
  status: 'closed',
  history: {
    deposits: [{
      block: 50, transactionHash: `0x${'77'.repeat(32)}`, logIndex: 1,
      liquidityRaw: '100', amount0Raw: '50', amount1Raw: '50',
    }],
    closedAt: {
      block: 100, transactionHash: TX, logIndex: 10,
      liquidityRaw: '100', amount0Raw: '40', amount1Raw: '60',
    },
    collections: [{
      block: 100, transactionHash: TX, logIndex: 11,
      amount0Raw: '42', amount1Raw: '63',
    }],
  },
});
const newPosition = position(2);
const candidates = lineage.discoverLineageCandidates([oldPosition, newPosition], 1000);
assert.equal(candidates.length, 1);
const candidate = candidates[0];

function log(topic0, tokenId, logIndex, payload, topics = null) {
  return {
    address: MANAGER,
    topics: topics || [topic0, topicId(tokenId)],
    data: payload,
    logIndex: `0x${logIndex.toString(16)}`,
  };
}

function receipt(overrides = {}) {
  return {
    status: '0x1',
    transactionHash: TX,
    blockNumber: '0x64',
    blockHash: BLOCK_HASH,
    logs: [
      log(TOPIC.decrease, 1, 10, data(100, 40, 60)),
      log(TOPIC.collect, 1, 11, `0x${addrWord(OWNER)}${word(42)}${word(63)}`),
      log(TRANSFER, 2, 12, '0x', [
        TRANSFER, topicAddress(`0x${'00'.repeat(20)}`), topicAddress(OWNER), topicId(2),
      ]),
      log(TOPIC.increase, 2, 13, data(80, 35, 45)),
    ],
    ...overrides,
  };
}

const proven = lineage.proveLineageReceipt(candidate, receipt());
assert.ok(proven);
assert.equal(proven.proof, 'receipt-v1');
assert.equal(proven.blockHash, BLOCK_HASH);

const wrongRecipient = receipt();
wrongRecipient.logs[1] = log(
  TOPIC.collect, 1, 11, `0x${addrWord(`0x${'99'.repeat(20)}`)}${word(42)}${word(63)}`,
);
assert.equal(lineage.proveLineageReceipt(candidate, wrongRecipient), null);

const missingMint = receipt({ logs: receipt().logs.filter((row) => row.topics[0] !== TRANSFER) });
assert.equal(lineage.proveLineageReceipt(candidate, missingMint), null);

const extraAction = receipt();
extraAction.logs.push(log(TOPIC.increase, 9, 14, data(1, 1, 1)));
assert.equal(lineage.proveLineageReceipt(candidate, extraAction), null);
assert.equal(lineage.proveLineageReceipt(candidate, receipt({ logs: {} })), null,
  'a malformed receipt log collection must fail closed');
const malformedExtraAction = receipt();
malformedExtraAction.logs.push({
  ...log(TOPIC.increase, 9, 14, data(1, 1, 1)),
  logIndex: 'not-a-quantity',
});
assert.equal(lineage.proveLineageReceipt(candidate, malformedExtraAction), null,
  'a recognized manager action with a malformed index must remain ambiguous');
assert.equal(lineage.proveLineageReceipt(candidate, receipt({ status: '0x0' })), null);

assert.equal(lineage.discoverLineageCandidates([
  { ...oldPosition, tokensOwed0: 1n }, newPosition,
]).length, 0, 'a predecessor with owed assets is not fully closed');
assert.equal(lineage.discoverLineageCandidates([
  oldPosition, { ...newPosition, version: 'v4' },
]).length, 0, 'v4 must remain unsupported');

const edge = lineage.normalizeLineageEdges([proven]);
assert.equal(edge.length, 1);
assert.equal(lineage.relevantLineageEdges([newPosition], edge).length, 1);
assert.equal(lineage.relevantLineageEdges([position(99)], edge).length, 0,
  'unrelated wallets and positions must not trigger receipt revalidation');
const attached = lineage.attachPositionLineage([oldPosition, newPosition], edge);
assert.equal(attached[1].lineage.isHead, true);
assert.equal(attached[1].lineage.memberCount, 2);
assert.equal(attached[1].lineage.combinedPnl, 15);
assert.equal(lineage.attachPositionLineage([newPosition], edge)[0].lineage.combinedPnl, null);
assert.equal(lineage.attachPositionLineage([
  { ...newPosition, pool: `0x${'aa'.repeat(20)}` },
], edge)[0].lineage, undefined, 'stored pool identity must match the current position');

// Conflicting outgoing edges are all discarded rather than guessed.
const conflict = { ...proven, to: proven.to.replace(/:2$/, ':3'), toTokenId: '3' };
assert.equal(lineage.normalizeLineageEdges([proven, conflict]).length, 0);
const manyEdges = Array.from({ length: lineage.MAX_LINEAGE_EDGES + 1 }, (_, index) => ({
  ...proven,
  from: proven.from.replace(/:1$/, `:${index + 1}`),
  to: proven.to.replace(/:2$/, `:${index + 2}`),
  fromTokenId: String(index + 1),
  toTokenId: String(index + 2),
  block: proven.block + index,
  closeLogIndex: 10,
  collectLogIndex: 11,
  openLogIndex: 13,
}));
assert.equal(lineage.normalizeLineageEdges(manyEdges).length, lineage.MAX_LINEAGE_EDGES,
  'the local replacement graph must stay bounded');
assert.equal(lineage.lineageProofKey(candidate), lineage.lineageProofKey(proven),
  'fresh discovery must deduplicate the same stored proof');
assert.equal(lineage.lineageReceiptGroupCount([candidate, proven]), 1);

let headerHash = BLOCK_HASH;
let headerNumber = '0x64';
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const result = body.method === 'eth_getTransactionReceipt'
    ? receipt()
    : { number: headerNumber, hash: headerHash };
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({
    jsonrpc: '2.0', id: body.id, result,
  }) };
};
assert.equal((await lineage.proveLineageCandidates(candidates)).length, 1,
  'fresh discovery must validate its canonical block header');
headerHash = `0x${'88'.repeat(32)}`;
assert.equal((await lineage.proveLineageCandidates(candidates)).length, 0,
  'fresh discovery must reject a non-canonical receipt block');
headerHash = BLOCK_HASH;
headerNumber = '0x65';
assert.equal((await lineage.proveLineageCandidates(candidates)).length, 0,
  'fresh discovery must reject a mismatched block number');
headerNumber = '0x64';
assert.equal((await lineage.validateLineageEdges(edge)).length, 1);
headerHash = `0x${'88'.repeat(32)}`;
assert.equal((await lineage.validateLineageEdges(edge)).length, 0,
  'a changed canonical block hash must make stored proof unavailable');
headerHash = BLOCK_HASH;
headerNumber = '0x65';
assert.equal((await lineage.validateLineageEdges(edge)).length, 0,
  'a stored proof must reject a mismatched canonical block number');
headerNumber = '0x64';

let requestCount = 0;
globalThis.fetch = async () => {
  requestCount++;
  throw new Error('an over-budget proof set must not make a request');
};
const overBudget = Array.from({ length: lineage.MAX_LINEAGE_VALIDATIONS + 1 }, (_, index) => ({
  ...proven,
  from: proven.from.replace(/:1$/, `:${index * 2 + 10}`),
  to: proven.to.replace(/:2$/, `:${index * 2 + 11}`),
  fromTokenId: String(index * 2 + 10),
  toTokenId: String(index * 2 + 11),
  transactionHash: `0x${(index + 1).toString(16).padStart(64, '0')}`,
  block: 1_000 + index,
}));
assert.equal(lineage.lineageReceiptGroupCount(overBudget), lineage.MAX_LINEAGE_VALIDATIONS + 1);
assert.equal(lineage.lineageReceiptGroupCount([
  ...overBudget.slice(0, 49), ...overBudget.slice(49, 51),
]), 51, 'stored and newly discovered groups must share one budget');
assert.equal((await lineage.validateLineageEdges(overBudget)).length, 0,
  'over-budget stored graphs must fail closed instead of rendering a prefix');
const overBudgetCandidates = overBudget.map(({ blockHash: _blockHash, proof: _proof, ...row }) => row);
assert.equal((await lineage.proveLineageCandidates(overBudgetCandidates)).length, 0,
  'over-budget discovery must fail closed instead of storing a prefix');
assert.equal(requestCount, 0);
assert.equal(lineage.completeLineageProofSet(overBudget.slice(0, 2), overBudget.slice(0, 1)).length, 0,
  'a partially proven chain must not manufacture an intermediate head');
assert.equal(lineage.completeLineageProofSet(overBudget.slice(0, 2), overBudget.slice(0, 2)).length, 2);

assert.equal(await lineage.writeLineageEdges(edge), 1);
assert.equal(await lineage.writeLineageEdges([]), 1,
  'a best-effort merge must not erase an existing proof');
assert.equal((await lineage.readLineageEdges()).length, 1);
storageFails = true;
assert.deepEqual(await lineage.readLineageState(), { ok: false, edges: [] });
assert.equal(await lineage.writeLineageEdges(edge), 0,
  'a failed read must not overwrite recoverable local proofs');

console.log('position lineage: unique receipt proof, ambiguity, PnL and reorg checks pass');
