import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

export type SnapshotColumn = {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  default?: string | number | boolean;
};

export type SnapshotTable = {
  name: string;
  schema: string;
  columns: Record<string, SnapshotColumn>;
  indexes: Record<string, any>;
  foreignKeys: Record<string, any>;
  compositePrimaryKeys: Record<string, any>;
  uniqueConstraints: Record<string, any>;
  checkConstraints: Record<string, any>;
  policies: Record<string, any>;
  isRLSEnabled: boolean;
};

export type Snapshot = {
  id: string;
  prevId: string;
  version: string;
  dialect: string;
  tables: Record<string, SnapshotTable>;
  enums: Record<string, unknown>;
  schemas: Record<string, unknown>;
  sequences: Record<string, unknown>;
  roles: Record<string, unknown>;
  policies: Record<string, unknown>;
  views: Record<string, unknown>;
  _meta: Record<string, unknown>;
};

export type CatalogColumn = {
  tableName: string;
  columnName: string;
  ordinal: number;
  dataType: string;
  notNull: boolean;
  defaultValue: string | null;
};

export type CatalogConstraint = {
  name: string;
  tableName: string;
  type: "p" | "u" | "f" | "c";
  columns: string[];
  foreignSchema: string | null;
  foreignTable: string | null;
  foreignColumns: string[];
  onUpdate: string;
  onDelete: string;
  nullsNotDistinct: boolean;
  definition: string;
};

export type CatalogIndexColumn = {
  position: number;
  isKey: boolean;
  columnName: string | null;
  expression: string;
  isExpression: boolean;
  ascending: boolean;
  nulls: string;
  opclass: string | null;
  opclassIsDefault: boolean;
  collationIsDefault: boolean;
};

export type CatalogIndex = {
  tableName: string;
  name: string;
  isUnique: boolean;
  method: string;
  predicate: string | null;
  storageParameters: Record<string, string>;
  columns: CatalogIndexColumn[];
};

export type CatalogSequence = {
  tableName: string;
  columnName: string;
  sequenceSchema: string;
  sequenceName: string;
  dataType: string;
  startValue: string;
  minValue: string;
  maxValue: string;
  incrementBy: string;
  cycle: boolean;
  cacheSize: string;
  dependencyType: string;
  defaultLinked: boolean;
};

export type LegacyCatalog = {
  tables: string[];
  columns: CatalogColumn[];
  constraints: CatalogConstraint[];
  indexes: CatalogIndex[];
  sequences: CatalogSequence[];
  unsupportedFeatures: string[];
};

export type MigrationManifest = {
  baseline: {
    hash: string;
    createdAt: number;
  };
  baselineSnapshot: Snapshot;
  snapshot: Snapshot;
  fixedTables: SnapshotTable[];
};

type SqlClient = ReturnType<typeof postgres>;

const ROOT_KEYS = ["id", "prevId", "version", "dialect", "tables", "enums", "schemas", "sequences", "roles", "policies", "views", "_meta"];
const TABLE_KEYS = ["name", "schema", "columns", "indexes", "foreignKeys", "compositePrimaryKeys", "uniqueConstraints", "policies", "checkConstraints", "isRLSEnabled"];
const COLUMN_KEYS = ["name", "type", "primaryKey", "notNull", "default"];
const INDEX_KEYS = ["name", "columns", "isUnique", "with", "method", "where", "concurrently"];
const INDEX_COLUMN_KEYS = ["expression", "isExpression", "asc", "nulls", "opclass"];
const FOREIGN_KEY_KEYS = ["name", "tableFrom", "columnsFrom", "tableTo", "schemaTo", "columnsTo", "onUpdate", "onDelete"];
const META_KEYS = ["columns", "schemas", "tables"];

function assertAllowedKeys(value: object, allowed: string[], context: string) {
  const unsupported = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unsupported.length) {
    throw new Error(`unsupported snapshot field at ${context}: ${unsupported.join(", ")}`);
  }
}

function assertEmptyCollection(snapshot: Snapshot, key: keyof Snapshot) {
  const value = snapshot[key] as Record<string, unknown>;
  if (value && Object.keys(value).length) {
    throw new Error(`unsupported snapshot feature at ${String(key)}; legacy equivalence cannot be certified`);
  }
}

