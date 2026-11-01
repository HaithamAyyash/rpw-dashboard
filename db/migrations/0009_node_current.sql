-- migrate:up

-- Latest known state per node, so status needs one row per node rather than a look into every
-- chunk per node: 8,000 of those took 200-700 ms per dashboard query (docs/database.md).
-- Triggers keep it correct inside the same transaction as the write; nothing else writes it.
CREATE TABLE node_current (
  org_id             uuid NOT NULL,
  node_id            bigint NOT NULL,
  avg_confidence     numeric(4,3),
  last_runs          real[],                  -- newest first, at most 3
  classified_runs    integer NOT NULL DEFAULT 0,
  last_classified    timestamptz,
  last_label         text,
  last_model_version text,
  last_heartbeat     timestamptz,
  battery_mv         integer,
  rssi_dbm           integer,
  uptime_s           bigint,
  PRIMARY KEY (org_id, node_id),
  UNIQUE (node_id),
  FOREIGN KEY (org_id, node_id) REFERENCES nodes (org_id, node_id)
);
ALTER TABLE node_current ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON node_current USING (org_id = current_org_id());
GRANT SELECT ON node_current TO nakhel_web, nakhel_worker;

CREATE FUNCTION node_current_refresh_classification(p_node_id bigint) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Lock first: the recompute below then runs in a new snapshot, so two concurrent writers
  -- for one node can't overwrite each other with a stale average.
  PERFORM 1 FROM node_current WHERE node_id = p_node_id FOR UPDATE;
  UPDATE node_current nc
  SET avg_confidence = r.avg_confidence, last_runs = r.last_runs,
      classified_runs = r.classified_runs, last_classified = r.last_classified,
      last_label = r.last_label, last_model_version = r.last_model_version
  FROM (
    SELECT avg(l.confidence)::numeric(4,3) AS avg_confidence,
           array_agg(l.confidence ORDER BY l."timestamp" DESC, l.processed_at DESC) AS last_runs,
           count(*)::int AS classified_runs,
           max(l."timestamp") AS last_classified,
           (array_agg(l.label ORDER BY l."timestamp" DESC, l.processed_at DESC))[1] AS last_label,
           (array_agg(l.model_version ORDER BY l."timestamp" DESC, l.processed_at DESC))[1] AS last_model_version
    FROM (
      SELECT c.confidence, c."timestamp", c.processed_at, c.label, c.model_version
      FROM classification_results c
      WHERE c.node_id = p_node_id
      ORDER BY c."timestamp" DESC, c.processed_at DESC LIMIT 3
    ) l
  ) r
  WHERE nc.node_id = p_node_id;
END $$;

CREATE FUNCTION node_current_refresh_health(p_node_id bigint) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  latest node_health;
BEGIN
  PERFORM 1 FROM node_current WHERE node_id = p_node_id FOR UPDATE;
  SELECT * INTO latest FROM node_health h WHERE h.node_id = p_node_id
    ORDER BY h."timestamp" DESC LIMIT 1;
  UPDATE node_current
  SET last_heartbeat = latest."timestamp", battery_mv = latest.battery_mv,
      rssi_dbm = latest.rssi_dbm, uptime_s = latest.uptime_s
  WHERE node_id = p_node_id;
END $$;

CREATE FUNCTION node_current_on_classification() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM node_current_refresh_classification(COALESCE(NEW.node_id, OLD.node_id));
  RETURN NULL;
END $$;

CREATE FUNCTION node_current_on_health() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM node_current_refresh_health(COALESCE(NEW.node_id, OLD.node_id));
  RETURN NULL;
END $$;

CREATE FUNCTION node_current_on_node() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO node_current (org_id, node_id) VALUES (NEW.org_id, NEW.node_id);
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION node_current_refresh_classification(bigint), node_current_refresh_health(bigint),
              node_current_on_classification(), node_current_on_health(), node_current_on_node()
  FROM PUBLIC;

-- Backfill, so this migration also works on a database that already has data.
INSERT INTO node_current (org_id, node_id) SELECT org_id, node_id FROM nodes;
SELECT node_current_refresh_classification(node_id), node_current_refresh_health(node_id) FROM nodes;

