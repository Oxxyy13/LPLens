#!/usr/bin/env node
/**
 * Robinhood -> Ethereum time alignment must use one public Blockscout lookup
 * before considering the many-call on-chain binary search. That burst exhausted
 * Ethereum dRPC in the live four-card overlay and withheld every dollar return.
 */
import assert from 'node:assert/strict';

const POOL = '0x' + '11'.repeat(20);
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const SQRT = 2_500_000_000_000_000_000_000_000_000n;
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
let blockscoutLookups = 0;
let ethereumBlockReads = 0;
let blockscoutPriceLookups = 0;
let ethereumLogReads = 0;

globalThis.fetch = async (url, init) => {
  const parsed = new URL(String(url));
  if (parsed.hostname === 'eth.blockscout.com' && !init
      && parsed.searchParams.get('module') === 'block') {
    blockscoutLookups++;
    assert.equal(parsed.searchParams.get('action'), 'getblocknobytime');
    assert.equal(parsed.searchParams.get('closest'), 'before');
    return {
      ok: true, status: 200,
      json: async () => ({ status: '1', message: 'OK', result: { blockNumber: '2000' } }),
    };
  }
  if (parsed.hostname === 'eth.blockscout.com' && !init
      && parsed.searchParams.get('module') === 'logs') {
    blockscoutPriceLookups++;
    assert.equal(parsed.searchParams.get('action'), 'getLogs');
    return {
      ok: true, status: 200,
      json: async () => ({ status: '1', message: 'OK', result: [{
        address: POOL,
        topics: ['0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'],
        data: '0x' + word(1n) + word(1n) + word(SQRT) + word(1n) + word(0n),
        blockNumber: '0x7d0', transactionHash: '0x' + 'ab'.repeat(32), logIndex: '0x0',
      }] }),
    };
  }

  const body = JSON.parse(init.body);
  const reply = (result) => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ jsonrpc: '2.0', id: body.id, result }),
  });
  if (parsed.hostname === 'rpc.mainnet.chain.robinhood.com'
      && body.method === 'eth_getBlockByNumber') {
    return reply({ number: '0x64', timestamp: '0x3e8' });
  }
  if (parsed.hostname === 'ethereum-rpc.publicnode.com'
      && body.method === 'eth_getBlockByNumber') {
    ethereumBlockReads++;
    throw new Error('binary search should not run when Blockscout succeeds');
  }
  if (parsed.hostname === 'ethereum-rpc.publicnode.com' && body.method === 'eth_call') {
    const data = body.params[0].data;
    if (data.startsWith('0x1698ee82')) return reply('0x' + word(POOL));
    if (data.startsWith('0x0dfe1681')) return reply('0x' + word(USDC));
    throw new Error(`unexpected eth_call ${data.slice(0, 10)}`);
  }
  if (parsed.hostname === 'ethereum-rpc.publicnode.com' && body.method === 'eth_getLogs') {
    ethereumLogReads++;
    throw new Error('public Blockscout should serve the historical pool price');
  }
  throw new Error(`unexpected request ${parsed.hostname} ${body.method}`);
};

const { refUsdAtBlock } = await import('../extension/lib/histprice.js');
const price = await refUsdAtBlock('robinhood', 100, {});
assert.ok(price > 0 && Number.isFinite(price), 'bridged historical USD price should resolve');
assert.equal(blockscoutLookups, 1, 'timestamp mapping should be one indexed request');
assert.equal(blockscoutPriceLookups, 1, 'historical pool price should use Blockscout logs');
assert.equal(ethereumBlockReads, 0, 'successful Blockscout lookup must avoid binary search');
assert.equal(ethereumLogReads, 0, 'successful Blockscout lookup must avoid RPC log reads');

console.log('histprice Blockscout: keyless time and price indexes avoid Ethereum RPC bursts');
