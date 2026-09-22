// Explicit display boundary. Never forward raw receipts, owners, endpoints,
// credentials, or provider errors to the content script.
const number = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const uint = (v) => {
  const s = String(v ?? '');
  return /^(0|[1-9][0-9]{0,77})$/.test(s) && BigInt(s) < 2n ** 256n ? s : null;
};
const symbol = (v) => String(v || '?').trim().slice(0, 24) || '?';
const reason = (v) => [
  'gross additions unpriced', 'gross additions are bounded',
  'collected proceeds unpriced', 'collected proceeds are bounded',
  'current collectable unavailable',
].includes(v) ? v : v ? 'Historical USD return unavailable' : null;

export function smartLpDisplayPosition(p) {
  const vault = p?.vault;
  if (!vault || !/^0x[0-9a-f]{40}$/i.test(vault.address || '')
      || !['in-range', 'below', 'above', 'idle'].includes(p.status)) return null;
  const h = p.history || {}, u = p.usd || {};
  const proven = h.source === 'vault-receipts' && !h.unavailable;
  const complete = !vault.valueUnavailable && !u.currentValueIncomplete
    && number(p.collectable0) !== null && number(p.collectable1) !== null;
  const lifetime = proven && complete;
  const hasPnl = lifetime && number(u.pnl) !== null && number(u.pnlPct) !== null;
  const hasVs = lifetime && !h.vsHodlUnavailable && number(h.vsHodl?.pct) !== null;
  return {
    protocol: 'Smart LP', status: p.status, fee: number(p.fee),
    price: number(p.price), priceLower: number(p.priceLower), priceUpper: number(p.priceUpper),
    amount0: number(p.amount0), amount1: number(p.amount1),
    collectable0: complete ? number(p.collectable0) : null,
    collectable1: complete ? number(p.collectable1) : null,
    token0Meta: { symbol: symbol(p.token0Meta?.symbol) },
    token1Meta: { symbol: symbol(p.token1Meta?.symbol) },
    vault: {
      address: vault.address.toLowerCase(), positionId: uint(vault.positionId),
      strategy: ['Full range', 'Balanced band', 'Single-sided ask'].includes(vault.strategy)
        ? vault.strategy : 'Managed range',
      sharePercent: number(vault.sharePercent),
      lastRecenterAt: Number.isSafeInteger(vault.lastRecenterAt) && vault.lastRecenterAt > 0
        && vault.lastRecenterAt <= 8_640_000_000_000 ? vault.lastRecenterAt : null,
      perfFeeBps: number(vault.perfFeeBps), withdrawFeeBps: number(vault.withdrawFeeBps),
      valueUnavailable: complete ? null : 'Current vault assets or pending fees are incomplete.',
    },
    history: {
      unavailable: proven ? null : 'Verified vault deposit and withdrawal history is unavailable.',
      currentUnavailable: !complete,
      deposited0: proven ? number(h.deposited0) : null,
      deposited1: proven ? number(h.deposited1) : null,
      received0: proven ? number(h.received0) : null,
      received1: proven ? number(h.received1) : null,
      vsHodl: hasVs ? { pct: number(h.vsHodl.pct) } : null,
      vsHodlUnavailable: h.vsHodlUnavailable
        ? 'Holding comparison after withdrawals is not supported yet' : null,
    },
    usd: {
      totalNow: complete ? number(u.totalNow) : null,
      value: number(u.value), collectable: complete ? number(u.collectable) : null,
      currentValueIncomplete: !complete,
      price0: number(u.price0), price1: number(u.price1), bridged: u.bridged === true,
      grossAdded: proven ? number(u.grossAdded) : null,
      grossAddedExact: proven && u.grossAddedExact === true,
      collectedProceeds: proven ? number(u.collectedProceeds) : null,
      collectedProceedsExact: proven && u.collectedProceedsExact === true,
      netCashIn: proven ? number(u.netCashIn) : null,
      pnl: hasPnl ? u.pnl : null, pnlPct: hasPnl ? u.pnlPct : null,
      vsHodl: hasVs ? number(u.vsHodl) : null,
      returnUnavailable: complete ? reason(u.returnUnavailable) : 'Current vault value incomplete',
    },
  };
}
