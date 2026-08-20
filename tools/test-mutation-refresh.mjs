#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scanV3Holdings } from '../extension/lib/positions.js';
import {
  hasNewHistoryEvent, lifetimeFees, mergeHistoryEvents,
} from '../extension/lib/history.js';
import { sumDepositBasis } from '../extension/lib/histprice.js';
import { enumerateV4 } from '../extension/lib/v4.js';

const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const addressWord = (a) => String(a).replace(/^0x/, '').padStart(64, '0');
const hexResult = (...parts) => '0x' + parts.join('');
const OWNER = '0x1111111111111111111111111111111111111111';
const TOKEN0 = '0x2222222222222222222222222222222222222222';
const TOKEN1 = '0x3333333333333333333333333333333333333333';
const NFPM = '0x4444444444444444444444444444444444444444';

function positionHex(liquidity) {
  return hexResult(
    word(0), word(0), addressWord(TOKEN0), addressWord(TOKEN1), word(3000),
    word(0), word(10), word(liquidity), word(0), word(0), word(0), word(0));
}

function rpcResponse(result, error = null) {
  return {
    ok: true,
    status: 200,
    json: async () => error ? { jsonrpc: '2.0', id: 1, error } : ({
      jsonrpc: '2.0', id: 1, result,
    }),
  };
}

async function withFetch(fake, fn) {
  const prior = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = prior; }
}

async function testFullV3EnumerationAndRevival() {
  let ids = Array.from({ length: 25 }, (_, i) => BigInt(i + 1));
  const fake = async (_url, init) => {
    const body = JSON.parse(init.body);
    const data = body.params[0].data;
    if (data.startsWith('0x2f745c59')) {
      const index = Number(BigInt('0x' + data.slice(-64)));
      return rpcResponse(hexResult(word(ids[index])));
    }
    if (data.startsWith('0x99fbab88')) {
      const tokenId = BigInt('0x' + data.slice(-64));
      return rpcResponse(positionHex(tokenId === 1n ? 10n : 0n));
    }
    throw new Error(`unexpected calldata ${data.slice(0, 10)}`);
  };

  await withFetch(fake, async () => {
    const first = await scanV3Holdings('https://mock.rpc', { nfpm: NFPM }, OWNER, 25);
    assert.equal(first.scanned, 25);
    assert.equal(first.closedHidden, 24);
    assert.deepEqual(first.live.map((p) => p.tokenId), [1n],
      'an old NFT revived after 24 closed positions must still render');

    // Same count and same newest token, but ERC721Enumerable swap-and-pop
    // changed an interior index. A sentinel cache would miss token 99.
    ids = [...ids];
    ids[7] = 99n;
    const second = await scanV3Holdings('https://mock.rpc', { nfpm: NFPM }, OWNER, 25, true);
    assert(second.live.some((p) => p.tokenId === 99n));
    assert(!second.live.some((p) => p.tokenId === 8n));
  });
}

async function testUnreadableV3IsCounted() {
  const fake = async (_url, init) => {
    const body = JSON.parse(init.body);
    const data = body.params[0].data;
    if (data.startsWith('0x2f745c59')) {
      const index = Number(BigInt('0x' + data.slice(-64)));
      if (index === 2) return rpcResponse(null, { code: -32000, message: 'index unavailable' });
      return rpcResponse(hexResult(word(index + 1)));
    }
    if (data.startsWith('0x99fbab88')) {
      const tokenId = BigInt('0x' + data.slice(-64));
      if (tokenId === 4n) return rpcResponse(null, { code: -32000, message: 'position unavailable' });
      return rpcResponse(positionHex(1n));
    }
    throw new Error('unexpected request');
  };
  await withFetch(fake, async () => {
    const got = await scanV3Holdings('https://mock.rpc', { nfpm: NFPM }, OWNER, 5);
    assert.equal(got.enumUnreadable, 1);
    assert.equal(got.positionUnreadable, 1);
    assert.equal(got.scanned, 3);
  });
}

function event(kind, block, a0, a1, extra = {}) {
  return { kind, block, time: null, liquidity: 0n, amount0: BigInt(a0), amount1: BigInt(a1), ...extra };
}

