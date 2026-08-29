import { telemetryCredentials } from './license.js';

export const TELEMETRY_SETTING_KEY = 'shareAnonymousScanOutcomes';

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
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

