import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CHAINS, V3_DEPLOYMENTS, v3Deployment, v3DeploymentsFor,
} from '../extension/lib/chains.js';
import {
  SELECTOR, dataSlipstreamGetPool, dataStoredClReward, decodePositions,
  decodeUintArrayBounded, padWord,
} from '../extension/lib/abi.js';
import { clGaugeRewardTotal, loadPositions } from '../extension/lib/positions.js';
import { historyIdentity } from '../extension/lib/cache.js';
import { positionRefreshIdentity } from '../extension/lib/refresh-deltas.js';

const ADDRESS = (char) => `0x${char.repeat(40)}`;
const word = (value) => padWord(value);
const signedWord = (value) => word(BigInt(value) < 0n ? (1n << 256n) + BigInt(value) : value);
const tuple = ({ word4 = 200, liquidity = 9 } = {}) => `0x${[
  word(0), word(0), word(ADDRESS('1')), word(ADDRESS('2')), word(word4),
  signedWord(-400), signedWord(600), word(liquidity), word(0), word(0), word(0), word(0),
].join('')}`;

const robinhood = CHAINS.robinhood;
const deployments = v3DeploymentsFor('robinhood');
const up33 = v3Deployment('robinhood', 'up33-cl');
assert.equal(deployments.length, 2);
assert.equal(V3_DEPLOYMENTS.robinhood, deployments);
assert.equal(deployments[0].nfpm.toLowerCase(), robinhood.nfpm.toLowerCase());
assert.equal(up33.kind, 'slipstream');
assert.equal(up33.protocol, 'UP33');
assert.equal(up33.nfpm.toLowerCase(), '0x07f44c47743a2f36414a82b9f558ecfcf0eedcef');
assert.equal(up33.factory.toLowerCase(), '0x1ac9db4a2608ba45d6127b1737949b51bb54b7f3');
assert.equal(up33.voter.toLowerCase(), '0x7f749fdd351c1ceed82d76d7699cb631eb8332a7');
assert.equal(up33.rewardToken.toLowerCase(), '0x57c0e45cb534413d1c20a4240955d6bb250bb4f1');
assert.equal(up33.rewardSymbol, 'UP');
assert.equal(up33.rewardDecimals, 18);

assert.equal(SELECTOR.slipstreamGetPool, '0x28af8d0b');
assert.equal(SELECTOR.poolFee, '0xddca3f43');
assert.equal(SELECTOR.stakedValues, '0x4b937763');
assert.equal(SELECTOR.stakedContains, '0xc69deec5');
assert.equal(SELECTOR.allPoolsLength, '0xefde4e64');
assert.equal(SELECTOR.allPools, '0x41d1de97');
assert.equal(SELECTOR.isPool, '0x5b16ebb7');
assert.equal(SELECTOR.earnedCl, '0x3e491d47');
assert.equal(SELECTOR.storedClReward, '0xf301af42');
assert.match(dataSlipstreamGetPool(ADDRESS('1'), ADDRESS('2'), 200), /^0x28af8d0b/);
assert.match(dataStoredClReward(7), /^0xf301af42/);
assert.equal(clGaugeRewardTotal(`0x${word(5)}`, `0x${word(7)}`), 12n);
assert.equal(clGaugeRewardTotal(`0x${word(5)}`, null), null,
  'a partial gauge reward read must fail closed instead of underreporting');
const bounded = decodeUintArrayBounded(
  `0x${word(32)}${word(3)}${word(1)}${word(2)}${word(3)}`, 2,
);
assert.deepEqual(bounded.values, [1n, 2n]);
assert.equal(bounded.truncated, true);

