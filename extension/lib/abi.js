// Minimal hand-rolled ABI encode/decode. Every selector below was verified with
// keccak256 rather than recalled; see docs/build-notes.md.
export const SELECTOR = {
  balanceOf: '0x70a08231',            // balanceOf(address)
  tokenOfOwnerByIndex: '0x2f745c59',  // tokenOfOwnerByIndex(address,uint256)
  positions: '0x99fbab88',            // positions(uint256)
  slot0: '0x3850c7bd',                // slot0()
  getPool: '0x1698ee82',              // getPool(address,address,uint24)
  symbol: '0x95d89b41',               // symbol()
  decimals: '0x313ce567',             // decimals()
  collect: '0xfc6f7865',              // collect((uint256,address,uint128,uint128))
  ownerOf: '0x6352211e',              // ownerOf(uint256)
};

const MAX_UINT128 = (1n << 128n) - 1n;

export function padWord(value) {
  let hex;
  if (typeof value === 'bigint' || typeof value === 'number') {
    hex = BigInt(value).toString(16);
  } else {
    hex = String(value).replace(/^0x/i, '');
  }
  return hex.padStart(64, '0');
}

export function encAddress(addr) {
  return padWord(addr.toLowerCase().replace(/^0x/, ''));
}

export function encUint(n) {
  return padWord(BigInt(n));
}

/** Split a 0x-prefixed return blob into 32-byte words. */
export function words(hex) {
  const body = (hex || '').replace(/^0x/, '');
  const out = [];
  for (let i = 0; i + 64 <= body.length; i += 64) out.push(body.slice(i, i + 64));
  return out;
}

export const toUint = (w) => BigInt('0x' + w);

/** Two's-complement decode. int24 values arrive sign-extended to 256 bits. */
export function toInt(w) {
  const v = BigInt('0x' + w);
  return v >= 1n << 255n ? v - (1n << 256n) : v;
}

export const toAddress = (w) => '0x' + w.slice(24);

/** ERC-20 symbol(): most tokens return a dynamic string, a few return bytes32. */
export function decodeSymbol(hex) {
  const w = words(hex);
  if (w.length === 0) return '?';
  if (w.length >= 3 && toUint(w[0]) === 32n) {
    const len = Number(toUint(w[1]));
    const bytes = w.slice(2).join('').slice(0, len * 2);
    return hexToUtf8(bytes) || '?';
  }
  return hexToUtf8(w[0].replace(/(00)+$/, '')) || '?';
}

function hexToUtf8(hex) {
  try {
    const bytes = hex.match(/.{1,2}/g) || [];
    return new TextDecoder().decode(
      new Uint8Array(bytes.map((b) => parseInt(b, 16)))
    ).replace(/\0/g, '').trim();
  } catch {
    return '';
  }
}

// ---- calldata builders ----

export const dataBalanceOf = (owner) => SELECTOR.balanceOf + encAddress(owner);

export const dataTokenOfOwnerByIndex = (owner, i) =>
  SELECTOR.tokenOfOwnerByIndex + encAddress(owner) + encUint(i);

export const dataPositions = (tokenId) => SELECTOR.positions + encUint(tokenId);

export const dataOwnerOf = (tokenId) => SELECTOR.ownerOf + encUint(tokenId);

export const dataSlot0 = () => SELECTOR.slot0;

export const dataGetPool = (t0, t1, fee) =>
  SELECTOR.getPool + encAddress(t0) + encAddress(t1) + encUint(fee);

/**
 * collect(CollectParams) as an eth_call from the owner. This is the standard
 * trick for reading uncollected fees without a transaction.
 *
 * Caveat that matters for accounting: the return value is principal owed +
 * fees, not fees alone. If a decreaseLiquidity has been called without a
 * collect, the pending principal is bundled in here. The UI labels this
 * "collectable", never "fees earned".
 */
export const dataCollect = (tokenId, recipient) =>
  SELECTOR.collect +
  encUint(tokenId) +
  encAddress(recipient) +
  encUint(MAX_UINT128) +
  encUint(MAX_UINT128);

/** positions(uint256) returns a 12-word static tuple. */
export function decodePositions(hex) {
  const w = words(hex);
  if (w.length < 12) return null;
  return {
    token0: toAddress(w[2]),
    token1: toAddress(w[3]),
    fee: Number(toUint(w[4])),
    tickLower: Number(toInt(w[5])),
    tickUpper: Number(toInt(w[6])),
    liquidity: toUint(w[7]),
    // Not displayed. These are the change-detector for the history cache:
    // every operation that emits an Increase/Decrease/Collect writes them, and
    // nothing else does. See lib/cache.js.
    feeGrowthInside0LastX128: toUint(w[8]),
    feeGrowthInside1LastX128: toUint(w[9]),
    tokensOwed0: toUint(w[10]),
    tokensOwed1: toUint(w[11]),
  };
}

export function decodeSlot0(hex) {
  const w = words(hex);
  if (w.length < 2) return null;
  return { sqrtPriceX96: toUint(w[0]), tick: Number(toInt(w[1])) };
}

export function decodeCollect(hex) {
  const w = words(hex);
  if (w.length < 2) return { amount0: 0n, amount1: 0n };
  return { amount0: toUint(w[0]), amount1: toUint(w[1]) };
}
