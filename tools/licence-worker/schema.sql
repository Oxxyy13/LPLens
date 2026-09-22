-- LPLens beta operational telemetry.
--
-- No plaintext access codes, installation identifiers, wallet addresses,
-- Blockscout filters, IP addresses, or response bodies are stored here.

CREATE TABLE IF NOT EXISTS installations (
  licence_hash TEXT NOT NULL,
  licence_label TEXT NOT NULL,
  installation_hash TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (licence_hash, installation_hash)
);

CREATE INDEX IF NOT EXISTS installations_last_seen
  ON installations (last_seen);

CREATE TABLE IF NOT EXISTS relay_usage_daily (
  licence_hash TEXT NOT NULL,
  licence_label TEXT NOT NULL,
  day TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  last_at TEXT NOT NULL,
  PRIMARY KEY (licence_hash, day)
);

CREATE INDEX IF NOT EXISTS relay_usage_day
  ON relay_usage_daily (day);

-- Anonymous product-quality counters. These rows intentionally have no
-- licence hash or installation hash columns, so they cannot be joined back to
-- a tester, browser or wallet.
CREATE TABLE IF NOT EXISTS scan_outcomes_daily (
  day TEXT NOT NULL,
  extension_version TEXT NOT NULL,
  surface TEXT NOT NULL,
  outcome TEXT NOT NULL,
  position_bucket TEXT NOT NULL,
  duration_bucket TEXT NOT NULL,
  scans INTEGER NOT NULL DEFAULT 0,
  last_at TEXT NOT NULL,
  PRIMARY KEY (
    day, extension_version, surface, outcome, position_bucket, duration_bucket
  )
);

CREATE INDEX IF NOT EXISTS scan_outcomes_day
  ON scan_outcomes_daily (day);

CREATE TABLE IF NOT EXISTS scan_errors_daily (
  day TEXT NOT NULL,
  extension_version TEXT NOT NULL,
  surface TEXT NOT NULL,
  chain_key TEXT NOT NULL,
  error_code TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 0,
  last_at TEXT NOT NULL,
  PRIMARY KEY (
    day, extension_version, surface, chain_key, error_code
  )
);

CREATE INDEX IF NOT EXISTS scan_errors_day
  ON scan_errors_daily (day);

-- Forward-only role-separated counters. Legacy scan_*_daily rows above are
-- mixed traffic and are never guessed, copied, deleted or relabelled.
-- These tables contain only calendar days, closed categories and counters.
CREATE TABLE IF NOT EXISTS scan_outcomes_v2_daily (
  day TEXT NOT NULL,
  extension_version TEXT NOT NULL,
  surface TEXT NOT NULL,
  cohort TEXT NOT NULL CHECK (cohort IN ('tester', 'internal', 'unclassified')),
  outcome TEXT NOT NULL,
  position_bucket TEXT NOT NULL,
  duration_bucket TEXT NOT NULL,
  coverage_reported INTEGER NOT NULL CHECK (coverage_reported IN (0, 1)),
  scans INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, extension_version, surface, cohort, outcome, position_bucket, duration_bucket, coverage_reported)
);

CREATE TABLE IF NOT EXISTS scan_errors_v2_daily (
  day TEXT NOT NULL,
  extension_version TEXT NOT NULL,
  surface TEXT NOT NULL,
  cohort TEXT NOT NULL CHECK (cohort IN ('tester', 'internal', 'unclassified')),
  chain_key TEXT NOT NULL,
  error_code TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, extension_version, surface, cohort, chain_key, error_code)
);

-- Availability is one primary code per observed position. Price causes can
-- overlap, so they must never be added to the availability denominator.
CREATE TABLE IF NOT EXISTS lp_return_coverage_daily (
  day TEXT NOT NULL,
  extension_version TEXT NOT NULL,
  surface TEXT NOT NULL,
  cohort TEXT NOT NULL CHECK (cohort IN ('tester', 'internal', 'unclassified')),
  metric TEXT NOT NULL CHECK (metric IN ('availability', 'price_cause')),
  code TEXT NOT NULL,
  positions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, extension_version, surface, cohort, metric, code)
);
