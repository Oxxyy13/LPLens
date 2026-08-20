#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  collectedProceedsUsd, strategyReturn, sumDepositBasis,
} from '../extension/lib/histprice.js';
import { classifyPosition, summarizeAggregate } from '../extension/lib/aggregate.js';
import { CHAINS } from '../extension/lib/chains.js';

function testClaimDoesNotMoveReturn() {
  const gross = { basis: 100, exact: true };
  const before = strategyReturn(gross, { proceeds: 0, exact: true }, 110);
  const after = strategyReturn(gross, { proceeds: 10, exact: true }, 100);
  assert.deepEqual(after, before,
    'claiming must move value from claimable to proceeds without moving LP return');
}

function testPartialRemoveDoesNotMoveReturn() {
  const gross = { basis: 100, exact: true };
  const before = strategyReturn(gross, { proceeds: 0, exact: true }, 110);
  // Removing $40 from active liquidity only moves it into claimable amounts.
  // Both remain inside currentValue until Collect transfers the assets out.
  const after = strategyReturn(gross, { proceeds: 0, exact: true }, 70 + 40);
  assert.deepEqual(after, before,
    'decreaseLiquidity must not move LP return before the assets are collected');
}

function testReinvestedCapitalIsNotStillHeld() {
  // Position A returned $40 and has $60 left. Position B received that same
  // $40 and later grew to $80. The portfolio made $40, not $80: A's returned
  // cash stopped accruing in A when it was collected.
  const oldPosition = strategyReturn(
    { basis: 100, exact: true }, { proceeds: 40, exact: true }, 60);
  const newPosition = strategyReturn(
    { basis: 40, exact: true }, { proceeds: 0, exact: true }, 80);
  assert.equal(oldPosition.pnl, 0);
  assert.equal(newPosition.pnl, 40);
  assert.equal(oldPosition.pnl + newPosition.pnl, 40);
}

function testBoundsFailClosed() {
  assert.equal(strategyReturn(
    { basis: 100, exact: false }, { proceeds: 0, exact: true }, 120).pnl, null);
  assert.equal(strategyReturn(
    { basis: 100, exact: true }, { proceeds: 10, exact: false }, 120).pnl, null);

  const classified = classifyPosition({
    history: {},
    usd: {
      currentValue: 120,
      pnl: null,
      grossAddedExact: false,
      collectedProceedsExact: true,
    },
  });
  assert.equal(classified.bound, true);
  assert.equal(classified.hasPnl, false);
}

async function testExactPairCanResolveSingleSidedAdd() {
  const basis = await sumDepositBasis([
    { block: 10, amount0: 2, amount1: 0, entry: { price: 7, exact: false } },
  ], async () => ({ usd0: 3, usd1: 0, exact: true, source: 'direct-reference' }));
  assert.equal(basis.basis, 6);
  assert.equal(basis.exact, true,
    'a direct WETH/stable leg is exact even when range math only gives a bound');
}

async function testEveryAddUsesItsOwnEventPrice() {
  const deposits = [
    { block: 10, amount0: 2, amount1: 1, entry: { price: 1, exact: true } },
    { block: 20, amount0: 3, amount1: 4, entry: { price: 2, exact: true } },
  ];
  const basis = await sumDepositBasis(deposits, async (deposit) => (
    deposit.block === 10
      ? { usd0: 5, usd1: 1, exact: true, source: 'event-math' }
      : { usd0: 9, usd1: 1, exact: true, source: 'event-math' }
  ));
  assert.equal(basis.basis, 42,
    'gross added must sum all additions at their own prices, not reuse the latest buy');
  assert.deepEqual(basis.legs.map((leg) => leg.value), [11, 31]);
}

async function testCollectionAtEventPrice() {
  const p = {
    token0: '0x1111111111111111111111111111111111111111',
    token1: CHAINS.base.usdRef.stable,
    token0Meta: { decimals: 18 },
    token1Meta: { decimals: 6 },
    history: {
      collections: [{
        block: 10,
        amount0: 2,
        amount1: 5,
        entry: { price: 3, exact: true },
      }],
    },
  };
  const got = await collectedProceedsUsd('base', p);
  assert.equal(got.proceeds, 11);
  assert.equal(got.exact, true);
}

async function testNoCollectedTokensInCurrentValue() {
  const src = await readFile(new URL('../extension/lib/positions.js', import.meta.url), 'utf8');
  const currentBlock = src.match(/const currentNow[\s\S]*?const ret =/u)?.[0] || '';
  assert(currentBlock, 'current-value calculation must be discoverable');
  assert(!/received0|received1/.test(currentBlock),
    'historical collections must not be marked today as though still held');
}

async function testOverlayKeepsDollarReturnAsHeadline() {
  const [overlay, worker] = await Promise.all([
    readFile(new URL('../extension/overlay.js', import.meta.url), 'utf8'),
    readFile(new URL('../extension/sw.js', import.meta.url), 'utf8'),
  ]);
  assert.match(overlay, /const headline = hasTotal \? cash\(u\.pnl\) : '—';/,
    'the compact headline must never substitute vs-holding percent for dollar LP return');
  assert.match(overlay, /<div class="gc-lbl">LP return<\/div>/,
    'the compact headline must always identify itself as LP return');
  assert.match(worker, /rpcOverrides: overrides/,
    'the overlay worker must forward origin-chain RPCs needed for bridged historical pricing');
}

function testAggregateLabelsAndExclusions() {
  const got = summarizeAggregate([
    { history: {}, usd: { currentValue: 80, pnl: 20, pnlPct: 20,
      grossAddedExact: true, collectedProceedsExact: true, vsHodl: 1 } },
    { history: {}, usd: { currentValue: 10, pnl: null,
      grossAddedExact: false, collectedProceedsExact: true, vsHodl: 0 } },
  ]);
  assert.match(got.returnLine, /^LP return \+\$20\.00/);
  assert.match(got.returnLine, /1 bound/);
  assert.match(got.valueLine, /^in positions \$90\.00/);
}

testClaimDoesNotMoveReturn();
testPartialRemoveDoesNotMoveReturn();
testReinvestedCapitalIsNotStillHeld();
testBoundsFailClosed();
await testExactPairCanResolveSingleSidedAdd();
await testEveryAddUsesItsOwnEventPrice();
await testCollectionAtEventPrice();
await testNoCollectedTokensInCurrentValue();
await testOverlayKeepsDollarReturnAsHeadline();
testAggregateLabelsAndExclusions();
console.log('cash-flow pnl: 10 regression groups passed');
