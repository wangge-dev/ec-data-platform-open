import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableName } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import {
  dqEvents,
  frontProfitCostPeriods,
  frontProfitFeeFacts,
  frontProfitL1SourceRows,
  frontProfitL3CalcDetails,
  frontProfitL4AggRows,
  frontProfitOperatorAssignments,
  frontProfitPublishRows,
  frontProfitRebateFacts,
  jobRuns,
  jobSteps,
  moduleConfigs,
  moduleConfigVersions,
  moduleSchemaDecisions,
  periodAuthorities,
  periodAuthorityEvents,
  publishVersionSources,
  publishVersions,
  reconResults,
  users,
} from "../src/db/schema.js";
import {
  assertSnapshotSupported,
  compareLegacyCatalog,
  loadMigrationManifest,
  type LegacyCatalog,
  type Snapshot,
} from "../scripts/migration-schema.js";

const root = resolve(import.meta.dirname, "../../..");

test("migration manifest keeps the first snapshot as the legacy baseline", () => {
  const manifest = loadMigrationManifest(resolve(root, "apps/api/drizzle"));
  const journal = JSON.parse(
    readFileSync(resolve(root, "apps/api/drizzle/meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ when: number }> };

  expect(manifest.baselineSnapshot.id).toBe(
    JSON.parse(
      readFileSync(resolve(root, "apps/api/drizzle/meta/0000_snapshot.json"), "utf8"),
    ).id,
  );
  expect(manifest.snapshot.id).toBe(
    JSON.parse(
      readFileSync(resolve(root, "apps/api/drizzle/meta/0009_snapshot.json"), "utf8"),
    ).id,
  );
  expect(manifest.baseline.createdAt).toBe(journal.entries[0].when);
  expect(manifest.baseline.hash).toMatch(/^[a-f0-9]{64}$/);
});

const makeSnapshot = (): Snapshot => ({
  id: "snapshot-1",
  prevId: "00000000-0000-0000-0000-000000000000",
  version: "7",
  dialect: "postgresql",
  tables: {
    "public.parents": {
      name: "parents",
      schema: "",
      columns: {
        id: { name: "id", type: "bigserial", primaryKey: true, notNull: true },
      },
      indexes: {},
      foreignKeys: {},
      compositePrimaryKeys: {},
      uniqueConstraints: {},
      checkConstraints: {},
      policies: {},
      isRLSEnabled: false,
    },
    "public.children": {
      name: "children",
      schema: "",
      columns: {
        id: { name: "id", type: "bigserial", primaryKey: true, notNull: true },
        parent_id: { name: "parent_id", type: "bigint", primaryKey: false, notNull: true },
      },
      indexes: {
        children_parent_idx: {
          name: "children_parent_idx",
          columns: [
            { expression: "parent_id", isExpression: false, asc: true, nulls: "last" },
          ],
          isUnique: false,
          concurrently: false,
          method: "btree",
          with: {},
        },
      },
      foreignKeys: {
        children_parent_id_parents_id_fk: {
          name: "children_parent_id_parents_id_fk",
          tableFrom: "children",
          tableTo: "parents",
          schemaTo: "public",
          columnsFrom: ["parent_id"],
          columnsTo: ["id"],
          onDelete: "no action",
          onUpdate: "no action",
        },
      },
      compositePrimaryKeys: {},
      uniqueConstraints: {},
      checkConstraints: {},
      policies: {},
      isRLSEnabled: false,
    },
  },
  enums: {},
  schemas: {},
  sequences: {},
  roles: {},
  policies: {},
  views: {},
  _meta: { columns: {}, schemas: {}, tables: {} },
});

const serial = (tableName: string): LegacyCatalog["sequences"][number] => ({
  tableName,
  columnName: "id",
  sequenceSchema: "public",
  sequenceName: `${tableName}_id_seq`,
  dataType: "bigint",
  startValue: "1",
  minValue: "1",
  maxValue: "9223372036854775807",
  incrementBy: "1",
  cycle: false,
  cacheSize: "1",
  dependencyType: "a",
  defaultLinked: true,
});

const makeCatalog = (): LegacyCatalog => ({
  tables: ["children", "parents"],
  columns: [
    { tableName: "parents", columnName: "id", ordinal: 1, dataType: "bigint", notNull: true, defaultValue: "nextval('parents_id_seq'::regclass)" },
    { tableName: "children", columnName: "id", ordinal: 1, dataType: "bigint", notNull: true, defaultValue: "nextval('children_id_seq'::regclass)" },
    { tableName: "children", columnName: "parent_id", ordinal: 2, dataType: "bigint", notNull: true, defaultValue: null },
  ],
  constraints: [
    { name: "parents_pkey", tableName: "parents", type: "p", columns: ["id"], foreignSchema: null, foreignTable: null, foreignColumns: [], onUpdate: "a", onDelete: "a", nullsNotDistinct: false, definition: "PRIMARY KEY (id)" },
    { name: "children_pkey", tableName: "children", type: "p", columns: ["id"], foreignSchema: null, foreignTable: null, foreignColumns: [], onUpdate: "a", onDelete: "a", nullsNotDistinct: false, definition: "PRIMARY KEY (id)" },
    { name: "children_parent_id_parents_id_fk", tableName: "children", type: "f", columns: ["parent_id"], foreignSchema: "public", foreignTable: "parents", foreignColumns: ["id"], onUpdate: "a", onDelete: "a", nullsNotDistinct: false, definition: "FOREIGN KEY (parent_id) REFERENCES parents(id)" },
  ],
  indexes: [
    {
      tableName: "children",
      name: "children_parent_idx",
      isUnique: false,
      method: "btree",
      predicate: null,
      storageParameters: {},
      columns: [
        { position: 0, isKey: true, columnName: "parent_id", expression: "parent_id", isExpression: false, ascending: true, nulls: "last", opclass: "int8_ops", opclassIsDefault: true, collationIsDefault: true },
      ],
    },
  ],
  sequences: [serial("parents"), serial("children")],
  unsupportedFeatures: [],
});

const clone = <T>(value: T): T => structuredClone(value);

describe("legacy migration schema comparator", () => {
  test("supports the current latest Drizzle snapshot", () => {
    const snapshot = JSON.parse(
      readFileSync(resolve(root, "apps/api/drizzle/meta/0000_snapshot.json"), "utf8"),
    );
    expect(() => assertSnapshotSupported(snapshot)).not.toThrow();
  });

  test("accepts an exactly matching catalog including serial sequence semantics", () => {
    expect(compareLegacyCatalog(makeSnapshot(), makeCatalog())).toEqual([]);
  });

  test("detects foreign-key referenced schema drift", () => {
    const catalog = makeCatalog();
    catalog.constraints.find((constraint) => constraint.type === "f")!.foreignSchema = "user_data";
    expect(compareLegacyCatalog(makeSnapshot(), catalog).join("\n")).toMatch(/foreign keys.*user_data/);
  });

  test.each([
    ["predicate", (catalog: LegacyCatalog) => { catalog.indexes[0].predicate = "parent_id > 0"; }],
    ["storage", (catalog: LegacyCatalog) => { catalog.indexes[0].storageParameters = { fillfactor: "70" }; }],
    ["opclass", (catalog: LegacyCatalog) => { catalog.indexes[0].columns[0].opclass = "int8_minmax_ops"; catalog.indexes[0].columns[0].opclassIsDefault = false; }],
    ["collation", (catalog: LegacyCatalog) => { catalog.indexes[0].columns[0].collationIsDefault = false; }],
    ["include", (catalog: LegacyCatalog) => { catalog.indexes[0].columns.push({ ...catalog.indexes[0].columns[0], position: 1, isKey: false }); }],
  ])("detects or refuses %s index semantics", (_feature, mutate) => {
    const catalog = makeCatalog();
    mutate(catalog);
    expect(compareLegacyCatalog(makeSnapshot(), catalog).join("\n")).toMatch(/index|unsupported/i);
  });

  test("preserves quoted expression semantics", () => {
    const snapshot = makeSnapshot();
    snapshot.tables["public.children"].indexes.children_parent_idx.columns[0] = {
      expression: 'lower("CaseSensitive")',
      isExpression: true,
      asc: true,
      nulls: "last",
    };
    const catalog = makeCatalog();
    catalog.indexes[0].columns[0] = {
      ...catalog.indexes[0].columns[0],
      columnName: null,
      expression: "lower(casesensitive)",
      isExpression: true,
      collationIsDefault: true,
    };
    expect(compareLegacyCatalog(snapshot, catalog).join("\n")).toMatch(/indexes/);
  });

  test.each([
    ["default linkage", (catalog: LegacyCatalog) => { catalog.sequences[0].defaultLinked = false; }],
    ["ownership linkage", (catalog: LegacyCatalog) => { catalog.sequences[0].dependencyType = "n"; }],
    ["increment", (catalog: LegacyCatalog) => { catalog.sequences[0].incrementBy = "2"; }],
    ["cache", (catalog: LegacyCatalog) => { catalog.sequences[0].cacheSize = "10"; }],
  ])("detects serial sequence %s drift", (_feature, mutate) => {
    const catalog = makeCatalog();
    mutate(catalog);
    expect(compareLegacyCatalog(makeSnapshot(), catalog).join("\n")).toMatch(/sequences/);
  });

  test("fails closed on unsupported future snapshot features", () => {
    const roleSnapshot = makeSnapshot();
    roleSnapshot.roles.ec_app = { name: "ec_app" };
    expect(() => assertSnapshotSupported(roleSnapshot)).toThrow(/unsupported snapshot feature.*roles/i);

    const identitySnapshot = makeSnapshot();
    (identitySnapshot.tables["public.parents"].columns.id as any).identity = "always";
    expect(() => assertSnapshotSupported(identitySnapshot)).toThrow(/unsupported snapshot field.*identity/i);

    const concurrentSnapshot = makeSnapshot();
    concurrentSnapshot.tables["public.children"].indexes.children_parent_idx.concurrently = true;
    expect(() => assertSnapshotSupported(concurrentSnapshot)).toThrow(/concurrently/i);

    const metadataSnapshot = makeSnapshot();
    metadataSnapshot._meta.tables = { renamed: "parents" };
    expect(() => assertSnapshotSupported(metadataSnapshot)).toThrow(/_meta\.tables/i);
  });

  test("fails closed on catalog features the snapshot cannot represent", () => {
    const catalog = makeCatalog();
    catalog.unsupportedFeatures.push("public.children.parent_id is generated");
    expect(compareLegacyCatalog(makeSnapshot(), catalog).join("\n")).toMatch(
      /unsupported catalog feature.*generated/i,
    );
  });
});

describe("JWT token version migration", () => {
  test("adds a backward-compatible non-null version to every existing user", () => {
    const migration = readFileSync(
      resolve(root, "apps/api/drizzle/0004_charming_xorn.sql"),
      "utf8",
    );

    expect(migration).toMatch(
      /ALTER TABLE "public"\."users" ADD COLUMN "token_version" integer DEFAULT 0 NOT NULL/i,
    );
    expect(users.tokenVersion.name).toBe("token_version");
    expect(users.tokenVersion.notNull).toBe(true);
    expect(users.tokenVersion.hasDefault).toBe(true);
  });
});

describe("complex job framework migration", () => {
  const migrationPath = resolve(
    root,
    "apps/api/drizzle/0005_complex_job_framework.sql",
  );

  test("creates generic run, step, DQ, reconciliation and publish tables", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS "public"\."job_run"/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS "public"\."job_step"/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS "public"\."dq_event"/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS "public"\."recon_result"/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS "public"\."publish_version"/i);
  });

  test("enforces publish version uniqueness and generic status checks", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toMatch(/"publish_version_module_scope_version_key" UNIQUE\("module_code","scope_key","version_no"\)/);
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "uq_publish_version_published_scope"');
    expect(migration).toContain(`"public"."publish_version"."status" = 'published'`);
    expect(migration).toMatch(/"job_run_status_check" CHECK/);
    expect(migration).toMatch(/"dq_event_severity_check" CHECK/);
  });

  test("exports matching Drizzle tables", () => {
    expect([
      getTableName(jobRuns),
      getTableName(jobSteps),
      getTableName(dqEvents),
      getTableName(reconResults),
      getTableName(publishVersions),
    ]).toEqual([
      "job_run",
      "job_step",
      "dq_event",
      "recon_result",
      "publish_version",
    ]);
  });
});

