#!/usr/bin/env bash
# Write a compressed logical backup to backups/. See docs/database.md for how to restore.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
out="backups/nakhel_$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T -e PGPASSWORD="$(grep ^POSTGRES_SUPERUSER_PASSWORD .env | cut -d= -f2)" db \
  pg_dump -h 127.0.0.1 -U postgres -d nakhel --format=custom > "$out"
echo "wrote $out ($(du -h "$out" | cut -f1))"
