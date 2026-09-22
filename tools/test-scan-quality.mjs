#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  buildReturnCoverage, validateReturnCoverage, MAX_QUALITY_POSITIONS,
  PRICE_CAUSE_CODES,
} from '../extension/lib/scan-quality.js';
import { PRICE_FAILURE } from '../extension/lib/histprice.js';
import { buildScanDiagnostic } from '../extension/lib/diagnostics.js';
import {
  sendScanTelemetry, returnCoverageEnabled, TELEMETRY_SETTING_KEY,
  RETURN_COVERAGE_SETTING_KEY,
} from '../extension/lib/telemetry.js';
import worker, { KEYS, sha256Hex, telemetryEvent, telemetryCohort } from './licence-worker/worker.js';

const sentinel = 'private-wallet-token-endpoint-error-sentinel';
const fixture = [
  { usd: { pnl: 0 } }, { usd: { pnl: 4 } }, { usd: { pnl: -4 } },
  { history: { unavailable: sentinel }, usd: { pnl: 4 } },
  { usd: { pnl: null, returnUnavailable: 'gross additions unpriced',
    returnUnavailableReasons: ['reference-price-unavailable', 'reference-price-unavailable', sentinel] } },
  { usd: { pnl: null, returnUnavailable: 'collected proceeds unpriced' } },
  { usd: { pnl: 20, grossAddedExact: false } },
  { usd: { pnl: 20, currentValueIncomplete: true } },
  { usd: null }, { error: sentinel }, { usd: { pnl: NaN } },
].map((p) => ({ ...p, owner: sentinel, token0: sentinel, tokenId: sentinel, symbol0: sentinel }));
const coverage = buildReturnCoverage(fixture);
assert.deepEqual(coverage, { counts: {
  available: 3, history_unavailable: 1, additions_unpriced: 1, proceeds_unpriced: 1,
  bounded_cash_flows: 1, current_value_unavailable: 1, unpriced: 1,
  position_unreadable: 1, unknown: 1,
}, priceCauses: { 'reference-price-unavailable': 1 } });
assert.doesNotMatch(JSON.stringify(coverage), new RegExp(sentinel));
assert.deepEqual(validateReturnCoverage(coverage), coverage);
assert.deepEqual(new Set(PRICE_CAUSE_CODES), new Set(Object.values(PRICE_FAILURE)));
for (const pnl of [null, undefined, Infinity, -Infinity, '0', true]) {
  assert.equal(buildReturnCoverage([{ usd: { pnl } }]).counts.available, undefined);
}
assert.equal(buildReturnCoverage(Array(MAX_QUALITY_POSITIONS + 1).fill({})), null);
assert.equal(buildReturnCoverage(null), null);
assert.deepEqual(buildReturnCoverage([]), { counts: {}, priceCauses: {} });
assert.deepEqual(buildReturnCoverage([{ usd: { pnl: 5, returnUnavailable: sentinel } }]).counts, { unknown: 1 });
for (const exact of ['costBasisExact', 'collectedProceedsExact']) {
  assert.deepEqual(buildReturnCoverage([{ usd: { pnl: 3, [exact]: false } }]).counts, { bounded_cash_flows: 1 });
}
for (const reason of ['current collectable unavailable', 'Current vault value incomplete']) {
  assert.deepEqual(buildReturnCoverage([{ usd: { returnUnavailable: reason } }]).counts, { current_value_unavailable: 1 });
}
for (const bad of [
  null, [], {}, { ...coverage, wallet: sentinel },
  { counts: { [sentinel]: 1 }, priceCauses: {} },
  { counts: { available: '1' }, priceCauses: {} },
  { counts: { available: 0 }, priceCauses: {} },
  { counts: { available: -1 }, priceCauses: {} },
  { counts: { available: 0.5 }, priceCauses: {} },
  { counts: { available: 1000, unknown: 1 }, priceCauses: {} },
  { counts: { available: 1 }, priceCauses: { 'reference-price-unavailable': 1 } },
  { counts: { additions_unpriced: 1 }, priceCauses: { [sentinel]: 1 } },
  JSON.parse('{"counts":{"__proto__":1},"priceCauses":{}}'),
]) assert.throws(() => validateReturnCoverage(bad), /LP-return/);

