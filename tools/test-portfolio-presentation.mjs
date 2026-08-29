#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  portfolioJobIssue, portfolioScanSummary, restoredPortfolioSummary,
} from '../extension/lib/portfolio-presentation.js';

assert.equal(portfolioScanSummary({
  complete: false, allFailed: false, issueCount: 0, positionCount: 0,
}), 'Refreshing positions…');
assert.equal(portfolioScanSummary({
  complete: true, allFailed: false, issueCount: 0, positionCount: 3,
}), '');
assert.equal(portfolioScanSummary({
  complete: true, allFailed: false, issueCount: 0, positionCount: 0,
}), 'No positions found on selected chains.');
assert.equal(portfolioScanSummary({
  complete: true, allFailed: false, issueCount: 1, positionCount: 3,
}), 'Some chain data could not be read.');
assert.equal(portfolioScanSummary({
  complete: true, allFailed: true, issueCount: 3, positionCount: 0,
}), 'Could not refresh positions.');

assert.equal(restoredPortfolioSummary({
  issueCount: 0, visiblePositionCount: 0, hasPositionCards: true, summaryOnly: false,
}), '', 'an all-hidden saved view still contains positions');
assert.equal(restoredPortfolioSummary({
  issueCount: 0, visiblePositionCount: 0, hasPositionCards: false, summaryOnly: true,
}), '', 'a bounded summary implies the full saved view contained position cards');
assert.equal(restoredPortfolioSummary({
  issueCount: 0, visiblePositionCount: 0, hasPositionCards: false, summaryOnly: false,
}), 'No positions found on selected chains.');

assert.equal(portfolioJobIssue({ phase: 'start' }), '');
assert.equal(portfolioJobIssue({ ok: true, result: { positions: [], closedHidden: 24 } }), '');
assert.equal(portfolioJobIssue({
  ok: true, result: { positions: [], v4: { closedHidden: 23 } },
}), '', 'closed v4 positions must not return to visible scan details');
assert.equal(portfolioJobIssue({ ok: false, error: 'HTTP 429 rate limit' }),
  'Rate limited. Try again shortly.');
const privateProviderFailure = portfolioJobIssue({
  ok: false,
  error: 'eth_call HTTP 429 https://rpc.invalid/?key=FAKE_SECRET 0x1234567890abcdef',
});
assert.equal(privateProviderFailure, 'Rate limited. Try again shortly.');
assert.doesNotMatch(privateProviderFailure, /rpc\.invalid|FAKE_SECRET|0x1234567890abcdef/,
  'friendly issue copy must never echo raw provider URLs, wallet data, or credentials');
const unknownPrivateFailure = portfolioJobIssue({
  ok: false,
  error: 'provider exploded https://secret.invalid token=TOP_SECRET',
});
assert.equal(unknownPrivateFailure, 'This chain could not be read.');
assert.doesNotMatch(unknownPrivateFailure, /secret\.invalid|TOP_SECRET/,
  'unknown provider failures must use fixed copy rather than echoing raw text');
assert.equal(portfolioJobIssue({ ok: false, error: 'fetch failed' }),
  'Network unavailable. Try again.');
assert.equal(portfolioJobIssue({
  ok: true,
  result: {
    count: 12,
    attempted: 10,
    enumUnreadable: 1,
    positionUnreadable: 2,
    v4: { unavailable: 'HTTP 429' },
  },
}), 'Some v3 positions were beyond the scan limit. '
  + 'Some v3 position ownership could not be verified. '
  + 'Some v3 positions could not be read. V4 data: Rate limited. Try again shortly.');

console.log('portfolio presentation: compact status and friendly issue copy pass');
