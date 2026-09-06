#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CHAINS } from '../extension/lib/chains.js';
import { revertPositionUrl } from '../extension/lib/revert.js';

const position = (overrides = {}) => ({
  chainKey: 'ethereum',
  version: 'v3',
  deploymentId: 'uniswap-v3',
  protocol: 'Uniswap',
  manager: CHAINS.ethereum.nfpm,
  tokenId: '123',
  ...overrides,
});

for (const [chainKey, slug] of Object.entries({
  ethereum: 'mainnet',
  base: 'base',
  arbitrum: 'arbitrum',
  polygon: 'polygon',
  robinhood: 'robinhood',
})) {
  assert.equal(
    revertPositionUrl(position({ chainKey, manager: CHAINS[chainKey].nfpm })),
    `https://revert.finance/uniswap-position/${slug}/123`,
    `standard Uniswap v3 on ${chainKey} should receive a Revert route`,
  );
}

for (const [chainKey, slug] of Object.entries({
  ethereum: 'mainnet',
  base: 'base',
  arbitrum: 'arbitrum',
  robinhood: 'robinhood',
})) {
  assert.equal(
    revertPositionUrl(position({
      chainKey,
      version: 'v4',
      deploymentId: 'uniswap-v4',
      protocol: 'Uniswap',
      manager: CHAINS[chainKey].v4PositionManager,
    })),
    `https://revert.finance/uniswapv4-position/${slug}/123`,
    `supported or live-verified Uniswap v4 on ${chainKey} should receive a Revert route`,
  );
}

for (const chainKey of ['polygon']) {
  assert.equal(revertPositionUrl(position({
    chainKey,
    version: 'v4',
    deploymentId: 'uniswap-v4',
    protocol: 'Uniswap',
    manager: CHAINS[chainKey].v4PositionManager,
  })), null, `unsupported v4 on ${chainKey} must fail closed`);
}

for (const unsupported of [
  position({ chainKey: 'hyperevm', protocol: 'ProjectX', deploymentId: 'projectx-v3' }),
  position({ chainKey: 'robinhood', protocol: 'UP33', deploymentId: 'up33-cl' }),
  position({ protocol: 'Uniswap', deploymentId: 'up33-cl' }),
  position({ protocol: null }),
  position({ manager: '0x0000000000000000000000000000000000000001' }),
  position({ version: 'v4', deploymentId: 'uniswap-v4', manager: null }),
  position({ version: 'v5' }),
  position({ chainKey: '../account/0xabc' }),
]) {
  assert.equal(revertPositionUrl(unsupported), null);
}

for (const invalidId of [
  null, '', '0', '-1', '1.5', '0x123', '12/34', Number.MAX_SAFE_INTEGER + 1,
  (1n << 256n).toString(),
]) {
  assert.equal(revertPositionUrl(position({ tokenId: invalidId })), null,
    `invalid token ID ${String(invalidId)} must fail closed`);
}

assert.equal(
  revertPositionUrl(position({ tokenId: 999n })),
  'https://revert.finance/uniswap-position/mainnet/999',
);

const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url)));
const controller = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
const helper = readFileSync(new URL('../extension/lib/revert.js', import.meta.url), 'utf8');
const positions = readFileSync(new URL('../extension/lib/positions.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../extension/popup.css', import.meta.url), 'utf8');
const hosts = [...(manifest.host_permissions || []), ...(manifest.optional_host_permissions || [])];

assert.equal(hosts.some((host) => /revert\.finance/i.test(host)), false,
  'an outbound link must not add Revert page access');
assert.doesNotMatch(helper, /fetch\s*\(|XMLHttpRequest|sendMessage\s*\(/,
  'the route helper must remain local and network-free');
assert.doesNotMatch(helper, /api\.revert\.finance|utm_/i,
  'the integration must not depend on Revert analytics or tracking parameters');
assert.match(positions, /standardV4[^]*deploymentId:[^]*'uniswap-v4'[^]*manager:[^]*v4PositionManager[^]*protocol:[^]*'Uniswap'/,
  'standard v4 rows must carry an explicit Uniswap deployment and manager identity');
assert.match(controller, /class="revert-position-link"[^]*target="_blank"[^]*rel="noopener noreferrer"/,
  'the external link must isolate its new tab');
assert.match(controller, /Wallet connections and transactions happen on Revert, not in LPLens/,
  'the card must name the transaction boundary before navigation');
assert.match(controller, /class="revert-prefix">View on <\/span>Revert/,
  'the card should make the external navigation explicit when space permits');
assert.match(css, /\.revert-position-link:focus-visible/,
  'the link needs a visible keyboard focus treatment');

console.log('Revert link: strict protocol, chain, token ID, permission, and navigation guards pass');
