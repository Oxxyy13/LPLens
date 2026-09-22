import { telemetryCredentials } from './license.js';
import { validateReturnCoverage } from './scan-quality.js';

export const TELEMETRY_SETTING_KEY = 'shareAnonymousScanOutcomes';
export const RETURN_COVERAGE_SETTING_KEY = 'shareLpReturnCoverageV1';

/** New data requires a separate affirmative choice, including existing installs. */
export async function returnCoverageEnabled() {
  try {
    const s = await chrome.storage.local.get([TELEMETRY_SETTING_KEY, RETURN_COVERAGE_SETTING_KEY]);
    return s[TELEMETRY_SETTING_KEY] !== false && s[RETURN_COVERAGE_SETTING_KEY] === true;
  } catch { return false; }
}

/** Existing beta installs share coarse outcomes unless the user turns it off. */
export async function telemetryEnabled() {
  try {
    const stored = await chrome.storage.local.get([TELEMETRY_SETTING_KEY]);
    return stored[TELEMETRY_SETTING_KEY] !== false;
  } catch {
    return false;
  }
}

/**
 * Fire-and-forget aggregate telemetry. A failure here must never change the
 * scan result. The report has already passed through diagnostics.js, and only
 * the allowlisted aggregate subset below is transmitted.
 */
export async function sendScanTelemetry(report) {
  try {
    if (!await telemetryEnabled()) return false;
    const credentials = await telemetryCredentials();
    if (!credentials || !report || !report.scan) return false;
    // Recheck consent after awaiting credentials. Turning sharing off also
    // suppresses a pending scan report; enabling it later does not backfill.
    const settings = await chrome.storage.local.get([TELEMETRY_SETTING_KEY, RETURN_COVERAGE_SETTING_KEY]);
    if (settings[TELEMETRY_SETTING_KEY] === false) return false;
    let lpReturns = null;
    if (settings[RETURN_COVERAGE_SETTING_KEY] === true && report.scan.lpReturns) {
      try { lpReturns = validateReturnCoverage(report.scan.lpReturns); }
      catch { /* Invalid coverage cannot suppress the ordinary scan report. */ }
    }
    const response = await fetch(credentials.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: credentials.key,
        version: report.version,
        surface: report.surface,
        outcome: report.scan.outcome,
        positionBucket: report.scan.positionBucket,
        durationBucket: report.scan.duration,
        errors: report.scan.errors,
        ...(lpReturns === null ? {} : { lpReturns }),
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
