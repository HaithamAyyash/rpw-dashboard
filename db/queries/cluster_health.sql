-- System health, cluster-head cards. GET /health/clusters. NULL fields mean "no data yet".
-- @returns cluster_id, name, farm_zone, uplink_type, revoked, last_seen, uptime_s, rssi_dbm, sd_free_mb, buffered_count
SELECT c.cluster_id, c.name, c.farm_zone, COALESCE(h.uplink_type, c.uplink_type) AS uplink_type,
       c.revoked, h."timestamp" AS last_seen, h.uptime_s, h.rssi_dbm, h.sd_free_mb, h.buffered_count
FROM cluster_heads c
LEFT JOIN LATERAL (
  SELECT ch.* FROM cluster_health ch
  WHERE ch.org_id = c.org_id AND ch.cluster_id = c.cluster_id
  ORDER BY ch."timestamp" DESC LIMIT 1
) h ON true
WHERE c.org_id = current_org_id()
ORDER BY c.name;
