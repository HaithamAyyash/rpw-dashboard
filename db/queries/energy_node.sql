-- Acoustic energy for one node. GET /nodes/{node_id}/energy?from=&to=&bucket=
-- @params node_id:bigint from:timestamptz to:timestamptz bucket:interval
-- @returns bucket, avg_energy, avg_snr_db, measurements
SELECT time_bucket($4, f."timestamp") AS bucket,
       avg(f.energy)::real AS avg_energy,
       avg(f.snr_db)::real AS avg_snr_db,
       count(*)::int       AS measurements
FROM acoustic_features f
WHERE f.org_id = current_org_id() AND f.node_id = $1
  AND f.energy IS NOT NULL  -- results from a model on the node have no matrix, so no energy
  AND f."timestamp" >= $2 AND f."timestamp" < $3
GROUP BY 1
ORDER BY 1;
