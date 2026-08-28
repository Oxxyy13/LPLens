#!/usr/bin/env node
/**
 * The raw-RPC historical price fallback searches newest to oldest. It may move
 * to an older interval only after the newer one returned a well-formed empty
 * result. A timeout, provider refusal, or malformed response leaves the newer
 * interval unknown and must fail closed instead of returning a stale Swap.
 */
import assert from 'node:assert/strict';
import { fetchLastLogBefore } from '../extension/lib/logs.js';

const CONTRACT = '0x' + '11'.repeat(20);
const TOPIC = '0x' + '22'.repeat(32);
const TX = '0x' + '33'.repeat(32);
const params = {
  contract: CONTRACT,
  topics: [TOPIC],
  block: 1000,
  chunk: 100,
  maxChunks: 4,
  lookback: 1000,
};

const response = (result, { ok = true, status = 200, error = null } = {}) => ({
  ok,
  status,
  headers: { get: () => null },
  json: async () => error
    ? { jsonrpc: '2.0', id: 1, error: { message: error } }
    : { jsonrpc: '2.0', id: 1, result },
});

const swap = (block) => ({
  address: CONTRACT,
  topics: [TOPIC],
  data: '0x',
  blockNumber: '0x' + BigInt(block).toString(16),
  transactionHash: TX,
  logIndex: '0x0',
});

const rangeOf = (init) => {
  const body = JSON.parse(init.body);
  assert.equal(body.method, 'eth_getLogs');
  const filter = body.params[0];
  return [Number(BigInt(filter.fromBlock)), Number(BigInt(filter.toBlock))];
};

// A transiently unreadable newest interval is retried in place. No older
// interval may be queried before the newest one is proven readable.
{
  const ranges = [];
  globalThis.fetch = async (_url, init) => {
    ranges.push(rangeOf(init));
    if (ranges.length < 3) return response(null, {
      ok: false, status: 400, error: 'temporary provider refusal',
    });
    return response([swap(995)]);
  };
  const got = await fetchLastLogBefore({ ...params, rpc: 'https://transient.invalid' });
  assert.equal(got?.block, 995);
  assert.deepEqual(ranges, [[901, 1000], [901, 1000], [901, 1000]],
    'every retry must repeat the same newest interval');
}

// Exhausting the newest interval fails closed even if an older interval would
// contain a plausible Swap. Skipping the unknown gap would make that stale row
// look exact.
{
  const ranges = [];
  globalThis.fetch = async (_url, init) => {
    const range = rangeOf(init);
    ranges.push(range);
    if (range[1] < 1000) return response([swap(850)]);
    return response(null, { ok: false, status: 400, error: 'persistent refusal' });
  };
  const got = await fetchLastLogBefore({ ...params, rpc: 'https://persistent.invalid' });
  assert.equal(got, null);
  assert.deepEqual(ranges, [[901, 1000], [901, 1000], [901, 1000]],
    'an unreadable newest interval must never be skipped');
}

// A confirmed empty newest interval is different: only then is descending to
// the next interval safe.
{
  const ranges = [];
  globalThis.fetch = async (_url, init) => {
    const range = rangeOf(init);
    ranges.push(range);
    return response(range[1] === 1000 ? [] : [swap(850)]);
  };
  const got = await fetchLastLogBefore({ ...params, rpc: 'https://empty.invalid' });
  assert.equal(got?.block, 850);
  assert.deepEqual(ranges, [[901, 1000], [801, 900]],
    'a well-formed empty interval may be followed by the next older one');
}

// A malformed successful response is also unreadable and receives the same
// bounded in-place retries.
{
  const ranges = [];
  globalThis.fetch = async (_url, init) => {
    ranges.push(rangeOf(init));
    return response({ not: 'a log array' });
  };
  const got = await fetchLastLogBefore({ ...params, rpc: 'https://malformed.invalid' });
  assert.equal(got, null);
  assert.deepEqual(ranges, [[901, 1000], [901, 1000], [901, 1000]]);
}

console.log('last historical log: retries newest chunk and fails closed across unreadable gaps');
