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
const { v3Deployment } = await import('../extension/lib/chains.js');
const OWNER = '0x' + '11'.repeat(20);
const BASE_V3 = v3Deployment('base');
const ROBINHOOD_V3 = v3Deployment('robinhood');
const UP33 = v3Deployment('robinhood', 'up33-cl');
const GAUGE = `0x${'aa'.repeat(20)}`;
const coverage = (...deployments) => deployments.map((deployment) => (
  `${deployment.id}@${deployment.nfpm.toLowerCase()}`
)).sort();

const record = (tokenId, deployment = BASE_V3, overrides = {}) => ({
  tokenId: String(tokenId),
  deploymentId: deployment.id,
  manager: deployment.nfpm.toLowerCase(),
  custody: 'wallet',
  ...overrides,
});
const protocol = (complete, ids) => ({
  complete,
  records: ids.map((id) => record(id)),
  ids: ids.map(String),
  deploymentCoverage: coverage(BASE_V3),
});

assert.deepEqual(index.normalizeCurrentPositionIds(['9', 2n, '2', '-1', 'bad']), ['2', '9']);
assert.deepEqual(index.normalizeCurrentV3Records(['9', 2n, '2', '-1', 'bad'], 'base'), [
  record('2'), record('9'),
]);

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
assert.equal(scope.version, index.CURRENT_POSITION_INDEX_VERSION);
assert.deepEqual(scope.v3, protocol(true, ['2', '9']));
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
assert.deepEqual(scope.v3, protocol(false, ['2', '9', '12']));
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

// Existing v1 rows migrate only to the historical default manager and direct
// wallet custody. They never fan out into a newly configured deployment.
const LEGACY_OWNER = `0x${'22'.repeat(20)}`;
const legacyKey = `${index.CURRENT_POSITION_INDEX_PREFIX}robinhood:${LEGACY_OWNER}`;
rows[legacyKey] = {
  version: 1,
  owner: LEGACY_OWNER,
  chainKey: 'robinhood',
  fullScanAt: 500,
  refreshedAt: null,
  v3: { complete: true, ids: ['7'] },
  v4: { complete: true, ids: [] },
};
scope = await index.readCurrentPositionScope(LEGACY_OWNER, 'robinhood');
assert.equal(scope.version, index.CURRENT_POSITION_INDEX_VERSION);
assert.deepEqual(scope.v3, {
  complete: false,
  records: [record('7', ROBINHOOD_V3)],
  ids: ['7'],
  deploymentCoverage: [],
});
jobs = await index.readCurrentPositionJobs([{ address: LEGACY_OWNER }], ['robinhood']);
assert.equal(jobs[0].ready, false,
  'a pre-UP33 Robinhood index must require Full rescan before fast refresh');

const LEGACY_SINGLE_OWNER = `0x${'44'.repeat(20)}`;
const legacySingleKey = `${index.CURRENT_POSITION_INDEX_PREFIX}base:${LEGACY_SINGLE_OWNER}`;
rows[legacySingleKey] = {
  version: 1,
  owner: LEGACY_SINGLE_OWNER,
  chainKey: 'base',
  fullScanAt: 525,
  refreshedAt: null,
  v3: { complete: true, ids: ['7'] },
  v4: { complete: true, ids: [] },
};
scope = await index.readCurrentPositionScope(LEGACY_SINGLE_OWNER, 'base');
assert.equal(scope.v3.complete, false,
  'bare-ID v1 rows must not invent current manager coverage');
assert.deepEqual(scope.v3.deploymentCoverage, []);

const SCOPED_V2_OWNER = `0x${'55'.repeat(20)}`;
const scopedV2Key = `${index.CURRENT_POSITION_INDEX_PREFIX}base:${SCOPED_V2_OWNER}`;
rows[scopedV2Key] = {
  version: index.CURRENT_POSITION_INDEX_VERSION,
  owner: SCOPED_V2_OWNER,
  chainKey: 'base',
  fullScanAt: 540,
  refreshedAt: null,
  v3: { complete: true, records: [record('7')], ids: ['7'] },
  v4: { complete: true, ids: [] },
};
scope = await index.readCurrentPositionScope(SCOPED_V2_OWNER, 'base');
assert.equal(scope.v3.complete, false,
  'an early v2 row without exact deployment coverage must require Full rescan');
