#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  collectedProceedsUsd, findBlockAtOrBefore, strategyReturn, sumDepositBasis,
} from '../extension/lib/histprice.js';
import {
  aggregateReasonText, classifyPosition, summarizeAggregate,
} from '../extension/lib/aggregate.js';
import { CHAINS } from '../extension/lib/chains.js';
import {
  tokenPriceChangesSinceFirstAdd, tokenPriceChangesSinceLatestAdd,
} from '../extension/lib/positions.js';

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
    { block: 10, time: 1000, transactionHash: '0x01',
      amount0: 2, amount1: 1, entry: { price: 1, exact: true } },
    { block: 20, time: 2000, transactionHash: '0x02',
      amount0: 3, amount1: 4, entry: { price: 2, exact: true } },
  ];
  const basis = await sumDepositBasis(deposits, async (deposit) => (
    deposit.block === 10
      ? { usd0: 5, usd1: 1, exact: true, source: 'event-math' }
      : { usd0: 9, usd1: 1, exact: true, source: 'event-math' }
  ));
  assert.equal(basis.basis, 42,
    'gross added must sum all additions at their own prices, not reuse the latest buy');
  assert.deepEqual(basis.legs.map((leg) => leg.value), [11, 31]);
  assert.deepEqual(basis.legs.map((leg) => [leg.time, leg.amount0, leg.poolPrice]), [
    [1000, 2, 1], [2000, 3, 2],
  ], 'capital-event metadata must survive historical pricing for the UI timeline');
}

async function testKeylessTimestampBlockSearch() {
  const timestamps = new Map([
    [100, 1000], [101, 1012], [102, 1024], [103, 1036], [104, 1048],
  ]);
  const headerAt = async (block) => ({ number: block, timestamp: timestamps.get(block) });
  assert.equal(await findBlockAtOrBefore(1035, 100, 104, headerAt), 102,
    'timestamp search must return the closest block before the target');
  assert.equal(await findBlockAtOrBefore(1036, 100, 104, headerAt), 103,
    'an exact timestamp must return its own block');
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
  assert.match(overlay, /classList\.toggle\('dense', dense\)/,
    'the gutter must adapt when Uniswap renders dense position rows');
  const render = await readFile(new URL('../extension/render.js', import.meta.url), 'utf8');
  assert.match(render, /box-sizing: border-box;/,
    'declared gutter width must include padding so it cannot overlap the position row');
  assert.match(worker, /rpcOverrides: overrides/,
    'the overlay worker must forward origin-chain RPCs needed for bridged historical pricing');
}

function testAggregateLabelsAndExclusions() {
  const got = summarizeAggregate([
    { history: {}, usd: { currentValue: 80, pnl: 20, pnlPct: 20,
      grossAddedExact: true, collectedProceedsExact: true, vsHodl: 1 } },
    { history: {}, usd: { currentValue: 10, pnl: null,
      grossAddedExact: false, collectedProceedsExact: true, vsHodl: 0,
      returnUnavailable: 'gross additions are bounded' } },
  ]);
  assert.match(got.returnLine, /^LP return \+\$20\.00/);
  assert.match(got.returnLine, /1 bound/);
  assert.match(got.valueLine, /^in positions \$90\.00/);
  assert.deepEqual(got.totalReturn.display, {
    state: 'partial',
    value: '+$20.00',
    tone: 'muted',
    coverage: '1 of 2 positions included',
    included: 1,
    excluded: 1,
    total: 2,
    returnUnavailable: [{ reason: 'gross additions are bounded', count: 1 }],
  });
}

