// Synthetic data only. No real wallet, deposit, access code or provider key.
import { SMART_LP, SMART_LP_TOPIC, smartLpSelector as sel } from '../../extension/lib/smart-lp.js';
import { CHAINS } from '../../extension/lib/chains.js';
export const OWNER = '0x' + '11'.repeat(20);
export const VAULT = '0x' + '22'.repeat(20);
export const POOL = '0x' + '33'.repeat(20);
export const TOKEN0 = '0x' + '44'.repeat(20);
export const TOKEN1 = '0x' + '55'.repeat(20);
export const ZERO = '0x' + '00'.repeat(20);
export const TX = '0x' + 'ab'.repeat(32);
export const BLOCK_HASH = '0x' + 'cd'.repeat(32);
export const UNIT = 10n ** 18n;
export const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
export const blob = (...ns) => '0x' + ns.map(word).join('');
export const addrTopic = (a) => blob(BigInt(a));
export const log = (address, topics, data, index, tx = TX) => ({
  address, topics, data, logIndex: '0x' + index.toString(16),
  blockNumber: '0x64', blockHash: BLOCK_HASH, transactionHash: tx, removed: false,
});
export const transfer = (address, from, to, value, index, tx = TX) =>
  log(address, [SMART_LP_TOPIC.transfer, addrTopic(from), addrTopic(to)], blob(value), index, tx);
export const deposit = () => log(VAULT, [SMART_LP_TOPIC.deposit, addrTopic(OWNER), addrTopic(OWNER)],
  blob(2n * UNIT, 3n * UNIT, 100), 4);

export function fixture(overrides = {}) {
  const state = {
    shares: 100n, supply: 1000n, id: 7n, liquidity: UNIT, mode: 1, manager: ZERO,
    decimals0: 18, decimals1: 18, feeFailure: false, wrongPool: false, wrongOwner: false,
    balanceFailure: false, blockFailure: false, registryFailure: false, reorg: false,
    logLimitOnce: false, truncatedHistory: false, nativeValue: 0n,
    ...overrides,
  };
  const history = [
    transfer(VAULT, ZERO, '0x' + '99'.repeat(20), 900n, 0),
    transfer(VAULT, ZERO, OWNER, 100n, 3), deposit(),
  ];
  const receipt = {
    transactionHash: TX, blockHash: BLOCK_HASH, blockNumber: '0x64', status: '0x1', from: OWNER, to: VAULT,
    logs: [transfer(TOKEN1, OWNER, VAULT, 10n * UNIT, 1), history[1], history[2]],
  };
  const transaction = { hash: TX, from: OWNER, to: VAULT, value: '0x0',
    input: sel('zapDeposit(address,uint256,uint256,address)') + word(TOKEN1) + word(10n * UNIT) + word(0) + word(OWNER) };
  const calls = [];
  const getters = () => ({
    pool: BigInt(POOL), token0: BigInt(TOKEN0), token1: BigInt(TOKEN1), nfpm: BigInt(CHAINS.robinhood.nfpm),
    poolFee: 10_000, mode: state.mode, positionId: state.id, totalSupply: state.supply,
    tickLower: -200, tickUpper: 200, perfFeeBps: 1000, withdrawFeeBps: 10,
    feeManager: BigInt(state.manager), lastRecenterAt: 1788968381, baseIsToken0: 0,
  });
  function answer(call) {
    calls.push(call);
    if (call.method === 'eth_getBlockByNumber') {
      if (state.blockFailure) throw new Error('checkpoint unavailable');
      return { number: call.params[0] === 'latest' ? '0xc8' : call.params[0],
        hash: state.reorg && call.params[0] === '0xc8' ? '0x' + 'ef'.repeat(32) : BLOCK_HASH,
        timestamp: '0x6aa00000', transactions: call.params[1] ? [{ ...transaction, value: '0x' + state.nativeValue.toString(16) }] : [TX] };
    }
    if (call.method === 'eth_getLogs') {
      if (state.logLimitOnce && call.params[0].fromBlock === '0x0' && call.params[0].toBlock === '0xc8') {
        throw new Error('logs matched by query exceeds limit of 10000');
      }
      return (state.truncatedHistory ? history.slice(1) : history).filter((l) =>
        BigInt(l.blockNumber) >= BigInt(call.params[0].fromBlock) && BigInt(l.blockNumber) <= BigInt(call.params[0].toBlock));
    }
    if (call.method === 'eth_getTransactionReceipt') return receipt;
    if (call.method !== 'eth_call') throw new Error('non-read RPC method');
    const c = call.params[0], to = c.to.toLowerCase(), s = c.data.slice(0, 10);
    if (to === SMART_LP.registry) {
      if (state.registryFailure) throw new Error('registry unavailable');
      if (s === sel('all()')) return blob(32, 1, BigInt(VAULT));
      if (s === sel('isListed(address)')) return blob(1);
    }
    if (to === VAULT) {
      if (s === sel('balanceOf(address)')) {
        if (state.balanceFailure) throw new Error('vault balance unavailable');
        return blob(state.shares);
      }
      const g = Object.entries(getters()).find(([n]) => sel(n + '()') === s);
      if (g) return blob(g[1]);
    }
    if (to === CHAINS.robinhood.factory.toLowerCase() && s === sel('getPool(address,address,uint24)')) return blob(BigInt(state.wrongPool ? ZERO : POOL));
    if (to === POOL && s === sel('slot0()')) return blob(1n << 96n, 0);
    if (to === TOKEN0 || to === TOKEN1) {
      if (s === sel('symbol()')) return '0x' + Buffer.from(to === TOKEN0 ? 'WETH' : 'EXAMPLE').toString('hex').padEnd(64, '0');
      if (s === sel('decimals()')) return blob(to === TOKEN0 ? state.decimals0 : state.decimals1);
      if (s === sel('balanceOf(address)')) return blob(to === TOKEN0 ? UNIT : 2n * UNIT);
    }
    if (to === CHAINS.robinhood.nfpm.toLowerCase()) {
      if (s === sel('positions(uint256)')) return blob(0, 0, BigInt(TOKEN0), BigInt(TOKEN1), 10000, -200, 200, state.liquidity, 0, 0, 0, 0);
      if (s === sel('ownerOf(uint256)')) return blob(BigInt(state.wrongOwner ? OWNER : VAULT));
      if (s === sel('collect((uint256,address,uint128,uint128))')) {
        if (state.feeFailure) throw new Error('collect unavailable');
        return blob(UNIT, 0);
      }
    }
    // Empty ordinary NFT/gauge enumeration for the mixed-protocol integration test.
    if ([sel('balanceOf(address)'), sel('length()')].includes(s)) return blob(0);
    throw new Error(`Unexpected fixture RPC ${to} ${s}`);
  }
  const fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    const one = (call) => {
      try { return { jsonrpc: '2.0', id: call.id, result: answer(call) }; }
      catch (e) { return { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: e.message } }; }
    };
    return { ok: true, status: 200, headers: { get: () => null },
      json: async () => Array.isArray(payload) ? payload.map(one) : one(payload) };
  };
  return { state, history, receipt, transaction, calls, fetch };
}