assert.deepEqual(scope.v3.deploymentCoverage, []);

// Early v2 rows shipped before the coverage field existed. Even if they hold
// manager-scoped records, they cannot prove that the configured deployment set
// has not changed since their Full rescan.
const PRE_COVERAGE_OWNER = `0x${'33'.repeat(20)}`;
const preCoverageKey = `${index.CURRENT_POSITION_INDEX_PREFIX}robinhood:${PRE_COVERAGE_OWNER}`;
rows[preCoverageKey] = {
  version: index.CURRENT_POSITION_INDEX_VERSION,
  owner: PRE_COVERAGE_OWNER,
  chainKey: 'robinhood',
  fullScanAt: 550,
  refreshedAt: null,
  v3: { complete: true, records: [record('7', UP33)], ids: [] },
  v4: { complete: true, ids: [] },
};
scope = await index.readCurrentPositionScope(PRE_COVERAGE_OWNER, 'robinhood');
assert.equal(scope.v3.complete, false,
  'a multi-manager v2 row without exact deployment coverage must fail closed');
jobs = await index.readCurrentPositionJobs([{ address: PRE_COVERAGE_OWNER }], ['robinhood']);
assert.equal(jobs[0].ready, false);

// A partial Full rescan after the upgrade may add newly proven records, but it
// must retain pre-upgrade records it could not disprove and remain unready.
await index.writeFullDiscoveryScope({
  owner: PRE_COVERAGE_OWNER,
  chainKey: 'robinhood',
  at: 575,
  discovery: {
    v3: { complete: false, records: [record('9', ROBINHOOD_V3)] },
    v4: { complete: true, ids: [] },
  },
});
scope = await index.readCurrentPositionScope(PRE_COVERAGE_OWNER, 'robinhood');
assert.equal(scope.v3.complete, false,
  'a partial post-upgrade Full rescan must not restore fast-refresh readiness');
assert.deepEqual(scope.v3.records, [
  record('9', ROBINHOOD_V3),
  record('7', UP33),
], 'a partial post-upgrade Full rescan must preserve remembered manager-scoped records');
assert.deepEqual(scope.v3.deploymentCoverage, coverage(ROBINHOOD_V3, UP33));
jobs = await index.readCurrentPositionJobs([{ address: PRE_COVERAGE_OWNER }], ['robinhood']);
assert.equal(jobs[0].ready, false);

// A nonempty coverage proof can still be stale. This models a row written
// before UP33 became a configured Robinhood deployment.
const STALE_COVERAGE_OWNER = `0x${'66'.repeat(20)}`;
const staleCoverageKey = `${index.CURRENT_POSITION_INDEX_PREFIX}robinhood:${STALE_COVERAGE_OWNER}`;
rows[staleCoverageKey] = {
  version: index.CURRENT_POSITION_INDEX_VERSION,
  owner: STALE_COVERAGE_OWNER,
  chainKey: 'robinhood',
  fullScanAt: 580,
  refreshedAt: null,
  v3: {
    complete: true,
    records: [record('7', ROBINHOOD_V3)],
    ids: ['7'],
    deploymentCoverage: coverage(ROBINHOOD_V3),
  },
  v4: { complete: true, ids: [] },
};
scope = await index.readCurrentPositionScope(STALE_COVERAGE_OWNER, 'robinhood');
assert.equal(scope.v3.complete, false,
  'a nonempty but stale deployment coverage proof must require Full rescan');
assert.deepEqual(scope.v3.records, [record('7', ROBINHOOD_V3)],
  'invalidating stale coverage must not discard remembered records');
assert.deepEqual(scope.v3.deploymentCoverage, coverage(ROBINHOOD_V3));
jobs = await index.readCurrentPositionJobs([{ address: STALE_COVERAGE_OWNER }], ['robinhood']);
assert.equal(jobs[0].ready, false);

