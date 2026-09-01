#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const manifest = JSON.parse(readFileSync(
  new URL('../extension/manifest.json', import.meta.url), 'utf8',
));
const worker = readFileSync(new URL('../extension/sw.js', import.meta.url), 'utf8');
const overlay = readFileSync(new URL('../extension/overlay.js', import.meta.url), 'utf8');
const options = readFileSync(new URL('../extension/options.html', import.meta.url), 'utf8');
const optionsScript = readFileSync(new URL('../extension/options.js', import.meta.url), 'utf8');

const UP33_ORIGIN = 'https://up33.xyz/*';
const ADDRESS = '0x2222222222222222222222222222222222222222';
const LIQUIDITY_URL = 'https://up33.xyz/liquidity';

assert.equal(manifest.version, '0.33.0');
assert.ok(manifest.optional_host_permissions.includes(UP33_ORIGIN),
  'UP33 must remain optional site access');
assert.ok(!(manifest.host_permissions || []).includes(UP33_ORIGIN),
  'UP33 was widened into install-time host permissions');

const matchBlock = worker.match(
  /const UP33_OVERLAY_MATCHES = Object\.freeze\((\[[\s\S]*?\])\);/,
);
assert.ok(matchBlock, 'UP33 overlay has no explicit match list');
const matches = [...matchBlock[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
assert.deepEqual(matches, [
  'https://up33.xyz/liquidity',
  'https://up33.xyz/liquidity/*',
]);
assert.match(worker, /msg\.type !== 'LPLENS_UP33_LIQUIDITY'/);
assert.match(worker, /loadPositions\('robinhood', address/);
assert.match(worker, /position && position\.protocol \|\| ''\)\.toLowerCase\(\) === 'up33'/);
assert.match(worker, /if \(!\(await up33LiquidityPageAccess\(sender\)\)\)/);
assert.match(worker, /id: UP33_OVERLAY_ID/);

assert.match(overlay, /const UP33_ROUTE = \/\^\\\/liquidity/);
assert.match(overlay, /type: 'LPLENS_UP33_LIQUIDITY'/);
assert.match(overlay, /reads only public position NFT IDs and row geometry to align PnL/);
assert.match(overlay, /button\[data-flow\^="cl-"\]/);
assert.match(overlay, /up33RowHasExactPositionId/);
assert.match(overlay, /Active wallet:/);
assert.match(overlay, /generation !== up33Generation/,
  'an active-wallet change must invalidate an in-flight UP33 response');
assert.match(overlay, /if \(ON_UP33\) \{\s*up33Generation\+\+/,
  'the UP33 overlay must follow an explicit active-wallet change');
assert.match(overlay, /LPLENS_OVERLAY_ACCESS_REVOKED/,
  'the UP33 content script must retain generic live revocation handling');
assert.doesNotMatch(overlay, /window\.ethereum\s*[.(=]/,
  'UP33 overlay gained wallet-provider access');
assert.match(options, /id="up33OverlayPerm"/);
assert.match(options, /up33\.xyz\/liquidity/);
assert.match(optionsScript, /UP33_OVERLAY_ORIGIN/);
assert.match(optionsScript, /removeOverlayPermission\(UP33_OVERLAY_ORIGIN\)/);

const workerSource = worker.replace(/^import .*?;\r?\n/gm, '');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
};

async function workerHarness({
  permission = true,
  loadPositionsImpl = async () => ({ positions: [], deploymentIssues: [] }),
} = {}) {
  const listeners = [];
  const counters = { entitlement: 0, loadPositions: 0 };
  const calls = [];
  let up33Permission = permission;

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
        origins.includes(UP33_ORIGIN) ? up33Permission : false
      ),
      onAdded: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    storage: {
      local: {
        get: async () => ({ address: ADDRESS, rpcOverrides: {}, etherscanKey: '' }),
      },
      onChanged: { addListener: () => {} },
    },
    scripting: {
      executeScript: async () => [],
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
        usdRef: { nativeEquivalent: true, weth: ADDRESS },
      },
    },
    loadPositionByVersion: async () => null,
    loadPositions: async (...args) => {
      counters.loadPositions += 1;
      calls.push(args);
      return loadPositionsImpl(...args);
    },
    entitlement: async () => {
      counters.entitlement += 1;
      return { allowed: true };
    },
    historyRelayCredentials: async () => null,
    createDexscreenerPairCache: () => ({ get: async () => null }),
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
  vm.runInContext(prelude + workerSource, context, { filename: 'sw-up33-test.js' });
  await Promise.resolve();
  await Promise.resolve();

  const dispatch = async (url = LIQUIDITY_URL) => {
    const msg = { type: 'LPLENS_UP33_LIQUIDITY' };
    const sender = { tab: { id: 17, url } };
    for (const listener of listeners) {
      const reply = deferred();
      const keepAlive = listener(msg, sender, reply.resolve);
      if (keepAlive === true) {
        return await Promise.race([
          reply.promise,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error('UP33 worker message timed out')), 2_000,
          )),
        ]);
      }
    }
    throw new Error('no worker listener accepted the UP33 message');
  };

  return {
    calls,
    counters,
    dispatch,
    setPermission: (value) => { up33Permission = value; },
  };
}

