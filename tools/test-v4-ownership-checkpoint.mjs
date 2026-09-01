#!/usr/bin/env node
import assert from 'node:assert/strict';

const rows = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (keys === null) return { ...rows };
        if (typeof keys === 'string') return Object.hasOwn(rows, keys) ? { [keys]: rows[keys] } : {};
        return {};
      },
      async set(values) { Object.assign(rows, values); },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete rows[key];
      },
    },
  },
};

const OWNER = '0x' + '11'.repeat(20);
const OTHER = '0x' + '33'.repeat(20);
const MANAGER = '0x' + '22'.repeat(20);
const RPC = 'https://checkpoint.invalid';
const HASH_90 = '0x' + '90'.repeat(32);
const HASH_90_REORG = '0x' + '91'.repeat(32);
const HASH_100 = '0x' + '10'.repeat(32);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const addressWord = (address) => address.slice(2).padStart(64, '0');
const result = (value, id = 1) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ jsonrpc: '2.0', id, result: value }),
});
const transferLog = ({ tokenId, direction, index }) => ({
  blockNumber: '0x5f',
  logIndex: '0x' + index.toString(16),
  transactionHash: '0x' + String(index + 1).padStart(64, '0'),
  topics: [
    TRANSFER,
    '0x' + addressWord(direction === 'out' ? OWNER : OTHER),
    '0x' + addressWord(direction === 'in' ? OWNER : OTHER),
    '0x' + word(tokenId),
  ],
  data: '0x',
});

const { CHAINS } = await import('../extension/lib/chains.js');
const prior = { ...CHAINS.base };
CHAINS.base.v4PositionManager = MANAGER;
CHAINS.base.blockscout = null;
CHAINS.base.logsRpc = RPC;
const cache = await import(`../extension/lib/v4-ownership-cache.js?t=${Date.now()}`);
const { enumerateV4 } = await import(`../extension/lib/v4.js?t=${Date.now()}`);
const { fetchTransfers } = await import(`../extension/lib/logs.js?t=${Date.now()}`);

let owners = new Map([['7', OWNER], ['8', OWNER]]);
let transfers = [];
let logCalls = 0;
let anchorHash90 = HASH_90;
let stateBlocks = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, init = {}) => {
  const body = JSON.parse(init.body);
  if (Array.isArray(body)) {
    return {
      ok: true,
      status: 200,
      json: async () => body.map((request) => {
        stateBlocks.push(request.params[1]);
        const id = BigInt('0x' + request.params[0].data.slice(-64)).toString();
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: '0x' + addressWord(owners.get(id) || OTHER),
        };
      }),
    };
  }
  if (body.method === 'eth_getBlockByNumber') {
    const tag = body.params[0];
    const number = tag === 'latest' ? 100 : Number(BigInt(tag));
    return result({
      number: '0x' + number.toString(16),
      hash: number === 90 ? anchorHash90 : HASH_100,
    }, body.id);
  }
  if (body.method === 'eth_call') {
    stateBlocks.push(body.params[1]);
    const data = body.params[0].data;
    if (data.startsWith('0x70a08231')) return result('0x' + word(2), body.id);
    if (data.startsWith('0x6352211e')) {
      const id = BigInt('0x' + data.slice(-64)).toString();
      return result('0x' + addressWord(owners.get(id) || OTHER), body.id);
    }
  }
  if (body.method === 'eth_getLogs') {
    logCalls++;
    const topics = body.params[0].topics;
    const direction = topics[1] ? 'out' : 'in';
    return result(transfers.filter((event) => event.direction === direction)
      .map((event) => transferLog(event)), body.id);
  }
  throw new Error(`unexpected RPC method ${body.method}`);
};

try {
  await cache.writeV4OwnershipCheckpoint({
    chainKey: 'base', manager: MANAGER, owner: OWNER,
    checkedThrough: 90, checkpointHash: HASH_90,
    balanceOf: 2, tokenIds: [7n, 8n], source: 'fixture',
  });

  const unchanged = await enumerateV4('base', OWNER, { rpcOverride: RPC });
  assert.deepEqual(unchanged.tokenIds, [7n, 8n]);
  assert.equal(unchanged.source, 'ownership-checkpoint+ownerOf');
  assert.equal(logCalls, 0, 'an unchanged exact checkpoint must not request Transfer logs');
  assert.ok(stateBlocks.length > 0);
  assert.ok(stateBlocks.every((block) => block === '0x64'),
    'balanceOf and ownerOf must share the captured block tag');

  // Restore the older checkpoint, then model a same-count swap. balanceOf is
  // unchanged, but ownerOf invalidates ID 7 and the bounded tail discovers 9.
  await cache.writeV4OwnershipCheckpoint({
    chainKey: 'base', manager: MANAGER, owner: OWNER,
    checkedThrough: 90, checkpointHash: HASH_90,
    balanceOf: 2, tokenIds: [7n, 8n], source: 'fixture',
  });
  owners = new Map([['7', OTHER], ['8', OWNER], ['9', OWNER]]);
  transfers = [
    { tokenId: 7n, direction: 'out', index: 1 },
    { tokenId: 9n, direction: 'in', index: 2 },
  ];
  logCalls = 0;
  stateBlocks = [];
  const swapped = await enumerateV4('base', OWNER, { rpcOverride: RPC });
  assert.deepEqual(swapped.tokenIds, [8n, 9n]);
  assert.equal(swapped.source, 'ownership-checkpoint+tail+ownerOf');
  assert.ok(logCalls > 0, 'a failed checkpoint proof must read only a bounded tail');
  assert.ok(stateBlocks.every((block) => block === '0x64'),
    'tail reconciliation must keep state proofs at the captured block');

  transfers = [
    { tokenId: 8n, direction: 'out', index: 4 },
    { tokenId: 8n, direction: 'in', index: 4 },
  ];
  const selfTransfer = await fetchTransfers({
    contract: MANAGER,
    owner: OWNER,
    rpc: RPC,
    fromBlock: 91,
    toBlock: 100,
    rpcOnly: true,
  });
  assert.deepEqual(selfTransfer.events, [], 'a self-transfer must be an ownership no-op');

  // A changed anchor hash invalidates the checkpoint and forces an
  // authoritative reconstruction. Stale checkpoint output is never accepted.
  await cache.writeV4OwnershipCheckpoint({
    chainKey: 'base', manager: MANAGER, owner: OWNER,
    checkedThrough: 90, checkpointHash: HASH_90,
    balanceOf: 2, tokenIds: [7n, 8n], source: 'fixture',
  });
  anchorHash90 = HASH_90_REORG;
  owners = new Map([['8', OWNER], ['9', OWNER]]);
  transfers = [
    { tokenId: 8n, direction: 'in', index: 5 },
    { tokenId: 9n, direction: 'in', index: 6 },
  ];
  logCalls = 0;
  stateBlocks = [];
  const rebuilt = await enumerateV4('base', OWNER, { rpcOverride: RPC });
  assert.deepEqual(rebuilt.tokenIds, [8n, 9n]);
  assert.equal(rebuilt.source, 'transfer-logs+ownerOf');
  assert.match(rebuilt.indexWarning || '', /invalidated by a block change/);
  assert.ok(logCalls > 0, 'a reorged checkpoint must rebuild ownership');
  assert.ok(stateBlocks.every((block) => block === '0x64'),
    'reorg recovery must keep state proofs at the captured block');
} finally {
  globalThis.fetch = originalFetch;
  Object.assign(CHAINS.base, prior);
}

console.log('v4 ownership checkpoint: warm reuse and same-count tail repair pass');
