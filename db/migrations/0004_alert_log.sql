-- migrate:up

-- A regular table, not a hypertable: it takes updates and is kept forever.
CREATE TABLE alert_log (
  alert_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations (org_id),
  "timestamp"     timestamptz NOT NULL,          -- when the condition happened
  created_at      timestamptz NOT NULL DEFAULT now(),  -- when the engine raised it
  measurement_ts  timestamptz,                   -- the measurement that triggered it, for latency
  node_id         bigint,
  cluster_id      uuid,
  alert_type      text NOT NULL CHECK (alert_type IN (
                    'infestation_detected', 'infestation_suspected', 'node_offline',
                    'low_battery', 'cluster_offline', 'sd_low')),
  severity        text NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  confidence      real CHECK (confidence BETWEEN 0 AND 1),
  message         text NOT NULL,
  acknowledged    boolean NOT NULL DEFAULT false,
  acknowledged_by uuid REFERENCES users (user_id),
  acknowledged_at timestamptz,
  email_sent_at   timestamptz,
  FOREIGN KEY (org_id, node_id)    REFERENCES nodes (org_id, node_id),
  FOREIGN KEY (org_id, cluster_id) REFERENCES cluster_heads (org_id, cluster_id),
  CONSTRAINT alert_target_matches_type CHECK (
    CASE WHEN alert_type IN ('cluster_offline', 'sd_low')
         THEN cluster_id IS NOT NULL
         ELSE node_id IS NOT NULL END
  ),
  CONSTRAINT alert_ack_consistent CHECK (
    (acknowledged AND acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL)
    OR (NOT acknowledged AND acknowledged_at IS NULL AND acknowledged_by IS NULL)
  )
);

CREATE INDEX alert_log_org_time_idx ON alert_log (org_id, "timestamp" DESC);
CREATE INDEX alert_log_org_unacked_idx ON alert_log (org_id, "timestamp" DESC) WHERE NOT acknowledged;
-- The engine's cooldown check: latest alert of this type for this node.
CREATE INDEX alert_log_cooldown_idx ON alert_log (org_id, node_id, alert_type, "timestamp" DESC);

ALTER TABLE alert_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON alert_log USING (org_id = current_org_id());

-- migrate:down
DROP TABLE alert_log;