for (const deniedUrl of [
  LIQUIDITY_URL,
  'https://up33.xyz/',
  'https://up33.xyz/liquidityx',
  'https://example.com/liquidity',
]) {
  const denied = await workerHarness({
    permission: deniedUrl === LIQUIDITY_URL ? false : true,
  });
  const reply = await denied.dispatch(deniedUrl);
  assert.equal(reply.permissionRevoked, true, `${deniedUrl} must fail closed`);
  assert.equal(denied.counters.entitlement, 0,
    'denied sender must stop before entitlement');
  assert.equal(denied.counters.loadPositions, 0,
    'denied sender must stop before chain work');
}

const allowed = await workerHarness({
  loadPositionsImpl: async () => ({
    positions: [
      { protocol: 'Uniswap', privateSentinel: 'must-not-cross' },
      {
        protocol: 'UP33', tokenId: '77', privateSentinel: 'must-not-cross',
        custody: 'gauge', status: 'in-range', fee: 100,
        price: 2, priceLower: 1, priceUpper: 3,
        token0Meta: { symbol: 'UP' }, token1Meta: { symbol: 'WETH' },
        history: {
          unavailable: 'private detail',
          vsHodl: { pct: 999, apr: 999, aprDays: 1 },
        },
        usd: {
          pnl: 999, pnlPct: 999, totalNow: 999,
          value: 12.5, currentValueIncomplete: true,
        },
        rewards: [{ symbol: 'UP', amount: 4, raw: 'private raw' }],
      },
      {
        protocol: 'UP33', tokenId: '78', privateSentinel: 'must-not-cross',
        custody: 'wallet', status: 'in-range', fee: 10_000,
        price: 2, priceLower: 1, priceUpper: 3,
        token0Meta: { symbol: 'UP' }, token1Meta: { symbol: 'WETH' },
        history: {
          firstTime: 100, lastTime: 100,
          vsHodl: { pct: 4.5, apr: 8.5, aprDays: 30 },
          directCustodyProven: true,
          privateProof: 'must-not-cross',
        },
        usd: {
          pnl: 5.25, pnlPct: 3.5, totalNow: 155,
          value: 150, currentValueIncomplete: false,
        },
        rewards: [],
      },
      {
        protocol: 'UP33', tokenId: '79', privateSentinel: 'must-not-cross',
        custody: 'wallet', status: 'in-range', fee: 10_000,
        price: 2, priceLower: 1, priceUpper: 3,
        token0Meta: { symbol: 'UP' }, token1Meta: { symbol: 'WETH' },
        history: {
          firstTime: 100, lastTime: 100,
          vsHodl: { pct: 999, apr: 999, aprDays: 1 },
        },
        usd: {
          pnl: 999, pnlPct: 999, totalNow: 999,
          value: 20, currentValueIncomplete: false,
        },
        rewards: [],
      },
      {
        protocol: 'UP33', tokenId: '079', privateSentinel: 'invalid-id-must-not-cross',
        custody: 'wallet', status: 'in-range', fee: 10_000,
        token0Meta: { symbol: 'UP' }, token1Meta: { symbol: 'WETH' },
        history: { directCustodyProven: true },
        usd: { pnl: 100, pnlPct: 100, value: 100 }, rewards: [],
      },
    ],
    deploymentIssues: [],
  }),
});
const allowedReply = await allowed.dispatch('https://up33.xyz/liquidity/pools');
assert.equal(allowedReply.ok, true);
assert.deepEqual(JSON.parse(JSON.stringify(allowedReply.data.positions)), [
  {
    positionId: '77',
    protocol: 'UP33', custody: 'gauge', status: 'in-range', fee: 100,
    price: 2, priceLower: 1, priceUpper: 3,
    token0Meta: { symbol: 'UP' }, token1Meta: { symbol: 'WETH' },
    history: {
      unavailable: 'UP33 lifetime accounting unavailable',
      firstTime: null, lastTime: null, exit: null, vsHodl: null,
    },
    usd: {
      pnl: null, pnlPct: null, totalNow: null, value: 12.5,
      currentValueIncomplete: true,
    },
    rewards: [{ symbol: 'UP', amount: 4 }],
  },
  {
    positionId: '78',
    protocol: 'UP33', custody: 'wallet', status: 'in-range', fee: 10_000,
    price: 2, priceLower: 1, priceUpper: 3,
    token0Meta: { symbol: 'UP' }, token1Meta: { symbol: 'WETH' },
    history: {
      unavailable: null,
      firstTime: 100, lastTime: 100, exit: null,
      vsHodl: { pct: 4.5, apr: 8.5, aprDays: 30 },
    },
    usd: {
      pnl: 5.25, pnlPct: 3.5, totalNow: 155, value: 150,
      currentValueIncomplete: false,
    },
    rewards: [],
  },
  {
    positionId: '79',
    protocol: 'UP33', custody: 'wallet', status: 'in-range', fee: 10_000,
    price: 2, priceLower: 1, priceUpper: 3,
    token0Meta: { symbol: 'UP' }, token1Meta: { symbol: 'WETH' },
    history: {
      unavailable: 'UP33 lifetime accounting unavailable',
      firstTime: 100, lastTime: 100, exit: null, vsHodl: null,
    },
    usd: {
      pnl: null, pnlPct: null, totalNow: null, value: 20,
      currentValueIncomplete: false,
    },
    rewards: [],
  },
]);
assert.doesNotMatch(JSON.stringify(allowedReply), /must-not-cross|Uniswap|tokenId|private raw|private detail/i,
  'non-UP33 positions and private extension details must not cross into the UP33 page');