describe("period authority migration", () => {
  const migrationPath = resolve(
    root,
    "apps/api/drizzle/0006_period_authority.sql",
  );

  test("creates current authority state and audit events", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS "public"\."period_authority"/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS "public"\."period_authority_event"/i);
    expect(migration).toMatch(/"period_authority_module_scope_key" UNIQUE\("module_code","scope_key"\)/);
    expect(migration).toContain("'manual', 'auto'");
    expect(migration).toContain("'initialized', 'set_authority', 'reopen_period'");
    expect(migration).toMatch(/"period_authority_close_day_check" CHECK/);
  });

  test("exports matching Drizzle tables", () => {
    expect([
      getTableName(periodAuthorities),
      getTableName(periodAuthorityEvents),
    ]).toEqual([
      "period_authority",
      "period_authority_event",
    ]);
  });
});

describe("publish source and fixed front-profit row migration", () => {
  const migrationPath = resolve(
    root,
    "apps/api/drizzle/0007_publish_sources_and_front_profit_rows.sql",
  );

  test("creates source references and the fixed front-profit publish row table", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS "public"\."publish_version_source"/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS "public"\."front_profit_publish_row"/i);
    expect(migration).toMatch(/"publish_version_source_version_source_role_key" UNIQUE\("publish_version_id","source_id","role"\)/);
    expect(migration).toContain('"fp_publish_row_version_fk"');
    expect(migration).not.toContain("front_profit_publish_row_publish_version_id_publish_version_id_fk");
    expect(migration).toMatch(/"front_profit_publish_row_version_record_id_key" UNIQUE\("publish_version_id","record_id"\)/);
    expect(migration).toMatch(/"front_profit_publish_row_version_aggregation_key" UNIQUE\("publish_version_id","aggregation_key"\)/);
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "uq_front_profit_publish_row_published_period_key"');
    expect(migration).toContain(`"public"."front_profit_publish_row"."status" = 'published'`);
  });

  test("exports matching Drizzle tables", () => {
    expect([
      getTableName(publishVersionSources),
      getTableName(frontProfitPublishRows),
    ]).toEqual([
      "publish_version_source",
      "front_profit_publish_row",
    ]);
  });
});

