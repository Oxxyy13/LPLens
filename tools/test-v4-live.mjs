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

// ETH/SEND's mint receipt includes a canonical Permit2 allowance. While the
// position remains additions-only it proves the public Blockscout receipt
// fallback; after a remove it must instead exercise the supported v4
// fail-closed boundary. The immutable receipt shape also lives in the
// deterministic v4-history regression.
const send = await loadPositionByVersion('robinhood', 'v4', 1545755n);
assert.equal(send.version, 'v4');
assert.equal(send.poolId,
  '0x7d8edc065b1fc74a09ccd79e15b1944248ce91410baa53c9dfed86f9518dc04f');
assert.equal(send.token0Meta.symbol, 'ETH');
assert.equal(send.token1Meta.symbol, 'SEND');
if (send.status === 'closed') {
  assert.match(send.history?.unavailable || '',
    /v4 lifecycle verified \(2 actions\).*removes and fee-only actions remain unavailable/);
  assert.equal(send.usd?.pnl, null);
} else {
  assert.ok(['in-range', 'below', 'above'].includes(send.status));
  assert.equal(send.history?.unavailable, undefined);
  assert.ok(Math.abs(send.history.deposited0 - 0.0166179503073222) < 1e-16);
  assert.ok(Math.abs(send.history.deposited1 - 121500.43407265082) < 1e-9);
  assert.ok(Math.abs(send.history.entry.price - 4327600.598591768) < 1e-6);
  assert.equal(send.history.proof, 'single-mint receipt + liquidity math');
  assert.ok(Number.isFinite(send.usd?.pnl));
  assert.ok(Number.isFinite(send.usd?.vsHodl));
}

// USDG/MOO proves that Robinhood's canonical USDG contract is a direct
// historical dollar anchor. Its exact mint basis must not depend on the
// bridged-WETH path or inherit that path's peg disclaimer.
const moo = await loadPositionByVersion('robinhood', 'v4', 1615229n);
assert.equal(moo.version, 'v4');
assert.equal(moo.poolId,
  '0x50b29d336ff8c80656c9c2e811a82779f8b8064b46c99799cf61d20d096765c8');
assert.equal(moo.token0.toLowerCase(), CHAINS.robinhood.usdRef.stable.toLowerCase());
assert.equal(moo.token0Meta.symbol, 'USDG');
assert.equal(moo.token1Meta.symbol, 'MOO');
// The NFT is mutable: after a remove or fee-only action the correct outcome
// is the documented fail-closed boundary, not a fabricated mint-only return.
// Its immutable mint/basis remains covered by test-v4-history and cashflow.
if (moo.history?.unavailable) {
  assert.match(moo.history.unavailable,
    /^v4 lifecycle verified \((?:[2-9]|[1-9]\d+) actions\).*removes and fee-only actions remain unavailable$/);
  assert.equal(moo.usd?.pnl, null);
  assert.equal(moo.usd?.pnlPct, null);
} else {
  assert.equal(moo.history.proof, 'single-mint receipt + liquidity math');
  assert.ok(Math.abs(moo.usd?.grossAdded - 79.11915436687237) < 1e-8);
  assert.ok(Number.isFinite(moo.usd?.pnl));
  assert.ok(Number.isFinite(moo.usd?.pnlPct));
  assert.equal(moo.usd?.returnUnavailable, null);
  assert.equal(moo.usd?.bridged, false);
}

console.log(JSON.stringify({
  v4: 'pass-fail-closed',
  tokenId: position.tokenId.toString(),
  pair: `${position.token0Meta.symbol}/${position.token1Meta.symbol}`,
  status: position.status,
  lifecycle: position.history.unavailable,
  trace: 'pass',
  send: {
    tokenId: send.tokenId.toString(),
    status: send.status,
    history: send.history.proof || send.history.unavailable,
    pnl: send.usd.pnl,
    vsHodl: send.usd.vsHodl,
  },
  moo: {
    tokenId: moo.tokenId.toString(),
    history: moo.history.proof || moo.history.unavailable,
    grossAdded: moo.usd.grossAdded,
    pnl: moo.usd.pnl,
    pnlPct: moo.usd.pnlPct,
    bridged: moo.usd.bridged,
  },
}));
