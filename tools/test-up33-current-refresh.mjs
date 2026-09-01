#!/usr/bin/env node
import assert from 'node:assert/strict';

import { loadKnownPositions, loadPositions } from '../extension/lib/positions.js';
import { v3Deployment } from '../extension/lib/chains.js';

const OWNER = '0x' + '11'.repeat(20);
const GAUGE = '0x' + '22'.repeat(20);
const POOL = '0x' + '33'.repeat(20);
const TOKEN0 = '0x' + '44'.repeat(20);
const TOKEN1 = '0x' + '55'.repeat(20);
const RPC = 'https://up33-current-refresh.invalid';
const DEPLOYMENT = v3Deployment('robinhood', 'up33-cl');
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const signedWord = (value) => (BigInt(value) < 0n
  ? ((1n << 256n) + BigInt(value)).toString(16)
  : BigInt(value).toString(16)).padStart(64, '0');
const addressWord = (address) => address.slice(2).padStart(64, '0');
const bytes32 = (text) => Buffer.from(text).toString('hex').padEnd(64, '0');
const array = (values) => '0x' + word(32) + word(values.length)
  + values.map((value) => word(value)).join('');
const positionHex = (liquidity) => '0x' + [
  word(0), word(0), addressWord(TOKEN0), addressWord(TOKEN1), word(200),
  signedWord(-200), signedWord(200), word(liquidity), word(0), word(0), word(0), word(0),
].join('');

let ownerReply = GAUGE;
let liquidity = 100n;
const seen = [];

function resultFor(call) {
  const request = call.params[0];
  const target = String(request.to || '').toLowerCase();
  const selector = String(request.data || '').slice(0, 10).toLowerCase();
  seen.push({ target, selector });
  if (target === DEPLOYMENT.nfpm.toLowerCase() && selector === '0x6352211e') {
    return '0x' + addressWord(ownerReply);
  }
  if (target === DEPLOYMENT.nfpm.toLowerCase() && selector === '0x70a08231') return '0x' + word(0);
  if (target === DEPLOYMENT.nfpm.toLowerCase() && selector === '0x99fbab88') {
    return positionHex(liquidity);
  }
  if (target === DEPLOYMENT.voter.toLowerCase() && selector === '0x1f7b6d32') return '0x' + word(1);
  if (target === DEPLOYMENT.voter.toLowerCase() && selector === '0xac4afa38') {
    return '0x' + addressWord(POOL);
  }
  if (target === DEPLOYMENT.voter.toLowerCase() && selector === '0xb9a09fd5') {
    return '0x' + addressWord(GAUGE);
  }
  if (target === DEPLOYMENT.factory.toLowerCase() && selector === '0x5b16ebb7') return '0x' + word(1);
  if (target === DEPLOYMENT.factory.toLowerCase() && selector === '0x28af8d0b') {
    return '0x' + addressWord(POOL);
  }
  if (target === GAUGE.toLowerCase() && selector === '0xc69deec5') return '0x' + word(1);
  if (target === GAUGE.toLowerCase() && selector === '0x4b937763') return array([7]);
  if (target === GAUGE.toLowerCase() && selector === '0x3e491d47') {
    return '0x' + word(2n * 10n ** 18n);
  }
  if (target === GAUGE.toLowerCase() && selector === '0xf301af42') {
    return '0x' + word(3n * 10n ** 18n);
  }
  if (target === POOL.toLowerCase() && selector === '0x3850c7bd') {
    return '0x' + word(1n << 96n) + word(0);
  }
  if (target === POOL.toLowerCase() && selector === '0xddca3f43') return '0x' + word(100);
  if ([TOKEN0.toLowerCase(), TOKEN1.toLowerCase()].includes(target)
      && selector === '0x95d89b41') {
    return '0x' + bytes32(target === TOKEN0.toLowerCase() ? 'AAA' : 'BBB');
  }
  if ([TOKEN0.toLowerCase(), TOKEN1.toLowerCase()].includes(target)
      && selector === '0x313ce567') return '0x' + word(18);
  if (target === DEPLOYMENT.nfpm.toLowerCase() && selector === '0xfc6f7865') {
    return '0x' + word(0) + word(0);
  }
  throw new Error(`unexpected UP33 call ${target} ${selector}`);
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, init = {}) => {
  const body = JSON.parse(init.body);
  const one = (call) => ({ jsonrpc: '2.0', id: call.id, result: resultFor(call) });
  const payload = Array.isArray(body) ? body.map(one) : one(body);
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => payload,
  };
};

const walletScope = {
  v3: {
    complete: true,
    ids: [],
    records: [{
      tokenId: '7', deploymentId: DEPLOYMENT.id,
      manager: DEPLOYMENT.nfpm.toLowerCase(), custody: 'wallet',
    }],
  },
  v4: { complete: true, ids: [] },
};

try {
  const staked = await loadKnownPositions('robinhood', OWNER, walletScope, {
    rpcOverride: RPC,
    withUsd: false,
  });
  assert.equal(staked.positions.length, 1);
  assert.equal(staked.positions[0].custody, 'gauge');
  assert.equal(staked.positions[0].custodian, GAUGE.toLowerCase());
  assert.equal(staked.positions[0].rewards[0].amount, 5,
    'stored plus newly earned UP must be displayed');
  assert.match(staked.positions[0].history.unavailable, /historical gauge emissions/);
  assert.deepEqual(staked.currentIndex.v3Records, [{
    tokenId: '7', deploymentId: DEPLOYMENT.id,
    manager: DEPLOYMENT.nfpm.toLowerCase(), custody: 'gauge',
    custodian: GAUGE.toLowerCase(),
  }]);

  const gaugeScope = {
    v3: { complete: true, ids: [], records: staked.currentIndex.v3Records },
    v4: { complete: true, ids: [] },
  };
  ownerReply = OWNER;
  const withdrawn = await loadKnownPositions('robinhood', OWNER, gaugeScope, {
    rpcOverride: RPC,
    withUsd: false,
  });
  assert.equal(withdrawn.positions.length, 1);
  assert.equal(withdrawn.positions[0].custody, 'wallet');
  assert.equal(withdrawn.positions[0].rewards.length, 0);
  assert.deepEqual(withdrawn.currentIndex.v3Records, [{
    tokenId: '7', deploymentId: DEPLOYMENT.id,
    manager: DEPLOYMENT.nfpm.toLowerCase(), custody: 'wallet',
  }]);
  assert.ok(withdrawn.positions[0].history.unavailable,
    'unstaking must not turn an incomplete or unproven lifetime into confident PnL');

  ownerReply = GAUGE;
  liquidity = 0n;
  const zeroLiquidityStake = await loadPositions('robinhood', OWNER, {
    rpcOverride: RPC,
    withUsd: false,
    v3DeploymentIds: ['up33-cl'],
    skipV4: true,
  });
  assert.equal(zeroLiquidityStake.positions.length, 1,
    'proven gauge membership with pending rewards must survive zero liquidity');
  assert.equal(zeroLiquidityStake.positions[0].rewards[0].amount, 5);
  assert.equal(zeroLiquidityStake.discovery.v3.records.length, 1);
  assert.ok(seen.some((call) => call.selector === '0xc69deec5'),
    'custody transition must be proven with stakedContains');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('UP33 current refresh: custody transitions, reward sum and zero-liquidity stakes pass');
