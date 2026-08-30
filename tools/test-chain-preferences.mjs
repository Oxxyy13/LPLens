#!/usr/bin/env node
import assert from 'node:assert/strict';

const stored = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        const keys = Array.isArray(key) ? key : [key];
        return Object.fromEntries(keys.filter((entry) => stored.has(entry))
          .map((entry) => [entry, stored.get(entry)]));
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) stored.set(key, value);
      },
    },
  },
};

const {
  DISABLED_PORTFOLIO_CHAINS_KEY,
  enabledPortfolioChains,
  loadDisabledPortfolioChains,
  normalizeDisabledPortfolioChains,
  portfolioChainSummary,
  loadPortfolioRefreshScope,
  normalizePortfolioRefreshScope,
  saveDisabledPortfolioChains,
  savePortfolioRefreshScope,
} = await import('../extension/lib/scan-preferences.js?surface=a');

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
assert.equal(portfolioChainSummary(chains, []), 'All');
assert.equal(portfolioChainSummary(chains, ['base', 'robinhood']), '4 selected');
assert.equal(portfolioChainSummary(chains, chains), 'None');
await saveDisabledPortfolioChains(['base', 'robinhood'], chains);
const secondSurface = await import('../extension/lib/scan-preferences.js?surface=b');
assert.deepEqual(await secondSurface.loadDisabledPortfolioChains(chains), ['base', 'robinhood'],
  'the selected chain set must survive a fresh module surface backed by chrome.storage.local');
stored.set(DISABLED_PORTFOLIO_CHAINS_KEY, ['base', 'unknown-chain']);
assert.deepEqual(await secondSurface.loadDisabledPortfolioChains(chains), ['base'],
  'unknown stored chains must be discarded');
assert.equal(normalizePortfolioRefreshScope('all'), 'all');
assert.equal(normalizePortfolioRefreshScope('anything-else'), 'wallet');
assert.equal(await loadPortfolioRefreshScope(), 'wallet');
await savePortfolioRefreshScope('all');
assert.equal(await secondSurface.loadPortfolioRefreshScope(), 'all',
  'wallet scope must survive across popup and side-panel surfaces');

console.log('portfolio scan preferences: chains and wallet scope pass');
