#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  decodeV4LiquidityLogs, inferSimpleV4Mint, inferSimpleV4TraceAddition,
  fetchV4Receipt, validateSimpleV4Receipt, V4_TOPIC,
} from '../extension/lib/v4.js';
import { CHAINS } from '../extension/lib/chains.js';

const TX = '0x00e8fa6cc9dd87fe357bb5da81e6c399f7cde8228fb022e1505bc4b25eb36ff5';
const POSITION_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const POOL_ID = '0x9ce47988f23c15b4922c8015fdca777329de3b2687bbaccde03fbf88a679827e';
const TENDIES = '0x45242320dbb855eea8fd36804c6487e10e97fcf9';
const TOKEN_ID = 811217n;
const LIQUIDITY = 93570467772447849565n;
const ZERO = '0x0000000000000000000000000000000000000000';
const WALLET = '0x8d7bbfa0506ea95c73d864310818acc3e5fa05d9';
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const PERMIT2_PERMIT =
  '0xc6a377bfc4eb120024a8ac08eef205be16b817020812c73223e81d1bdb9708ec';
const SEND_TX = '0x424918c1a10b278bd87e2cfe624d8a0f8959ca16767cdd72e3cd3ea75fb7f183';
const SEND = '0x6909eb6f914bf821b1c995d6a9c8a29ebb794e01';
const SEND_POOL_ID = '0x7d8edc065b1fc74a09ccd79e15b1944248ce91410baa53c9dfed86f9518dc04f';
const SEND_TOKEN_ID = 1545755n;
const SEND_LIQUIDITY = 141_844_293_344_803_342_576n;
const topicAddress = (address) =>
  '0x' + address.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const assertClose = (actual, expected, tolerance, label) => {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, received ${actual}`);
};

const modifyData = '0x'
  + '000000000000000000000000000000000000000000000000000000000001b3f0'
  + '000000000000000000000000000000000000000000000000000000000001d7e0'
  + '000000000000000000000000000000000000000000000005128d14ae73e3fc5d'
  + '00000000000000000000000000000000000000000000000000000000000c60d1';
const normalised = {
  block: 42369660,
  time: null,
  transactionHash: TX,
  logIndex: 71,
  topics: [V4_TOPIC.modifyLiquidity, POOL_ID, topicAddress(POSITION_MANAGER)],
  data: modifyData,
};

const events = decodeV4LiquidityLogs([normalised], {
  poolId: POOL_ID,
  positionManager: POSITION_MANAGER,
  tokenId: TOKEN_ID,
  tickLower: 111600,
  tickUpper: 120800,
});
assert.equal(events.length, 1);
assert.equal(events[0].liquidityDelta, LIQUIDITY);
assert.equal(events[0].tokenId, TOKEN_ID);
assert.equal(decodeV4LiquidityLogs([normalised], {
  poolId: POOL_ID,
  positionManager: POSITION_MANAGER,
  tokenId: TOKEN_ID + 1n,
  tickLower: 111600,
  tickUpper: 120800,
}).length, 0, 'salt/tokenId must be matched locally');

const receipt = {
  status: '0x1',
  transactionHash: TX,
  from: WALLET,
  to: POSITION_MANAGER,
  logs: [
    {
      address: POSITION_MANAGER,
      topics: [
        V4_TOPIC.transfer,
        '0x' + '0'.repeat(64),
        topicAddress(WALLET),
        '0x' + TOKEN_ID.toString(16).padStart(64, '0'),
      ],
      data: '0x',
    },
    {
      address: POOL_MANAGER,
      topics: normalised.topics,
      data: modifyData,
    },
    {
      address: TENDIES,
      topics: [
        V4_TOPIC.transfer,
        topicAddress(WALLET),
        topicAddress(POOL_MANAGER),
      ],
      data: '0x000000000000000000000000000000000000000000000228e70f3a83970bc031',
    },
  ],
};

const permitLog = {
  address: PERMIT2,
  transactionHash: TX,
  topics: [
    PERMIT2_PERMIT,
    topicAddress(WALLET),
    topicAddress(TENDIES),
    topicAddress(POSITION_MANAGER),
  ],
  data: '0x'
    + ((1n << 160n) - 1n).toString(16).padStart(64, '0')
    + (2_000_000_000n).toString(16).padStart(64, '0')
    + '0'.repeat(64),
};
const permittedReceipt = { ...structuredClone(receipt), logs: [permitLog, ...receipt.logs] };
const permittedProof = inferSimpleV4Mint({
  event: events[0], receipt: permittedReceipt,
  poolManager: POOL_MANAGER, positionManager: POSITION_MANAGER,
  token0: ZERO, token1: TENDIES, hooks: ZERO, liquidity: LIQUIDITY,
  tickLower: 111600, tickUpper: 120800, decimals0: 18, decimals1: 18,
});
assert.equal(permittedProof.unavailable, undefined, permittedProof.unavailable);

const badPermitOwner = structuredClone(permittedReceipt);
badPermitOwner.logs[0].topics[1] = topicAddress('0x1111111111111111111111111111111111111111');
assert.match(inferSimpleV4Mint({
  event: events[0], receipt: badPermitOwner,
  poolManager: POOL_MANAGER, positionManager: POSITION_MANAGER,
  token0: ZERO, token1: TENDIES, hooks: ZERO, liquidity: LIQUIDITY,
  tickLower: 111600, tickUpper: 120800, decimals0: 18, decimals1: 18,
}).unavailable, /Permit2 authorization does not match/i);

const badPermitSpender = structuredClone(permittedReceipt);
badPermitSpender.logs[0].topics[3] = topicAddress(POOL_MANAGER);
assert.match(inferSimpleV4Mint({
  event: events[0], receipt: badPermitSpender,
  poolManager: POOL_MANAGER, positionManager: POSITION_MANAGER,
  token0: ZERO, token1: TENDIES, hooks: ZERO, liquidity: LIQUIDITY,
  tickLower: 111600, tickUpper: 120800, decimals0: 18, decimals1: 18,
}).unavailable, /unrelated Permit2/i);

const duplicatePermit = structuredClone(permittedReceipt);
duplicatePermit.logs.splice(1, 0, structuredClone(permitLog));
assert.match(inferSimpleV4Mint({
  event: events[0], receipt: duplicatePermit,
  poolManager: POOL_MANAGER, positionManager: POSITION_MANAGER,
  token0: ZERO, token1: TENDIES, hooks: ZERO, liquidity: LIQUIDITY,
  tickLower: 111600, tickUpper: 120800, decimals0: 18, decimals1: 18,
}).unavailable, /unrelated Permit2/i);

const sendModifyData = '0x'
  + '0000000000000000000000000000000000000000000000000000000000022b78'
  + '0000000000000000000000000000000000000000000000000000000000026ac0'
  + SEND_LIQUIDITY.toString(16).padStart(64, '0')
  + '000000000000000000000000000000000000000000000000000000000017961b';
const sendNormalised = {
  block: 52757523,
  time: null,
  transactionHash: SEND_TX,
  logIndex: 42,
  topics: [V4_TOPIC.modifyLiquidity, SEND_POOL_ID, topicAddress(POSITION_MANAGER)],
  data: sendModifyData,
};
const sendEvents = decodeV4LiquidityLogs([sendNormalised], {
  poolId: SEND_POOL_ID,
  positionManager: POSITION_MANAGER,
  tokenId: SEND_TOKEN_ID,
  tickLower: 142200,
  tickUpper: 158400,
});
assert.equal(sendEvents.length, 1);
const sendReceipt = {
  transactionHash: SEND_TX,
  status: '0x1',
  from: WALLET,
  to: POSITION_MANAGER,
  logs: [
    {
      address: PERMIT2,
      transactionHash: SEND_TX,
      topics: [
        PERMIT2_PERMIT,
        topicAddress(WALLET),
        topicAddress(SEND),
        topicAddress(POSITION_MANAGER),
      ],
      data: '0x'
        + ((1n << 160n) - 1n).toString(16).padStart(64, '0')
        + (1_790_962_636n).toString(16).padStart(64, '0')
        + '0'.repeat(64),
    },
    {
      address: POSITION_MANAGER,
      transactionHash: SEND_TX,
      topics: [
        V4_TOPIC.transfer,
        '0x' + '0'.repeat(64),
        topicAddress(WALLET),
        '0x' + SEND_TOKEN_ID.toString(16).padStart(64, '0'),
      ],
      data: '0x',
    },
    {
      address: POOL_MANAGER,
      transactionHash: SEND_TX,
      topics: sendNormalised.topics,
      data: sendModifyData,
    },
    {
      address: SEND,
      transactionHash: SEND_TX,
      topics: [V4_TOPIC.transfer, topicAddress(WALLET), topicAddress(POOL_MANAGER)],
      data: '0x0000000000000000000000000000000000000000000019ba8d3e1c2fd7eafb83',
    },
  ],
};
const proveSendMint = (candidate) => inferSimpleV4Mint({
  event: sendEvents[0],
  receipt: candidate,
  poolManager: POOL_MANAGER,
  positionManager: POSITION_MANAGER,
  token0: ZERO,
  token1: SEND,
  hooks: ZERO,
  liquidity: sendEvents[0].liquidityDelta,
  tickLower: 142200,
  tickUpper: 158400,
  decimals0: 18,
  decimals1: 18,
});
const exactSendProof = proveSendMint(sendReceipt);
assert.equal(exactSendProof.unavailable, undefined, exactSendProof.unavailable);
assertClose(exactSendProof.amount0, 0.0166179503073222, 1e-16, 'SEND mint ETH');
assertClose(exactSendProof.amount1, 121_500.43407265082, 1e-9, 'SEND mint token');
assertClose(exactSendProof.entry.price, 4_327_600.598591768, 1e-6, 'SEND entry price');
assert.equal(exactSendProof.proof, 'single-mint receipt + liquidity math');

const sendMutation = (mutate) => {
  const candidate = structuredClone(sendReceipt);
  mutate(candidate);
  return proveSendMint(candidate).unavailable;
};
assert.match(sendMutation((candidate) => {
  candidate.status = '0x0';
}), /receipt is unavailable/i, 'a failed transaction receipt must fail closed');
assert.match(sendMutation((candidate) => {
  delete candidate.status;
}), /receipt is unavailable/i, 'a receipt with no success status must fail closed');
assert.match(sendMutation((candidate) => {
  candidate.logs[1].topics[2] = topicAddress('0x1111111111111111111111111111111111111111');
}), /Permit2 authorization does not match/i, 'NFT recipient must bind to Permit2 owner');
assert.match(sendMutation((candidate) => {
  candidate.from = '0x1111111111111111111111111111111111111111';
}), /Permit2 authorization does not match/i, 'transaction sender must bind to Permit2 owner');
assert.match(sendMutation((candidate) => {
  candidate.to = POOL_MANAGER;
}), /Permit2 authorization does not match/i, 'transaction recipient must be PositionManager');
assert.match(sendMutation((candidate) => {
  candidate.logs[0].topics[2] = topicAddress(TENDIES);
}), /unrelated Permit2/i, 'Permit2 token must match a pool token');
assert.match(sendMutation((candidate) => {
  candidate.logs[0].address = '0x1111111111111111111111111111111111111111';
}), /additional actions/i, 'Permit2 must use the canonical contract');
assert.match(sendMutation((candidate) => {
  candidate.logs[0].topics[0] = '0x' + '1'.repeat(64);
}), /additional actions/i, 'Permit2 must use the canonical event topic');
assert.match(sendMutation((candidate) => {
  candidate.logs[0].data = candidate.logs[0].data.slice(0, -2);
}), /unrelated Permit2/i, 'truncated Permit2 data must fail');
assert.match(sendMutation((candidate) => {
  candidate.logs[0].data = '0x'
    + (1n << 160n).toString(16).padStart(64, '0')
    + (1_790_962_636n).toString(16).padStart(64, '0')
    + '0'.repeat(64);
}), /unrelated Permit2/i, 'overflow Permit2 amount must fail');
assert.match(sendMutation((candidate) => {
  candidate.logs[0].data = '0x'
    + '1'.padStart(64, '0')
    + (1_790_962_636n).toString(16).padStart(64, '0')
    + '0'.repeat(64);
}), /Permit2 authorization does not match/i, 'Permit2 amount must cover settlement');
assert.match(sendMutation((candidate) => {
  candidate.logs.splice(1, 0, structuredClone(candidate.logs[0]));
}), /unrelated Permit2/i, 'duplicate Permit2 events must fail');
assert.match(sendMutation((candidate) => {
  candidate.logs.pop();
}), /Permit2 authorization does not match/i, 'missing settlement must fail');
assert.match(sendMutation((candidate) => {
  const second = structuredClone(candidate.logs[3]);
  second.topics[1] = topicAddress('0x1111111111111111111111111111111111111111');
  candidate.logs.push(second);
}), /multiple owners/i, 'settlement from multiple owners must fail');
assert.match(sendMutation((candidate) => {
  const outgoing = structuredClone(candidate.logs[3]);
  outgoing.topics[1] = topicAddress(POOL_MANAGER);
  outgoing.topics[2] = topicAddress(WALLET);
  candidate.logs.push(outgoing);
}), /outgoing token transfer/i, 'a mint refund makes gross settlement ambiguous');
assert.match(validateSimpleV4Receipt({
  event: sendEvents[0], receipt: sendReceipt,
  poolManager: POOL_MANAGER, positionManager: POSITION_MANAGER,
  token0: ZERO, token1: SEND, expectMint: false,
}).unavailable, /unrelated Permit2/i, 'Permit2 exception is mint-only');
const shuffledSendReceipt = structuredClone(sendReceipt);
shuffledSendReceipt.logs = [
  shuffledSendReceipt.logs[3], shuffledSendReceipt.logs[2],
  shuffledSendReceipt.logs[0], shuffledSendReceipt.logs[1],
];
assert.equal(proveSendMint(shuffledSendReceipt).unavailable, undefined,
  'identity bindings must not depend on receipt log order');

const proof = inferSimpleV4Mint({
  event: events[0],
  receipt,
  poolManager: POOL_MANAGER,
  positionManager: POSITION_MANAGER,
  token0: ZERO,
  token1: TENDIES,
  hooks: ZERO,
  liquidity: LIQUIDITY,
  tickLower: 111600,
  tickUpper: 120800,
  decimals0: 18,
  decimals1: 18,
});
assert.equal(proof.unavailable, undefined, JSON.stringify(proof));
assert.ok(Math.abs(proof.amount0 - 0.027278581830193577) < 1e-15);
assert.ok(Math.abs(proof.amount1 - 10199.252319371933) < 1e-9);
assert.ok(Math.abs(proof.entry.price - 139874.8244373024) < 1e-6);
assert.equal(proof.entry.exact, true);

assert.match(inferSimpleV4Mint({
  event: events[0], receipt, poolManager: POOL_MANAGER,
  positionManager: POSITION_MANAGER, token0: ZERO, token1: TENDIES,
  hooks: '0x0000000000000000000000000000000000000001',
  liquidity: LIQUIDITY, tickLower: 111600, tickUpper: 120800,
  decimals0: 18, decimals1: 18,
}).unavailable, /hooked/i);

const extra = structuredClone(receipt);
extra.logs.push({ address: '0x' + '1'.repeat(40), topics: [], data: '0x' });
assert.match(inferSimpleV4Mint({
  event: events[0], receipt: extra, poolManager: POOL_MANAGER,
  positionManager: POSITION_MANAGER, token0: ZERO, token1: TENDIES, hooks: ZERO,
  liquidity: LIQUIDITY, tickLower: 111600, tickUpper: 120800,
  decimals0: 18, decimals1: 18,
}).unavailable, /additional actions/i);

const hexWord = (value) => {
  const n = BigInt(value);
  return (n < 0n ? (1n << 256n) + n : n).toString(16).padStart(64, '0');
};
const packDelta = (amount0, amount1) => {
  const limb = (value) => value < 0n ? (1n << 128n) + value : value;
  return (limb(amount0) << 128n) | limb(amount1);
};
const principal0 = -27278581830232895n;
const principal1 = -10199252319371933761585n;
const fees0 = 12345n;
const fees1 = 67890n;
const caller0 = principal0 + fees0;
const caller1 = principal1 + fees1;
const traceInput = '0x5a6bcfda'
  + hexWord(0) + hexWord(BigInt(TENDIES)) + hexWord(10031) + hexWord(200) + hexWord(0)
  + hexWord(111600) + hexWord(120800) + hexWord(LIQUIDITY) + hexWord(TOKEN_ID)
  + hexWord(320);
const trace = {
  from: '0x1111111111111111111111111111111111111111',
  to: POSITION_MANAGER,
  calls: [{
    from: POSITION_MANAGER,
    to: POOL_MANAGER,
    input: traceInput,
    output: '0x' + hexWord(packDelta(caller0, caller1))
      + hexWord(packDelta(fees0, fees1)),
    calls: [],
  }],
};
const addReceipt = {
  status: '0x1',
  transactionHash: TX,
  logs: [{
    address: POOL_MANAGER,
    transactionHash: TX,
    topics: normalised.topics,
    data: modifyData,
  }, {
    address: TENDIES,
    topics: [V4_TOPIC.transfer, topicAddress('0x8d7bbfa0506ea95c73d864310818acc3e5fa05d9'),
      topicAddress(POOL_MANAGER)],
    data: '0x' + hexWord(-caller1),
  }],
};
assert.equal(validateSimpleV4Receipt({
  event: events[0], receipt: addReceipt, poolManager: POOL_MANAGER,
  positionManager: POSITION_MANAGER, token0: ZERO, token1: TENDIES,
  expectMint: false,
}).unavailable, undefined, 'an isolated later addition receipt must pass');

const traced = inferSimpleV4TraceAddition({
  event: events[0], trace, poolManager: POOL_MANAGER,
  positionManager: POSITION_MANAGER, hooks: ZERO,
  tickLower: 111600, tickUpper: 120800, decimals0: 18, decimals1: 18,
});
assert.equal(traced.unavailable, undefined, JSON.stringify(traced));
assert.ok(Math.abs(traced.amount0 - Number(-principal0) / 1e18) < 1e-15);
assert.ok(Math.abs(traced.amount1 - Number(-principal1) / 1e18) < 1e-9);
assert.equal(traced.fees0, Number(fees0) / 1e18);
assert.equal(traced.fees1, Number(fees1) / 1e18);
assert.match(inferSimpleV4TraceAddition({
  event: { ...events[0], tokenId: TOKEN_ID + 1n }, trace,
  poolManager: POOL_MANAGER, positionManager: POSITION_MANAGER, hooks: ZERO,
  tickLower: 111600, tickUpper: 120800, decimals0: 18, decimals1: 18,
}).unavailable, /does not isolate/i, 'a trace for another salt must fail closed');

let rpcReceiptCalls = 0;
let publicMetadataCalls = 0;
let publicLogCalls = 0;
let hostedReceiptCalls = 0;
let publicMode = 'success';
const originalFetch = globalThis.fetch;
const relayOptions = {
  historyRelay: {
    receiptUrl: 'https://lplens-beta.licence-worker.workers.dev/receipt',
    key: 'test-key',
    installationId: '0123456789abcdef0123456789abcdef',
  },
};
const receiptForHash = (hash) => ({
  ...structuredClone(sendReceipt),
  transactionHash: hash,
  logs: sendReceipt.logs.map((log) => ({ ...structuredClone(log), transactionHash: hash })),
});
const blockscoutItems = (hash) => receiptForHash(hash).logs.map((log, index) => ({
  address: { hash: log.address },
  block_number: 52757523,
  data: log.data,
  index: 40 + index,
  topics: [...log.topics, ...Array(4 - log.topics.length).fill(null)],
  transaction_hash: hash,
}));
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.origin === new URL(CHAINS.robinhood.rpc).origin && url.pathname === '/') {
    rpcReceiptCalls++;
    return new Response(JSON.stringify({ error: { message: 'Too Many Requests' } }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
    });
  }
  if (url.hostname === 'robinhoodchain.blockscout.com') {
    const match = url.pathname.match(/^\/api\/v2\/transactions\/(0x[0-9a-f]{64})(\/logs)?$/);
    assert.ok(match, `unexpected public Blockscout URL ${url.href}`);
    const hash = match[1];
    if (!match[2]) {
      publicMetadataCalls++;
      if (publicMode === 'http-error') return new Response('{}', { status: 503 });
      return Response.json({
        hash,
        status: 'ok',
        result: 'success',
        block_number: 52757523,
        from: { hash: WALLET },
        to: { hash: POSITION_MANAGER },
      });
    }
    publicLogCalls++;
    const items = blockscoutItems(hash);
    if (publicMode === 'missing-pagination') return Response.json({ items });
    if (publicMode === 'pagination') {
      if (!url.search) {
        return Response.json({
          items: items.slice(0, 2),
          next_page_params: { index: 42, items_count: 50, block_number: 52757523 },
        });
      }
      assert.equal(url.searchParams.get('index'), '42');
      assert.equal(url.searchParams.get('items_count'), '50');
      assert.equal(url.searchParams.get('block_number'), '52757523');
      return Response.json({ items: items.slice(2), next_page_params: null });
    }
    return Response.json({ items, next_page_params: null });
  }
  assert.equal(url.href, 'https://lplens-beta.licence-worker.workers.dev/receipt');
  hostedReceiptCalls++;
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body).sort(), [
    'chainId', 'installationId', 'key', 'transactionHash',
  ]);
  assert.equal(body.chainId, '4663');
  return Response.json({ result: receiptForHash(body.transactionHash) });
};
try {
  const publicHash = SEND_TX;
  const publicReceipt = await fetchV4Receipt(
    CHAINS.robinhood.rpc, CHAINS.robinhood, publicHash, relayOptions,
  );
  assert.equal(publicReceipt.transactionHash, publicHash);
  assert.equal(publicReceipt.logs.length, 4);
  assert.equal(proveSendMint(publicReceipt).unavailable, undefined,
    'the normalized public REST receipt must prove the exact SEND mint');
  assert.equal(rpcReceiptCalls, 3);
  assert.equal(publicMetadataCalls, 1);
  assert.equal(publicLogCalls, 1);
  assert.equal(hostedReceiptCalls, 0,
    'a complete public REST receipt must not consume the authenticated relay');
  await fetchV4Receipt(CHAINS.robinhood.rpc, CHAINS.robinhood, publicHash, relayOptions);
  assert.deepEqual(
    [rpcReceiptCalls, publicMetadataCalls, publicLogCalls, hostedReceiptCalls],
    [3, 1, 1, 0],
    'an immutable successful receipt must be cached briefly',
  );

  publicMode = 'pagination';
  const pagedHash = '0x' + 'b'.repeat(64);
  const pagedReceipt = await fetchV4Receipt(
    CHAINS.robinhood.rpc, CHAINS.robinhood, pagedHash, relayOptions,
  );
  assert.equal(pagedReceipt.logs.length, 4);
  assert.deepEqual(pagedReceipt.logs.map((log) => Number.parseInt(log.logIndex, 16)),
    [40, 41, 42, 43]);
  assert.equal(hostedReceiptCalls, 0);

  publicMode = 'http-error';
  const relayHash = '0x' + 'c'.repeat(64);
  const relayed = await fetchV4Receipt(
    CHAINS.robinhood.rpc, CHAINS.robinhood, relayHash, relayOptions,
  );
  assert.equal(relayed.transactionHash, relayHash);
  assert.equal(hostedReceiptCalls, 1,
    'the authenticated relay is used only after RPC and public REST fail');

  publicMode = 'missing-pagination';
  const recoveryHash = '0x' + 'd'.repeat(64);
  await assert.rejects(
    fetchV4Receipt(CHAINS.robinhood.rpc, CHAINS.robinhood, recoveryHash),
    /may be incomplete/i,
  );
  publicMode = 'success';
  const recovered = await fetchV4Receipt(
    CHAINS.robinhood.rpc, CHAINS.robinhood, recoveryHash,
  );
  assert.equal(recovered.transactionHash, recoveryHash,
    'a failed receipt task must be evicted so the next refresh can recover');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('v4 history: receipt fallback, salt matching, trace proofs and fail-closed boundary pass');
