import { CHAINS } from './chains.js';

// Revert is an external management product, not an LPLens data provider.
// These URLs are created locally from public position identity and are opened
// only after the user clicks the link. Keep the allowlist narrower than the
// routes accepted by Revert's app so an unsupported position never looks
// actionable merely because both products use an Ethereum-style NFT ID.
const REVERT_ORIGIN = 'https://revert.finance';
const MAX_UINT256 = (1n << 256n) - 1n;

const NETWORK_SLUGS = Object.freeze({
  ethereum: 'mainnet',
  base: 'base',
  arbitrum: 'arbitrum',
  polygon: 'polygon',
  robinhood: 'robinhood',
});

const V3_NETWORKS = new Set([
  'ethereum', 'base', 'arbitrum', 'polygon', 'robinhood',
]);

// Revert's public product page currently lists v4 on Ethereum, Base,
// Arbitrum, and Unichain. Its live app also resolved Robinhood v4 NFTs 1545755
// and 1615229 on 2026-09-04. LPLens does not scan Unichain and deliberately
// does not infer Polygon v4 support.
const V4_NETWORKS = new Set(['ethereum', 'base', 'arbitrum', 'robinhood']);

function tokenId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const raw = typeof value === 'bigint' ? value.toString() : String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) return null;
  try {
    const id = BigInt(raw);
    return id > 0n && id <= MAX_UINT256 ? id.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Return a user-clickable Revert position URL for a supported standard
 * Uniswap NFT. ProjectX, UP33, unknown deployments, and unsupported v4
 * networks fail closed to null.
 */
export function revertPositionUrl(position) {
  if (!position) return null;

  const chainKey = String(position.chainKey || '').toLowerCase();
  const network = NETWORK_SLUGS[chainKey];
  const id = tokenId(position.tokenId);
  const version = String(position.version || '').toLowerCase();
  const protocol = String(position.protocol || '').toLowerCase();
  const chain = CHAINS[chainKey];
  const manager = String(position.manager || '').toLowerCase();
  if (!network || !id || protocol !== 'uniswap' || !chain) return null;

  if (version === 'v3') {
    // Tagged v3 rows always name their deployment. Requiring both fields keeps
    // another v3-family NFT from inheriting the standard Uniswap route.
    if (position.deploymentId !== 'uniswap-v3') return null;
    if (manager !== String(chain.nfpm || '').toLowerCase()) return null;
    if (!V3_NETWORKS.has(chainKey)) return null;
    return `${REVERT_ORIGIN}/uniswap-position/${network}/${id}`;
  }

  if (version === 'v4') {
    if (position.deploymentId !== 'uniswap-v4') return null;
    if (manager !== String(chain.v4PositionManager || '').toLowerCase()) return null;
    if (!V4_NETWORKS.has(chainKey)) return null;
    return `${REVERT_ORIGIN}/uniswapv4-position/${network}/${id}`;
  }

  return null;
}
