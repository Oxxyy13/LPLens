import {
  CHAINS, MAX_POSITIONS, v3Deployment, v3DeploymentsFor,
} from './chains.js';
import {
  dataBalanceOf, dataTokenOfOwnerByIndex, dataPositions, dataSlot0,
  dataGetPool, dataCollect, dataOwnerOf, decodePositions, decodeSlot0, decodeCollect,
  dataSlipstreamGetPool, dataVoterPool, dataVoterGauge, dataIsPool, dataStakedValues,
  dataStakedContains, dataEarnedCl, dataStoredClReward, decodeUintArrayBounded,
  decodeSymbol, SELECTOR, toUint, toAddress,
  words, encUint,
} from './abi.js';
import { ethCall, ethCallBatch, mapLimit } from './rpc.js';
import {
  fetchHistoryCheckpoint, fetchHistoryRange, fetchRecentHistory,
  historyChanged, mergeHistoryEvents, replaceHistoryTail,
  solveSqrtPrice, accounting, reconciles, lifetimeFees,
} from './history.js';
import { fetchExactTokenTransfers } from './logs.js';
import {
  fingerprint, historyIdentity, readHistoryAny, writeHistory,
} from './cache.js';
import { enumerateV4, loadV4Position, V4 } from './v4.js';
import {
  costBasisUsd, collectedProceedsUsd, strategyReturn, usdPairAt,
} from './histprice.js';
import { positionAmounts, humanPrice, scale, tickToPrice } from './v3.js';

const tokenCache = new Map(); // `${chain}:${addr}` -> {symbol, decimals}
const gaugeCache = new Map(); // voter -> {at, gauges}; discovery acceleration only
const HISTORY_REORG_OVERLAP = 128;
const GAUGE_CACHE_MS = 5 * 60_000;
const MAX_GAUGES = 2_000;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Total pending CL gauge emissions. Both components are required. */
export function clGaugeRewardTotal(storedHex, earnedHex) {
  const storedWord = storedHex ? words(storedHex)[0] : null;
  const earnedWord = earnedHex ? words(earnedHex)[0] : null;
  if (!storedWord || !earnedWord) return null;
  try { return toUint(storedWord) + toUint(earnedWord); }
  catch { return null; }
}

/**
 * Prove that an NFT has remained in one wallet continuously since mint.
 *
 * Eligibility is intentionally stricter than reconstructing current ownership:
 * exactly one mint directly to the current owner is required. Any later
 * Transfer means the position may have accrued gauge emissions or other
 * custody-only value that LPLens cannot reconstruct yet. Ambiguity therefore
 * withholds lifetime figures.
 */
export function uninterruptedDirectCustody(events, expectedOwner, tokenId) {
  const owner = String(expectedOwner || '').toLowerCase();
  let id;
  try { id = BigInt(tokenId); } catch {
    return { ok: false, reason: 'invalid NFT identity' };
  }
  if (!/^0x[0-9a-f]{40}$/.test(owner) || !Array.isArray(events) || !events.length) {
    return { ok: false, reason: 'direct-from-mint custody is unproven' };
  }
  const rows = [...events].sort((a, b) => (Number(a.block) - Number(b.block))
    || (Number(a.index) - Number(b.index)));
  const validRow = (row) => {
    try {
      return BigInt(row.tokenId) === id
        && /^0x[0-9a-f]{40}$/.test(String(row.from || '').toLowerCase())
        && /^0x[0-9a-f]{40}$/.test(String(row.to || '').toLowerCase())
        && Number.isSafeInteger(Number(row.block))
        && Number.isSafeInteger(Number(row.index));
    } catch { return false; }
  };
  if (rows.some((row) => !validRow(row))) {
    return { ok: false, reason: 'NFT Transfer history is malformed' };
  }

  const first = rows[0];
  if (String(first.from).toLowerCase() !== ZERO_ADDRESS
      || String(first.to).toLowerCase() !== owner) {
    return { ok: false, reason: 'NFT was not minted directly to this wallet' };
  }
  if (rows.length !== 1) {
    return { ok: false, reason: 'NFT left direct wallet custody' };
  }
  return { ok: true };
}

/**
 * Exact USD token-price moves from the first liquidity addition to now.
 *
 * This is intentionally separate from the pool-ratio move shown in details:
 * both tokens can rise or fall together in dollars while their ratio barely
 * moves. Only an exact historical leg is eligible; a bound must not become a
 * confident-looking percentage.
 */
export function tokenPriceChangesSinceFirstAdd(basis, current0, current1, adds = 1) {
  const legs = basis && Array.isArray(basis.legs) ? basis.legs : [];
  const first = legs.reduce((best, leg) => (
    !best || Number(leg.block) < Number(best.block) ? leg : best
  ), null);
  if (!first || first.exact === false) return null;
  const change = (from, to) => {
    if (!(from > 0) || !(to > 0) || !Number.isFinite(from) || !Number.isFinite(to)) {
      return null;
    }
    return { from, to, pct: (to / from - 1) * 100 };
  };
  const token0 = change(first.usd0, current0);
  const token1 = change(first.usd1, current1);
  if (!token0 && !token1) return null;
  return { label: Number(adds) > 1 ? 'first add' : 'opened', token0, token1 };
}

/** Exact USD token-price moves from the most recent addition to now. */
export function tokenPriceChangesSinceLatestAdd(basis, current0, current1, adds = 1) {
  if (Number(adds) < 2) return null;
  const legs = basis && Array.isArray(basis.legs) ? basis.legs : [];
  const latest = legs.reduce((best, leg) => (
    !best || Number(leg.block) > Number(best.block) ? leg : best
  ), null);
  if (!latest || latest.exact === false) return null;
  const change = (from, to) => {
    if (!(from > 0) || !(to > 0) || !Number.isFinite(from) || !Number.isFinite(to)) {
      return null;
    }
    return { from, to, pct: (to / from - 1) * 100 };
  };
  const token0 = change(latest.usd0, current0);
  const token1 = change(latest.usd1, current1);
  if (!token0 && !token1) return null;
  return { label: 'latest add', token0, token1 };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function retryRead(fn, attempts = 3) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await fn(); }
    catch (err) {
      last = err;
      if (attempt + 1 < attempts) await wait(120 * (attempt + 1));
    }
  }
  throw last;
}

const isAlchemyRpc = (rpc) => {
  try { return new URL(rpc).hostname.toLowerCase().endsWith('.g.alchemy.com'); }
  catch { return false; }
};

const readSingles = (rpc, calls) => mapLimit(calls, 4, (call) => retryRead(() => ethCall(
  rpc, call.to, call.data, call.from, call.block || 'latest')));

/**
 * Batch high-volume Alchemy calls and chains whose provider explicitly opts
 * in. A provider that refuses a whole batch falls back to the established
 * bounded-single path; per-item failures retry without repeating good reads.
 */
async function readMany(rpc, calls, configuredBatchSize = 0) {
  const requestedSize = Number(configuredBatchSize);
  const batchSize = isAlchemyRpc(rpc)
    ? 25
    : (Number.isInteger(requestedSize) && requestedSize > 1 ? requestedSize : 0);
  if (!batchSize) return readSingles(rpc, calls);

  const out = new Array(calls.length);
  for (let offset = 0; offset < calls.length; offset += batchSize) {
    const chunk = calls.slice(offset, offset + batchSize);
    let pending = chunk.map((call, index) => ({ call, index }));
    for (let attempt = 0; attempt < 4 && pending.length; attempt++) {
      let rows;
      try { rows = await ethCallBatch(rpc, pending.map((item) => item.call)); }
      catch {
        break;
      }
      // Some RPCs answer HTTP 200 but reject every JSON-RPC item. Treat that
      // as a refused batch rather than spending every retry on the same shape.
      if (rows.length && rows.every((row) => row && row.__error)) break;
      const retry = [];
      for (let i = 0; i < pending.length; i++) {
        if (!rows[i] || rows[i].__error) retry.push(pending[i]);
        else out[offset + pending[i].index] = rows[i];
      }
      pending = retry;
      if (pending.length && attempt < 3) await wait(2000 * (attempt + 1));
    }
    // Confirm any batch item that is still unknown through the established
    // bounded scalar path. This covers whole-batch rejection, missing rows,
    // and a partial item that exhausted its batch retries.
    if (pending.length) {
      const rows = await readSingles(rpc, pending.map((item) => item.call));
      for (let i = 0; i < pending.length; i++) {
        out[offset + pending[i].index] = rows[i];
      }
    }
    if (offset + chunk.length < calls.length) await wait(250);
  }
  return out;
}

export async function tokenMeta(rpc, chainKey, addr) {
  const key = `${chainKey}:${addr.toLowerCase()}`;
  if (tokenCache.has(key)) return tokenCache.get(key);
  const [symRaw, decRaw] = await Promise.all([
    retryRead(() => ethCall(rpc, addr, SELECTOR.symbol)).catch(() => null),
    retryRead(() => ethCall(rpc, addr, SELECTOR.decimals)).catch(() => null),
  ]);
  const symbol = symRaw ? decodeSymbol(symRaw) : '?';
  const decimalWord = decRaw ? words(decRaw)[0] : null;
  const decodedDecimals = decimalWord ? Number(toUint(decimalWord)) : null;
  const decimals = Number.isInteger(decodedDecimals)
    && decodedDecimals >= 0 && decodedDecimals <= 255 ? decodedDecimals : 18;
  const meta = { symbol, decimals };
  // A fallback helps the current card render, but it is not a chain fact and
  // must not make a transient RPC failure sticky for the worker's lifetime.
  if (symbol && symbol !== '?' && decimalWord && decimals === decodedDecimals) {
    tokenCache.set(key, meta);
  }
  return meta;
}

