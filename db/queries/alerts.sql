-- Alert log. GET /alerts?from=&to=&severity=&acknowledged=
-- @params from:timestamptz to:timestamptz severity:text acknowledged:boolean limit:int offset:int zone:text
-- @returns alert_id, timestamp, alert_type, severity, confidence, message, node_id, tree_label, cluster_id, cluster_name, acknowledged, acknowledged_by_name, acknowledged_at, email_sent_at
SELECT a.alert_id, a."timestamp", a.alert_type, a.severity, a.confidence, a.message,
       a.node_id, n.tree_label, a.cluster_id, c.name AS cluster_name,
       a.acknowledged, u.name AS acknowledged_by_name, a.acknowledged_at, a.email_sent_at
FROM alert_log a
LEFT JOIN nodes n ON n.org_id = a.org_id AND n.node_id = a.node_id
LEFT JOIN cluster_heads c ON c.org_id = a.org_id AND c.cluster_id = a.cluster_id
LEFT JOIN users u ON u.user_id = a.acknowledged_by
WHERE a.org_id = current_org_id()
  AND a."timestamp" >= $1 AND a."timestamp" < $2
  AND ($3::text IS NULL OR a.severity = $3)
  AND ($4::boolean IS NULL OR a.acknowledged = $4)
  AND ($7::text IS NULL OR COALESCE(n.farm_zone, c.farm_zone) = $7)
ORDER BY a."timestamp" DESC, a.alert_id DESC
LIMIT $5 OFFSET $6;
