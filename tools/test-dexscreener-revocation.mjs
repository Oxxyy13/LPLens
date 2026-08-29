#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const workerSource = readFileSync(new URL('../extension/sw.js', import.meta.url), 'utf8')
  .replace(/^import .*?;\r?\n/gm, '');

const POOL = '0x1111111111111111111111111111111111111111';
const ADDRESS = '0x2222222222222222222222222222222222222222';
const HREF = `https://dexscreener.com/robinhood/${POOL}`;
const DEX_ORIGIN = 'https://dexscreener.com/*';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
};

async function workerHarness({
  permission = false,
  consent = true,
  consentPresent = true,
  loadPositionsImpl = async () => ({ positions: [] }),
  pairGetImpl = async () => null,
} = {}) {
  const listeners = [];
  const counters = {
    entitlement: 0,
    loadPositions: 0,
    pairGet: 0,
    executeScript: 0,
  };
  let dexPermission = permission;
  let chartConsent = consent;

  const chrome = {
    runtime: {
      id: 'test-extension',
      getURL: (path = '') => `chrome-extension://test-extension/${path}`,
      onMessage: { addListener: (listener) => listeners.push(listener) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
    },
    permissions: {
      contains: async ({ origins = [] } = {}) => (
        origins.includes(DEX_ORIGIN) ? dexPermission : false
      ),
      onAdded: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    storage: {
      local: {
        get: async (keys) => {
          const requested = Array.isArray(keys) ? keys : [keys];
          const out = {};
          if (consentPresent && requested.includes('dexscreenerChartConsentV1')) {
            out.dexscreenerChartConsentV1 = chartConsent;
          }
          if (requested.includes('address')) out.address = ADDRESS;
          if (requested.includes('rpcOverrides')) out.rpcOverrides = {};
          if (requested.includes('etherscanKey')) out.etherscanKey = '';
          return out;
        },
      },
      onChanged: { addListener: () => {} },
    },
    scripting: {
      executeScript: async () => {
        counters.executeScript += 1;
        return [{ result: { ok: false, reason: 'not-needed-in-revocation-test' } }];
      },
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async () => {},
      updateContentScripts: async () => {},
      unregisterContentScripts: async () => {},
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => {},
    },
  };

  const deps = {
    CHAINS: {
      robinhood: {
        dexscreener: 'robinhood',
        usdRef: {
          nativeEquivalent: true,
          weth: '0x3333333333333333333333333333333333333333',
        },
      },
    },
    loadPositionByVersion: async () => null,
    loadPositions: async (...args) => {
      counters.loadPositions += 1;
      return loadPositionsImpl(...args);
    },
    entitlement: async () => {
      counters.entitlement += 1;
      return { allowed: true };
    },
    historyRelayCredentials: async () => null,
    createDexscreenerPairCache: () => ({
      get: async (...args) => {
        counters.pairGet += 1;
        return pairGetImpl(...args);
      },
    }),
  };

  const context = vm.createContext({
    chrome,
    URL,
    AbortSignal,
    setTimeout,
    clearTimeout,
    console,
    __deps: deps,
  });
  const prelude = `
    const {
      CHAINS, loadPositionByVersion, loadPositions, entitlement,
      historyRelayCredentials, createDexscreenerPairCache,
    } = globalThis.__deps;
  `;
  vm.runInContext(prelude + workerSource, context, { filename: 'sw-revocation-test.js' });
  await Promise.resolve();
  await Promise.resolve();

  const dispatch = async (msg, sender = { tab: { id: 17, url: HREF } }) => {
    for (const listener of listeners) {
      const reply = deferred();
      const keepAlive = listener(msg, sender, reply.resolve);
      if (keepAlive === true) {
        return await Promise.race([
          reply.promise,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(`message timed out: ${msg.type}`)), 2_000)),
        ]);
      }
    }
    throw new Error(`no worker listener accepted ${msg.type}`);
  };

  return {
    counters,
    dispatch,
    setPermission: (value) => { dexPermission = value; },
    setConsent: (value) => { chartConsent = value; },
  };
}

const poolMessage = {
  type: 'LPLENS_DEXSCREENER_POOL',
  chain: 'robinhood',
  poolRef: POOL,
};
const chartMessage = {
  type: 'LPLENS_DEXSCREENER_CHART_GEOMETRY',
  href: HREF,
  ranges: [{ id: 'r0', lo: 1, now: 2, hi: 3 }],
};

