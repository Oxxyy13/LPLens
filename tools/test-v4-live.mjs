#!/usr/bin/env node
import assert from 'node:assert/strict';

import { loadPositionByVersion } from '../extension/lib/positions.js';
import { CHAINS } from '../extension/lib/chains.js';
import { fetchV4Trace, inferSimpleV4TraceAddition } from '../extension/lib/v4.js';

// User-opened ETH/TENDIES position discovered from the exact range in the
// 0.27 smoke report. Its mint transaction is immutable and exercises native
// settlement, receipt proof, bridged ETH pricing and the overlay load path.
const position = await loadPositionByVersion('robinhood', 'v4', 811217n);
assert.equal(position.version, 'v4');
assert.equal(position.poolId,
  '0x9ce47988f23c15b4922c8015fdca777329de3b2687bbaccde03fbf88a679827e');
assert.equal(position.token0Meta.symbol, 'ETH');
assert.equal(position.token1Meta.symbol, 'TENDIES');
assert.equal(position.tickLower, 111600);
assert.equal(position.tickUpper, 120800);
assert.equal(position.history?.unavailable, undefined,
  position.history?.unavailable || 'v4 history missing');
assert.equal(position.history.proof, 'single-mint receipt + liquidity math');
assert.equal(position.history.deposits.length, 1);
assert.ok(Math.abs(position.history.deposits[0].amount0 - 0.027278581830193577) < 1e-15);
assert.ok(Math.abs(position.history.deposits[0].amount1 - 10199.252319371933) < 1e-9);
assert.ok(Math.abs(position.history.entry.price - 139874.8244373024) < 1e-6);
assert.ok(Number.isFinite(position.history.vsHodl?.pct));
assert.equal(position.usd?.returnUnavailable, null);
assert.equal(position.usd?.grossAddedExact, true);
assert.equal(position.usd?.collectedProceedsExact, true);
assert.ok(Number.isFinite(position.usd?.pnl));
assert.ok(Number.isFinite(position.usd?.pnlPct));

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
  v4: 'pass',
  tokenId: position.tokenId.toString(),
  pair: `${position.token0Meta.symbol}/${position.token1Meta.symbol}`,
  historySource: position.history.source,
  entry: position.history.entry.price,
  vsHodlPct: position.history.vsHodl.pct,
  pnlUsd: position.usd.pnl,
  pnlPct: position.usd.pnlPct,
  trace: 'pass',
}));
