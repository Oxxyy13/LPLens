// Independent, read-only adapter for the Robinhood Smart LP registry.
// Contract interfaces verified against Sourcify, chain 4663 (2026-09-10).
// Vault shares identify a holding; a keeper replacing its NFT does NOT open a
// new user investment. No signing, approvals, website data, or remote code.
import { CHAINS } from './chains.js';
import { ethCall, ethCallBatch, rpcCall, mapLimit } from './rpc.js';
import {
  encAddress, words, toUint, toInt, toAddress, decodeSymbol,
  dataBalanceOf, dataGetPool, dataOwnerOf, dataPositions, dataCollect,
  decodePositions, decodeSlot0, decodeUintArrayBounded,
} from './abi.js';
import { keccak256 } from './keccak.js';
import { positionAmounts, humanPrice, tickToPrice, scale } from './v3.js';

export const SMART_LP = Object.freeze({
  chainKey: 'robinhood',
  registry: '0xe8749183fbf6a657eb58b3a4d3e4b9cc09560146',
  maxVaults: 1_000,
});
const ZERO = '0x' + '0'.repeat(40);
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const lower = (s) => String(s || '').toLowerCase();
const hex = (n) => '0x' + BigInt(n).toString(16);
const digest = (s) => '0x' + [...keccak256(new TextEncoder().encode(s))]
  .map((n) => n.toString(16).padStart(2, '0')).join('');
export const smartLpSelector = (s) => digest(s).slice(0, 10);
export const SMART_LP_TOPIC = Object.freeze({
  transfer: digest('Transfer(address,address,uint256)'),
  deposit: digest('Deposited(address,address,uint256,uint256,uint256)'),
  withdraw: digest('Withdrawn(address,address,uint256,uint256,uint256)'),
});
const INPUTS = new Set([
  'deposit(uint256,uint256,uint256,address)',
  'depositSingle(uint256,uint256,address)',
  'zapDeposit(address,uint256,uint256,address)',
].map(smartLpSelector));
const OUTPUTS = new Set([
  'withdraw(uint256,uint256,uint256,bool,address)',
  'zapWithdraw(uint256,address,uint256,bool,address)',
].map(smartLpSelector));

export function normalizeSmartLpScope(raw, chainKey) {
  if (chainKey !== SMART_LP.chainKey) return { complete: true, addresses: [] };
  const values = Array.isArray(raw?.addresses) ? raw.addresses.map(lower) : [];
  const valid = values.length <= SMART_LP.maxVaults && values.every((a) => ADDRESS.test(a) && a !== ZERO);
  return { complete: raw?.complete === true && valid && Array.isArray(raw?.addresses)
      && lower(raw?.registry) === SMART_LP.registry,
    registry: SMART_LP.registry,
    addresses: [...new Set(values.filter((a) => ADDRESS.test(a) && a !== ZERO))].slice(0, SMART_LP.maxVaults) };
}

function requireThat(ok, reason) { if (!ok) throw new Error(`Smart LP: ${reason}`); }
function uint(blob) {
  requireThat(/^0x[0-9a-fA-F]{64}$/.test(blob), 'invalid integer response');
  return toUint(words(blob)[0]);
}
function address(blob) {
  const n = uint(blob);
  requireThat(n < 1n << 160n, 'invalid address response');
  return '0x' + n.toString(16).padStart(40, '0');
}
function eventAddress(topic) { return address(topic); }
function header(block) {
  requireThat(block && HASH.test(lower(block.hash)) && /^0x[0-9a-f]+$/i.test(block.number), 'block checkpoint unavailable');
  const n = Number(BigInt(block.number));
  requireThat(Number.isSafeInteger(n) && n >= 0, 'invalid block number');
  return { number: n, hash: lower(block.hash), tag: hex(n) };
}

// Batch only public read calls. Retry failed items through the existing bounded
// scalar path; a missing balance must never be interpreted as zero shares.
async function readBatch(rpc, calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 25) {
    const chunk = calls.slice(i, i + 25);
    let rows;
    try { rows = await ethCallBatch(rpc, chunk); } catch { rows = []; }
    const fixed = await mapLimit(chunk, 2, async (call, j) => {
      if (typeof rows[j] === 'string' && rows[j] !== '0x') return rows[j];
      return ethCall(rpc, call.to, call.data, call.from, call.block);
    });
    out.push(...fixed);
  }
  return out;
}