/**
 * How many chains `loadAllChains` runs at once.
 *
 * Per-chain work already uses mapLimit of 3–4, so five chains in parallel
 * would be ~20 concurrent RPC calls. Two chains keeps the peak around 8,
 * comparable to a single-chain scan, and is less likely to trip Base
 * Blockscout's ~10-request window — the all-chains path is what makes that
 * 429 likely. Single-chain loads are unchanged.
 */
export const ALL_CHAIN_CONCURRENCY = 2;

// DexScreener mark memo, keyed `chain:token`. In memory only — prices are live
// numbers and must not survive into a later session from chrome.storage.
const PRICE_MEMO = new Map();
const PRICE_MEMO_TTL_MS = 60_000;
const PRICE_MEMO_MAX = 500;

function tagPosition(p, chainKey, deployment = null) {
  const chain = CHAINS[chainKey];
  const chainProtocol = chain && chain.protocol;
  const version = p.version || 'v3';
  const standardV4 = version === 'v4' && chain?.v4PositionManager && !chainProtocol;
  return {
    ...p,
    chainKey,
    version,
    deploymentId: p.deploymentId || deployment?.id || (standardV4 ? 'uniswap-v4' : null),
    manager: p.manager || deployment?.nfpm || (standardV4 ? chain.v4PositionManager : null),
    protocol: p.protocol || deployment?.protocol || chainProtocol || (standardV4 ? 'Uniswap' : null),
  };
}

/**
 * Enumerate and mark every v3 position held by `owner` on one chain.
 * Read-only: eth_call and eth_getBalance style requests only. Nothing is signed.
 */
export async function loadPositions(chainKey, owner, opts = {}) {
  const chain = CHAINS[chainKey];
  if (!chain) throw new Error(`unknown chain ${chainKey}`);
  const rpc = opts.rpcOverride || chain.rpc;
  const configuredDeployments = v3DeploymentsFor(chainKey);
  const requestedDeploymentIds = Array.isArray(opts.v3DeploymentIds)
    ? new Set(opts.v3DeploymentIds.map((value) => String(value || '').trim().toLowerCase()))
    : null;
  const deployments = requestedDeploymentIds
    ? configuredDeployments.filter((deployment) => requestedDeploymentIds.has(deployment.id))
    : configuredDeployments;
  if (!deployments.length) throw new Error(`no requested v3 deployment on ${chainKey}`);
  const deploymentRows = await mapLimit(deployments, 1, async (deployment) => {
    try {
      return await loadV3Deployment(
        rpc, chain, chainKey, deployment, owner, !!opts.includeClosed, opts,
      );
    } catch (error) {
      return {
        deployment,
        unavailable: error.message || String(error),
        count: 0,
        attempted: 0,
        scanned: 0,
        enumUnreadable: 0,
        positionUnreadable: 0,
        closedHidden: 0,
        truncated: false,
        positions: [],
        discovery: { complete: false, ids: [], records: [] },
      };
    }
  });

  const v4 = opts.skipV4 === true ? {
    positions: [], held: 0, shown: 0, closedHidden: 0, unreadable: 0,
    unavailable: null, source: 'skipped', discovery: { complete: true, ids: [] },
  } : await scanV4(chainKey, owner, opts);
  let positions = [
    ...deploymentRows.flatMap((row) => row.positions || []),
    ...v4.positions.map((position) => tagPosition(position, chainKey)),
  ];
  if (opts.withUsd) {
    positions = (await mapLimit(positions, 2, async (position) => {
      try { return await attachUsd(chainKey, position, opts); }
      catch { return position; }
    })).filter((position) => position && !position.__error);
  }

  const sum = (name) => deploymentRows.reduce((total, row) => total + Number(row[name] || 0), 0);
  const defaultDeployment = configuredDeployments[0];
  const defaultRow = deploymentRows.find((row) => row.deployment.id === defaultDeployment?.id);
  const records = deploymentRows.flatMap((row) => row.discovery?.records || []);
  return {
    chain: chainKey,
    count: sum('count'),
    scanned: sum('scanned'),
    attempted: sum('attempted'),
    enumUnreadable: sum('enumUnreadable'),
    positionUnreadable: sum('positionUnreadable'),
    closedHidden: sum('closedHidden'),
    truncated: deploymentRows.some((row) => row.truncated),
    stoppedEarly: false,
    enumSource: deployments.length > 1 ? 'rpc-verified-deployments' : 'rpc-verified',
    deploymentIssues: deploymentRows.filter((row) => row.unavailable).map((row) => ({
      deploymentId: row.deployment.id,
      protocol: row.deployment.protocol,
      error: row.unavailable,
    })),
    positions,
    v4,
    discovery: {
      v3: {
        complete: deployments.length === configuredDeployments.length
          && deploymentRows.every((row) => row.discovery?.complete === true),
        // Legacy readers attribute bare IDs only to the default deployment.
        ids: defaultRow?.discovery?.ids || [],
        records,
      },
      v4: v4.discovery,
    },
  };
}

async function loadV3Deployment(
  rpc, chain, chainKey, deployment, owner, includeClosed, opts,
) {
  const balanceHex = await ethCall(rpc, deployment.nfpm, dataBalanceOf(owner));
  const directCount = Number(toUint(words(balanceHex)[0] || '0'));
  const direct = await scanV3Holdings(
    rpc, chain, deployment, owner, directCount, includeClosed,
  );
  const staked = deployment.kind === 'slipstream'
    ? await scanSlipstreamStakes(rpc, chain, deployment, owner, includeClosed)
    : emptyV3Discovery();
  // A deposit can land between wallet enumeration and gauge enumeration. In
  // that case the same manager/tokenId is visible through both paths during
  // one unpinned `latest` scan. The gauge row has the later beneficial-owner
  // proof, so insert it last and let it replace the stale wallet row.
  const byNft = new Map();
  for (const position of [...direct.live, ...staked.live]) {
    const key = `${String(position.manager || deployment.nfpm).toLowerCase()}:${position.tokenId}`;
    byNft.set(key, position);
  }
  const live = [...byNft.values()];
  const enriched = await mapLimit(live, 3, (position) => retryRead(() =>
    enrichPosition(rpc, chain, chainKey, deployment, owner, position), 2));
  const rendered = enriched.filter((position) => position && !position.__error && !position.error);
  const enrichUnreadable = enriched.length - rendered.length;
  const source = historySource(chain, rpc, opts);
  const withHistory = await mapLimit(rendered, 3, (position) =>
    attachDeploymentHistory(source, chainKey, deployment, position, owner));
  const positions = withHistory.filter((position) => position && !position.__error)
    .map((position) => tagPosition(position, chainKey, deployment));
  const recordsByNft = new Map();
  for (const record of [...direct.discovery.records, ...staked.discovery.records]) {
    recordsByNft.set(`${String(record.manager).toLowerCase()}:${record.tokenId}`, record);
  }
  const records = [...recordsByNft.values()];
  return {
    deployment,
    count: directCount + staked.count,
    attempted: direct.attempted + staked.attempted,
    scanned: direct.scanned + staked.scanned,
    enumUnreadable: direct.enumUnreadable + staked.enumUnreadable,
    positionUnreadable: direct.positionUnreadable + staked.positionUnreadable
      + enrichUnreadable,
    closedHidden: direct.closedHidden + staked.closedHidden,
    truncated: directCount > direct.attempted || staked.truncated,
    positions,
    discovery: {
      complete: direct.discovery.complete && staked.discovery.complete,
      ids: direct.discovery.ids,
      records,
    },
  };
}

function emptyV3Discovery() {
  return {
    live: [], count: 0, attempted: 0, scanned: 0, enumUnreadable: 0,
    positionUnreadable: 0, closedHidden: 0, truncated: false,
    discovery: { complete: true, ids: [], records: [] },
  };
}

/**
 * Wallet × chain sweep. Jobs share ALL_CHAIN_CONCURRENCY so ten wallets
 * do not multiply the per-chain mapLimit. One address or one chain
 * throwing becomes `{ ok: false }` for that job and does not take down
 * the rest. onProgress fires as each job starts and finishes.
 */
export async function loadSweep(owners, chainKeys, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const jobs = [];
  const seen = new Set();
  for (const owner of owners || []) {
    const address = String(typeof owner === 'string' ? owner : owner.address || '')
      .trim().toLowerCase();
    if (!address || seen.has(address)) continue;
    seen.add(address);
    const label = typeof owner === 'string' ? '' : String(owner.label || '');
    for (const chainKey of chainKeys || []) jobs.push({ address, label, chainKey });
  }
  return mapLimit(jobs, ALL_CHAIN_CONCURRENCY, async (job) => {
    const meta = { owner: job.address, label: job.label, chainKey: job.chainKey };
    try { await onProgress({ ...meta, phase: 'start' }); } catch { /* UI must not fail the scan */ }
    try {
      const rpcOverride = (opts.rpcOverrides && opts.rpcOverrides[job.chainKey]) || null;
      const result = await loadPositions(job.chainKey, job.address, { ...opts, rpcOverride });
      result.positions = (result.positions || []).map((p) => ({
        ...p,
        ownerAddress: job.address,
        ownerLabel: job.label,
      }));
      const payload = { ...meta, ok: true, result };
      try { await onProgress(payload); } catch { /* */ }
      return payload;
    } catch (err) {
      const payload = { ...meta, ok: false, error: err.message || String(err) };
      try { await onProgress(payload); } catch { /* */ }
      return payload;
    }
  });
}

function knownScopeMap(scopes) {
  return new Map((Array.isArray(scopes) ? scopes : []).map((job) => [
    `${String(job.owner || '').toLowerCase()}@${job.chainKey}`,
    job.scope || null,
  ]));
}

/**
 * Fast wallet x chain sweep over IDs proven by the last Full rescan.
 *
 * It never calls tokenOfOwnerByIndex and never reconstructs v4 ownership from
 * Transfer history. Every remembered ID is first checked with ownerOf, then
 * its present state, fees, prices and incremental history are read live.
 */
