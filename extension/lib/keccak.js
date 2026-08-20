/**
 * Keccak-256, as used by Ethereum.
 *
 * Needed because Uniswap v4 identifies a pool by
 * `poolId = keccak256(abi.encode(PoolKey))` rather than by a contract address.
 * v3 could resolve pools with an on-chain `factory.getPool()` call; v4 has a
 * singleton PoolManager and expects the caller to derive the id, so reading any
 * v4 position requires hashing locally.
 *
 * NOTE: this is original Keccak (padding byte 0x01), NOT NIST SHA3-256
 * (padding 0x06). They differ only in that pad byte and produce completely
 * different digests. `crypto.subtle` offers neither, which is why this exists.
 *
 * Verified against published vectors at load time in the test suite:
 *   keccak256("")    = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
 *   keccak256("abc") = 4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45
 * and cross-checked on-chain: the derived poolId's top 200 bits must equal the
 * truncated id v4 stores independently in PositionInfo.
 */

const MASK = (1n << 64n) - 1n;

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rho rotation offsets, indexed by lane (x + 5y).
const R = [
  0n, 1n, 62n, 28n, 27n,
  36n, 44n, 6n, 55n, 20n,
  3n, 10n, 43n, 25n, 39n,
  41n, 45n, 15n, 21n, 8n,
  18n, 2n, 61n, 56n, 14n,
];

const rotl = (v, n) => ((v << n) | (v >> (64n - n))) & MASK;

function keccakF(A) {
  for (let round = 0; round < 24; round++) {
    // theta
    const C = new Array(5);
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) A[x + y] ^= D;
    }

    // rho + pi
    const B = new Array(25).fill(0n);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], R[x + 5 * y]);
      }
    }

    // chi
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        A[x + y] = B[x + y] ^ ((~B[((x + 1) % 5) + y] & MASK) & B[((x + 2) % 5) + y]);
      }
    }

    // iota
    A[0] ^= RC[round];
  }
  return A;
}

/** Keccak-256 over a Uint8Array. Returns a 32-byte Uint8Array. */
export function keccak256(bytes) {
  const RATE = 136;   // 1088 bits
  const padLen = RATE - (bytes.length % RATE);
  const padded = new Uint8Array(bytes.length + padLen);
  padded.set(bytes);
  padded[bytes.length] = 0x01;          // original Keccak pad, not SHA3's 0x06
  padded[padded.length - 1] |= 0x80;

  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      A[i] ^= lane;
    }
    keccakF(A);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = A[i];
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

/** Keccak-256 over a 0x-prefixed hex string. Returns 0x-prefixed hex. */
export function keccak256Hex(hex) {
  const body = String(hex).replace(/^0x/, '');
  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(body.substr(i * 2, 2), 16);
  const digest = keccak256(bytes);
  return '0x' + [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}