export async function smartLpRegistry(rpc, block) {
  const result = await ethCall(rpc, SMART_LP.registry, smartLpSelector('all()'), null, block);
  const decoded = decodeUintArrayBounded(result, SMART_LP.maxVaults);
  requireThat(decoded && !decoded.truncated, 'registry unreadable or too large');
  const addresses = decoded.values.map((n) => address('0x' + n.toString(16).padStart(64, '0')));
  requireThat(!addresses.includes(ZERO) && new Set(addresses).size === addresses.length, 'invalid registry membership');
  return addresses;
}

/** A complete, bounded, single-vault event read. Split capped RPC responses.
 * No explorer's first page or partial list is accepted as lifetime history. */
export async function smartLpLogs(rpc, vault, through) {
  let reads = 0;
  let count = 0;
  async function part(from, to) {
    requireThat(++reads <= 127, 'history exceeds read budget');
    let logs;
    try {
      logs = await rpcCall(rpc, 'eth_getLogs', [{ address: vault, fromBlock: hex(from), toBlock: hex(to) }]);
      requireThat(Array.isArray(logs), 'invalid history response');
      if (logs.length >= 5_000) throw new Error('log limit');
    } catch (error) {
      if (!/log.*limit|limit.*log|range.*(?:large|wide|exceed)|response.*size/i.test(error.message) || from >= to) throw error;
      const mid = Math.floor((from + to) / 2);
      return [...await part(from, mid), ...await part(mid + 1, to)];
    }
    count += logs.length;
    requireThat(count <= 20_000, 'history exceeds event budget');
    return logs;
  }
  const logs = await part(0, through);
  const seen = new Set();
  for (const log of logs) {
    const block = Number(BigInt(log.blockNumber));
    const key = `${lower(log.transactionHash)}:${log.logIndex}`;
    requireThat(lower(log.address) === vault && log.removed !== true
      && Number.isSafeInteger(block) && block >= 0 && block <= through
      && HASH.test(lower(log.transactionHash)) && HASH.test(lower(log.blockHash))
      && /^0x[0-9a-f]+$/i.test(log.logIndex) && !seen.has(key), 'untrusted or duplicate history event');
    seen.add(key);
  }
  return logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber))
    || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
}

/** Reconcile both total supply and this wallet's complete share movement.
 * Transfers, gifts, external recipients and routed withdrawals need their own
 * accounting model. Keep their current range/value but withhold lifetime PnL. */
export function reconcileSmartLpShares(logs, owner, shares, supply) {
  owner = lower(owner);
  let minted = 0n, balance = 0n;
  const movements = new Map();
  const flows = [];
  for (const log of logs) {
    const topic = lower(log.topics?.[0]);
    if (topic === SMART_LP_TOPIC.transfer) {
      requireThat(log.topics.length === 3, 'invalid share Transfer');
      const from = eventAddress(log.topics[1]), to = eventAddress(log.topics[2]);
      const amount = uint(log.data);
      if (from === ZERO) minted += amount;
      if (to === ZERO) minted -= amount;
      if (to === owner) balance += amount;
      if (from === owner) balance -= amount;
      requireThat(minted >= 0n && balance >= 0n, 'incomplete share history');
      if (amount && (to === owner || from === owner) && from !== to) {
        requireThat(from === ZERO || to === ZERO, 'transferred shares: lifetime accounting not supported yet');
        const key = `${lower(log.transactionHash)}:${to === owner ? 'deposit' : 'withdraw'}`;
        movements.set(key, (movements.get(key) || 0n) + amount);
      }
    } else if (topic === SMART_LP_TOPIC.deposit || topic === SMART_LP_TOPIC.withdraw) {
      requireThat(log.topics.length === 3 && /^0x[0-9a-f]{192}$/i.test(log.data), 'invalid cash-flow event');
      const from = eventAddress(log.topics[1]), to = eventAddress(log.topics[2]);
      if (from !== owner && to !== owner) continue;
      requireThat(from === owner && to === owner, 'third-party vault cash flow not supported yet');
      const w = words(log.data);
      const kind = topic === SMART_LP_TOPIC.deposit ? 'deposit' : 'withdraw';
      const key = `${lower(log.transactionHash)}:${kind}`;
      requireThat(!flows.some((flow) => flow.key === key), 'multiple cash flows in one transaction');
      flows.push({ key, kind, log, shares: toUint(w[2]), event0: toUint(w[0]), event1: toUint(w[1]) });
    }
  }
  requireThat(minted === BigInt(supply) && balance === BigInt(shares), 'share history does not reconcile');
  requireThat(flows.length > 0 && flows.length <= 100, 'cash-flow history missing or too large');
  requireThat(movements.size === flows.length && flows.every((flow) => movements.get(flow.key) === flow.shares), 'cash flows do not reconcile with shares');
  return flows;
}