export function assertSnapshotSupported(snapshot: Snapshot): void {
  assertAllowedKeys(snapshot, ROOT_KEYS, "snapshot root");
  if (snapshot.version !== "7" || snapshot.dialect !== "postgresql") {
    throw new Error(`unsupported snapshot version/dialect: ${snapshot.version}/${snapshot.dialect}`);
  }
  for (const key of ["enums", "schemas", "sequences", "roles", "policies", "views"] as const) {
    assertEmptyCollection(snapshot, key);
  }
  assertAllowedKeys(snapshot._meta, META_KEYS, "snapshot _meta");
  for (const key of META_KEYS) {
    if (Object.keys((snapshot._meta[key] as Record<string, unknown>) ?? {}).length) {
      throw new Error(`unsupported snapshot feature at _meta.${key}; legacy equivalence cannot be certified`);
    }
  }

  for (const [qualifiedName, table] of Object.entries(snapshot.tables)) {
    assertAllowedKeys(table, TABLE_KEYS, qualifiedName);
    const schema = table.schema || "public";
    if (schema !== "public" || qualifiedName !== `public.${table.name}`) {
      throw new Error(`unsupported snapshot table schema at ${qualifiedName}`);
    }
    if (table.isRLSEnabled || Object.keys(table.policies ?? {}).length) {
      throw new Error(`unsupported snapshot feature at ${qualifiedName}: row-level security`);
    }
    for (const [columnName, column] of Object.entries(table.columns)) {
      assertAllowedKeys(column, COLUMN_KEYS, `${qualifiedName}.${columnName}`);
    }
    for (const [indexName, index] of Object.entries(table.indexes ?? {})) {
      assertAllowedKeys(index as object, INDEX_KEYS, `${qualifiedName}.indexes.${indexName}`);
      if ((index as any).concurrently) {
        throw new Error(`unsupported snapshot feature at ${qualifiedName}.indexes.${indexName}: concurrently`);
      }
      for (const [position, column] of (index as any).columns.entries()) {
        assertAllowedKeys(column, INDEX_COLUMN_KEYS, `${qualifiedName}.indexes.${indexName}.columns[${position}]`);
      }
    }
    for (const [foreignKeyName, foreignKey] of Object.entries(table.foreignKeys ?? {})) {
      assertAllowedKeys(foreignKey as object, FOREIGN_KEY_KEYS, `${qualifiedName}.foreignKeys.${foreignKeyName}`);
    }
    for (const [name, key] of Object.entries(table.compositePrimaryKeys ?? {})) {
      assertAllowedKeys(key as object, ["name", "columns"], `${qualifiedName}.compositePrimaryKeys.${name}`);
    }
    for (const [name, constraint] of Object.entries(table.uniqueConstraints ?? {})) {
      assertAllowedKeys(constraint as object, ["name", "nullsNotDistinct", "columns"], `${qualifiedName}.uniqueConstraints.${name}`);
    }
    for (const [name, constraint] of Object.entries(table.checkConstraints ?? {})) {
      assertAllowedKeys(constraint as object, ["name", "value"], `${qualifiedName}.checkConstraints.${name}`);
    }
  }
}

