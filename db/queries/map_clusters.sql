-- Sensor map cluster-head markers. GET /map (cluster heads half)
-- @returns cluster_id, name, farm_zone, location_lat, location_lon, revoked, last_seen, node_count
SELECT c.cluster_id, c.name, c.farm_zone, c.location_lat, c.location_lon, c.revoked,
       h."timestamp" AS last_seen,
       (SELECT count(*)::int FROM nodes n
         WHERE n.org_id = c.org_id AND n.cluster_id = c.cluster_id AND n.active) AS node_count
FROM cluster_heads c
LEFT JOIN LATERAL (
  SELECT ch."timestamp" FROM cluster_health ch
  WHERE ch.org_id = c.org_id AND ch.cluster_id = c.cluster_id
  ORDER BY ch."timestamp" DESC LIMIT 1
) h ON true
WHERE c.org_id = current_org_id()
ORDER BY c.name;
