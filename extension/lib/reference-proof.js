/** Fixed public reference market and closed, independently checked proof shape. */
export const ETH_REFERENCE = Object.freeze({
  chainId: '1',
  pool: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
  token0: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  token1: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  topic: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
  maxLookback: 4096,
});
const HASH = /^0x[0-9a-f]{64}$/;
const integer = (v) => Number.isSafeInteger(v) && v > 0;
const fields = (o, names) => !!o && typeof o === 'object' && !Array.isArray(o)
  && Object.keys(o).length === names.length && names.every((n) => Object.hasOwn(o, n));

export function referenceQuery(query) {
  if (fields(query, ['block']) && integer(query.block) && query.block <= 1_000_000_000) {
    return { block: query.block };
  }
  if (fields(query, ['timestamp']) && integer(query.timestamp)
      && query.timestamp >= 1_600_000_000 && query.timestamp <= 10_000_000_000) {
    return { timestamp: query.timestamp };
  }
  return null;
}

/** Decode only header facts. Never retain a provider's full block or error. */
export function referenceHeader(raw, expected) {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const parse = (v) => {
      if (typeof v !== 'string' || !/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(v)) return NaN;
      return Number(BigInt(v));
    };
    const number = parse(raw.number), timestamp = parse(raw.timestamp);
    const hash = typeof raw.hash === 'string' ? raw.hash.toLowerCase() : '';
    const parentHash = typeof raw.parentHash === 'string' ? raw.parentHash.toLowerCase() : '';
    if (!integer(number) || number !== expected || !integer(timestamp)
        || !HASH.test(hash) || !HASH.test(parentHash)) return null;
    return { number, hash, parentHash, timestamp };
  } catch { return null; }
}

function validHeader(h) {
  return fields(h, ['number', 'hash', 'parentHash', 'timestamp']) && integer(h.number)
    && integer(h.timestamp) && HASH.test(h.hash) && HASH.test(h.parentHash);
}

/**
 * Recompute dollars from an allowlisted Swap, never trust a returned float.
 * This is provider-backed evidence, not a cryptographic receipt inclusion proof.
 */
export function referenceProofPrice(proof, query) {
  try {
    if (!referenceQuery(query)
        || !fields(proof, ['v', 'chainId', 'pool', 'block', 'nextBlock', 'swapBlock', 'swap'])
        || proof.v !== 1 || proof.chainId !== ETH_REFERENCE.chainId
        || proof.pool !== ETH_REFERENCE.pool || !validHeader(proof.block)
        || !validHeader(proof.swapBlock)) return null;
    const { block, nextBlock, swapBlock, swap } = proof;
    if (query.block !== undefined) {
      if (block.number !== query.block || nextBlock !== null) return null;
    } else if (!validHeader(nextBlock) || nextBlock.number !== block.number + 1
        || nextBlock.parentHash !== block.hash || !(block.timestamp <= query.timestamp)
        || !(query.timestamp < nextBlock.timestamp)) return null;
    if (swapBlock.number > block.number
        || swapBlock.number < Math.max(1, block.number - ETH_REFERENCE.maxLookback + 1)
        || swapBlock.timestamp > block.timestamp
        || (swapBlock.number === block.number && swapBlock.hash !== block.hash)
        || !fields(swap, ['blockNumber', 'blockHash', 'logIndex', 'transactionHash', 'sqrtPriceX96'])
        || swap.blockNumber !== swapBlock.number || swap.blockHash !== swapBlock.hash
        || !Number.isSafeInteger(swap.logIndex) || swap.logIndex < 0
        || !HASH.test(swap.transactionHash)
        || typeof swap.sqrtPriceX96 !== 'string'
        || !/^[1-9][0-9]{0,48}$/.test(swap.sqrtPriceX96)) return null;
    const sqrt = BigInt(swap.sqrtPriceX96);
    if (sqrt <= 4_295_128_739n || sqrt >= 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n) return null;
    const ratio = Number(sqrt) / 2 ** 96;
    const price = 1e12 / (ratio * ratio); // USDC is token0 (6dp), WETH token1 (18dp).
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch { return null; }
}
