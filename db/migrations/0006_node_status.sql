-- migrate:up

-- The one definition of tree status; cards, map, summary and the worker all read it.
-- security_invoker: row-level security applies as the caller, not as the view's owner.
-- Offline = no heartbeat for 56 h: two missed nightly heartbeats (48 h), plus the 8 h width
-- of the night window, since a heartbeat can land anywhere inside it. A node with no health
-- data at all is NOT offline (decision D2): with SNR gating, silence proves nothing.
CREATE VIEW node_status WITH (security_invoker = true) AS
SELECT n.org_id, n.node_id,
       r.avg_confidence, r.last_runs, r.classified_runs, r.last_classified,
       h."timestamp" AS last_heartbeat, h.battery_mv, h.rssi_dbm, h.uptime_s,
       CASE
         WHEN h."timestamp" IS NOT NULL AND h."timestamp" < now() - INTERVAL '56 hours' THEN 'offline'
         WHEN r.classified_runs = 0 THEN 'unknown'
         WHEN r.avg_confidence >= o.alert_threshold THEN 'alert'
         WHEN r.avg_confidence >= o.suspect_threshold THEN 'suspected'
         ELSE 'healthy'
       END AS status
FROM nodes n
JOIN organizations o ON o.org_id = n.org_id
CROSS JOIN LATERAL (
  SELECT avg(l.confidence)::numeric(4,3) AS avg_confidence,
         array_agg(l.confidence ORDER BY l."timestamp" DESC) AS last_runs,
         count(*)::int AS classified_runs,
         max(l."timestamp") AS last_classified
  FROM (
    SELECT c.confidence, c."timestamp" FROM classification_results c
    WHERE c.org_id = n.org_id AND c.node_id = n.node_id
    ORDER BY c."timestamp" DESC LIMIT 3
  ) l
) r
LEFT JOIN LATERAL (
  SELECT nh."timestamp", nh.battery_mv, nh.rssi_dbm, nh.uptime_s FROM node_health nh
  WHERE nh.org_id = n.org_id AND nh.node_id = n.node_id
  ORDER BY nh."timestamp" DESC LIMIT 1
) h ON true
WHERE n.active;

-- migrate:down
DROP VIEW node_status;
