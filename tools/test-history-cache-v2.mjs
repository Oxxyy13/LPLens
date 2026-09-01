#!/usr/bin/env node
import assert from 'node:assert/strict';

// cache.js captures chrome.storage.local when the module is evaluated. Keep a
// transparent backing object so this test can also inspect migration effects.
const rows = {};
const local = {
  async get(keys) {
    if (keys === null || keys === undefined) return { ...rows };
    if (typeof keys === 'string') {
      return Object.prototype.hasOwnProperty.call(rows, keys)
        ? { [keys]: rows[keys] } : {};
    }
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys
        .filter((key) => Object.prototype.hasOwnProperty.call(rows, key))
        .map((key) => [key, rows[key]]));
    }
    return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [
      key, Object.prototype.hasOwnProperty.call(rows, key) ? rows[key] : fallback,
    ]));
  },
  async set(values) { Object.assign(rows, values); },
  async remove(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete rows[key];
  },
};

globalThis.chrome = { storage: { local } };

const cache = await import(`../extension/lib/cache.js?cache-v2=${Date.now()}`);
const history = await import('../extension/lib/history.js');
const logs = await import('../extension/lib/logs.js');

const NFPM = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
const TOKEN0 = '0x' + '11'.repeat(20);
const TOKEN1 = '0x' + '22'.repeat(20);
const HASH_A = '0x' + 'aa'.repeat(32);
const HASH_B = '0x' + 'bb'.repeat(32);
const HASH_C = '0x' + 'cc'.repeat(32);
const word = (value) => BigInt(value).toString(16).padStart(64, '0');

const position = {
  token0: TOKEN0,
  token1: TOKEN1,
  fee: 3000,
  tickLower: -120,
  tickUpper: 120,
};
const identity = cache.historyIdentity(position);
assert.equal(
  identity,
  `${TOKEN0.toLowerCase()}:${TOKEN1.toLowerCase()}:3000:-120:120`,
  'static identity must be canonical and include every immutable v3 field',
);
assert.equal(cache.historyIdentity({}), null, 'missing identity fields must fail closed');
assert.equal(cache.historyIdentity({ ...position, tickUpper: -120 }), null,
  'an invalid static range must fail closed');

const event = ({
  kind = 'increase', block, tx, index = 0, liquidity = 1n,
  amount0 = 2n, amount1 = 3n,
}) => ({
  kind,
  block,
  time: null,
  transactionHash: tx,
  logIndex: index,
  liquidity,
  amount0,
  amount1,
});

// The same NFPM address and token ID exist independently on several chains.
// A cache hit must therefore require chain as well as NFT and static identity.
const ethereumEvent = event({ block: 10, tx: HASH_A, liquidity: 100n });
const arbitrumEvent = event({ block: 20, tx: HASH_B, liquidity: 200n });
await cache.writeHistory({
  chainKey: 'ethereum', nfpm: NFPM, tokenId: 7n, identity,
  fp: 'eth-fingerprint', events: [ethereumEvent], source: 'ethereum-fixture',
  checkedThrough: 100, anchorBlock: 90, anchorHash: HASH_A,
});
await cache.writeHistory({
  chainKey: 'arbitrum', nfpm: NFPM, tokenId: 7n, identity,
  fp: 'arb-fingerprint', events: [arbitrumEvent], source: 'arbitrum-fixture',
  checkedThrough: 200, anchorBlock: 190, anchorHash: HASH_B,
});

const ethereumHit = await cache.readHistoryAny('ethereum', NFPM, 7n, identity);
const arbitrumHit = await cache.readHistoryAny('arbitrum', NFPM, 7n, identity);
assert.equal(ethereumHit.events[0].liquidity, 100n);
assert.equal(arbitrumHit.events[0].liquidity, 200n);
assert.equal(ethereumHit.checkedThrough, 100);
assert.equal(ethereumHit.anchorBlock, 90);
assert.equal(ethereumHit.anchorHash, HASH_A);
assert.equal(await cache.readHistoryAny('polygon', NFPM, 7n, identity), null,
  'a cache row from another chain must never be reused');
