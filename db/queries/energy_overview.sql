-- Overlay chart: healthy average vs suspected vs alert. GET /energy/overview?from=&to=&bucket=
-- Trees are grouped by their CURRENT status, not their status at the time of the measurement.
-- @params from:timestamptz to:timestamptz bucket:interval
-- @returns bucket, status, avg_energy, nodes, measurements
-- Aggregate first (index-only, so no MFCC is loaded), then attach status. MATERIALIZED stops the
-- planner undoing this: it underestimates the status filter and would look up node by node.
WITH per_node AS MATERIALIZED (
  SELECT time_bucket($3, f."timestamp") AS bucket, f.node_id,
         sum(f.energy) AS energy_sum, count(*) AS measurements
  FROM acoustic_features f
  WHERE f.org_id = current_org_id()
    AND f."timestamp" >= $1 AND f."timestamp" < $2
  GROUP BY 1, 2
)
SELECT p.bucket, s.status,
       (sum(p.energy_sum) / sum(p.measurements))::real AS avg_energy,
       count(*)::int AS nodes,
       sum(p.measurements)::int AS measurements
FROM per_node p
JOIN node_status s ON s.node_id = p.node_id
WHERE s.org_id = current_org_id()
  AND s.status IN ('healthy', 'suspected', 'alert')
GROUP BY 1, 2
ORDER BY 1, 2;
