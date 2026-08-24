#!/usr/bin/env node
/**
 * Live ProjectX/HyperEVM regression against Dan's public test position.
 * Reads ETHERSCAN_KEY from the gitignored local .env and never prints it.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { CHAINS } from '../extension/lib/chains.js';
import {
  dataBalanceOf, dataOwnerOf, toAddress, toUint, words,
} from '../extension/lib/abi.js';
import { ethCall } from '../extension/lib/rpc.js';

const WALLET = '0x946D4D60c864921bafeEa88a183a0C62929Dc09C';
const TOKEN_ID = 533076n;
const chain = CHAINS.hyperevm;

function localEnv() {
  const url = new URL('../.env', import.meta.url);
  if (!existsSync(url)) return {};
  return Object.fromEntries(readFileSync(url, 'utf8').split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return [];
    const at = trimmed.indexOf('=');
    if (at < 1) return [];
    return [[trimmed.slice(0, at), trimmed.slice(at + 1).trim().replace(/^['"]|['"]$/g, '')]];
  }));
}

const etherscanKey = String(localEnv().ETHERSCAN_KEY || '').trim();
if (!etherscanKey) throw new Error('ETHERSCAN_KEY missing from local .env');

const backing = {};
globalThis.chrome = {
  storage: { local: {
    get: async (names) => Object.fromEntries(
      names.filter((name) => Object.hasOwn(backing, name)).map((name) => [name, backing[name]]),
    ),
    set: async (values) => Object.assign(backing, values),
    remove: async (names) => {
      for (const name of Array.isArray(names) ? names : [names]) delete backing[name];
    },
  } },
};

try {
  const [balanceHex, ownerHex] = await Promise.all([
    ethCall(chain.rpc, chain.nfpm, dataBalanceOf(WALLET)),
    ethCall(chain.rpc, chain.nfpm, dataOwnerOf(TOKEN_ID)),
  ]);
  const balance = toUint(words(balanceHex)[0]);
  const owner = toAddress(words(ownerHex)[0]);
  assert.ok(balance > 0n, 'ProjectX wallet should hold at least one NFT');
  assert.equal(owner.toLowerCase(), WALLET.toLowerCase());

  const { loadPosition, loadPositions } = await import(
    `../extension/lib/positions.js?projectx-live=${Date.now()}`
  );
  const position = await loadPosition('hyperevm', TOKEN_ID, {
    etherscanKey,
    withUsd: true,
  });

  assert.equal(position.protocol, 'ProjectX');
  assert.equal(position.version, 'v3');
  assert.equal(position.token0Meta.symbol, 'WHYPE');
  assert.equal(position.token1Meta.symbol, 'UBTC');
  assert.ok(position.liquidity > 0n);
  assert.ok(['in-range', 'below', 'above'].includes(position.status));
  assert.ok(position.history && !position.history.unavailable,
    position.history && position.history.unavailable || 'ProjectX history missing');
  assert.match(position.history.source || '', /etherscan/);
  assert.ok(position.history.deposits.length >= 1);
  assert.ok(position.usd && position.usd.grossAdded !== null,
    'ProjectX historical USD basis should resolve');

  console.log(JSON.stringify({
    projectx: 'pass',
    walletNfts: String(balance),
    tokenId: String(TOKEN_ID),
    pair: `${position.token0Meta.symbol}/${position.token1Meta.symbol}`,
    status: position.status,
    historySource: position.history.source,
    historyEvents: position.history.deposits.length + position.history.collections.length,
    usdBasisAvailable: position.usd.grossAdded !== null,
  }));

  if (process.argv.includes('--wallet-scan')) {
    const withUsd = process.argv.includes('--with-usd');
    const scan = await loadPositions(
      'hyperevm', WALLET, { etherscanKey, includeClosed: false, withUsd },
    );
    assert.equal(scan.count, Number(balance));
    assert.equal(scan.scanned, Number(balance));
    assert.equal(scan.enumUnreadable, 0);
    assert.equal(scan.positionUnreadable, 0);
    assert.ok(scan.positions.some((row) => row.tokenId === TOKEN_ID));
    if (withUsd) {
      const overlayPosition = scan.positions.find((row) => row.tokenId === TOKEN_ID);
      assert.ok(overlayPosition.usd && overlayPosition.usd.grossAdded !== null,
        'ProjectX portfolio overlay scan should include USD basis');
    }
    console.log(JSON.stringify({
      projectxWalletScan: 'pass',
      held: scan.count,
      scanned: scan.scanned,
      openRendered: scan.positions.length,
      closedHidden: scan.closedHidden,
      unreadable: scan.enumUnreadable + scan.positionUnreadable,
      usd: withUsd,
    }));
  }
} finally {
  delete globalThis.chrome;
}
