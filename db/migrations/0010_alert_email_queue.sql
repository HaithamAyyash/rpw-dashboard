-- migrate:up

-- The worker's email queue. Only unsent alerts are in it, so it stays tiny.
-- Across all organizations, so unlike dashboard indexes it doesn't start with org_id.
CREATE INDEX alert_log_unsent_idx ON alert_log (created_at) WHERE email_sent_at IS NULL;

-- migrate:down
DROP INDEX alert_log_unsent_idx;
