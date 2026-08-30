/**
 * Portfolio-scan network preferences.
 *
 * Store the disabled networks rather than the enabled networks. Missing local
 * state therefore means "scan everything", and a network added in a future
 * release is enabled by default. These preferences scope portfolio sweeps
 * only; protocol-page overlays can still read a directly opened position on
 * any supported network.
 */

export const DISABLED_PORTFOLIO_CHAINS_KEY = 'disabledPortfolioChainsV1';
export const PORTFOLIO_REFRESH_SCOPE_KEY = 'portfolioRefreshScopeV1';

const memory = {};
const store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
  ? chrome.storage.local
  : null;

function availableChainKeys(chainKeys) {
  return [...new Set((Array.isArray(chainKeys) ? chainKeys : [])
    .filter((key) => typeof key === 'string' && key))];
}

export function normalizeDisabledPortfolioChains(raw, chainKeys) {
  const available = availableChainKeys(chainKeys);
  const requested = new Set(Array.isArray(raw) ? raw : []);
  return available.filter((key) => requested.has(key));
}

export function enabledPortfolioChains(chainKeys, disabled) {
  const available = availableChainKeys(chainKeys);
  const blocked = new Set(normalizeDisabledPortfolioChains(disabled, available));
  return available.filter((key) => !blocked.has(key));
}

export function portfolioChainSummary(chainKeys, disabled) {
  const available = availableChainKeys(chainKeys);
  const enabled = enabledPortfolioChains(available, disabled);
  if (enabled.length === available.length) return 'All';
  if (!enabled.length) return 'None';
  return `${enabled.length} selected`;
}

export async function loadDisabledPortfolioChains(chainKeys) {
  try {
    const raw = store
      ? (await store.get(DISABLED_PORTFOLIO_CHAINS_KEY))[DISABLED_PORTFOLIO_CHAINS_KEY]
      : memory[DISABLED_PORTFOLIO_CHAINS_KEY];
    return normalizeDisabledPortfolioChains(raw, chainKeys);
  } catch {
    return [];
  }
}

export async function saveDisabledPortfolioChains(disabled, chainKeys) {
  const value = normalizeDisabledPortfolioChains(disabled, chainKeys);
  if (store) await store.set({ [DISABLED_PORTFOLIO_CHAINS_KEY]: value });
  else memory[DISABLED_PORTFOLIO_CHAINS_KEY] = value;
  return value;
}

export function normalizePortfolioRefreshScope(value) {
  return value === 'all' ? 'all' : 'wallet';
}

export async function loadPortfolioRefreshScope() {
  try {
    const raw = store
      ? (await store.get(PORTFOLIO_REFRESH_SCOPE_KEY))[PORTFOLIO_REFRESH_SCOPE_KEY]
      : memory[PORTFOLIO_REFRESH_SCOPE_KEY];
    return normalizePortfolioRefreshScope(raw);
  } catch {
    return 'wallet';
  }
}

export async function savePortfolioRefreshScope(value) {
  const scope = normalizePortfolioRefreshScope(value);
  if (store) await store.set({ [PORTFOLIO_REFRESH_SCOPE_KEY]: scope });
  else memory[PORTFOLIO_REFRESH_SCOPE_KEY] = scope;
  return scope;
}