/** Actual wallet/vault ERC-20 transfers, not the Deposited post-zap basket. */
export function smartLpExternalFlow(flow, receipt, transaction, owner, vault, tokens) {
  const log = flow.log;
  requireThat(receipt && lower(receipt.transactionHash) === lower(log.transactionHash)
    && lower(receipt.blockHash) === lower(log.blockHash)
    && BigInt(receipt.blockNumber) === BigInt(log.blockNumber) && BigInt(receipt.status) === 1n
    && lower(receipt.from) === owner && lower(receipt.to) === vault, 'cash-flow receipt unverified');
  requireThat(transaction && lower(transaction.hash) === lower(log.transactionHash)
    && lower(transaction.from) === owner && lower(transaction.to) === vault
    && BigInt(transaction.value) === 0n, 'native or routed cash flow not supported yet');
  const allowed = flow.kind === 'deposit' ? INPUTS : OUTPUTS;
  requireThat(allowed.has(lower(transaction.input).slice(0, 10)), 'unsupported cash-flow method');
  requireThat(Array.isArray(receipt.logs) && receipt.logs.some((r) =>
    lower(r.address) === vault && r.logIndex === log.logIndex && lower(r.data) === lower(log.data)
      && JSON.stringify(r.topics.map(lower)) === JSON.stringify(log.topics.map(lower))), 'cash-flow event absent from receipt');
  const incoming = [0n, 0n], outgoing = [0n, 0n];
  for (const r of receipt.logs) {
    const i = tokens.indexOf(lower(r.address));
    if (i < 0 || lower(r.topics?.[0]) !== SMART_LP_TOPIC.transfer) continue;
    requireThat(r.topics.length === 3, 'invalid asset Transfer');
    const from = eventAddress(r.topics[1]), to = eventAddress(r.topics[2]);
    const n = uint(r.data);
    if (from === owner && to === vault) incoming[i] += n;
    if (from === vault && to === owner) outgoing[i] += n;
    requireThat(!(n && (from === owner || to === owner)
      && !(from === owner && to === vault) && !(from === vault && to === owner)), 'external wallet movement in vault transaction');
  }
  if (flow.kind === 'withdraw') {
    requireThat(incoming.every((n) => n === 0n) && outgoing[0] === flow.event0 && outgoing[1] === flow.event1,
      'withdrawal assets unverified (native withdrawals are not supported yet)');
    return outgoing;
  }
  const net = incoming.map((n, i) => n - outgoing[i]);
  requireThat(net.every((n) => n >= 0n) && net.some((n) => n > 0n), 'deposit assets unverified');
  return net;
}

