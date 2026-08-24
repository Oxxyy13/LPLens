#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  decodeV4LiquidityLogs, inferSimpleV4Mint, inferSimpleV4TraceAddition,
  validateSimpleV4Receipt, V4_TOPIC,
} from '../extension/lib/v4.js';

const TX = '0x00e8fa6cc9dd87fe357bb5da81e6c399f7cde8228fb022e1505bc4b25eb36ff5';
const POSITION_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const POOL_ID = '0x9ce47988f23c15b4922c8015fdca777329de3b2687bbaccde03fbf88a679827e';
const TENDIES = '0x45242320dbb855eea8fd36804c6487e10e97fcf9';
const TOKEN_ID = 811217n;
const LIQUIDITY = 93570467772447849565n;
const ZERO = '0x0000000000000000000000000000000000000000';
const topicAddress = (address) =>
  '0x' + address.replace(/^0x/, '').toLowerCase().padStart(64, '0');

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
  logs: [
    {
      address: POSITION_MANAGER,
      topics: [
        V4_TOPIC.transfer,
        '0x' + '0'.repeat(64),
        topicAddress('0x8d7bbfa0506ea95c73d864310818acc3e5fa05d9'),
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
        topicAddress('0x8d7bbfa0506ea95c73d864310818acc3e5fa05d9'),
        topicAddress(POOL_MANAGER),
      ],
      data: '0x000000000000000000000000000000000000000000000228e70f3a83970bc031',
    },
  ],
};

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

console.log('v4 history: salt matching, receipt + trace proofs and fail-closed boundary pass');
