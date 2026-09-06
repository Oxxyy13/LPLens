#!/usr/bin/env node
import assert from 'node:assert/strict';

import { fetchFilteredLogs } from '../extension/lib/logs.js';
import {
  coalesceV4PoolLogTask, decodeV4LiquidityLogs, verifiedV4MintBlock, V4_TOPIC,
} from '../extension/lib/v4.js';

const RPC = 'https://rpc.filtered-log.fixture.invalid';
const CONTRACT = '0x' + '11'.repeat(20);
const TOPIC = '0x' + '22'.repeat(32);
const OWNER = '0x' + '33'.repeat(20);
const PRIOR_OWNER = '0x' + '44'.repeat(20);
const ZERO = '0x' + '0'.repeat(40);
const TOKEN_ID = 1615229n;

const response = (id, { result, error } = {}) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }),
});
const log = (block, index = 0) => ({
  address: CONTRACT,
  blockNumber: '0x' + BigInt(block).toString(16),
  transactionHash: '0x' + BigInt(block * 100 + index + 1).toString(16).padStart(64, '0'),
  logIndex: '0x' + BigInt(index).toString(16),
  topics: [TOPIC],
  data: '0x',
});
const limits = (id) => response(id, {
  error: { code: -32005, message: 'logs matched by query exceeds limit of 10000' },
});
const range = (request) => {
  const filter = request.params[0];
  return [Number(BigInt(filter.fromBlock)), Number(BigInt(filter.toBlock))];
};
const runWithFetch = async (stub, task) => {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await task(); }
  finally { globalThis.fetch = original; }
};
const request = (extra = {}) => fetchFilteredLogs({
  contract: CONTRACT,
  topics: [TOPIC],
  rpc: RPC,
  fromBlock: 0,
  ...extra,
});

// Concurrent same-pool cards share one active request, but a completed result
// is gone before the next deliberate refresh. An older bound can replace a
// newer in-flight read without the superseded task evicting the safer one.
{
  let finishFirst;
  let loads = 0;
  const first = coalesceV4PoolLogTask('same-pool', 20, () => {
    loads++;
    return new Promise((resolve) => { finishFirst = resolve; });
  });
  const concurrent = coalesceV4PoolLogTask('same-pool', 30, () => {
    loads++;
    return Promise.resolve('wrong');
  });
  assert.strictEqual(concurrent, first);
  assert.equal(loads, 0, 'the shared loader starts in a microtask');
  await Promise.resolve();
  assert.equal(loads, 1);
  finishFirst('first');
  assert.equal(await first, 'first');
  await Promise.resolve();

  const refreshed = coalesceV4PoolLogTask('same-pool', 30, () => {
    loads++;
    return Promise.resolve('fresh');
  });
  assert.notStrictEqual(refreshed, first);
  assert.equal(await refreshed, 'fresh');
  assert.equal(loads, 2);

  let finishNewer;
  let finishOlder;
  const newer = coalesceV4PoolLogTask('range-race', 50,
    () => new Promise((resolve) => { finishNewer = resolve; }));
  await Promise.resolve();
  const older = coalesceV4PoolLogTask('range-race', 10,
    () => new Promise((resolve) => { finishOlder = resolve; }));
  await Promise.resolve();
  assert.notStrictEqual(newer, older);
  finishNewer('narrow');
  assert.equal(await newer, 'narrow');
  const sharesOlder = coalesceV4PoolLogTask('range-race', 40,
    () => Promise.resolve('wrong'));
  assert.strictEqual(sharesOlder, older);
  finishOlder('wide');
  assert.equal(await older, 'wide');
}
const addressTopic = (address) =>
  '0x' + address.slice(2).toLowerCase().padStart(64, '0');
const transfer = (from, to, block, index) => ({
  address: CONTRACT,
  blockNumber: '0x' + BigInt(block).toString(16),
  transactionHash: '0x' + BigInt(block * 100 + index + 1).toString(16).padStart(64, '0'),
  logIndex: '0x' + BigInt(index).toString(16),
  topics: [
    V4_TOPIC.transfer,
    addressTopic(from),
    addressTopic(to),
    '0x' + TOKEN_ID.toString(16).padStart(64, '0'),
  ],
  data: '0x',
});

