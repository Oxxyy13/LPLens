/**
 * Event-log retrieval, source-agnostic.
 *
 * Lifetime history needs every log for one position across all of chain
 * history. Whether that is cheap depends entirely on the endpoint, and the
 * measured landscape as of 2026-08-19 is:
 *
 *   - Robinhood Chain's public RPC serves unbounded eth_getLogs, keylessly.
 *   - No public Ethereum RPC does. Verified refusals from eth.drpc.org (10k
 *     blocks), ethereum-rpc.publicnode.com (archive needs a token),
 *     rpc.ankr.com (key), rpc.mevblocker.io (10k), eth-pokt.nodies.app,
 *     rpc.flashbots.net (pruned), cloudflare-eth.com, eth.merkle.io.
 *   - Alchemy's FREE tier caps eth_getLogs at a **10 block** range, so a free
 *     key does not help. PAYG lifts it.
 *   - Etherscan V2 serves full-range topic-filtered getLogs on a free key
 *     for Ethereum (1), Arbitrum (42161), Polygon (137), and HyperEVM (999).
 *     On Base (8453)
 *     a free key returns HTTP 200 with status "0", message "NOTOK", result
 *     "Free API access is not supported for this chain...". That is a
 *     refusal, not an empty result — a transport-level 200 is not enough.
 *   - Blockscout serves the same Etherscan-compatible getLogs keylessly on
 *     eth / base / arbitrum / polygon.blockscout.com (verified live
 *     2026-08-19). Documented cap is 1,000 logs per query; page/offset is
 *     ignored, so we walk fromBlock instead of truncating.
 *
 * Source order: Etherscan (only when a user key is configured) -> licensed
 * hosted history relay (Blockscout Pro on Uniswap chains, Etherscan on
 * HyperEVM) -> public Blockscout (when the chain has a URL) -> raw
 * eth_getLogs. All sources return the same normalised shape, and
 * fetchPositionLogs never throws — a missing history must read as
 * "unavailable", never as "no activity".
 */
import { rpcCall } from './rpc.js';

const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';

// Etherscan's free tier allows 3 requests/second. Position loads run
// concurrently, so without a throttle a multi-position scan bursts well past
// that and starts collecting rejections — which would surface as history
// randomly "unavailable" on some cards and not others. One shared serialiser
// spaces every Etherscan request by the minimum interval.
const ETHERSCAN_MIN_GAP_MS = 360;
let etherscanChain = Promise.resolve();
function etherscanSlot() {
  const wait = etherscanChain.then(
    () => new Promise((r) => setTimeout(r, ETHERSCAN_MIN_GAP_MS)));
  etherscanChain = wait;
  return wait;
}

