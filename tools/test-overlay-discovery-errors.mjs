#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/sw.js', import.meta.url), 'utf8')
  .replace(/^import .*?;\r?\n/gm, '');
const ADDRESS = '0x' + '11'.repeat(20);
const POOL = '0x' + '22'.repeat(20);
const empty = () => ({ positions: [], deploymentIssues: [],
  discovery: { v3: { complete: true }, v4: { complete: true } },
  v4: { unreadable: 0, unavailable: null } });

function harness(results) {
  const listeners = [];
  const event = { addListener() {} };
  let loads = 0;
  const store = { address: ADDRESS, rpcOverrides: {}, etherscanKey: '' };
  const chrome = {
    runtime: { id: 'test', getURL: (p) => `chrome-extension://test/${p}`,
      onMessage: { addListener: (f) => listeners.push(f) }, onInstalled: event, onStartup: event },
    permissions: { contains: async () => true, onAdded: event, onRemoved: event },
    storage: { local: { get: async () => store }, onChanged: event },
    scripting: { executeScript: async () => [], getRegisteredContentScripts: async () => [],
      registerContentScripts: async () => {}, updateContentScripts: async () => {},
      unregisterContentScripts: async () => {} },
    tabs: { query: async () => [], sendMessage: async () => {} },
  };
  const deps = {
    CHAINS: { robinhood: { usdRef: {} }, hyperevm: { usdRef: {} } },
    loadPositionByVersion: async () => null,
    loadPositions: async () => structuredClone(results[Math.min(loads++, results.length - 1)]),
    entitlement: async () => ({ allowed: true }), historyRelayCredentials: async () => null,
    createDexscreenerPairCache: () => ({ get: async () => null }),
  };
  vm.runInNewContext(`const {CHAINS, loadPositionByVersion, loadPositions, entitlement,
    historyRelayCredentials, createDexscreenerPairCache} = __deps;\n` + source,
  { chrome, URL, AbortSignal, setTimeout, clearTimeout, console, __deps: deps });
  const dispatch = (projectx = false) => new Promise((resolve, reject) => {
    const msg = projectx ? { type: 'LPLENS_PROJECTX_PORTFOLIO' } : {
      type: 'LPLENS_DEXSCREENER_POOL', chain: 'robinhood', poolRef: POOL,
    };
    const url = projectx ? 'https://www.prjx.com/portfolio' : `https://dexscreener.com/robinhood/${POOL}`;
    for (const f of listeners) if (f(msg, { tab: { id: 1, url } }, resolve) === true) return;
    reject(new Error('No listener accepted the request'));
  });
  return { dispatch, loads: () => loads, store };
}

const failures = [
  { deploymentIssues: [{ deploymentId: 'projectx-v3', error: 'eth_call: HTTP 429' }] },
  { enumUnreadable: 1 }, { positionUnreadable: 1 }, { truncated: true },
  { stoppedEarly: true }, { v4: { unreadable: 1 } },
  { v4: { unavailable: 'Blockscout HTTP 429' } },
  { discovery: { v3: { complete: false } } },
  { discovery: { v4: { complete: false } } },
];
for (const failure of failures) {
  for (const projectx of [false, true]) {
    const h = harness([{ ...empty(), ...failure }, empty()]);
    const failed = await h.dispatch(projectx);
    assert.equal(failed.ok, true, 'readable partial data remains usable');
    assert.match(failed.data.unavailable, /Refresh this page to retry/);
    if (JSON.stringify(failure).includes('429')) assert.match(failed.data.unavailable, /rate-limiting/);
    const recovered = await h.dispatch(projectx);
    assert.equal(recovered.data.unavailable, null);
    assert.equal(h.loads(), 2, 'failed discovery must not poison the empty cache');
  }
}

const partial = harness([{ ...empty(), positions: [{ version: 'v3', pool: POOL }], positionUnreadable: 1 }]);
assert.equal((await partial.dispatch()).data.positions.length, 1);
assert.match((await partial.dispatch()).data.unavailable, /Some positions could not be read/);
assert.equal(partial.loads(), 2);

const complete = harness([empty()]);
assert.equal((await complete.dispatch()).data.unavailable, null);
assert.equal((await complete.dispatch()).data.positions.length, 0);
assert.equal(complete.loads(), 1, 'genuinely complete empty results may be cached');
complete.store.rpcOverrides = { robinhood: 'https://new-rpc.fixture.invalid' };
await complete.dispatch();
assert.equal(complete.loads(), 2, 'RPC changes must not reuse the old scan');

console.log('overlay discovery: errors survive, partial results remain visible, failed caches recover');