CREATE TRIGGER node_current_create AFTER INSERT ON nodes
  FOR EACH ROW EXECUTE FUNCTION node_current_on_node();
CREATE TRIGGER node_current_classification AFTER INSERT OR DELETE ON classification_results
  FOR EACH ROW EXECUTE FUNCTION node_current_on_classification();
CREATE TRIGGER node_current_health AFTER INSERT OR DELETE ON node_health
  FOR EACH ROW EXECUTE FUNCTION node_current_on_health();

-- Same columns as before, so callers don't change; two more are added at the end.
CREATE OR REPLACE VIEW node_status WITH (security_invoker = true) AS
SELECT n.org_id, n.node_id,
       c.avg_confidence, c.last_runs, c.classified_runs, c.last_classified,
       c.last_heartbeat, c.battery_mv, c.rssi_dbm, c.uptime_s,
       CASE
         WHEN c.last_heartbeat IS NOT NULL AND c.last_heartbeat < now() - INTERVAL '56 hours' THEN 'offline'
         WHEN c.classified_runs = 0 THEN 'unknown'
         WHEN c.avg_confidence >= o.alert_threshold THEN 'alert'
         WHEN c.avg_confidence >= o.suspect_threshold THEN 'suspected'
         ELSE 'healthy'
       END AS status,
       c.last_label, c.last_model_version
FROM nodes n
JOIN organizations o ON o.org_id = n.org_id
JOIN node_current c ON c.org_id = n.org_id AND c.node_id = n.node_id
WHERE n.active;

-- Lets the energy overview read a week of energy values from the index alone, without loading
-- each row's 1.6 KB MFCC matrix.
DROP INDEX acoustic_features_org_time_idx;
CREATE INDEX acoustic_features_org_time_idx ON acoustic_features (org_id, "timestamp" DESC)
  INCLUDE (node_id, energy);

-- migrate:down
DROP INDEX acoustic_features_org_time_idx;
CREATE INDEX acoustic_features_org_time_idx ON acoustic_features (org_id, "timestamp" DESC);

DROP VIEW node_status;
CREATE VIEW node_status WITH (security_invoker = true) AS
SELECT n.org_id, n.node_id,
       r.avg_confidence, r.last_runs, r.classified_runs, r.last_classified,
       h."timestamp" AS last_heartbeat, h.battery_mv, h.rssi_dbm, h.uptime_s,
       CASE
         WHEN h."timestamp" IS NOT NULL AND h."timestamp" < now() - INTERVAL '56 hours' THEN 'offline'
         WHEN r.classified_runs = 0 THEN 'unknown'
         WHEN r.avg_confidence >= o.alert_threshold THEN 'alert'
         WHEN r.avg_confidence >= o.suspect_threshold THEN 'suspected'
         ELSE 'healthy'
       END AS status
FROM nodes n
JOIN organizations o ON o.org_id = n.org_id
CROSS JOIN LATERAL (
  SELECT avg(l.confidence)::numeric(4,3) AS avg_confidence,
         array_agg(l.confidence ORDER BY l."timestamp" DESC) AS last_runs,
         count(*)::int AS classified_runs,
         max(l."timestamp") AS last_classified
  FROM (
    SELECT c.confidence, c."timestamp" FROM classification_results c
    WHERE c.org_id = n.org_id AND c.node_id = n.node_id
    ORDER BY c."timestamp" DESC LIMIT 3
  ) l
) r
LEFT JOIN LATERAL (
  SELECT nh."timestamp", nh.battery_mv, nh.rssi_dbm, nh.uptime_s FROM node_health nh
  WHERE nh.org_id = n.org_id AND nh.node_id = n.node_id
  ORDER BY nh."timestamp" DESC LIMIT 1
) h ON true
WHERE n.active;
GRANT SELECT ON node_status TO nakhel_web, nakhel_worker;

DROP TRIGGER node_current_health ON node_health;
DROP TRIGGER node_current_classification ON classification_results;
DROP TRIGGER node_current_create ON nodes;
DROP FUNCTION node_current_on_node();
DROP FUNCTION node_current_on_health();
DROP FUNCTION node_current_on_classification();
DROP FUNCTION node_current_refresh_health(bigint);
DROP FUNCTION node_current_refresh_classification(bigint);
DROP TABLE node_current;
