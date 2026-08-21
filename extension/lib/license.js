/**
 * Invite-only beta access (and, still in this file, the older trial / licence
 * paths). GATING_ENABLED is the master switch: false returns the product to
 * honestly-free with no storage, no clock, no network.
 *
 * DESIGN CONSTRAINTS, all of which shaped this:
 *
 * 1. NO WALLET, EVER. The access key is an opaque string. It works identically
 *    whether the user paid by card or by sending tokens to a wallet, because
 *    the extension never learns which. That keeps the whole payment decision
 *    swappable and keeps the extension free of signing code.
 *
 * 2. FAIL OPEN, NOT CLOSED. If the validation endpoint is unreachable, a
 *    previously-valid key keeps working for GRACE_DAYS. A tester must not
 *    lose access because a Worker had a bad afternoon. Grace applies ONLY
 *    when the endpoint is unreachable — never when it answers valid: false.
 *    A revocation that the Worker confirmed is a revocation.
 *
 * 3. HONEST ABOUT ENFORCEMENT. This is a client-side gate. Someone determined
 *    can unpack the extension and delete the check, and no amount of
 *    obfuscation changes that — the code has to run on their machine. The gate
 *    exists because most people would rather paste a key than patch a CRX on
 *    every update, not because it is unbreakable. Real enforcement would
 *    require the computation to happen server-side, which is a different
 *    product.
 *
 * 4. THE TRIAL CLOCK IS LOCAL. It lives in chrome.storage, so clearing it
 *    restarts the trial. Same reasoning as above: this is a speed bump for the
 *    honest majority, not a lock. Invite-only beta does not start that clock;
 *    the path is kept below so a paid trial can be restored without rewriting
 *    the file.
 */

const TRIAL_DAYS = 3;
const GRACE_DAYS = 7;          // offline tolerance for a key already seen valid
// Revocation should land in hours, not a day. Hitting a free Worker every
// six hours is fine at beta scale (a handful of testers, one POST each).
const RECHECK_HOURS = 6;
const INSTALLATION_ID_KEY = 'lplensInstallationId';
let installationIdPromise = null;

export const GATING_ENABLED = true;

// REPLACE after `wrangler deploy` with the printed URL. Must match the
// host_permissions entry in manifest.json (exact host, not *.workers.dev).
// If this is still the placeholder at runtime, entitlement() fails loud
// with state: 'misconfigured' — never a silent allow, never a silent
// "key not recognised".
export const VALIDATE_URL_PLACEHOLDER = 'https://lplens-beta.REPLACE-ME.workers.dev/';
export const VALIDATE_URL = "https://lplens-beta.licence-worker.workers.dev/";

const DAY = 86_400_000;

const GENERIC_INVALID = 'This licence key was not recognised.';
export const INVITE_REASON =
  'This LPLens build is invite-only. Paste the access key you were sent into options.';
export const MISCONFIGURED_REASON =
  'This LPLens build is not finished: the access-check URL is still the placeholder. Deploy the Cloudflare Worker, put its URL in lib/license.js, and match host_permissions in manifest.json.';

function urlIsPlaceholder(url) {
  return !url || url === VALIDATE_URL_PLACEHOLDER || /REPLACE-ME/i.test(String(url));
}

async function store(keys) {
  try { return await chrome.storage.local.get(keys); } catch { return {}; }
}
async function save(obj) {
  try { await chrome.storage.local.set(obj); } catch { /* non-fatal */ }
}

/**
 * Random per-browser-install identifier for soft seat counting.
 *
 * It is not a fingerprint and contains no machine facts. chrome.storage.local
 * does not sync it to another browser; uninstalling or clearing extension data
 * removes it. The Worker stores only SHA-256(installationId).
 */
export async function installationId() {
  if (installationIdPromise) return installationIdPromise;
  installationIdPromise = (async () => {
    const existing = await store([INSTALLATION_ID_KEY]);
    if (/^[0-9a-f]{32}$/.test(existing[INSTALLATION_ID_KEY] || '')) {
      return existing[INSTALLATION_ID_KEY];
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    await save({ [INSTALLATION_ID_KEY]: id });
    return id;
  })();
  return installationIdPromise;
}

/**
 * Ask the endpoint whether a key is good. Network failure is NOT a verdict —
 * it returns null so the caller can fall back to the cached answer.
 * A 200 with valid: false IS a verdict; the server's reason is passed through.
 */
async function validateRemote(key, installId) {
  if (!VALIDATE_URL || urlIsPlaceholder(VALIDATE_URL) || !key) return null;
  try {
    const res = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, installationId: installId }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (typeof body.valid !== 'boolean') return null;
    return {
      valid: body.valid,
      expires: body.expires || null,
      reason: body.reason || null,
      installations: Number.isInteger(body.installations) ? body.installations : null,
      installationLimit: Number.isInteger(body.installationLimit) ? body.installationLimit : null,
    };
  } catch {
    return null;
  }
}

