-- The organization's own settings. GET /orgs/{org_id}
-- @returns org_id, name, slug, timezone, suspect_threshold, alert_threshold
SELECT o.org_id, o.name, o.slug, o.timezone, o.suspect_threshold, o.alert_threshold
FROM organizations o
WHERE o.org_id = current_org_id();
