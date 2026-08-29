#!/usr/bin/env node
import assert from 'node:assert/strict';

import { loadPositionByVersion } from '../extension/lib/positions.js';
import { CHAINS } from '../extension/lib/chains.js';
import { fetchV4Trace, inferSimpleV4TraceAddition } from '../extension/lib/v4.js';

// The public instance rejects Node's default undici user agent even though the
// same request succeeds from the shipped Chrome extension. Use a browser-like
// agent so this probe exercises the production network path instead of the
// instance's bot filter.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers || {});
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36');
  }
  return nativeFetch(input, { ...init, headers });
};

// ETH/TENDIES was opened for the 0.27 smoke report and fully removed later.
// The two lifecycle events are now an immutable live fail-closed fixture for
// the supported v4 boundary. Its mint transaction separately exercises native
// settlement, receipt proof, and the public Blockscout trace shape.
const position = await loadPositionByVersion('robinhood', 'v4', 811217n);
assert.equal(position.version, 'v4');
assert.equal(position.poolId,
  '0x9ce47988f23c15b4922c8015fdca777329de3b2687bbaccde03fbf88a679827e');
assert.equal(position.token0Meta.symbol, 'ETH');
assert.equal(position.token1Meta.symbol, 'TENDIES');
assert.equal(position.tickLower, 111600);
assert.equal(position.tickUpper, 120800);
assert.equal(position.status, 'closed');
assert.equal(position.liquidity, 0n);
assert.match(position.history?.unavailable || '',
  /v4 lifecycle verified \(2 actions\).*removes and fee-only actions remain unavailable/);
assert.equal(position.usd?.pnl, null);

// The immutable mint also exercises the exact public Blockscout trace shape
// used for every later addition. The receipt path remains the one-add fallback;
// this separately proves that PoolManager's two packed return deltas decode.
const trace = await fetchV4Trace(CHAINS.robinhood,
  '0x00e8fa6cc9dd87fe357bb5da81e6c399f7cde8228fb022e1505bc4b25eb36ff5');
const traced = inferSimpleV4TraceAddition({
  event: {
    transactionHash: '0x00e8fa6cc9dd87fe357bb5da81e6c399f7cde8228fb022e1505bc4b25eb36ff5',
    tokenId: 811217n,
    tickLower: 111600,
    tickUpper: 120800,
    liquidityDelta: 93570467772447849565n,
  },
  trace,
  poolManager: CHAINS.robinhood.v4PoolManager,
  positionManager: CHAINS.robinhood.v4PositionManager,
  hooks: position.hooks,
  tickLower: position.tickLower,
  tickUpper: position.tickUpper,
  decimals0: position.token0Meta.decimals,
  decimals1: position.token1Meta.decimals,
});
assert.equal(traced.unavailable, undefined, traced.unavailable);
assert.ok(Math.abs(traced.amount0 - 0.027278581830232895) < 1e-15);
assert.ok(Math.abs(traced.amount1 - 10199.252319371933) < 1e-9);
assert.equal(traced.fees0, 0);
assert.equal(traced.fees1, 0);

console.log(JSON.stringify({
  v4: 'pass-fail-closed',
  tokenId: position.tokenId.toString(),
  pair: `${position.token0Meta.symbol}/${position.token1Meta.symbol}`,
  status: position.status,
  lifecycle: position.history.unavailable,
  trace: 'pass',
}));
