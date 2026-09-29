#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "[codespaces] waiting for PostgreSQL"
for attempt in {1..60}; do
  if pg_isready -h postgres -p 5432 -U ec -d ec_data >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == "60" ]]; then
    echo "[codespaces] PostgreSQL did not become ready" >&2
    exit 1
  fi
  sleep 1
done

cd "$repo_root/apps/api"

echo "[codespaces] applying tracked migrations"
pnpm exec tsx scripts/migrate.ts

echo "[codespaces] seeding the empty development database"
pnpm exec tsx scripts/seed.ts

echo "[codespaces] database is ready"
