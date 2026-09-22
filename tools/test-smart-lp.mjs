#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { SMART_LP, SMART_LP_TOPIC, scanSmartLp, reconcileSmartLpShares, smartLpExternalFlow, normalizeSmartLpScope, smartLpSelector } from '../extension/lib/smart-lp.js';
import { loadPositions, loadKnownPositions } from '../extension/lib/positions.js';
import { positionHideKey } from '../extension/lib/hidden-positions.js';
import { classifyPosition } from '../extension/lib/aggregate.js';
import { writeFullDiscoveryScope, readCurrentPositionScope, writeCurrentRefreshScope, readCurrentPositionJobs } from '../extension/lib/current-position-index.js';
import { fixture, OWNER, VAULT, ZERO, TOKEN0, TOKEN1, UNIT, TX, transfer, blob, log, addrTopic } from './fixtures/smart-lp.mjs';
const RPC = 'https://smart-lp.invalid';
const opts = { rpcOverride: RPC, skipV4: true };
const original = globalThis.fetch;
let count = 0;
async function test(name, fn) { await fn(); console.log('PASS', name); count++; }
let successful;
try {
  await test('registry discovery, share allocation, pending fees and actual zap input', async () => {
    const f = fixture(); globalThis.fetch = f.fetch;
    const r = await scanSmartLp(OWNER, opts);
    assert.equal(r.unavailable, null);
    assert.deepEqual(r.discovery.addresses, [VAULT]);
    const p = r.positions[0]; successful = p;
    assert.equal(p.vault.sharePercent, 10);
    assert.equal(p.collectable0, 0.08991, 'performance and exit fees applied exactly once');
    assert.equal(p.history.deposited0, 0);
    assert.equal(p.history.deposited1, 10, 'external 10 tokens, not post-zap 2 + 3 basket');
    assert.equal(p.history.fees0, null);
    assert.equal(p.vault.positionId, '7');
    assert.equal(p.status, 'in-range');
    assert.ok(f.calls.every((c) => ['eth_call','eth_getLogs','eth_getBlockByNumber','eth_getTransactionReceipt'].includes(c.method)));
    assert.ok(f.calls.filter((c) => c.method === 'eth_call').every((c) => c.params[1] === '0xc8'), 'one pinned snapshot');
  });
  await test('rebalance replaces NFT without replacing identity or cash-flow basis', async () => {
    const f = fixture({ id: 8n }); globalThis.fetch = f.fetch;
    const r = await scanSmartLp(OWNER, opts, [VAULT]);
    assert.equal(r.positions[0].vault.positionId, '8');
    assert.equal(positionHideKey(r.positions[0]), positionHideKey(successful));
    assert.deepEqual(r.positions[0].history.deposits, successful.history.deposits);
    assert.ok(!f.calls.some((c) => c.method === 'eth_call' && c.params[0].to === SMART_LP.registry && c.params[0].data.length === 10), 'current refresh does not enumerate registry');
  });
  await test('partial exit uses net external proceeds and reconciles burned shares', async () => {
    const f = fixture();
    const out = log(VAULT, [SMART_LP_TOPIC.withdraw, addrTopic(OWNER), addrTopic(OWNER)], blob(UNIT, 2n * UNIT, 50), 8);
    const burn = transfer(VAULT, OWNER, ZERO, 50, 7);
    const flows = reconcileSmartLpShares([...f.history, burn, out], OWNER, 50, 950);
    assert.equal(flows.length, 2);
    const exit = { ...f.receipt, logs: [out, burn,
      transfer(TOKEN0, VAULT, OWNER, UNIT, 5), transfer(TOKEN1, VAULT, OWNER, 2n * UNIT, 6)] };
    const tx = { ...f.transaction, input: smartLpSelector('withdraw(uint256,uint256,uint256,bool,address)') };
    assert.deepEqual(smartLpExternalFlow(flows[1], exit, tx, OWNER, VAULT, [TOKEN0, TOKEN1]), [UNIT, 2n * UNIT]);
    assert.throws(() => smartLpExternalFlow(flows[1], { ...exit, logs: [out, burn] }, tx, OWNER, VAULT, [TOKEN0, TOKEN1]), /withdrawal assets unverified/);
  });
  await test('share transfers, missing mint and missing receipt events fail closed', async () => {
    const f = fixture();
    assert.throws(() => reconcileSmartLpShares(f.history.slice(1), OWNER, 100, 1000), /reconcile/);
    assert.throws(() => reconcileSmartLpShares([...f.history,
      transfer(VAULT, OWNER, '0x' + '88'.repeat(20), 1, 5)], OWNER, 99, 1000), /transferred shares/);
    const flow = reconcileSmartLpShares(f.history, OWNER, 100, 1000)[0];
    assert.throws(() => smartLpExternalFlow(flow, { ...f.receipt, logs: [] }, f.transaction, OWNER, VAULT, [TOKEN0, TOKEN1]), /absent/);
  });
  for (const [state, reason] of [
    [{ truncatedHistory: true }, /reconcile/],
    [{ nativeValue: UNIT }, /native/],
    [{ feeFailure: true }, /pending vault fees/],
    [{ manager: '0x' + 'aa'.repeat(20) }, /harvest-mode/],
  ]) await test(`unavailable lifetime is explicit: ${Object.keys(state)[0]}`, async () => {
    const f = fixture(state); globalThis.fetch = f.fetch;
    const r = await scanSmartLp(OWNER, opts);
    assert.equal(r.positions.length, 1, 'range/holding survives incomplete accounting');
    assert.match(r.positions[0].history.unavailable, reason);
    assert.equal(r.positions[0].history.vsHodl, undefined);
    if (state.feeFailure || state.manager) assert.equal(r.positions[0].collectable0, null);
  });
  for (const state of [{ wrongOwner: true }, { wrongPool: true }, { decimals0: 255 }, { reorg: true }, { balanceFailure: true }, { blockFailure: true }, { registryFailure: true }]) {
    await test(`unverified holding is not shown: ${Object.keys(state)[0]}`, async () => {
      const f = fixture(state); globalThis.fetch = f.fetch;
      const r = await scanSmartLp(OWNER, opts, [VAULT]);
      assert.equal(r.positions.length, 0);
      assert.equal(r.discovery.complete, false);
      assert.deepEqual(r.discovery.addresses, [VAULT], 'preserve unreadable current identity');
      assert.ok(r.unavailable);
    });
  }
  await test('bounded log splitting retains complete history', async () => {
    const f = fixture({ logLimitOnce: true }); globalThis.fetch = f.fetch;
    const r = await scanSmartLp(OWNER, opts);
    assert.equal(r.positions[0].history.deposited1, 10);
    assert.equal(f.calls.filter((c) => c.method === 'eth_getLogs').length, 3);
  });
  await test('idle assets remain visible; redeemed shares are removed', async () => {
    const f = fixture({ id: 0n, liquidity: 0n }); globalThis.fetch = f.fetch;
    let r = await scanSmartLp(OWNER, opts);
    assert.equal(r.positions[0].status, 'idle');
    assert.equal(r.positions[0].collectable0, 0);
    assert.equal(r.positions[0].amount0, 0.0999);
    f.state.shares = 0n;
    r = await scanSmartLp(OWNER, opts, [VAULT]);
    assert.equal(r.positions.length, 0); assert.equal(r.discovery.complete, true);
    assert.deepEqual(r.discovery.addresses, []);
  });
  await test('portfolio discovery/current index migrate without losing ordinary NFTs', async () => {
    const f = fixture(); globalThis.fetch = f.fetch;
    const r = await loadPositions('robinhood', OWNER, opts);
    assert.equal(r.positions.length, 1); assert.equal(r.positions[0].version, 'vault');
    assert.deepEqual(r.deploymentIssues, []);
    await writeFullDiscoveryScope({ owner: OWNER, chainKey: 'robinhood', discovery: { ...r.discovery, smartLp: undefined } });
    assert.equal((await readCurrentPositionJobs([OWNER], ['robinhood']))[0].ready, false, 'pre-vault index requires Full rescan');
    await writeFullDiscoveryScope({ owner: OWNER, chainKey: 'robinhood', discovery: r.discovery });
    let scope = await readCurrentPositionScope(OWNER, 'robinhood');
    assert.equal((await readCurrentPositionJobs([OWNER], ['robinhood']))[0].ready, true);
    const current = await loadKnownPositions('robinhood', OWNER, scope, opts);
    assert.equal(current.positions.length, 1);
    f.state.blockFailure = true;
    const failed = await loadKnownPositions('robinhood', OWNER, scope, opts);
    assert.ok(failed.deploymentIssues.length);
    await writeCurrentRefreshScope({ owner: OWNER, chainKey: 'robinhood', ids: failed.currentIndex });
    scope = await readCurrentPositionScope(OWNER, 'robinhood');
    assert.deepEqual(scope.smartLp.addresses, [VAULT]);
    await writeFullDiscoveryScope({ owner: OWNER, chainKey: 'robinhood', discovery: { ...r.discovery, smartLp: { complete: false, addresses: [] } } });
    scope = await readCurrentPositionScope(OWNER, 'robinhood');
    assert.equal(scope.smartLp.complete, false); assert.deepEqual(scope.smartLp.addresses, [VAULT]);
  });
  await test('invalid or wrong-registry saved proof cannot enable current refresh', async () => {
    assert.equal(normalizeSmartLpScope({ complete: true, addresses: [VAULT], registry: ZERO }, 'robinhood').complete, false);
    assert.equal(normalizeSmartLpScope({ complete: true, addresses: ['bad'], registry: SMART_LP.registry }, 'robinhood').complete, false);
    assert.equal(normalizeSmartLpScope(undefined, 'base').complete, true);
  });
  await test('vault renderer excludes fictitious IL, mint entry, and range-trading story', async () => {
    const context = vm.createContext({ console });
    vm.runInContext(await readFile(new URL('../extension/render.js', import.meta.url), 'utf8'), context);
    const R = context.LPLens;
    const h = successful.history;
    const html = R.hero(successful, h, 'EXAMPLE') + R.details(successful, h, 'WETH', 'EXAMPLE', true);
    assert.match(html, /after vault fees/); assert.match(html, /Balanced band/);
    assert.match(html, /underlying NFT/); assert.match(html, /#7/);
    assert.doesNotMatch(html, /fees minus IL|what your range traded|solved from mint|NaN|undefined/);
    assert.equal(R.rebalanceLine(successful, h, 'WETH', 'EXAMPLE'), '');
    const orientation = R.dexscreenerOrientation(successful, {
      baseToken: { address: TOKEN1, symbol: 'EXAMPLE' }, quoteToken: { address: TOKEN0, symbol: 'WETH' },
    });
    assert.equal(orientation.valid, true, 'vault range uses ordinary pool orientation');
    assert.match(R.rangeBar({ ...successful, status: 'idle' }, h, true), /No active LP range/);
    assert.equal(classifyPosition({ ...successful, usd: { currentValue: null, value: 99, currentValueIncomplete: true } }).hasValue, false);
  });
} finally { globalThis.fetch = original; }
console.log(`Smart LP: ${count} checks passed`);
