-- System health, node cards. GET /health/nodes. NULL battery/uptime means "no data yet".
-- @params limit:int offset:int zone:text
-- @returns node_id, lora_id, tree_label, farm_zone, status, battery_mv, rssi_dbm, uptime_s, last_heartbeat, last_classified, total_count
SELECT n.node_id, n.lora_id, n.tree_label, n.farm_zone, s.status, s.battery_mv, s.rssi_dbm,
       s.uptime_s, s.last_heartbeat, s.last_classified,
       count(*) OVER () AS total_count
FROM nodes n
JOIN node_status s ON s.org_id = n.org_id AND s.node_id = n.node_id
WHERE n.org_id = current_org_id()
  AND ($3::text IS NULL OR n.farm_zone = $3)
ORDER BY n.tree_label, n.node_id
LIMIT $1 OFFSET $2;
