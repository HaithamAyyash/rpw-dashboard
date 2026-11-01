-- migrate:up

CREATE TABLE cluster_heads (
  cluster_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations (org_id),
  name               text NOT NULL CHECK (length(trim(name)) > 0),
  farm_zone          text,
  install_date       date,
  location_lat       double precision CHECK (location_lat BETWEEN -90 AND 90),
  location_lon       double precision CHECK (location_lon BETWEEN -180 AND 180),
  uplink_type        text CHECK (uplink_type IN ('wifi', '4g')),
  api_key_hash       text NOT NULL UNIQUE CHECK (api_key_hash ~ '^[0-9a-f]{64}$'),
  api_key_created_at timestamptz NOT NULL DEFAULT now(),
  revoked            boolean NOT NULL DEFAULT false,
  UNIQUE (org_id, name),
  -- Target of the composite tenant foreign keys.
  UNIQUE (org_id, cluster_id)
);

CREATE TABLE nodes (
  node_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations (org_id),
  cluster_id   uuid NOT NULL,
  lora_id      integer NOT NULL CHECK (lora_id BETWEEN 0 AND 65535),
  tree_label   text NOT NULL CHECK (length(trim(tree_label)) > 0),
  farm_zone    text,
  install_date date,
  location_lat double precision CHECK (location_lat BETWEEN -90 AND 90),
  location_lon double precision CHECK (location_lon BETWEEN -180 AND 180),
  active       boolean NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, cluster_id) REFERENCES cluster_heads (org_id, cluster_id),
  UNIQUE (org_id, node_id)
);

-- Unique among active nodes, so a replaced node's radio ID can be reused while the old
-- row keeps its history. This is also the index ingest uses to resolve a LoRa ID.
CREATE UNIQUE INDEX nodes_active_lora_uidx ON nodes (cluster_id, lora_id) WHERE active;
CREATE INDEX nodes_org_zone_idx    ON nodes (org_id, farm_zone);
CREATE INDEX nodes_org_label_idx   ON nodes (org_id, tree_label, node_id);
CREATE INDEX nodes_org_cluster_idx ON nodes (org_id, cluster_id);

ALTER TABLE cluster_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE nodes         ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON cluster_heads USING (org_id = current_org_id());
CREATE POLICY org_isolation ON nodes         USING (org_id = current_org_id());

-- migrate:down
DROP TABLE nodes;
DROP TABLE cluster_heads;
