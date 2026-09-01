#!/usr/bin/env node
import assert from 'node:assert/strict';

import { TRANSFER_TOPIC, fetchTokenTransfersRpc } from '../extension/lib/logs.js';
import {
  loadV3Position, uninterruptedDirectCustody,
} from '../extension/lib/positions.js';
import { v3Deployment } from '../extension/lib/chains.js';

const OWNER = '0x' + '11'.repeat(20);
const GAUGE = '0x' + '22'.repeat(20);
const POOL = '0x' + '33'.repeat(20);
const TOKEN0 = '0x' + '44'.repeat(20);
const TOKEN1 = '0x' + '55'.repeat(20);
const ZERO = '0x' + '00'.repeat(20);
const RPC = 'https://up33-direct-pnl.invalid';
const DEPLOYMENT = v3Deployment('robinhood', 'up33-cl');
const HEAD = 1_000;
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const signedWord = (value) => (BigInt(value) < 0n
  ? ((1n << 256n) + BigInt(value)).toString(16)
  : BigInt(value).toString(16)).padStart(64, '0');
const addressWord = (address) => address.slice(2).toLowerCase().padStart(64, '0');
const bytes32 = (text) => Buffer.from(text).toString('hex').padEnd(64, '0');
const topicAddress = (address) => `0x${addressWord(address)}`;
const topicId = (tokenId) => `0x${word(tokenId)}`;
const txHash = (tokenId, suffix = 0) => `0x${(
  BigInt(tokenId) * 10n + BigInt(suffix) + 1n
).toString(16).padStart(64, '0')}`;
const blockHash = (block) => `0x${BigInt(block).toString(16).padStart(64, '0')}`;

const positionHex = (liquidity = 100n) => '0x' + [
  word(0), word(0), addressWord(TOKEN0), addressWord(TOKEN1), word(200),
  signedWord(-200), signedWord(200), word(liquidity), word(0), word(0), word(0), word(0),
].join('');

const transfer = (tokenId, from, to, block, index, suffix = 0) => ({
  address: DEPLOYMENT.nfpm,
  blockNumber: `0x${BigInt(block).toString(16)}`,
  logIndex: `0x${BigInt(index).toString(16)}`,
  transactionHash: txHash(tokenId, suffix),
  topics: [TRANSFER_TOPIC, topicAddress(from), topicAddress(to), topicId(tokenId)],
  data: '0x',
});

const increase = (tokenId) => ({
  address: DEPLOYMENT.nfpm,
  blockNumber: '0xa',
  logIndex: '0x2',
  transactionHash: txHash(tokenId),
  topics: [
    '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f',
    topicId(tokenId),
  ],
  data: `0x${word(100)}${word(1_000)}${word(1_000)}`,
});

const pristine = [transfer(7, ZERO, OWNER, 10, 1)];
assert.deepEqual(uninterruptedDirectCustody(pristine.map((row) => ({
  block: Number(BigInt(row.blockNumber)),
  index: Number(BigInt(row.logIndex)),
  transactionHash: row.transactionHash,
  tokenId: 7n,
  from: ZERO,
  to: OWNER,
})), OWNER, 7), { ok: true });
assert.equal(uninterruptedDirectCustody([], OWNER, 7).ok, false);
assert.equal(uninterruptedDirectCustody([{
  block: 10, index: 1, tokenId: 7n, from: ZERO, to: GAUGE,
}], OWNER, 7).ok, false, 'minting to another custodian must fail closed');
assert.equal(uninterruptedDirectCustody([
  { block: 10, index: 1, tokenId: 7n, from: ZERO, to: OWNER },
  { block: 11, index: 1, tokenId: 7n, from: OWNER, to: OWNER },
], OWNER, 7).ok, false, 'even an extra self-transfer is outside the strict proof');
assert.equal(uninterruptedDirectCustody([
  { block: 10, index: 1, tokenId: 7n, from: ZERO, to: OWNER },
  { block: 11, index: 1, tokenId: 7n, from: OWNER, to: GAUGE },
  { block: 12, index: 1, tokenId: 7n, from: GAUGE, to: OWNER },
], OWNER, 7).ok, false, 'stake then unstake must never unlock direct-only PnL');