// The optimization uses the global zero-address mint, not this wallet's first
// receipt. That preserves lifetime history when an LP NFT changes owners.
{
  let calls = 0;
  const mint = transfer(ZERO, PRIOR_OWNER, 12, 0);
  const acquired = transfer(PRIOR_OWNER, OWNER, 40, 1);
  const proven = await runWithFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    calls++;
    assert.equal(body.method, 'eth_getLogs');
    assert.equal(body.params[0].topics[3],
      '0x' + TOKEN_ID.toString(16).padStart(64, '0'));
    return response(body.id, { result: [acquired, mint] });
  }, () => verifiedV4MintBlock(RPC, CONTRACT, TOKEN_ID));
  assert.equal(calls, 1);
  assert.equal(proven, 12);

  const unproven = await runWithFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    return response(body.id, { result: [acquired] });
  }, () => verifiedV4MintBlock(RPC, CONTRACT, TOKEN_ID));
  assert.equal(unproven, 0, 'a missing global mint must fall back to block zero');
}

// A moving `latest` is pinned once. Every oversized interval is bisected into
// non-overlapping children, read left-to-right, and returned canonically.
{
  const queried = [];
  let headCalls = 0;
  const events = [log(30), log(2), log(18), log(10)];
  const got = await runWithFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'eth_getBlockByNumber') {
      headCalls++;
      return response(body.id, { result: { number: '0x1f' } });
    }
    assert.equal(body.method, 'eth_getLogs');
    const [from, to] = range(body);
    queried.push([from, to]);
    if (to - from + 1 > 8) return limits(body.id);
    const matching = events.filter((row) => {
      const block = Number(BigInt(row.blockNumber));
      return block >= from && block <= to;
    }).reverse();
    return response(body.id, {
      result: matching.length ? [...matching, structuredClone(matching[0])] : [],
    });
  }, () => request({ toBlock: 'latest' }));

  assert.equal(headCalls, 1);
  assert.deepEqual(queried, [
    [0, 31], [0, 15], [0, 7], [8, 15], [16, 31], [16, 23], [24, 31],
  ]);
  assert.equal(got.source, 'rpc-chunked');
  assert.deepEqual([got.fromBlock, got.toBlock], [0, 31]);
  assert.deepEqual(got.logs.map((row) => row.block), [2, 10, 18, 30]);
}

// A successful parent response at the known cap is ambiguous and must also be
// split. The 10,000 untrusted rows are discarded rather than treated as whole.
{
  const queried = [];
  const got = await runWithFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    const [from, to] = range(body);
    queried.push([from, to]);
    if (from === 0 && to === 1) {
      return response(body.id, { result: Array(10_000).fill({}) });
    }
    return response(body.id, { result: [log(from)] });
  }, () => request({ toBlock: 1 }));
  assert.deepEqual(queried, [[0, 1], [0, 0], [1, 1]]);
  assert.equal(got.source, 'rpc-chunked');
  assert.deepEqual(got.logs.map((row) => row.block), [0, 1]);
}

// One failed child invalidates the whole lifetime. A successfully read sibling
// can never escape as partial history.
{
  const queried = [];
  const got = await runWithFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    const bounds = range(body);
    queried.push(bounds);
    if (bounds[0] === 0 && bounds[1] === 15) return limits(body.id);
    if (bounds[0] === 0) return response(body.id, { result: [log(2)] });
    return response(body.id, {
      error: { code: -32000, message: 'historical backend unavailable' },
    });
  }, () => request({ toBlock: 15 }));
  assert.deepEqual(queried, [[0, 15], [0, 7], [8, 15]]);
  assert.equal(got.logs, undefined);
  assert.match(got.unavailable, /historical backend unavailable/);
}

// Generic failures are not repaired by fan-out, and a single block at the cap
// terminates immediately because no smaller complete interval exists.
{
  let calls = 0;
  const generic = await runWithFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    calls++;
    return response(body.id, { error: { code: -32000, message: 'archive unavailable' } });
  }, () => request({ toBlock: 100 }));
  assert.equal(calls, 1);
  assert.match(generic.unavailable, /archive unavailable/);

  calls = 0;
  const rateLimited = await runWithFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    calls++;
    return {
      ok: false,
      status: 429,
      headers: { get: () => '0' },
      json: async () => ({ error: { message: 'Too Many Requests' }, id: body.id }),
    };
  }, () => request({ toBlock: 100 }));
  assert.equal(calls, 3, 'rpcCall retries one range but the splitter must not fan it out');
  assert.match(rateLimited.unavailable, /HTTP 429/);

  calls = 0;
  const oneBlock = await runWithFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    calls++;
    return response(body.id, { result: Array(10_000).fill({}) });
  }, () => request({ fromBlock: 9, toBlock: 9 }));
  assert.equal(calls, 1);
  assert.match(oneBlock.unavailable, /completeness cannot be proven.*block 9/i);
}

