-- migrate:up

-- True when m is a 30 x 13 matrix of finite numbers.
-- array_length alone would let NULL, NaN and Infinity elements through. (In Postgres,
-- NaN = NaN is true, so <> also catches NaN.)
CREATE FUNCTION mfcc_is_valid(m real[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT array_ndims(m) = 2
       AND array_length(m, 1) = 30
       AND array_length(m, 2) = 13
       AND NOT EXISTS (
         SELECT 1 FROM unnest(m) AS v
         WHERE v IS NULL OR v = 'NaN'::real OR v = 'Infinity'::real OR v = '-Infinity'::real
       )
  $$;

-- Decision D9: acoustic energy = mean of coefficient c0 over the 30 frames.
CREATE FUNCTION mfcc_energy(m real[]) RETURNS real
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT avg(m[f][1])::real FROM generate_series(1, 30) AS f
  $$;

-- One measurement from one node. The FK is to the internal node_id, never the LoRa ID.
CREATE TABLE acoustic_features (
  "timestamp"    timestamptz NOT NULL,
  org_id         uuid NOT NULL,
  node_id        bigint NOT NULL,
  cluster_id     uuid NOT NULL,
  mfcc           real[] NOT NULL CHECK (mfcc_is_valid(mfcc)),
  snr_db         real,
  rssi_dbm       integer CHECK (rssi_dbm BETWEEN -200 AND 20),
  msg_id         uuid,
  received_at    timestamptz,
  schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  energy         real GENERATED ALWAYS AS (mfcc_energy(mfcc)) STORED,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'classified', 'failed')),
  FOREIGN KEY (org_id, node_id)    REFERENCES nodes (org_id, node_id),
  FOREIGN KEY (org_id, cluster_id) REFERENCES cluster_heads (org_id, cluster_id),
  UNIQUE (node_id, "timestamp")
);

CREATE TABLE node_health (
  "timestamp" timestamptz NOT NULL,
  org_id      uuid NOT NULL,
  node_id     bigint NOT NULL,
  battery_mv  integer CHECK (battery_mv >= 0),
  rssi_dbm    integer CHECK (rssi_dbm BETWEEN -200 AND 20),
  uptime_s    bigint CHECK (uptime_s >= 0),
  FOREIGN KEY (org_id, node_id) REFERENCES nodes (org_id, node_id),
  UNIQUE (node_id, "timestamp")
);

CREATE TABLE cluster_health (
  "timestamp"    timestamptz NOT NULL,
  org_id         uuid NOT NULL,
  cluster_id     uuid NOT NULL,
  uptime_s       bigint CHECK (uptime_s >= 0),
  rssi_dbm       integer CHECK (rssi_dbm BETWEEN -200 AND 20),
  sd_free_mb     integer CHECK (sd_free_mb >= 0),
  uplink_type    text CHECK (uplink_type IN ('wifi', '4g')),
  buffered_count integer CHECK (buffered_count >= 0),
  FOREIGN KEY (org_id, cluster_id) REFERENCES cluster_heads (org_id, cluster_id),
  UNIQUE (cluster_id, "timestamp")
);

CREATE TABLE classification_results (
  "timestamp"   timestamptz NOT NULL,            -- of the measurement, not of the inference
  org_id        uuid NOT NULL,
  node_id       bigint NOT NULL,
  label         text NOT NULL CHECK (label IN ('healthy', 'infested')),
  confidence    real NOT NULL CHECK (confidence BETWEEN 0 AND 1),  -- P(infested), whatever the label
  model_version text NOT NULL,
  inference_ms  real CHECK (inference_ms >= 0),
  processed_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, node_id) REFERENCES nodes (org_id, node_id),
  -- model_version is part of the key so a new model can re-score old measurements.
  UNIQUE (node_id, "timestamp", model_version)
);

