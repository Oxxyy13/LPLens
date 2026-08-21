#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import worker, { KEYS, decide, relayQuery, sha256Hex } from './licence-worker/worker.js';
import { CHAINS } from '../extension/lib/chains.js';
import { VALIDATE_URL } from '../extension/lib/license.js';
import { fetchPositionLogs } from '../extension/lib/logs.js';

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
const TEST_SECRET = LIVE ? envFile.BLOCKSCOUT_PRO_API_KEY : 'test-blockscout-secret';
if (!TEST_SECRET) throw new Error('BLOCKSCOUT_PRO_API_KEY missing for --live test');
const keyHash = await sha256Hex(TEST_KEY);
KEYS[keyHash] = { label: 'test-fixture', expires: '2099-12-31' };

const db = new FakeD1();
const env = { DB: db, BLOCKSCOUT_PRO_API_KEY: TEST_SECRET };
const originalFetch = globalThis.fetch;
let upstreamCalls = 0;
let upstreamSawSecret = false;
let pagedMode = false;

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

globalThis.fetch = async (input, init = {}) => {
  const url = input instanceof URL
    ? input
    : new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === 'lplens-beta.licence-worker.workers.dev') {
    return worker.fetch(new Request(url, init), env);
  }
  if (url.hostname === 'api.blockscout.com') {
    upstreamCalls++;
    upstreamSawSecret = url.searchParams.get('apikey') === TEST_SECRET;
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
  throw new Error(`unexpected outbound host ${url.hostname}`);
};

try {
  assert.equal(decide(null).valid, false);
  assert.equal(decide({ label: 'x' }).valid, false);
  assert.equal(decide({ label: 'x', expires: 'soon' }).valid, false);
  assert.equal(decide({ label: 'x', expires: '2099-12-31' }).valid, true);
  assert.equal(decide({ label: 'x', expires: '2020-01-01' }).valid, false);

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
      }), /unsupported Blockscout request/);
      continue;
    }
    for (const address of [chain.nfpm, chain.v4PositionManager]) {
      const allowed = relayQuery({
        chainId: chain.etherscanChainId,
        fields: { address, fromBlock: '0', toBlock: 'latest', topic1: LOG.topics[1] },
      });
      assert.equal(allowed.fields.address, address.toLowerCase());
    }
  }
  assert.equal(
    new URL('blockscout', VALIDATE_URL).href,
    'https://lplens-beta.licence-worker.workers.dev/blockscout',
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
    [...db.boundValues].some((args) => args.some((value) => String(value).includes(TEST_SECRET))),
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
  const relayCredentials = await licence.blockscoutRelayCredentials();
  assert.match(relayCredentials.installationId, /^[0-9a-f]{32}$/);
  assert.equal(await licence.installationId(), relayCredentials.installationId);

  // Exercise the real extension log client through the Worker and upstream.
  const got = await fetchPositionLogs({
    nfpm: LOG.address,
    tokenId: 961877n,
    rpc: 'https://rpc.invalid.example',
    etherscanKey: null,
    etherscanChainId: 1,
    blockscoutRelay: relayCredentials,
    blockscoutChainId: 1,
    blockscout: null,
  });
  assert.equal(got.source, 'blockscout-pro', JSON.stringify(got));
  assert.equal(got.logs.length, LIVE ? 4 : 1);
  if (!LIVE) assert.equal(got.logs[0].block, 16);
  assert.equal(upstreamCalls, 1);
  assert.equal(upstreamSawSecret, true);
  assert.equal(db.usage.values().next().value.requests, 1);

  if (!LIVE) {
    pagedMode = true;
    const paged = await fetchPositionLogs({
      nfpm: LOG.address,
      tokenId: 961877n,
      rpc: 'https://rpc.invalid.example',
      etherscanKey: null,
      etherscanChainId: 1,
      blockscoutRelay: relayCredentials,
      blockscoutChainId: 1,
      blockscout: null,
    });
    pagedMode = false;
    assert.equal(paged.source, 'blockscout-pro');
    assert.equal(paged.logs.length, 1001);
    assert.equal(upstreamCalls, 3);
    assert.equal(db.usage.values().next().value.requests, 3);
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
  assert.equal(upstreamCalls, LIVE ? 1 : 3);

  const afterSuccess = upstreamCalls;
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
  assert.equal(upstreamCalls, afterSuccess);

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
  assert.equal(upstreamCalls, afterSuccess);

  const privacy = await worker.fetch(new Request(
    'https://lplens-beta.licence-worker.workers.dev/privacy',
  ), env);
  assert.equal(privacy.status, 200);
  const privacyHtml = await privacy.text();
  assert.match(privacyHtml, /Blockscout Pro/);
  assert.match(privacyHtml, /installation identifier/i);
  assert.match(privacyHtml, /position links/i);
  assert.match(privacyHtml, /first line of visible row text/i);
  assert.doesNotMatch(privacyHtml, /does not read Uniswap(?:’|')s page HTML/i);
  assert.equal(privacyHtml.includes(TEST_SECRET), false);

  const getRoot = await worker.fetch(new Request(
    'https://lplens-beta.licence-worker.workers.dev/',
  ), env);
  assert.equal(getRoot.status, 405);
  const preflight = await worker.fetch(new Request(
    'https://lplens-beta.licence-worker.workers.dev/blockscout',
    { method: 'OPTIONS' },
  ), env);
  assert.equal(preflight.status, 204);

  console.log(`blockscout relay: allowlist, hashed install tracking, quota and extension path pass${LIVE ? ' (live Pro API)' : ''}`);
} finally {
  globalThis.fetch = originalFetch;
  delete globalThis.chrome;
  delete KEYS[keyHash];
}