export function loadMigrationManifest(migrationsFolder: string): MigrationManifest {
  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  if (!existsSync(journalPath)) throw new Error(`migration journal is missing: ${journalPath}`);
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries?: Array<{ idx?: number; tag?: string; when?: number }>;
  };
  if (!journal.entries?.length) throw new Error("migration journal has no tracked migrations");

  let previousSnapshotId = "00000000-0000-0000-0000-000000000000";
  let baseline: MigrationManifest["baseline"] | undefined;
  let baselineSnapshot: Snapshot | undefined;
  let latestSnapshot: Snapshot | undefined;
  for (const [index, entry] of journal.entries.entries()) {
    if (entry.idx !== index) throw new Error(`migration journal idx chain is invalid at entry ${index}`);
    if (!entry.tag) throw new Error(`migration journal entry ${index} has no tag`);
    const prefix = entry.tag.match(/^\d+/)?.[0];
    if (!prefix) throw new Error(`migration tag has no numeric prefix: ${entry.tag}`);
    const sqlPath = join(migrationsFolder, `${entry.tag}.sql`);
    const snapshotPath = join(migrationsFolder, "meta", `${prefix}_snapshot.json`);
    if (!existsSync(sqlPath)) throw new Error(`tracked migration SQL is missing: ${sqlPath}`);
    if (!existsSync(snapshotPath)) throw new Error(`tracked migration snapshot is missing: ${snapshotPath}`);
    const migrationSql = readFileSync(sqlPath, "utf8");
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Snapshot;
    if (snapshot.prevId !== previousSnapshotId) {
      throw new Error(`migration snapshot chain is broken at ${snapshotPath}`);
    }
    assertSnapshotSupported(snapshot);
    if (index === 0) {
      const createdAt = journal.entries[index]?.when;
      if (!Number.isSafeInteger(createdAt)) {
        throw new Error("first migration journal entry has an invalid timestamp");
      }
      baseline = {
        hash: createHash("sha256").update(migrationSql).digest("hex"),
        createdAt: createdAt!,
      };
      baselineSnapshot = snapshot;
    }
    previousSnapshotId = snapshot.id;
    latestSnapshot = snapshot;
  }

  const fixedTables = Object.values(latestSnapshot!.tables);
  if (!fixedTables.length) throw new Error("latest migration snapshot contains no public tables");
  return {
    baseline: baseline!,
    baselineSnapshot: baselineSnapshot!,
    snapshot: latestSnapshot!,
    fixedTables,
  };
}

function canonicalType(value: string): string {
  return value
    .toLowerCase()
    .replace("timestamp without time zone", "timestamp")
    .replace("character varying", "varchar")
    .replace(/\s*,\s*/g, ",")
    .trim();
}

function canonicalDefault(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value)
    .trim()
    .replace(/::(?:character varying|varchar|text)(?:\(\d+\))?/gi, "")
    .replace(/\s+/g, " ");
}

function canonicalSql(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value).trim().replace(/\s+/g, " ");
}

function actionName(code: string): string {
  return ({ a: "no action", r: "restrict", c: "cascade", n: "set null", d: "set default" }[code] ?? code);
}

function stableSignatures(values: unknown[]): string[] {
  return values.map((value) => JSON.stringify(value)).sort();
}

function compareSignatures(errors: string[], table: string, label: string, expected: unknown[], actual: unknown[]) {
  const expectedSignatures = stableSignatures(expected);
  const actualSignatures = stableSignatures(actual);
  if (JSON.stringify(expectedSignatures) !== JSON.stringify(actualSignatures)) {
    errors.push(`public.${table}: ${label} expected ${expectedSignatures.join(", ") || "none"}, got ${actualSignatures.join(", ") || "none"}`);
  }
}

function serialSettings(type: string) {
  if (type === "smallserial") return { dataType: "smallint", maxValue: "32767" };
  if (type === "serial") return { dataType: "integer", maxValue: "2147483647" };
  return { dataType: "bigint", maxValue: "9223372036854775807" };
}

