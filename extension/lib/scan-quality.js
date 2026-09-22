/** Closed, amount-free LP-return coverage. Shared with the Worker validator. */
export const MAX_QUALITY_POSITIONS = 1000;
export const RETURN_COVERAGE_CODES = Object.freeze([
  'available', 'history_unavailable', 'additions_unpriced', 'proceeds_unpriced',
  'bounded_cash_flows', 'current_value_unavailable', 'unpriced',
  'position_unreadable', 'unknown',
]);
export const PRICE_CAUSE_CODES = Object.freeze([
  'reference-pool-unavailable', 'reference-price-unavailable',
  'reference-time-unavailable', 'pool-price-unavailable', 'unsupported-pair',
]);
const coverageCodes = new Set(RETURN_COVERAGE_CODES);
const priceCodes = new Set(PRICE_CAUSE_CODES);
const reasonCodes = new Map([
  ['gross additions unpriced', 'additions_unpriced'],
  ['collected proceeds unpriced', 'proceeds_unpriced'],
  ['gross additions are bounded', 'bounded_cash_flows'],
  ['collected proceeds are bounded', 'bounded_cash_flows'],
  ['current collectable unavailable', 'current_value_unavailable'],
  ['Current vault value incomplete', 'current_value_unavailable'],
]);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function returnCode(p) {
  if (!object(p)) return 'unknown';
  if (p.error) return 'position_unreadable';
  if (p.history?.unavailable) return 'history_unavailable';
  const u = p.usd;
  if (!object(u)) return 'unpriced';
  if (u.grossAddedExact === false || u.costBasisExact === false
      || u.collectedProceedsExact === false) return 'bounded_cash_flows';
  if (u.currentValueIncomplete) return 'current_value_unavailable';
  if (u.returnUnavailable) return reasonCodes.get(u.returnUnavailable) || 'unknown';
  return typeof u.pnl === 'number' && Number.isFinite(u.pnl) ? 'available' : 'unknown';
}

/** One primary status per returned position, not per unique LP or wallet. */
export function buildReturnCoverage(positions) {
  // Never sample/truncate and accidentally claim complete coverage.
  if (!Array.isArray(positions) || positions.length > MAX_QUALITY_POSITIONS) return null;
  const counts = {}, priceCauses = {};
  for (const p of positions) {
    const code = returnCode(p);
    counts[code] = (counts[code] || 0) + 1;
    if (!['additions_unpriced', 'proceeds_unpriced', 'current_value_unavailable'].includes(code)) continue;
    const causes = p?.usd?.returnUnavailableReasons;
    if (!Array.isArray(causes)) continue;
    for (const cause of new Set(causes)) {
      if (priceCodes.has(cause)) priceCauses[cause] = (priceCauses[cause] || 0) + 1;
    }
  }
  return { counts, priceCauses };
}

/** Strictly copy allowlisted counters; never spread caller-supplied objects. */
export function validateReturnCoverage(value) {
  if (!object(value) || Object.keys(value).length !== 2
      || !Object.hasOwn(value, 'counts') || !Object.hasOwn(value, 'priceCauses')) {
    throw new Error('invalid LP-return coverage');
  }
  const copy = (rows, allowed) => {
    if (!object(rows)) throw new Error('invalid LP-return counters');
    const clean = {};
    for (const [code, count] of Object.entries(rows)) {
      if (!allowed.has(code) || !Number.isInteger(count) || count < 1
          || count > MAX_QUALITY_POSITIONS) throw new Error('invalid LP-return counter');
      clean[code] = count;
    }
    return clean;
  };
  const counts = copy(value.counts, coverageCodes);
  const priceCauses = copy(value.priceCauses, priceCodes);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const priceMissing = ['additions_unpriced', 'proceeds_unpriced', 'current_value_unavailable']
    .reduce((n, code) => n + (counts[code] || 0), 0);
  if (total > MAX_QUALITY_POSITIONS || Object.values(priceCauses).some((n) => n > priceMissing)) {
    throw new Error('inconsistent LP-return counters');
  }
  return { counts, priceCauses };
}
