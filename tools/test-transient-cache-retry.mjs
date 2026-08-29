#!/usr/bin/env node
import assert from 'node:assert/strict';

globalThis.chrome = { storage: { local: {
  get: async () => ({}),
  set: async () => {},
  remove: async () => {},
} } };

const { tokenMeta } = await import(`../extension/lib/positions.js?transient-cache=${Date.now()}`);
const { refUsdAtBlock } = await import('../extension/lib/histprice.js');
const { CHAINS } = await import('../extension/lib/chains.js');

const originalFetch = globalThis.fetch;
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const addressWord = (address) => word(BigInt(address));
const bytes32 = (text) => Buffer.from(text, 'utf8').toString('hex').padEnd(64, '0');
const rpcReply = (body, result) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ jsonrpc: '2.0', id: body.id, result }),
});

try {
  // A syntactically successful RPC response can still be unusable token
  // metadata. The fallback is allowed for this render, but must be retried on
  // the next load instead of becoming a service-worker-lifetime cache entry.
  const token = '0x' + '71'.repeat(20);
  let metadataMode = 'malformed';
  let metadataCalls = 0;
  globalThis.fetch = async (_input, init = {}) => {
    const body = JSON.parse(init.body);
    metadataCalls++;
    if (metadataMode === 'malformed') return rpcReply(body, '0x');
    const selector = body.params[0].data.slice(0, 10).toLowerCase();
    if (selector === '0x95d89b41') return rpcReply(body, '0x' + bytes32('RETRY'));
    if (selector === '0x313ce567') return rpcReply(body, '0x' + word(6n));
    throw new Error(`unexpected token metadata selector ${selector}`);
  };

  assert.deepEqual(
    await tokenMeta('https://metadata.fixture.invalid', 'cache-token-retry', token),
    { symbol: '?', decimals: 18 },
  );
  assert.equal(metadataCalls, 2);

  metadataMode = 'valid';
  assert.deepEqual(
    await tokenMeta('https://metadata.fixture.invalid', 'cache-token-retry', token),
    { symbol: 'RETRY', decimals: 6 },
    'fallback token metadata must be retried',
  );
  assert.equal(metadataCalls, 4);

  metadataMode = 'must-not-fetch';
  globalThis.fetch = async () => {
    throw new Error('successfully decoded token metadata should be cached');
  };
  assert.deepEqual(
    await tokenMeta('https://metadata.fixture.invalid', 'cache-token-retry', token),
    { symbol: 'RETRY', decimals: 6 },
  );
  assert.equal(metadataCalls, 4, 'a proven metadata row should be memoised');

  // Partial success is still not a complete fact. In particular, caching a
  // real symbol alongside fallback 18 decimals silently scales every amount.
  const partialToken = '0x' + '72'.repeat(20);
  metadataMode = 'partial';
  let partialCalls = 0;
  globalThis.fetch = async (_input, init = {}) => {
    const body = JSON.parse(init.body);
    partialCalls++;
    const selector = body.params[0].data.slice(0, 10).toLowerCase();
    if (selector === '0x95d89b41') return rpcReply(body, '0x' + bytes32('PARTIAL'));
    if (selector === '0x313ce567') {
      return rpcReply(body, metadataMode === 'partial' ? '0x' : '0x' + word(9n));
    }
    throw new Error(`unexpected partial metadata selector ${selector}`);
  };
  assert.deepEqual(
    await tokenMeta('https://metadata.fixture.invalid', 'cache-token-partial', partialToken),
    { symbol: 'PARTIAL', decimals: 18 },
  );
  metadataMode = 'valid';
  assert.deepEqual(
    await tokenMeta('https://metadata.fixture.invalid', 'cache-token-partial', partialToken),
    { symbol: 'PARTIAL', decimals: 9 },
    'partially decoded metadata must be retried rather than cached',
  );
  assert.equal(partialCalls, 4);

  // Reference-pool discovery has the same contract. A provider refusal does
  // not prove that a configured USDC/reference-token pool does not exist.
  const chainKey = 'cache_reference_retry_fixture';
  const factory = '0x' + '81'.repeat(20);
  const stable = '0x' + '82'.repeat(20);
  const weth = '0x' + '83'.repeat(20);
  const pool = '0x' + '84'.repeat(20);
  CHAINS[chainKey] = {
    label: 'Cache reference retry fixture',
    factory,
    rpc: 'https://reference.fixture.invalid',
    usdRef: { stable, weth, stableDecimals: 6 },
  };

  let referenceMode = 'refuse';
  let referenceCalls = 0;
  let discoveryCalls = 0;
  globalThis.fetch = async (_input, init = {}) => {
    const body = JSON.parse(init.body);
    referenceCalls++;
    const selector = body.params[0].data.slice(0, 10).toLowerCase();
    if (selector === '0x1698ee82') discoveryCalls++;
    if (referenceMode === 'refuse') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          jsonrpc: '2.0', id: body.id,
          error: { code: -32000, message: 'fixture provider refusal' },
        }),
      };
    }
    if (selector === '0x1698ee82') return rpcReply(body, '0x' + addressWord(pool));
    if (selector === '0x0dfe1681') return rpcReply(body, '0x' + addressWord(stable));
    if (selector === '0x3850c7bd') return rpcReply(body, '0x' + word(1n << 96n) + word(0n));
    throw new Error(`unexpected reference-pool selector ${selector}`);
  };

  assert.equal(
    await refUsdAtBlock(chainKey, 'latest', {
      rpcOverride: 'https://reference.fixture.invalid',
    }),
    null,
    'a refused reference-pool read should fail closed for this attempt',
  );
  assert.equal(discoveryCalls, 3, 'all configured fee tiers should have been attempted');

  referenceMode = 'valid';
  const recovered = await refUsdAtBlock(chainKey, 'latest', {
    rpcOverride: 'https://reference.fixture.invalid',
  });
  assert.equal(recovered, 1e12,
    'a later refresh must rediscover the reference pool after transient failure');
  assert.equal(discoveryCalls, 4, 'successful retry should resolve the first fee tier');

  const callsAfterRecovery = referenceCalls;
  globalThis.fetch = async () => {
    throw new Error('successful latest reference price should be memoised briefly');
  };
  assert.equal(
    await refUsdAtBlock(chainKey, 'latest', {
      rpcOverride: 'https://reference.fixture.invalid',
    }),
    recovered,
  );
  assert.equal(referenceCalls, callsAfterRecovery);

  delete CHAINS[chainKey];
  console.log('transient caches: fallback token metadata and failed pool discovery retry; proven values memoise');
} finally {
  globalThis.fetch = originalFetch;
  delete globalThis.chrome;
}
