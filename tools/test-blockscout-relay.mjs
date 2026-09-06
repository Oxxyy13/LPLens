#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import worker, {
  KEYS, decide, receiptQuery, relayQuery, sha256Hex,
} from './licence-worker/worker.js';
import { CHAINS } from '../extension/lib/chains.js';
import { VALIDATE_URL } from '../extension/lib/license.js';
import { fetchPositionLogs } from '../extension/lib/logs.js';
import { fetchV4Receipt } from '../extension/lib/v4.js';

class FakeD1 {
  constructor() {
    this.installations = new Map();
    this.usage = new Map();
    this.boundValues = [];
  }

  prepare(sql) {
    return {
      bind: (...args) => {
        this.boundValues.push(args);
        return {
          run: async () => {
            if (sql.includes('INSERT INTO installations')) {
              const [licenceHash, label, installationHash, at] = args;
              const key = `${licenceHash}:${installationHash}`;
              const old = this.installations.get(key);
              this.installations.set(key, {
                licenceHash, label, installationHash,
                firstSeen: old ? old.firstSeen : at,
                lastSeen: at,
              });
            }
            return { success: true };
          },
          first: async () => {
            if (sql.includes('SELECT COUNT(*) AS count FROM installations')) {
              const [licenceHash] = args;
              return {
                count: [...this.installations.values()]
                  .filter((row) => row.licenceHash === licenceHash).length,
              };
            }
            if (sql.includes('INSERT INTO relay_usage_daily')) {
              const [licenceHash, label, day, at] = args;
              const key = `${licenceHash}:${day}`;
              const old = this.usage.get(key);
              const requests = (old ? old.requests : 0) + 1;
              this.usage.set(key, { licenceHash, label, day, at, requests });
              return { requests };
            }
            throw new Error(`unhandled FakeD1 query: ${sql}`);
          },
        };
      },
    };
  }
}

const LIVE = process.argv.includes('--live');
const TEST_KEY = 'test-access-key-with-enough-entropy';
const TEST_INSTALL = '0123456789abcdef0123456789abcdef';
const envFile = LIVE ? Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1).replace(/^['"]|['"]$/g, '')];
    }),
) : {};
const TEST_BLOCKSCOUT_SECRET = LIVE
  ? envFile.BLOCKSCOUT_PRO_API_KEY : 'test-blockscout-secret';
const TEST_ETHERSCAN_SECRET = LIVE
  ? envFile.ETHERSCAN_KEY : 'test-etherscan-secret';
if (!TEST_BLOCKSCOUT_SECRET) {
  throw new Error('BLOCKSCOUT_PRO_API_KEY missing for --live test');
}
if (!TEST_ETHERSCAN_SECRET) throw new Error('ETHERSCAN_KEY missing for --live test');
const keyHash = await sha256Hex(TEST_KEY);
KEYS[keyHash] = { label: 'test-fixture', expires: '2099-12-31' };

const db = new FakeD1();
const env = {
  DB: db,
  BLOCKSCOUT_PRO_API_KEY: TEST_BLOCKSCOUT_SECRET,
  ETHERSCAN_API_KEY: TEST_ETHERSCAN_SECRET,
};
const originalFetch = globalThis.fetch;
let blockscoutCalls = 0;
let etherscanCalls = 0;
let receiptCalls = 0;
let blockscoutSawSecret = false;
let etherscanSawSecret = false;
let receiptSawBearer = false;
let receiptMode = 'pool-manager';
let receiptLastRequest = null;
let receiptLastUrl = '';
let rpc429Calls = 0;
const receiptRelayBodies = [];
let pagedMode = false;
const upstreamCallCount = () => blockscoutCalls + etherscanCalls;
const MODIFY_LIQUIDITY_TOPIC =
  '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec';

const LOG = {
  address: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  blockNumber: '0x10',
  data: '0x' + '0'.repeat(192),
  logIndex: '0x1',
  timeStamp: '0x65',
  topics: [
    '0x' + '1'.repeat(64),
    '0x' + (961877n).toString(16).padStart(64, '0'),
  ],
  transactionHash: '0x' + '2'.repeat(64),
};

