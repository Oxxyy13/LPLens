#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  enabledPortfolioChains,
  normalizeDisabledPortfolioChains,
  portfolioChainSummary,
} from '../extension/lib/scan-preferences.js';

const chains = ['ethereum', 'base', 'arbitrum', 'polygon', 'hyperevm', 'robinhood'];

assert.deepEqual(normalizeDisabledPortfolioChains(undefined, chains), []);
assert.deepEqual(normalizeDisabledPortfolioChains([
  'robinhood', 'unknown', 'robinhood', 'base', 42,
], chains), ['base', 'robinhood']);
assert.deepEqual(enabledPortfolioChains(chains, []), chains,
  'missing or empty disabled state must keep every network enabled');
assert.deepEqual(enabledPortfolioChains(chains, ['base', 'robinhood']), [
  'ethereum', 'arbitrum', 'polygon', 'hyperevm',
]);
assert.deepEqual(enabledPortfolioChains([...chains, 'futurechain'], ['base', 'robinhood']), [
  'ethereum', 'arbitrum', 'polygon', 'hyperevm', 'futurechain',
], 'newly supported networks must default on without migrating saved preferences');
assert.equal(portfolioChainSummary(chains, []), 'All 6');
assert.equal(portfolioChainSummary(chains, ['base', 'robinhood']), '4 of 6');
assert.equal(portfolioChainSummary(chains, chains), '0 of 6');

console.log('portfolio chain preferences: defaults, filtering and summaries pass');
