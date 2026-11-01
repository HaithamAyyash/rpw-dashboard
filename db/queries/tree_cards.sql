-- Overview tree cards. GET /trees?zone=&status=&q=
-- @params zone:text status:text q:text limit:int offset:int
-- @returns node_id, lora_id, tree_label, farm_zone, cluster_id, status, avg_confidence, last_runs, last_measurement, measurements_24h, battery_mv, rssi_dbm, location_lat, location_lon, total_count
-- Filter and page first, so the per-card look into acoustic_features runs only for one page.
WITH page AS (
  SELECT n.node_id, n.org_id, n.lora_id, n.tree_label, n.farm_zone, n.cluster_id,
         s.status, s.avg_confidence, s.last_runs, s.battery_mv, s.rssi_dbm,
         n.location_lat, n.location_lon,
         count(*) OVER () AS total_count
  FROM node_status s
  JOIN nodes n ON n.org_id = s.org_id AND n.node_id = s.node_id
  WHERE s.org_id = current_org_id()
    AND ($1::text IS NULL OR n.farm_zone = $1)
    AND ($2::text IS NULL OR s.status = $2)
    AND ($3::text IS NULL OR n.tree_label ILIKE '%' || $3 || '%' OR n.lora_id::text = $3)
  ORDER BY n.tree_label, n.node_id
  LIMIT $4 OFFSET $5
)
SELECT p.node_id, p.lora_id, p.tree_label, p.farm_zone, p.cluster_id,
       p.status, p.avg_confidence, p.last_runs,
       (SELECT f."timestamp" FROM acoustic_features f
         WHERE f.org_id = p.org_id AND f.node_id = p.node_id
         ORDER BY f."timestamp" DESC LIMIT 1) AS last_measurement,
       (SELECT count(*)::int FROM acoustic_features f
         WHERE f.org_id = p.org_id AND f.node_id = p.node_id
           AND f."timestamp" >= now() - INTERVAL '24 hours') AS measurements_24h,
       p.battery_mv, p.rssi_dbm, p.location_lat, p.location_lon, p.total_count
FROM page p
ORDER BY p.tree_label, p.node_id;