export async function loadKnownSweep(owners, chainKeys, scopes, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const byScope = knownScopeMap(scopes);
  const jobs = [];
  const seen = new Set();
  for (const owner of owners || []) {
    const address = String(typeof owner === 'string' ? owner : owner.address || '')
      .trim().toLowerCase();
    if (!address || seen.has(address)) continue;
    seen.add(address);
    const label = typeof owner === 'string' ? '' : String(owner.label || '');
    for (const chainKey of chainKeys || []) jobs.push({ address, label, chainKey });
  }
  return mapLimit(jobs, ALL_CHAIN_CONCURRENCY, async (job) => {
    const meta = { owner: job.address, label: job.label, chainKey: job.chainKey };
    try { await onProgress({ ...meta, phase: 'start' }); } catch { /* UI must not fail */ }
    try {
      const scope = byScope.get(`${job.address}@${job.chainKey}`);
      if (!scope || !scope.v3?.complete || !scope.v4?.complete) {
        throw new Error('Run Full rescan once to discover positions');
      }
      const rpcOverride = (opts.rpcOverrides && opts.rpcOverrides[job.chainKey]) || null;
      const result = await loadKnownPositions(job.chainKey, job.address, scope, {
        ...opts, rpcOverride,
      });
      result.positions = (result.positions || []).map((p) => ({
        ...p,
        ownerAddress: job.address,
        ownerLabel: job.label,
      }));
      const payload = { ...meta, ok: true, result };
      try { await onProgress(payload); } catch { /* */ }
      return payload;
    } catch (err) {
      const payload = { ...meta, ok: false, error: err.message || String(err) };
      try { await onProgress(payload); } catch { /* */ }
      return payload;
    }
  });
}

function rememberedIds(scope, version) {
  const out = [];
  const seen = new Set();
  for (const raw of scope?.[version]?.ids || []) {
    try {
      const tokenId = BigInt(raw);
      const key = tokenId.toString();
      if (tokenId < 0n || seen.has(key)) continue;
      seen.add(key);
      out.push(tokenId);
    } catch { /* malformed local state is ignored */ }
  }
  return out;
}

function rememberedV3Records(scope, chainKey) {
  const rows = Array.isArray(scope?.v3?.records) ? scope.v3.records : [];
  if (rows.length) return rows.map((record) => ({ ...record, tokenId: BigInt(record.tokenId) }));
  const deployment = v3Deployment(chainKey);
  if (!deployment) return [];
  return rememberedIds(scope, 'v3').map((tokenId) => ({
    tokenId,
    deploymentId: deployment.id,
    manager: deployment.nfpm.toLowerCase(),
    custody: 'wallet',
  }));
}

function positionIsClosed(version, position) {
  if (version === 'v4') return position.liquidity === 0n;
  // Gauge membership remains economically live after liquidity is removed:
  // stored and newly accrued UP rewards can still be claimable until withdraw.
  if (position.custody === 'gauge') return false;
  return position.liquidity === 0n
    && position.tokensOwed0 === 0n
    && position.tokensOwed1 === 0n;
}

/** Re-read remembered open IDs without performing ownership discovery. */
export async function loadKnownPositions(chainKey, owner, scope, opts = {}) {
  const chain = CHAINS[chainKey];
  if (!chain) throw new Error(`unknown chain ${chainKey}`);
  if (!scope || !scope.v3?.complete || !scope.v4?.complete) {
    throw new Error('Run Full rescan once to discover positions');
  }
  const rpc = opts.rpcOverride || chain.rpc;
  const wanted = [
    ...rememberedV3Records(scope, chainKey).map((record) => ({
      version: 'v3',
      ...record,
    })),
    ...rememberedIds(scope, 'v4').map((tokenId) => ({ version: 'v4', tokenId })),
  ];
  const ownerHexes = await readMany(rpc, wanted.map((item) => ({
    to: item.version === 'v4' ? chain.v4PositionManager : item.manager,
    data: dataOwnerOf(item.tokenId),
  })), chain.rpcBatchSize);

  const expectedOwner = String(owner).toLowerCase();
  const verified = [];
  const defaultV3 = v3Deployment(chainKey);
  const keep = { v3: [], v3Records: [], v4: [] };
  const keepItem = (item) => {
    if (item.version === 'v4') keep.v4.push(item.tokenId.toString());
    else {
      keep.v3Records.push({
        tokenId: item.tokenId.toString(),
        deploymentId: item.deploymentId,
        manager: item.manager,
        custody: item.custody,
        ...(item.custodian ? { custodian: item.custodian } : {}),
      });
      if (item.deploymentId === defaultV3?.id && item.custody === 'wallet') {
        keep.v3.push(item.tokenId.toString());
      }
    }
  };
  let enumUnreadable = 0;
  const ownership = [];
  for (let i = 0; i < wanted.length; i++) {
    const item = wanted[i], hex = ownerHexes[i];
    if (!hex || hex.__error) {
      enumUnreadable++;
      keepItem(item);
      continue;
    }
    let actual;
    try { actual = toAddress(words(hex)[0]).toLowerCase(); }
    catch {
      enumUnreadable++;
      keepItem(item);
      continue;
    }
    ownership.push({ item, actual });
  }

  const gaugeProofItems = [];
  const gaugeDiscovery = new Map();
  for (const row of ownership) {
    const { item, actual } = row;
    if (item.version === 'v4') {
      if (actual === expectedOwner) verified.push(item);
      continue;
    }
    const deployment = v3Deployment(chainKey, item.deploymentId);
    if (!deployment || String(deployment.nfpm).toLowerCase() !== item.manager) {
      enumUnreadable++;
      keepItem(item);
      continue;
    }
    if (deployment.kind !== 'slipstream') {
      if (actual === expectedOwner) verified.push(item);
      continue;
    }
    if (actual === expectedOwner) {
      const walletItem = { ...item, custody: 'wallet' };
      delete walletItem.custodian;
      verified.push(walletItem);
      continue;
    }

    let isConfiguredGauge = item.custody === 'gauge' && actual === item.custodian;
    if (!isConfiguredGauge) {
      let discovered = gaugeDiscovery.get(deployment.id);
      if (!discovered) {
        try {
          discovered = await slipstreamGauges(rpc, chain, deployment);
          gaugeDiscovery.set(deployment.id, discovered);
        } catch {
          enumUnreadable++;
          keepItem(item);
          continue;
        }
      }
      isConfiguredGauge = discovered.gauges.includes(actual);
      if (!isConfiguredGauge && !discovered.complete) {
        enumUnreadable++;
        keepItem(item);
        continue;
      }
    }
    // A different non-gauge owner is positive proof of transfer. A configured
    // gauge still needs the protocol's beneficial-ownership proof.
    if (isConfiguredGauge) gaugeProofItems.push({ item, actual });
  }

  const gaugeProofHexes = await readMany(rpc, gaugeProofItems.map(({ item, actual }) => ({
    to: actual,
    data: dataStakedContains(owner, item.tokenId),
  })), chain.rpcBatchSize);
  for (let index = 0; index < gaugeProofItems.length; index++) {
    const { item, actual } = gaugeProofItems[index];
    const proof = gaugeProofHexes[index];
    if (!proof || proof.__error) {
      enumUnreadable++;
      keepItem(item);
      continue;
    }
    let contained;
    try { contained = toUint(words(proof)[0] || '0') !== 0n; }
    catch {
      enumUnreadable++;
      keepItem(item);
      continue;
    }
    if (contained) verified.push({ ...item, custody: 'gauge', custodian: actual });
  }

  const loaded = await mapLimit(verified, 3, async (item) => ({
    item,
    position: item.version === 'v4'
      ? await loadPositionByVersion(chainKey, item.version, item.tokenId, opts)
      : await loadV3Position(chainKey, item.deploymentId, item.tokenId, {
        ...opts,
        ownerOverride: owner,
        custody: item.custody,
        custodian: item.custodian,
      }),
  }));
  const positions = [];
  let positionUnreadable = 0;
  let closedHidden = 0;
  let v4ClosedHidden = 0;
  let v4Unreadable = 0;
  for (let i = 0; i < verified.length; i++) {
    const item = verified[i], row = loaded[i];
    if (!row || row.__error || !row.position) {
      if (item.version === 'v4') v4Unreadable++;
      else positionUnreadable++;
      keepItem(item);
      continue;
    }
    const position = row.position;
    if (positionIsClosed(item.version, position)) {
      if (!opts.includeClosed) {
        closedHidden++;
        if (item.version === 'v4') v4ClosedHidden++;
        continue;
      }
    } else {
      keepItem(item);
    }
    positions.push(tagPosition(position, chainKey));
  }

  return {
    chain: chainKey,
    count: wanted.length,
    attempted: wanted.length,
    scanned: wanted.length - enumUnreadable,
    enumUnreadable,
    positionUnreadable,
    closedHidden,
    truncated: false,
    stoppedEarly: false,
    enumSource: 'remembered-ownerOf',
    refreshMode: 'current',
    positions,
    currentIndex: keep,
    v4: {
      positions: positions.filter((position) => position.version === 'v4'),
      held: rememberedIds(scope, 'v4').length,
      shown: positions.filter((position) => position.version === 'v4').length,
      closedHidden: v4ClosedHidden,
      unreadable: v4Unreadable,
      unavailable: null,
      source: 'remembered-ownerOf',
    },
  };
}

/**
 * All-chains sweep for one owner. Isolation and progress match loadSweep.
 */
export async function loadAllChains(owner, opts = {}) {
  return loadSweep([owner], Object.keys(CHAINS), opts);
}