async function attachVaultHistory(rpc, p, owner, checkpoint) {
  try {
    requireThat(!p.vault.valueUnavailable, p.vault.valueUnavailable);
    const logs = await smartLpLogs(rpc, p.vault.address, checkpoint.number);
    const flows = reconcileSmartLpShares(logs, owner, p.vault.shares, p.vault.totalSupply);
    const blocks = new Map();
    const rows = await mapLimit(flows, 2, async (flow) => {
      const blockTag = hex(BigInt(flow.log.blockNumber));
      // A full block gives the original input/value without widening the issued
      // RPC method allowlist. Native deposits must not become partial ERC-20 basis.
      if (!blocks.has(blockTag)) blocks.set(blockTag, rpcCall(rpc, 'eth_getBlockByNumber', [blockTag, true]));
      const [receipt, block] = await Promise.all([
        rpcCall(rpc, 'eth_getTransactionReceipt', [flow.log.transactionHash]), blocks.get(blockTag),
      ]);
      const h = header(block);
      requireThat(h.tag === blockTag && h.hash === lower(flow.log.blockHash), 'cash-flow block changed');
      const time = Number(BigInt(block.timestamp));
      requireThat(Number.isSafeInteger(time) && time > 0, 'cash-flow timestamp unavailable');
      const tx = block.transactions?.find((t) => lower(t.hash) === lower(flow.log.transactionHash));
      const raw = smartLpExternalFlow(flow, receipt, tx, owner, p.vault.address, [p.token0, p.token1]);
      return { kind: flow.kind, block: h.number, time, transactionHash: flow.log.transactionHash,
        logIndex: Number(BigInt(flow.log.logIndex)), amount0Raw: raw[0], amount1Raw: raw[1],
        amount0: scale(Number(raw[0]), p.token0Meta.decimals), amount1: scale(Number(raw[1]), p.token1Meta.decimals),
        entry: null };
    });
    const failed = rows.find((row) => row.__error);
    requireThat(!failed, failed?.__error);
    const deposits = rows.filter((row) => row.kind === 'deposit');
    const collections = rows.filter((row) => row.kind === 'withdraw');
    requireThat(deposits.length > 0, 'original deposit not found');
    const sum = (items, key) => items.reduce((s, r) => s + r[key], 0);
    const deposited0 = sum(deposits, 'amount0'), deposited1 = sum(deposits, 'amount1');
    const received0 = sum(collections, 'amount0'), received1 = sum(collections, 'amount1');
    const held = deposited0 * p.price + deposited1;
    const delta = (p.amount0 + p.collectable0 - deposited0) * p.price + p.amount1 + p.collectable1 - deposited1;
    return { ...p, history: { source: 'vault-receipts', checkedThrough: checkpoint.number,
      deposits, collections, adds: deposits.length, firstBlock: deposits[0].block, firstTime: deposits[0].time,
      deposited0, deposited1, received0, received1, fees0: null, fees1: null,
      // Partial withdrawals require a time-matched holding benchmark. Do not
      // pretend withdrawn tokens are still held or split compounding into IL.
      vsHodl: !collections.length && held > 0 ? { delta, pct: delta / held * 100, price: p.price, pricedAt: 'spot' } : null,
      vsHodlUnavailable: collections.length ? 'holding comparison after withdrawals is not supported yet' : null,
    } };
  } catch (error) { return { ...p, history: { unavailable: error.message || String(error) } }; }
}

/** Read one current holding at one checkpoint. NFT custody/pool identity are
 * checked afresh, including on the fast current-position refresh path. */