export function compareLegacyCatalog(snapshot: Snapshot, catalog: LegacyCatalog): string[] {
  assertSnapshotSupported(snapshot);
  const errors = catalog.unsupportedFeatures.map((feature) => `unsupported catalog feature: ${feature}`);
  const fixedTables = Object.values(snapshot.tables);
  const actualTableNames = new Set(catalog.tables);
  for (const table of fixedTables) {
    if (!actualTableNames.has(table.name)) errors.push(`public.${table.name}: missing table`);
  }
  if (errors.length) return errors;

  for (const table of fixedTables) {
    const expectedColumns = Object.values(table.columns);
    const actualColumns = catalog.columns
      .filter((column) => column.tableName === table.name)
      .sort((left, right) => left.ordinal - right.ordinal);
    const expectedOrder = expectedColumns.map((column) => column.name);
    const actualOrder = actualColumns.map((column) => column.columnName);
    if (JSON.stringify(expectedOrder) !== JSON.stringify(actualOrder)) {
      errors.push(`public.${table.name}: column order expected ${JSON.stringify(expectedOrder)}, got ${JSON.stringify(actualOrder)}`);
    }
    for (const expected of expectedColumns) {
      const actual = actualColumns.find((column) => column.columnName === expected.name);
      if (!actual) continue;
      const expectedType = canonicalType(expected.type);
      const actualType = canonicalType(actual.dataType);
      const serialMatches = expectedType.endsWith("serial") && actualType === canonicalType(serialSettings(expectedType).dataType) && canonicalDefault(actual.defaultValue)?.startsWith("nextval(");
      if (!serialMatches && expectedType !== actualType) {
        errors.push(`public.${table.name}.${expected.name}: type expected ${expected.type}, got ${actual.dataType}`);
      }
      if (expected.notNull !== actual.notNull) {
        errors.push(`public.${table.name}.${expected.name}: nullability expected notNull=${expected.notNull}, got ${actual.notNull}`);
      }
      if (!serialMatches && canonicalDefault(expected.default) !== canonicalDefault(actual.defaultValue)) {
        errors.push(`public.${table.name}.${expected.name}: default expected ${canonicalDefault(expected.default) ?? "none"}, got ${canonicalDefault(actual.defaultValue) ?? "none"}`);
      }
    }

    const constraints = catalog.constraints.filter((constraint) => constraint.tableName === table.name);
    const expectedPrimaryKeys = Object.values(table.compositePrimaryKeys ?? {}).map((key: any) => key.columns);
    const simplePrimaryKey = expectedColumns.filter((column) => column.primaryKey).map((column) => column.name);
    if (simplePrimaryKey.length) expectedPrimaryKeys.push(simplePrimaryKey);
    compareSignatures(errors, table.name, "primary key", expectedPrimaryKeys, constraints.filter((constraint) => constraint.type === "p").map((constraint) => constraint.columns));
    compareSignatures(
      errors,
      table.name,
      "unique constraints",
      Object.values(table.uniqueConstraints ?? {}).map((constraint: any) => ({ name: constraint.name, columns: constraint.columns, nullsNotDistinct: Boolean(constraint.nullsNotDistinct) })),
      constraints.filter((constraint) => constraint.type === "u").map((constraint) => ({ name: constraint.name, columns: constraint.columns, nullsNotDistinct: constraint.nullsNotDistinct })),
    );
    compareSignatures(
      errors,
      table.name,
      "foreign keys",
      Object.values(table.foreignKeys ?? {}).map((constraint: any) => ({ name: constraint.name, columns: constraint.columnsFrom, foreignSchema: constraint.schemaTo || "public", foreignTable: constraint.tableTo, foreignColumns: constraint.columnsTo, onUpdate: constraint.onUpdate ?? "no action", onDelete: constraint.onDelete ?? "no action" })),
      constraints.filter((constraint) => constraint.type === "f").map((constraint) => ({ name: constraint.name, columns: constraint.columns, foreignSchema: constraint.foreignSchema, foreignTable: constraint.foreignTable, foreignColumns: constraint.foreignColumns, onUpdate: actionName(constraint.onUpdate), onDelete: actionName(constraint.onDelete) })),
    );
    compareSignatures(
      errors,
      table.name,
      "check constraints",
      Object.values(table.checkConstraints ?? {}).map((constraint: any) => ({ name: constraint.name, definition: canonicalSql(constraint.value) })),
      constraints.filter((constraint) => constraint.type === "c").map((constraint) => ({ name: constraint.name, definition: canonicalSql(constraint.definition.replace(/^check\s*\((.*)\)$/i, "$1")) })),
    );

    const actualIndexes = catalog.indexes.filter((index) => index.tableName === table.name);
    for (const index of actualIndexes) {
      if (index.columns.some((column) => !column.isKey)) errors.push(`public.${table.name}.${index.name}: unsupported include index columns`);
      if (index.columns.some((column) => !column.collationIsDefault)) errors.push(`public.${table.name}.${index.name}: unsupported non-default index collation`);
    }
    const expectedIndexes = Object.values(table.indexes ?? {}).map((index: any) => ({
      name: index.name,
      unique: Boolean(index.isUnique),
      method: index.method,
      predicate: canonicalSql(index.where),
      storageParameters: Object.fromEntries(Object.entries(index.with ?? {}).map(([key, value]) => [key, String(value)])),
      columns: index.columns.map((column: any, position: number) => ({ position, isKey: true, expression: canonicalSql(column.expression), isExpression: Boolean(column.isExpression), ascending: column.asc !== false, nulls: column.nulls ?? (column.asc === false ? "first" : "last"), opclass: column.opclass ?? null })),
    }));
    const comparableActualIndexes = actualIndexes.map((index) => ({
      name: index.name,
      unique: index.isUnique,
      method: index.method,
      predicate: canonicalSql(index.predicate),
      storageParameters: index.storageParameters,
      columns: index.columns.filter((column) => column.isKey).map((column) => ({ position: column.position, isKey: true, expression: canonicalSql(column.isExpression ? column.expression : column.columnName), isExpression: column.isExpression, ascending: column.ascending, nulls: column.nulls, opclass: column.opclassIsDefault ? null : column.opclass })),
    }));
    compareSignatures(errors, table.name, "indexes", expectedIndexes, comparableActualIndexes);
  }

  const expectedSequences = fixedTables.flatMap((table) =>
    Object.values(table.columns)
      .filter((column) => ["smallserial", "serial", "bigserial"].includes(canonicalType(column.type)))
      .map((column) => {
        const settings = serialSettings(canonicalType(column.type));
        return {
          tableName: table.name,
          columnName: column.name,
          sequenceSchema: "public",
          sequenceName: `${table.name}_${column.name}_seq`,
          dataType: settings.dataType,
          startValue: "1",
          minValue: "1",
          maxValue: settings.maxValue,
          incrementBy: "1",
          cycle: false,
          cacheSize: "1",
          dependencyType: "a",
          defaultLinked: true,
        };
      }),
  );
  compareSignatures(errors, "<fixed tables>", "sequences", expectedSequences, catalog.sequences);
  return errors;
}

