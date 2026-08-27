#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildScanDiagnostic, durationBucket, normalizeErrorCode, positionBucket,
} from '../extension/lib/diagnostics.js';
import worker, { KEYS, sha256Hex, telemetryEvent } from './licence-worker/worker.js';

globalThis.chrome = {
  runtime: { getManifest: () => ({ version: '0.30.0' }) },
};

assert.equal(normalizeErrorCode('HTTP 429: rate limit reached'), 'rate_limit');
assert.equal(normalizeErrorCode('request timed out'), 'timeout');
assert.equal(normalizeErrorCode('v4 ownership enumeration failed'), 'ownership');
assert.equal(normalizeErrorCode('Blockscout history unavailable'), 'history');
assert.equal(normalizeErrorCode('eth_call reverted'), 'rpc');
assert.equal(positionBucket(0), '0');
assert.equal(positionBucket(5), '2-5');
assert.equal(positionBucket(21), '21+');
assert.equal(durationBucket(4_999), '<5s');
assert.equal(durationBucket(60_000), '60s+');

const secretAddress = '0x' + 'a'.repeat(40);
const secretKey = 'secret-access-value';
const jobs = [
  { owner: secretAddress, label: 'private label', chainKey: 'base' },
  { owner: secretAddress, label: 'private label', chainKey: 'ethereum' },
];
const states = {
  [`${secretAddress}@base`]: {
    ok: false,
    error: `HTTP 429 for wallet ${secretAddress} using ${secretKey}`,
  },
  [`${secretAddress}@ethereum`]: {
    ok: true,
    result: { count: 3, attempted: 2, scanned: 2, positions: [{}], v4: {} },
  },
};
const report = buildScanDiagnostic({
  surface: 'sidepanel',
  startedAt: 0,
  finishedAt: 20_000,
  jobs,
  states,
  positionCount: 1,
  hiddenCount: 0,
  savedWalletCount: 1,
  accessState: 'licensed',
  telemetryEnabled: true,
  optionalPageAccess: { dexscreener: true },
});
const serialized = JSON.stringify(report);
assert.equal(report.scan.outcome, 'partial');
assert.equal(report.scan.positionBucket, '1');
assert.deepEqual(report.scan.errors, [
  { chain: 'base', code: 'rate_limit', count: 1 },
  { chain: 'ethereum', code: 'unreadable', count: 1 },
]);
assert.doesNotMatch(serialized, new RegExp(secretAddress, 'i'));
assert.doesNotMatch(serialized, /private label|secret-access-value|HTTP 429/i);

assert.deepEqual(telemetryEvent({
  key: 'validated separately',
  version: report.version,
  surface: report.surface,
  outcome: report.scan.outcome,
  positionBucket: report.scan.positionBucket,
  durationBucket: report.scan.duration,
  errors: report.scan.errors,
}), {
  version: '0.30.0',
  surface: 'sidepanel',
  outcome: 'partial',
  positionBucket: '1',
  durationBucket: '15-30s',
  errors: report.scan.errors,
});
assert.throws(() => telemetryEvent({
  key: 'x', version: '0.30.0', surface: 'popup', outcome: 'success',
  positionBucket: '1', durationBucket: '<5s', errors: [], wallet: secretAddress,
}), /unsupported telemetry field/);
assert.throws(() => telemetryEvent({
  key: 'x', version: '0.30.0', surface: 'popup', outcome: 'success',
  positionBucket: '1', durationBucket: '<5s',
  errors: [{ chain: 'base', code: 'raw provider text', count: 1 }],
}), /invalid telemetry error/);

const unitKey = 'unit-test-only';
const unitHash = await sha256Hex(unitKey);
KEYS[unitHash] = { label: 'unit', expires: '2099-12-31' };
const writes = [];
const env = {
  DB: {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() { writes.push({ sql, args }); return { success: true }; },
          };
        },
      };
    },
  },
};
const response = await worker.fetch(new Request('https://unit.invalid/telemetry', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    key: unitKey,
    version: '0.30.0',
    surface: 'sidepanel',
    outcome: 'partial',
    positionBucket: '1',
    durationBucket: '15-30s',
    errors: report.scan.errors,
  }),
}), env);
delete KEYS[unitHash];
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { ok: true });
assert.equal(writes.length, 3);
assert.ok(writes.every(({ sql, args }) =>
  !/licen[cs]e_hash|installation_hash/.test(sql)
  && !args.includes(unitKey) && !args.includes(unitHash)));

const schema = readFileSync(new URL('./licence-worker/schema.sql', import.meta.url), 'utf8');
const scanTables = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS scan_outcomes_daily'));
assert.doesNotMatch(scanTables, /licen[cs]e_hash|installation_hash/);
console.log('diagnostics and telemetry: sanitized report, strict event allowlist and unlinkable schema pass');
