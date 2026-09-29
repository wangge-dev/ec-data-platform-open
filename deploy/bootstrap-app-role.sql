-- Manual recovery helper for the ec_app role after its password has been
-- provisioned. Normal deployments use `docker compose up -d`: init-app-role.sh
-- creates the role on an empty database and the one-shot migrate service owns
-- fixed public tables and grants their DML privileges.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ec_app') THEN
    RAISE EXCEPTION 'ec_app does not exist; provision it with APP_DB_PASSWORD before applying recovery grants';
  END IF;
END $$;

GRANT CONNECT ON DATABASE ec_data TO ec_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM ec_app;
GRANT USAGE ON SCHEMA public TO ec_app;

CREATE SCHEMA IF NOT EXISTS user_data AUTHORIZATION ec;
GRANT USAGE, CREATE ON SCHEMA user_data TO ec_app;
ALTER ROLE ec_app SET search_path TO public, user_data;

-- Fixed public table ownership, table/sequence grants, and default privileges
-- intentionally remain the migrator's responsibility.
