#!/usr/bin/env node
/**
 * A lying RPC must never produce a historical price.
 *
 * `rpc.hyperliquid.xyz/evm` answers a historical `eth_call` with LATEST state
 * instead of refusing. On 2026-08-23 that made ProjectX NFT 533076 report a
 * USD LP return of -$110 on a position that was up ~$130: the mint block's
 * WHYPE was priced at that day's $82.70 rather than the real $75.92, and the
 * result was still stamped `exact: true, source: 'event-math'`, because that
 * flag describes the event-solved token ratio and never the dollar leg.
 *
 * Historical prices are now read from the pool's own `Swap` events, which live
 * in the log index and outlive pruned state. This test pins that: an endpoint
 * that serves present-day `slot0` for every block must yield the SWAP price or
 * null, never the present-day one.
 */
import assert from 'node:assert/strict';

const LATEST_SQRT = 3_000_000_000_000_000_000_000_000_000n;   // "today"
const SWAP_SQRT   = 2_500_000_000_000_000_000_000_000_000n;   // at the target block
const word = (v) => v.toString(16).padStart(64, '0');

let calls;
globalThis.chrome = { storage: { local: {
  get: async () => ({}), set: async () => {}, remove: async () => {},
} } };

// Every eth_call returns latest state whatever block is asked for, and
// eth_getLogs serves the historical Swap. Exactly the shape of the live bug.
const POOL = '0x' + '11'.repeat(20);
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';   // ethereum usdRef.stable

// Every eth_call answers with present-day state whatever block is asked for,
// and eth_getLogs serves the historical Swap. Exactly the live failure shape.
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  calls.push(body.method);
  const reply = (result) => ({
    ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result }),
  });
  if (body.method === 'eth_call') {
    const data = body.params[0].data;
    if (data.startsWith('0x1698ee82')) return reply('0x' + word(BigInt(POOL)));      // getPool
    if (data.startsWith('0x0dfe1681')) return reply('0x' + word(BigInt(USDC)));      // token0
    if (data.startsWith('0x3850c7bd')) return reply('0x' + word(LATEST_SQRT) + word(0n));
    throw new Error('unexpected call ' + data.slice(0, 10));
  }
  if (body.method === 'eth_getLogs') {
    return reply([{
      address: POOL,
      topics: ['0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'],
      // amount0, amount1, sqrtPriceX96, liquidity, tick
      data: '0x' + word(1n) + word(1n) + word(SWAP_SQRT) + word(1n) + word(0n),
      blockNumber: '0x1000', transactionHash: '0x' + 'ab'.repeat(32), logIndex: '0x0',
    }]);
  }
  throw new Error('unexpected method ' + body.method);
};

const { refUsdAtBlock } = await import('../extension/lib/histprice.js');

const toUsd = (sqrt) => {
  const s = Number(sqrt) / 2 ** 96;
  return 10 ** 12 / (s * s);         // USDC is token0, so WETH/USD inverts
};

// 1. A historical read must come from the Swap event, not the eth_call.
calls = [];
const historical = await refUsdAtBlock('ethereum', 4096, {
  rpcOverride: 'https://stub.invalid/rpc',
});
assert.ok(historical !== null, 'historical price should resolve from the Swap event');
assert.ok(Math.abs(historical - toUsd(SWAP_SQRT)) < 1e-6,
  `historical price came from the wrong source: ${historical}`);
assert.ok(Math.abs(historical - toUsd(LATEST_SQRT)) > 1,
  'historical price must not equal the present-day price a lying node served');
assert.ok(calls.includes('eth_getLogs'), 'historical price must read the log index');

// 2. With no Swap in range it fails CLOSED — never falls back to eth_call.
const prior = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  if (body.method === 'eth_getLogs') {
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: [] }) };
  }
  return prior(url, init);
};
const dry = await refUsdAtBlock('ethereum', 8192, { rpcOverride: 'https://stub.invalid/rpc' });
assert.equal(dry, null, 'no swap in range must yield null, never a present-day price');
globalThis.fetch = prior;

// 3. `latest` still reads state directly: every node serves that honestly.
calls = [];
const now = await refUsdAtBlock('ethereum', 'latest', { rpcOverride: 'https://stub.invalid/rpc' });
assert.ok(Math.abs(now - toUsd(LATEST_SQRT)) < 1e-6, 'latest must read slot0');
assert.ok(calls.includes('eth_call'), 'latest must not pay for a log scan');

console.log('histprice archive: historical prices read the log index, fail closed, latest reads state');