const deniedPool = await workerHarness({ permission: false });
const deniedPoolReply = await deniedPool.dispatch(poolMessage);
assert.equal(deniedPoolReply.permissionRevoked, true);
assert.equal(deniedPool.counters.entitlement, 0,
  'start-denied pool request must stop before entitlement or chain work');
assert.equal(deniedPool.counters.loadPositions, 0);
assert.equal(deniedPool.counters.pairGet, 0);

const deniedChart = await workerHarness({ permission: false, consent: true });
const deniedChartReply = await deniedChart.dispatch(chartMessage);
assert.equal(deniedChartReply.reason, 'permission-revoked');
assert.equal(deniedChart.counters.pairGet, 0,
  'start-denied chart request must stop before pair metadata');
assert.equal(deniedChart.counters.executeScript, 0,
  'start-denied chart request must never enter MAIN world');

for (const [label, consent, consentPresent] of [
  ['missing', undefined, false],
  ['false', false, true],
  ['string true', 'true', true],
  ['numeric true', 1, true],
  ['object', {}, true],
  ['null', null, true],
]) {
  const deniedConsent = await workerHarness({
    permission: true,
    consent,
    consentPresent,
  });
  const reply = await deniedConsent.dispatch(chartMessage);
  assert.equal(reply.reason, 'chart-consent-required',
    `${label} chart consent must fail closed`);
  assert.equal(deniedConsent.counters.pairGet, 0,
    `${label} chart consent must stop before pair metadata`);
  assert.equal(deniedConsent.counters.executeScript, 0,
    `${label} chart consent must never enter MAIN world`);
}

const poolGate = deferred();
const poolStarted = deferred();
const midPool = await workerHarness({
  permission: true,
  loadPositionsImpl: async () => {
    poolStarted.resolve();
    return await poolGate.promise;
  },
  pairGetImpl: async () => ({
    baseToken: { address: ADDRESS, symbol: 'BASE' },
    quoteToken: {
      address: '0x3333333333333333333333333333333333333333', symbol: 'QUOTE',
    },
    quoteFresh: true,
    priceNative: 1,
    priceUsd: 2,
    marketCap: 3,
    fdv: 4,
  }),
});
const midPoolReplyPromise = midPool.dispatch(poolMessage);
await poolStarted.promise;
midPool.setPermission(false);
poolGate.resolve({
  positions: [{ version: 'v3', pool: POOL, privateSentinel: 'must-not-cross' }],
});
const midPoolReply = await midPoolReplyPromise;
assert.equal(midPoolReply.permissionRevoked, true);
assert.doesNotMatch(JSON.stringify(midPoolReply), /must-not-cross|positions|address/i,
  'mid-flight revocation must not return wallet or position data');

const pairGate = deferred();
const pairStarted = deferred();
const midChart = await workerHarness({
  permission: true,
  consent: true,
  pairGetImpl: async () => {
    pairStarted.resolve();
    return await pairGate.promise;
  },
});
const midChartReplyPromise = midChart.dispatch(chartMessage);
await pairStarted.promise;
midChart.setPermission(false);
pairGate.resolve({
  baseToken: { address: ADDRESS, symbol: 'BASE' },
  quoteToken: {
    address: '0x3333333333333333333333333333333333333333', symbol: 'QUOTE',
  },
  quoteFresh: true,
  priceNative: 1,
  priceUsd: 2,
  marketCap: 3,
  fdv: 4,
});
const midChartReply = await midChartReplyPromise;
assert.equal(midChartReply.reason, 'permission-revoked');
assert.equal(midChart.counters.executeScript, 0,
  'mid-flight revocation must be rechecked before MAIN-world execution');

const consentPairGate = deferred();
const consentPairStarted = deferred();
const midConsent = await workerHarness({
  permission: true,
  consent: true,
  pairGetImpl: async () => {
    consentPairStarted.resolve();
    return await consentPairGate.promise;
  },
});
const midConsentReplyPromise = midConsent.dispatch(chartMessage);
await consentPairStarted.promise;
midConsent.setConsent(false);
consentPairGate.resolve({
  baseToken: { address: ADDRESS, symbol: 'BASE' },
  quoteToken: {
    address: '0x3333333333333333333333333333333333333333', symbol: 'QUOTE',
  },
  quoteFresh: true,
  priceNative: 1,
  priceUsd: 2,
  marketCap: 3,
  fdv: 4,
});
const midConsentReply = await midConsentReplyPromise;
assert.equal(midConsentReply.reason, 'permission-revoked');
assert.equal(midConsent.counters.executeScript, 0,
  'mid-flight consent revocation must be rechecked before MAIN-world execution');

console.log('Dexscreener revocation: permission and strict chart consent fail closed');
