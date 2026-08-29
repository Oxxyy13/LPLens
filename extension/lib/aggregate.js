/**
 * Honest multi-position totals.
 *
 * An aggregate is the easiest place in this product to silently lie. An
 * unpriced position treated as $0 under-reports and looks authoritative
 * doing it — the same defect as rendering $0 instead of an em-dash, one
 * level up. vs-holding and LP return stay separate: they answer
 * different questions and collapsing them is the error this project exists
 * to avoid. Summing USD is legitimate only because both halves already
 * share one price source; additions and collections are already valued at
 * their event blocks, while current value is only what remains in the LP.
 *
 * A single-sided flow (gross additions or proceeds are bounded) is excluded
 * from LP return rather than summed as if it were exact.
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

function positionWord(n) {
  return n === 1 ? 'position' : 'positions';
}

function addReturnUnavailableReason(reasons, reason) {
  const clean = String(reason || '').trim();
  if (!clean) return;
  const existing = reasons.returnUnavailable.find((entry) => entry.reason === clean);
  if (existing) existing.count++;
  else reasons.returnUnavailable.push({ reason: clean, count: 1 });
}

/**
 * Structured presentation state for a single aggregate metric.
 *
 * Callers should use `state`, not the formatted value, to distinguish a true
 * zero from unavailable data. `tone` deliberately follows the numeric sum and
 * remains neutral for current position value, zero, or an unavailable metric.
 */
function metricDisplay(bucket, n, signed) {
  const state = bucket.included === 0
    ? 'unavailable'
    : bucket.excluded > 0 ? 'partial' : 'complete';
  const value = bucket.included ? money(bucket.sum, signed) : 'Unavailable';
  const tone = state !== 'complete' || !signed || bucket.included === 0 || bucket.sum === 0
    ? 'muted'
    : bucket.sum > 0 ? 'up' : 'down';
  const coverage = !n
    ? 'no positions'
    : state === 'complete'
      ? `${n} ${positionWord(n)}`
      : state === 'partial'
        ? `${bucket.included} of ${n} ${positionWord(n)} included`
        : `0 of ${n} ${positionWord(n)} available`;

  return {
    state,
    value,
    tone,
    coverage,
    included: bucket.included,
    excluded: bucket.excluded,
    total: n,
    returnUnavailable: bucket.reasons.returnUnavailable.map((entry) => ({ ...entry })),
  };
}

const RETURN_REASON_LABELS = new Map([
  ['gross additions unpriced', 'entry deposits could not be priced'],
  ['gross additions are bounded', 'one-sided entry deposits are only bounded'],
  ['collected proceeds unpriced', 'collected proceeds could not be priced'],
  ['collected proceeds are bounded', 'collected proceeds are only bounded'],
  ['current collectable unavailable', 'current collectable amounts are unavailable'],
]);

/** Complete, non-overlapping explanation for an excluded aggregate bucket. */
export function aggregateReasonText(bucket) {
  const reasons = (bucket && bucket.reasons) || {};
  const exact = (bucket && bucket.display && bucket.display.returnUnavailable) || [];
  const bits = [];
  if (reasons.history) {
    bits.push(reasons.history === 1
      ? 'lifetime history is unavailable for 1 position'
      : `lifetime history is unavailable for ${reasons.history} positions`);
  }

  let exactUnpriced = 0;
  let exactBound = 0;
  for (const { reason, count } of exact) {
    const n = Number.isInteger(count) && count > 0 ? count : 1;
    const label = RETURN_REASON_LABELS.get(reason) || String(reason || 'return data is unavailable');
    bits.push(n > 1 ? `${label} for ${n} positions` : label);
    if (/bound/i.test(String(reason))) exactBound += n;
    else exactUnpriced += n;
  }

  const otherBound = Math.max(0, (Number(reasons.bound) || 0) - exactBound);
  const otherUnpriced = Math.max(0, (Number(reasons.unpriced) || 0) - exactUnpriced);
  if (otherBound) {
    const hasPrior = bits.length > 0;
    bits.push(otherBound === 1
      ? `${hasPrior ? 'another' : '1'} position has only bounded cash flows`
      : `${otherBound} other positions have only bounded cash flows`);
  }
  if (otherUnpriced) {
    const hasPrior = bits.length > 0;
    bits.push(otherUnpriced === 1
      ? `${hasPrior ? 'another' : '1'} position could not be priced`
      : `${otherUnpriced} other positions could not be priced`);
  }
  return bits.join('; ');
}

/**
 * Classify one position for each total. Never coerces missing data to zero.
 */
export function classifyPosition(p) {
  const h = (p && p.history) || {};
  const u = p && p.usd;
  const histGone = !!(h && h.unavailable);

  const value = u && (u.currentValue !== null && u.currentValue !== undefined
    ? u.currentValue
    : u.totalNow !== null && u.totalNow !== undefined ? u.totalNow : u.value);
  const hasValue = value !== null && value !== undefined && isFinite(value);
  const hasVs = !!(u && u.vsHodl !== null && u.vsHodl !== undefined && isFinite(u.vsHodl));
  const hasPnl = !!(u && u.pnl !== null && u.pnl !== undefined && isFinite(u.pnl));
  const bound = !!(u && (u.grossAddedExact === false
    || u.collectedProceedsExact === false
    || u.costBasisExact === false));
  const returnUnavailable = String(u && u.returnUnavailable || '').trim() || null;

  return {
    histGone,
    hasValue,
    value: hasValue ? value : null,
    hasVs: hasVs && !histGone,
    vsHodl: hasVs ? u.vsHodl : null,
    bound,
    hasPnl: hasPnl && !histGone && !bound,
    pnl: hasPnl && !bound ? u.pnl : null,
    returnUnavailable,
  };
}

function bucketLine(name, bucket, n, signed) {
  if (!n) return `${name} —`;
  const shown = bucket.included ? money(bucket.sum, signed) : '—';
  if (!bucket.excluded) {
    const coverage = n === 1 ? '1 position' : `all ${n} positions`;
    return `${name} ${shown} · ${coverage}`;
  }
  return `${name} ${shown} · totals exclude ${bucket.excluded} of ${n} ${positionWord(n)} (${reasonsText(bucket.reasons)})`;
}

export function summarizeAggregate(positions) {
  const list = Array.isArray(positions) ? positions : [];
  const n = list.length;
  const emptyReasons = () => ({
    unpriced: 0,
    history: 0,
    bound: 0,
    returnUnavailable: [],
  });
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
    else if (c.bound) {
      totalReturn.excluded++;
      totalReturn.reasons.bound++;
      addReturnUnavailableReason(totalReturn.reasons, c.returnUnavailable);
    }
    else if (c.hasPnl) { totalReturn.sum += c.pnl; totalReturn.included++; }
    else {
      totalReturn.excluded++;
      totalReturn.reasons.unpriced++;
      addReturnUnavailableReason(totalReturn.reasons, c.returnUnavailable);
    }
  }

  value.display = metricDisplay(value, n, false);
  vsHold.display = metricDisplay(vsHold, n, true);
  totalReturn.display = metricDisplay(totalReturn, n, true);

  return {
    n,
    value,
    vsHold,
    totalReturn,
    vsLine: bucketLine('vs holding', vsHold, n, true),
    returnLine: bucketLine('LP return', totalReturn, n, true),
    valueLine: bucketLine('in positions', value, n, false),
  };
}
