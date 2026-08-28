#!/usr/bin/env node
import assert from 'node:assert/strict';
import { CHAINS } from '../extension/lib/chains.js';
import { scanV3Holdings } from '../extension/lib/positions.js';

const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const addressWord = (a) => String(a).replace(/^0x/, '').padStart(64, '0');
const hexResult = (...parts) => '0x' + parts.join('');
const OWNER = '0x1111111111111111111111111111111111111111';
const TOKEN0 = '0x2222222222222222222222222222222222222222';
const TOKEN1 = '0x3333333333333333333333333333333333333333';
const NFPM = '0x4444444444444444444444444444444444444444';
const RPC = 'https://mock.robinhood.rpc';

function positionHex() {
  return hexResult(
    word(0), word(0), addressWord(TOKEN0), addressWord(TOKEN1), word(3000),
    word(0), word(10), word(1), word(0), word(0), word(0), word(0));
}

const jsonResponse = (json, ok = true, status = 200) => ({
  ok, status, headers: { get: () => null }, json: async () => json,
});

async function withFetch(fake, fn) {
  const prior = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = prior; }
}

async function testRobinhoodOnlyOptsIntoPublicBatching() {
  assert.equal(CHAINS.robinhood.rpcBatchSize, 25);
  for (const [key, chain] of Object.entries(CHAINS)) {
    if (key !== 'robinhood') assert.equal(chain.rpcBatchSize, undefined);
  }
}

async function testFailedItemsRetryWithoutRepeatingGoodReads() {
  const batchSizes = [];
  let batch = 0;
  const fake = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert(Array.isArray(body), 'configured Robinhood reads should be batched');
    batchSizes.push(body.length);
    batch++;

    if (batch === 1) {
      return jsonResponse(body.map((request, index) => index === 1
        ? { jsonrpc: '2.0', id: request.id, error: { message: 'temporary item failure' } }
        : { jsonrpc: '2.0', id: request.id, result: hexResult(word(101 + index)) }));
    }
    if (batch === 2) {
      assert.equal(body.length, 1, 'only the failed item should retry');
      return jsonResponse(body.map((request) => ({
        jsonrpc: '2.0', id: request.id, result: hexResult(word(102)),
      })));
    }
    return jsonResponse(body.map((request) => ({
      jsonrpc: '2.0', id: request.id, result: positionHex(),
    })));
  };

  await withFetch(fake, async () => {
    const got = await scanV3Holdings(
      RPC, { nfpm: NFPM, rpcBatchSize: 25 }, OWNER, 3);
    assert.equal(got.scanned, 3);
    assert.equal(got.enumUnreadable, 0);
    assert.equal(got.positionUnreadable, 0);
    assert.deepEqual(got.live.map((row) => row.tokenId), [101n, 102n, 103n]);
    assert.deepEqual(batchSizes, [3, 1, 3]);
  });
}

async function testWholeBatchRefusalFallsBackToSingles() {
  let batches = 0;
  let singles = 0;
  const fake = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (Array.isArray(body)) {
      batches++;
      return jsonResponse({ error: { message: 'batch requests disabled' } }, false, 400);
    }

    singles++;
    const data = body.params[0].data;
    let result;
    if (data.startsWith('0x2f745c59')) {
      const index = Number(BigInt('0x' + data.slice(-64)));
      result = hexResult(word(index + 1));
    } else if (data.startsWith('0x99fbab88')) {
      result = positionHex();
    } else {
      throw new Error(`unexpected calldata ${data.slice(0, 10)}`);
    }
    return jsonResponse({ jsonrpc: '2.0', id: body.id, result });
  };

  await withFetch(fake, async () => {
    const got = await scanV3Holdings(
      RPC, { nfpm: NFPM, rpcBatchSize: 25 }, OWNER, 2);
    assert.equal(got.scanned, 2);
    assert.equal(got.enumUnreadable, 0);
    assert.equal(got.positionUnreadable, 0);
    assert.equal(batches, 2, 'enumeration and positions should each try one batch');
    assert.equal(singles, 4, 'both refused batches should recover through singles');
  });
}

async function testAllItemErrorsFallBackToSingles() {
  let batches = 0;
  let singles = 0;
  const fake = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (Array.isArray(body)) {
      batches++;
      if (batches === 1) {
        return jsonResponse(body.map((request) => ({
          jsonrpc: '2.0', id: request.id, error: { message: 'batch method unavailable' },
        })));
      }
      return jsonResponse(body.map((request) => ({
        jsonrpc: '2.0', id: request.id, result: positionHex(),
      })));
    }

    singles++;
    return jsonResponse({ jsonrpc: '2.0', id: body.id, result: hexResult(word(7)) });
  };

  await withFetch(fake, async () => {
    const got = await scanV3Holdings(
      RPC, { nfpm: NFPM, rpcBatchSize: 25 }, OWNER, 1);
    assert.equal(got.scanned, 1);
    assert.equal(got.enumUnreadable, 0);
    assert.equal(got.positionUnreadable, 0);
    assert.equal(got.live[0].tokenId, 7n);
    assert.equal(batches, 2, 'the all-error batch should fall back without batch retries');
    assert.equal(singles, 1, 'the rejected batch item should be confirmed with a scalar read');
  });
}

async function testBatchChunksPreservePositionOrder() {
  const batchSizes = [];
  const fake = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert(Array.isArray(body));
    batchSizes.push(body.length);
    return jsonResponse(body.map((request) => {
      const data = request.params[0].data;
      const result = data.startsWith('0x2f745c59')
        ? hexResult(word(Number(BigInt('0x' + data.slice(-64))) + 1))
        : positionHex();
      return { jsonrpc: '2.0', id: request.id, result };
    }));
  };

  await withFetch(fake, async () => {
    const got = await scanV3Holdings(
      RPC, { nfpm: NFPM, rpcBatchSize: 25 }, OWNER, 27);
    assert.equal(got.enumUnreadable, 0);
    assert.equal(got.positionUnreadable, 0);
    assert.deepEqual(batchSizes, [25, 2, 25, 2]);
    assert.deepEqual(got.live.map((row) => row.tokenId),
      Array.from({ length: 27 }, (_, index) => BigInt(27 - index)),
      'chunking must preserve the newest-first enumeration order');
  });
}

await testRobinhoodOnlyOptsIntoPublicBatching();
await testFailedItemsRetryWithoutRepeatingGoodReads();
await testWholeBatchRefusalFallsBackToSingles();
await testAllItemErrorsFallBackToSingles();
await testBatchChunksPreservePositionOrder();
console.log('Robinhood RPC batching: 5 regression groups passed');
