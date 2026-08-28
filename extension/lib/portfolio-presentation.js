import { normalizeErrorCode } from './diagnostics.js';

const FRIENDLY_FAILURES = Object.freeze({
  rate_limit: 'Rate limited. Try again shortly.',
  timeout: 'Timed out. Try again.',
  network: 'Network unavailable. Try again.',
  history: 'History service unavailable.',
  ownership: 'Position ownership could not be verified.',
  unreadable: 'Some positions could not be read.',
  rpc: 'The chain RPC could not complete the request.',
  unknown: 'This chain could not be read.',
});

export function portfolioScanSummary({ complete, allFailed, issueCount, positionCount }) {
  if (!complete) return 'Refreshing positions…';
  if (allFailed) return 'Could not refresh positions.';
  if (issueCount) return 'Some chain data could not be read.';
  if (!positionCount) return 'No positions found on selected chains.';
  return '';
}

export function restoredPortfolioSummary({
  issueCount, visiblePositionCount, hasPositionCards, summaryOnly,
}) {
  if (issueCount) return 'Some chain data could not be read.';
  if (visiblePositionCount || hasPositionCards || summaryOnly) return '';
  return 'No positions found on selected chains.';
}

function friendlyFailure(value) {
  return FRIENDLY_FAILURES[normalizeErrorCode(value)] || FRIENDLY_FAILURES.unknown;
}

export function portfolioJobIssue(state) {
  if (!state || state.phase === 'start') return '';
  if (state.ok === false) return friendlyFailure(state.error);

  const result = state.result || {};
  const messages = [];
  if (result.count > (result.attempted ?? result.scanned)) {
    messages.push('Some v3 positions were beyond the scan limit.');
  }
  if (result.enumUnreadable) {
    messages.push('Some v3 position ownership could not be verified.');
  }
  if (result.positionUnreadable) {
    messages.push('Some v3 positions could not be read.');
  }

  const v4 = result.v4 || {};
  if (v4.unavailable) messages.push(`V4 data: ${friendlyFailure(v4.unavailable)}`);
  else if (v4.unreadable) messages.push('Some v4 positions could not be read.');

  return [...new Set(messages)].join(' ');
}
