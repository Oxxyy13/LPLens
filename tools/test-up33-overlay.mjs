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

assert.equal(manifest.version, '0.34.0');
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
assert.match(overlay, /reads only validated public position NFT IDs and row geometry/);
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
        token0Meta: {
          symbol: '<UP&"012345678901234567890123456789',
          privateSymbolTail: 'must-not-cross',
        },
        token1Meta: { symbol: 'WETH' },
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
        amount0: 7, amount1: 11, collectable0: 0.5, collectable1: 1.5,
        token0Meta: { symbol: 'UP' }, token1Meta: { symbol: 'WETH' },
        history: {
          firstTime: 100, lastTime: 100,
          entry: { price: 1.5, exact: true, bound: null, spread: 0.0001 },
          exit: null, adds: 2,
          deposited0: 10, deposited1: 8, received0: 2, received1: 3,
          fees0: 0.75, fees1: 1.25, feeCreditsOnAdd: false,
          vsHodl: {
            delta: 2.25, pct: 4.5, fees: 1.75, feesPct: 3.25,
            il: 0.5, ilPct: 0.75, apr: 8.5, aprDays: 30,
          },
          directCustodyProven: true,
          privateProof: 'must-not-cross',
        },
        usd: {
          pnl: 5.25, pnlPct: 3.5, vsHodl: 2.25,
          grossAdded: 160, grossAddedExact: true,
          collectedProceeds: 10, collectedProceedsExact: true, netCashIn: 150,
          returnUnavailable: null, totalNow: 155, value: 150, collectable: 5,
          currentValueIncomplete: false,
          tokenPriceChange: {
            label: 'first add', token0: { from: 1, to: 1.5, pct: 50 },
            token1: { from: 2, to: 1.5, pct: -25 }, private: 'must-not-cross',
          },
          latestAddPriceChange: {
            label: 'latest add', token0: { from: 1.25, to: 1.5, pct: 20 },
            token1: null,
          },
          capitalEvents: [{
            kind: 'forged-kind', block: 50, time: 75,
            amount0: 4, amount1: 6, value: 80, exact: true,
            transactionHash: 'must-not-cross',
          }, {
            kind: 'forged-kind', block: 70, time: Number.MAX_SAFE_INTEGER,
            amount0: 6, amount1: 2, value: 80, exact: true,
          }],
        },
        rewards: [{ symbol: 'UP', amount: 1.25, raw: 'must-not-cross' }],
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
    deploymentIssues: [{
      protocol: 'UP33',
      error: 'HTTP 429 from https://provider.invalid/?key=must-not-cross',
    }],
  }),
});
const allowedReply = await allowed.dispatch('https://up33.xyz/liquidity/pools');
assert.equal(allowedReply.ok, true);
assert.deepEqual(JSON.parse(JSON.stringify(allowedReply.data.positions)), [
  {
    positionId: '77',
    protocol: 'UP33', custody: 'gauge', status: 'in-range', fee: 100,
    price: 2, priceLower: 1, priceUpper: 3,
    amount0: null, amount1: null, collectable0: null, collectable1: null,
    token0Meta: { symbol: '<UP&"0123456789012345678' },
    token1Meta: { symbol: 'WETH' },
    history: {
      unavailable: 'Staked position lifetime return is unavailable until historical gauge emissions and trading fees can be included.',
      currentUnavailable: true, firstTime: null, lastTime: null,
      entry: null, exit: null,
      deposited0: null, deposited1: null, received0: null, received1: null,
      feeCreditsOnAdd: false, vsHodl: null,
    },
    usd: {
      pnl: null, pnlPct: null, vsHodl: null,
      grossAdded: null, grossAddedExact: null,
      collectedProceeds: null, collectedProceedsExact: null,
      netCashIn: null, returnUnavailable: null,
      tokenPriceChange: null, latestAddPriceChange: null,
      capitalEvents: [], capitalEventsTruncated: false,
      totalNow: null, value: 12.5, collectable: null,
      currentValueIncomplete: true,
    },
    rewards: [{ symbol: 'UP', amount: 4 }],
    rewardsUnavailable: null,
  },
  {
    positionId: '78',
    protocol: 'UP33', custody: 'wallet', status: 'in-range', fee: 10_000,
    price: 2, priceLower: 1, priceUpper: 3,
    amount0: 7, amount1: 11, collectable0: 0.5, collectable1: 1.5,
    token0Meta: { symbol: 'UP' }, token1Meta: { symbol: 'WETH' },
    history: {
      unavailable: null, currentUnavailable: false,
      firstTime: 100, lastTime: 100,
      entry: { price: 1.5, exact: true, bound: null, spread: 0.0001 },
      exit: null,
      deposited0: 10, deposited1: 8, received0: 2, received1: 3,
      feeCreditsOnAdd: false,
      vsHodl: {
        pct: 4.5, feesPct: 3.25, ilPct: 0.75, apr: 8.5, aprDays: 30,
      },
    },
    usd: {
      pnl: 5.25, pnlPct: 3.5, vsHodl: 2.25,
      grossAdded: 160, grossAddedExact: true,
      collectedProceeds: 10, collectedProceedsExact: true, netCashIn: 150,
      returnUnavailable: null,
      tokenPriceChange: {
        label: 'first add', token0: { from: 1, to: 1.5, pct: 50 },
        token1: { from: 2, to: 1.5, pct: -25 },
      },
      latestAddPriceChange: {
        label: 'latest add', token0: { from: 1.25, to: 1.5, pct: 20 },
        token1: null,
      },
      capitalEvents: [{
        kind: 'opened', block: 50, time: 75,
        amount0: 4, amount1: 6, value: 80, exact: true,
      }, {
        kind: 'added', block: 70, time: null,
        amount0: 6, amount1: 2, value: 80, exact: true,
      }],
      capitalEventsTruncated: false,
      totalNow: 155, value: 150, collectable: 5,
      currentValueIncomplete: false,
    },
    rewards: [{ symbol: 'UP', amount: 1.25 }], rewardsUnavailable: null,
  },
  {
    positionId: '79',
    protocol: 'UP33', custody: 'wallet', status: 'in-range', fee: 10_000,
    price: 2, priceLower: 1, priceUpper: 3,
    amount0: null, amount1: null, collectable0: null, collectable1: null,
    token0Meta: { symbol: 'UP' }, token1Meta: { symbol: 'WETH' },
    history: {
      unavailable: 'Complete direct-custody history could not be proven.',
      currentUnavailable: true, firstTime: 100, lastTime: 100,
      entry: null, exit: null,
      deposited0: null, deposited1: null, received0: null, received1: null,
      feeCreditsOnAdd: false, vsHodl: null,
    },
    usd: {
      pnl: null, pnlPct: null, vsHodl: null,
      grossAdded: null, grossAddedExact: null,
      collectedProceeds: null, collectedProceedsExact: null,
      netCashIn: null, returnUnavailable: null,
      tokenPriceChange: null, latestAddPriceChange: null,
      capitalEvents: [], capitalEventsTruncated: false,
      totalNow: null, value: 20, collectable: null,
      currentValueIncomplete: false,
    },
    rewards: [], rewardsUnavailable: null,
  },
]);
assert.equal(
  allowedReply.data.unavailable,
  'UP33 positions could not be read from Robinhood Chain. Refresh and try again.',
  'raw deployment errors must become one allowlisted page-facing reason',
);
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

const thrown = await workerHarness({
  loadPositionsImpl: async () => {
    throw new Error('https://provider.invalid/?key=must-not-cross');
  },
});
const thrownReply = await thrown.dispatch();
assert.deepEqual(JSON.parse(JSON.stringify(thrownReply)), {
  ok: false,
  error: 'UP33 positions could not be read from Robinhood Chain. Refresh and try again.',
});

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
