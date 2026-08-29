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