export async function loadSmartLpVault(rpc, owner, vault, checkpoint) {
  owner = lower(owner); vault = lower(vault);
  requireThat(ADDRESS.test(owner) && ADDRESS.test(vault) && vault !== ZERO, 'invalid holding identity');
  const block = checkpoint.tag;
  const names = ['pool', 'token0', 'token1', 'nfpm', 'poolFee', 'mode', 'positionId', 'totalSupply',
    'tickLower', 'tickUpper', 'perfFeeBps', 'withdrawFeeBps', 'feeManager', 'lastRecenterAt', 'baseIsToken0'];
  const calls = names.map((n) => ({ to: vault, data: smartLpSelector(`${n}()`), block }));
  calls.push({ to: vault, data: dataBalanceOf(owner), block });
  calls.push({ to: SMART_LP.registry, data: smartLpSelector('isListed(address)') + encAddress(vault), block });
  const blobs = await readBatch(rpc, calls);
  requireThat(blobs.every((r) => typeof r === 'string'), 'vault state unavailable');
  const vals = Object.fromEntries(names.map((n, i) => [n, blobs[i]]));
  const shares = uint(blobs[names.length]);
  requireThat(uint(blobs[names.length + 1]) === 1n, 'vault no longer listed');
  if (!shares) return null;
  const pool = address(vals.pool), token0 = address(vals.token0), token1 = address(vals.token1), nfpm = address(vals.nfpm);
  const totalSupply = uint(vals.totalSupply), id = uint(vals.positionId);
  const mode = Number(uint(vals.mode)), fee = Number(uint(vals.poolFee));
  const perfFeeBps = Number(uint(vals.perfFeeBps)), withdrawFeeBps = Number(uint(vals.withdrawFeeBps));
  const tickLower = Number(toInt(words(vals.tickLower)[0])), tickUpper = Number(toInt(words(vals.tickUpper)[0]));
  requireThat(shares <= totalSupply && totalSupply > 0n && mode <= 2
    && perfFeeBps <= 10_000 && withdrawFeeBps <= 10_000, 'invalid share or fee state');
  requireThat(nfpm === lower(CHAINS.robinhood.nfpm) && token0 !== ZERO && token1 !== ZERO && token0 !== token1,
    'unsupported vault deployment');
  const stateCalls = [
    { to: CHAINS.robinhood.factory, data: dataGetPool(token0, token1, fee), block },
    { to: pool, data: smartLpSelector('slot0()'), block },
    ...[token0, token1].flatMap((to) => [
      { to, data: smartLpSelector('symbol()'), block },
      { to, data: smartLpSelector('decimals()'), block },
      { to, data: dataBalanceOf(vault), block },
    ]),
    ...(id ? [{ to: nfpm, data: dataPositions(id), block }, { to: nfpm, data: dataOwnerOf(id), block }] : []),
  ];
  const state = await readBatch(rpc, stateCalls);
  requireThat(state.every((r) => typeof r === 'string'), 'underlying assets unavailable');
  requireThat(address(state[0]) === pool && pool !== ZERO, 'underlying pool not verified');
  const slot = decodeSlot0(state[1]);
  requireThat(slot && slot.sqrtPriceX96 > 0n, 'pool price unavailable');
  const token0Meta = { symbol: decodeSymbol(state[2]).slice(0, 40), decimals: Number(uint(state[3])) };
  const token1Meta = { symbol: decodeSymbol(state[5]).slice(0, 40), decimals: Number(uint(state[6])) };
  requireThat(token0Meta.decimals <= 36 && token1Meta.decimals <= 36, 'unsupported token decimals');
  const nft = id ? decodePositions(state[8]) : { liquidity: 0n, tickLower, tickUpper };
  if (id) requireThat(nft && address(state[9]) === vault && nft.token0 === token0 && nft.token1 === token1
    && nft.fee === fee && nft.tickLower === tickLower && nft.tickUpper === tickUpper, 'underlying NFT does not match vault');
  const validRange = tickLower >= -887272 && tickUpper <= 887272 && tickLower < tickUpper;
  requireThat(!nft.liquidity || validRange, 'invalid vault range');
  const amount = positionAmounts({ ...nft, sqrtPriceX96: slot.sqrtPriceX96 });
  const fraction = Number(shares) / Number(totalSupply);
  const exitFactor = (10_000 - withdrawFeeBps) / 10_000;
  const feesFactor = (10_000 - perfFeeBps) / 10_000;
  let pending = id ? null : [0n, 0n];
  let valueUnavailable = address(vals.feeManager) !== ZERO ? 'harvest-mode fee routing is not supported yet' : null;
  if (id && !valueUnavailable) {
    try {
      const collected = await ethCall(rpc, nfpm, dataCollect(id, vault), vault, block);
      requireThat(/^0x[0-9a-f]{128}$/i.test(collected), 'pending fees unavailable');
      pending = words(collected).map(toUint);
    } catch { valueUnavailable = 'pending vault fees unavailable'; }
  }
  const strategy = ['Full range', 'Balanced band', 'Single-sided ask'][mode];
  const p = {
    chainKey: SMART_LP.chainKey, version: 'vault', protocol: 'Smart LP', deploymentId: 'smart-lp',
    manager: vault, tokenId: BigInt(vault), ownerAddress: owner, pool, token0, token1, fee,
    token0Meta, token1Meta, tickLower, tickUpper, liquidity: nft.liquidity,
    currentTick: slot.tick, price: humanPrice(slot.sqrtPriceX96, token0Meta.decimals, token1Meta.decimals),
    priceLower: nft.liquidity ? tickToPrice(tickLower, token0Meta.decimals, token1Meta.decimals) : null,
    priceUpper: nft.liquidity ? tickToPrice(tickUpper, token0Meta.decimals, token1Meta.decimals) : null,
    amount0: scale((amount.amount0 + Number(uint(state[4]))) * fraction * exitFactor, token0Meta.decimals),
    amount1: scale((amount.amount1 + Number(uint(state[7]))) * fraction * exitFactor, token1Meta.decimals),
    collectable0: pending && !valueUnavailable ? scale(Number(pending[0]) * fraction * feesFactor * exitFactor, token0Meta.decimals) : null,
    collectable1: pending && !valueUnavailable ? scale(Number(pending[1]) * fraction * feesFactor * exitFactor, token1Meta.decimals) : null,
    status: nft.liquidity ? amount.status : 'idle',
    vault: { address: vault, registry: SMART_LP.registry, shares: String(shares), totalSupply: String(totalSupply),
      sharePercent: fraction * 100, mode, strategy, positionId: String(id), nfpm, baseIsToken0: uint(vals.baseIsToken0) === 1n,
      perfFeeBps, withdrawFeeBps, lastRecenterAt: Number(uint(vals.lastRecenterAt)), valueUnavailable,
      checkpoint: checkpoint.number, valueConvention: 'estimated exit value; after vault fees, before gas' },
  };
  return attachVaultHistory(rpc, p, owner, checkpoint);
}