assert.equal(await cache.readHistoryAny(
  'ethereum', NFPM, 7n, cache.historyIdentity({ ...position, fee: 500 }),
), null, 'a static-identity mismatch must be a cache miss');

// Version 1 had no chain namespace. It is ignored, then removed only after a
// valid v2 replacement has been stored. Unrelated extension data must survive.
const legacyTokenId = 808n;
const legacyKey = `hist:${NFPM.toLowerCase()}:${legacyTokenId}`;
rows[legacyKey] = {
  fp: 'old', source: 'legacy', at: 1,
  events: [{ k: 'increase', b: 1, t: null, x: HASH_C, i: 0, l: '1', a0: '1', a1: '1' }],
};
rows.settings = { keep: true };
assert.equal(await cache.readHistoryAny('ethereum', NFPM, legacyTokenId, identity), null,
  'unnamespaced v1 rows must be ignored');
assert.ok(rows[legacyKey], 'a read-only miss must not destructively migrate data');
await cache.writeHistory({
  chainKey: 'ethereum', nfpm: NFPM, tokenId: legacyTokenId, identity,
  fp: 'new', events: [event({ block: 5, tx: HASH_C })], source: 'fixture',
  checkedThrough: 8, anchorBlock: 5, anchorHash: HASH_C,
});
assert.equal(rows[legacyKey], undefined, 'v1 row must be removed after v2 replacement');
assert.deepEqual(rows.settings, { keep: true }, 'migration must preserve unrelated storage');

// Malformed checkpoints and rows are never eligible for reuse.
const rejectedTokenId = 809n;
await cache.writeHistory({
  chainKey: 'ethereum', nfpm: NFPM, tokenId: rejectedTokenId, identity,
  fp: 'bad', events: [event({ block: 9, tx: HASH_A })], source: 'fixture',
  checkedThrough: 8, anchorBlock: 5, anchorHash: HASH_A,
});
assert.equal(await cache.readHistoryAny('ethereum', NFPM, rejectedTokenId, identity), null,
  'an event beyond checkedThrough must not be stored');

const corruptKey = `hist:v2:ethereum:${NFPM.toLowerCase()}:810`;
rows[corruptKey] = {
  v: 2, identity, fp: 'bad', source: 'fixture', at: Date.now(),
  checkedThrough: 100, anchorBlock: 101, anchorHash: HASH_A,
  events: [{ k: 'increase', b: 10, t: null, x: HASH_A, i: 0, l: '1', a0: '1', a1: '1' }],
};
assert.equal(await cache.readHistoryAny('ethereum', NFPM, 810n, identity), null,
  'an anchor beyond checkedThrough must fail closed');

// Re-reading from the overlap replaces an orphaned tail, while the verified
// prefix remains. Offsetting liquidity changes still count as changed history.
const prefix = event({ block: 10, tx: HASH_A, liquidity: 100n });
const orphan = event({ kind: 'collect', block: 95, tx: HASH_B, liquidity: 0n, amount0: 9n });
const canonicalTail = [
  event({ kind: 'increase', block: 91, tx: '0x' + '31'.repeat(32), liquidity: 10n }),
  event({ kind: 'decrease', block: 92, tx: '0x' + '32'.repeat(32), liquidity: 10n }),
  event({ kind: 'collect', block: 93, tx: '0x' + '33'.repeat(32), liquidity: 0n }),
];
const replaced = history.replaceHistoryTail([prefix, orphan], 90, canonicalTail);
assert.deepEqual(replaced.map((item) => item.block), [10, 91, 92, 93]);
assert.ok(!replaced.some((item) => item.transactionHash === HASH_B),
  'the old non-final tail must not survive canonical replacement');
