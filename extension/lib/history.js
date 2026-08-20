/**
 * Position lifetime history, reconstructed from NonfungiblePositionManager
 * events. This is what the README called "deliberately not implemented" —
 * it needed an events source, and this is that source.
 *
 * The feature rests on one property of Uniswap v3: `tokenId` is the FIRST
 * INDEXED parameter of IncreaseLiquidity, DecreaseLiquidity and Collect, so it
 * lands in topic1. A single `eth_getLogs` filtered on `[null, tokenId]`
 * therefore returns one position's entire lifetime in ONE request — no
 * subgraph, no address scanning, no block-range walking, no API key.
 *
 * Topic hashes were derived with keccak256 (`eth_utils`) and then cross-checked
 * against a live log, not recalled. See docs/build-notes.md.
 */
import { fetchPositionLogs } from './logs.js';
import { sqrtRatioAtTick } from './v3.js';

export const TOPIC = {
  increase: '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f',
  decrease: '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4',
  collect:  '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01',
};

const word = (data, i) => BigInt('0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64));

/**
 * Every lifetime event for one position. Source selection and all endpoint
 * quirks live in logs.js; this only decodes.
 */
export async function fetchHistory(source, nfpm, tokenId) {
  const got = await fetchPositionLogs({ ...source, nfpm, tokenId });
  if (got.unavailable) return { unavailable: got.unavailable };

  const events = [];
  for (const log of got.logs) {
    const t0 = (log.topics[0] || '').toLowerCase();
    const kind = t0 === TOPIC.increase ? 'increase'
      : t0 === TOPIC.decrease ? 'decrease'
      : t0 === TOPIC.collect ? 'collect' : null;
    if (!kind) continue;
    // increase/decrease: [liquidity, amount0, amount1]
    // collect:           [recipient, amount0, amount1]
    events.push({
      kind,
      block: log.block,
      time: log.time,
      liquidity: kind === 'collect' ? 0n : word(log.data, 0),
      amount0: word(log.data, 1),
      amount1: word(log.data, 2),
    });
  }
  events.sort((a, b) => a.block - b.block);
  return { events, source: got.source };
}

/**
 * Integrity check: the event set must explain the on-chain liquidity.
 *
 * Summing IncreaseLiquidity minus DecreaseLiquidity across a position's whole
 * life must land exactly on the `liquidity` that `positions()` reports right
 * now. If it does not, the event set is incomplete and every number derived
 * from it — entry price, deposited totals, fees, vs-HODL — is wrong.
 *
 * This is not theoretical. Etherscan returns at most 1000 records per query, so
 * a heavily-traded position truncates silently. It also catches a provider
 * returning a partial range, and it is the backstop for a fingerprint collision
 * in the history cache.
 *
 * Cheap: pure arithmetic over data already in hand, no extra request.
 */
export function reconciles(events, onChainLiquidity) {
  let net = 0n;
  for (const e of events) {
    if (e.kind === 'increase') net += e.liquidity;
    else if (e.kind === 'decrease') net -= e.liquidity;
  }
  return net === onChainLiquidity;
}

/**
 * Solve for the pool price at the moment liquidity moved, from the event
 * amounts and the position's range alone. No archive node required.
 *
 *   amount1 = L(√P − √Pa)      →  √P = √Pa + amount1/L
 *   amount0 = L(1/√P − 1/√Pb)  →  √P = 1/(1/√Pb + amount0/L)
 *
 * Both must produce the same √P, which makes the pair a self-check rather than
 * a single unverified number. Verified 2026-08-18 across six Robinhood Chain
 * positions: agreement to 0.000000%.
 *
 * A single-sided mint is genuinely underdetermined — all of token0 means only
 * "price was at or below the lower bound". That returns a bound, not a price.
 */
export function solveSqrtPrice({ liquidity, amount0, amount1, tickLower, tickUpper }) {
  const L = Number(liquidity);
  const a0 = Number(amount0), a1 = Number(amount1);
  if (!L) return null;
  const sqrtA = sqrtRatioAtTick(tickLower), sqrtB = sqrtRatioAtTick(tickUpper);

  if (a0 === 0 && a1 === 0) return null;
  if (a0 === 0) return { sqrtP: sqrtB, exact: false, bound: 'at or above' };
  if (a1 === 0) return { sqrtP: sqrtA, exact: false, bound: 'at or below' };

  const fromAmount1 = sqrtA + a1 / L;
  const fromAmount0 = 1 / (1 / sqrtB + a0 / L);
  const spread = Math.abs(fromAmount1 - fromAmount0) / fromAmount1;
  return {
    sqrtP: (fromAmount1 + fromAmount0) / 2,
    exact: true,
    // Surfaced so a disagreement can never hide inside an average.
    spread,
  };
}

/**
 * Token-denominated lifetime accounting.
 *
 * The subtlety that makes naive versions of this wrong: in the NFPM,
 * `decreaseLiquidity` does NOT pay anything out — it burns liquidity and
 * credits `tokensOwed`. Only `collect` actually transfers tokens to the owner,
 * and it transfers fees AND that credited principal together. So the tokens
 * you really received are the Collect totals alone; adding Decrease totals to
 * them double-counts the principal.
 */
export function accounting(events) {
  const sum = (kind) => events.filter((e) => e.kind === kind).reduce(
    (acc, e) => ({ a0: acc.a0 + e.amount0, a1: acc.a1 + e.amount1 }),
    { a0: 0n, a1: 0n });

  const dep = sum('increase');   // tokens put in
  const dec = sum('decrease');   // principal moved to tokensOwed, NOT paid out
  const col = sum('collect');    // the only real payout: fees + that principal

  return {
    deposited0: dep.a0, deposited1: dep.a1,
    withdrawn0: dec.a0, withdrawn1: dec.a1,
    received0: col.a0, received1: col.a1,
    // Collect minus the principal it returned = the fee component.
    fees0: col.a0 > dec.a0 ? col.a0 - dec.a0 : 0n,
    fees1: col.a1 > dec.a1 ? col.a1 - dec.a1 : 0n,
    adds: events.filter((e) => e.kind === 'increase').length,
    firstBlock: events.length ? events[0].block : null,
    lastBlock: events.length ? events[events.length - 1].block : null,
    // Only Etherscan supplies timestamps; the JSON-RPC path leaves these null
    // rather than inventing a date from a block number.
    firstTime: events.length ? events[0].time : null,
    lastTime: events.length ? events[events.length - 1].time : null,
  };
}
