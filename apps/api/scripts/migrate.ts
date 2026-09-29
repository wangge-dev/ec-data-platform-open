import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { validateRuntimeEnvironment } from "../src/lib/runtime-secrets.js";
import {
  loadMigrationManifest,
  validateLegacySchema,
  type SnapshotTable,
} from "./migration-schema.js";

const APP_ROLE = "ec_app";
const USER_SCHEMA = "user_data";
const MIGRATION_LOCK_ID = 731_202_607;
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

type SqlClient = ReturnType<typeof postgres>;

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

async function createUserSchema(client: SqlClient, owner: string): Promise<void> {
  const schema = quoteIdentifier(USER_SCHEMA);
  const ownerIdentifier = quoteIdentifier(owner);
  await client.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION ${ownerIdentifier}`);
  await client.unsafe(`ALTER SCHEMA ${schema} OWNER TO ${ownerIdentifier}`);
  await client.unsafe(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
}

async function ownedSequences(client: SqlClient, schema: string, table: string): Promise<string[]> {
  const rows = (await client.unsafe(
    `SELECT seq.relname AS sequence_name
       FROM pg_class tbl
       JOIN pg_namespace table_ns ON table_ns.oid = tbl.relnamespace
       JOIN pg_depend dep ON dep.refobjid = tbl.oid AND dep.deptype IN ('a', 'i')
       JOIN pg_class seq ON seq.oid = dep.objid AND seq.relkind = 'S'
       JOIN pg_namespace seq_ns ON seq_ns.oid = seq.relnamespace
      WHERE table_ns.nspname = $1 AND tbl.relname = $2 AND seq_ns.nspname = $1`,
    [schema, table],
  )) as Array<{ sequence_name: string }>;
  return rows.map((row) => row.sequence_name);
}

async function adoptLegacyObjects(
  client: SqlClient,
  fixedTables: SnapshotTable[],
  owner: string,
  additionalLegacyOwners: string[] = [],
): Promise<void> {
  const fixedNames = fixedTables.map((table) => table.name);
  const legacyOwners = [...new Set([APP_ROLE, ...additionalLegacyOwners])];
  const existingUserSchemaOwners = [...new Set([APP_ROLE, owner, ...additionalLegacyOwners])];
  const dynamicTables = (await client.unsafe(
    `SELECT c.relname AS table_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND pg_get_userbyid(c.relowner) = ANY($1::text[])
        AND NOT (c.relname = ANY($2::text[]))
      ORDER BY c.relname`,
    [legacyOwners, fixedNames],
  )) as Array<{ table_name: string }>;

  for (const { table_name: table } of dynamicTables) {
    const [collision] = (await client.unsafe(
      "SELECT to_regclass($1) IS NOT NULL AS exists",
      [`${USER_SCHEMA}.${table}`],
    )) as Array<{ exists: boolean }>;
    if (collision.exists) {
      throw new Error(
        `cannot move legacy dynamic table public.${table}: ${USER_SCHEMA}.${table} already exists`,
      );
    }
    const sequences = await ownedSequences(client, "public", table);
    await client.unsafe(
      `ALTER TABLE ${quoteIdentifier("public")}.${quoteIdentifier(table)} SET SCHEMA ${quoteIdentifier(USER_SCHEMA)}`,
    );
    await client.unsafe(
      `ALTER TABLE ${quoteIdentifier(USER_SCHEMA)}.${quoteIdentifier(table)} OWNER TO ${quoteIdentifier(APP_ROLE)}`,
    );
    for (const sequence of sequences) {
      await client.unsafe(
        `ALTER SEQUENCE ${quoteIdentifier(USER_SCHEMA)}.${quoteIdentifier(sequence)} OWNER TO ${quoteIdentifier(APP_ROLE)}`,
      );
    }
    console.log(`[migrate] moved legacy dynamic table public.${table} to ${USER_SCHEMA}.${table}`);
  }

  // Earlier releases could move dynamic tables without transferring ownership to the app role.
  const existingDynamicTables = (await client.unsafe(
    `SELECT c.relname AS table_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
        AND pg_get_userbyid(c.relowner) = ANY($2::text[])
        AND pg_get_userbyid(c.relowner) <> $3
      ORDER BY c.relname`,
    [USER_SCHEMA, existingUserSchemaOwners, APP_ROLE],
  )) as Array<{ table_name: string }>;

  for (const { table_name: table } of existingDynamicTables) {
    const sequences = await ownedSequences(client, USER_SCHEMA, table);
    await client.unsafe(
      `ALTER TABLE ${quoteIdentifier(USER_SCHEMA)}.${quoteIdentifier(table)} OWNER TO ${quoteIdentifier(APP_ROLE)}`,
    );
    for (const sequence of sequences) {
      await client.unsafe(
        `ALTER SEQUENCE ${quoteIdentifier(USER_SCHEMA)}.${quoteIdentifier(sequence)} OWNER TO ${quoteIdentifier(APP_ROLE)}`,
      );
    }
    console.log(`[migrate] adopted existing dynamic table ${USER_SCHEMA}.${table}`);
  }

  for (const table of fixedTables) {
    const [exists] = (await client.unsafe(
      "SELECT to_regclass($1) IS NOT NULL AS exists",
      [`public.${table.name}`],
    )) as Array<{ exists: boolean }>;
    if (!exists.exists) continue;
    const sequences = await ownedSequences(client, "public", table.name);
    await client.unsafe(
      `ALTER TABLE ${quoteIdentifier("public")}.${quoteIdentifier(table.name)} OWNER TO ${quoteIdentifier(owner)}`,
    );
    for (const sequence of sequences) {
      await client.unsafe(
        `ALTER SEQUENCE ${quoteIdentifier("public")}.${quoteIdentifier(sequence)} OWNER TO ${quoteIdentifier(owner)}`,
      );
    }
  }
}

async function applyApplicationGrants(
  client: SqlClient,
  databaseName: string,
  owner: string,
): Promise<void> {
  const database = quoteIdentifier(databaseName);
  const ownerIdentifier = quoteIdentifier(owner);
  await client.begin(async (tx) => {
    await tx.unsafe(`GRANT CONNECT ON DATABASE ${database} TO ${quoteIdentifier(APP_ROLE)}`);
    await tx.unsafe("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await tx.unsafe(`REVOKE CREATE ON SCHEMA public FROM ${quoteIdentifier(APP_ROLE)}`);
    await tx.unsafe(`GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(APP_ROLE)}`);
    await tx.unsafe(`REVOKE ALL ON SCHEMA ${quoteIdentifier(USER_SCHEMA)} FROM PUBLIC`);
    await tx.unsafe(
      `GRANT USAGE, CREATE ON SCHEMA ${quoteIdentifier(USER_SCHEMA)} TO ${quoteIdentifier(APP_ROLE)}`,
    );
    await tx.unsafe(
      "GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO ec_app",
    );
    await tx.unsafe("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ec_app");
    await tx.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA ${quoteIdentifier(USER_SCHEMA)} TO ec_app`,
    );
    await tx.unsafe(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${quoteIdentifier(USER_SCHEMA)} TO ec_app`,
    );
    await tx.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerIdentifier} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO ec_app`,
    );
    await tx.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerIdentifier} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ec_app`,
    );
    await tx.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerIdentifier} IN SCHEMA ${quoteIdentifier(USER_SCHEMA)} GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO ec_app`,
    );
    await tx.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerIdentifier} IN SCHEMA ${quoteIdentifier(USER_SCHEMA)} GRANT USAGE, SELECT ON SEQUENCES TO ec_app`,
    );
    await tx.unsafe(
      `ALTER ROLE ${quoteIdentifier(APP_ROLE)} IN DATABASE ${database} SET search_path TO public, ${quoteIdentifier(USER_SCHEMA)}`,
    );
  });
}

async function establishLegacyBaseline(
  client: SqlClient,
  baseline: { hash: string; createdAt: number },
): Promise<void> {
  await client.begin(async (tx) => {
    await tx.unsafe("CREATE SCHEMA IF NOT EXISTS drizzle");
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);
    const [existing] = (await tx.unsafe(
      "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
    )) as Array<{ count: number }>;
    if (existing.count !== 0) {
      throw new Error("legacy baseline journal was created concurrently; retry migration");
    }
    await tx.unsafe(
      "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
      [baseline.hash, baseline.createdAt],
    );
  });
}

async function main() {
  validateRuntimeEnvironment(process.env);
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  if (!migrationUrl) throw new Error("MIGRATION_DATABASE_URL is required");

  const manifest = loadMigrationManifest(migrationsFolder);
  const client = postgres(migrationUrl, { max: 1, connect_timeout: 10 });
  let lockAcquired = false;
  try {
    const [identity] = await client<{
      database_name: string;
      database_owner: string;
      current_user: string;
      is_superuser: boolean;
    }[]>`
      SELECT current_database() AS database_name,
             pg_get_userbyid(d.datdba) AS database_owner,
             current_user, r.rolsuper AS is_superuser
        FROM pg_database d
        JOIN pg_roles r ON r.rolname = current_user
       WHERE d.datname = current_database()
    `;
    if (!identity || (!identity.is_superuser && identity.database_owner !== identity.current_user)) {
      throw new Error("migration connection must use the database owner or a PostgreSQL superuser");
    }

    const [appRole] = await client<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = ${APP_ROLE}) AS exists
    `;
    if (!appRole?.exists) throw new Error(`required application role ${APP_ROLE} does not exist`);

    await client`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID})`;
    lockAcquired = true;

    const [legacy] = await client<{ journal_exists: boolean; fixed_table_count: number }[]>`
      SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS journal_exists,
             (
               SELECT count(*)::int FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
                 AND c.relname = ANY(${manifest.fixedTables.map((table) => table.name)}::text[])
             ) AS fixed_table_count
    `;

    if (!legacy.journal_exists && legacy.fixed_table_count > 0) {
      console.log("[migrate] validating legacy schema against the first tracked snapshot");
      await validateLegacySchema(client, manifest.baselineSnapshot);
      await createUserSchema(client, identity.database_owner);
      await adoptLegacyObjects(
        client,
        manifest.fixedTables,
        identity.database_owner,
        [identity.database_owner, identity.current_user],
      );
      await establishLegacyBaseline(client, manifest.baseline);
      console.log("[migrate] exact legacy schema validated; first migration journal entry established");
    } else {
      await createUserSchema(client, identity.database_owner);
      await adoptLegacyObjects(
        client,
        manifest.fixedTables,
        identity.database_owner,
        !legacy.journal_exists ? [identity.database_owner, identity.current_user] : [],
      );
    }

    console.log(`[migrate] applying tracked migrations from ${migrationsFolder}`);
    await migrate(drizzle(client), {
      migrationsFolder,
      migrationsSchema: "drizzle",
      migrationsTable: "__drizzle_migrations",
    });

    await adoptLegacyObjects(client, manifest.fixedTables, identity.database_owner);
    await applyApplicationGrants(client, identity.database_name, identity.database_owner);
    console.log("[migrate] migrations, ownership, and two-schema grants completed");
  } finally {
    try {
      if (lockAcquired) await client`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`;
    } finally {
      await client.end();
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[migrate] failed: ${message}`);
  process.exitCode = 1;
});
