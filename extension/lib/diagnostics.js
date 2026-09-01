/**
 * Privacy-safe support diagnostics.
 *
 * Raw provider errors, wallet addresses, labels, token symbols, pool ids and
 * position ids never cross this boundary. The saved report is deliberately
 * boring: version, UI surface, coarse counts and allowlisted error classes.
 * A user must still press Copy before anything leaves chrome.storage.local.
 */

export const DIAGNOSTIC_STORAGE_KEY = 'lplensDiagnosticSummary';

export const ERROR_CODES = Object.freeze([
  'rate_limit', 'timeout', 'network', 'history', 'ownership', 'unreadable', 'rpc', 'unknown',
]);

const ERROR_CODE_SET = new Set(ERROR_CODES);

export function normalizeErrorCode(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return 'unknown';
  if (/\b429\b|rate.?limit|too many requests|daily (?:history )?allowance/.test(text)) {
    return 'rate_limit';
  }
  if (/timeout|timed out|aborterror|aborted/.test(text)) return 'timeout';
  if (/history|blockscout|etherscan|\beth_getlogs\b|\blogs?\b/.test(text)) return 'history';
  if (/owner|ownership|enumerat|balance could not be verified/.test(text)) return 'ownership';
  if (/unreadable|not readable|could not read|incomplete|mismatch/.test(text)) return 'unreadable';
  if (/eth_call|json-rpc|\brpc\b|revert|execution error|pool not found/.test(text)) return 'rpc';
  if (/network|failed to fetch|fetch failed|http 50[234]|temporarily unavailable|no response/.test(text)) {
    return 'network';
  }
  return 'unknown';
}

export function positionBucket(count) {
  const n = Math.max(0, Number(count) || 0);
  if (n === 0) return '0';
  if (n === 1) return '1';
  if (n <= 5) return '2-5';
  if (n <= 20) return '6-20';
  return '21+';
}

export function durationBucket(durationMs) {
  const n = Math.max(0, Number(durationMs) || 0);
  if (n < 5_000) return '<5s';
  if (n < 15_000) return '5-15s';
  if (n < 30_000) return '15-30s';
  if (n < 60_000) return '30-60s';
  return '60s+';
}

function resultIssueCodes(result) {
  const codes = [];
  const r = result || {};
  if (r.count > (r.attempted ?? r.scanned)) codes.push('unreadable');
  if (r.enumUnreadable) codes.push('ownership');
  if (r.positionUnreadable) codes.push('unreadable');
  const v4 = r.v4 || {};
  if (v4.unavailable) codes.push(normalizeErrorCode(v4.unavailable));
  if (v4.unreadable) codes.push('unreadable');
  return codes;
}

function safeChainKey(value, allowed) {
  const key = String(value || '').toLowerCase();
  return allowed.has(key) ? key : 'unknown';
}

/** Build the only scan shape that may be saved or sent as product telemetry. */
export function buildScanDiagnostic({
  surface, startedAt, finishedAt = Date.now(), jobs = [], states = {},
  positionCount = 0, hiddenCount = 0, includeClosed = false,
  savedWalletCount = 0, accessState = 'unknown', telemetryEnabled = true,
  optionalPageAccess = {},
}) {
  const manifest = chrome.runtime.getManifest();
  const allowedChains = new Set(jobs.map((job) => String(job.chainKey || '').toLowerCase()));
  const chainRows = {};
  const errors = new Map();
  let complete = 0;
  let failed = 0;
  let issues = 0;

  for (const job of jobs) {
    const chain = safeChainKey(job.chainKey, allowedChains);
    const state = states[`${job.owner || job.address || ''}@${job.chainKey}`];
    const row = chainRows[chain] || { jobs: 0, complete: 0, failed: 0, issues: 0 };
    row.jobs++;
    if (state && state.phase !== 'start') {
      complete++;
      row.complete++;
      const codes = state.ok === false
        ? [normalizeErrorCode(state.error)]
        : resultIssueCodes(state.result);
      if (state.ok === false) {
        failed++;
        row.failed++;
      }
      if (codes.length) {
        issues++;
        row.issues++;
      }
      for (const code of new Set(codes)) {
        const safe = ERROR_CODE_SET.has(code) ? code : 'unknown';
        const key = `${chain}:${safe}`;
        errors.set(key, (errors.get(key) || 0) + 1);
      }
    }
    chainRows[chain] = row;
  }

  const outcome = failed === jobs.length && jobs.length
    ? 'failed'
    : failed || issues || complete < jobs.length
      ? 'partial'
      : Number(positionCount) > 0 ? 'success' : 'empty';
  const errorCounts = [...errors.entries()].map(([key, count]) => {
    const [chain, code] = key.split(':');
    return { chain, code, count };
  });

  return {
    product: 'LPLens',
    version: String(manifest.version || ''),
    generatedAt: new Date(finishedAt).toISOString(),
    surface: ['popup', 'sidepanel'].includes(surface) ? surface : 'unknown',
    accessState: String(accessState || 'unknown'),
    settings: {
      includeClosed: !!includeClosed,
      savedWalletCount: Math.max(0, Number(savedWalletCount) || 0),
      hiddenPositionCount: Math.max(0, Number(hiddenCount) || 0),
      anonymousScanOutcomes: !!telemetryEnabled,
      optionalPageAccess: {
        uniswap: !!optionalPageAccess.uniswap,
        projectx: !!optionalPageAccess.projectx,
        dexscreener: !!optionalPageAccess.dexscreener,
        up33: !!optionalPageAccess.up33,
      },
    },
    scan: {
      outcome,
      duration: durationBucket(finishedAt - startedAt),
      positionCount: Math.max(0, Number(positionCount) || 0),
      positionBucket: positionBucket(positionCount),
      jobs: { total: jobs.length, complete, failed, issues },
      chains: chainRows,
      errors: errorCounts,
    },
  };
}

export async function saveDiagnosticReport(report) {
  await chrome.storage.local.set({ [DIAGNOSTIC_STORAGE_KEY]: report });
  return report;
}

export async function readDiagnosticReport() {
  const stored = await chrome.storage.local.get([DIAGNOSTIC_STORAGE_KEY]);
  const report = stored[DIAGNOSTIC_STORAGE_KEY];
  return report && typeof report === 'object' ? report : null;
}

export function diagnosticText(report) {
  return JSON.stringify(report, null, 2);
}

export async function copyDiagnosticReport(report) {
  const text = diagnosticText(report);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('Clipboard access was unavailable.');
}
