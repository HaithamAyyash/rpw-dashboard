-- Classification results over a period. GET /classifications?from=&to=&node_id=&label=&min_conf=&sort=
-- @params from:timestamptz to:timestamptz node_id:bigint label:text min_conf:real sort:text limit:int offset:int
-- @returns node_id, lora_id, tree_label, timestamp, model_version, label, confidence, inference_ms, processed_at
-- sort: time_desc (default) | confidence_desc
SELECT c.node_id, n.lora_id, n.tree_label, c."timestamp", c.model_version, c.label, c.confidence,
       c.inference_ms, c.processed_at
FROM classification_results c
JOIN nodes n ON n.org_id = c.org_id AND n.node_id = c.node_id
WHERE c.org_id = current_org_id()
  AND c."timestamp" >= $1 AND c."timestamp" < $2
  AND ($3::bigint IS NULL OR c.node_id = $3)
  AND ($4::text IS NULL OR c.label = $4)
  AND ($5::real IS NULL OR c.confidence >= $5)
ORDER BY
  CASE WHEN $6 = 'confidence_desc' THEN c.confidence END DESC,
  c."timestamp" DESC, c.node_id
LIMIT $7 OFFSET $8;