function testHistoryRefreshAndFees() {
  const oldIncrease = event('increase', 10, 100, 200, { liquidity: 50n });
  const fetchedIncrease = { ...oldIncrease, transactionHash: '0xaaa', logIndex: 1 };
  const newCollect = event('collect', 20, 7, 9, { transactionHash: '0xbbb', logIndex: 2 });
  const merged = mergeHistoryEvents([oldIncrease], [fetchedIncrease], [newCollect]);
  assert.equal(merged.length, 2, 'legacy and identified copies of one event must dedupe');
  assert(hasNewHistoryEvent([oldIncrease], merged), 'a just-mined collect must invalidate history');
  assert(!hasNewHistoryEvent([oldIncrease], [fetchedIncrease]),
    'adding log identity to an old row is not a new transaction');

  // Prior fees 100, then 500 principal is decreased and 550 is collectable.
  // Total fees remain 150; the pending principal is not a fee and old fees do
  // not disappear merely because collected < total decreased at this moment.
  assert.equal(lifetimeFees(100n, 550n, 500n), 150n);
  assert.equal(lifetimeFees(650n, 0n, 500n), 150n, 'claiming must preserve lifetime fees');
}

async function testEveryAddGetsItsOwnBasis() {
  const blocks = [];
  const basis = await sumDepositBasis([
    { block: 10, amount0: 5, amount1: 10, entry: { price: 2, exact: true } },
    { block: 20, amount0: 4, amount1: 8, entry: { price: 3, exact: false } },
  ], async (deposit) => {
    blocks.push(deposit.block);
    return deposit.block === 10 ? { usd0: 2, usd1: 1 } : { usd0: 3, usd1: 1 };
  });
  assert.deepEqual(blocks, [10, 20]);
  assert.equal(basis.basis, 40);
  assert.equal(basis.exact, false);
}

async function testAlchemyV4IsOnChainVerified() {
  const pm = '0x5555555555555555555555555555555555555555';
  const rpc = 'https://base-mainnet.g.alchemy.com/v2/test-key-not-a-secret';
  const fake = async (url, init) => {
    if (!init) {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, '/nft/v3/test-key-not-a-secret/getNFTsForOwner');
      assert.equal(parsed.searchParams.get('owner'), OWNER);
      return {
        ok: true, status: 200, json: async () => ({
          ownedNfts: [
            { contract: { address: pm }, tokenId: '7' },
            { contract: { address: pm }, tokenId: '8' },
          ],
        }),
      };
    }
    const body = JSON.parse(init.body);
    if (Array.isArray(body)) {
      return {
        ok: true, status: 200, json: async () => body.map((request) => ({
          jsonrpc: '2.0', id: request.id, result: hexResult(addressWord(OWNER)),
        })),
      };
    }
    const data = body.params[0].data;
    if (data.startsWith('0x70a08231')) return rpcResponse(hexResult(word(2)));
    if (data.startsWith('0x6352211e')) return rpcResponse(hexResult(addressWord(OWNER)));
    throw new Error('Transfer-log fallback should not run after verified NFT ownership');
  };

  // Use a shallow chain override by temporarily pointing Base's configured PM
  // through the real module input expected by enumerateV4.
  const { CHAINS } = await import('../extension/lib/chains.js');
  const prior = CHAINS.base.v4PositionManager;
  CHAINS.base.v4PositionManager = pm;
  try {
    await withFetch(fake, async () => {
      const got = await enumerateV4('base', OWNER, { rpcOverride: rpc });
      assert.deepEqual(got.tokenIds, [7n, 8n]);
      assert.equal(got.balanceOf, 2);
      assert.equal(got.source, 'alchemy-nft+ownerOf');
    });
  } finally {
    CHAINS.base.v4PositionManager = prior;
  }
}

async function testNoUnknownAsZeroRegressions() {
  const src = await readFile(new URL('../extension/lib/positions.js', import.meta.url), 'utf8');
  assert(!/p\.collectable0\s*\|\|\s*0/.test(src));
  assert(!/p\.collectable1\s*\|\|\s*0/.test(src));
}

await testFullV3EnumerationAndRevival();
await testUnreadableV3IsCounted();
testHistoryRefreshAndFees();
await testEveryAddGetsItsOwnBasis();
await testAlchemyV4IsOnChainVerified();
await testNoUnknownAsZeroRegressions();
console.log('mutation refresh: 6 regression groups passed');