assert.equal(history.reconciles(replaced, 100n), true,
  'offsetting tail events can preserve the same mutable position fingerprint');
assert.equal(history.historyChanged([prefix], replaced), true,
  'same ending liquidity must not hide new cash-flow events');

const semanticBefore = event({ block: 50, tx: HASH_C, index: 4, amount0: 10n });
const semanticAfter = event({ block: 51, tx: HASH_C, index: 4, amount0: 11n });
assert.equal(history.historyChanged([semanticBefore], [semanticAfter]), true,
  'the same transaction/log identity with changed canonical semantics is a reorg change');

// Bounded reads must preserve numeric range semantics. Empty is a valid tail
// fact, but not a valid lifetime when requireNonEmpty is set.
const originalFetch = globalThis.fetch;
let calls = [];
const rpcReply = (result, id = 1) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ jsonrpc: '2.0', id, result }),
});

globalThis.fetch = async (_input, init = {}) => {
  const body = JSON.parse(init.body);
  calls.push(body);
  return rpcReply([], body.id);
};
const emptyTail = await logs.fetchPositionLogsRange({
  nfpm: NFPM, tokenId: 7n, rpc: 'https://rpc.fixture.invalid',
  fromBlock: 42, toBlock: 77,
});
assert.equal(emptyTail.source, 'rpc-tail');
assert.deepEqual([emptyTail.fromBlock, emptyTail.toBlock], [42, 77]);
assert.equal(calls[0].method, 'eth_getLogs');
assert.equal(calls[0].params[0].fromBlock, '0x2a');
assert.equal(calls[0].params[0].toBlock, '0x4d');

calls = [];
const emptyLifetime = await logs.fetchPositionLogsRange({
  nfpm: NFPM, tokenId: 7n, rpc: 'https://rpc.fixture.invalid',
  fromBlock: 0, toBlock: 77, requireNonEmpty: true,
});
assert.match(emptyLifetime.unavailable, /zero logs for a position lifetime/);

// Explorer fallback receives the exact requested bounds too. A 400 response
// makes the RPC refusal deterministic and avoids retry delays.
let blockscoutUrl = null;
globalThis.fetch = async (input, init = {}) => {
  if (init.body) {
    return {
      ok: false,
      status: 400,
      headers: { get: () => null },
      json: async () => ({ error: { message: 'range unsupported' } }),
    };
  }
  blockscoutUrl = new URL(String(input));
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: '0', message: 'No logs found', result: [] }),
  };
};
const explorerTail = await logs.fetchPositionLogsRange({
  nfpm: NFPM, tokenId: 7n, rpc: 'https://rpc.fixture.invalid',
  blockscout: 'https://blockscout.fixture.invalid/api',
  fromBlock: 1234, toBlock: 2345,
});
assert.equal(explorerTail.source, 'blockscout-tail');
assert.equal(blockscoutUrl.searchParams.get('fromBlock'), '1234');
assert.equal(blockscoutUrl.searchParams.get('toBlock'), '2345');

// Numeric checkpoints must prove the exact requested block, not merely return
// some well-formed header. Latest is allowed to resolve to its returned head.
globalThis.fetch = async (_input, init = {}) => {
  const body = JSON.parse(init.body);
  return rpcReply({ number: '0x65', hash: HASH_A }, body.id);
};
const wrongCheckpoint = await logs.fetchBlockCheckpoint('https://rpc.fixture.invalid', 100);
assert.match(wrongCheckpoint.unavailable, /did not match the requested block/);

globalThis.fetch = async (_input, init = {}) => {
  const body = JSON.parse(init.body);
  return rpcReply({ number: '0x64', hash: HASH_B.toUpperCase().replace('0X', '0x') }, body.id);
};
assert.deepEqual(
  await logs.fetchBlockCheckpoint('https://rpc.fixture.invalid', 100),
  { block: 100, hash: HASH_B },
);

