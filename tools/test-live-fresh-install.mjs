#!/usr/bin/env node
/**
 * Exercise the shipped licence client and hosted history relay as a brand
 * new browser profile. The access code is read from a local file or .env and
 * is never printed. This is a live test and intentionally consumes three or
 * more relay requests plus one installation row for the supplied code.
 *
 * Usage: node tools/test-live-fresh-install.mjs --env CWS_REVIEWER_ACCESS_KEY
 *        node tools/test-live-fresh-install.mjs --key-file C:\path\to\key.txt
 *        LPLENS_ENV_FILE=C:\path\to\.env node tools/test-live-fresh-install.mjs --env NAME
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchFilteredLogs, fetchPositionLogs } from '../extension/lib/logs.js';
import { CHAINS } from '../extension/lib/chains.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_ORIGIN = 'https://lplens-beta.licence-worker.workers.dev';
const NFPM = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
const TOKEN_ID = 961877n;
const PROJECTX_TOKEN_ID = 533076n;
const V4_MODIFY = '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec';
const ETH_V4_POOL_ID = '0x135e319cb228834941e895dd8f123b218246f2bb8ef533972784b77efb38eedc';

function envValues() {
  const file = resolve(String(process.env.LPLENS_ENV_FILE || '').trim() || join(ROOT, '.env'));
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return [];
    const at = trimmed.indexOf('=');
    if (at < 1) return [];
    return [[trimmed.slice(0, at), trimmed.slice(at + 1).replace(/^['"]|['"]$/g, '')]];
  }));
}

function accessKey() {
  const envAt = process.argv.indexOf('--env');
  if (envAt !== -1) {
    const name = process.argv[envAt + 1] || '';
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(name)) throw new Error('invalid --env name');
    const key = String(envValues()[name] || '').trim();
    if (!key) throw new Error(`${name} is missing from .env`);
    return key;
  }
  const fileAt = process.argv.indexOf('--key-file');
  if (fileAt !== -1) {
    const path = resolve(process.argv[fileAt + 1] || '');
    const key = String(readFileSync(path, 'utf8')).trim();
    if (!key) throw new Error('key file is empty');
    return key;
  }
  throw new Error('use --env NAME or --key-file PATH');
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) walk(file, out);
    else out.push(file);
  }
  return out;
}

const key = accessKey();
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'extension/manifest.json'), 'utf8'));
assert.ok(manifest.host_permissions.includes(`${WORKER_ORIGIN}/*`));

// This is the exact initial state after the user saves a code in a clean
// profile: no installation id and no cached verdict exist yet.
const backing = { licenseKey: key };
globalThis.chrome = {
  storage: { local: {
    get: async (names) => Object.fromEntries(
      names.filter((name) => Object.hasOwn(backing, name)).map((name) => [name, backing[name]]),
    ),
    set: async (values) => Object.assign(backing, values),
  } },
};

try {
  const licence = await import(`../extension/lib/license.js?fresh=${Date.now()}`);
  const entitlement = await licence.entitlement();
  assert.equal(entitlement.allowed, true, entitlement.reason || 'access denied');
  assert.equal(entitlement.state, 'licensed');
  assert.match(backing.lplensInstallationId, /^[0-9a-f]{32}$/);
  assert.equal(backing.licenseSeen.valid, true);

  const relay = await licence.historyRelayCredentials();
  assert.equal(relay.url, `${WORKER_ORIGIN}/history`);
  assert.equal(relay.installationId, backing.lplensInstallationId);

  const result = await fetchPositionLogs({
    nfpm: NFPM,
    tokenId: TOKEN_ID,
    rpc: 'https://rpc.invalid.example',
    etherscanKey: null,
    etherscanChainId: 1,
    historyRelay: relay,
    historyRelayChainId: 1,
    blockscout: null,
  });
  assert.equal(result.source, 'blockscout-pro', JSON.stringify(result));
  assert.equal(result.logs.length, 4);

  const projectx = await fetchPositionLogs({
    nfpm: CHAINS.hyperevm.nfpm,
    tokenId: PROJECTX_TOKEN_ID,
    rpc: 'https://rpc.invalid.example',
    etherscanKey: null,
    etherscanChainId: 999,
    historyRelay: relay,
    historyRelayChainId: 999,
    blockscout: null,
  });
  assert.equal(projectx.source, 'etherscan-hosted', JSON.stringify(projectx));
  assert.equal(projectx.logs.length, 1);

  const eth = CHAINS.ethereum;
  const v4 = await fetchFilteredLogs({
    contract: eth.v4PoolManager,
    topics: [
      V4_MODIFY,
      ETH_V4_POOL_ID,
      '0x' + eth.v4PositionManager.replace(/^0x/, '').toLowerCase().padStart(64, '0'),
    ],
    rpc: 'https://rpc.invalid.example',
    etherscanKey: null,
    etherscanChainId: 1,
    historyRelay: relay,
    historyRelayChainId: 1,
    blockscout: null,
  });
  assert.equal(v4.source, 'blockscout-pro', JSON.stringify(v4));
  assert.ok(v4.logs.some((log) => BigInt('0x' + log.data.slice(-64)) === 1000n),
    'hosted v4 history did not return the immutable NFT 1000 mint');

  // A local operator can keep the provider secret in .env for deployment and
  // regression tests, but it must remain absent from everything Chrome ships.
  const providerSecrets = [
    envValues().BLOCKSCOUT_PRO_API_KEY,
    envValues().ETHERSCAN_KEY,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  if (providerSecrets.length) {
    for (const file of walk(resolve(ROOT, 'extension'))) {
      if (/\.(png|gif|jpe?g|webp|ico)$/i.test(file)) continue;
      const text = readFileSync(file, 'utf8');
      for (const providerSecret of providerSecrets) {
        assert.equal(text.includes(providerSecret), false);
      }
    }
  }
  console.log('fresh install: licence validation and hosted v3/v4 Blockscout Pro + ProjectX Etherscan history pass');
} finally {
  delete globalThis.chrome;
}
