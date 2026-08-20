/**
 * Uniswap v3 position math.
 *
 * DISPLAY-GRADE, NOT CONSENSUS-GRADE. Tick ratios are computed as
 * 1.0001^(tick/2) in IEEE-754 doubles instead of the exact integer TickMath
 * used on-chain. Relative error is ~1e-16, which is invisible on a readout and
 * unacceptable for anything that produces calldata. If this code ever feeds a
 * transaction, swap in @uniswap/v3-sdk TickMath first.
 */
const Q96 = 2 ** 96;

export const sqrtRatioAtTick = (tick) => Math.pow(1.0001, tick / 2);

export const sqrtPriceFromX96 = (sqrtPriceX96) => Number(sqrtPriceX96) / Q96;

/**
 * Token amounts currently held by the position.
 * Returns raw (undecimalised) float amounts.
 */
export function positionAmounts({ liquidity, tickLower, tickUpper, sqrtPriceX96 }) {
  const L = Number(liquidity);
  const sqrtA = sqrtRatioAtTick(tickLower);
  const sqrtB = sqrtRatioAtTick(tickUpper);
  const sqrtP = sqrtPriceFromX96(sqrtPriceX96);

  if (L === 0) return { amount0: 0, amount1: 0, status: 'closed' };

  if (sqrtP <= sqrtA) {
    // Price below range: entirely token0.
    return { amount0: L * (sqrtB - sqrtA) / (sqrtA * sqrtB), amount1: 0, status: 'below' };
  }
  if (sqrtP >= sqrtB) {
    // Price above range: entirely token1.
    return { amount0: 0, amount1: L * (sqrtB - sqrtA), status: 'above' };
  }
  return {
    amount0: L * (sqrtB - sqrtP) / (sqrtP * sqrtB),
    amount1: L * (sqrtP - sqrtA),
    status: 'in-range',
  };
}

/** Price of 1 token0 expressed in token1, decimal-adjusted. */
export function humanPrice(sqrtPriceX96, dec0, dec1) {
  const sqrtP = sqrtPriceFromX96(sqrtPriceX96);
  return sqrtP * sqrtP * Math.pow(10, dec0 - dec1);
}

export const scale = (raw, decimals) => raw / Math.pow(10, decimals);

export const tickToPrice = (tick, dec0, dec1) =>
  Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
