-- One tree. GET /trees/{node_id}. No row (so 404) for another organization's node.
-- @params node_id:bigint
-- @returns node_id, lora_id, tree_label, farm_zone, cluster_id, cluster_name, install_date, location_lat, location_lon, status, avg_confidence, last_runs, last_classified, last_heartbeat, battery_mv, rssi_dbm, uptime_s
SELECT n.node_id, n.lora_id, n.tree_label, n.farm_zone, n.cluster_id, c.name AS cluster_name,
       n.install_date, n.location_lat, n.location_lon,
       s.status, s.avg_confidence, s.last_runs, s.last_classified,
       s.last_heartbeat, s.battery_mv, s.rssi_dbm, s.uptime_s
FROM nodes n
JOIN cluster_heads c ON c.org_id = n.org_id AND c.cluster_id = n.cluster_id
JOIN node_status s ON s.org_id = n.org_id AND s.node_id = n.node_id
WHERE n.org_id = current_org_id() AND n.node_id = $1;
