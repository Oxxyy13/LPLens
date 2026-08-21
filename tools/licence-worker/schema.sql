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
