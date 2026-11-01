-- Overview stat cards. GET /summary?zone=
-- @params zone:text
-- @returns trees_monitored, healthy, suspected, alerts, offline, unknown, active_nodes, total_nodes, measurements_last_hour, suspected_yesterday, suspected_change, with_heartbeat
WITH zone_nodes AS (
  SELECT n.node_id FROM nodes n
  WHERE n.org_id = current_org_id() AND n.active
    AND ($1::text IS NULL OR n.farm_zone = $1)
),
current_status AS (
  SELECT s.status, s.last_heartbeat FROM node_status s
  JOIN zone_nodes z ON z.node_id = s.node_id
  WHERE s.org_id = current_org_id()
),
yesterday AS (
  -- The same last-3 rule, as things stood 24 h ago.
  SELECT count(*) FILTER (WHERE y.avg_confidence >= o.suspect_threshold
                            AND y.avg_confidence < o.alert_threshold) AS suspected
  FROM zone_nodes z
  JOIN organizations o ON o.org_id = current_org_id()
  CROSS JOIN LATERAL (
    SELECT avg(l.confidence) AS avg_confidence FROM (
      SELECT c.confidence FROM classification_results c
      WHERE c.org_id = current_org_id() AND c.node_id = z.node_id
        AND c."timestamp" <= now() - INTERVAL '24 hours'
      ORDER BY c."timestamp" DESC LIMIT 3
    ) l
  ) y
),
counts AS (
  SELECT count(*)::int                                     AS trees_monitored,
         count(*) FILTER (WHERE status = 'healthy')::int   AS healthy,
         count(*) FILTER (WHERE status = 'suspected')::int AS suspected,
         count(*) FILTER (WHERE status = 'alert')::int     AS alerts,
         count(*) FILTER (WHERE status = 'offline')::int   AS offline,
         count(*) FILTER (WHERE status = 'unknown')::int   AS unknown,
         count(last_heartbeat)::int                        AS with_heartbeat
  FROM current_status
)
SELECT c.trees_monitored, c.healthy, c.suspected, c.alerts, c.offline, c.unknown,
       c.trees_monitored - c.offline AS active_nodes,
       c.trees_monitored             AS total_nodes,
       (SELECT count(*)::int FROM acoustic_features f
         WHERE f.org_id = current_org_id() AND f."timestamp" >= now() - INTERVAL '1 hour'
           AND f.node_id IN (SELECT node_id FROM zone_nodes)) AS measurements_last_hour,
       y.suspected::int              AS suspected_yesterday,
       c.suspected - y.suspected::int AS suspected_change,
       c.with_heartbeat
FROM counts c, yesterday y;
