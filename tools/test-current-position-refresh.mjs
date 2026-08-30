#!/usr/bin/env node
import assert from 'node:assert/strict';
import { loadKnownPositions } from '../extension/lib/positions.js';

const OWNER = '0x' + '11'.repeat(20);
const OTHER = '0x' + '22'.repeat(20);
const TOKEN0 = '0x' + '33'.repeat(20);
const TOKEN1 = '0x' + '44'.repeat(20);
const RPC = 'https://known-refresh.invalid';
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const signedWord = (value) => (BigInt(value) < 0n
  ? ((1n << 256n) + BigInt(value)).toString(16)
  : BigInt(value).toString(16)).padStart(64, '0');
const addressWord = (address) => address.slice(2).padStart(64, '0');
const positionHex = (liquidity) => '0x' + [
  word(0), word(0), addressWord(TOKEN0), addressWord(TOKEN1), word(3000),
  signedWord(-120), signedWord(120), word(liquidity), word(0), word(0), word(0), word(0),
].join('');
const response = (value, id = 1) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ jsonrpc: '2.0', id, result: value }),
});

const scope = {
  v3: { complete: true, ids: ['7'] },
  v4: { complete: true, ids: [] },
};
let ownerReply = OWNER;
let liquidity = 100n;
const methods = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, init = {}) => {
  const body = JSON.parse(init.body);
  assert.equal(Array.isArray(body), false, 'this fixture uses bounded scalar reads');
  methods.push(body);
  const data = body.params[0].data;
  if (data.startsWith('0x6352211e')) {
    return response(ownerReply === 'malformed' ? '0x' : '0x' + addressWord(ownerReply), body.id);
  }
  if (data.startsWith('0x99fbab88')) return response(positionHex(liquidity), body.id);
  if (data.startsWith('0x1698ee82')) return response('0x' + word(0), body.id);
  throw new Error(`unexpected selector ${data.slice(0, 10)}`);
};

try {
  let got = await loadKnownPositions('ethereum', OWNER, scope, {
    rpcOverride: RPC,
    withUsd: false,
  });
  assert.equal(got.positions.length, 1);
  assert.deepEqual(got.currentIndex.v3, ['7']);
  assert.equal(methods.some((call) => call.params[0].data.startsWith('0x2f745c59')), false,
    'fast refresh must never enumerate tokenOfOwnerByIndex');
  assert.equal(methods.some((call) => call.method === 'eth_getLogs'), false,
    'fast refresh must never replay Transfer history');

  methods.length = 0;
  ownerReply = OTHER;
  got = await loadKnownPositions('ethereum', OWNER, scope, {
    rpcOverride: RPC,
    withUsd: false,
  });
  assert.equal(got.positions.length, 0);
  assert.deepEqual(got.currentIndex.v3, [], 'a proven transfer removes the remembered ID');
  assert.equal(methods.some((call) => call.params[0].data.startsWith('0x99fbab88')), false,
    'a transferred ID must not pay for a position read');

  methods.length = 0;
  ownerReply = 'malformed';
  got = await loadKnownPositions('ethereum', OWNER, scope, {
    rpcOverride: RPC,
    withUsd: false,
  });
  assert.equal(got.enumUnreadable, 1);
  assert.deepEqual(got.currentIndex.v3, ['7'], 'an unreadable owner proof preserves the ID');

  ownerReply = OWNER;
  liquidity = 0n;
  got = await loadKnownPositions('ethereum', OWNER, scope, {
    rpcOverride: RPC,
    withUsd: false,
  });
  assert.equal(got.positions.length, 0);
  assert.equal(got.closedHidden, 1);
  assert.deepEqual(got.currentIndex.v3, [], 'a proven closed position leaves the open index');

  await assert.rejects(
    () => loadKnownPositions('ethereum', OWNER, null, { rpcOverride: RPC }),
    /Full rescan/,
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log('current position refresh: strict owner proof and no discovery calls pass');
