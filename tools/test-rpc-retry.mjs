#!/usr/bin/env node
import assert from 'node:assert/strict';

let calls = 0;
globalThis.fetch = async () => {
  calls++;
  if (calls === 1) {
    return {
      ok: false,
      status: 429,
      headers: { get: (name) => name.toLowerCase() === 'retry-after' ? '0' : null },
      json: async () => ({ error: { message: 'You reached Public endpoint rate limit' } }),
    };
  }
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1234' }),
  };
};

const { rpcCall, RpcError } = await import('../extension/lib/rpc.js');
const result = await rpcCall('https://rpc.mainnet.chain.robinhood.com', 'eth_call', []);
assert.equal(result, '0x1234');
assert.equal(calls, 2, 'HTTP 429 should be retried once and then succeed');

calls = 0;
let permanentCalls = 0;
globalThis.fetch = async () => {
  permanentCalls++;
  return {
    ok: false,
    status: 400,
    headers: { get: () => null },
    json: async () => ({ error: { message: 'bad request' } }),
  };
};
await assert.rejects(
  () => rpcCall('https://rpc.mainnet.chain.robinhood.com', 'eth_call', []),
  (err) => err instanceof RpcError && err.status === 400 && err.retryable === false,
);
assert.equal(permanentCalls, 1, 'permanent HTTP errors must not be retried');

console.log('rpc retry: transient 429 retries, permanent 400 fails immediately');
