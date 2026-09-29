#!/bin/sh
set -e

cd /app/apps/api

echo "[api] waiting for postgres..."
POSTGRES_READY=0
for i in $(seq 1 30); do
  if node --input-type=module -e '
    import postgres from "postgres";
    const sql = postgres(process.env.DATABASE_URL, { connect_timeout: 5, max: 1 });
    try {
      await sql`SELECT 1`;
    } finally {
      await sql.end();
    }
  ' 2>/dev/null; then
    POSTGRES_READY=1
    echo "[api] postgres is ready"
    break
  fi
  echo "[api] postgres not ready, retry ${i}/30"
  sleep 2
done

if [ "$POSTGRES_READY" != "1" ]; then
  echo "[api] postgres did not become ready" >&2
  exit 1
fi

echo "[api] seeding admin user (idempotent)"
./node_modules/.bin/tsx scripts/seed.ts

echo "[api] starting server on :4000"
exec ./node_modules/.bin/tsx src/index.ts