assert.doesNotMatch(JSON.stringify(allowedReply), new RegExp(ADDRESS, 'i'),
  'the full active wallet must stay in extension context');
assert.equal(allowedReply.data.walletLabel, '0x2222...2222');
assert.equal(allowed.calls[0][0], 'robinhood');
assert.equal(allowed.calls[0][1], ADDRESS);
assert.equal(allowed.calls[0][2].includeClosed, false);
assert.equal(allowed.calls[0][2].withUsd, true);
assert.deepEqual(JSON.parse(JSON.stringify(allowed.calls[0][2].v3DeploymentIds)), ['up33-cl']);
assert.equal(allowed.calls[0][2].skipV4, true);
const cachedReply = await allowed.dispatch('https://up33.xyz/liquidity/pools');
assert.equal(cachedReply.ok, true);
assert.equal(allowed.counters.loadPositions, 2,
  'completed UP33 custody proofs must be refreshed instead of served stale');

const scanGate = deferred();
const scanStarted = deferred();
const revoked = await workerHarness({
  loadPositionsImpl: async () => {
    scanStarted.resolve();
    return await scanGate.promise;
  },
});
const revokedReplyPromise = revoked.dispatch();
await scanStarted.promise;
revoked.setPermission(false);
scanGate.resolve({
  positions: [{ protocol: 'UP33', privateSentinel: 'must-not-cross' }],
  deploymentIssues: [],
});
const revokedReply = await revokedReplyPromise;
assert.equal(revokedReply.permissionRevoked, true);
assert.doesNotMatch(JSON.stringify(revokedReply), /must-not-cross|positions|address/i,
  'mid-flight revocation must not return wallet or position data');

console.log('UP33 overlay: optional route, active wallet, filtering and revocation pass');
