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
 *     for Ethereum (1), Arbitrum (42161) and Polygon (137). On Base (8453)
 *     a free key returns HTTP 200 with status "0", message "NOTOK", result
 *     "Free API access is not supported for this chain...". That is a
 *     refusal, not an empty result — a transport-level 200 is not enough.
 *   - Blockscout serves the same Etherscan-compatible getLogs keylessly on
 *     eth / base / arbitrum / polygon.blockscout.com (verified live
 *     2026-08-19). Documented cap is 1,000 logs per query; page/offset is
 *     ignored, so we walk fromBlock instead of truncating.
 *
 * Source order: Etherscan (only when a key is configured) -> Blockscout
 * (when the chain has a URL) -> raw eth_getLogs. All three return the same
 * normalised shape, and fetchPositionLogs never throws — a missing history
 * must read as "unavailable", never as "no activity".
 */
import { rpcCall } from './rpc.js';

const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';

// Etherscan's free tier allows 5 requests/second. Position loads run
// concurrently, so without a throttle a multi-position scan bursts well past
// that and starts collecting rejections — which would surface as history
// randomly "unavailable" on some cards and not others. One shared serialiser
// spaces every Etherscan request by the minimum interval.
const ETHERSCAN_MIN_GAP_MS = 220;
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

/** Blockscout getLogs hard-caps at 1,000 (docs + live WETH Transfer probe). */
const BLOCKSCOUT_PAGE = 1000;
/** Positions do not have tens of thousands of events; this is a runaway guard. */
const BLOCKSCOUT_MAX_PAGES = 50;

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

const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function transferFilter(topics) {
  const fields = { topic0: topics[0] };
  if (topics[1]) { fields.topic1 = topics[1]; fields.topic0_1_opr = 'and'; }
  if (topics[2]) { fields.topic2 = topics[2]; fields.topic0_2_opr = 'and'; }
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
}) {
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
 * Fetch one position's lifetime logs from the best available source.
 * Never throws: returns `{ unavailable }` so a single unreachable history
 * degrades one card instead of failing the whole load.
 *
 * Order: Etherscan (key required) -> Blockscout (per-chain URL) -> eth_getLogs.
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
}) {
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
