-- Sensor map markers. GET /map (nodes half). Deliberately not paginated: the map draws them all.
-- @returns node_id, lora_id, tree_label, farm_zone, cluster_id, location_lat, location_lon, status, avg_confidence
SELECT n.node_id, n.lora_id, n.tree_label, n.farm_zone, n.cluster_id,
       n.location_lat, n.location_lon, s.status, s.avg_confidence
FROM nodes n
JOIN node_status s ON s.org_id = n.org_id AND s.node_id = n.node_id
WHERE n.org_id = current_org_id()
  AND n.location_lat IS NOT NULL AND n.location_lon IS NOT NULL;