async function slipstreamGauges(rpc, chain, deployment) {
  const key = [
    deployment.chainKey,
    deployment.id,
    String(deployment.voter || '').toLowerCase(),
    String(rpc || '').trim().toLowerCase(),
  ].join('|');
  const cached = gaugeCache.get(key);
  if (cached && Date.now() - cached.at < GAUGE_CACHE_MS) {
    return { gauges: cached.gauges, complete: true, source: 'memory' };
  }
  // The voter contains only active/incentivized pools, while the CL factory's
  // historical allPools list is much larger. Classify each voter pool through
  // the factory's on-chain isPool proof so v2 gauges never receive a CL call.
  const lengthHex = await ethCall(rpc, deployment.voter, SELECTOR.voterLength);
  const count = Number(toUint(words(lengthHex)[0] || '0'));
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_GAUGES) {
    throw new Error('UP33 gauge count is outside the safety limit');
  }
  const poolHexes = await readMany(rpc, Array.from({ length: count }, (_, index) => ({
    to: deployment.voter,
    data: dataVoterPool(index),
  })), chain.rpcBatchSize);
  const pools = [];
  let unreadable = 0;
  for (const raw of poolHexes) {
    try {
      if (!raw || raw.__error) throw new Error('pool unreadable');
      const pool = toAddress(words(raw)[0]);
      if (!/^0x0{40}$/.test(pool)) pools.push(pool);
    } catch { unreadable++; }
  }
  const classificationHexes = await readMany(rpc, pools.map((pool) => ({
    to: deployment.factory,
    data: dataIsPool(pool),
  })), chain.rpcBatchSize);
  const clPools = [];
  for (let index = 0; index < pools.length; index++) {
    const raw = classificationHexes[index];
    try {
      if (!raw || raw.__error) throw new Error('pool classification unreadable');
      if (toUint(words(raw)[0] || '0') !== 0n) clPools.push(pools[index]);
    } catch { unreadable++; }
  }
  const gaugeHexes = await readMany(rpc, clPools.map((pool) => ({
    to: deployment.voter,
    data: dataVoterGauge(pool),
  })), chain.rpcBatchSize);
  const gauges = [];
  for (const raw of gaugeHexes) {
    try {
      if (!raw || raw.__error) throw new Error('gauge unreadable');
      const gauge = toAddress(words(raw)[0]).toLowerCase();
      if (!/^0x0{40}$/.test(gauge) && !gauges.includes(gauge)) gauges.push(gauge);
    } catch { unreadable++; }
  }
  const complete = unreadable === 0 && pools.length === count;
  if (complete) gaugeCache.set(key, { at: Date.now(), gauges });
  return { gauges, complete, source: 'voter', unreadable };
}

/** Discover Slipstream NFTs held in gauge custody for a beneficial owner. */
async function scanSlipstreamStakes(rpc, chain, deployment, owner, includeClosed) {
  const discovered = await slipstreamGauges(rpc, chain, deployment);
  const stakeHexes = await readMany(rpc, discovered.gauges.map((gauge) => ({
    to: gauge,
    data: dataStakedValues(owner),
  })), chain.rpcBatchSize);
  const candidates = [];
  let enumUnreadable = Number(discovered.unreadable || 0);
  let truncated = false;
  for (let index = 0; index < discovered.gauges.length; index++) {
    const raw = stakeHexes[index];
    if (!raw || raw.__error) { enumUnreadable++; continue; }
    const remaining = Math.max(0, MAX_POSITIONS + 1 - candidates.length);
    if (!remaining) { truncated = true; break; }
    const decoded = decodeUintArrayBounded(raw, remaining);
    if (!decoded) { enumUnreadable++; continue; }
    if (decoded.truncated) truncated = true;
    for (const tokenId of decoded.values) {
      candidates.push({ tokenId, custodian: discovered.gauges[index] });
    }
    if (candidates.length > MAX_POSITIONS) { truncated = true; break; }
  }
  const wanted = candidates.slice(0, MAX_POSITIONS);
  const positionHexes = await readMany(rpc, wanted.map((item) => ({
    to: deployment.nfpm,
    data: dataPositions(item.tokenId),
  })), chain.rpcBatchSize);
  const ownerHexes = await readMany(rpc, wanted.map((item) => ({
    to: deployment.nfpm,
    data: dataOwnerOf(item.tokenId),
  })), chain.rpcBatchSize);
  // This is deliberately the last ownership read. `stakedValues(owner)` can
  // become stale while the unpinned scan is in flight, and ownerOf alone only
  // proves that the gauge has custody, not which depositor is the beneficiary.
  const custodyProofHexes = await readMany(rpc, wanted.map((item) => ({
    to: item.custodian,
    data: dataStakedContains(owner, item.tokenId),
  })), chain.rpcBatchSize);
  const live = [], records = [];
  let scanned = 0, positionUnreadable = 0, closedHidden = 0;
  for (let index = 0; index < wanted.length; index++) {
    const item = wanted[index];
    const custodyProof = custodyProofHexes[index];
    if (!custodyProof || custodyProof.__error) {
      enumUnreadable++;
      continue;
    }
    let stillBeneficialOwner;
    try { stillBeneficialOwner = toUint(words(custodyProof)[0] || '0') !== 0n; }
    catch {
      enumUnreadable++;
      continue;
    }
    // A clean false is a resolved mid-scan withdrawal or ownership change,
    // not an unreadable position and not this wallet's current holding.
    if (!stillBeneficialOwner) continue;
    try {
      const actualCustodian = toAddress(words(ownerHexes[index])[0]).toLowerCase();
      if (actualCustodian !== item.custodian) throw new Error('gauge custody changed');
      const position = decodePositions(positionHexes[index], deployment.kind);
      if (!position) throw new Error('position unreadable');
      const row = {
        tokenId: item.tokenId,
        ...position,
        deploymentId: deployment.id,
        manager: deployment.nfpm,
        protocol: deployment.protocol,
        custody: 'gauge',
        custodian: item.custodian,
      };
      scanned++;
      // Proven gauge membership stays in the portfolio even after liquidity
      // reaches zero because pending emissions can remain claimable.
      const dead = row.custody !== 'gauge'
        && row.liquidity === 0n && row.tokensOwed0 === 0n && row.tokensOwed1 === 0n;
      if (!dead) records.push({
        tokenId: row.tokenId.toString(),
        deploymentId: deployment.id,
        manager: deployment.nfpm,
        custody: 'gauge',
        custodian: item.custodian,
      });
      if (dead && !includeClosed) closedHidden++;
      else live.push(row);
    } catch {
      positionUnreadable++;
    }
  }
  return {
    live,
    count: candidates.length,
    attempted: wanted.length,
    scanned,
    enumUnreadable,
    positionUnreadable,
    closedHidden,
    truncated,
    discovery: {
      complete: discovered.complete && !truncated && enumUnreadable === 0
        && positionUnreadable === 0,
      ids: [],
      records,
    },
  };
}

/**
 * Current v3 holdings, newest first.
 *
 * Every ownership index is read on every scan, followed by positions() for
 * every id. Closed NFTs are read too because increaseLiquidity can revive any
 * unburned token. Failures are counted instead of being filtered away.
 */
export async function scanV3Holdings(
  rpc, chain, deploymentOrOwner, ownerOrCount, countOrIncludeClosed, maybeIncludeClosed = false,
) {
  // Preserve the exported legacy test/helper signature while the application
  // passes an explicit deployment descriptor.
  const explicitDeployment = deploymentOrOwner && typeof deploymentOrOwner === 'object';
  const deployment = explicitDeployment ? deploymentOrOwner : {
    id: 'default',
    protocol: chain.protocol || 'Uniswap',
    kind: 'uniswap-v3',
    nfpm: chain.nfpm,
    factory: chain.factory,
  };
  const owner = explicitDeployment ? ownerOrCount : deploymentOrOwner;
  const count = explicitDeployment ? countOrIncludeClosed : ownerOrCount;
  const includeClosed = explicitDeployment ? maybeIncludeClosed : !!countOrIncludeClosed;
  const attempted = Math.min(count, MAX_POSITIONS);
  const indexes = Array.from({ length: attempted }, (_, i) => count - 1 - i);
  const idHexes = await readMany(rpc, indexes.map((index) => ({
    to: deployment.nfpm, data: dataTokenOfOwnerByIndex(owner, index),
  })), chain.rpcBatchSize);

  const tokenIds = [];
  let enumUnreadable = 0;
  for (const hex of idHexes) {
    if (!hex || hex.__error) { enumUnreadable++; continue; }
    try { tokenIds.push(toUint(words(hex)[0])); }
    catch { enumUnreadable++; }
  }

  const live = [];
  let scanned = 0;
  let positionUnreadable = 0;
  let closedHidden = 0;
  const currentIds = [];
  const posHexes = await readMany(rpc, tokenIds.map((tokenId) => ({
    to: deployment.nfpm, data: dataPositions(tokenId),
  })), chain.rpcBatchSize);
  for (let i = 0; i < tokenIds.length; i++) {
    const hex = posHexes[i];
    if (!hex || hex.__error) {
      positionUnreadable++;
      currentIds.push(tokenIds[i]);
      continue;
    }
    const pos = decodePositions(hex, deployment.kind);
    if (!pos) {
      positionUnreadable++;
      currentIds.push(tokenIds[i]);
      continue;
    }
    const p = {
      tokenId: tokenIds[i],
      ...pos,
      deploymentId: deployment.id,
      manager: deployment.nfpm,
      protocol: deployment.protocol,
      custody: 'wallet',
      custodian: null,
    };
    scanned++;
    const dead = p.liquidity === 0n && p.tokensOwed0 === 0n && p.tokensOwed1 === 0n;
    if (!dead) currentIds.push(p.tokenId);
    if (dead && !includeClosed) closedHidden++;
    if (!dead || includeClosed) live.push(p);
  }
  return {
    live, attempted, scanned, enumUnreadable, positionUnreadable, closedHidden,
    discovery: {
      complete: attempted === count && enumUnreadable === 0,
      ids: currentIds.map(String),
      records: currentIds.map((tokenId) => ({
        tokenId: String(tokenId),
        deploymentId: deployment.id,
        manager: deployment.nfpm,
        custody: 'wallet',
        custodian: null,
      })),
    },
  };
}