/**
 * Current entitlement.
 *
 * Returns { allowed, state, daysLeft, reason, expires } where state is one of
 * 'free' | 'licensed' | 'trial' | 'expired' | 'invalid' | 'needs_key' |
 * 'misconfigured'. Never throws: a gate that crashes is a gate that blocks
 * testers.
 *
 * `state: 'free'` is the ungated product (GATING_ENABLED false).
 * Invite-only beta: no key -> needs_key; placeholder URL -> misconfigured.
 */
export async function entitlement() {
  if (!GATING_ENABLED) return { allowed: true, state: 'free' };

  if (urlIsPlaceholder(VALIDATE_URL)) {
    return { allowed: false, state: 'misconfigured', reason: MISCONFIGURED_REASON };
  }

  const s = await store(['licenseKey', 'licenseSeen', 'trialStart']);
  const now = Date.now();
  const key = (s.licenseKey || '').trim();

  if (key) {
    const installId = await installationId();
    const seen = s.licenseSeen && s.licenseSeen.key === key ? s.licenseSeen : null;
    const stale = !seen || (now - (seen.at || 0)) > RECHECK_HOURS * 3600_000;

    if (stale) {
      const remote = await validateRemote(key, installId);
      if (remote) {
        await save({
          licenseSeen: {
            key, at: now, valid: remote.valid,
            expires: remote.expires, reason: remote.reason || null,
            installations: remote.installations,
            installationLimit: remote.installationLimit,
          },
        });
        if (remote.valid) {
          return { allowed: true, state: 'licensed', expires: remote.expires };
        }
        return {
          allowed: false,
          state: 'invalid',
          reason: remote.reason || GENERIC_INVALID,
          expires: remote.expires || null,
        };
      }
      // Endpoint unreachable. Trust a previously-valid key for the grace
      // window. This does NOT apply when the Worker answered valid: false.
      if (seen && seen.valid && (now - seen.at) < GRACE_DAYS * DAY) {
        return { allowed: true, state: 'licensed', offline: true, expires: seen.expires };
      }
      return {
        allowed: false,
        state: 'invalid',
        reason: seen && seen.reason ? seen.reason : GENERIC_INVALID,
      };
    } else if (seen.valid) {
      return { allowed: true, state: 'licensed', expires: seen.expires };
    } else {
      return {
        allowed: false,
        state: 'invalid',
        reason: seen.reason || GENERIC_INVALID,
        expires: seen.expires || null,
      };
    }
  }

  // Invite-only: a link without a key grants nothing. Do not start a trial
  // clock. The paid-trial path is kept below, unreachable, so restoring it
  // is deleting this return (the same shape as GATING_ENABLED's early exit).
  return { allowed: false, state: 'needs_key', reason: INVITE_REASON };

  // --- paid-trial path (unreachable in invite-only beta) ---
  // Start the trial clock on first use rather than at install, so someone
  // who installs and forgets does not lose their trial to the calendar.
  let trialStart = s.trialStart;
  if (!trialStart) {
    trialStart = now;
    await save({ trialStart });
  }
  const elapsed = now - trialStart;
  const daysLeft = Math.max(0, TRIAL_DAYS - Math.floor(elapsed / DAY));
  if (elapsed < TRIAL_DAYS * DAY) {
    return { allowed: true, state: 'trial', daysLeft };
  }
  return {
    allowed: false,
    state: 'expired',
    reason: `Your ${TRIAL_DAYS}-day trial has ended.`,
  };
}

/**
 * Credentials for the authenticated history relay. Callers already perform an
 * entitlement check; the Worker verifies the key and expiry again per relay
 * request, so a patched caller cannot turn this into an unauthenticated proxy.
 */
export async function blockscoutRelayCredentials() {
  if (!GATING_ENABLED || urlIsPlaceholder(VALIDATE_URL)) return null;
  const s = await store(['licenseKey']);
  const key = String(s.licenseKey || '').trim();
  if (!key) return null;
  return {
    url: new URL('blockscout', VALIDATE_URL).href,
    key,
    installationId: await installationId(),
  };
}

/** Trial length, exported so the UI never hardcodes a second copy. */
export const TRIAL_LENGTH_DAYS = TRIAL_DAYS;

/** Beta / gate headlines. Consumers use this so copy cannot drift. */
export function gateHeadline(state) {
  if (state === 'misconfigured') return 'This build is not finished';
  if (state === 'needs_key') return 'Invite-only beta';
  if (state === 'invalid') return 'Access not granted';
  if (state === 'expired') return 'Trial ended';
  if (state === 'licensed') return 'Access active';
  if (state === 'trial') return 'Trial';
  return 'Access required';
}

export function gateHint(state) {
  if (state === 'needs_key') {
    return 'Paste the access key you were sent into options to continue.';
  }
  if (state === 'misconfigured') {
    return 'The person who built this still needs to deploy the access-check Worker.';
  }
  if (state === 'invalid') {
    return 'If you were invited, your access may have ended. Check options or ask Dan.';
  }
  return 'Paste your access key in options to continue.';
}