describe("front-profit L1/L3/L4 layer skeleton migration", () => {
  const migrationPath = resolve(
    root,
    "apps/api/drizzle/0008_front_profit_layer_skeleton.sql",
  );

  test("creates additive module-layer tables without changing publish rows", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS "public"\."front_profit_l1_source_row"/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS "public"\."front_profit_l3_calc_detail"/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS "public"\."front_profit_l4_agg_row"/i);
    expect(migration).not.toMatch(/ALTER TABLE "public"\."front_profit_publish_row"/i);
    expect(migration).not.toMatch(/CREATE TABLE IF NOT EXISTS "public"\."fact_rebate"/i);
  });

  test("preserves run-scoped idempotency and lineage hooks", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toMatch(/"fp_l1_source_row_run_record_kind_key" UNIQUE\("run_id","source_family","source_record_key","amount_kind"\)/);
    expect(migration).toMatch(/"fp_l3_calc_detail_run_detail_key" UNIQUE\("run_id","detail_key"\)/);
    expect(migration).toMatch(/"fp_l4_agg_row_run_record_key" UNIQUE\("run_id","record_id"\)/);
    expect(migration).toMatch(/"fp_l4_agg_row_run_aggregation_key" UNIQUE\("run_id","aggregation_key"\)/);
    expect(migration).toContain('"mapping_version_id" bigint');
    expect(migration).toContain('"rule_version" varchar(64) NOT NULL');
    expect(migration).toContain('"job_version" varchar(64) NOT NULL');
    expect(migration).toContain('"fp_l4_publish_version_fk"');
  });

  test("exports matching Drizzle tables", () => {
    expect([
      getTableName(frontProfitL1SourceRows),
      getTableName(frontProfitL3CalcDetails),
      getTableName(frontProfitL4AggRows),
    ]).toEqual([
      "front_profit_l1_source_row",
      "front_profit_l3_calc_detail",
      "front_profit_l4_agg_row",
    ]);
  });
});

