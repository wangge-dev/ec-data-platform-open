#!/bin/sh
set -eu

# Runs only when PostgreSQL initializes an empty data directory.
psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=app_password="$APP_DB_PASSWORD" <<-'EOSQL'
SELECT format(
  'CREATE ROLE ec_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE',
  :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ec_app') \gexec

ALTER ROLE ec_app PASSWORD :'app_password';
GRANT CONNECT ON DATABASE ec_data TO ec_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM ec_app;
GRANT USAGE ON SCHEMA public TO ec_app;
EOSQL