const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, init = {}) => {
  const payload = JSON.parse(init.body);
  const answer = (request) => {
    if (request.method === 'eth_getBlockByNumber') {
      const requested = request.params[0] === 'latest'
        ? HEAD : Number(BigInt(request.params[0]));
      return {
        number: `0x${BigInt(requested).toString(16)}`,
        hash: blockHash(requested),
      };
    }
    if (request.method === 'eth_getLogs') {
      const topics = request.params[0]?.topics || [];
      const tokenId = BigInt(topics[3] || topics[1]);
      if (topics[0] === TRANSFER_TOPIC) {
        const all = tokenId === 7n ? [transfer(tokenId, ZERO, OWNER, 10, 1)]
          : tokenId === 8n ? [
          transfer(tokenId, ZERO, OWNER, 10, 1),
          transfer(tokenId, OWNER, GAUGE, 11, 1, 1),
          transfer(tokenId, GAUGE, OWNER, 12, 1, 2),
          ] : [];
        const from = Number(BigInt(request.params[0].fromBlock));
        const to = Number(BigInt(request.params[0].toBlock));
        return all.filter((row) => {
          const block = Number(BigInt(row.blockNumber));
          return block >= from && block <= to;
        });
      }
      return [increase(tokenId)];
    }
    if (request.method !== 'eth_call') throw new Error(`unexpected method ${request.method}`);
    const tx = request.params[0];
    const target = String(tx.to || '').toLowerCase();
    const selector = String(tx.data || '').slice(0, 10).toLowerCase();
    if (target === DEPLOYMENT.nfpm.toLowerCase() && selector === '0x99fbab88') {
      return positionHex();
    }
    if (target === DEPLOYMENT.nfpm.toLowerCase() && selector === '0x6352211e') {
      return `0x${addressWord(OWNER)}`;
    }
    if (target === DEPLOYMENT.nfpm.toLowerCase() && selector === '0xfc6f7865') {
      return `0x${word(0)}${word(0)}`;
    }
    if (target === DEPLOYMENT.factory.toLowerCase() && selector === '0x28af8d0b') {
      return `0x${addressWord(POOL)}`;
    }
    if (target === POOL.toLowerCase() && selector === '0x3850c7bd') {
      return `0x${word(1n << 96n)}${word(0)}`;
    }
    if (target === POOL.toLowerCase() && selector === '0xddca3f43') {
      return `0x${word(10_000)}`;
    }
    if ([TOKEN0.toLowerCase(), TOKEN1.toLowerCase()].includes(target)
        && selector === '0x95d89b41') {
      return `0x${bytes32(target === TOKEN0.toLowerCase() ? 'AAA' : 'BBB')}`;
    }
    if ([TOKEN0.toLowerCase(), TOKEN1.toLowerCase()].includes(target)
        && selector === '0x313ce567') return `0x${word(18)}`;
    throw new Error(`unexpected call ${target} ${selector}`);
  };
  const one = (request) => ({ jsonrpc: '2.0', id: request.id, result: answer(request) });
  const body = Array.isArray(payload) ? payload.map(one) : one(payload);
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  };
};

try {
  const direct = await loadV3Position('robinhood', 'up33-cl', 7, {
    rpcOverride: RPC,
    ownerOverride: OWNER,
    withUsd: false,
  });
  assert.equal(direct.history.unavailable, undefined);
  assert.equal(direct.history.directCustodyProven, true);
  assert.equal(direct.history.custodyCheckedThrough, HEAD);
  assert.equal(direct.history.adds, 1);
  assert.equal(direct.history.deposits[0].transactionHash, txHash(7));

  const returnedFromGauge = await loadV3Position('robinhood', 'up33-cl', 8, {
    rpcOverride: RPC,
    ownerOverride: OWNER,
    withUsd: false,
  });
  assert.match(returnedFromGauge.history.unavailable, /staking|custody transfer/);
  assert.equal(returnedFromGauge.history.directCustodyProven, undefined);

  const exact = await fetchTokenTransfersRpc({
    contract: DEPLOYMENT.nfpm,
    tokenId: 7,
    rpc: RPC,
    toBlock: HEAD,
  });
  assert.equal(exact.unavailable, undefined);
  assert.equal(exact.events.length, 1);
  assert.equal(exact.events[0].from, ZERO);
  assert.equal(exact.events[0].to, OWNER);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('UP33 direct PnL: pristine mint proof passes; transfers, staking and incomplete provenance fail closed');
