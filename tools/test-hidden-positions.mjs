#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  cleanHiddenKeys, loadHiddenPositions, positionHideKey, setPositionHidden,
} from '../extension/lib/hidden-positions.js';
import { CHAINS } from '../extension/lib/chains.js';

const position = {
  ownerAddress: '0x8D7Bbfa0506eA95C73D864310818ACC3e5fA05d9',
  chainKey: 'base',
  version: 'v3',
  tokenId: 123n,
};
const owner = '0x8d7bbfa0506ea95c73d864310818acc3e5fa05d9';
const manager = CHAINS.base.nfpm.toLowerCase();
const otherManager = `0x${'aa'.repeat(20)}`;
const legacyKey = `${owner}:base:v3:123`;
const key = `${owner}:base:${manager}:v3:123`;
assert.equal(positionHideKey(position), key);
assert.equal(positionHideKey({ ...position, ownerAddress: 'bad' }), null);
assert.equal(positionHideKey({ ...position, manager: 'bad' }), null,
  'an explicit malformed manager must not fall back to the default deployment');
assert.deepEqual(cleanHiddenKeys([legacyKey, key.toUpperCase(), 'garbage']), [key],
  'a legacy key migrates only to the chain default manager');
assert.equal(positionHideKey({ ...position, manager: otherManager }),
  `${owner}:base:${otherManager}:v3:123`);
assert.notEqual(positionHideKey({ ...position, manager: otherManager }), key,
  'equal token IDs in different managers must not share a hide key');

assert.deepEqual(await loadHiddenPositions(), []);
assert.deepEqual(await setPositionHidden(legacyKey, true), [key]);
assert.deepEqual(await loadHiddenPositions(), [key]);
assert.deepEqual(await setPositionHidden(key, false), []);

const panel = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const controller = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
assert.match(panel, /id="showHidden"/, 'side panel has no reversible hidden-position control');
assert.match(panel, /id="hiddenCount"/, 'side panel does not report the local hidden count');
assert.match(controller, /class="hide-position"/);
assert.match(controller, /setPositionHidden\(key, hide\)/);
assert.match(controller, /totalsCard\(visible\)/,
  'hidden positions are still included in portfolio totals');
assert.match(controller, /data-hidden-position/);

console.log('hidden positions: scoped local key, reversible storage, controls and totals exclusion pass');
