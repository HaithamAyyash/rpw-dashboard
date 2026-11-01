-- The zone selector in the top bar. GET /zones
-- @returns farm_zone, trees
SELECT n.farm_zone, count(*)::int AS trees
FROM nodes n
WHERE n.org_id = current_org_id() AND n.active AND n.farm_zone IS NOT NULL
GROUP BY n.farm_zone
ORDER BY n.farm_zone;