describe("front-profit business rule skeleton migration", () => {
  const migrationPath = resolve(
    root,
    "apps/api/drizzle/0009_front_profit_business_rule_skeleton.sql",
  );

  test("creates additive business-rule tables without changing L4 or publish rows", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS "public"\."front_profit_rebate_fact"/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS "public"\."front_profit_fee_fact"/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS "public"\."front_profit_operator_assignment"/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS "public"\."front_profit_cost_period"/i);
    expect(migration).not.toMatch(/ALTER TABLE "public"\."front_profit_l4_agg_row"/i);
    expect(migration).not.toMatch(/ALTER TABLE "public"\."front_profit_publish_row"/i);
  });

  test("encodes the accepted P0 fail-closed boundaries", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toMatch(/"fp_rebate_fact_run_rebate_key" UNIQUE\("run_id","rebate_key"\)/);
    expect(migration).toMatch(/"fp_fee_authority_source_check" CHECK/);
    expect(migration).toContain("'settlement', 'platform_bill', 'rate_rule', 'manual_estimate'");
    expect(migration).toMatch(/"fp_operator_authority_key_type_check" CHECK/);
    expect(migration).toContain("'sku', 'ad_account', 'product_owner', 'order_owner', 'manual_mapping'");
    expect(migration).toMatch(/"fp_operator_authority_key_check" CHECK/);
    expect(migration).toMatch(/"fp_cost_effective_range_check" CHECK/);
    expect(migration).toMatch(/"fp_cost_period_run_sku_kind_from" UNIQUE\("run_id","sku_key","cost_kind","effective_from"\)/);
  });

  test("exports matching Drizzle tables", () => {
    expect([
      getTableName(frontProfitRebateFacts),
      getTableName(frontProfitFeeFacts),
      getTableName(frontProfitOperatorAssignments),
      getTableName(frontProfitCostPeriods),
    ]).toEqual([
      "front_profit_rebate_fact",
      "front_profit_fee_fact",
      "front_profit_operator_assignment",
      "front_profit_cost_period",
    ]);
  });
});