let storage = { licenseKey: 'quality-unit-test-only' };
let getHook = null;
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: '0.35.0' }) },
  storage: { local: { async get(keys) {
    if (getHook) getHook(keys);
    return Object.fromEntries(keys.filter((key) => key in storage).map((key) => [key, storage[key]]));
  } } },
};
const report = buildScanDiagnostic({
  surface: 'sidepanel', startedAt: 0, finishedAt: 2000,
  positionCount: fixture.length, lpReturns: coverage,
});
assert.deepEqual(report.scan.lpReturns, coverage);
assert.doesNotMatch(JSON.stringify(report), new RegExp(sentinel));
assert.equal(Object.hasOwn(buildScanDiagnostic({}).scan, 'lpReturns'), false);
const requests = [];
globalThis.fetch = async (_url, init) => {
  requests.push(JSON.parse(init.body));
  return { ok: true };
};
assert.equal(await returnCoverageEnabled(), false, 'existing installs must not silently opt in');
await sendScanTelemetry(report);
assert.equal(Object.hasOwn(requests.at(-1), 'lpReturns'), false);
for (const value of [false, 'true', 1, null]) {
  storage[RETURN_COVERAGE_SETTING_KEY] = value;
  assert.equal(await returnCoverageEnabled(), false);
}
storage[RETURN_COVERAGE_SETTING_KEY] = true;
assert.equal(await returnCoverageEnabled(), true);
await sendScanTelemetry(report);
assert.deepEqual(requests.at(-1).lpReturns, coverage);
assert.equal(Object.hasOwn(requests.at(-1), 'installationId'), false);
assert.doesNotMatch(JSON.stringify(requests), new RegExp(sentinel));
const sent = requests.length;
storage[TELEMETRY_SETTING_KEY] = false;
assert.equal(await returnCoverageEnabled(), false);
assert.equal(await sendScanTelemetry(report), false);
assert.equal(requests.length, sent);
storage[TELEMETRY_SETTING_KEY] = true;
getHook = (keys) => { if (keys.includes('licenseKey')) storage[TELEMETRY_SETTING_KEY] = false; };
assert.equal(await sendScanTelemetry(report), false, 'revoke while credentials load');
assert.equal(requests.length, sent);
getHook = null;
storage[TELEMETRY_SETTING_KEY] = true;
getHook = (keys) => { if (keys.includes('licenseKey')) storage[RETURN_COVERAGE_SETTING_KEY] = false; };
assert.equal(await sendScanTelemetry(report), true, 'coverage revocation preserves ordinary scan report');
assert.equal(Object.hasOwn(requests.at(-1), 'lpReturns'), false);
getHook = null;
storage[RETURN_COVERAGE_SETTING_KEY] = true;
const malformed = { ...report, scan: { ...report.scan, lpReturns: { ...coverage, secret: sentinel } } };
assert.equal(await sendScanTelemetry(malformed), true);
assert.equal(Object.hasOwn(requests.at(-1), 'lpReturns'), false);
globalThis.fetch = async () => { throw new Error('offline'); };
assert.equal(await sendScanTelemetry(report), false);
getHook = () => { throw new Error('storage unavailable'); };
assert.equal(await returnCoverageEnabled(), false);
assert.equal(await sendScanTelemetry(report), false);
getHook = null;

