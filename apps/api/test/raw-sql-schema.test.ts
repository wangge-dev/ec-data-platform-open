import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { getTableName } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import * as schema from "../src/db/schema.js";

const apiRoot = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(apiRoot, "src");
const fixedTableNames = Object.values(schema).map(getTableName).sort();

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });

const sqlStringContents = (file: string): string[] => {
  const source = readFileSync(file, "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const contents: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node)) contents.push(node.text);
    if (ts.isTemplateExpression(node)) {
      contents.push(node.head.text + node.templateSpans.map((span) => span.literal.text).join(""));
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return contents;
};

describe("raw SQL schema qualification", () => {
  test("schema-qualifies every literal reference to the 31 fixed ORM tables", () => {
    expect(fixedTableNames).toEqual([
      "agent_runs",
      "agents",
      "alerts",
      "charts",
      "dashboards",
      "data_sources",
      "datasets",
      "dq_event",
      "front_profit_cost_period",
      "front_profit_fee_fact",
      "front_profit_l1_source_row",
      "front_profit_l3_calc_detail",
      "front_profit_l4_agg_row",
      "front_profit_operator_assignment",
      "front_profit_publish_row",
      "front_profit_rebate_fact",
      "job_run",
      "job_step",
      "module_config_versions",
      "module_configs",
      "module_schema_decisions",
      "period_authority",
      "period_authority_event",
      "platform_templates",
      "publish_version",
      "publish_version_source",
      "recon_result",
      "settings",
      "unified_sales",
      "unified_shopee_sales",
      "users",
    ]);

    const violations: string[] = [];
    for (const file of sourceFiles(sourceRoot)) {
      for (const content of sqlStringContents(file)) {
        for (const table of fixedTableNames) {
          const operation = "(?:from|join|update|into|delete\\s+from|truncate(?:\\s+table)?)";
          const publicPrefix = '\\"?public\\"?\\s*\\.\\s*\\"?';
          const pattern = new RegExp(
            `\\b${operation}\\s+(?!${publicPrefix})\\\"?${table}\\\"?\\b`,
            "i",
          );
          if (pattern.test(content)) {
            violations.push(`${file.slice(apiRoot.length + 1)}: ${content.trim().replace(/\\s+/g, " ").slice(0, 180)}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("routes fixed module outputs to public and dynamic tables to user_data", async () => {
    const helperPath = resolve(sourceRoot, "db/table-scope.ts");
    expect(existsSync(helperPath)).toBe(true);
    const {
      quoteSqlIdentifier,
      runtimeTableReference,
      runtimeTableSchema,
      schemaTableReference,
      PUBLIC_FIXED_TABLES,
    } = await import("../src/db/table-scope.js");

    expect([...PUBLIC_FIXED_TABLES].sort()).toEqual(fixedTableNames);
    for (const table of fixedTableNames) {
      expect(runtimeTableReference(table)).toBe(`"public"."${table}"`);
      expect(runtimeTableSchema(table)).toBe("public");
    }
    expect(runtimeTableReference("unified_inventory")).toBe('"user_data"."unified_inventory"');
    expect(runtimeTableReference("uf_42")).toBe('"user_data"."uf_42"');
    expect(runtimeTableSchema("uf_42")).toBe("user_data");
    expect(schemaTableReference("user_data", "unified_sales")).toBe('"user_data"."unified_sales"');
    expect(quoteSqlIdentifier('字典"列')).toBe('"字典""列"');
    expect(() => quoteSqlIdentifier("bad\0column")).toThrow("Invalid SQL identifier");
    expect(() => schemaTableReference("private", "alerts")).toThrow("Invalid runtime schema");
    expect(() => runtimeTableReference('alerts"; DROP TABLE public.users; --')).toThrow("Invalid runtime table name");
  });

  test("prefers an existing user_data dynamic table over a public legacy table", async () => {
    const { resolveExistingRuntimeTableReference } = await import("../src/db/table-scope.js");
    const probes: string[] = [];
    const reference = await resolveExistingRuntimeTableReference("uf_42", async (schema, table) => {
      probes.push(`${schema}.${table}`);
      return true;
    });

    expect(reference).toBe('"user_data"."uf_42"');
    expect(probes).toEqual(["user_data.uf_42"]);
  });

  test("falls back to public only for an existing validated non-fixed legacy table", async () => {
    const { resolveExistingRuntimeTableReference } = await import("../src/db/table-scope.js");
    const probes: string[] = [];
    const reference = await resolveExistingRuntimeTableReference("uf_35", async (schema, table) => {
      probes.push(`${schema}.${table}`);
      return schema === "public";
    });

    expect(reference).toBe('"public"."uf_35"');
    expect(probes).toEqual(["user_data.uf_35", "public.uf_35"]);
    await expect(
      resolveExistingRuntimeTableReference('uf_35"; DROP TABLE public.users; --', async () => true),
    ).rejects.toThrow("Invalid runtime table name");
  });

  test("pins fixed tables to public without allowing user_data shadow probes", async () => {
    const { resolveExistingRuntimeTableReference } = await import("../src/db/table-scope.js");
    for (const table of fixedTableNames) {
      let probeCount = 0;
      const reference = await resolveExistingRuntimeTableReference(table, async () => {
        probeCount += 1;
        return true;
      });
      expect(reference).toBe(`"public"."${table}"`);
      expect(probeCount).toBe(0);
    }
  });

  test.each([
    "module_configs",
    "module_config_versions",
    "module_schema_decisions",
    "job_run",
    "job_step",
    "dq_event",
    "front_profit_cost_period",
    "front_profit_fee_fact",
    "front_profit_l1_source_row",
    "front_profit_l3_calc_detail",
    "front_profit_l4_agg_row",
    "front_profit_operator_assignment",
    "front_profit_publish_row",
    "front_profit_rebate_fact",
    "recon_result",
    "publish_version",
    "publish_version_source",
    "period_authority",
    "period_authority_event",
  ])("pins framework fixed table %s to public without a user_data probe", async (table) => {
    const { resolveExistingRuntimeTableReference } = await import("../src/db/table-scope.js");
    const probes: string[] = [];

    const reference = await resolveExistingRuntimeTableReference(table, async (schema, name) => {
      probes.push(`${schema}.${name}`);
      return true;
    });

    expect(reference).toBe(`"public"."${table}"`);
    expect(probes).toEqual([]);
  });

  test("validates freeform SQL without rewriting it", () => {
    const board = readFileSync(resolve(sourceRoot, "routes/board.ts"), "utf8");
    const alerts = readFileSync(resolve(sourceRoot, "modules/alerts-engine.ts"), "utf8");
    const guard = readFileSync(resolve(sourceRoot, "lib/sql-guard.ts"), "utf8");

    expect(guard).not.toContain("type SqlTokenKind");
    expect(guard).not.toContain("function sqlTokens");
    expect(board).toContain("ensureReadOnly(queryText)");
    expect(board).not.toContain("executeLocalReadOnlyQuery(finalSpec.sql");
    expect(board).not.toContain("/ai-chart-legacy");
    expect(board).toContain('queryType: z.literal("semantic")');
    expect(board).toMatch(
      /async function datasetQueryPlan[\s\S]*resolveExistingRuntimeTableReferenceFromSql\(tableName, sql\)/,
    );
    expect(board).not.toContain('SELECT * FROM "${safeTableName(queryText)}"');
    expect(board).not.toContain('SELECT * FROM "${safeTableName(ds.queryText!)}"');
    expect(alerts).toContain("ensureReadOnly(rule.sql)");
    expect(alerts).not.toContain("sql.unsafe(rule.sql)");
  });

  test("keeps concurrent first dynamic ETL creation atomic", () => {
    const transform = readFileSync(resolve(sourceRoot, "modules/default-transform.ts"), "utf8");
    expect(transform).toContain("CREATE TABLE IF NOT EXISTS ${tableRef}");
    expect(transform).toContain("pg_advisory_xact_lock(hashtextextended($1, 0))");
    expect(transform).toContain("quoteSqlIdentifier(pair.right!)");
    expect(transform).not.toContain("return map[rawName] ?? rawName");
    expect(transform).not.toContain("CREATE TABLE ${tableRef} (");
  });

  test("cleans duplicate dynamic tables in every runtime schema", () => {
    const importer = readFileSync(resolve(sourceRoot, "services/import-excel.ts"), "utf8");

    expect(importer).toContain("c.table_schema, c.table_name");
    expect(importer).toContain("schemaTableReference(t.table_schema, t.table_name)");
    expect(importer).toContain('for (const schema of ["user_data", "public"] as const)');
    expect(importer).toContain("DROP TABLE IF EXISTS ${schemaTableReference(schema, tableName)}");
  });
});
