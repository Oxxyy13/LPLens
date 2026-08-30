#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CHAINS, PUBLIC_RPC } from '../extension/lib/chains.js';
import { relayQuery } from './licence-worker/worker.js';

const chain = CHAINS.hyperevm;
assert.ok(chain, 'HyperEVM chain config is missing');
assert.equal(chain.label, 'HyperEVM');
assert.equal(chain.protocol, 'ProjectX');
assert.equal(chain.nfpm.toLowerCase(), '0xead19ae861c29bbb2101e834922b2feee69b9091');
assert.equal(chain.factory.toLowerCase(), '0xff7b3e8c00e57ea31477c32a5b52a58eea47b072');
assert.equal(chain.rpc, 'https://rpc.hyperliquid.xyz/evm');
assert.equal(PUBLIC_RPC.hyperevm, chain.rpc);
assert.equal(chain.dexscreener, 'hyperevm');
assert.equal(chain.nativeSymbol, 'HYPE');
assert.equal(chain.etherscanChainId, 999);
assert.equal(chain.usdRef.stable.toLowerCase(), '0xb88339cb7199b77e23db6e890353e22632ba630f');
assert.equal(chain.usdRef.weth.toLowerCase(), '0x5555555555555555555555555555555555555555');
assert.equal(chain.usdRef.stableDecimals, 6);
assert.deepEqual(Object.keys(CHAINS), [
  'ethereum', 'base', 'arbitrum', 'polygon', 'hyperevm', 'robinhood',
]);

const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url)));
assert.equal(manifest.version, '0.31.0');
assert.match(manifest.name, /Concentrated LP Position Reader/);
assert.match(manifest.description, /ProjectX/);
assert.ok(manifest.host_permissions.includes('https://rpc.hyperliquid.xyz/*'));

const allowed = relayQuery({
  chainId: 999,
  fields: {
    address: chain.nfpm,
    fromBlock: '0',
    toBlock: 'latest',
    topic1: '0x' + (533076n).toString(16).padStart(64, '0'),
  },
});
assert.equal(allowed.chainId, '999');
assert.equal(allowed.fields.address, chain.nfpm.toLowerCase());
assert.throws(() => relayQuery({
  chainId: 999,
  fields: {
    address: '0x' + '9'.repeat(40),
    topic1: allowed.fields.topic1,
  },
}), /allowlisted/);

console.log('ProjectX config: HyperEVM contracts, manifest permission and relay allowlist pass');
