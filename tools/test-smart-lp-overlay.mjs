import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { smartLpDisplayPosition } from '../extension/lib/smart-lp-display.js';
import { OWNER, POSITION } from './fixtures/smart-lp-display.mjs';
const origins = ['https://stonkbrokers.io', 'https://www.stonkbrokers.io', 'https://www.stonkbrokers.cash'];
const page = origins[0] + '/locker/smart-lp';
const source = readFileSync(new URL('../extension/sw.js', import.meta.url), 'utf8').replace(/^import .*?;\r?\n/gm, '');
const content = readFileSync(new URL('../extension/smart-lp-overlay.js', import.meta.url), 'utf8');
assert.doesNotMatch(content, /storage\.onChanged/, 'raw wallet/credential storage changes must not enter this content script');
assert.match(content, /LPLENS_SMART_LP_SCOPE_CHANGED/);
const empty = { positions: [], discovery: { complete: true } };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function harness({ permission = true, allowed = true, scan = async () => empty } = {}) {
  const messages = [], storageListeners = [], removedListeners = [], registrations = new Map();
  const state = { permission, address: OWNER, url: page, scanCount: 0, entCount: 0 };
  const chrome = {
    runtime: { id: 'test', getURL: p => 'chrome-extension://test/' + p,
      onMessage: { addListener: f => messages.push(f) }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
    permissions: { contains: async ({ origins: list }) => state.permission && list.every(o => origins.includes(o.slice(0, -2))),
      onAdded: { addListener() {} }, onRemoved: { addListener: f => removedListeners.push(f) } },
    storage: { local: { get: async () => ({ address: state.address, rpcOverrides: {} }) },
      onChanged: { addListener: f => storageListeners.push(f) } },
    tabs: { get: async () => ({ url: state.url }), query: async () => [], sendMessage: async () => {} },
    scripting: {
      getRegisteredContentScripts: async ({ ids }) => ids.flatMap(id => registrations.has(id) ? [registrations.get(id)] : []),
      registerContentScripts: async defs => defs.forEach(d => registrations.set(d.id, d)),
      updateContentScripts: async defs => defs.forEach(d => registrations.set(d.id, d)),
      unregisterContentScripts: async ({ ids }) => ids.forEach(id => registrations.delete(id)),
    },
  };
  const context = vm.createContext({ chrome, URL, console, setTimeout, clearTimeout,
    CHAINS: {}, createDexscreenerPairCache: () => ({ clear() {} }),
    entitlement: async () => { state.entCount++; return { allowed }; },
    historyRelayCredentials: async () => null,
    loadPositions: () => { throw new Error('must not scan standard LPs'); },
    scanSmartLp: async address => { state.scanCount++; assert.equal(address, state.address); return scan(); },
    attachUsd: async (_chain, p) => p, smartLpDisplayPosition,
  });
  vm.runInContext(source, context);
  await context.syncOverlayRegistration();
  const dispatch = (url = page, overrides = {}) => new Promise((resolve, reject) => {
    let handled = false;
    for (const f of messages) {
      if (f({ type: 'LPLENS_SMART_LP_PORTFOLIO', address: 'ignored-page-wallet' },
        { frameId: 0, url, tab: { id: 7, url }, ...overrides }, resolve)) { handled = true; break; }
    }
    if (!handled) reject(new Error('No Smart LP handler'));
  });
  return { state, dispatch, registrations, context,
    change: (key, value) => { state[key] = value; for (const f of storageListeners) f({ [key]: { newValue: value } }, 'local'); } };
}
const display = smartLpDisplayPosition(POSITION);
assert.equal(display.status, 'below', 'out of range is not closed');
assert.equal(display.usd.totalNow, 82);
assert.equal(display.usd.pnl, -18);
assert.ok(!JSON.stringify(display).includes(OWNER));
assert.ok(!JSON.stringify(display).includes('do-not-forward'));
assert.equal(display.history.vsHodl.feesPct, undefined, 'no fictitious vault fee/IL split');
const unsupported = smartLpDisplayPosition({ ...POSITION,
  history: { ...POSITION.history, unavailable: 'https://secret.invalid/credential' } });
assert.equal(unsupported.usd.totalNow, 82);
assert.equal(unsupported.usd.pnl, null); assert.equal(unsupported.usd.vsHodl, null);
assert.ok(!JSON.stringify(unsupported).includes('secret.invalid'));
const partial = smartLpDisplayPosition({ ...POSITION, collectable0: null });
assert.equal(partial.usd.totalNow, null); assert.equal(partial.usd.pnl, null);
assert.equal(smartLpDisplayPosition({ ...POSITION, status: 'idle' }).status, 'idle');
assert.equal(smartLpDisplayPosition({ ...POSITION, vault: { address: 'invalid' } }), null);
const h = await harness({ scan: async () => ({ ...empty, positions: [POSITION] }) });
assert.equal(h.registrations.size, 3);
for (const [index, origin] of origins.entries()) {
  const def = h.registrations.get(`lplens-smart-lp-overlay-${index}`);
  assert.deepEqual(Array.from(def.matches), [origin + '/locker/smart-lp', origin + '/locker/smart-lp/*']);
  assert.deepEqual(Array.from(def.js), ['render.js', 'smart-lp-overlay.js']);
  h.state.url = origin + '/locker/smart-lp';
  assert.equal((await h.dispatch(h.state.url)).data.positions.length, 1);
}
for (const url of [origins[0] + '/', origins[0] + '/locker/smart-lpx', 'https://evil.invalid/locker/smart-lp',
  'https://www.stonkbrokers.cash.evil.invalid/locker/smart-lp']) {
  const d = await harness();
  assert.equal((await d.dispatch(url)).permissionRevoked, true);
  assert.equal(d.state.entCount, 0); assert.equal(d.state.scanCount, 0);
}
for (const overrides of [{ frameId: 1 }, { url: 'https://evil.invalid' }, { tab: {} }]) {
  const d = await harness(); assert.equal((await d.dispatch(page, overrides)).permissionRevoked, true);
  assert.equal(d.state.scanCount, 0);
}
const denied = await harness({ permission: false });
assert.equal((await denied.dispatch()).permissionRevoked, true);
assert.equal(denied.state.entCount, 0);
const gated = await harness({ allowed: false });
assert.equal((await gated.dispatch()).gated, true); assert.equal(gated.state.scanCount, 0);
for (const mutation of ['wallet', 'permission', 'route', 'settings']) {
  const hold = deferred(), started = deferred();
  const r = await harness({ scan: async () => { started.resolve(); return hold.promise; } });
  const reply = r.dispatch(); await started.promise;
  if (mutation === 'wallet') r.change('address', '0x' + '33'.repeat(20));
  if (mutation === 'settings') r.change('rpcOverrides', {});
  if (mutation === 'permission') r.state.permission = false;
  if (mutation === 'route') r.state.url = origins[0] + '/trade';
  hold.resolve({ ...empty, positions: [POSITION] });
  const result = await reply;
  assert.equal(result.ok, false, `${mutation} drops late data`); assert.equal(result.data, undefined);
}
const hold = deferred(), started = deferred();
const coalesce = await harness({ scan: async () => { started.resolve(); return hold.promise; } });
const a = coalesce.dispatch(); await started.promise; const b = coalesce.dispatch();
await new Promise(r => setImmediate(r)); assert.equal(coalesce.state.scanCount, 1);
hold.resolve(empty); await Promise.all([a, b]); await coalesce.dispatch();
assert.equal(coalesce.state.scanCount, 2, 'completed custody proof not cached');
const fail = await harness({ scan: async () => ({ ...empty, unavailable: 'private-provider-url', unreadable: 1 }) });
assert.match((await fail.dispatch()).data.unavailable, /Some vaults/);
const throwing = await harness({ scan: async () => { throw new Error('private-provider-url'); } });
assert.ok(!JSON.stringify(await throwing.dispatch()).includes('private-provider-url'));
console.log('Smart LP overlay: serialization, strict hosts/routes/frames, auth, late wallet/settings/revocation, partial results and fresh proofs passed');
