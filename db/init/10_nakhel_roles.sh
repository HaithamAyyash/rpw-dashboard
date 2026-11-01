#!/bin/bash
# Runs once, as superuser, when a database volume is first initialised.
# Roles live here rather than in migrations because BYPASSRLS needs a superuser,
# and migrations deliberately run as the unprivileged nakhel_owner.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_pw="$NAKHEL_OWNER_PASSWORD" \
  -v web_pw="$NAKHEL_WEB_PASSWORD" \
  -v worker_pw="$NAKHEL_WORKER_PASSWORD" <<'SQL'
CREATE ROLE nakhel_owner  LOGIN PASSWORD :'owner_pw'  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE nakhel_web    LOGIN PASSWORD :'web_pw'    NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE nakhel_worker LOGIN PASSWORD :'worker_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;

ALTER DATABASE nakhel OWNER TO nakhel_owner;
ALTER SCHEMA public OWNER TO nakhel_owner;

-- Application roles connect and use public; everything else is granted table by table.
REVOKE ALL ON DATABASE nakhel FROM PUBLIC;
GRANT CONNECT ON DATABASE nakhel TO nakhel_owner, nakhel_web, nakhel_worker;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO nakhel_web, nakhel_worker;

SQL