/**
 * Best-effort USD marks from DexScreener.
 *
 * Two guards, and both are load-bearing. Without them this returned prices
 * wrong by orders of magnitude — a real defect, not a hypothetical:
 *
 *  1. CHAIN. DexScreener returns pairs across every chain it indexes, and the
 *     same address frequently exists elsewhere as a bridged or copycat token.
 *     Querying Ethereum WETH returns six PulseChain pairs BEFORE the real ones,
 *     so taking the first pair marked WETH at $0.0000122 instead of $1,932.99.
 *  2. LIQUIDITY. Among pairs on the right chain, a thin pool can quote almost
 *     anything. The deepest qualifying pair wins, and pairs below a floor are
 *     ignored entirely.
 *
 * A dispersion check then compares the deepest pair against other materially
 * liquid ones. If they disagree substantially the token is left UNPRICED rather
 * than marked at a number no one can stand behind — an absent mark renders as
 * "unpriced", which is honest, whereas a wrong mark silently corrupts every
 * dollar figure derived from it.
 *
 * Mirrors the guard structure already proven in
 * `PortfolioManager/scripts/robinhood_chain_lp.py`.
 */
export async function usdPrices(chainKey, addresses) {
  const chain = CHAINS[chainKey];
  const wantChain = chain && chain.dexscreener;
  // In-memory dedupe across a scan. attachUsd runs once per position, so 20
  // positions used to mean 20 DexScreener requests even though nearly all of
  // them share WETH or a stablecoin. Scanning five chains for several wallets
  // multiplies that, and DexScreener is the request budget most likely to be
  // throttled. Short TTL because these are live marks; failures are never
  // cached, so a throttled request retries rather than sticking as "unpriced".
  const fresh = {};
  const missing = [];
  const nowMs = Date.now();
  for (const a of new Set(addresses.map((x) => String(x).toLowerCase()))) {
    const hit = PRICE_MEMO.get(`${chainKey}:${a}`);
    if (hit && nowMs - hit.at < PRICE_MEMO_TTL_MS) fresh[a] = hit.usd;
    else missing.push(a);
  }
  if (!missing.length) return fresh;
  const MIN_LIQUIDITY_USD = 5000;
  const MATERIAL_SHARE = 0.20;   // pools worth comparing against the deepest
  const MAX_DISPERSION = 0.25;   // beyond this, refuse to pick

  const out = {};
  // Only what the memo did not already have. 30 is DexScreener's documented
  // per-request address limit.
  const unique = missing;

  for (let i = 0; i < unique.length; i += 30) {
    const batch = unique.slice(i, i + 30);
    let json;
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch.join(',')}`);
      json = await res.json();
    } catch {
      continue;   // keyless best-effort; absence is "no mark", never 0
    }

    const byToken = new Map();
    for (const pair of json.pairs || []) {
      if (wantChain && String(pair.chainId || '').toLowerCase() !== wantChain) continue;
      const base = pair.baseToken && pair.baseToken.address && pair.baseToken.address.toLowerCase();
      const price = Number(pair.priceUsd);
      const liq = Number((pair.liquidity && pair.liquidity.usd) || 0);
      if (!base || !batch.includes(base) || !(price > 0) || !(liq >= MIN_LIQUIDITY_USD)) continue;
      if (!byToken.has(base)) byToken.set(base, []);
      byToken.get(base).push({ price, liq });
    }

    for (const [token, pairs] of byToken) {
      pairs.sort((a, b) => b.liq - a.liq);
      const best = pairs[0];
      const material = pairs.filter((p) => p.liq >= best.liq * MATERIAL_SHARE);
      const worst = material.reduce(
        (acc, p) => Math.max(acc, Math.abs(p.price - best.price) / best.price), 0);
      if (worst > MAX_DISPERSION) continue;   // leave unpriced rather than guess
      out[token] = best.price;
    }

    // Cache this batch. A token DexScreener answered for but did not price is
    // memoised as undefined so it is not re-requested once per position; a
    // batch that threw never reaches here, so a throttled request retries.
    const at = Date.now();
    for (const token of batch) PRICE_MEMO.set(`${chainKey}:${token}`, { usd: out[token], at });
    if (PRICE_MEMO.size > PRICE_MEMO_MAX) {
      for (const k of [...PRICE_MEMO.keys()].slice(0, PRICE_MEMO.size - PRICE_MEMO_MAX)) {
        PRICE_MEMO.delete(k);
      }
    }
  }
  return { ...fresh, ...out };
}


/**
 * Value a position in USD, or refuse to.
 *
 * A missing price is NOT zero. Treating an unpriced leg as $0 silently
 * understates the position — the same fail-silent class as a scan that
 * overwrites a good mark with 0. If a leg holds a non-zero amount and has no
 * mark, this returns null and the caller must render "unpriced".
 */
export function valueUsd(amount0, amount1, price0, price1) {
  const missing0 = price0 === undefined && amount0 !== 0;
  const missing1 = price1 === undefined && amount1 !== 0;
  if (missing0 || missing1) return null;
  return (price0 ?? 0) * amount0 + (price1 ?? 0) * amount1;
}

/**
 * v4 half of an address sweep.
 *
 * Kept separate from the v3 scan because almost nothing carries over: the v4
 * PositionManager is not ERC721Enumerable, so holdings come from Transfer logs,
 * and there is no per-tokenId event history to attach.
 *
 * Liquidity is checked first, one cheap call per token, so only positions that
 * will actually render pay for the full read. A 22-position wallet costs 22
 * calls to filter instead of ~110 to load everything.
 */
async function scanV4(chainKey, owner, opts = {}) {
  const chain = CHAINS[chainKey];
  if (!chain || !chain.v4PositionManager) {
    return {
      positions: [], held: 0, shown: 0, closedHidden: 0, unreadable: 0,
      unavailable: null,
      discovery: { complete: true, ids: [] },
    };
  }
  const rpc = opts.rpcOverride || chain.rpc;

  const found = await enumerateV4(chainKey, owner, opts);
  if (found.unavailable) {
    return {
      positions: [], held: found.balanceOf ?? null, shown: 0,
      closedHidden: 0, unreadable: found.balanceOf ?? null,
      unavailable: found.unavailable,
      discovery: { complete: false, ids: [] },
    };
  }
  // A short list would read as "you hold fewer positions"; say so instead.
  if (!found.reconciles) {
    return {
      positions: [], held: found.balanceOf, shown: 0,
      closedHidden: 0,
      unreadable: Math.max(0, found.balanceOf - found.tokenIds.length),
      unavailable: `v4 enumeration incomplete — Transfer logs give ${found.tokenIds.length}`
        + ` positions but balanceOf reports ${found.balanceOf}`,
      discovery: {
        complete: false,
        ids: (found.verifiedTokenIds || []).map(String),
      },
    };
  }

  const liquidityHexes = await readMany(rpc, found.tokenIds.map((tokenId) => ({
    to: chain.v4PositionManager, data: V4.positionLiquidity + encUint(tokenId),
  })), chain.rpcBatchSize);
  const checked = found.tokenIds.map((tokenId, index) => {
    const hex = liquidityHexes[index];
    if (!hex || hex.__error) return { __error: hex && hex.__error || 'liquidity unreadable' };
    return { tokenId, closed: toUint(words(hex)[0] || '0') === 0n };
  });
  const liquidityUnreadable = checked.filter((row) => row && row.__error).length;
  const readable = checked.filter((row) => row && !row.__error);
  const currentIds = [
    ...readable.filter((row) => !row.closed).map((row) => row.tokenId),
    ...checked.flatMap((row, index) => (
      row && row.__error ? [found.tokenIds[index]] : []
    )),
  ];
  const closedHidden = opts.includeClosed ? 0 : readable.filter((row) => row.closed).length;
  const wanted = readable
    .filter((row) => opts.includeClosed || !row.closed)
    .map((row) => row.tokenId);

  const loaded = await mapLimit(wanted, 3, (tokenId) =>
    retryRead(() => loadV4Position(chainKey, tokenId, {
      ...opts,
      tokenMeta: (addr) => tokenMeta(rpc, chainKey, addr),
    }), 2));

  const positions = loaded.filter((p) => p && !p.__error);
  const loadUnreadable = loaded.length - positions.length;
  return {
    positions,
    held: found.balanceOf,
    shown: positions.length,
    closedHidden,
    unreadable: liquidityUnreadable + loadUnreadable,
    source: found.source,
    unavailable: null,
    discovery: {
      complete: true,
      ids: currentIds.map(String),
    },
  };
}


/**
 * USD marks for one position.
 *
 * What is honest here, and what is not, comes down to WHEN each side is priced.
 *
 *   vsHoldUsd  — the vs-HODL delta converted at today's price. Legitimate,
 *                because vs-HODL already values both baskets at one moment;
 *                this only restates that single-moment result in dollars.
 *   currentValue — active liquidity plus claimable amounts, marked now.
 *   grossAdded   — every addition valued at its own block.
 *   cashReturned — every collection valued at its own block.
 *   pnl          — currentValue + cashReturned − grossAdded.
 *
 * Historical collections are never marked today. Once value leaves an LP it
 * stops accruing to that position; assuming it remains held double-counts it
 * when the owner rebalances into another NFT.
 *
 * Marks come from DexScreener and are best-effort: an unpriced leg yields null,
 * never zero, because a missing price must not read as a worthless position.
 */
export async function attachUsd(chainKey, p, opts = {}) {
  let prices = {};
  try {
    prices = await usdPrices(chainKey, [p.token0, p.token1]);
  } catch {
    return { ...p, usd: null };
  }
  // Chain-derived marks are preferred over DexScreener: they come from the
  // position's own pool plus the USD reference, so the current value and the
  // historical cash flows are produced the same way. DexScreener only fills the gap for
  // pairs with no leg in the reference token or the stablecoin.
  let chainPair = null;
  try {
    chainPair = await usdPairAt(chainKey, p.token0, p.token1, p.price, 'latest', opts);
  } catch { chainPair = null; }

  const p0 = chainPair ? chainPair.usd0 : prices[p.token0.toLowerCase()];
  const p1 = chainPair ? chainPair.usd1 : prices[p.token1.toLowerCase()];
  if (p0 === undefined && p1 === undefined) return { ...p, usd: null };

  const h = p.history || {};
  const v = h.vsHodl;
  const mark = (a0, a1) => {
    if (a0 === null || a1 === null || a0 === undefined || a1 === undefined) return null;
    if ((a0 !== 0 && p0 === undefined) || (a1 !== 0 && p1 === undefined)) return null;
    return (p0 ?? 0) * a0 + (p1 ?? 0) * a1;
  };

  // Strategy cash flows use event-time dollars on both sides. An addition is
  // capital entering the LP; a Collect is capital leaving it. Once collected,
  // tokens are no longer assumed to remain in the wallet forever — doing that
  // double-counts them when they are re-used in a new NFT.
  let basis = null;
  try { basis = await costBasisUsd(chainKey, p, opts); } catch { basis = null; }
  let proceeds = null;
  try { proceeds = await collectedProceedsUsd(chainKey, p, opts); } catch { proceeds = null; }

  // Decreased-but-uncollected principal lives in collectable, so a remove does
  // not change return until the assets actually leave the position.
  const currentNow = p.collectable0 === null || p.collectable1 === null
    ? null
    : mark(
      (p.amount0 || 0) + p.collectable0,
      (p.amount1 || 0) + p.collectable1,
    );
  const ret = strategyReturn(basis, proceeds, currentNow);
  const tokenPriceChange = tokenPriceChangesSinceFirstAdd(
    basis, p0, p1, h.adds || (h.deposits && h.deposits.length) || 1);
  const latestAddPriceChange = tokenPriceChangesSinceLatestAdd(
    basis, p0, p1, h.adds || (h.deposits && h.deposits.length) || 1);
  const capitalEvents = basis && Array.isArray(basis.legs) ? basis.legs.map((leg, index) => ({
    ...leg,
    kind: index === 0 ? 'opened' : 'added',
  })) : [];
  let returnUnavailable = null;
  if (!basis) returnUnavailable = 'gross additions unpriced';
  else if (!basis.exact) returnUnavailable = 'gross additions are bounded';
  else if (!proceeds) returnUnavailable = 'collected proceeds unpriced';
  else if (!proceeds.exact) returnUnavailable = 'collected proceeds are bounded';
  else if (currentNow === null) returnUnavailable = 'current collectable unavailable';

  return {
    ...p,
    usd: {
      price0: p0 ?? null,
      price1: p1 ?? null,
      tokenPriceChange,
      latestAddPriceChange,
      capitalEvents,
      markSource: chainPair ? 'pool' : 'dexscreener',
      // Only show the bridge caveat when this position actually used the
      // wrapped-native origin-chain price. A direct USDG anchor on Robinhood
      // must not inherit the chain's unrelated WETH pricing assumption.
      bridged: !!(chainPair?.bridged || basis?.bridged || proceeds?.bridged),
      grossAdded: basis ? basis.basis : null,
      grossAddedExact: basis ? basis.exact : null,
      grossAddedBound: basis ? basis.bound : null,
      collectedProceeds: proceeds ? proceeds.proceeds : null,
      collectedProceedsExact: proceeds ? proceeds.exact : null,
      netCashIn: basis && proceeds && basis.exact && proceeds.exact
        ? basis.basis - proceeds.proceeds : null,
      returnUnavailable,
      pnl: ret.pnl,
      pnlPct: ret.pnlPct,
      currentValue: currentNow,
      currentValueIncomplete: p.custody === 'gauge' && currentNow === null,
      // Compatibility aliases for existing local harnesses and old consumers.
      // UI copy no longer calls gross additions a cost basis.
      costBasis: basis ? basis.basis : null,
      costBasisExact: basis ? basis.exact : null,
      costBasisBound: basis ? basis.bound : null,
      totalNow: currentNow,
      // vsHodl.delta is denominated in token1, so it converts with p1 alone.
      vsHodl: v && p1 !== undefined ? v.delta * p1 : null,
      value: mark(p.amount0, p.amount1),
      collectable: mark(p.collectable0, p.collectable1),
      fees: h.fees0 !== undefined && h.fees0 !== null && p1 !== undefined
        ? mark(h.fees0, h.fees1) : null,
      deposited: h.deposited0 !== undefined ? mark(h.deposited0, h.deposited1) : null,
    },
  };
}

/** Where history logs should come from for this chain and these options. */
function historySource(chain, rpc, opts) {
  return {
    rpc: opts.rpcOverride || chain.logsRpc || rpc,
    etherscanKey: opts.etherscanKey || chain.etherscanKey || null,
    etherscanChainId: chain.etherscanChainId || null,
    historyRelay: opts.historyRelay || opts.blockscoutRelay || null,
    historyRelayChainId: chain.etherscanChainId || null,
    blockscout: chain.blockscout || null,
  };
}

/**
 * Present-state enrichment for one decoded position: pool, price, range,
 * composition, collectable. Shared by the address scan and the single-token
 * lookup so the two paths cannot drift apart.
 */
async function enrichPosition(rpc, chain, chainKey, deployment, owner, p) {
  const poolData = deployment.kind === 'slipstream'
    ? dataSlipstreamGetPool(p.token0, p.token1, p.tickSpacing)
    : dataGetPool(p.token0, p.token1, p.fee);
  const poolHex = await retryRead(() => ethCall(rpc, deployment.factory, poolData));
  const pool = toAddress(words(poolHex)[0]);
  if (/^0x0{40}$/.test(pool)) return { ...p, error: 'pool not found' };

  const [
    slotHex, t0, t1, collectHex, dynamicFeeHex, earnedRewardHex, storedRewardHex,
  ] = await Promise.all([
    retryRead(() => ethCall(rpc, pool, dataSlot0())),
    tokenMeta(rpc, chainKey, p.token0),
    tokenMeta(rpc, chainKey, p.token1),
    // from == owner is required; collect() checks the caller is approved.
    p.custody === 'gauge' ? Promise.resolve(null)
      : retryRead(() => ethCall(rpc, deployment.nfpm, dataCollect(p.tokenId, owner), owner))
        .catch(() => null),
    deployment.kind === 'slipstream'
      ? retryRead(() => ethCall(rpc, pool, SELECTOR.poolFee)).catch(() => null)
      : Promise.resolve(null),
    p.custody === 'gauge'
      ? retryRead(() => ethCall(rpc, p.custodian, dataEarnedCl(owner, p.tokenId))).catch(() => null)
      : Promise.resolve(null),
    p.custody === 'gauge'
      ? retryRead(() => ethCall(rpc, p.custodian, dataStoredClReward(p.tokenId))).catch(() => null)
      : Promise.resolve(null),
  ]);

  const slot = decodeSlot0(slotHex);
  const amounts = positionAmounts({ ...p, sqrtPriceX96: slot.sqrtPriceX96 });
  const collectable = collectHex ? decodeCollect(collectHex) : null;
  const dynamicFeeWord = dynamicFeeHex ? words(dynamicFeeHex)[0] : null;
  const fee = deployment.kind === 'slipstream'
    ? (dynamicFeeWord ? Number(toUint(dynamicFeeWord)) : null)
    : p.fee;
  // CLGauge checkpoints the previously accrued portion into rewards[tokenId].
  // earned(owner, tokenId) returns only growth since that checkpoint, so both
  // reads must succeed before displaying their sum.
  const rewardRaw = clGaugeRewardTotal(storedRewardHex, earnedRewardHex);
  const rewardMetadataComplete = deployment.rewardToken
    && deployment.rewardSymbol
    && Number.isInteger(deployment.rewardDecimals);
  const rewards = rewardRaw !== null && rewardMetadataComplete ? [{
    token: deployment.rewardToken,
    symbol: deployment.rewardSymbol,
    amount: scale(Number(rewardRaw), deployment.rewardDecimals),
    raw: rewardRaw,
    kind: 'gauge-emission',
  }] : [];

  return {
    ...p,
    pool,
    fee,
    token0Meta: t0,
    token1Meta: t1,
    currentTick: slot.tick,
    price: humanPrice(slot.sqrtPriceX96, t0.decimals, t1.decimals),
    priceLower: tickToPrice(p.tickLower, t0.decimals, t1.decimals),
    priceUpper: tickToPrice(p.tickUpper, t0.decimals, t1.decimals),
    amount0: scale(amounts.amount0, t0.decimals),
    amount1: scale(amounts.amount1, t1.decimals),
    status: amounts.status,
    // Deliberately named "collectable", not "fees": collect() returns
    // principal owed + fees when a decreaseLiquidity is pending.
    collectable0: collectable ? scale(Number(collectable.amount0), t0.decimals) : null,
    collectable1: collectable ? scale(Number(collectable.amount1), t1.decimals) : null,
    collectableRaw0: collectable ? collectable.amount0 : null,
    collectableRaw1: collectable ? collectable.amount1 : null,
    rewards,
    rewardsUnavailable: p.custody === 'gauge' && !rewards.length
      ? 'pending UP reward could not be read' : null,
  };
}

function unavailableSlipstreamHistory(p, unavailable, currentUnavailable = false) {
  return {
    ...p,
    history: { unavailable, currentUnavailable },
  };
}

/**
 * Direct UP33 positions can use ordinary v3 cash-flow accounting only when
 * their complete NFT history proves uninterrupted wallet custody since mint.
 * Any gauge custody, external transfer, partial log read, or ownership race
 * keeps lifetime return unavailable.
 */
async function attachDeploymentHistory(source, chainKey, deployment, p, owner) {
  if (deployment.kind !== 'slipstream') {
    return attachHistory(source, chainKey, deployment, p);
  }
  if (p.custody === 'gauge') {
    return unavailableSlipstreamHistory(
      p,
      'UP33 lifetime accounting is unavailable for staked positions until historical gauge emissions and trading fees are included',
      true,
    );
  }

  // First prove the ordinary v3-family lifecycle and arithmetic. The custody
  // proof runs afterwards against a newer captured head, so a stake or transfer
  // that occurs while lifecycle history is loading cannot unlock a stale PnL.
  const attached = await attachHistory(source, chainKey, deployment, p);
  if (!attached.history || attached.history.unavailable) return attached;

  const expectedOwner = String(owner || '').toLowerCase();
  const head = await fetchHistoryCheckpoint(source, 'latest');
  if (head.unavailable) {
    return unavailableSlipstreamHistory(
      p, 'UP33 direct-custody history could not be proven',
    );
  }

  const lifecycleHead = Number(attached.history.checkedThrough);
  if (!Number.isSafeInteger(lifecycleHead) || lifecycleHead < 0
      || lifecycleHead > head.block) {
    return unavailableSlipstreamHistory(
      p, 'UP33 lifecycle and custody history could not be aligned',
    );
  }
  if (lifecycleHead < head.block) {
    const lifecycleTail = await fetchHistoryRange(
      source, deployment.nfpm, p.tokenId, lifecycleHead + 1, head.block,
    );
    if (lifecycleTail.unavailable || lifecycleTail.events.length) {
      return unavailableSlipstreamHistory(
        p, 'UP33 position history changed during refresh; retry in a moment',
      );
    }
  }

  let ownerAtHead;
  try {
    const ownerHex = await retryRead(() => ethCall(
      source.rpc,
      deployment.nfpm,
      dataOwnerOf(p.tokenId),
      null,
      '0x' + BigInt(head.block).toString(16),
    ), 2);
    ownerAtHead = toAddress(words(ownerHex)[0]).toLowerCase();
  } catch {
    return unavailableSlipstreamHistory(
      p, 'UP33 direct-custody history could not be proven',
    );
  }
  if (ownerAtHead !== expectedOwner) {
    return unavailableSlipstreamHistory(
      p, 'UP33 direct custody changed during refresh; retry in a moment',
    );
  }

  const transfers = await fetchExactTokenTransfers({
    ...source,
    contract: deployment.nfpm,
    tokenId: p.tokenId,
    fromBlock: 0,
    toBlock: head.block,
  });
  if (transfers.unavailable) {
    return unavailableSlipstreamHistory(
      p, 'UP33 direct-custody history could not be proven',
    );
  }
  const custody = uninterruptedDirectCustody(
    transfers.events, expectedOwner, p.tokenId,
  );
  if (!custody.ok) {
    return unavailableSlipstreamHistory(
      p, 'UP33 lifetime accounting is unavailable after staking or another custody transfer',
    );
  }
  const firstDepositTx = attached.history.deposits?.[0]?.transactionHash;
  const mintTx = transfers.events[0]?.transactionHash;
  if (!firstDepositTx || !mintTx
      || String(firstDepositTx).toLowerCase() !== String(mintTx).toLowerCase()) {
    return unavailableSlipstreamHistory(
      p, 'UP33 mint and first liquidity addition could not be matched',
    );
  }
  const canonicalHead = await fetchHistoryCheckpoint(source, head.block);
  if (canonicalHead.unavailable
      || String(canonicalHead.hash).toLowerCase() !== String(head.hash).toLowerCase()) {
    return unavailableSlipstreamHistory(
      p, 'UP33 custody checkpoint changed during refresh; retry in a moment',
    );
  }
  return {
    ...attached,
    history: {
      ...attached.history,
      directCustodyProven: true,
      custodyCheckedThrough: head.block,
      custodySource: transfers.source,
    },
  };
}

/**
 * Lifetime history for one enriched position. One eth_getLogs. An endpoint
 * that refuses wide ranges degrades to `history.unavailable` rather than
 * failing the position.
 */
async function attachHistory(source, chainKey, deployment, p) {
  const fp = fingerprint(p);
  const identity = historyIdentity(p);
  if (!identity) {
    return { ...p, history: { unavailable: 'position identity is incomplete' } };
  }

  const previous = await readHistoryAny(
    chainKey, deployment.nfpm, p.tokenId, identity,
  );
  const head = await fetchHistoryCheckpoint(source, 'latest');
  if (head.unavailable) {
    return {
      ...p,
      history: { unavailable: `history head unavailable: ${head.unavailable}` },
    };
  }

  let h = null;
  let incrementalFailure = null;

  // A matching anchor proves the cached prefix through that block is still on
  // the canonical chain. Replace everything after it, even when the mutable
  // positions() fingerprint is unchanged.
  if (previous && previous.checkedThrough <= head.block
      && previous.anchorBlock <= head.block) {
    const anchor = await fetchHistoryCheckpoint(source, previous.anchorBlock);
    if (!anchor.unavailable && anchor.hash === previous.anchorHash) {
      const fromBlock = previous.anchorBlock + 1;
      const tail = fromBlock <= head.block
        ? await fetchHistoryRange(
          source, deployment.nfpm, p.tokenId, fromBlock, head.block,
        )
        : { events: [], source: 'empty-tail' };
      if (!tail.unavailable) {
        let recent = { events: [], source: null };
        // Indexed tails can lag at the head. Supplement the fixed last 128
        // blocks directly from RPC so a just-mined net-zero sequence is seen.
        if (tail.source !== 'rpc-tail' && tail.source !== 'empty-tail') {
          recent = await fetchRecentHistory(source, deployment.nfpm, p.tokenId, {
            fromBlock: Math.max(0, head.block - HISTORY_REORG_OVERLAP + 1),
            toBlock: head.block,
          });
        }
        if (!recent.unavailable) {
          h = {
            events: replaceHistoryTail(
              previous.events,
              previous.anchorBlock,
              mergeHistoryEvents(tail.events, recent.events),
            ),
            source: [previous.source || 'cache-v2', tail.source, recent.source]
              .filter(Boolean).join('+'),
          };
        } else {
          incrementalFailure = recent.unavailable;
        }
      } else {
        incrementalFailure = tail.unavailable;
      }
    } else {
      incrementalFailure = anchor.unavailable || 'history cache anchor changed';
    }
  }

  // Missing/invalid/reorged caches get a complete bounded rebuild through the
  // captured head. An indexed result is accepted only with a direct recent
  // RPC supplement at that same head.
  if (!h) {
    const full = await fetchHistoryRange(
      source, deployment.nfpm, p.tokenId, 0, head.block, true,
    );
    if (full.unavailable) {
      h = {
        unavailable: [incrementalFailure, full.unavailable]
          .filter(Boolean).join('; ') || 'history refresh unavailable',
      };
    } else {
      let recent = { events: [], source: null };
      if (full.source !== 'rpc-tail') {
        recent = await fetchRecentHistory(source, deployment.nfpm, p.tokenId, {
          fromBlock: Math.max(0, head.block - HISTORY_REORG_OVERLAP + 1),
          toBlock: head.block,
        });
      }
      if (recent.unavailable) {
        h = { unavailable: `recent history unavailable: ${recent.unavailable}` };
      } else {
        h = {
          events: mergeHistoryEvents(full.events, recent.events),
          source: [full.source, recent.source].filter(Boolean).join('+'),
        };
      }
    }
  }

  // A changed positions() state with an identical canonical event set means
  // the newest transaction is still missing. Do not stamp old history as new.
  if (!h.unavailable && previous && previous.fingerprint !== fp
      && !historyChanged(previous.events, h.events)) {
    return {
      ...p,
      history: { unavailable: 'latest transaction is not indexed yet; retry in a moment' },
    };
  }
  if (!h.unavailable && (!h.events || h.events.length === 0)) {
    return {
      ...p,
      history: {
        unavailable: 'zero lifetime events; a minted position must have at least one IncreaseLiquidity',
      },
    };
  }
  if (!h.unavailable && !reconciles(h.events, p.liquidity)) {
    // Never cache an incomplete set, and never derive figures from one.
    return {
      ...p,
      history: {
        unavailable: 'event history incomplete; entry price and PnL cannot be trusted for this position',
      },
    };
  }
  if (!h.unavailable) {
    const anchorBlock = Math.max(0, head.block - HISTORY_REORG_OVERLAP);
    const anchor = anchorBlock === head.block
      ? head : await fetchHistoryCheckpoint(source, anchorBlock);
    if (!anchor.unavailable) {
      await writeHistory({
        chainKey,
        nfpm: deployment.nfpm,
        tokenId: p.tokenId,
        identity,
        fp,
        events: h.events,
        source: h.source,
        checkedThrough: head.block,
        anchorBlock,
        anchorHash: anchor.hash,
      });
    }
  }
  if (h.unavailable) return { ...p, history: { unavailable: h.unavailable } };

  const acct = accounting(h.events);
  const d0 = p.token0Meta.decimals, d1 = p.token1Meta.decimals;
  const priced = (ev) => {
    const r = solveSqrtPrice({ ...ev, tickLower: p.tickLower, tickUpper: p.tickUpper });
    return r ? { ...r, price: r.sqrtP * r.sqrtP * Math.pow(10, d0 - d1) } : null;
  };

  const firstAdd = h.events.find((e) => e.kind === 'increase');
  const lastRemove = [...h.events].reverse().find((e) => e.kind === 'decrease');
  const deposits = h.events.filter((e) => e.kind === 'increase').map((e) => ({
    block: e.block,
    time: e.time,
    transactionHash: e.transactionHash || null,
    logIndex: e.logIndex ?? null,
    liquidityRaw: String(e.liquidity),
    amount0Raw: String(e.amount0),
    amount1Raw: String(e.amount1),
    amount0: scale(Number(e.amount0), d0),
    amount1: scale(Number(e.amount1), d1),
    entry: priced(e),
  }));
  const collections = h.events.filter((e) => e.kind === 'collect').map((e) => {
    // A DecreaseLiquidity in the same transaction gives the exact pool price
    // for a collect that mixes returned principal with fees. Fee-only collects
    // have no such event; historical slot0 pricing gets a chance later.
    const paired = e.transactionHash
      ? [...h.events].reverse().find((candidate) => candidate.kind === 'decrease'
        && candidate.transactionHash === e.transactionHash
        && (candidate.logIndex ?? -1) < (e.logIndex ?? Number.MAX_SAFE_INTEGER))
      : null;
    return {
      block: e.block,
      time: e.time,
      transactionHash: e.transactionHash || null,
      logIndex: e.logIndex ?? null,
      amount0Raw: String(e.amount0),
      amount1Raw: String(e.amount1),
      amount0: scale(Number(e.amount0), d0),
      amount1: scale(Number(e.amount1), d1),
      entry: paired ? priced(paired) : null,
    };
  });
  const fee0 = p.collectableRaw0 === null
    ? null : lifetimeFees(acct.received0, p.collectableRaw0, acct.withdrawn0);
  const fee1 = p.collectableRaw1 === null
    ? null : lifetimeFees(acct.received1, p.collectableRaw1, acct.withdrawn1);
  const fees0 = fee0 === null ? null : scale(Number(fee0), d0);
  const fees1 = fee1 === null ? null : scale(Number(fee1), d1);
  const currentUnavailable = p.collectable0 === null || p.collectable1 === null;
  const historyForComparison = {
    deposited0: scale(Number(acct.deposited0), d0),
    deposited1: scale(Number(acct.deposited1), d1),
    received0: scale(Number(acct.received0), d0),
    received1: scale(Number(acct.received1), d1),
    fees0,
    fees1,
    firstTime: acct.firstTime,
    lastTime: acct.lastTime,
    exit: p.liquidity === 0n && lastRemove ? priced(lastRemove) : null,
    adds: acct.adds,
  };
  const closedAt = p.liquidity === 0n && lastRemove ? {
    block: lastRemove.block,
    time: lastRemove.time,
    transactionHash: lastRemove.transactionHash || null,
    logIndex: lastRemove.logIndex ?? null,
    liquidityRaw: String(lastRemove.liquidity),
    amount0Raw: String(lastRemove.amount0),
    amount1Raw: String(lastRemove.amount1),
    amount0: scale(Number(lastRemove.amount0), d0),
    amount1: scale(Number(lastRemove.amount1), d1),
  } : null;

  return {
    ...p,
    history: {
      entry: firstAdd ? priced(firstAdd) : null,
      // An exit price only exists once the position is actually closed.
      exit: p.liquidity === 0n && lastRemove ? priced(lastRemove) : null,
      // Cross-NFT lineage is proven only from a unique same-transaction
      // close-then-open sequence. Keep the exact final decrease event identity
      // alongside the existing first-deposit identity so that proof never
      // depends on token names, nearby blocks, or approximate amounts.
      closedAt,
      deposits,
      collections,
      deposited0: scale(Number(acct.deposited0), d0),
      deposited1: scale(Number(acct.deposited1), d1),
      received0: scale(Number(acct.received0), d0),
      received1: scale(Number(acct.received1), d1),
      fees0,
      fees1,
      adds: acct.adds,
      firstBlock: acct.firstBlock,
      firstTime: acct.firstTime,
      lastTime: acct.lastTime,
      currentUnavailable,
      checkedThrough: head.block,
      source: h.source + (h.cached ? ' (cached)' : ''),
      vsHodl: currentUnavailable ? null : vsHodl(p, historyForComparison),
    },
  };
}

/**
 * Position value against simply having held the deposit — impermanent loss,
 * net of fees. This is the number an LP actually wants, and it needs no
 * historical USD at all.
 *
 * Why this is legitimate where `token_delta × price_now` is not: both baskets
 * are valued at ONE price. That is a same-moment comparison of two portfolios,
 * not a historical quantity delta multiplied by today's mark. The refusal
 * elsewhere in this project is about the latter and does not apply here.
 *
 * WHICH price is a correctness question, not a detail. A closed position
 * stopped being exposed at its exit price; valuing its deposit basket at spot
 * charges it with market moves that happened after it ceased to exist. Measured
 * on position 961877 the difference is the whole conclusion: +0.022% priced at
 * exit (fees beat IL), −0.470% priced at spot (a loss that never happened).
 *
 * Denominated in token1. Returns null when there is nothing to compare.
 */
function vsHodl(p, h) {
  const closed = p.liquidity === 0n && h.exit;
  const price = closed ? h.exit.price : p.price;
  if (!price || !Number.isFinite(price)) return null;

  if (p.collectable0 === null || p.collectable1 === null
      || h.fees0 === null || h.fees1 === null) return null;

  const have0 = h.received0 + (p.amount0 || 0) + p.collectable0;
  const have1 = h.received1 + (p.amount1 || 0) + p.collectable1;

  const hodl = h.deposited0 * price + h.deposited1;
  const have = have0 * price + have1;
  if (!hodl) return null;

  const delta = have - hodl;

  // Decomposition. A position's value satisfies
  //     value_now = value_hodl + fees_earned - impermanent_loss
  // so with fees known exactly (Collect minus Decrease, plus what is still
  // claimable), IL is the remainder rather than a separate estimate. Reporting
  // only the net hides which of the two is driving it — a position can be up
  // on huge fees despite severe IL, or barely up because neither happened, and
  // those call for opposite decisions.
  const fees = h.fees0 * price + h.fees1;
  const il = fees - delta;   // positive means IL cost you

  // Realised fee yield over the position's ACTUAL life, which is a different
  // and more honest number than Uniswap's trailing-24h APR: it is what this
  // position really earned, not what the pool paid yesterday. Null without
  // timestamps rather than guessed from block heights.
  let apr = null, aprDays = null;
  const end = closed ? h.lastTime : Math.floor(Date.now() / 1000);
  if (h.adds === 1 && h.firstTime && end && end > h.firstTime) {
    const years = (end - h.firstTime) / 31557600;
    if (years > 0) {
      apr = (fees / hodl) / years * 100;
      // The sample window travels with the number. Annualising a few hours
      // multiplies them by thousands — a 4h sample carries a x2192 factor — so
      // an APR from a young position is an extrapolation, not a yield. Callers
      // must be able to say so rather than print a confident percentage.
      aprDays = years * 365.25;
    }
  }

  return {
    delta,
    pct: (have / hodl - 1) * 100,
    fees,
    feesPct: (fees / hodl) * 100,
    il,
    ilPct: (il / hodl) * 100,
    apr,
    aprDays,
    price,
    pricedAt: closed ? 'exit' : 'spot',
  };
}

/**
 * Load exactly one position by tokenId, with no owner known up front.
 *
 * This is the path the on-page overlay uses: a Uniswap position URL carries
 * chain and tokenId but not the owner, and `collect()` must be staticcalled
 * as the owner, so ownerOf is read first. Everything after that is the same
 * code the popup runs.
 */
export async function loadPositionByVersion(chainKey, version, tokenId, opts = {}) {
  if (String(version).toLowerCase() === 'v4') {
    const chain = CHAINS[chainKey];
    const rpc = opts.rpcOverride || (chain && chain.rpc);
    const v4pos = await loadV4Position(chainKey, tokenId, {
      ...opts,
      tokenMeta: (addr) => tokenMeta(rpc, chainKey, addr),
    });
    return opts.withUsd === false ? v4pos : attachUsd(chainKey, v4pos, opts);
  }
  return loadPosition(chainKey, tokenId, opts);
}

export async function loadPosition(chainKey, tokenId, opts = {}) {
  const deployment = v3Deployment(chainKey, opts.deploymentId || null);
  if (!deployment) throw new Error(`unknown v3 deployment for ${chainKey}`);
  return loadV3Position(chainKey, deployment.id, tokenId, opts);
}

export async function loadV3Position(chainKey, deploymentId, tokenId, opts = {}) {
  const chain = CHAINS[chainKey];
  if (!chain) throw new Error(`unknown chain ${chainKey}`);
  const deployment = v3Deployment(chainKey, deploymentId);
  if (!deployment) throw new Error(`unknown v3 deployment ${deploymentId} on ${chainKey}`);
  const rpc = opts.rpcOverride || chain.rpc;

  const [posHex, ownerHex] = await Promise.all([
    ethCall(rpc, deployment.nfpm, dataPositions(tokenId)),
    ethCall(rpc, deployment.nfpm, dataOwnerOf(tokenId)).catch(() => null),
  ]);

  const pos = decodePositions(posHex, deployment.kind);
  if (!pos) throw new Error(`position ${tokenId} not readable on ${chainKey}`);
  const nftOwner = ownerHex ? toAddress(words(ownerHex)[0]) : null;
  const owner = opts.ownerOverride || nftOwner;
  const custody = opts.custody === 'gauge' ? 'gauge' : 'wallet';
  const base = {
    tokenId,
    ...pos,
    deploymentId: deployment.id,
    manager: deployment.nfpm,
    protocol: deployment.protocol,
    custody,
    custodian: custody === 'gauge' ? (opts.custodian || nftOwner) : null,
  };

  const enriched = await enrichPosition(rpc, chain, chainKey, deployment, owner, base);
  if (enriched.error) return { ...enriched, owner };
  const full = await attachDeploymentHistory(
    historySource(chain, rpc, opts), chainKey, deployment, enriched, owner,
  );
  const priced = opts.withUsd === false ? full : await attachUsd(chainKey, full, opts);
  return tagPosition({ ...priced, owner, nftOwner, version: 'v3' }, chainKey, deployment);
}
