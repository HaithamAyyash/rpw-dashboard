-- Ingest -> classification and ingest -> alert latency, for report Table 6.3.
-- @params from:timestamptz to:timestamptz
-- @returns classified, classify_p50_ms, classify_p95_ms, alerts, alert_p50_ms, alert_p95_ms
WITH classified AS (
  SELECT EXTRACT(EPOCH FROM c.processed_at - f.ingested_at) * 1000 AS ms
  FROM classification_results c
  JOIN acoustic_features f ON f.node_id = c.node_id AND f."timestamp" = c."timestamp"
  WHERE c.org_id = current_org_id() AND c."timestamp" >= $1 AND c."timestamp" < $2
),
alerted AS (
  SELECT EXTRACT(EPOCH FROM a.created_at - f.ingested_at) * 1000 AS ms
  FROM alert_log a
  JOIN acoustic_features f ON f.node_id = a.node_id AND f."timestamp" = a.measurement_ts
  WHERE a.org_id = current_org_id() AND a.measurement_ts >= $1 AND a.measurement_ts < $2
)
SELECT (SELECT count(*)::int FROM classified) AS classified,
       (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) FROM classified)::real AS classify_p50_ms,
       (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) FROM classified)::real AS classify_p95_ms,
       (SELECT count(*)::int FROM alerted) AS alerts,
       (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) FROM alerted)::real AS alert_p50_ms,
       (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) FROM alerted)::real AS alert_p95_ms;
