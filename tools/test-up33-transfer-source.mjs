#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  TRANSFER_TOPIC, fetchExactTokenTransfers,
} from '../extension/lib/logs.js';
import { uninterruptedDirectCustody } from '../extension/lib/positions.js';

const CONTRACT = '0x' + 'aa'.repeat(20);
const OWNER = '0x' + '11'.repeat(20);
const GAUGE = '0x' + '22'.repeat(20);
const ZERO = '0x' + '00'.repeat(20);
const TOKEN_ID = 113960n;
const HEAD = 1_000;
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const topicAddress = (address) => `0x${address.slice(2).padStart(64, '0')}`;
const topicId = `0x${word(TOKEN_ID)}`;
const transfer = (from, to, block, index, suffix) => ({
  address: CONTRACT,
  blockNumber: `0x${BigInt(block).toString(16)}`,
  logIndex: `0x${BigInt(index).toString(16)}`,
  transactionHash: `0x${BigInt(suffix).toString(16).padStart(64, '0')}`,
  topics: [TRANSFER_TOPIC, topicAddress(from), topicAddress(to), topicId],
  data: '0x',
});

const mint = transfer(ZERO, OWNER, 10, 1, 1);
const oldStake = transfer(OWNER, GAUGE, 100, 2, 2);
const oldReturn = transfer(GAUGE, OWNER, 101, 3, 3);
const rpcQueries = [];
const originalFetch = globalThis.fetch;

try {
  globalThis.fetch = async (url, init = {}) => {
    assert.ok(init.body, `custody proof must not trust explorer index: ${url}`);
    const request = JSON.parse(init.body);
    assert.equal(request.method, 'eth_getLogs');
    const query = request.params[0];
    rpcQueries.push(query);
    assert.deepEqual(query.topics, [TRANSFER_TOPIC, null, null, topicId]);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        jsonrpc: '2.0', id: request.id, result: [mint, oldStake, oldReturn],
      }),
    };
  };

  const got = await fetchExactTokenTransfers({
    contract: CONTRACT,
    tokenId: TOKEN_ID,
    rpc: 'https://rpc.invalid',
    blockscout: 'https://blockscout.invalid/api',
    toBlock: HEAD,
  });
  assert.equal(got.unavailable, undefined);
  assert.equal(got.complete, true);
  assert.equal(got.source, 'rpc');
  assert.deepEqual(got.events.map((event) => [event.block, event.from, event.to]), [
    [10, ZERO, OWNER],
    [100, OWNER, GAUGE],
    [101, GAUGE, OWNER],
  ]);
  assert.equal(uninterruptedDirectCustody(got.events, OWNER, TOKEN_ID).ok, false,
    'an old stake and return must still block PnL');
  assert.equal(rpcQueries.length, 1);
  assert.equal(rpcQueries[0].fromBlock, '0x0');
  assert.equal(rpcQueries[0].toBlock, `0x${HEAD.toString(16)}`);

  globalThis.fetch = async (url, init = {}) => {
    assert.ok(init.body, `custody proof must not trust explorer index: ${url}`);
    const request = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        jsonrpc: '2.0', id: request.id,
        error: { code: -32000, message: 'lifetime range unavailable' },
      }),
    };
  };
  const noLifetime = await fetchExactTokenTransfers({
    contract: CONTRACT,
    tokenId: TOKEN_ID,
    rpc: 'https://rpc.invalid',
    blockscout: 'https://blockscout.invalid/api',
    toBlock: HEAD,
  });
  assert.match(noLifetime.unavailable, /lifetime range unavailable/,
    'an unreadable lifetime RPC range must fail closed');

  globalThis.fetch = async (url, init = {}) => {
    assert.ok(init.body, `custody proof must not trust explorer index: ${url}`);
    const request = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        jsonrpc: '2.0', id: request.id,
        result: [{ ...mint, topics: [TRANSFER_TOPIC, topicAddress(ZERO)] }],
      }),
    };
  };
  const malformed = await fetchExactTokenTransfers({
    contract: CONTRACT,
    tokenId: TOKEN_ID,
    rpc: 'https://rpc.invalid',
    blockscout: 'https://blockscout.invalid/api',
    toBlock: HEAD,
  });
  assert.match(malformed.unavailable, /mismatched NFT Transfer log/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('UP33 Transfer source: exact lifetime RPC proof detects old custody round trips and fails closed');