CREATE TABLE ingest_rejects (
  "time"       timestamptz NOT NULL DEFAULT now(),
  org_id       uuid NOT NULL,
  cluster_id   uuid NOT NULL,
  lora_id      integer,                          -- as sent, so not range-checked
  http_status  smallint NOT NULL CHECK (http_status BETWEEN 400 AND 499),
  error_code   text NOT NULL,
  request_body text CHECK (length(request_body) <= 65536),
  FOREIGN KEY (org_id, cluster_id) REFERENCES cluster_heads (org_id, cluster_id)
);

-- TimescaleDB refuses to toggle RLS once compression is on, so it goes on before anything
-- else happens to these tables.
ALTER TABLE acoustic_features      ENABLE ROW LEVEL SECURITY;
ALTER TABLE node_health            ENABLE ROW LEVEL SECURITY;
ALTER TABLE cluster_health         ENABLE ROW LEVEL SECURITY;
ALTER TABLE classification_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_rejects         ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON acoustic_features      USING (org_id = current_org_id());
CREATE POLICY org_isolation ON node_health            USING (org_id = current_org_id());
CREATE POLICY org_isolation ON cluster_health         USING (org_id = current_org_id());
CREATE POLICY org_isolation ON classification_results USING (org_id = current_org_id());
CREATE POLICY org_isolation ON ingest_rejects         USING (org_id = current_org_id());

-- create_default_indexes => false: a bare time index starts with neither org_id nor node_id,
-- so no dashboard query would use it. The indexes below replace it.
SELECT create_hypertable('acoustic_features',      'timestamp', chunk_time_interval => INTERVAL '7 days',  create_default_indexes => false);
SELECT create_hypertable('node_health',            'timestamp', chunk_time_interval => INTERVAL '7 days',  create_default_indexes => false);
SELECT create_hypertable('cluster_health',         'timestamp', chunk_time_interval => INTERVAL '7 days',  create_default_indexes => false);
SELECT create_hypertable('classification_results', 'timestamp', chunk_time_interval => INTERVAL '7 days',  create_default_indexes => false);
SELECT create_hypertable('ingest_rejects',         'time',      chunk_time_interval => INTERVAL '30 days', create_default_indexes => false);

CREATE INDEX acoustic_features_org_node_time_idx ON acoustic_features (org_id, node_id, "timestamp" DESC);
CREATE INDEX acoustic_features_org_time_idx      ON acoustic_features (org_id, "timestamp" DESC);
-- The worker's queue: only pending rows are in it, so it stays tiny however large the table gets.
CREATE INDEX acoustic_features_pending_idx       ON acoustic_features (ingested_at) WHERE status = 'pending';

CREATE INDEX node_health_org_node_time_idx       ON node_health (org_id, node_id, "timestamp" DESC);
CREATE INDEX cluster_health_org_cluster_time_idx ON cluster_health (org_id, cluster_id, "timestamp" DESC);

CREATE INDEX classification_org_node_time_idx    ON classification_results (org_id, node_id, "timestamp" DESC);
CREATE INDEX classification_org_time_idx         ON classification_results (org_id, "timestamp" DESC);

CREATE INDEX ingest_rejects_org_time_idx         ON ingest_rejects (org_id, "time" DESC);

SELECT add_retention_policy('acoustic_features',      INTERVAL '1 year');
SELECT add_retention_policy('classification_results', INTERVAL '1 year');
SELECT add_retention_policy('node_health',            INTERVAL '1 year');
SELECT add_retention_policy('cluster_health',         INTERVAL '1 year');
SELECT add_retention_policy('ingest_rejects',         INTERVAL '90 days');

-- migrate:down
DROP TABLE ingest_rejects;
DROP TABLE classification_results;
DROP TABLE cluster_health;
DROP TABLE node_health;
DROP TABLE acoustic_features;
DROP FUNCTION mfcc_energy(real[]);
DROP FUNCTION mfcc_is_valid(real[]);