// Blockscout public instances advertise ~180 req / window on eth/arb/polygon
// and a much tighter 10 on Base (verified in response headers 2026-08-19).
// Same serialiser shape as Etherscan so a 3-wide position scan cannot burst.
const BLOCKSCOUT_MIN_GAP_MS = 250;
let blockscoutChain = Promise.resolve();
function blockscoutSlot() {
  const wait = blockscoutChain.then(
    () => new Promise((r) => setTimeout(r, BLOCKSCOUT_MIN_GAP_MS)));
  blockscoutChain = wait;
  return wait;
}
const HISTORY_RELAY_MIN_GAP_MS = 360;
let historyRelayChain = Promise.resolve();
function historyRelaySlot() {
  const wait = historyRelayChain.then(
    () => new Promise((r) => setTimeout(r, HISTORY_RELAY_MIN_GAP_MS)));
  historyRelayChain = wait;
  return wait;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Blockscout getLogs hard-caps at 1,000 (docs + live WETH Transfer probe). */
const BLOCKSCOUT_PAGE = 1000;
/** Positions do not have tens of thousands of events; this is a runaway guard. */
const BLOCKSCOUT_MAX_PAGES = 50;
// Windows tried, newest-first, when locating the last log at or before a
// block. A deep pool resolves on the first; a quiet one widens.
const EXPLORER_SPANS = Object.freeze([500, 5000, 50000]);
const EXPLORER_MAX_PAGES = 8;
// rpcCall already retries provider-declared capacity failures. This outer,
// bounded retry also covers malformed replies and errors a provider labels as
// permanent even though a second identical read can succeed. More importantly,
// the caller never moves to an older interval until this one has returned a
// well-formed empty result.
const RPC_LAST_LOG_ATTEMPTS = 3;
const RPC_LAST_LOG_RETRY_MS = 100;

/** Normalised log: what history.js consumes, regardless of source. */
const normalise = (log) => ({
  topics: log.topics || [],
  data: log.data || '0x',
  block: Number(BigInt(log.blockNumber)),
  transactionHash: log.transactionHash || null,
  logIndex: log.logIndex === undefined || log.logIndex === null
    ? null : Number(BigInt(log.logIndex)),
  // Etherscan supplies timeStamp; JSON-RPC does not. Null rather than a guess.
  time: log.timeStamp ? Number(BigInt(log.timeStamp)) : null,
});

/**
 * Shared Etherscan-compatible body parser.
 *
 * Two response conventions to respect, because conflating them would turn an
 * error into a false "this position never did anything":
 *   status "1"                              -> result is the log array
 *   status "0" + "No records found"         -> parsed empty (Etherscan)
 *   status "0" + "No logs found"            -> parsed empty (Blockscout)
 *   status "0" + anything else              -> real error, result is a message
 *                                              string (the Base free-tier
 *                                              paywall is this shape)
 *
 * Parsed-empty is NOT automatically success. fetchTransfers treats it as a
 * legitimate "this owner has no transfers". fetchPositionLogs treats it as
 * a source failure: a minted position always has at least one
 * IncreaseLiquidity, so zero lifetime logs means an incomplete index.
 */
function parseExplorerLogs(body, label) {
  if (body.status === '1' && Array.isArray(body.result)) return body.result;
  const msg = String(body.message || '');
  if (body.status === '0' && /no (records|logs) found/i.test(msg)) return [];
  throw new Error(`${label}: ${body.result || body.message || 'unknown error'}`);
}

function logQuery(fields) {
  const qs = new URLSearchParams();
  qs.set('module', 'logs');
  qs.set('action', 'getLogs');
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  return qs;
}

/**
 * JSON-RPC path. Works wherever the endpoint permits a wide range.
 * `tokenId` is topic1 on IncreaseLiquidity/DecreaseLiquidity/Collect, so one
 * filtered call returns the position's whole lifetime.
 */
async function viaRpc(rpc, nfpm, topic1) {
  const logs = await rpcCall(rpc, 'eth_getLogs', [{
    address: nfpm, fromBlock: '0x0', toBlock: 'latest', topics: [null, topic1],
  }]);
  if (!Array.isArray(logs)) throw new Error('malformed getLogs result');
  return logs.map(normalise);
}

async function viaRpcRange(rpc, nfpm, topic1, fromBlock, toBlock) {
  const logs = await rpcCall(rpc, 'eth_getLogs', [{
    address: nfpm,
    fromBlock: '0x' + BigInt(fromBlock).toString(16),
    toBlock: '0x' + BigInt(toBlock).toString(16),
    topics: [null, topic1],
  }]);
  if (!Array.isArray(logs)) throw new Error('malformed getLogs result');
  return logs.map(normalise);
}

async function explorerGetLogs(url, fields, slot, label) {
  await slot();
  const res = await fetch(`${url}?${logQuery(fields)}`);
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
  return parseExplorerLogs(await res.json(), label);
}

async function viaEtherscan(chainId, key, nfpm, topic1) {
  const rows = await explorerGetLogs(ETHERSCAN_V2, {
    chainid: String(chainId),
    address: nfpm,
    topic1,
    fromBlock: '0',
    toBlock: 'latest',
    apikey: key,
  }, etherscanSlot, 'etherscan');
  return rows.map(normalise);
}

/**
 * Blockscout Etherscan-compatible getLogs, paged by fromBlock.
 *
 * page/offset is a no-op on the public instances (verified 2026-08-19: page=2
 * returned the same 1,000 WETH Transfer logs as page=1). A full page therefore
 * means "there may be more", and we continue from the last blockNumber with
 * overlap so same-block remainder is not dropped.
 */
async function viaBlockscoutRaw(baseUrl, fields) {
  const collected = [];
  const seen = new Set();
  let fromBlock = 0;

  for (let page = 0; page < BLOCKSCOUT_MAX_PAGES; page++) {
    const rows = await explorerGetLogs(baseUrl, {
      ...fields,
      fromBlock: String(fromBlock),
      toBlock: 'latest',
    }, blockscoutSlot, 'blockscout');

    let newest = fromBlock;
    for (const row of rows) {
      const key = `${row.transactionHash}:${row.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(row);
      const b = Number(BigInt(row.blockNumber));
      if (b > newest) newest = b;
    }

    if (rows.length < BLOCKSCOUT_PAGE) return collected;

    // A 1,000-log page confined to a single block cannot be continued with
    // fromBlock without skipping or looping. Throw rather than truncate.
    const oldest = Number(BigInt(rows[0].blockNumber));
    if (oldest === newest) {
      throw new Error(
        `blockscout: ${BLOCKSCOUT_PAGE} logs in block ${newest}, `
        + 'result cap would truncate');
    }
    fromBlock = newest;
  }
  throw new Error(
    `blockscout: exceeded ${BLOCKSCOUT_MAX_PAGES * BLOCKSCOUT_PAGE} log page cap`);
}

async function viaBlockscout(baseUrl, fields) {
  return (await viaBlockscoutRaw(baseUrl, fields)).map(normalise);
}

/**
 * Authenticated hosted history relay. The access key proves beta entitlement;
 * provider credentials never enter this public extension. The Worker selects
 * Blockscout Pro for its supported chains and Etherscan V2 for HyperEVM.
 */
async function historyRelayPage(relay, chainId, fields) {
  if (!relay || !relay.url || !relay.key || !relay.installationId || !chainId) {
    throw new Error('history relay is not configured');
  }

  let last = 'unavailable';
  for (let attempt = 0; attempt < 4; attempt++) {
    await historyRelaySlot();
    let response;
    try {
      response = await fetch(relay.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: relay.key,
          installationId: relay.installationId,
          chainId: String(chainId),
          fields,
        }),
      });
    } catch (err) {
      last = err.message || String(err);
      if (attempt < 3) {
        await sleep(400 * (2 ** attempt) + Math.floor(Math.random() * 180));
        continue;
      }
      break;
    }

    let body = null;
    try { body = await response.json(); } catch { /* handled below */ }
    if (response.ok) return parseExplorerLogs(body, hostedRelayLabel(chainId));

    last = body && (body.error || body.reason)
      ? String(body.error || body.reason)
      : `HTTP ${response.status}`;
    const dailyAllowance = response.status === 429 && /allowance/i.test(last);
    if (dailyAllowance || ![429, 502, 503, 504].includes(response.status) || attempt === 3) {
      break;
    }
    await sleep(400 * (2 ** attempt) + Math.floor(Math.random() * 180));
  }
  throw new Error(`history relay: ${last}`);
}

function hostedRelayLabel(chainId) {
  return String(chainId) === '999' ? 'etherscan-hosted' : 'blockscout-pro';
}

/**
 * The unified Pro endpoint uses the same 1,000-row getLogs ceiling as the
 * public Etherscan-compatible endpoint. Walk fromBlock with an overlapping
 * boundary and de-duplicate, so a busy v4 owner is never silently truncated.
 */
async function viaHistoryRelayRaw(relay, chainId, fields) {
  const collected = [];
  const seen = new Set();
  let fromBlock = Number(fields.fromBlock || 0);

  for (let page = 0; page < BLOCKSCOUT_MAX_PAGES; page++) {
    const rows = await historyRelayPage(relay, chainId, {
      ...fields,
      fromBlock: String(fromBlock),
      toBlock: 'latest',
    });

    let newest = fromBlock;
    for (const row of rows) {
      const key = `${row.transactionHash}:${row.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(row);
      const block = Number(BigInt(row.blockNumber));
      if (block > newest) newest = block;
    }

    if (rows.length < BLOCKSCOUT_PAGE) return collected;
    const oldest = Number(BigInt(rows[0].blockNumber));
    if (oldest === newest) {
      throw new Error(
        `history relay: ${BLOCKSCOUT_PAGE} logs in block ${newest}, `
        + 'result cap would truncate');
    }
    fromBlock = newest;
  }
  throw new Error(
    `history relay: exceeded ${BLOCKSCOUT_MAX_PAGES * BLOCKSCOUT_PAGE} log page cap`);
}

async function viaHistoryRelay(relay, chainId, fields) {
  return (await viaHistoryRelayRaw(relay, chainId, fields)).map(normalise);
}

const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function transferFilter(topics) {
  const fields = { topic0: topics[0] };
  if (topics[1]) { fields.topic1 = topics[1]; fields.topic0_1_opr = 'and'; }
  if (topics[2]) { fields.topic2 = topics[2]; fields.topic0_2_opr = 'and'; }
  if (topics[1] && topics[2]) fields.topic1_2_opr = 'and';
  return fields;
}

/**
 * ERC-721 Transfer logs for one owner, both directions.
 *
 * Used to enumerate v4 positions, whose PositionManager is NOT
 * ERC721Enumerable — `tokenOfOwnerByIndex` simply does not exist there, so the
 * v3 index scan has no equivalent. Transfer indexes `tokenId` as topic3 and the
 * addresses as topic1/topic2, so two filtered queries reconstruct current
 * holdings exactly.
 *
 * Two queries rather than one because eth_getLogs ORs within a topic position,
 * never across positions: `from == owner` and `to == owner` cannot be combined.
 */
export async function fetchTransfers({
  contract, owner, rpc, etherscanKey, etherscanChainId, blockscout,
  historyRelay, historyRelayChainId, blockscoutRelay, blockscoutChainId,
}) {
  const hostedRelay = historyRelay || blockscoutRelay;
  const hostedChainId = historyRelayChainId || blockscoutChainId;
  const topicOwner = '0x' + String(owner).replace(/^0x/, '').toLowerCase().padStart(64, '0');

  const grab = async (topics) => {
    const filter = transferFilter(topics);
    const errors = [];

    if (etherscanKey && etherscanChainId) {
      try {
        return await explorerGetLogs(ETHERSCAN_V2, {
          chainid: String(etherscanChainId),
          address: contract,
          fromBlock: '0',
          toBlock: 'latest',
          apikey: etherscanKey,
          ...filter,
        }, etherscanSlot, 'etherscan');
      } catch (err) {
        errors.push(err.message || String(err));
      }
    }

    if (hostedRelay && hostedChainId) {
      try {
        return await viaHistoryRelayRaw(hostedRelay, hostedChainId, {
          address: contract,
          fromBlock: '0',
          toBlock: 'latest',
          ...filter,
        });
      } catch (err) {
        errors.push(err.message || String(err));
      }
    }

    if (blockscout) {
      try {
        return await viaBlockscoutRaw(blockscout, { address: contract, ...filter });
      } catch (err) {
        errors.push(err.message || String(err));
      }
    }

    try {
      const logs = await rpcCall(rpc, 'eth_getLogs', [{
        address: contract, fromBlock: '0x0', toBlock: 'latest', topics,
      }]);
      if (!Array.isArray(logs)) throw new Error('malformed getLogs result');
      return logs;
    } catch (err) {
      const rpcMsg = err.message || String(err);
      throw new Error(errors.length ? `${errors.join('; ')}; rpc fallback: ${rpcMsg}` : rpcMsg);
    }
  };

  try {
    const [inLogs, outLogs] = await Promise.all([
      grab([TRANSFER_TOPIC, null, topicOwner]),
      grab([TRANSFER_TOPIC, topicOwner, null]),
    ]);
    const tag = (logs, direction) => logs.map((l) => ({
      direction,
      block: Number(BigInt(l.blockNumber)),
      index: Number(BigInt(l.logIndex || '0x0')),
      tokenId: BigInt(l.topics[3]),
    }));
    // Chronological replay: a token can be received, sent, and received again.
    const events = [...tag(inLogs, 'in'), ...tag(outLogs, 'out')]
      .sort((a, b) => (a.block - b.block) || (a.index - b.index));
    return { events };
  } catch (err) {
    return { unavailable: err.message || String(err) };
  }
}

/**
 * Complete lifetime logs for one exact event filter.
 *
 * v3 can identify an NFT with topic1 alone. v4 cannot: its token id is the
 * non-indexed `salt` word, so callers first constrain the PoolManager query by
 * event signature + poolId + PositionManager, then decode and match the salt.
 * This shares the same source order, pagination and zero-result fail-closed
 * rule as fetchPositionLogs without turning the hosted relay into a generic
 * explorer proxy.
 */
export async function fetchFilteredLogs({
  contract, topics, rpc, etherscanKey, etherscanChainId, blockscout,
  historyRelay, historyRelayChainId, blockscoutRelay, blockscoutChainId,
}) {
  const hostedRelay = historyRelay || blockscoutRelay;
  const hostedChainId = historyRelayChainId || blockscoutChainId;
  const filter = transferFilter(topics || []);
  const errors = [];

  if (!contract || !topics || !topics[0]) {
    return { unavailable: 'an exact event signature is required' };
  }

  const trySource = async (label, fn) => {
    try {
      const logs = await fn();
      if (!logs.length) {
        errors.push(`${label}: zero logs for a position lifetime`);
        return null;
      }
      return { logs, source: label };
    } catch (err) {
      errors.push(err.message || String(err));
      return null;
    }
  };

  if (etherscanKey && etherscanChainId) {
    const hit = await trySource('etherscan', async () => (
      await explorerGetLogs(ETHERSCAN_V2, {
        chainid: String(etherscanChainId),
        address: contract,
        fromBlock: '0',
        toBlock: 'latest',
        apikey: etherscanKey,
        ...filter,
      }, etherscanSlot, 'etherscan')
    ).map(normalise));
    if (hit) return hit;
  }

  if (hostedRelay && hostedChainId) {
    const label = hostedRelayLabel(hostedChainId);
    const hit = await trySource(label,
      () => viaHistoryRelay(hostedRelay, hostedChainId, {
        address: contract,
        fromBlock: '0',
        toBlock: 'latest',
        ...filter,
      }));
    if (hit) return hit;
  }

  if (blockscout) {
    const hit = await trySource('blockscout',
      () => viaBlockscout(blockscout, { address: contract, ...filter }));
    if (hit) return hit;
  }

  const hit = await trySource('rpc', async () => {
    const logs = await rpcCall(rpc, 'eth_getLogs', [{
      address: contract,
      fromBlock: '0x0',
      toBlock: 'latest',
      topics,
    }]);
    if (!Array.isArray(logs)) throw new Error('malformed getLogs result');
    return logs.map(normalise);
  });
  if (hit) return hit;
  return { unavailable: errors.join('; ') };
}

/** Recent counterpart for explorer-index lag; never substitutes for lifetime. */
export async function fetchRecentFilteredLogs({
  contract, topics, rpc, lookback = 128,
}) {
  try {
    const latest = await rpcCall(rpc, 'eth_getBlockByNumber', ['latest', false]);
    if (!latest || latest.number === undefined) throw new Error('latest block unavailable');
    const to = Number(BigInt(latest.number));
    const from = Math.max(0, to - lookback + 1);
    const grab = async (start, end) => {
      const logs = await rpcCall(rpc, 'eth_getLogs', [{
        address: contract,
        fromBlock: '0x' + BigInt(start).toString(16),
        toBlock: '0x' + BigInt(end).toString(16),
        topics,
      }]);
      if (!Array.isArray(logs)) throw new Error('malformed getLogs result');
      return logs.map(normalise);
    };
    try {
      return { logs: await grab(from, to), source: 'recent-rpc' };
    } catch {
      const logs = [];
      for (let start = from; start <= to; start += 10) {
        logs.push(...await grab(start, Math.min(to, start + 9)));
      }
      return { logs, source: 'recent-rpc-chunked' };
    }
  } catch (err) {
    return { unavailable: err.message || String(err) };
  }
}

/**
 * Fetch one position's lifetime logs from the best available source.
 * Never throws: returns `{ unavailable }` so a single unreachable history
 * degrades one card instead of failing the whole load.
 *
 * Order: Etherscan (user key) -> licensed hosted relay -> public Blockscout
 * per-chain URL -> eth_getLogs.
 * A source that refuses — including Etherscan's HTTP-200 paywall — falls
 * through. Zero logs also falls through: this is only called for a tokenId
 * whose positions() was just read, and a minted position always has at least
 * one IncreaseLiquidity. An empty result is an incomplete index, never a
 * successful empty lifetime. If every source yields zero or fails, the
 * return is `{ unavailable }`, never `{ logs: [], source }`.
 *
 * Do not apply this invariant to fetchTransfers: an address with no v4
 * positions genuinely has no Transfer logs.
 */
export async function fetchPositionLogs({
  nfpm, tokenId, rpc, etherscanKey, etherscanChainId, blockscout,
  historyRelay, historyRelayChainId, blockscoutRelay, blockscoutChainId,
}) {
  const hostedRelay = historyRelay || blockscoutRelay;
  const hostedChainId = historyRelayChainId || blockscoutChainId;
  const topic1 = '0x' + BigInt(tokenId).toString(16).padStart(64, '0');
  const errors = [];

  const trySource = async (label, fn) => {
    try {
      const logs = await fn();
      if (!logs.length) {
        errors.push(`${label}: zero logs for a position lifetime`);
        return null;
      }
      return { logs, source: label };
    } catch (err) {
      errors.push(err.message || String(err));
      return null;
    }
  };

  if (etherscanKey && etherscanChainId) {
    const hit = await trySource('etherscan',
      () => viaEtherscan(etherscanChainId, etherscanKey, nfpm, topic1));
    if (hit) return hit;
  }
  if (hostedRelay && hostedChainId) {
    const label = hostedRelayLabel(hostedChainId);
    const hit = await trySource(label,
      () => viaHistoryRelay(hostedRelay, hostedChainId, {
        address: nfpm,
        fromBlock: '0',
        toBlock: 'latest',
        topic1,
      }));
    if (hit) return hit;
  }

  if (blockscout) {
    const hit = await trySource('blockscout',
      () => viaBlockscout(blockscout, { address: nfpm, topic1 }));
    if (hit) return hit;
  }

  const hit = await trySource('rpc', () => viaRpc(rpc, nfpm, topic1));
  if (hit) return hit;
  return { unavailable: errors.join('; ') };
}

/**
 * Read just-mined position events directly from the selected RPC. Explorer
 * indexes can lag a Collect/Increase/Decrease. Normal RPCs accept the initial
 * 128-block request; Alchemy free currently needs the ten-block fallback.
 */
export async function fetchRecentPositionLogs({ rpc, nfpm, tokenId, lookback = 128 }) {
  const topic1 = '0x' + BigInt(tokenId).toString(16).padStart(64, '0');
  try {
    const latest = await rpcCall(rpc, 'eth_getBlockByNumber', ['latest', false]);
    if (!latest || latest.number === undefined) throw new Error('latest block unavailable');
    const to = Number(BigInt(latest.number));
    const from = Math.max(0, to - lookback + 1);
    try {
      return { logs: await viaRpcRange(rpc, nfpm, topic1, from, to), source: 'recent-rpc' };
    } catch {
      const logs = [];
      for (let start = from; start <= to; start += 10) {
        const end = Math.min(to, start + 9);
        logs.push(...await viaRpcRange(rpc, nfpm, topic1, start, end));
      }
      return { logs, source: 'recent-rpc-chunked' };
    }
  } catch (err) {
    return { unavailable: err.message || String(err) };
  }
}

/**
 * The most recent log at or before `block`, or null.
 *
 * Historical POOL PRICES need a pool's state at an old block. Reading `slot0`
 * there needs an archive node, and at least one chain's public RPC answers a
 * historical `eth_call` with LATEST state rather than refusing — a silent
 * wrong answer, which is worse than no answer (see `histprice.js`). A log
 * index does not have that failure mode: `eth_getLogs` is served from
 * receipts, which full nodes retain long after the matching state is pruned,
 * and a v3 pool's own `Swap` event carries `sqrtPriceX96`. So the price at an
 * unservable block is still an exact chain fact if you read it as an event.
 *
 * Two endpoint quirks are handled here rather than by the caller:
 *  - Etherscan returns rows ASCENDING from `fromBlock` and caps a page at
 *    1,000. On a busy pool a full page means the last row is mid-window, not
 *    the newest — a stale price that would still be marked exact. Walk forward
 *    from the last block seen, with overlap, until a short page.
 *  - A public RPC may time out on a wide range while serving a narrow one
 *    (verified 2026-08-23: hyperliquid.xyz 504s at 1,000 blocks, answers at
 *    100), so the RPC path walks backward in small chunks and stops at the
 *    first that hits.
 *
 * Returns null rather than a guess. Callers must fail closed on null.
 */
async function lastExplorerLog(target, floor, rowsAt) {
  for (const span of EXPLORER_SPANS) {
    let from = Math.max(floor, target - span);
    try {
      for (let page = 0; page < EXPLORER_MAX_PAGES; page++) {
        const rows = await rowsAt(from, target);
        if (!rows.length) break;
        const best = rows[rows.length - 1];
        if (rows.length < BLOCKSCOUT_PAGE) return normalise(best);
        const newest = Number(BigInt(best.blockNumber));
        // The endpoint cannot paginate within a block. Returning any one of
        // 1,000 same-block rows could stamp an earlier swap as the close, so
        // fail this source instead of manufacturing exactness.
        if (newest <= from) return null;
        from = newest;
      }
    } catch {
      // A provider refusal will not improve when asked for a wider window.
      return null;
    }
    if (from <= floor) break;
  }
  return null;
}

/** Read one RPC log interval completely, or admit that the interval is unknown. */
async function rpcLogsInChunk(rpc, filter) {
  for (let attempt = 0; attempt < RPC_LAST_LOG_ATTEMPTS; attempt++) {
    try {
      const logs = await rpcCall(rpc, 'eth_getLogs', [filter]);
      if (!Array.isArray(logs)) throw new Error('malformed eth_getLogs result');
      return logs;
    } catch {
      if (attempt + 1 >= RPC_LAST_LOG_ATTEMPTS) return null;
      await sleep(RPC_LAST_LOG_RETRY_MS * (2 ** attempt));
    }
  }
  return null;
}

export async function fetchLastLogBefore({
  contract, topics, block, rpc, etherscanKey, etherscanChainId,
  blockscout,
  lookback = 50000, chunk = 100, maxChunks = 16,
}) {
  const target = Number(block);
  if (!contract || !topics || !topics[0]) return null;
  if (!Number.isFinite(target) || target < 0) return null;
  const floor = Math.max(0, target - lookback);
  const filter = transferFilter(topics);

  if (etherscanKey && etherscanChainId) {
    // Escalating windows from the target downward. A deep pool answers the
    // first, narrow query in one request; only a quiet pool pays for a wider
    // one. Querying the whole lookback up front would page through thousands
    // of rows on a busy pool to reach the same last row.
    const hit = await lastExplorerLog(target, floor, (from, to) =>
      explorerGetLogs(ETHERSCAN_V2, {
        chainid: String(etherscanChainId),
        address: contract,
        fromBlock: String(from),
        toBlock: String(to),
        apikey: etherscanKey,
        ...filter,
      }, etherscanSlot, 'etherscan'));
    if (hit) return hit;
  }

  // Historical pool pricing is a first-class use of the same public log
  // index that serves position history. Prefer it to raw eth_getLogs: public
  // RPCs commonly reject even modest historical ranges, while Blockscout's
  // indexed query is keyless and does not consume the node's JSON-RPC budget.
  if (blockscout) {
    const hit = await lastExplorerLog(target, floor, (from, to) =>
      explorerGetLogs(blockscout, {
        address: contract,
        fromBlock: String(from),
        toBlock: String(to),
        ...filter,
      }, blockscoutSlot, 'blockscout'));
    if (hit) return hit;
  }

  if (!rpc) return null;
  for (let i = 0; i < maxChunks; i++) {
    const to = target - i * chunk;
    if (to < floor) break;
    const from = Math.max(floor, to - chunk + 1);
    const logs = await rpcLogsInChunk(rpc, {
      address: contract,
      fromBlock: '0x' + BigInt(from).toString(16),
      toBlock: '0x' + BigInt(to).toString(16),
      topics,
    });
    // An unreadable newer interval is not proof that it contains no Swap.
    // Returning a hit from an older interval would silently stamp a stale price
    // as exact, so this source must fail closed rather than skip the gap.
    if (logs === null) return null;
    if (logs.length) {
      try { return normalise(logs[logs.length - 1]); }
      catch { return null; }
    }
    if (from <= floor) break;
  }
  return null;
}