function testSinglePositionAggregateAvailability() {
  const got = summarizeAggregate([{
    history: {},
    usd: {
      currentValue: 9_404,
      vsHodl: 131,
      pnl: null,
      returnUnavailable: 'gross additions unpriced',
    },
  }]);

  assert.equal(got.vsLine, 'vs holding +$131 · 1 position');
  assert.equal(got.returnLine,
    'LP return — · totals exclude 1 of 1 position (1 unpriced)');
  assert.equal(got.valueLine, 'in positions $9,404 · 1 position');
  assert.deepEqual(got.vsHold.display, {
    state: 'complete',
    value: '+$131',
    tone: 'up',
    coverage: '1 position',
    included: 1,
    excluded: 0,
    total: 1,
    returnUnavailable: [],
  });
  assert.deepEqual(got.totalReturn.display, {
    state: 'unavailable',
    value: 'Unavailable',
    tone: 'muted',
    coverage: '0 of 1 position available',
    included: 0,
    excluded: 1,
    total: 1,
    returnUnavailable: [{ reason: 'gross additions unpriced', count: 1 }],
  });
  assert.deepEqual(got.value.display, {
    state: 'complete',
    value: '$9,404',
    tone: 'muted',
    coverage: '1 position',
    included: 1,
    excluded: 0,
    total: 1,
    returnUnavailable: [],
  });

  const negative = summarizeAggregate([{
    history: {},
    usd: { currentValue: 1, vsHodl: -1, pnl: -2 },
  }]);
  assert.equal(negative.vsHold.display.tone, 'down');
  assert.equal(negative.totalReturn.display.tone, 'down');

  const mixed = summarizeAggregate([
    { history: { unavailable: 'missing' }, usd: {} },
    { history: {}, usd: { pnl: null, returnUnavailable: 'gross additions unpriced' } },
    { history: {}, usd: { pnl: null } },
  ]);
  assert.equal(aggregateReasonText(mixed.totalReturn),
    'lifetime history is unavailable for 1 position; entry deposits could not be priced; another position could not be priced',
    'mixed exclusions must name every cause without double-counting exact reasons');

  const principalOnly = summarizeAggregate([{
    history: { unavailable: 'UP33 lifetime accounting unavailable' },
    usd: { value: 500, currentValue: null, currentValueIncomplete: true },
  }]);
  assert.equal(principalOnly.value.display.state, 'unavailable');
  assert.equal(principalOnly.value.included, 0,
    'a staked active-liquidity mark must not masquerade as complete position value');
  assert.equal(aggregateReasonText(principalOnly.value),
    'current value is incomplete for 1 position');
}

function testTokenPriceChangesAreExactAndClearlyAnchored() {
  const oneAdd = tokenPriceChangesSinceFirstAdd({ legs: [{
    block: 20, exact: true, usd0: 2000, usd1: 0.02,
  }] }, 2100, 0.018, 1);
  assert.equal(oneAdd.label, 'opened');
  assert.ok(Math.abs(oneAdd.token0.pct - 5) < 1e-12);
  assert.ok(Math.abs(oneAdd.token1.pct + 10) < 1e-12);

  const multi = tokenPriceChangesSinceFirstAdd({ legs: [
    { block: 30, exact: true, usd0: 2200, usd1: 0.018 },
    { block: 10, exact: true, usd0: 2000, usd1: 0.02 },
  ] }, 2100, 0.018, 2);
  assert.equal(multi.label, 'first add');
  assert.equal(multi.token0.from, 2000, 'the earliest exact addition anchors the move');
  const latest = tokenPriceChangesSinceLatestAdd({ legs: [
    { block: 30, exact: true, usd0: 2200, usd1: 0.018 },
    { block: 10, exact: true, usd0: 2000, usd1: 0.02 },
  ] }, 2420, 0.0198, 2);
  assert.equal(latest.label, 'latest add');
  assert.ok(Math.abs(latest.token0.pct - 10) < 1e-12);
  assert.ok(Math.abs(latest.token1.pct - 10) < 1e-12);
  assert.equal(tokenPriceChangesSinceLatestAdd({ legs: [{
    block: 10, exact: true, usd0: 2000, usd1: 0.02,
  }] }, 2100, 0.018, 1), null, 'one-add positions must not duplicate the opened move');
  assert.equal(tokenPriceChangesSinceFirstAdd({
    legs: [{ block: 10, exact: false, usd0: 2000, usd1: 0.02 }],
  }, 2100, 0.018), null, 'a bounded historical price must stay unavailable');
}

testClaimDoesNotMoveReturn();
testPartialRemoveDoesNotMoveReturn();
testReinvestedCapitalIsNotStillHeld();
testBoundsFailClosed();
await testExactPairCanResolveSingleSidedAdd();
await testEveryAddUsesItsOwnEventPrice();
await testKeylessTimestampBlockSearch();
await testCollectionAtEventPrice();
await testNoCollectedTokensInCurrentValue();
await testOverlayKeepsDollarReturnAsHeadline();
testAggregateLabelsAndExclusions();
testSinglePositionAggregateAvailability();
testTokenPriceChangesAreExactAndClearlyAnchored();
console.log('cash-flow pnl: 13 regression groups passed');