const slipstream = decodePositions(tuple(), 'slipstream');
assert.equal(slipstream.tickSpacing, 200);
assert.equal(slipstream.fee, null, 'tick spacing must never masquerade as a fee');
assert.equal(slipstream.tickLower, -400);
assert.equal(slipstream.tickUpper, 600);
assert.equal(slipstream.liquidity, 9n);
const uniswap = decodePositions(tuple({ word4: 10_000 }), 'uniswap-v3');
assert.equal(uniswap.fee, 10_000);
assert.equal(Object.hasOwn(uniswap, 'tickSpacing'), false);

const identityBase = {
  token0: ADDRESS('1'), token1: ADDRESS('2'), pool: ADDRESS('3'),
  tickSpacing: 200, fee: 100, tickLower: -400, tickUpper: 600,
  version: 'v3',
};
assert.equal(
  historyIdentity(identityBase),
  historyIdentity({ ...identityBase, fee: 10_000 }),
  'a dynamic fee update must not invalidate immutable history identity',
);
assert.equal(
  positionRefreshIdentity(identityBase),
  positionRefreshIdentity({ ...identityBase, fee: 10_000 }),
  'a dynamic fee update must not reset local refresh comparisons',
);

const OWNER = ADDRESS('a');
const GAUGE = ADDRESS('b');
const POOL = ADDRESS('c');
const TOKEN_ID = 7n;
const addressResult = (address) => `0x${word(address)}`;
const arrayResult = (values) => `0x${word(32)}${word(values.length)}${values.map(word).join('')}`;
const bytes32Text = (value) => `0x${Buffer.from(value).toString('hex').padEnd(64, '0')}`;

function custodyRaceRpc({ directCount, stillStaked, name }) {
  const calls = [];
  const manager = up33.nfpm.toLowerCase();
  const factory = up33.factory.toLowerCase();
  const voter = up33.voter.toLowerCase();
  const gauge = GAUGE.toLowerCase();
  const pool = POOL.toLowerCase();
  const token0 = ADDRESS('1').toLowerCase();
  const token1 = ADDRESS('2').toLowerCase();

  const answer = (request) => {
    assert.equal(request.method, 'eth_call');
    const tx = request.params[0];
    const to = String(tx.to).toLowerCase();
    const data = String(tx.data).toLowerCase();
    const selector = data.slice(0, 10);
    calls.push(selector);

    if (to === manager && selector === SELECTOR.balanceOf) return `0x${word(directCount)}`;
    if (to === manager && selector === SELECTOR.tokenOfOwnerByIndex) return `0x${word(TOKEN_ID)}`;
    if (to === manager && selector === SELECTOR.positions) return tuple();
    if (to === manager && selector === SELECTOR.ownerOf) return addressResult(GAUGE);
    if (to === voter && selector === SELECTOR.voterLength) return `0x${word(1)}`;
    if (to === voter && selector === SELECTOR.voterPools) return addressResult(POOL);
    if (to === voter && selector === SELECTOR.voterGauges) return addressResult(GAUGE);
    if (to === factory && selector === SELECTOR.isPool) return `0x${word(1)}`;
    if (to === factory && selector === SELECTOR.slipstreamGetPool) return addressResult(POOL);
    if (to === gauge && selector === SELECTOR.stakedValues) return arrayResult([TOKEN_ID]);
    if (to === gauge && selector === SELECTOR.stakedContains) {
      return `0x${word(stillStaked ? 1 : 0)}`;
    }
    if (to === gauge && selector === SELECTOR.earnedCl) return `0x${word(3)}`;
    if (to === gauge && selector === SELECTOR.storedClReward) return `0x${word(2)}`;
    if (to === pool && selector === SELECTOR.slot0) return `0x${word(2n ** 96n)}${word(0)}`;
    if (to === pool && selector === SELECTOR.poolFee) return `0x${word(10_000)}`;
    if ((to === token0 || to === token1) && selector === SELECTOR.symbol) {
      return bytes32Text(to === token0 ? 'T0' : 'T1');
    }
    if ((to === token0 || to === token1) && selector === SELECTOR.decimals) {
      return `0x${word(18)}`;
    }
    throw new Error(`unhandled ${name} RPC ${to} ${selector}`);
  };

  return {
    url: `https://${name}.invalid`,
    calls,
    fetch: async (_url, init) => {
      const payload = JSON.parse(init.body);
      if (Array.isArray(payload)) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => payload.map((request) => ({
            jsonrpc: '2.0', id: request.id, result: answer(request),
          })),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ jsonrpc: '2.0', id: payload.id, result: answer(payload) }),
      };
    },
  };
}