function parseStorageParameters(values: string[] | null): Record<string, string> {
  return Object.fromEntries((values ?? []).map((value) => {
    const separator = value.indexOf("=");
    return separator === -1 ? [value, ""] : [value.slice(0, separator), value.slice(separator + 1)];
  }));
}

export async function readLegacyCatalog(client: SqlClient, fixedTables: SnapshotTable[]): Promise<LegacyCatalog> {
  const fixedNames = fixedTables.map((table) => table.name);
  const tables = (await client.unsafe(
    `SELECT c.relname AS table_name,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname=ANY($1::text[])`, [fixedNames],
  )) as any[];
  const columnRows = (await client.unsafe(
    `SELECT c.relname AS table_name,a.attname AS column_name,a.attnum AS ordinal,
            format_type(a.atttypid,a.atttypmod) AS data_type,a.attnotnull AS not_null,
            pg_get_expr(ad.adbin,ad.adrelid) AS default_value,a.attidentity,a.attgenerated
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
       LEFT JOIN pg_attrdef ad ON ad.adrelid=c.oid AND ad.adnum=a.attnum
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname,a.attnum`, [fixedNames],
  )) as any[];
  const constraintRows = (await client.unsafe(
    `SELECT con.conname AS name,rel.relname AS table_name,con.contype AS type,
            ARRAY(SELECT att.attname FROM unnest(con.conkey) WITH ORDINALITY key(attnum,ord) JOIN pg_attribute att ON att.attrelid=rel.oid AND att.attnum=key.attnum ORDER BY key.ord) AS columns,
            foreign_ns.nspname AS foreign_schema,foreign_rel.relname AS foreign_table,
            ARRAY(SELECT att.attname FROM unnest(con.confkey) WITH ORDINALITY key(attnum,ord) JOIN pg_attribute att ON att.attrelid=foreign_rel.oid AND att.attnum=key.attnum ORDER BY key.ord) AS foreign_columns,
            con.confupdtype AS on_update,con.confdeltype AS on_delete,
            COALESCE(constraint_index.indnullsnotdistinct,false) AS nulls_not_distinct,
            pg_get_constraintdef(con.oid,true) AS definition,con.condeferrable,con.condeferred,
            con.convalidated,con.connoinherit,con.confmatchtype
       FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid JOIN pg_namespace n ON n.oid=rel.relnamespace
       LEFT JOIN pg_class foreign_rel ON foreign_rel.oid=con.confrelid LEFT JOIN pg_namespace foreign_ns ON foreign_ns.oid=foreign_rel.relnamespace
       LEFT JOIN pg_index constraint_index ON constraint_index.indexrelid=con.conindid
      WHERE n.nspname='public' AND rel.relname=ANY($1::text[]) AND con.contype IN ('p','u','f','c')`, [fixedNames],
  )) as any[];
  const indexRows = (await client.unsafe(
    `SELECT rel.relname AS table_name,idx.relname AS name,i.indisunique AS is_unique,am.amname AS method,
            key.position,key.position<i.indnkeyatts AS is_key,att.attname AS column_name,
            pg_get_indexdef(i.indexrelid,key.position+1,true) AS expression,(i.indkey[key.position]=0) AS is_expression,
            (i.indoption[key.position]&1)=0 AS ascending,CASE WHEN (i.indoption[key.position]&2)=2 THEN 'first' ELSE 'last' END AS nulls,
            opc.opcname AS opclass,COALESCE(opc.opcdefault,false) AS opclass_is_default,
            (i.indcollation[key.position]=0 OR i.indcollation[key.position]=COALESCE(att.attcollation,0)) AS collation_is_default,
            pg_get_expr(i.indpred,i.indrelid,true) AS predicate,idx.reloptions AS storage_parameters,
            i.indisvalid,i.indisready,i.indisexclusion,i.indisclustered,i.indnullsnotdistinct,
            idx.reltablespace<>0 AS non_default_tablespace
       FROM pg_index i JOIN pg_class rel ON rel.oid=i.indrelid JOIN pg_namespace n ON n.oid=rel.relnamespace
       JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_am am ON am.oid=idx.relam
       CROSS JOIN LATERAL generate_series(0,i.indnatts-1) key(position)
       LEFT JOIN pg_attribute att ON att.attrelid=rel.oid AND att.attnum=i.indkey[key.position]
       LEFT JOIN pg_opclass opc ON opc.oid=i.indclass[key.position]
      WHERE n.nspname='public' AND rel.relname=ANY($1::text[]) AND NOT i.indisprimary
        AND NOT EXISTS(SELECT 1 FROM pg_constraint con WHERE con.conindid=i.indexrelid)
      ORDER BY rel.relname,idx.relname,key.position`, [fixedNames],
  )) as any[];
  const sequenceRows = (await client.unsafe(
    `SELECT tbl.relname AS table_name,att.attname AS column_name,seq_ns.nspname AS sequence_schema,seq.relname AS sequence_name,
            format_type(settings.seqtypid,NULL) AS data_type,settings.seqstart::text AS start_value,
            settings.seqmin::text AS min_value,settings.seqmax::text AS max_value,settings.seqincrement::text AS increment_by,
            settings.seqcycle AS cycle,settings.seqcache::text AS cache_size,ownership.deptype AS dependency_type,
            EXISTS(SELECT 1 FROM pg_attrdef ad JOIN pg_depend default_dep ON default_dep.classid='pg_attrdef'::regclass AND default_dep.objid=ad.oid
                   WHERE ad.adrelid=tbl.oid AND ad.adnum=att.attnum AND default_dep.refobjid=seq.oid) AS default_linked
       FROM pg_class seq JOIN pg_namespace seq_ns ON seq_ns.oid=seq.relnamespace JOIN pg_sequence settings ON settings.seqrelid=seq.oid
       JOIN pg_depend ownership ON ownership.classid='pg_class'::regclass AND ownership.objid=seq.oid AND ownership.refclassid='pg_class'::regclass AND ownership.deptype IN ('a','i')
       JOIN pg_class tbl ON tbl.oid=ownership.refobjid JOIN pg_namespace table_ns ON table_ns.oid=tbl.relnamespace
       JOIN pg_attribute att ON att.attrelid=tbl.oid AND att.attnum=ownership.refobjsubid
      WHERE table_ns.nspname='public' AND tbl.relname=ANY($1::text[]) ORDER BY tbl.relname,att.attnum`, [fixedNames],
  )) as any[];

  const indexes = Array.from(new Set(indexRows.map((row) => `${row.table_name}\0${row.name}`))).map((key) => {
    const [tableName, name] = key.split("\0");
    const rows = indexRows.filter((row) => row.table_name === tableName && row.name === name);
    return {
      tableName,
      name,
      isUnique: rows[0].is_unique,
      method: rows[0].method,
      predicate: rows[0].predicate,
      storageParameters: parseStorageParameters(rows[0].storage_parameters),
      columns: rows.map((row) => ({ position: row.position, isKey: row.is_key, columnName: row.column_name, expression: row.expression, isExpression: row.is_expression, ascending: row.ascending, nulls: row.nulls, opclass: row.opclass, opclassIsDefault: row.opclass_is_default, collationIsDefault: row.collation_is_default })),
    };
  });

  const unsupportedFeatures = [
    ...tables.flatMap((row) => [
      row.relkind !== "r" ? `public.${row.table_name} is not an ordinary table` : null,
      row.relpersistence !== "p" ? `public.${row.table_name} is not persistent` : null,
      row.relrowsecurity || row.relforcerowsecurity ? `public.${row.table_name} uses row-level security` : null,
    ]),
    ...columnRows.flatMap((row) => [
      row.attidentity ? `public.${row.table_name}.${row.column_name} uses identity` : null,
      row.attgenerated ? `public.${row.table_name}.${row.column_name} is generated` : null,
    ]),
    ...constraintRows.flatMap((row) => [
      row.condeferrable || row.condeferred ? `public.${row.table_name}.${row.name} is deferrable` : null,
      !row.convalidated ? `public.${row.table_name}.${row.name} is not validated` : null,
      row.type === "c" && row.connoinherit ? `public.${row.table_name}.${row.name} uses NO INHERIT` : null,
      row.type === "f" && row.confmatchtype !== "s" ? `public.${row.table_name}.${row.name} uses non-simple MATCH` : null,
    ]),
    ...indexRows.flatMap((row) => [
      !row.indisvalid || !row.indisready ? `public.${row.table_name}.${row.name} is invalid or not ready` : null,
      row.indisexclusion ? `public.${row.table_name}.${row.name} is an exclusion index` : null,
      row.indisclustered ? `public.${row.table_name}.${row.name} is clustered` : null,
      row.indnullsnotdistinct ? `public.${row.table_name}.${row.name} uses NULLS NOT DISTINCT` : null,
      row.non_default_tablespace ? `public.${row.table_name}.${row.name} uses a non-default tablespace` : null,
    ]),
  ].filter((value): value is string => value !== null);

  return {
    tables: tables.map((row) => row.table_name),
    columns: columnRows.map((row) => ({ tableName: row.table_name, columnName: row.column_name, ordinal: row.ordinal, dataType: row.data_type, notNull: row.not_null, defaultValue: row.default_value })),
    constraints: constraintRows.map((row) => ({ name: row.name, tableName: row.table_name, type: row.type, columns: row.columns, foreignSchema: row.foreign_schema, foreignTable: row.foreign_table, foreignColumns: row.foreign_columns, onUpdate: row.on_update, onDelete: row.on_delete, nullsNotDistinct: row.nulls_not_distinct, definition: row.definition })),
    indexes,
    sequences: sequenceRows.map((row) => ({ tableName: row.table_name, columnName: row.column_name, sequenceSchema: row.sequence_schema, sequenceName: row.sequence_name, dataType: row.data_type, startValue: row.start_value, minValue: row.min_value, maxValue: row.max_value, incrementBy: row.increment_by, cycle: row.cycle, cacheSize: row.cache_size, dependencyType: row.dependency_type, defaultLinked: row.default_linked })),
    unsupportedFeatures,
  };
}

export async function validateLegacySchema(client: SqlClient, snapshot: Snapshot): Promise<void> {
  const catalog = await readLegacyCatalog(client, Object.values(snapshot.tables));
  const errors = compareLegacyCatalog(snapshot, catalog);
  if (errors.length) {
    throw new Error(`legacy schema validation failed:\n- ${errors.join("\n- ")}\nRefusing to baseline an incomplete, drifted, or unsupported schema. Restore it to the first tracked schema snapshot and retry.`);
  }
}