// Exercise the wiring through loadPosition, not only the cache helpers. The
// previous cache ends at block 200 with a trusted block-100 anchor. A refresh
// at block 300 must prove block 100, replace 101..300, then persist a new
// block-172 anchor (300 minus the 128-block reorg overlap).
const { CHAINS, v3Deployment } = await import('../extension/lib/chains.js');
const { loadPosition } = await import('../extension/lib/positions.js');
const chainKey = 'ethereum';
const deployment = v3Deployment(chainKey);
const factory = deployment.factory;
const pool = '0x' + '42'.repeat(20);
const owner = '0x' + '43'.repeat(20);
const integrationTokenId = 9001n;
const integrationPosition = {
  token0: TOKEN0,
  token1: TOKEN1,
  fee: 3000,
  tickLower: -120,
  tickUpper: 120,
  liquidity: 100n,
  feeGrowthInside0LastX128: 0n,
  feeGrowthInside1LastX128: 0n,
  tokensOwed0: 0n,
  tokensOwed1: 0n,
};
const integrationIdentity = cache.historyIdentity(integrationPosition);
const integrationFingerprint = cache.fingerprint(integrationPosition);
const orphanTx = '0x' + '51'.repeat(32);
const canonicalTxs = [
  '0x' + '52'.repeat(32),
  '0x' + '53'.repeat(32),
  '0x' + '54'.repeat(32),
];
const oldAnchorHash = '0x' + '61'.repeat(32);
const newAnchorHash = '0x' + '62'.repeat(32);
const headHash = '0x' + '63'.repeat(32);

assert.equal(deployment.nfpm.toLowerCase(), NFPM.toLowerCase());
const originalBlockscout = CHAINS[chainKey].blockscout;
// Force this wiring fixture through the mocked raw-RPC path. Deployment
// identity still comes from the production registry added for multi-manager
// support, instead of inventing a chain after that registry has been frozen.
CHAINS[chainKey].blockscout = null;

await cache.writeHistory({
  chainKey,
  nfpm: NFPM,
  tokenId: integrationTokenId,
  identity: integrationIdentity,
  fp: integrationFingerprint,
  events: [
    event({ block: 50, tx: HASH_A, liquidity: 100n, amount0: 1_000n, amount1: 1_000n }),
    event({ kind: 'collect', block: 150, tx: orphanTx, liquidity: 0n, amount0: 99n }),
  ],
  source: 'old-cache-fixture',
  checkedThrough: 200,
  anchorBlock: 100,
  anchorHash: oldAnchorHash,
});

const signedWord = (value) => word(value < 0 ? (1n << 256n) + BigInt(value) : BigInt(value));
const positionHex = '0x' + [
  word(0n),
  word(0n),
  word(BigInt(TOKEN0)),
  word(BigInt(TOKEN1)),
  word(3000n),
  signedWord(-120),
  signedWord(120),
  word(100n),
  word(0n),
  word(0n),
  word(0n),
  word(0n),
].join('');
const integrationLogs = [
  {
    address: NFPM,
    topics: [history.TOPIC.increase, '0x' + word(integrationTokenId)],
    data: '0x' + word(10n) + word(100n) + word(100n),
    blockNumber: '0x6e',
    transactionHash: canonicalTxs[0],
    logIndex: '0x0',
  },
  {
    address: NFPM,
    topics: [history.TOPIC.decrease, '0x' + word(integrationTokenId)],
    data: '0x' + word(10n) + word(50n) + word(50n),
    blockNumber: '0x6f',
    transactionHash: canonicalTxs[1],
    logIndex: '0x0',
  },
  {
    address: NFPM,
    topics: [history.TOPIC.collect, '0x' + word(integrationTokenId)],
    data: '0x' + word(0n) + word(50n) + word(50n),
    blockNumber: '0x70',
    transactionHash: canonicalTxs[2],
    logIndex: '0x0',
  },
];

