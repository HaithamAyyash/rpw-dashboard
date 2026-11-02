-- Classification screen default: latest result per node. GET /classifications
-- @params label:text min_conf:real sort:text limit:int offset:int zone:text
-- @returns node_id, lora_id, tree_label, timestamp, model_version, label, confidence, status, total_count
-- sort: confidence_desc (default) | confidence_asc | time_desc | tree_asc
SELECT n.node_id, n.lora_id, n.tree_label, s.last_classified AS "timestamp",
       s.last_model_version AS model_version, s.last_label AS label,
       s.last_runs[1] AS confidence, s.status, count(*) OVER () AS total_count
FROM nodes n
JOIN node_status s ON s.org_id = n.org_id AND s.node_id = n.node_id
WHERE n.org_id = current_org_id()
  AND s.classified_runs > 0
  AND ($6::text IS NULL OR n.farm_zone = $6)
  AND ($1::text IS NULL OR s.last_label = $1)
  AND ($2::real IS NULL OR s.last_runs[1] >= $2)
ORDER BY
  CASE WHEN $3 = 'confidence_asc' THEN s.last_runs[1] END ASC,
  CASE WHEN $3 = 'time_desc' THEN s.last_classified END DESC,
  CASE WHEN $3 = 'tree_asc' THEN n.tree_label END ASC,
  s.last_runs[1] DESC, n.node_id
LIMIT $4 OFFSET $5;
