#!/usr/bin/env node
/**
 * Bounded deployed-runtime test, not a unit mock. Uses an operator code from
 * the environment, never a tester's browser storage or provider credential.
 * node --env-file-if-exists=.env tools/test-live-reference-price.mjs --env LPLENS_OWNER_ACCESS_KEY
 * One stable operator installation ID; one cold price request; canonical warm reuse.
 */
import assert from 'node:assert/strict';
const at = process.argv.indexOf('--env');
const name = at < 0 ? '' : process.argv[at + 1];
if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(name || '') || !process.env[name]) {
  console.error('Supply --env NAME and load that operator access code through the environment.');
  process.exit(1);
}
const backing = {
  licenseKey: process.env[name],
  lplensInstallationId: 'cc4d10be0da032be1c7fcac1b58c128a1',
};
globalThis.chrome = { storage: { local: {
  get: async (keys) => keys === null ? structuredClone(backing)
    : Object.fromEntries((typeof keys === 'string' ? [keys] : keys)
      .filter((k) => Object.hasOwn(backing, k)).map((k) => [k, structuredClone(backing[k])])),
  set: async (values) => Object.assign(backing, structuredClone(values)),
  remove: async (keys) => { for (const k of Array.isArray(keys) ? keys : [keys]) delete backing[k]; },
} } };
const nativeFetch = globalThis.fetch;
let priceRequests = 0, blockChecks = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === 'lplens-beta.licence-worker.workers.dev' && url.pathname === '/price') {
    if (++priceRequests > 1) throw new Error('price request budget');
  } else if (url.hostname === 'ethereum-rpc.publicnode.com') {
    if (++blockChecks > 4) throw new Error('canonical check budget');
  } else if (!(url.hostname === 'lplens-beta.licence-worker.workers.dev' && url.pathname === '/')) {
    throw new Error('unexpected endpoint');
  }
  return nativeFetch(input, { ...init, signal: init.signal || AbortSignal.timeout(8000) });
};
try {
  const { entitlement, historyRelayCredentials } = await import('../extension/lib/license.js');
  assert.equal((await entitlement()).allowed, true);
  const opts = { historyRelay: await historyRelayCredentials() };
  const { protectedReferencePrice, REFERENCE_CACHE_PREFIX } = await import('../extension/lib/reference-price.js');
  const query = { timestamp: 1_787_600_000 };
  const cold = await protectedReferencePrice(query, opts);
  assert.ok(cold > 0 && Number.isFinite(cold));
  assert.equal(priceRequests, 1);
  assert.equal(Object.keys(backing).filter((k) => k.startsWith(REFERENCE_CACHE_PREFIX)).length, 1);
  const restarted = await import('../extension/lib/reference-price.js?live-restart');
  assert.equal(await restarted.protectedReferencePrice(query, opts), cold);
  assert.equal(priceRequests, 1, 'warm read must not retry the provider');
  assert.equal(blockChecks, 2);
  console.log('live reference pricing: hosted proof, local persistent success, two canonical checks and zero warm price requests pass');
} catch {
  console.error('Live reference-price checks failed. No credential or upstream error details printed.');
  process.exitCode = 1;
} finally { globalThis.fetch = nativeFetch; delete globalThis.chrome; }
