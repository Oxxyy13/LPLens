// Synthetic UI/accounting boundary fixture, never a tester's wallet or position.
export const OWNER = '0x' + '11'.repeat(20);
export const POSITION = {
  protocol: 'Smart LP', status: 'below', fee: 10000,
  price: 2, priceLower: 3, priceUpper: 5,
  amount0: 30, amount1: 10, collectable0: 1, collectable1: 0,
  token0Meta: { symbol: 'EXAMPLE' }, token1Meta: { symbol: 'WETH' },
  ownerAddress: OWNER, privateSentinel: 'do-not-forward',
  vault: { address: '0x' + '22'.repeat(20), positionId: '12345',
    strategy: 'Balanced band', sharePercent: 0.22847995, lastRecenterAt: 1788968381,
    perfFeeBps: 1000, withdrawFeeBps: 10, valueUnavailable: null },
  history: { source: 'vault-receipts', deposited0: 40, deposited1: 5,
    received0: 0, received1: 0, vsHodl: { pct: 5, delta: 4 },
    deposits: [{ transactionHash: 'do-not-forward' }] },
  usd: { totalNow: 82, value: 80, collectable: 2, price0: 2, price1: 2,
    grossAdded: 100, grossAddedExact: true, collectedProceeds: 0,
    collectedProceedsExact: true, netCashIn: 100,
    pnl: -18, pnlPct: -18, vsHodl: 4, returnUnavailable: null },
};
