#!/usr/bin/env bash
# NAKHEL database commands. Needs only bash and Docker. Run ./db.sh with no arguments for help.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { cp .env.example .env; echo "created .env from .env.example"; }

test_compose() { NAKHEL_DB_HOST=db-test DBMATE_HOST=db-test docker compose --profile tools --profile test "$@"; }
tools() { docker compose --profile tools run --rm tools "$@"; }

case "${1:-help}" in
  up)    docker compose up -d --wait db ;;
  down)  docker compose down ;;
  # Deletes this project's own volume only (nakhel_nakhel_db), then rebuilds from zero.
  reset)
    docker compose down -v
    docker compose up -d --wait db
    docker compose --profile tools run --rm dbmate up ;;
  migrate)
    docker compose up -d --wait db
    docker compose --profile tools run --rm dbmate up ;;
  rollback) docker compose --profile tools run --rm dbmate rollback ;;
  seed)
    docker compose --profile tools build tools
    shift; tools python tools/seed.py "$@" ;;
  psql)
    docker compose exec -e PGPASSWORD="$(grep ^NAKHEL_OWNER_PASSWORD .env | cut -d= -f2)" db \
      psql -h 127.0.0.1 -U nakhel_owner -d nakhel ;;
  backup) ./tools/backup.sh ;;
  bench)
    shift; tools python tools/bench_queries.py "$@" ;;
  # From zero: empty database -> all migrations up -> all down -> all up -> tests.
  test)
    shift
    docker compose --profile tools build tools
    test_compose rm -sf db-test
    test_compose up -d --wait db-test
    trap 'test_compose rm -sf db-test' EXIT
    test_compose run --rm --no-deps dbmate up
    for _ in db/migrations/*.sql; do test_compose run --rm --no-deps dbmate rollback; done
    test_compose run --rm --no-deps dbmate up
    test_compose run --rm --no-deps tools pytest db/tests tools/tests -q "$@" ;;
  # Web checks: type-check, lint and tests against a throwaway database.
  test-web)
    shift
    docker compose --profile tools run --rm --no-deps node npm ci --no-audit --no-fund
    test_compose rm -sf db-test
    test_compose up -d --wait db-test
    trap 'test_compose rm -sf db-test' EXIT
    test_compose run --rm --no-deps dbmate up
    test_compose run --rm --no-deps node npm run typecheck
    test_compose run --rm --no-deps node npm run lint
    test_compose run --rm --no-deps node npx vitest run "$@" ;;
  # Run any web script, e.g. ./db.sh web npm run create-org -- --name X --slug x ...
  # Worker tests on a throwaway database, with a real mail server.
  test-worker)
    shift
    docker compose --profile tools build worker-test
    test_compose rm -sf db-test
    test_compose up -d --wait db-test mailpit
    trap 'test_compose rm -sf db-test' EXIT
    test_compose run --rm --no-deps dbmate up
    test_compose run --rm --no-deps worker-test pytest tests -q "$@"
    test_compose run --rm --no-deps worker-test pylint nakhel_worker tests ;;
  # Fake cluster heads calling the live API. ./db.sh simulate --help
  simulate)
    shift
    docker compose --profile tools build tools
    tools python tools/simulate_cluster.py "$@" ;;
  # Simulator -> API -> worker -> database -> dashboard API -> email, on the running stack.
  integration)
    shift
    docker compose --profile tools build tools
    docker compose up -d --wait db mailpit
    docker compose up -d --wait --build web worker
    tools pytest tools/tests_integration -q "$@" ;;
  # Browser tests against the running app. Needs: ./db.sh seed and docker compose up -d web
  e2e)
    shift; docker compose --profile tools run --rm e2e npx playwright test "$@" ;;
  web)
    shift; docker compose --profile tools run --rm node "$@" ;;
  lint)
    docker compose --profile tools build tools
    tools pylint tools/seed.py tools/bench_queries.py tools/pi_client_example.py tools/simulate_cluster.py tools/nakhel_fake tools/tests tools/tests_integration db/tests ;;
  *)
    cat <<'HELP'
./db.sh reset          Rebuild the dev database from zero and apply all migrations
./db.sh seed           Load fake data: 2 organizations, 30 days
./db.sh seed --scale   Load the large dataset: 8,000 nodes x 90 days
./db.sh test           Run the database tests on a throwaway database
./db.sh psql           SQL shell as the owner role
./db.sh backup         pg_dump into backups/
./db.sh bench          Time every dashboard query on the large seed
./db.sh test-web       Type-check, lint and test the web app on a throwaway database
./db.sh test-worker    Test the worker on a throwaway database and real mail server
./db.sh integration    Whole pipeline test on the running stack
./db.sh simulate       Fake cluster heads calling the live API
./db.sh e2e            Browser tests against the running app and demo data
./db.sh web <command>  Run a command in the web app's Node container
./db.sh up | down | migrate | rollback | lint
HELP
    ;;
esac