describe("user module configuration migration", () => {
  const migrationPath = resolve(
    root,
    "apps/api/drizzle/0002_user_module_configs.sql",
  );

  test("creates all three public configuration tables", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toMatch(/CREATE TABLE public\.module_configs/i);
    expect(migration).toMatch(/CREATE TABLE public\.module_config_versions/i);
    expect(migration).toMatch(/CREATE TABLE public\.module_schema_decisions/i);
  });

  test("enforces unique active module codes and immutable version numbers", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toMatch(/code VARCHAR\(64\) NOT NULL UNIQUE/i);
    expect(migration).toMatch(/UNIQUE\s*\(module_code,\s*version\)/i);
    expect(migration).toMatch(
      /status VARCHAR\(16\) NOT NULL DEFAULT 'active'.*CHECK\s*\(status IN \('active', 'archived'\)\)/is,
    );
  });

  test("records actor and timestamp audit fields", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration.match(/created_by BIGINT NOT NULL REFERENCES public\.users\(id\)/gi))
      .toHaveLength(3);
    expect(migration.match(/created_at TIMESTAMP NOT NULL DEFAULT NOW\(\)/gi))
      .toHaveLength(2);
    expect(migration.match(/updated_at TIMESTAMP NOT NULL DEFAULT NOW\(\)/gi))
      .toHaveLength(2);
  });

  test("exports matching Drizzle tables", () => {
    expect([
      getTableName(moduleConfigs),
      getTableName(moduleConfigVersions),
      getTableName(moduleSchemaDecisions),
    ]).toEqual([
      "module_configs",
      "module_config_versions",
      "module_schema_decisions",
    ]);
  });
});
