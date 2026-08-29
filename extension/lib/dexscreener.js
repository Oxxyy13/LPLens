/** Dexscreener pair identity and live-quote cache. */

export const DEXSCREENER_QUOTE_TTL_MS = 30_000;

const positiveNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const parseToken = (value) => {
  const address = String(value && value.address || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return null;
  return { address, symbol: String(value && value.symbol || '').slice(0, 32) };
};

/**
 * Pair token identity is immutable for a service-worker session. Quotes are
 * live inputs and expire separately. A failed refresh never extends freshness
 * and never returns the stale quote as though it were current.
 */
export function createDexscreenerPairCache({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  quoteTtlMs = DEXSCREENER_QUOTE_TTL_MS,
} = {}) {
  const identities = new Map();
  const quotes = new Map();
  const inFlight = new Map();
  const retryAfter = new Map();

  const snapshot = (key) => {
    const identity = identities.get(key);
    const quote = quotes.get(key);
    const fresh = quote && now() - quote.at < quoteTtlMs;
    if (!identity) return null;
    return {
      ...identity,
      priceNative: fresh ? quote.priceNative : null,
      priceUsd: fresh ? quote.priceUsd : null,
      marketCap: fresh ? quote.marketCap : null,
      fdv: fresh ? quote.fdv : null,
      quoteFresh: !!fresh,
    };
  };

  const get = async (apiChain, poolRef) => {
    const key = `${String(apiChain).toLowerCase()}:${String(poolRef).toLowerCase()}`;
    const cached = snapshot(key);
    if (cached && cached.quoteFresh) return cached;
    if (cached && now() < (retryAfter.get(key) || 0)) return cached;
    if (inFlight.has(key)) return inFlight.get(key);

    const promise = (async () => {
      try {
        const url = `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(apiChain)}/${encodeURIComponent(poolRef)}`;
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
        if (!response.ok) throw new Error(`Dexscreener pair lookup failed: HTTP ${response.status}`);
        const json = await response.json();
        const candidates = Array.isArray(json && json.pairs) ? json.pairs : [];
        const pair = candidates.find((item) =>
          String(item && item.pairAddress || '').toLowerCase() === String(poolRef).toLowerCase());
        if (!pair) throw new Error('Dexscreener pair metadata unavailable');

        const baseToken = parseToken(pair.baseToken);
        const quoteToken = parseToken(pair.quoteToken);
        if (!baseToken || !quoteToken) throw new Error('Dexscreener pair identity malformed');
        const quote = {
          at: now(),
          priceNative: positiveNumber(pair.priceNative),
          priceUsd: positiveNumber(pair.priceUsd),
          marketCap: positiveNumber(pair.marketCap),
          fdv: positiveNumber(pair.fdv),
        };
        if (!quote.priceNative || (!quote.priceUsd && !quote.marketCap && !quote.fdv)) {
          throw new Error('Dexscreener live quote malformed');
        }
        // Treat pair identity and its first live quote as one proof. A partial
        // response must not seed an identity that a later failed lookup could
        // return as though Dexscreener had fully established it.
        identities.set(key, { baseToken, quoteToken });
        quotes.set(key, quote);
        retryAfter.delete(key);
        return snapshot(key);
      } catch (error) {
        // Keep immutable orientation if it was already proven, but return no
        // live conversion values after a failed or expired quote refresh.
        const identityOnly = snapshot(key);
        if (identityOnly) {
          retryAfter.set(key, now() + 2_000);
          return identityOnly;
        }
        throw error;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, promise);
    return promise;
  };

  return { get };
}
