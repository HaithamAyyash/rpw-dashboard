-- migrate:up

-- Least privilege. Column lists are deliberate: org_id can never be changed after insert,
-- and hashes aren't readable. Anything not granted here is denied.

-- nakhel_web: the Next.js app, subject to row-level security. No DELETE except where stated;
-- devices are retired with flags so their history survives.
GRANT SELECT ON organizations TO nakhel_web;
GRANT UPDATE (name, timezone, suspect_threshold, alert_threshold) ON organizations TO nakhel_web;

GRANT SELECT (user_id, email, name, token_version, created_at, last_login) ON users TO nakhel_web;
GRANT INSERT (user_id, email, name, password_hash) ON users TO nakhel_web;
GRANT UPDATE (name, password_hash, token_version, last_login) ON users TO nakhel_web;

GRANT SELECT, DELETE ON organization_members TO nakhel_web;
GRANT INSERT (org_id, user_id, role) ON organization_members TO nakhel_web;
GRANT UPDATE (role) ON organization_members TO nakhel_web;

GRANT SELECT (invite_id, org_id, email, role, invited_by, created_at, expires_at, accepted_at)
  ON organization_invites TO nakhel_web;
GRANT INSERT (org_id, email, role, token_hash, invited_by, expires_at) ON organization_invites TO nakhel_web;
GRANT UPDATE (accepted_at) ON organization_invites TO nakhel_web;
GRANT DELETE ON organization_invites TO nakhel_web;

GRANT SELECT (cluster_id, org_id, name, farm_zone, install_date, location_lat, location_lon,
              uplink_type, api_key_created_at, revoked) ON cluster_heads TO nakhel_web;
GRANT INSERT (org_id, name, farm_zone, install_date, location_lat, location_lon, uplink_type, api_key_hash)
  ON cluster_heads TO nakhel_web;
GRANT UPDATE (name, farm_zone, install_date, location_lat, location_lon, uplink_type,
              api_key_hash, api_key_created_at, revoked) ON cluster_heads TO nakhel_web;

GRANT SELECT ON nodes TO nakhel_web;
GRANT INSERT (org_id, cluster_id, lora_id, tree_label, farm_zone, install_date, location_lat, location_lon, active)
  ON nodes TO nakhel_web;
GRANT UPDATE (cluster_id, lora_id, tree_label, farm_zone, install_date, location_lat, location_lon, active, updated_at)
  ON nodes TO nakhel_web;

-- status and ingested_at are left out: new rows always start pending, stamped by the server.
GRANT SELECT ON acoustic_features TO nakhel_web;
GRANT INSERT ("timestamp", org_id, node_id, cluster_id, mfcc, snr_db, rssi_dbm, msg_id, received_at, schema_version)
  ON acoustic_features TO nakhel_web;
GRANT SELECT, INSERT ON node_health, cluster_health, ingest_rejects TO nakhel_web;
GRANT SELECT ON classification_results TO nakhel_web;
GRANT SELECT ON alert_log TO nakhel_web;
GRANT UPDATE (acknowledged, acknowledged_by, acknowledged_at) ON alert_log TO nakhel_web;
GRANT SELECT ON node_status TO nakhel_web;

-- nakhel_worker: the Python worker, BYPASSRLS, reads every org. Never reads password hashes.
GRANT SELECT ON organizations, organization_members, nodes, node_health, cluster_health,
                classification_results, acoustic_features, alert_log, node_status TO nakhel_worker;
GRANT SELECT (user_id, email, name) ON users TO nakhel_worker;
GRANT SELECT (cluster_id, org_id, name, farm_zone, location_lat, location_lon, uplink_type, revoked)
  ON cluster_heads TO nakhel_worker;
GRANT UPDATE (status) ON acoustic_features TO nakhel_worker;
GRANT INSERT ON classification_results, alert_log TO nakhel_worker;
GRANT UPDATE (email_sent_at) ON alert_log TO nakhel_worker;

-- migrate:down
REVOKE ALL ON organizations, users, organization_members, organization_invites, cluster_heads,
              nodes, acoustic_features, node_health, cluster_health, classification_results,
              ingest_rejects, alert_log, node_status
  FROM nakhel_web, nakhel_worker;