const PROJECTX_LOG = {
  ...LOG,
  address: CHAINS.hyperevm.nfpm,
  blockNumber: '43779436',
  logIndex: '1',
  timeStamp: '1787317843',
  topics: [
    LOG.topics[0],
    '0x' + (533076n).toString(16).padStart(64, '0'),
  ],
  transactionHash: '0x' + '3'.repeat(64),
};

const RECEIPT_TX = '0x' + 'a'.repeat(64);
const RECEIPT_TX_2 = '0x' + 'b'.repeat(64);

globalThis.fetch = async (input, init = {}) => {
  const url = input instanceof URL
    ? input
    : new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === 'lplens-beta.licence-worker.workers.dev') {
    if (url.pathname === '/receipt' && init.body) {
      receiptRelayBodies.push(JSON.parse(String(init.body)));
    }
    return worker.fetch(new Request(url, init), env);
  }
  if (url.hostname === 'rpc.receipt-test.invalid') {
    rpc429Calls++;
    return new Response(JSON.stringify({ error: { message: 'public endpoint rate limit' } }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
    });
  }
  if (url.hostname === 'api.blockscout.com') {
    if (url.pathname === '/4663/json-rpc') {
      receiptCalls++;
      receiptLastUrl = url.href;
      const headers = new Headers(init.headers || {});
      receiptSawBearer = headers.get('Authorization') === `Bearer ${TEST_BLOCKSCOUT_SECRET}`;
      receiptLastRequest = JSON.parse(String(init.body || 'null'));
      assert.equal(init.method, 'POST');
      assert.equal(headers.get('Content-Type'), 'application/json');
      if (receiptMode === 'live') return originalFetch(input, init);
      if (receiptMode === 'provider-error') {
        return new Response(JSON.stringify({
          error: `private upstream detail ${TEST_BLOCKSCOUT_SECRET}`,
        }), { status: 429, headers: { 'Content-Type': 'application/json' } });
      }
      if (receiptMode === 'jsonrpc-error') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id: 1,
          error: { message: `private upstream detail ${TEST_BLOCKSCOUT_SECRET}` },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const requestedHash = receiptLastRequest.params[0];
      const resultHash = receiptMode === 'mismatched-hash'
        ? '0x' + 'f'.repeat(64) : requestedHash;
      let address = CHAINS.robinhood.v4PoolManager;
      if (receiptMode === 'position-manager') address = CHAINS.robinhood.v4PositionManager;
      if (receiptMode === 'unrelated') address = '0x' + '9'.repeat(40);
      const topic0 = receiptMode === 'wrong-topic'
        ? '0x' + '8'.repeat(64) : MODIFY_LIQUIDITY_TOPIC;
      const positionManagerTopic = receiptMode === 'wrong-position-manager'
        ? '0x' + '7'.repeat(64)
        : '0x' + CHAINS.robinhood.v4PositionManager.replace(/^0x/, '')
          .toLowerCase().padStart(64, '0');
      const result = receiptMode === 'null-result' ? null : {
        transactionHash: resultHash,
        status: receiptMode === 'failed-status' ? '0x0'
          : receiptMode === 'missing-status' ? undefined : '0x1',
        blockNumber: '0x1234',
        logs: [{
          address,
          transactionHash: resultHash,
          logIndex: '0x0',
          topics: [topic0, '0x' + '6'.repeat(64), positionManagerTopic],
          data: '0x',
        }],
      };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    blockscoutCalls++;
    blockscoutSawSecret = url.searchParams.get('apikey') === TEST_BLOCKSCOUT_SECRET;
    assert.equal(url.searchParams.get('chain_id'), '1');
    assert.equal(url.searchParams.get('module'), 'logs');
    assert.equal(url.searchParams.get('action'), 'getLogs');
    if (LIVE) return originalFetch(input, init);
    let result = [LOG];
    if (pagedMode) {
      const fromBlock = Number(url.searchParams.get('fromBlock'));
      result = fromBlock === 0
        ? Array.from({ length: 1000 }, (_unused, index) => ({
            ...LOG,
            blockNumber: '0x' + (index + 1).toString(16),
            transactionHash: '0x' + (index + 1).toString(16).padStart(64, '0'),
          }))
        : [
            { ...LOG, blockNumber: '0x3e8', transactionHash: '0x' + (1000).toString(16).padStart(64, '0') },
            { ...LOG, blockNumber: '0x3e9', transactionHash: '0x' + (1001).toString(16).padStart(64, '0') },
          ];
    }
    return new Response(JSON.stringify({ status: '1', message: 'OK', result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (url.hostname === 'api.etherscan.io') {
    etherscanCalls++;
    etherscanSawSecret = url.searchParams.get('apikey') === TEST_ETHERSCAN_SECRET;
    assert.equal(url.searchParams.get('chainid'), '999');
    assert.equal(url.searchParams.get('module'), 'logs');
    assert.equal(url.searchParams.get('action'), 'getLogs');
    assert.equal(url.searchParams.get('address'), CHAINS.hyperevm.nfpm.toLowerCase());
    if (LIVE) return originalFetch(input, init);
    return new Response(JSON.stringify({ status: '1', message: 'OK', result: [PROJECTX_LOG] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  throw new Error(`unexpected outbound host ${url.hostname}`);
};

const requestReceipt = (payload, method = 'POST') => worker.fetch(new Request(
  'https://lplens-beta.licence-worker.workers.dev/receipt',
  {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}),
  },
), env);

try {
  assert.equal(decide(null).valid, false);
  assert.equal(decide({ label: 'x' }).valid, false);
  assert.equal(decide({ label: 'x', expires: 'soon' }).valid, false);
  assert.equal(decide({ label: 'x', expires: '2099-12-31' }).valid, true);
  assert.equal(decide({ label: 'x', expires: '2020-01-01' }).valid, false);

  const cleanReceipt = receiptQuery({
    key: TEST_KEY,
    installationId: TEST_INSTALL,
    chainId: '4663',
    transactionHash: '0x' + 'A'.repeat(64),
  });
  assert.deepEqual(cleanReceipt, { chainId: '4663', transactionHash: RECEIPT_TX });
  for (const bad of [
    {
      key: TEST_KEY, installationId: TEST_INSTALL, chainId: 4663,
      transactionHash: RECEIPT_TX,
    },
    {
      key: TEST_KEY, installationId: TEST_INSTALL, chainId: 1,
      transactionHash: RECEIPT_TX,
    },
    {
      key: TEST_KEY, installationId: TEST_INSTALL, chainId: '4663',
      transactionHash: '0x1234',
    },
    {
      key: TEST_KEY, installationId: TEST_INSTALL, chainId: '4663',
      transactionHash: RECEIPT_TX, method: 'eth_getBalance',
    },
    {
      key: {}, installationId: TEST_INSTALL, chainId: '4663',
      transactionHash: RECEIPT_TX,
    },
    {
      key: TEST_KEY, installationId: {}, chainId: '4663',
      transactionHash: RECEIPT_TX,
    },
    {
      key: TEST_KEY, installationId: TEST_INSTALL, chainId: '4663',
    },
  ]) {
    assert.throws(() => receiptQuery(bad), /receipt|transaction/i);
  }

  // Pure allowlist: exact LPLens contract passes; arbitrary contracts do not.
  const clean = relayQuery({
    chainId: 1,
    fields: {
      address: LOG.address,
      fromBlock: '0',
      toBlock: 'latest',
      topic1: LOG.topics[1],
    },
  });
  assert.equal(clean.chainId, '1');
  assert.throws(() => relayQuery({
    chainId: 1,
    fields: { address: '0x' + '9'.repeat(40), topic1: LOG.topics[1] },
  }), /allowlisted/);
  for (const chain of Object.values(CHAINS)) {
    if (!chain.etherscanChainId) {
      assert.throws(() => relayQuery({
        chainId: 4663,
        fields: { address: chain.nfpm, topic1: LOG.topics[1] },
      }), /unsupported history request/);
      continue;
    }
    for (const address of [chain.nfpm, chain.v4PositionManager].filter(Boolean)) {
      const allowed = relayQuery({
        chainId: chain.etherscanChainId,
        fields: { address, fromBlock: '0', toBlock: 'latest', topic1: LOG.topics[1] },
      });
      assert.equal(allowed.fields.address, address.toLowerCase());
    }
    if (chain.v4PoolManager) {
      const managerTopic = '0x'
        + chain.v4PositionManager.replace(/^0x/, '').toLowerCase().padStart(64, '0');
      const allowed = relayQuery({
        chainId: chain.etherscanChainId,
        fields: {
          address: chain.v4PoolManager,
          fromBlock: '0',
          toBlock: 'latest',
          topic0: '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec',
          topic1: '0x' + '8'.repeat(64),
          topic2: managerTopic,
          topic0_1_opr: 'and',
          topic0_2_opr: 'and',
          topic1_2_opr: 'and',
        },
      });
      assert.equal(allowed.fields.address, chain.v4PoolManager.toLowerCase());
      assert.throws(() => relayQuery({
        chainId: chain.etherscanChainId,
        fields: { address: chain.v4PoolManager, topic1: LOG.topics[1] },
      }), /exact LPLens history filter/);
    }
  }
  assert.equal(
    new URL('history', VALIDATE_URL).href,
    'https://lplens-beta.licence-worker.workers.dev/history',
  );

  // The validation endpoint tracks only hashes and returns the soft seat count.
  const validation = await worker.fetch(new Request(
    'https://lplens-beta.licence-worker.workers.dev/',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: TEST_KEY, installationId: TEST_INSTALL }),
    },
  ), env);
  assert.equal(validation.status, 200);
  const validationBody = await validation.json();
  assert.equal(validationBody.valid, true);
  assert.equal(validationBody.installations, 1);
  assert.equal(validationBody.installationLimit, 5);
  assert.equal(db.installations.size, 1);
  assert.ok(!JSON.stringify([...db.boundValues]).includes(TEST_KEY));
  assert.ok(!JSON.stringify([...db.boundValues]).includes(TEST_INSTALL));
  assert.equal(
    [...db.boundValues].some((args) => args.some((value) =>
      String(value).includes(TEST_BLOCKSCOUT_SECRET)
        || String(value).includes(TEST_ETHERSCAN_SECRET))),
    false,
  );

  // Installation counting is monitor-only. Six browsers on one code stay valid.
  for (let n = 2; n <= 6; n++) {
    const extra = await worker.fetch(new Request(
      'https://lplens-beta.licence-worker.workers.dev/',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: TEST_KEY,
          installationId: n.toString(16).padStart(32, '0'),
        }),
      },
    ), env);
    assert.equal(extra.status, 200);
    const extraBody = await extra.json();
    assert.equal(extraBody.valid, true);
    assert.equal(extraBody.installations, n);
    assert.equal(extraBody.installationLimit, 5);
  }

  // The real licence client creates one stable random browser identifier and
  // carries it into validation and relay credentials without user setup.
  const chromeBacking = { licenseKey: TEST_KEY };
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => Object.fromEntries(
          keys.filter((key) => Object.hasOwn(chromeBacking, key))
            .map((key) => [key, chromeBacking[key]])),
        set: async (values) => Object.assign(chromeBacking, values),
      },
    },
  };
  const licence = await import(`../extension/lib/license.js?relay-test=${Date.now()}`);
  const entitlement = await licence.entitlement();
  assert.equal(entitlement.allowed, true);
  const relayCredentials = await licence.historyRelayCredentials();
  assert.match(relayCredentials.installationId, /^[0-9a-f]{32}$/);
  assert.equal(await licence.installationId(), relayCredentials.installationId);

  // Exercise the real extension log client through the Worker and upstream.
  const got = await fetchPositionLogs({
    nfpm: LOG.address,
    tokenId: 961877n,
    rpc: 'https://rpc.invalid.example',
    etherscanKey: null,
    etherscanChainId: 1,
    historyRelay: relayCredentials,
    historyRelayChainId: 1,
    blockscout: null,
  });
  assert.equal(got.source, 'blockscout-pro', JSON.stringify(got));
  assert.equal(got.logs.length, LIVE ? 4 : 1);
  if (!LIVE) assert.equal(got.logs[0].block, 16);
  assert.equal(blockscoutCalls, 1);
  assert.equal(blockscoutSawSecret, true);
  assert.equal(db.usage.values().next().value.requests, 1);

  const projectx = await fetchPositionLogs({
    nfpm: CHAINS.hyperevm.nfpm,
    tokenId: 533076n,
    rpc: 'https://rpc.invalid.example',
    etherscanKey: null,
    etherscanChainId: 999,
    historyRelay: relayCredentials,
    historyRelayChainId: 999,
    blockscout: null,
  });
  assert.equal(projectx.source, 'etherscan-hosted', JSON.stringify(projectx));
  assert.equal(projectx.logs.length, 1);
  assert.equal(etherscanCalls, 1);
  assert.equal(etherscanSawSecret, true);
  assert.equal(db.usage.values().next().value.requests, 2);

  if (!LIVE) {
    pagedMode = true;
    const paged = await fetchPositionLogs({
      nfpm: LOG.address,
      tokenId: 961877n,
      rpc: 'https://rpc.invalid.example',
      etherscanKey: null,
      etherscanChainId: 1,
      historyRelay: relayCredentials,
      historyRelayChainId: 1,
      blockscout: null,
    });
    pagedMode = false;
    assert.equal(paged.source, 'blockscout-pro');
    assert.equal(paged.logs.length, 1001);
    assert.equal(blockscoutCalls, 3);
    assert.equal(etherscanCalls, 1);
    assert.equal(db.usage.values().next().value.requests, 4);
  }

  // A valid code cannot turn the relay into a general Blockscout proxy.
  const refused = await worker.fetch(new Request(
    'https://lplens-beta.licence-worker.workers.dev/blockscout',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: TEST_KEY,
        installationId: TEST_INSTALL,
        chainId: 1,
        fields: { address: '0x' + '9'.repeat(40), topic1: LOG.topics[1] },
      }),
    },
  ), env);
  assert.equal(refused.status, 400);
  assert.equal(upstreamCallCount(), LIVE ? 2 : 4);

  const afterSuccess = upstreamCallCount();
  const unknownRelay = await worker.fetch(new Request(
    'https://lplens-beta.licence-worker.workers.dev/blockscout',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'unknown-access-key-with-enough-entropy',
        installationId: TEST_INSTALL,
        chainId: 1,
        fields: { address: LOG.address, topic1: LOG.topics[1] },
      }),
    },
  ), env);
  assert.equal(unknownRelay.status, 403);
  assert.equal(upstreamCallCount(), afterSuccess);

  const expiredKey = 'expired-access-key-with-enough-entropy';
  const expiredHash = await sha256Hex(expiredKey);
  KEYS[expiredHash] = { label: 'expired-fixture', expires: '2020-01-01' };
  try {
    const expiredRelay = await worker.fetch(new Request(
      'https://lplens-beta.licence-worker.workers.dev/blockscout',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: expiredKey,
          installationId: TEST_INSTALL,
          chainId: 1,
          fields: { address: LOG.address, topic1: LOG.topics[1] },
        }),
      },
    ), env);
    assert.equal(expiredRelay.status, 403);
  } finally {
    delete KEYS[expiredHash];
  }

  const missingInstall = await worker.fetch(new Request(
    'https://lplens-beta.licence-worker.workers.dev/blockscout',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: TEST_KEY,
        chainId: 1,
        fields: { address: LOG.address, topic1: LOG.topics[1] },
      }),
    },
  ), env);
  assert.equal(missingInstall.status, 401);

  const receiptPayload = {
    key: TEST_KEY,
    installationId: TEST_INSTALL,
    chainId: '4663',
    transactionHash: RECEIPT_TX,
  };
  const usageBeforeReceipt = db.usage.values().next().value.requests;
  receiptMode = 'pool-manager';
  const receiptResponse = await requestReceipt(receiptPayload);
  assert.equal(receiptResponse.status, 200);
  const receiptBody = await receiptResponse.json();
  assert.deepEqual(Object.keys(receiptBody), ['result']);
  assert.equal(receiptBody.result.transactionHash, RECEIPT_TX);
  assert.equal(receiptBody.result.status, '0x1');
  assert.equal(receiptBody.result.logs.length, 1,
    'the Worker must return the complete upstream receipt logs array');
  assert.equal(receiptBody.result.logs[0].address, CHAINS.robinhood.v4PoolManager);
  assert.equal(receiptCalls, 1);
  assert.equal(receiptSawBearer, true);
  assert.equal(receiptLastUrl, 'https://api.blockscout.com/4663/json-rpc');
  assert.deepEqual(receiptLastRequest, {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getTransactionReceipt',
    params: [RECEIPT_TX],
  });
  assert.equal(db.usage.values().next().value.requests, usageBeforeReceipt + 1,
    'a successful receipt consumes the existing daily relay quota');
  assert.equal(JSON.stringify([...db.boundValues]).includes(RECEIPT_TX), false,
    'transaction hashes must not be written to the relay database');
  assert.equal(JSON.stringify(receiptBody).includes(TEST_BLOCKSCOUT_SECRET), false);

  // Exercise the real extension fallback through the real Worker validator.
  // Three public-RPC 429s must lead to one canonical authenticated relay call.
  const receiptCallsBeforeE2e = receiptCalls;
  const e2eReceipt = await fetchV4Receipt(
    'https://rpc.receipt-test.invalid',
    { receiptRelayChainId: '4663' },
    RECEIPT_TX_2,
    {
      historyRelay: {
        receiptUrl: 'https://lplens-beta.licence-worker.workers.dev/receipt',
        key: TEST_KEY,
        installationId: TEST_INSTALL,
      },
    },
  );
  assert.equal(rpc429Calls, 3);
  assert.equal(receiptCalls, receiptCallsBeforeE2e + 1);
  assert.equal(e2eReceipt.transactionHash, RECEIPT_TX_2);
  assert.equal(e2eReceipt.logs.length, 1);
  assert.equal(receiptRelayBodies.length, 1);
  assert.deepEqual(receiptRelayBodies[0], {
    key: TEST_KEY,
    installationId: TEST_INSTALL,
    chainId: '4663',
    transactionHash: RECEIPT_TX_2,
  });
  assert.deepEqual(Object.keys(receiptRelayBodies[0]).sort(),
    ['chainId', 'installationId', 'key', 'transactionHash']);

  const callsBeforeInvalidReceipts = receiptCalls;
  const usageBeforeInvalidReceipts = db.usage.values().next().value.requests;
  for (const payload of [
    { ...receiptPayload, chainId: 4663 },
    { ...receiptPayload, chainId: '1' },
    { ...receiptPayload, transactionHash: '0x1234' },
    { ...receiptPayload, method: 'eth_getBalance' },
  ]) {
    const invalid = await requestReceipt(payload);
    assert.equal(invalid.status, 400);
    assert.equal(Object.hasOwn(await invalid.json(), 'result'), false);
  }
  const missingReceiptInstall = await requestReceipt({ ...receiptPayload, installationId: '' });
  assert.equal(missingReceiptInstall.status, 401);
  const unknownReceipt = await requestReceipt({
    ...receiptPayload,
    key: 'unknown-access-key-with-enough-entropy',
  });
  assert.equal(unknownReceipt.status, 403);
  const receiptGet = await requestReceipt(null, 'GET');
  assert.equal(receiptGet.status, 405);
  assert.equal(receiptCalls, callsBeforeInvalidReceipts,
    'invalid, unauthorised and wrong-method requests must never reach Blockscout');
  assert.equal(db.usage.values().next().value.requests, usageBeforeInvalidReceipts,
    'requests rejected before the upstream boundary must not consume quota');

  for (const mode of [
    'mismatched-hash', 'null-result', 'unrelated', 'position-manager',
    'wrong-topic', 'wrong-position-manager', 'failed-status', 'missing-status',
  ]) {
    receiptMode = mode;
    const rejected = await requestReceipt(receiptPayload);
    assert.equal(rejected.status, 404, `${mode} receipt must fail closed`);
    const rejectedBody = await rejected.json();
    assert.equal(Object.hasOwn(rejectedBody, 'result'), false);
    assert.equal(JSON.stringify(rejectedBody).includes(TEST_BLOCKSCOUT_SECRET), false);
  }
  receiptMode = 'provider-error';
  const providerFailure = await requestReceipt(receiptPayload);
  assert.equal(providerFailure.status, 502);
  const providerFailureBody = await providerFailure.json();
  assert.match(providerFailureBody.error || '', /temporarily unavailable/i);
  assert.equal(JSON.stringify(providerFailureBody).includes(TEST_BLOCKSCOUT_SECRET), false,
    'upstream errors must not expose provider details or the bearer credential');
  receiptMode = 'jsonrpc-error';
  const rpcFailure = await requestReceipt(receiptPayload);
  assert.equal(rpcFailure.status, 502);
  const rpcFailureBody = await rpcFailure.json();
  assert.match(rpcFailureBody.error || '', /temporarily unavailable/i);
  assert.equal(JSON.stringify(rpcFailureBody).includes(TEST_BLOCKSCOUT_SECRET), false,
    'JSON-RPC errors must not expose upstream details or the bearer credential');
  receiptMode = 'pool-manager';

  if (LIVE) {
    const liveTransactionHash =
      '0x00e8fa6cc9dd87fe357bb5da81e6c399f7cde8228fb022e1505bc4b25eb36ff5';
    receiptMode = 'live';
    const liveReceiptResponse = await requestReceipt({
      ...receiptPayload,
      transactionHash: liveTransactionHash,
    });
    assert.equal(liveReceiptResponse.status, 200);
    const liveReceiptBody = await liveReceiptResponse.json();
    assert.deepEqual(Object.keys(liveReceiptBody), ['result']);
    assert.equal(String(liveReceiptBody.result.transactionHash).toLowerCase(), liveTransactionHash);
    assert.equal(liveReceiptBody.result.status, '0x1');
    assert.equal(liveReceiptBody.result.logs.length, 3);
    assert.equal(JSON.stringify(liveReceiptBody).includes(TEST_BLOCKSCOUT_SECRET), false);
    receiptMode = 'pool-manager';
  }

  const day = new Date().toISOString().slice(0, 10);
  db.usage.set(`${keyHash}:${day}`, {
    licenceHash: keyHash, label: 'test-fixture', day, requests: 1000, at: day,
  });
  const overQuota = await worker.fetch(new Request(
    'https://lplens-beta.licence-worker.workers.dev/blockscout',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: TEST_KEY,
        installationId: TEST_INSTALL,
        chainId: 1,
        fields: { address: LOG.address, topic1: LOG.topics[1] },
      }),
    },
  ), env);
  assert.equal(overQuota.status, 429);
  const overQuotaBody = await overQuota.json();
  assert.match(overQuotaBody.error || '', /daily history allowance/i);
  assert.equal(upstreamCallCount(), afterSuccess);
  const receiptCallsBeforeQuota = receiptCalls;
  const receiptOverQuota = await requestReceipt(receiptPayload);
  assert.equal(receiptOverQuota.status, 429);
  assert.equal(receiptCalls, receiptCallsBeforeQuota,
    'over-quota receipt requests must not reach Blockscout');

  const privacy = await worker.fetch(new Request(
    'https://lplens-beta.licence-worker.workers.dev/privacy',
  ), env);
  assert.equal(privacy.status, 200);
  const privacyHtml = await privacy.text();
  assert.match(privacyHtml, /Blockscout Pro/);
  assert.match(privacyHtml, /Etherscan V2/);
  assert.match(privacyHtml, /ProjectX/);
  assert.match(privacyHtml, /installation identifier/i);
  assert.match(privacyHtml, /position links/i);
  assert.match(privacyHtml, /first line of visible row text/i);
  assert.doesNotMatch(privacyHtml, /does not read Uniswap(?:’|')s page HTML/i);
  assert.equal(privacyHtml.includes(TEST_BLOCKSCOUT_SECRET), false);
  assert.equal(privacyHtml.includes(TEST_ETHERSCAN_SECRET), false);

  const getRoot = await worker.fetch(new Request(
    'https://lplens-beta.licence-worker.workers.dev/',
  ), env);
  assert.equal(getRoot.status, 405);
  const preflight = await worker.fetch(new Request(
    'https://lplens-beta.licence-worker.workers.dev/history',
    { method: 'OPTIONS' },
  ), env);
  assert.equal(preflight.status, 204);

  console.log(`history relay: allowlist, hashed install tracking, quota and extension path pass${LIVE ? ' (live Blockscout Pro + Etherscan)' : ''}`);
} finally {
  globalThis.fetch = originalFetch;
  delete globalThis.chrome;
  delete KEYS[keyHash];
}