const getLogRanges = [];
const checkpointTags = [];
globalThis.fetch = async (_input, init = {}) => {
  const body = JSON.parse(init.body);
  if (body.method === 'eth_getBlockByNumber') {
    const tag = body.params[0];
    checkpointTags.push(tag);
    if (tag === 'latest') {
      return rpcReply({ number: '0x12c', hash: headHash }, body.id);
    }
    if (tag === '0x64') {
      return rpcReply({ number: '0x64', hash: oldAnchorHash }, body.id);
    }
    if (tag === '0xac') {
      return rpcReply({ number: '0xac', hash: newAnchorHash }, body.id);
    }
    throw new Error(`unexpected checkpoint ${tag}`);
  }
  if (body.method === 'eth_getLogs') {
    const filter = body.params[0];
    getLogRanges.push([filter.fromBlock, filter.toBlock]);
    return rpcReply(integrationLogs, body.id);
  }
  if (body.method !== 'eth_call') throw new Error(`unexpected method ${body.method}`);
  const call = body.params[0];
  const target = String(call.to).toLowerCase();
  const selector = call.data.slice(0, 10).toLowerCase();
  if (target === NFPM.toLowerCase() && selector === '0x99fbab88') {
    return rpcReply(positionHex, body.id);
  }
  if (target === NFPM.toLowerCase() && selector === '0x6352211e') {
    return rpcReply('0x' + word(BigInt(owner)), body.id);
  }
  if (target === factory.toLowerCase() && selector === '0x1698ee82') {
    return rpcReply('0x' + word(BigInt(pool)), body.id);
  }
  if (target === pool.toLowerCase() && selector === '0x3850c7bd') {
    return rpcReply('0x' + word(1n << 96n) + word(0n), body.id);
  }
  if ((target === TOKEN0.toLowerCase() || target === TOKEN1.toLowerCase())
      && selector === '0x95d89b41') {
    const symbol = target === TOKEN0.toLowerCase() ? 'TOKEN0' : 'TOKEN1';
    return rpcReply('0x' + Buffer.from(symbol, 'utf8').toString('hex').padEnd(64, '0'), body.id);
  }
  if ((target === TOKEN0.toLowerCase() || target === TOKEN1.toLowerCase())
      && selector === '0x313ce567') {
    return rpcReply('0x' + word(18n), body.id);
  }
  if (target === NFPM.toLowerCase() && selector === '0xfc6f7865') {
    return rpcReply('0x' + word(0n) + word(0n), body.id);
  }
  throw new Error(`unexpected eth_call ${target} ${selector}`);
};

const integrated = await loadPosition(chainKey, integrationTokenId, {
  rpcOverride: 'https://history-wiring.fixture.invalid',
  withUsd: false,
});
assert.equal(integrated.history.unavailable, undefined);
assert.deepEqual(getLogRanges, [['0x65', '0x12c']],
  'incremental refresh must replace exactly anchor + 1 through captured head');
assert.deepEqual(checkpointTags, ['latest', '0x64', '0xac'],
  'refresh must verify the old anchor and persist the new overlap anchor');

const advanced = await cache.readHistoryAny(
  chainKey, NFPM, integrationTokenId, integrationIdentity,
);
assert.equal(advanced.checkedThrough, 300);
assert.equal(advanced.anchorBlock, 172);
assert.equal(advanced.anchorHash, newAnchorHash);
assert.ok(!advanced.events.some((item) => item.transactionHash === orphanTx),
  'the integration path must remove an orphaned cached tail event');
assert.deepEqual(
  advanced.events.filter((item) => canonicalTxs.includes(item.transactionHash))
    .map((item) => item.block),
  [110, 111, 112],
);
assert.equal(history.reconciles(advanced.events, 100n), true);
CHAINS[chainKey].blockscout = originalBlockscout;

globalThis.fetch = originalFetch;
delete globalThis.chrome;

console.log('history cache v2: chain identity, migration, checkpoints, overlap and exact ranges are hardened');
