-- Historical records side panel: how many records, how many positive.
-- @params node_id:bigint from:timestamptz to:timestamptz zone:text
-- @returns total_records, positive_detections
SELECT count(*)::int AS total_records,
       (SELECT count(*)::int FROM classification_results c
         JOIN nodes n ON n.org_id = c.org_id AND n.node_id = c.node_id
         WHERE c.org_id = current_org_id() AND c.label = 'infested'
           AND ($1::bigint IS NULL OR c.node_id = $1)
           AND c."timestamp" >= $2 AND c."timestamp" < $3
           AND ($4::text IS NULL OR n.farm_zone = $4)) AS positive_detections
FROM acoustic_features f
JOIN nodes n ON n.org_id = f.org_id AND n.node_id = f.node_id
WHERE f.org_id = current_org_id()
  AND ($1::bigint IS NULL OR f.node_id = $1)
  AND f."timestamp" >= $2 AND f."timestamp" < $3
  AND ($4::text IS NULL OR n.farm_zone = $4);