// Provider rows must satisfy the requested address/topics, identities cannot
// conflict across children, and pathological splitting stops at the call cap.
{
  const wrongAddress = await runWithFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    return response(body.id, {
      result: [{ ...log(1), address: '0x' + 'ff'.repeat(20) }],
    });
  }, () => request({ toBlock: 1 }));
  assert.match(wrongAddress.unavailable, /outside the exact requested filter/);

  const sharedHash = '0x' + 'ab'.repeat(32);
  const conflict = await runWithFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    const [from, to] = range(body);
    if (from === 0 && to === 1) return limits(body.id);
    return response(body.id, {
      result: [{ ...log(from), transactionHash: sharedHash, logIndex: '0x0' }],
    });
  }, () => request({ toBlock: 1 }));
  assert.match(conflict.unavailable, /cross-range conflicting log identity/);

  let calls = 0;
  const bounded = await runWithFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    calls++;
    const [from, to] = range(body);
    return from === to ? response(body.id, { result: [] }) : limits(body.id);
  }, () => request({ toBlock: 100 }));
  assert.equal(calls, 64);
  assert.match(bounded.unavailable, /split exceeded 64 RPC calls/);
}

// A capped Etherscan page spans every NFT in the pool. A fee-only action for
// our NFT beyond that first page must survive even though it changes no
// liquidity and is older than the recent-RPC supplement.
{
  const poolId = TOPIC;
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  const modify = (block, id, delta) => ({
    ...log(block),
    topics: [V4_TOPIC.modifyLiquidity, poolId, addressTopic(OWNER)],
    data: '0x' + [0, 200, delta, id].map(word).join(''),
  });
  const events = [modify(1, TOKEN_ID, 100),
    ...Array.from({ length: 999 }, (_, i) => modify(i + 2, TOKEN_ID + 1n, 1)),
    modify(1001, TOKEN_ID, 0)];
  const cursors = [];
  const got = await runWithFetch(async (url) => {
    const query = new URL(url);
    assert.equal(query.hostname, 'api.etherscan.io');
    assert.equal(query.searchParams.get('toBlock'), '5000');
    const from = Number(query.searchParams.get('fromBlock'));
    cursors.push(from);
    return { ok: true, json: async () => ({ status: '1', result:
      events.filter((row) => Number(BigInt(row.blockNumber)) >= from).slice(0, 1000),
    }) };
  }, () => request({
    topics: [V4_TOPIC.modifyLiquidity, poolId, addressTopic(OWNER)],
    toBlock: 5000, etherscanChainId: 1, etherscanKey: 'fixture-key',
  }));
  assert.deepEqual(cursors, [0, 1000]);
  assert.equal(got.source, 'etherscan');
  assert.equal(got.logs.length, 1001, 'overlapping page boundary must be deduplicated');
  const decoded = decodeV4LiquidityLogs(got.logs, {
    poolId, positionManager: OWNER, tokenId: TOKEN_ID, tickLower: 0, tickUpper: 200,
  });
  assert.deepEqual(decoded.map((event) => event.liquidityDelta), [100n, 0n]);
}

for (const failure of ['same-block-cap', 'later-page-failure']) {
  let explorerCalls = 0;
  const got = await runWithFetch(async (url, init) => {
    if (new URL(url).hostname === 'api.etherscan.io') {
      explorerCalls++;
      if (explorerCalls > 1) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ status: '1', result:
        Array.from({ length: 1000 }, (_, i) =>
          log(failure === 'same-block-cap' ? 1 : i + 1, i)),
      }) };
    }
    const body = JSON.parse(init.body);
    return response(body.id, { error: { code: -32000, message: 'archive unavailable' } });
  }, () => request({ toBlock: 5000, etherscanChainId: 1, etherscanKey: 'fixture-key' }));
  assert.equal(got.logs, undefined, 'a failed page sequence must not leak partial history');
  assert.match(got.unavailable, failure === 'same-block-cap' ? /result cap would truncate/ : /etherscan HTTP 503/);
  assert.equal(explorerCalls, failure === 'same-block-cap' ? 1 : 2);
}

console.log('filtered logs: adaptive RPC splitting and Etherscan pagination are complete and fail-closed');
