/**
 * Honest multi-position totals.
 *
 * An aggregate is the easiest place in this product to silently lie. An
 * unpriced position treated as $0 under-reports and looks authoritative
 * doing it — the same defect as rendering $0 instead of an em-dash, one
 * level up. vs-holding and total return stay separate: they answer
 * different questions and collapsing them is the error this project exists
 * to avoid. Summing USD is legitimate only because both halves already
 * share one price source; nothing here multiplies a historical quantity
 * by today's price.
 *
 * A single-sided mint (cost basis is a bound, not a point) is excluded
 * from total return rather than summed as if it were exact.
 */

function money(n, signed) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  const abs = Math.abs(n);
  const digits = abs !== 0 && abs < 100 ? 2 : 0;
  const body = '$' + abs.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  if (!signed) return body;
  if (n > 0) return '+' + body;
  if (n < 0) return '−' + body;
  return body;
}

function reasonsText(reasons) {
  const bits = [];
  if (reasons.unpriced) bits.push(`${reasons.unpriced} unpriced`);
  if (reasons.history) bits.push(`${reasons.history} history unavailable`);
  if (reasons.bound) bits.push(`${reasons.bound} bound`);
  return bits.join(', ');
}

/**
 * Classify one position for each total. Never coerces missing data to zero.
 */
export function classifyPosition(p) {
  const h = (p && p.history) || {};
  const u = p && p.usd;
  const histGone = !!(h && h.unavailable);

  const value = u && (u.totalNow !== null && u.totalNow !== undefined
    ? u.totalNow
    : u.value);
  const hasValue = value !== null && value !== undefined && isFinite(value);
  const hasVs = !!(u && u.vsHodl !== null && u.vsHodl !== undefined && isFinite(u.vsHodl));
  const hasPnl = !!(u && u.pnl !== null && u.pnl !== undefined && isFinite(u.pnl));
  const bound = !!(hasPnl && u.costBasisExact === false);

  return {
    histGone,
    hasValue,
    value: hasValue ? value : null,
    hasVs: hasVs && !histGone,
    vsHodl: hasVs ? u.vsHodl : null,
    bound,
    hasPnl: hasPnl && !histGone && !bound,
    pnl: hasPnl && !bound ? u.pnl : null,
  };
}

function bucketLine(name, bucket, n, signed) {
  if (!n) return `${name} —`;
  const shown = bucket.included ? money(bucket.sum, signed) : '—';
  if (!bucket.excluded) return `${name} ${shown} · all ${n} positions`;
  return `${name} ${shown} · totals exclude ${bucket.excluded} of ${n} positions (${reasonsText(bucket.reasons)})`;
}

export function summarizeAggregate(positions) {
  const list = Array.isArray(positions) ? positions : [];
  const n = list.length;
  const emptyReasons = () => ({ unpriced: 0, history: 0, bound: 0 });
  const value = { sum: 0, included: 0, excluded: 0, reasons: emptyReasons() };
  const vsHold = { sum: 0, included: 0, excluded: 0, reasons: emptyReasons() };
  const totalReturn = { sum: 0, included: 0, excluded: 0, reasons: emptyReasons() };

  for (const p of list) {
    const c = classifyPosition(p);

    if (c.hasValue) { value.sum += c.value; value.included++; }
    else { value.excluded++; value.reasons.unpriced++; }

    if (c.histGone) { vsHold.excluded++; vsHold.reasons.history++; }
    else if (c.hasVs) { vsHold.sum += c.vsHodl; vsHold.included++; }
    else { vsHold.excluded++; vsHold.reasons.unpriced++; }

    if (c.histGone) { totalReturn.excluded++; totalReturn.reasons.history++; }
    else if (c.bound) { totalReturn.excluded++; totalReturn.reasons.bound++; }
    else if (c.hasPnl) { totalReturn.sum += c.pnl; totalReturn.included++; }
    else { totalReturn.excluded++; totalReturn.reasons.unpriced++; }
  }

  return {
    n,
    value,
    vsHold,
    totalReturn,
    vsLine: bucketLine('vs holding', vsHold, n, true),
    returnLine: bucketLine('total return', totalReturn, n, true),
    valueLine: bucketLine('now', value, n, false),
  };
}