// Equal token IDs in different managers and custody contracts remain distinct.
assert.equal(await index.writeFullDiscoveryScope({
  owner: LEGACY_OWNER,
  chainKey: 'robinhood',
  at: 600,
  discovery: {
    v3: {
      complete: true,
      records: [
        record('7', ROBINHOOD_V3),
        record('7', UP33),
        record('8', UP33, { custody: 'gauge', custodian: GAUGE }),
        { ...record('8', UP33), manager: ROBINHOOD_V3.nfpm },
        record('9', UP33, { custody: 'gauge' }),
        record('10', UP33),
        record('10', UP33, { custody: 'gauge', custodian: GAUGE }),
      ],
    },
    v4: { complete: true, ids: [] },
  },
}), true);
scope = await index.readCurrentPositionScope(LEGACY_OWNER, 'robinhood');
assert.equal(scope.v3.records.length, 3,
  'invalid records and conflicting custody claims must fail closed');
assert.equal(scope.v3.complete, false,
  'a complete claim containing an invalid deployment record must not enable fast refresh');
assert.deepEqual(scope.v3.ids, ['7'],
  'the compatibility ID list must contain only default-manager wallet custody');
assert.deepEqual(scope.v3.deploymentCoverage, coverage(ROBINHOOD_V3, UP33),
  'a Full rescan must record every configured manager in its coverage proof');
assert.equal(new Set(scope.v3.records.map((row) => (
  `${row.manager}:${row.tokenId}`
))).size, 3);

await index.writeFullDiscoveryScope({
  owner: LEGACY_OWNER,
  chainKey: 'robinhood',
  at: 650,
  discovery: {
    v3: {
      complete: true,
      records: [
        record('7', ROBINHOOD_V3),
        record('7', UP33),
        record('8', UP33, { custody: 'gauge', custodian: GAUGE }),
      ],
    },
    v4: { complete: true, ids: [] },
  },
});
scope = await index.readCurrentPositionScope(LEGACY_OWNER, 'robinhood');
assert.equal(scope.v3.complete, true,
  'a complete multi-manager Full rescan must restore fast-refresh readiness');
assert.deepEqual(scope.v3.deploymentCoverage, coverage(ROBINHOOD_V3, UP33));
jobs = await index.readCurrentPositionJobs([{ address: LEGACY_OWNER }], ['robinhood']);
assert.equal(jobs[0].ready, true);
await index.writeCurrentRefreshScope({
  owner: LEGACY_OWNER,
  chainKey: 'robinhood',
  at: 675,
  ids: { v3: ['11'], v4: [] },
});
scope = await index.readCurrentPositionScope(LEGACY_OWNER, 'robinhood');
assert.deepEqual(scope.v3.ids, ['11']);
assert.deepEqual(scope.v3.records.map((row) => `${row.manager}:${row.tokenId}`), [
  `${ROBINHOOD_V3.nfpm.toLowerCase()}:11`,
  `${UP33.nfpm.toLowerCase()}:7`,
  `${UP33.nfpm.toLowerCase()}:8`,
], 'a legacy current refresh must preserve deployments it cannot inspect');

await index.writeCurrentRefreshScope({
  owner: LEGACY_OWNER,
  chainKey: 'robinhood',
  at: 700,
  ids: {
    v3Records: [record('7', UP33, { custody: 'gauge', custodian: GAUGE })],
    v4: [],
  },
});
scope = await index.readCurrentPositionScope(LEGACY_OWNER, 'robinhood');
assert.deepEqual(scope.v3.records, [record('7', UP33, {
  custody: 'gauge', custodian: GAUGE,
})]);
assert.deepEqual(scope.v3.ids, []);
assert.deepEqual(scope.v3.deploymentCoverage, coverage(ROBINHOOD_V3, UP33),
  'fast refresh must preserve the Full rescan deployment coverage proof');

await index.writeCurrentRefreshScope({
  owner: LEGACY_OWNER,
  chainKey: 'robinhood',
  ids: {
    v3: {
      complete: true,
      records: [record('7', UP33, { custody: 'gauge', custodian: GAUGE })],
      deploymentCoverage: coverage(ROBINHOOD_V3),
    },
    v4: [],
  },
});
scope = await index.readCurrentPositionScope(LEGACY_OWNER, 'robinhood');
assert.equal(scope.v3.complete, true);
assert.deepEqual(scope.v3.deploymentCoverage, coverage(ROBINHOOD_V3, UP33),
  'a current-refresh object must not rewrite Full-rescan deployment coverage');

console.log('current position index: migration, deployment/custody identity and readiness pass');
