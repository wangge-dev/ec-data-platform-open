export const PUBLIC_FIXED_TABLES = new Set([
  "users",
  "data_sources",
  "datasets",
  "dashboards",
  "charts",
  "agents",
  "agent_runs",
  "settings",
  "module_configs",
  "module_config_versions",
  "module_schema_decisions",
  "unified_sales",
  "unified_shopee_sales",
  "platform_templates",
  "alerts",
  "job_run",
  "job_step",
  "dq_event",
  "recon_result",
  "publish_version",
  "publish_version_source",
  "front_profit_publish_row",
  "front_profit_l1_source_row",
  "front_profit_l3_calc_detail",
  "front_profit_l4_agg_row",
  "front_profit_rebate_fact",
  "front_profit_fee_fact",
  "front_profit_operator_assignment",
  "front_profit_cost_period",
  "period_authority",
  "period_authority_event",
]);

const RUNTIME_TABLE_NAME = /^[a-z][a-z0-9_]*$/;
const RUNTIME_SCHEMAS = new Set(["public", "user_data"]);
export type RuntimeSchema = "public" | "user_data";
export type RuntimeTableExistenceProbe = (
  schema: RuntimeSchema,
  tableName: string,
) => Promise<boolean>;
export type RuntimeTableLocation = {
  schema: RuntimeSchema;
  tableName: string;
  reference: string;
};

type UnsafeSqlClient = {
  unsafe: (query: string, parameters?: any[]) => PromiseLike<any[]>;
};

/**
 * Quote a PostgreSQL identifier without treating user/configuration text as SQL.
 * Table names still use the stricter runtime-table allowlist below; this helper
 * is for validated metadata such as imported dictionary column names, which may
 * legitimately contain spaces or non-ASCII characters.
 */
export function quoteSqlIdentifier(identifier: string): string {
  if (!identifier || identifier.includes("\0")) {
    throw new Error("Invalid SQL identifier");
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function schemaTableReference(schema: string, tableName: string): string {
  if (!RUNTIME_SCHEMAS.has(schema)) {
    throw new Error(`Invalid runtime schema: ${schema}`);
  }
  if (!RUNTIME_TABLE_NAME.test(tableName)) {
    throw new Error(`Invalid runtime table name: ${tableName}`);
  }
  return `"${schema}"."${tableName}"`;
}

export function runtimeTableSchema(tableName: string): RuntimeSchema {
  if (!RUNTIME_TABLE_NAME.test(tableName)) {
    throw new Error(`Invalid runtime table name: ${tableName}`);
  }
  return PUBLIC_FIXED_TABLES.has(tableName) ? "public" : "user_data";
}

export function runtimeTableReference(tableName: string): string {
  const schema = runtimeTableSchema(tableName);
  return schemaTableReference(schema, tableName);
}

export async function resolveExistingRuntimeTable(
  tableName: string,
  tableExists: RuntimeTableExistenceProbe,
): Promise<RuntimeTableLocation | null> {
  const defaultSchema = runtimeTableSchema(tableName);
  if (defaultSchema === "public") {
    return {
      schema: "public",
      tableName,
      reference: schemaTableReference("public", tableName),
    };
  }

  for (const schema of ["user_data", "public"] as const) {
    if (await tableExists(schema, tableName)) {
      return { schema, tableName, reference: schemaTableReference(schema, tableName) };
    }
  }
  return null;
}

export async function resolveExistingRuntimeTableReference(
  tableName: string,
  tableExists: RuntimeTableExistenceProbe,
): Promise<string | null> {
  return (await resolveExistingRuntimeTable(tableName, tableExists))?.reference ?? null;
}

export async function resolveExistingRuntimeTableFromSql(
  tableName: string,
  client: UnsafeSqlClient,
): Promise<RuntimeTableLocation | null> {
  return resolveExistingRuntimeTable(tableName, async (schema, name) => {
    const [exists] = await client.unsafe(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 LIMIT 1`,
      [schema, name],
    );
    return Boolean(exists);
  });
}

export async function resolveExistingRuntimeTableReferenceFromSql(
  tableName: string,
  client: UnsafeSqlClient,
): Promise<string | null> {
  return (await resolveExistingRuntimeTableFromSql(tableName, client))?.reference ?? null;
}
