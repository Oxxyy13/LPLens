-- Read-only, tester-only, last 30 UTC days. Requires the additive v2 schema.
-- Received reports are not unique users/scans, and opt-out is not zero missing.
SELECT extension_version, surface,
       SUM(scans) AS received_scan_reports,
       SUM(CASE WHEN coverage_reported = 1 THEN scans ELSE 0 END) AS reports_with_coverage,
       SUM(CASE WHEN duration_bucket = '60s+' THEN scans ELSE 0 END) AS reports_at_least_60s
FROM scan_outcomes_v2_daily
WHERE cohort = 'tester' AND day >= date('now', '-30 days')
GROUP BY extension_version, surface;

SELECT extension_version, surface,
       SUM(positions) AS observed_positions,
       SUM(CASE WHEN code = 'available' THEN positions ELSE 0 END) AS return_available,
       SUM(CASE WHEN code != 'available' THEN positions ELSE 0 END) AS return_missing,
       ROUND(100.0 * SUM(CASE WHEN code = 'available' THEN positions ELSE 0 END)
         / NULLIF(SUM(positions), 0), 1) AS available_percent
FROM lp_return_coverage_daily
WHERE cohort = 'tester' AND metric = 'availability' AND day >= date('now', '-30 days')
GROUP BY extension_version, surface;

-- Price causes can overlap, unlike primary availability reasons.
SELECT extension_version, metric, code, SUM(positions) AS observations
FROM lp_return_coverage_daily
WHERE cohort = 'tester' AND day >= date('now', '-30 days')
GROUP BY extension_version, metric, code
ORDER BY observations DESC;

SELECT extension_version, chain_key, error_code, SUM(occurrences) AS occurrences
FROM scan_errors_v2_daily
WHERE cohort = 'tester' AND day >= date('now', '-30 days')
GROUP BY extension_version, chain_key, error_code
ORDER BY occurrences DESC;