/** Full scan enumerates registry balances, current refresh only remembered
 * vaults. Read failures preserve identity and are explicit, not empty wallets. */
export async function scanSmartLp(owner, opts = {}, knownAddresses = null) {
  if (Array.isArray(knownAddresses) && !knownAddresses.length) {
    return { positions: [], unreadable: 0, unavailable: null,
      discovery: { complete: true, registry: SMART_LP.registry, addresses: [] } };
  }
  const rpc = opts.rpcOverride || CHAINS.robinhood.rpc;
  let addresses = knownAddresses === null ? [] : [...new Set(knownAddresses.map(lower))];
  let positions = [], unreadable = 0;
  const kept = [], errors = [];
  try {
    const checkpoint = header(await rpcCall(rpc, 'eth_getBlockByNumber', ['latest', false]));
    addresses = knownAddresses === null ? await smartLpRegistry(rpc, checkpoint.tag) : [...new Set(knownAddresses.map(lower))];
    requireThat(addresses.length <= SMART_LP.maxVaults && addresses.every((a) => ADDRESS.test(a) && a !== ZERO), 'invalid remembered vaults');
    const balances = await readBatch(rpc, addresses.map((to) => ({ to, data: dataBalanceOf(owner), block: checkpoint.tag })));
    const held = [];
    balances.forEach((r, i) => {
      try { if (uint(r) > 0n) held.push(addresses[i]); }
      catch { unreadable++; kept.push(addresses[i]); }
    });
    const rows = await mapLimit(held, 2, (a) => loadSmartLpVault(rpc, owner, a, checkpoint));
    rows.forEach((p, i) => {
      if (p?.__error) { unreadable++; errors.push(p.__error); kept.push(held[i]); }
      else if (p) { positions.push(p); kept.push(held[i]); }
    });
    const end = header(await rpcCall(rpc, 'eth_getBlockByNumber', [checkpoint.tag, false]));
    requireThat(end.hash === checkpoint.hash, 'checkpoint changed during scan; refresh again');
  } catch (error) {
    errors.push(error.message || String(error));
    unreadable++;
    positions = [];
    kept.push(...addresses);
  }
  return { positions, unreadable, unavailable: unreadable ? errors[0] || 'Smart LP: some vault balances could not be read' : null,
    discovery: { complete: unreadable === 0, registry: SMART_LP.registry, addresses: [...new Set(kept)] } };
}
