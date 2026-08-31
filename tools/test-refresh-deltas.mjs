#!/usr/bin/env node
import assert from 'node:assert/strict';

const rows = {};
let storageFails = false;
globalThis.chrome = {
  storage: { local: {
    async get(keys) {
      if (storageFails) throw new Error('storage unavailable');
      if (keys === null) return { ...rows };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => Object.hasOwn(rows, key))
        .map((key) => [key, rows[key]]));
    },
    async set(values) {
      if (storageFails) throw new Error('storage unavailable');
      Object.assign(rows, values);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete rows[key];
    },
  } },
};

const delta = await import(`../extension/lib/refresh-deltas.js?t=${Date.now()}`);
const OWNER = `0x${'11'.repeat(20)}`;
const OTHER = `0x${'22'.repeat(20)}`;
const TOKEN0 = `0x${'33'.repeat(20)}`;
const TOKEN1 = `0x${'44'.repeat(20)}`;
const POOL = `0x${'55'.repeat(20)}`;

function position(overrides = {}) {
  return {
    ownerAddress: OWNER,
    chainKey: 'ethereum',
    version: 'v3',
    tokenId: 7n,
    pool: POOL,
    token0: TOKEN0,
    token1: TOKEN1,
    fee: 3000,
    tickLower: -120,
    tickUpper: 120,
    status: 'in-range',
    history: {
      fees0: 1,
      fees1: 2,
      adds: 1,
      collections: [],
      currentUnavailable: false,
    },
    usd: {
      currentValue: 100,
      pnl: 10,
      vsHodl: 3,
      price0: 2,
      price1: 4,
      grossAdded: 90,
      grossAddedExact: true,
      collectedProceeds: 0,
      collectedProceedsExact: true,
      returnUnavailable: null,
    },
    ...overrides,
  };
}

const first = position();
const key = delta.positionRefreshKey(first);
assert.match(key, /^delta:v1:ethereum:0x[0-9a-f]{40}:0x[0-9a-f]{40}:v3:7$/);
assert.notEqual(delta.positionRefreshKey(position({ ownerAddress: OTHER })), key);
assert.notEqual(delta.positionRefreshKey(position({ tokenId: 8n })), key);
assert.equal(delta.positionRefreshKey(position({ chainKey: 'unknown' })), null);

const acceptedSidePanel = {
  sidePanel: true,
  allFailed: false,
  preservedCurrentView: false,
};
assert.equal(delta.shouldAdvanceRefreshSamples(acceptedSidePanel), true,
  'a final accepted side-panel refresh advances the visible baseline');
assert.equal(delta.shouldAdvanceRefreshSamples({ ...acceptedSidePanel, partialFull: true }), true,
  'a partial Full result that becomes the accepted view also advances');
assert.equal(delta.shouldAdvanceRefreshSamples({ ...acceptedSidePanel, sidePanel: false }), false,
  'a popup scan must not silently advance the side-panel baseline');
assert.equal(delta.shouldAdvanceRefreshSamples({ ...acceptedSidePanel, allFailed: true }), false);
assert.equal(delta.shouldAdvanceRefreshSamples({
  ...acceptedSidePanel, preservedCurrentView: true,
}), false);
assert.equal(delta.shouldAdvanceRefreshSamples({
  ...acceptedSidePanel, progressivePaint: true,
}), false);
assert.equal(delta.shouldAdvanceRefreshSamples({
  ...acceptedSidePanel, localMutation: true,
}), false, 'hide and restore are not on-chain observations');

const firstSample = delta.captureRefreshSample(first, 1000);
assert.ok(firstSample);
assert.equal(delta.compareRefreshSamples(null, firstSample), null);
assert.equal(delta.attachRefreshDeltas([first], new Map(), 1000)[0].refreshDelta.baseline, true);

const second = position({
  status: 'above',
  history: { ...first.history, fees0: 1.5, fees1: 2.25 },
  usd: {
    ...first.usd,
    currentValue: 95,
    pnl: 12,
    vsHodl: 2,
    price0: 3,
    price1: 5,
  },
});
const comparison = delta.compareRefreshSamples(firstSample, delta.captureRefreshSample(second, 2000));
assert.equal(comparison.positionValueUsd, -5);
assert.equal(comparison.lpReturnUsd, 2);
assert.equal(comparison.vsHoldingUsd, -1);
assert.equal(comparison.feesGainedUsd, 2.75);
assert.equal(comparison.statusChanged, true);
assert.equal(comparison.fromStatus, 'in-range');
assert.equal(comparison.toStatus, 'above');

// Token-price movement alone must not be mislabeled as newly earned fees.
const repriced = position({ usd: { ...first.usd, price0: 20, price1: 40 } });
assert.equal(delta.compareRefreshSamples(
  firstSample, delta.captureRefreshSample(repriced, 2000),
).feesGainedUsd, 0);

const revised = position({ history: { ...first.history, fees0: 0.9 } });
const revision = delta.compareRefreshSamples(firstSample, delta.captureRefreshSample(revised, 2000));
assert.equal(revision.feesGainedUsd, null);
assert.equal(revision.feesRevised, true);

const added = position({
  history: { ...first.history, adds: 2 },
  usd: { ...first.usd, currentValue: 150, grossAdded: 140, pnl: 10 },
});
const addedDelta = delta.compareRefreshSamples(firstSample, delta.captureRefreshSample(added, 2000));
assert.equal(addedDelta.positionValueUsd, 50);
assert.equal(addedDelta.lpReturnUsd, 0);
assert.equal(addedDelta.cashFlowChanged, true);
assert.equal(addedDelta.additionsChanged, true);

const changedIdentity = position({ tickUpper: 240 });
assert.equal(delta.compareRefreshSamples(
  firstSample, delta.captureRefreshSample(changedIdentity, 2000),
), null);

assert.equal(await delta.writeRefreshSamples([first], 1000), 1);
const saved = await delta.readRefreshSamples([first]);
assert.equal(saved.get(key).at, 1000);
rows[key] = { ...rows[key], currentValueUsd: 1n };
assert.equal((await delta.readRefreshSamples([first])).size, 0,
  'BigInt or malformed local rows must be ignored');

for (const storedKey of Object.keys(rows)) delete rows[storedKey];
const many = Array.from({ length: delta.MAX_REFRESH_SAMPLES + 2 }, (_, tokenId) => (
  position({ tokenId: BigInt(tokenId) })
));
assert.equal(await delta.writeRefreshSamples(many, 2500), many.length);
assert.equal(Object.keys(rows).filter((storedKey) => (
  storedKey.startsWith(delta.REFRESH_DELTA_PREFIX)
)).length, delta.MAX_REFRESH_SAMPLES, 'the local comparison cache must stay bounded');

storageFails = true;
assert.equal(await delta.writeRefreshSamples([first], 3000), 0);
assert.equal((await delta.readRefreshSamples([first])).size, 0);

console.log('refresh deltas: state machine, identity, exact metrics, fee units and storage failure pass');