const originalFetch = globalThis.fetch;
try {
  // The wallet enumeration sees the NFT just before it is deposited. Gauge
  // enumeration then sees the same manager/tokenId with a final true proof.
  const duplicateRace = custodyRaceRpc({
    directCount: 1, stillStaked: true, name: 'up33-duplicate',
  });
  globalThis.fetch = duplicateRace.fetch;
  const duplicateResult = await loadPositions('robinhood', OWNER, {
    rpcOverride: duplicateRace.url,
    v3DeploymentIds: ['up33-cl'],
    skipV4: true,
    withUsd: false,
  });
  assert.equal(duplicateResult.positions.length, 1,
    'one NFT observed through wallet and gauge paths must render once');
  assert.equal(duplicateResult.positions[0].custody, 'gauge',
    'the final gauge proof must replace the stale direct-custody row');
  assert.deepEqual(duplicateResult.discovery.v3.records.map((record) => ({
    tokenId: record.tokenId, custody: record.custody, custodian: record.custodian,
  })), [{ tokenId: '7', custody: 'gauge', custodian: GAUGE.toLowerCase() }],
  'the current-position index must receive one gauge-scoped record');
  assert.ok(
    duplicateRace.calls.lastIndexOf(SELECTOR.stakedContains)
      > duplicateRace.calls.lastIndexOf(SELECTOR.ownerOf),
    'stakedContains must be the final custody read after ownerOf',
  );
  assert.ok(
    duplicateRace.calls.lastIndexOf(SELECTOR.stakedContains)
      > duplicateRace.calls.lastIndexOf(SELECTOR.positions),
    'stakedContains must run after the candidate position read',
  );

  // The initial stakedValues result is stale. ownerOf still says the gauge,
  // but a final false beneficial-ownership proof must remove the candidate.
  const staleRace = custodyRaceRpc({
    directCount: 0, stillStaked: false, name: 'up33-stale',
  });
  globalThis.fetch = staleRace.fetch;
  const staleResult = await loadPositions('robinhood', OWNER, {
    rpcOverride: staleRace.url,
    v3DeploymentIds: ['up33-cl'],
    skipV4: true,
    withUsd: false,
  });
  assert.equal(staleResult.positions.length, 0,
    'stale stakedValues membership must not attribute a gauge NFT to the old owner');
  assert.equal(staleResult.discovery.v3.records.length, 0,
    'a failed final custody proof must not enter the current-position index');
  assert.equal(staleResult.enumUnreadable, 0,
    'a clean false proof is a resolved ownership change, not an RPC failure');
} finally {
  globalThis.fetch = originalFetch;
}

const source = readFileSync(new URL('../extension/lib/positions.js', import.meta.url), 'utf8');
assert.match(source, /scanSlipstreamStakes/);
assert.match(source, /custody === 'gauge'/);
assert.match(source, /attachDeploymentHistory/);
assert.match(source, /fetchExactTokenTransfers/);
assert.match(source, /exactly one mint directly to the current owner is required/);
assert.match(source, /historical gauge emissions and trading fees are included/);
assert.match(source, /dataStakedContains\(owner, item\.tokenId\)/);
assert.match(source, /clGaugeRewardTotal\(storedRewardHex, earnedRewardHex\)/);

console.log('UP33 config: deployment isolation, final gauge custody, race de-duplication, complete rewards and dynamic fee identity pass');
