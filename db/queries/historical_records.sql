-- Historical records. GET /nodes/{node_id}/features?from=&to=[&include=mfcc], and the CSV export.
-- node_id NULL means every node in the organization.
-- @params node_id:bigint from:timestamptz to:timestamptz include_mfcc:boolean limit:int offset:int
-- @returns node_id, lora_id, tree_label, timestamp, energy, snr_db, rssi_dbm, status, msg_id, received_at, ingested_at, label, confidence, model_version, mfcc
SELECT f.node_id, n.lora_id, n.tree_label, f."timestamp", f.energy, f.snr_db, f.rssi_dbm, f.status,
       f.msg_id, f.received_at, f.ingested_at,
       c.label, c.confidence, c.model_version,
       CASE WHEN $4 THEN f.mfcc END AS mfcc
FROM acoustic_features f
JOIN nodes n ON n.org_id = f.org_id AND n.node_id = f.node_id
LEFT JOIN LATERAL (
  SELECT r.label, r.confidence, r.model_version FROM classification_results r
  WHERE r.org_id = f.org_id AND r.node_id = f.node_id AND r."timestamp" = f."timestamp"
  ORDER BY r.processed_at DESC LIMIT 1
) c ON true
WHERE f.org_id = current_org_id()
  AND ($1::bigint IS NULL OR f.node_id = $1)
  AND f."timestamp" >= $2 AND f."timestamp" < $3
ORDER BY f."timestamp" DESC, f.node_id
LIMIT $5 OFFSET $6;
