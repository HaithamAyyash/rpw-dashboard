-- migrate:up

-- A hypertable's rows live in chunk tables in _timescaledb_internal. TimescaleDB copies the
-- hypertable's GRANTs onto each chunk but NOT its row-level security, so the web role could read
-- every organization's rows by naming a chunk directly. Access through the hypertable checks
-- privileges on the hypertable only, so chunks don't need any grants of their own.
-- Closing the schema instead isn't possible: TimescaleDB's planner needs it for every table scan.
-- Chunk creation can't be hooked, so a job closes each new chunk within a minute of its creation.
CREATE PROCEDURE lock_down_chunks(job_id integer, config jsonb)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  chunk regclass;
BEGIN
  FOR chunk IN
    SELECT format('%I.%I', c.chunk_schema, c.chunk_name)::regclass
    FROM timescaledb_information.chunks c
    WHERE has_any_column_privilege('nakhel_web',
            format('%I.%I', c.chunk_schema, c.chunk_name), 'SELECT,INSERT,UPDATE')
       OR has_any_column_privilege('nakhel_worker',
            format('%I.%I', c.chunk_schema, c.chunk_name), 'SELECT,INSERT,UPDATE')
  LOOP
    EXECUTE format('REVOKE ALL ON %s FROM nakhel_web, nakhel_worker', chunk);
  END LOOP;
END $$;

SELECT add_job('lock_down_chunks', INTERVAL '1 minute', fixed_schedule => false);

-- migrate:down
SELECT delete_job(job_id) FROM timescaledb_information.jobs WHERE proc_name = 'lock_down_chunks';
DROP PROCEDURE lock_down_chunks(integer, jsonb);
