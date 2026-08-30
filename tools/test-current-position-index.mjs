#!/usr/bin/env node
import assert from 'node:assert/strict';

const rows = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (keys === null) return { ...rows };
        if (typeof keys === 'string') return Object.hasOwn(rows, keys) ? { [keys]: rows[keys] } : {};
        return Object.fromEntries((keys || []).filter((key) => Object.hasOwn(rows, key))
          .map((key) => [key, rows[key]]));
      },
      async set(values) { Object.assign(rows, values); },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete rows[key];
      },
    },
  },
};

const index = await import(`../extension/lib/current-position-index.js?t=${Date.now()}`);
const OWNER = '0x' + '11'.repeat(20);

assert.deepEqual(index.normalizeCurrentPositionIds(['9', 2n, '2', '-1', 'bad']), ['2', '9']);

assert.equal(await index.writeFullDiscoveryScope({
  owner: OWNER,
  chainKey: 'base',
  at: 100,
  discovery: {
    v3: { complete: true, ids: ['9', '2', '2'] },
    v4: { complete: true, ids: [] },
  },
}), true);
let scope = await index.readCurrentPositionScope(OWNER, 'base');
assert.deepEqual(scope.v3, { complete: true, ids: ['2', '9'] });
assert.deepEqual(scope.v4, { complete: true, ids: [] });

// A partial later discovery may add proof but cannot delete unseen IDs. It
// must disable fast readiness until another complete Full rescan succeeds.
await index.writeFullDiscoveryScope({
  owner: OWNER,
  chainKey: 'base',
  at: 200,
  discovery: {
    v3: { complete: false, ids: ['12'] },
    v4: { complete: false, ids: ['77'] },
  },
});
scope = await index.readCurrentPositionScope(OWNER, 'base');
assert.deepEqual(scope.v3, { complete: false, ids: ['2', '9', '12'] });
assert.deepEqual(scope.v4, { complete: false, ids: ['77'] });

// A complete empty discovery is authoritative and clears only that protocol.
await index.writeFullDiscoveryScope({
  owner: OWNER,
  chainKey: 'base',
  at: 300,
  discovery: {
    v3: { complete: true, ids: [] },
    v4: { complete: false, ids: [] },
  },
});
scope = await index.readCurrentPositionScope(OWNER, 'base');
assert.deepEqual(scope.v3.ids, []);
assert.deepEqual(scope.v4.ids, ['77']);
let jobs = await index.readCurrentPositionJobs([{ address: OWNER }], ['base']);
assert.equal(jobs[0].ready, false, 'partial v4 discovery must disable fast refresh');

// A later complete scan restores readiness and replaces both protocol sets.
await index.writeFullDiscoveryScope({
  owner: OWNER,
  chainKey: 'base',
  at: 350,
  discovery: {
    v3: { complete: true, ids: [] },
    v4: { complete: true, ids: ['77'] },
  },
});

// Fast refresh replaces only its remembered-open subset after live proof.
await index.writeCurrentRefreshScope({
  owner: OWNER,
  chainKey: 'base',
  at: 400,
  ids: { v3: ['55'], v4: [] },
});
scope = await index.readCurrentPositionScope(OWNER, 'base');
assert.deepEqual(scope.v3.ids, ['55']);
assert.deepEqual(scope.v4.ids, []);
assert.equal(scope.fullScanAt, 350);
assert.equal(scope.refreshedAt, 400);

jobs = await index.readCurrentPositionJobs([{ address: OWNER }], ['base', 'ethereum']);
assert.equal(jobs.length, 2);
assert.equal(jobs.find((job) => job.chainKey === 'base').ready, true);
assert.equal(jobs.find((job) => job.chainKey === 'ethereum').ready, false);

assert.equal(await index.markCurrentPositionScopeIncomplete({
  owner: OWNER,
  chainKey: 'base',
}), true);
scope = await index.readCurrentPositionScope(OWNER, 'base');
assert.deepEqual(scope.v3.ids, ['55']);
assert.deepEqual(scope.v4.ids, []);
assert.equal(scope.v3.complete, false);
assert.equal(scope.v4.complete, false);
jobs = await index.readCurrentPositionJobs([{ address: OWNER }], ['base']);
assert.equal(jobs[0].ready, false, 'a failed Full rescan must disable fast refresh');

const key = `${index.CURRENT_POSITION_INDEX_PREFIX}base:${OWNER}`;
rows[key] = { ...rows[key], owner: '0x' + '22'.repeat(20) };
assert.equal(await index.readCurrentPositionScope(OWNER, 'base'), null,
  'cross-owner local state must be ignored');

console.log('current position index: sanitization, replacement, merge and readiness pass');