const schema = readFileSync(new URL('./licence-worker/schema.sql', import.meta.url), 'utf8');
const db = new DatabaseSync(':memory:');
db.exec(schema);
db.exec(schema); // Additive migration is safe to reapply.
db.exec("INSERT INTO scan_outcomes_daily VALUES ('2026-08-29','0.30.0','popup','success','1','<5s',5,'legacy')");
const writes = [];
let failBatch = false;
const env = { DB: {
  prepare(sql) { return { bind(...args) { return { sql, args }; } }; },
  async batch(statements) {
    db.exec('BEGIN');
    try {
      for (const [index, s] of statements.entries()) {
        if (failBatch && index === 1) throw new Error('injected write failure');
        db.prepare(s.sql.replace(/\?\d+/g, '?')).run(...s.args);
      }
      db.exec('COMMIT');
      writes.push(...statements);
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    return statements.map(() => ({ success: true }));
  },
} };
const event = { version: '0.35.0', surface: 'sidepanel', outcome: 'success',
  positionBucket: '2-5', durationBucket: '60s+', errors: [],
  lpReturns: { counts: { available: 1, additions_unpriced: 1 },
    priceCauses: { 'reference-price-unavailable': 1 } },
};
assert.deepEqual(telemetryEvent({ ...event, key: 'x' }), event);
assert.throws(() => telemetryEvent({ ...event, positionBucket: '1' }), /count does not match/);
assert.throws(() => telemetryEvent({ ...event, cohort: 'tester' }), /unsupported telemetry field/);
assert.throws(() => telemetryEvent({ ...event, lpReturns: null }), /invalid LP-return/);
assert.equal(telemetryCohort({ label: 'owner-primary' }), 'internal');
assert.equal(telemetryCohort({ label: 'cws-reviewer' }), 'internal');
assert.equal(telemetryCohort({ label: 'beta-999' }), 'tester');
assert.equal(telemetryCohort({ label: 'unrecognised-role' }), 'unclassified');
assert.equal(telemetryCohort(null), 'unclassified');
const testHashes = [];
async function post(label, body = event, expires = '2099-12-31') {
  const key = `quality-unit-${label}`, hash = await sha256Hex(key);
  KEYS[hash] = { label, expires };
  testHashes.push(hash);
  return worker.fetch(new Request('https://unit.invalid/telemetry', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, key }),
  }), env);
}
for (const label of ['beta-999', 'beta-999', 'owner-primary', 'cws-reviewer', 'unit']) {
  assert.equal((await post(label)).status, 200);
}
const scalar = (sql) => Object.values(db.prepare(sql).get())[0];
assert.equal(scalar("SELECT SUM(scans) FROM scan_outcomes_v2_daily WHERE cohort='tester'"), 2);
assert.equal(scalar("SELECT SUM(scans) FROM scan_outcomes_v2_daily WHERE cohort='internal'"), 2);
assert.equal(scalar("SELECT SUM(positions) FROM lp_return_coverage_daily WHERE cohort='tester' AND metric='availability'"), 4);
assert.equal(scalar("SELECT SUM(positions) FROM lp_return_coverage_daily WHERE cohort='tester' AND metric='availability' AND code='available'"), 2);
assert.equal(scalar("SELECT SUM(positions) FROM lp_return_coverage_daily WHERE cohort='tester' AND metric='price_cause'"), 2);
const { lpReturns: _unused, ...legacyEvent } = event;
assert.equal((await post('beta-999', legacyEvent)).status, 200, 'old clients remain supported');
assert.equal(scalar("SELECT SUM(scans) FROM scan_outcomes_v2_daily WHERE cohort='tester' AND coverage_reported=0"), 1);
assert.equal((await post('beta-999', { ...event, outcome: 'empty', positionBucket: '0',
  lpReturns: { counts: {}, priceCauses: {} } })).status, 200);
assert.equal((await post('beta-999', { ...event, errors: [{ chain: 'base', code: 'history', count: 1 }] })).status, 200);
assert.equal(scalar("SELECT SUM(occurrences) FROM scan_errors_v2_daily WHERE cohort='tester'"), 1);
assert.equal(scalar('SELECT SUM(scans) FROM scan_outcomes_daily'), 5, 'legacy rows stay untouched');
assert.equal(scalar('SELECT COUNT(*) FROM installations'), 0, 'telemetry never tracks installations');
assert.equal(scalar('SELECT COUNT(*) FROM relay_usage_daily'), 0, 'telemetry spends no relay quota');
const before = scalar('SELECT SUM(scans) FROM scan_outcomes_v2_daily');
// The operator's read-only report must exclude internal and legacy traffic.
const reportSql = readFileSync(new URL('./licence-worker/scan-quality-report.sql', import.meta.url), 'utf8');
const reportQueries = reportSql.replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean);
assert.equal(reportQueries.length, 4);
for (const query of reportQueries) {
  assert.match(query, /^SELECT/i);
  assert.match(query, /WHERE cohort = 'tester'/);
  db.prepare(query).all();
}
const coverageRow = db.prepare(reportQueries[1]).get();
assert.equal(coverageRow.observed_positions, 6);
assert.equal(coverageRow.return_available, 3);
assert.equal(coverageRow.return_missing, 3);
assert.equal(coverageRow.available_percent, 50);
assert.equal((await post('expired-unit', event, '2000-01-01')).status, 403);
assert.equal((await post('beta-999', { ...event, cohort: 'internal' })).status, 400);
failBatch = true;
assert.equal((await post('beta-999')).status, 503);
assert.equal(scalar('SELECT SUM(scans) FROM scan_outcomes_v2_daily'), before, 'failed event rolls back');
assert.ok(writes.every(({ sql, args }) => !/licence_hash|installation_hash|last_at/.test(sql)
  && !args.some((v) => testHashes.includes(v) || String(v).startsWith('quality-unit-')
    || ['beta-999', 'owner-primary', 'cws-reviewer'].includes(v))));
for (const hash of testHashes) delete KEYS[hash];
db.close();
console.log('scan quality: coverage, privacy, opt-in/revocation, role isolation, legacy compatibility, SQLite migration and atomic writes pass');
