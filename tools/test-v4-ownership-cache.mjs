#!/usr/bin/env node
import assert from 'node:assert/strict';

const rows = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (keys === null) return { ...rows };
        if (typeof keys === 'string') return Object.hasOwn(rows, keys) ? { [keys]: rows[keys] } : {};
        return {};
      },
      async set(values) { Object.assign(rows, values); },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete rows[key];
      },
    },
  },
};

const cache = await import(`../extension/lib/v4-ownership-cache.js?t=${Date.now()}`);
const OWNER = '0x' + '11'.repeat(20);
const MANAGER = '0x' + '22'.repeat(20);
const HASH = '0x' + 'ab'.repeat(32);

assert.equal(await cache.writeV4OwnershipCheckpoint({
  chainKey: 'base',
  manager: MANAGER,
  owner: OWNER,
  checkedThrough: 123,
  checkpointHash: HASH,
  balanceOf: 2,
  tokenIds: [9n, 2n],
  source: 'fixture+ownerOf',
}), true);

let hit = await cache.readV4OwnershipCheckpoint({
  chainKey: 'base', manager: MANAGER, owner: OWNER,
});
assert.deepEqual(hit.tokenIds, [2n, 9n]);
assert.equal(hit.balanceOf, 2);
assert.equal(hit.checkedThrough, 123);
assert.equal(hit.checkpointHash, HASH);

assert.equal(await cache.readV4OwnershipCheckpoint({
  chainKey: 'ethereum', manager: MANAGER, owner: OWNER,
}), null, 'a checkpoint must be chain-scoped');

assert.equal(await cache.writeV4OwnershipCheckpoint({
  chainKey: 'base', manager: MANAGER, owner: OWNER,
  checkedThrough: 124, checkpointHash: HASH,
  balanceOf: 2, tokenIds: [2n],
}), false, 'balanceOf must equal the unique ID count');

const key = `${cache.V4_OWNERSHIP_PREFIX}base:${MANAGER}:${OWNER}`;
rows[key] = { ...rows[key], tokenIds: ['9', '2'] };
assert.equal(await cache.readV4OwnershipCheckpoint({
  chainKey: 'base', manager: MANAGER, owner: OWNER,
}), null, 'non-canonical persisted IDs must fail closed');

rows[key] = {
  ...rows[key], tokenIds: ['2', '2'], balanceOf: 2,
};
assert.equal(await cache.readV4OwnershipCheckpoint({
  chainKey: 'base', manager: MANAGER, owner: OWNER,
}), null, 'duplicate IDs must fail closed');

console.log('v4 ownership cache: exact schema, chain binding and corruption guards pass');
