import { resolveExistingRuntimeTableReferenceFromSql } from "../db/table-scope.js";
import { FILE_TABLE_PREFIX } from "./import-excel.js";
import {
  FRONT_PROFIT_COST_APPLIED_AMOUNT_KIND,
  FRONT_PROFIT_COST_APPLIED_SOURCE_FAMILY,
  FRONT_PROFIT_COST_SOURCE_HEADERS,
  FRONT_PROFIT_COST_SOURCE_VERSION,
  FRONT_PROFIT_COST_USAGE_HEADERS,
  normalizeFrontProfitCostSourceRows,
  normalizeFrontProfitCostUsageRows,
  type FrontProfitCostSourceRawRow,
  type FrontProfitCostSourceRow,
  type FrontProfitCostUsageRawRow,
  type FrontProfitCostUsageRow,
} from "./front-profit-cost-source.js";
import {
  FRONT_PROFIT_FEE_SOURCE_HEADERS,
  normalizeFrontProfitFeeSourceRows,
  type FrontProfitFeeSourceRawRow,
  type FrontProfitFeeSourceRow,
} from "./front-profit-fee-source.js";
import {
  FRONT_PROFIT_STANDARD_HEADERS,
  isValidatedFrontProfitSourceConfig,
} from "./front-profit-standard.js";
import { canonicalRowsContract } from "./front-profit-canonical-rows-contract.js";
import {
  type FrontProfitL4AggRowForContract,
} from "./front-profit-layers.js";
import {
  FRONT_PROFIT_OPERATOR_ASSIGNMENT_HEADERS,
  normalizeFrontProfitOperatorAssignmentRows,
  type FrontProfitOperatorAssignmentRawRow,
  type FrontProfitOperatorAssignmentRow,
} from "./front-profit-operator-source.js";
import {
  FRONT_PROFIT_PROMOTION_SOURCE_HEADERS,
  normalizeFrontProfitPromotionSourceRows,
  type FrontProfitPromotionSourceRawRow,
  type FrontProfitPromotionSourceRow,
} from "./front-profit-promotion-source.js";
import {
  FRONT_PROFIT_REBATE_SOURCE_HEADERS,
  normalizeFrontProfitRebateSourceRows,
  type FrontProfitRebateSourceRawRow,
  type FrontProfitRebateSourceRow,
} from "./front-profit-rebate-source.js";
import {
  FRONT_PROFIT_SALES_SOURCE_HEADERS,
  FRONT_PROFIT_SALES_AMOUNT_KIND,
  FRONT_PROFIT_SALES_SOURCE_FAMILY,
  FRONT_PROFIT_SALES_SOURCE_VERSION,
  normalizeFrontProfitSalesSourceRows,
  type FrontProfitSalesSourceRawRow,
  type FrontProfitSalesSourceRow,
} from "./front-profit-sales-source.js";
import { FRONT_PROFIT_MONEY_TOLERANCE } from "./front-profit-formula.js";
import {
  FrontProfitBusinessRuleBlockError,
} from "./front-profit-business-rules.js";

export const FRONT_PROFIT_SOURCE_FAMILIES = [
  "operator_assignment",
  "sales_fact",
  "cost_period",
  "cost_usage",
  "rebate",
  "fee_fact",
  "promotion_spend",
] as const;

export type FrontProfitSourceFamily = typeof FRONT_PROFIT_SOURCE_FAMILIES[number];

export type FrontProfitSourceLoaderSqlExecutor = {
  unsafe(query: string, parameters?: unknown[]): PromiseLike<Array<Record<string, unknown>>>;
};

export type FrontProfitSourceLoadErrorCode =
  | "FRONT_PROFIT_SOURCE_NOT_FOUND"
  | "FRONT_PROFIT_SOURCE_NOT_FILE"
  | "FRONT_PROFIT_SOURCE_FAMILY_MISMATCH"
  | "FRONT_PROFIT_SOURCE_TABLE_MISSING"
  | "FRONT_PROFIT_SOURCE_HEADER_MISSING"
  | "FRONT_PROFIT_SOURCE_PERIOD_MISMATCH"
  | "FRONT_PROFIT_MANUAL_BASELINE_UNVALIDATED";

export class FrontProfitSourceLoadError extends Error {
  constructor(
    readonly code: FrontProfitSourceLoadErrorCode,
    message: string,
    readonly payload: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "FrontProfitSourceLoadError";
  }
}

export type FrontProfitSourceRecord = {
  id: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
};

export type FrontProfitNormalizedUfSource =
  | {
    family: "operator_assignment";
    sourceId: number;
    sourceFile: string | null;
    rows: FrontProfitOperatorAssignmentRow[];
  }
  | {
    family: "sales_fact";
    sourceId: number;
    sourceFile: string | null;
    rows: FrontProfitSalesSourceRow[];
  }
  | {
    family: "cost_period";
    sourceId: number;
    sourceFile: string | null;
    rows: FrontProfitCostSourceRow[];
  }
  | {
    family: "cost_usage";
    sourceId: number;
    sourceFile: string | null;
    rows: FrontProfitCostUsageRow[];
  }
  | {
    family: "rebate";
    sourceId: number;
    sourceFile: string | null;
    rows: FrontProfitRebateSourceRow[];
  }
  | {
    family: "fee_fact";
    sourceId: number;
    sourceFile: string | null;
    rows: FrontProfitFeeSourceRow[];
  }
  | {
    family: "promotion_spend";
    sourceId: number;
    sourceFile: string | null;
    rows: FrontProfitPromotionSourceRow[];
  };

export type FrontProfitSqlSideSourceLoadResult = {
  sourceId: number;
  rowCount: number;
  l1RowCount: number;
  reconResultCount: number;
  l1WritePath?: "sql_side_insert";
  phaseTimings?: FrontProfitSqlSideSourceLoadPhaseTiming[];
};

export type FrontProfitSqlSideSourceLoadPhaseTiming = {
  phase: string;
  seconds: number;
};

type FrontProfitUfSqlSpec<Header extends string> = {
  source: FrontProfitSourceRecord;
  sourceFile: string | null;
  tableRef: string;
  columns: Record<Header, string>;
};

type SourceColumn = {
  raw: string;
  name: string;
};

export function canUseFrontProfitSqlSideUfSourceLoad(
  executor: FrontProfitSourceLoaderSqlExecutor,
  family?: "sales_fact" | "cost_usage",
): boolean {
  if (typeof executor !== "function") return false;
  const mode = normalizeText(process.env.FRONT_PROFIT_SQL_SIDE_UF_LOAD);
  if (mode === "0" || mode === "false" || mode === "off") return false;
  if (mode === "1" || mode === "true" || mode === "all") return true;
  if (mode === "sales_fact" || mode === "sales") return family === "sales_fact";
  if (mode === "cost_usage" || mode === "cost") return family === "cost_usage";
  return false;
}

function assertPositiveSafeId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new FrontProfitSourceLoadError(
      "FRONT_PROFIT_SOURCE_NOT_FOUND",
      `${label} must be a positive safe integer`,
      { [label]: value },
    );
  }
  return value;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    return jsonObject(parsed);
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function quoteSqlIdentifier(identifier: string): string {
  if (!identifier || identifier.includes("\0")) {
    throw new FrontProfitSourceLoadError(
      "FRONT_PROFIT_SOURCE_HEADER_MISSING",
      "front-profit source column name is invalid",
      { identifier },
    );
  }
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

function sourceColumns(config: Record<string, unknown>, sourceId: number): SourceColumn[] {
  const columns = Array.isArray(config.columns) ? config.columns : [];
  return columns
    .map((column) => jsonObject(column))
    .map((column) => ({
      raw: normalizeText(column.raw),
      name: normalizeText(column.name),
    }))
    .filter((column) => column.raw && column.name);
}

function sourceFile(source: FrontProfitSourceRecord): string | null {
  const fileName = normalizeText(source.config.originalFileName);
  return fileName || normalizeText(source.name) || null;
}

function assertSourceFamily(
  source: FrontProfitSourceRecord,
  expectedFamily: FrontProfitSourceFamily,
): void {
  const configured = normalizeText(source.config.frontProfitSourceFamily);
  if (!configured) return;
  if (configured !== expectedFamily) {
    throw new FrontProfitSourceLoadError(
      "FRONT_PROFIT_SOURCE_FAMILY_MISMATCH",
      `front-profit source ${source.id} is ${configured}, expected ${expectedFamily}`,
      { sourceId: source.id, configured, expectedFamily },
    );
  }
}

function columnNameByRawHeader(
  source: FrontProfitSourceRecord,
  rawHeader: string,
): string {
  const match = sourceColumns(source.config, source.id)
    .find((column) => column.raw === rawHeader);
  if (!match) {
    throw new FrontProfitSourceLoadError(
      "FRONT_PROFIT_SOURCE_HEADER_MISSING",
      `front-profit source ${source.id} is missing header ${rawHeader}`,
      { sourceId: source.id, header: rawHeader },
    );
  }
  return match.name;
}

export async function readFrontProfitSourceRecord(
  executor: FrontProfitSourceLoaderSqlExecutor,
  sourceId: number,
): Promise<FrontProfitSourceRecord> {
  const id = assertPositiveSafeId(sourceId, "sourceId");
  const [row] = await executor.unsafe(
    `SELECT id, name, type, config
       FROM public.data_sources
      WHERE id = $1
      LIMIT 1`,
    [id],
  );
  if (!row) {
    throw new FrontProfitSourceLoadError(
      "FRONT_PROFIT_SOURCE_NOT_FOUND",
      `front-profit source ${id} does not exist`,
      { sourceId: id },
    );
  }
  const type = normalizeText(row.type);
  if (type !== "file") {
    throw new FrontProfitSourceLoadError(
      "FRONT_PROFIT_SOURCE_NOT_FILE",
      `front-profit source ${id} is not a file source`,
      { sourceId: id, type },
    );
  }
  return {
    id,
    name: normalizeText(row.name),
    type,
    config: jsonObject(row.config),
  };
}

async function readRowsForHeaders<Header extends string>(
  executor: FrontProfitSourceLoaderSqlExecutor,
  input: {
    source: FrontProfitSourceRecord;
    headers: readonly Header[];
  },
): Promise<Array<Partial<Record<Header, unknown>>>> {
  const tableRef = await resolveExistingRuntimeTableReferenceFromSql(
    `${FILE_TABLE_PREFIX}${input.source.id}`,
    executor,
  );
  if (!tableRef) {
    throw new FrontProfitSourceLoadError(
      "FRONT_PROFIT_SOURCE_TABLE_MISSING",
      `front-profit source table uf_${input.source.id} is missing`,
      { sourceId: input.source.id },
    );
  }

  const selectList = input.headers
    .map((header) =>
      `${quoteSqlIdentifier(columnNameByRawHeader(input.source, header))} AS ${quoteSqlIdentifier(header)}`)
    .join(", ");
  const rows = await executor.unsafe(
    `SELECT ${selectList}
       FROM ${tableRef}
      ORDER BY id`,
  );
  return rows as Array<Partial<Record<Header, unknown>>>;
}

async function readUfSqlSpec<Header extends string>(
  executor: FrontProfitSourceLoaderSqlExecutor,
  input: {
    sourceId: number;
    family: FrontProfitSourceFamily;
    headers: readonly Header[];
  },
): Promise<FrontProfitUfSqlSpec<Header>> {
  const source = await readFrontProfitSourceRecord(executor, input.sourceId);
  assertSourceFamily(source, input.family);
  const tableRef = await resolveExistingRuntimeTableReferenceFromSql(
    `${FILE_TABLE_PREFIX}${source.id}`,
    executor,
  );
  if (!tableRef) {
    throw new FrontProfitSourceLoadError(
      "FRONT_PROFIT_SOURCE_TABLE_MISSING",
      `front-profit source table uf_${source.id} is missing`,
      { sourceId: source.id },
    );
  }
  const columns = Object.fromEntries(
    input.headers.map((header) => [
      header,
      quoteSqlIdentifier(columnNameByRawHeader(source, header)),
    ]),
  ) as Record<Header, string>;
  return {
    source,
    sourceFile: sourceFile(source),
    tableRef,
    columns,
  };
}

function jsonbParam(value: Record<string, unknown>): Record<string, unknown> {
  return value;
}

async function upsertSqlSideReconMetric(
  executor: FrontProfitSourceLoaderSqlExecutor,
  input: {
    runId: number;
    layer: string;
    metric: string;
    expected: number;
    actual: number;
    tolerance: number;
    evidenceRef: Record<string, unknown>;
  },
): Promise<void> {
  await executor.unsafe(
    `INSERT INTO public.recon_result
       (run_id, layer, metric, expected, actual, tolerance, passed, evidence_ref)
     VALUES ($1, $2, $3, $4, $5, $6, ABS($5::numeric - $4::numeric) <= $6::numeric, $7::jsonb)
     ON CONFLICT (run_id, layer, metric) DO UPDATE SET
       expected = EXCLUDED.expected,
       actual = EXCLUDED.actual,
       tolerance = EXCLUDED.tolerance,
       passed = EXCLUDED.passed,
       evidence_ref = EXCLUDED.evidence_ref`,
    [
      input.runId,
      input.layer,
      input.metric,
      String(input.expected),
      String(input.actual),
      String(input.tolerance),
      jsonbParam(input.evidenceRef),
    ],
  );
}

export async function normalizeFrontProfitUfSourceRows(
  executor: FrontProfitSourceLoaderSqlExecutor,
  input: {
    runId: number;
    sourceId: number;
    family: FrontProfitSourceFamily;
  },
): Promise<FrontProfitNormalizedUfSource> {
  const source = await readFrontProfitSourceRecord(executor, input.sourceId);
  assertSourceFamily(source, input.family);
  const common = {
    runId: input.runId,
    sourceId: source.id,
    sourceFile: sourceFile(source),
  };

  switch (input.family) {
    case "operator_assignment": {
      const rows = await readRowsForHeaders(executor, {
        source,
        headers: FRONT_PROFIT_OPERATOR_ASSIGNMENT_HEADERS,
      });
      return {
        family: input.family,
        sourceId: source.id,
        sourceFile: common.sourceFile,
        rows: normalizeFrontProfitOperatorAssignmentRows({
          runId: common.runId,
          sourceId: common.sourceId,
          rows: rows as FrontProfitOperatorAssignmentRawRow[],
        }),
      };
    }
    case "sales_fact": {
      const rows = await readRowsForHeaders(executor, {
        source,
        headers: FRONT_PROFIT_SALES_SOURCE_HEADERS,
      });
      return {
        family: input.family,
        sourceId: source.id,
        sourceFile: common.sourceFile,
        rows: normalizeFrontProfitSalesSourceRows({
          ...common,
          rows: rows as FrontProfitSalesSourceRawRow[],
        }),
      };
    }
    case "cost_period": {
      const rows = await readRowsForHeaders(executor, {
        source,
        headers: FRONT_PROFIT_COST_SOURCE_HEADERS,
      });
      return {
        family: input.family,
        sourceId: source.id,
        sourceFile: common.sourceFile,
        rows: normalizeFrontProfitCostSourceRows({
          runId: common.runId,
          sourceId: common.sourceId,
          rows: rows as FrontProfitCostSourceRawRow[],
        }),
      };
    }
    case "cost_usage": {
      const rows = await readRowsForHeaders(executor, {
        source,
        headers: FRONT_PROFIT_COST_USAGE_HEADERS,
      });
      return {
        family: input.family,
        sourceId: source.id,
        sourceFile: common.sourceFile,
        rows: normalizeFrontProfitCostUsageRows({
          ...common,
          rows: rows as FrontProfitCostUsageRawRow[],
        }),
      };
    }
    case "rebate": {
      const rows = await readRowsForHeaders(executor, {
        source,
        headers: FRONT_PROFIT_REBATE_SOURCE_HEADERS,
      });
      return {
        family: input.family,
        sourceId: source.id,
        sourceFile: common.sourceFile,
        rows: normalizeFrontProfitRebateSourceRows({
          ...common,
          rows: rows as FrontProfitRebateSourceRawRow[],
        }),
      };
    }
    case "fee_fact": {
      const rows = await readRowsForHeaders(executor, {
        source,
        headers: FRONT_PROFIT_FEE_SOURCE_HEADERS,
      });
      return {
        family: input.family,
        sourceId: source.id,
        sourceFile: common.sourceFile,
        rows: normalizeFrontProfitFeeSourceRows({
          ...common,
          rows: rows as FrontProfitFeeSourceRawRow[],
        }),
      };
    }
    case "promotion_spend": {
      const rows = await readRowsForHeaders(executor, {
        source,
        headers: FRONT_PROFIT_PROMOTION_SOURCE_HEADERS,
      });
      return {
        family: input.family,
        sourceId: source.id,
        sourceFile: common.sourceFile,
        rows: normalizeFrontProfitPromotionSourceRows({
          ...common,
          rows: rows as FrontProfitPromotionSourceRawRow[],
        }),
      };
    }
  }
}

function sourceMetric(sourceId: number, metric: string): string {
  return `source_${sourceId}_${metric}`;
}

async function hasFrontProfitL1RowsForSource(
  executor: FrontProfitSourceLoaderSqlExecutor,
  input: {
    runId: number;
    sourceFamily: string;
  },
): Promise<boolean> {
  const [row] = await executor.unsafe(
    `SELECT 1
       FROM public.front_profit_l1_source_row
      WHERE run_id = $1 AND source_family = $2
      LIMIT 1`,
    [input.runId, input.sourceFamily],
  );
  return row != null;
}

function l1ConflictUpdateSql(): string {
  return `ON CONFLICT (run_id, source_family, source_record_key, amount_kind) DO UPDATE SET
              source_id = EXCLUDED.source_id,
              source_row_no = EXCLUDED.source_row_no,
              period = EXCLUDED.period,
              event_date = EXCLUDED.event_date,
              platform = EXCLUDED.platform,
              shop = EXCLUDED.shop,
              operator_key = EXCLUDED.operator_key,
              sku_key = EXCLUDED.sku_key,
              amount_value = EXCLUDED.amount_value,
              quantity = EXCLUDED.quantity,
              currency = EXCLUDED.currency,
              row_payload = EXCLUDED.row_payload`;
}

function textExpr(column: string): string {
  return `BTRIM(${column})`;
}

function nullableTextExpr(column: string): string {
  return `NULLIF(BTRIM(${column}), '')`;
}

function requiredNumericExpr(column: string): string {
  return `BTRIM(${column})::numeric`;
}

function optionalNumericZeroExpr(column: string): string {
  return `COALESCE(NULLIF(BTRIM(${column}), '')::numeric, 0)`;
}

function dateIssueSql(dateAlias: string, periodParameter = "$3"): string {
  return `${dateAlias} !~ '^\\d{4}-\\d{2}-\\d{2}$' OR SUBSTRING(${dateAlias} FROM 1 FOR 7) <> ${periodParameter}`;
}

async function assertNoSqlSideIssues(
  issues: Array<Record<string, unknown>>,
  evidence: Record<string, unknown>,
): Promise<void> {
  if (issues.length === 0) return;
  const firstCode = String(issues[0]?.code ?? "");
  const code: FrontProfitBusinessRuleBlockError["code"] = firstCode === "OWNER_AMBIGUOUS"
    ? "OWNER_AMBIGUOUS"
    : firstCode === "COST_PERIOD_OVERLAP"
      ? "COST_PERIOD_OVERLAP"
      : firstCode === "COST_PERIOD_MISSING"
        ? "COST_PERIOD_MISSING"
        : "OWNER_MISSING";
  throw new FrontProfitBusinessRuleBlockError(code, {
    ...evidence,
    issues,
  });
}

async function recordSqlSidePhase<T>(
  phaseTimings: FrontProfitSqlSideSourceLoadPhaseTiming[],
  phase: string,
  action: () => PromiseLike<T> | T,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await action();
  } finally {
    phaseTimings.push({
      phase,
      seconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
    });
  }
}

export async function loadFrontProfitSalesUfSourceToL1SqlSide(
  executor: FrontProfitSourceLoaderSqlExecutor,
  input: {
    runId: number;
    period: string;
    sourceId: number;
  },
): Promise<FrontProfitSqlSideSourceLoadResult> {
  const spec = await readUfSqlSpec(executor, {
    sourceId: input.sourceId,
    family: "sales_fact",
    headers: FRONT_PROFIT_SALES_SOURCE_HEADERS,
  });
  const sourceStage = `front_profit_sales_sql_source_stage_${input.runId}_${spec.source.id}`;
  const candidateStage = `front_profit_sales_sql_candidate_stage_${input.runId}_${spec.source.id}`;
  const phaseTimings: FrontProfitSqlSideSourceLoadPhaseTiming[] = [];
  const c = spec.columns;
  const sourceRowsSql = `
    SELECT (ROW_NUMBER() OVER (ORDER BY id) + 1)::int AS source_row_no,
           ${textExpr(c["销售ID"])} AS sale_key,
           ${textExpr(c["销售日期"])} AS sale_date,
           ${textExpr(c["平台"])} AS platform,
           ${textExpr(c["业务模式"])} AS business_mode,
           ${nullableTextExpr(c["组"])} AS group_name,
           ${textExpr(c["店铺"])} AS shop,
           ${nullableTextExpr(c["店铺2"])} AS shop_normalized,
           ${nullableTextExpr(c.SKU)} AS sku_key,
           ${nullableTextExpr(c["广告账户"])} AS ad_account_key,
           ${nullableTextExpr(c["产品负责人"])} AS product_owner_key,
           ${nullableTextExpr(c["订单负责人"])} AS order_owner_key,
           ${nullableTextExpr(c["手工映射键"])} AS manual_mapping_key,
           ${requiredNumericExpr(c["单量"])} AS quantity,
           ${requiredNumericExpr(c.GMV)} AS gmv,
           ${optionalNumericZeroExpr(c["出货货值"])} AS shipment_value,
           ${nullableTextExpr(c["来源批次"])} AS source_batch,
           ${nullableTextExpr(c["备注"])} AS note
      FROM ${spec.tableRef}`;
  await recordSqlSidePhase(phaseTimings, "source_stage", async () => {
    await executor.unsafe(`CREATE TEMP TABLE ${sourceStage} ON COMMIT DROP AS ${sourceRowsSql}`);
    await executor.unsafe(`CREATE INDEX ON ${sourceStage} (source_row_no)`);
    await executor.unsafe(`ANALYZE ${sourceStage}`);
  });

  const candidateSql = `
    SELECT s.*,
           key.priority,
           key.authority_key_type,
           key.authority_key,
           oa.operator,
           oa.effective_from
      FROM ${sourceStage} s
      CROSS JOIN LATERAL (
        VALUES
          ('sku'::text, 1, s.sku_key),
          ('ad_account'::text, 2, s.ad_account_key),
          ('product_owner'::text, 3, s.product_owner_key),
          ('order_owner'::text, 4, s.order_owner_key),
          ('manual_mapping'::text, 5, s.manual_mapping_key)
      ) AS key(authority_key_type, priority, authority_key)
      JOIN public.front_profit_operator_assignment oa
        ON oa.run_id = $1
       AND oa.shop = s.shop
       AND oa.authority_key_type = key.authority_key_type
       AND oa.authority_key = key.authority_key
       AND oa.effective_from <= s.sale_date
       AND s.sale_date <= oa.effective_to
     WHERE key.authority_key IS NOT NULL`;

  const dateIssues = await recordSqlSidePhase(phaseTimings, "date_validate", () =>
    executor.unsafe(
      `SELECT source_row_no AS "sourceRowNo",
            sale_date AS "date",
            'FRONT_PROFIT_SOURCE_PERIOD_MISMATCH' AS code
       FROM ${sourceStage}
      WHERE ${dateIssueSql("sale_date", "$1")}
      ORDER BY source_row_no
      LIMIT 20`,
      [input.period],
    ),
  );
  if (dateIssues.length > 0) {
    throw new FrontProfitSourceLoadError(
      "FRONT_PROFIT_SOURCE_PERIOD_MISMATCH",
      `front-profit sales_fact source has rows outside ${input.period}`,
      { sourceId: spec.source.id, period: input.period, issues: dateIssues },
    );
  }
  await recordSqlSidePhase(phaseTimings, "candidate_stage", async () => {
    await executor.unsafe(`CREATE TEMP TABLE ${candidateStage} ON COMMIT DROP AS ${candidateSql}`, [input.runId]);
    await executor.unsafe(`CREATE INDEX ON ${candidateStage} (source_row_no, priority)`);
    await executor.unsafe(`ANALYZE ${candidateStage}`);
  });

  const ownerIssues = await recordSqlSidePhase(phaseTimings, "owner_validate", () =>
    executor.unsafe(
      `WITH best_priority AS (
            SELECT source_row_no, MIN(priority) AS priority
              FROM ${candidateStage}
             GROUP BY source_row_no
          ),
          best_matches AS (
            SELECT c.*
              FROM ${candidateStage} c
              JOIN best_priority bp
                ON bp.source_row_no = c.source_row_no
               AND bp.priority = c.priority
          ),
          issues AS (
            SELECT s.source_row_no AS "sourceRowNo",
                   'OWNER_MISSING' AS code,
                   jsonb_build_object('shop', s.shop, 'date', s.sale_date) AS evidence
              FROM ${sourceStage} s
              LEFT JOIN best_priority bp ON bp.source_row_no = s.source_row_no
             WHERE bp.source_row_no IS NULL
            UNION ALL
            SELECT bm.source_row_no AS "sourceRowNo",
                   'OWNER_AMBIGUOUS' AS code,
                   jsonb_build_object(
                     'shop', MIN(bm.shop),
                     'date', MIN(bm.sale_date),
                     'authorityKeyType', MIN(bm.authority_key_type),
                     'authorityKey', MIN(bm.authority_key),
                     'operators', jsonb_agg(DISTINCT bm.operator)
                   ) AS evidence
              FROM best_matches bm
             GROUP BY bm.source_row_no
            HAVING COUNT(*) > 1
          )
     SELECT * FROM issues ORDER BY "sourceRowNo" LIMIT 20`,
      [],
    ),
  );
  await assertNoSqlSideIssues(ownerIssues, {
    sourceId: spec.source.id,
    period: input.period,
    sourceFamily: FRONT_PROFIT_SALES_SOURCE_FAMILY,
  });

  const [inserted] = await recordSqlSidePhase(phaseTimings, "l1_upsert", async () => {
    const hasExistingL1Rows = await hasFrontProfitL1RowsForSource(executor, {
      runId: input.runId,
      sourceFamily: FRONT_PROFIT_SALES_SOURCE_FAMILY,
    });
    return executor.unsafe(
      `WITH ranked AS (
            SELECT *,
                   ROW_NUMBER() OVER (
                     PARTITION BY source_row_no
                     ORDER BY priority, effective_from, operator
                   ) AS rn
              FROM ${candidateStage}
          ),
          resolved AS (
            SELECT s.*, r.operator, r.authority_key_type, r.authority_key
              FROM ${sourceStage} s
              JOIN ranked r
                ON r.source_row_no = s.source_row_no
               AND r.rn = 1
          ),
          upserted AS (
            INSERT INTO public.front_profit_l1_source_row
              (run_id, source_id, source_row_no, period, source_family, source_record_key,
               event_date, platform, shop, operator_key, sku_key, amount_kind, amount_value,
               quantity, currency, row_payload)
            SELECT $1::bigint,
                   $2::bigint,
                   source_row_no,
                   $3::varchar,
                   $4::varchar,
                   sale_key,
                   sale_date,
                   platform,
                   shop,
                   operator,
                   sku_key,
                   $5::varchar,
                   gmv,
                   quantity,
                   'CNY',
                   jsonb_build_object(
                     'sourceContractVersion', $6::text,
                     'sourceFile', $7::text,
                     'sourceBatch', source_batch,
                     'businessMode', business_mode,
                     'groupName', group_name,
                     'shopNormalized', shop_normalized,
                     'adAccountKey', ad_account_key,
                     'productOwnerKey', product_owner_key,
                     'orderOwnerKey', order_owner_key,
                     'manualMappingKey', manual_mapping_key,
                     'matchedAuthorityKeyType', authority_key_type,
                     'matchedAuthorityKey', authority_key,
                     'detailKey', CONCAT('sales:', sale_key),
                     'recordId', CONCAT('SALES_L3_', sale_key),
                     'calculationRole', 'sales_contribution',
                     'quantity', quantity,
                     'gmv', gmv,
                     'sales_gmv', gmv,
                     'shipment_value', shipment_value,
                     'sales_shipment_value', shipment_value,
                     'note', note
                    )
              FROM resolved
            ${hasExistingL1Rows ? l1ConflictUpdateSql() : ""}
            RETURNING 1
          )
     SELECT COUNT(*)::int AS row_count FROM upserted`,
      [
        input.runId,
        spec.source.id,
        input.period,
        FRONT_PROFIT_SALES_SOURCE_FAMILY,
        FRONT_PROFIT_SALES_AMOUNT_KIND,
        FRONT_PROFIT_SALES_SOURCE_VERSION,
        spec.sourceFile,
      ],
    );
  });

  const reconMetricsStartedAt = Date.now();
  const [expected] = await executor.unsafe(
    `SELECT COUNT(*)::int AS row_count,
            COALESCE(SUM(quantity), 0)::float8 AS quantity,
            COALESCE(SUM(gmv), 0)::float8 AS gmv,
            COALESCE(SUM(shipment_value), 0)::float8 AS shipment_value
       FROM ${sourceStage}`,
    [],
  );
  const [actual] = await executor.unsafe(
    `SELECT COUNT(*)::int AS row_count,
            COALESCE(SUM((row_payload->>'quantity')::numeric), 0)::float8 AS quantity,
            COALESCE(SUM((row_payload->>'sales_gmv')::numeric), 0)::float8 AS gmv,
            COALESCE(SUM((row_payload->>'sales_shipment_value')::numeric), 0)::float8 AS shipment_value
       FROM public.front_profit_l1_source_row
      WHERE run_id = $1 AND period = $2 AND source_id = $3 AND source_family = $4`,
    [input.runId, input.period, spec.source.id, FRONT_PROFIT_SALES_SOURCE_FAMILY],
  );
  const reconFields = [
    ["row_count", Number(expected?.row_count ?? 0), Number(actual?.row_count ?? 0), 0],
    ["quantity_sum", Number(expected?.quantity ?? 0), Number(actual?.quantity ?? 0), FRONT_PROFIT_MONEY_TOLERANCE],
    ["gmv_sum", Number(expected?.gmv ?? 0), Number(actual?.gmv ?? 0), FRONT_PROFIT_MONEY_TOLERANCE],
    [
      "shipment_value_sum",
      Number(expected?.shipment_value ?? 0),
      Number(actual?.shipment_value ?? 0),
      FRONT_PROFIT_MONEY_TOLERANCE,
    ],
  ] as const;
  for (const [metric, expectedValue, actualValue, tolerance] of reconFields) {
    await upsertSqlSideReconMetric(executor, {
      runId: input.runId,
      layer: "SALES_SOURCE_L1",
      metric: sourceMetric(spec.source.id, metric),
      expected: expectedValue,
      actual: actualValue,
      tolerance,
      evidenceRef: {
        sourceId: spec.source.id,
        period: input.period,
        sourceFamily: FRONT_PROFIT_SALES_SOURCE_FAMILY,
        sourceContractVersion: FRONT_PROFIT_SALES_SOURCE_VERSION,
        loadPath: "sql_side_uf_to_l1",
      },
    });
  }
  phaseTimings.push({
    phase: "recon_metrics",
    seconds: Number(((Date.now() - reconMetricsStartedAt) / 1000).toFixed(3)),
  });

  return {
    sourceId: spec.source.id,
    rowCount: Number(expected?.row_count ?? 0),
    l1RowCount: Number(inserted?.row_count ?? 0),
    reconResultCount: reconFields.length,
    phaseTimings,
  };
}

export async function loadFrontProfitCostUsageUfSourceToL1SqlSide(
  executor: FrontProfitSourceLoaderSqlExecutor,
  input: {
    runId: number;
    period: string;
    sourceId: number;
  },
): Promise<FrontProfitSqlSideSourceLoadResult> {
  const spec = await readUfSqlSpec(executor, {
    sourceId: input.sourceId,
    family: "cost_usage",
    headers: FRONT_PROFIT_COST_USAGE_HEADERS,
  });
  const sourceStage = `front_profit_cost_sql_source_stage_${input.runId}_${spec.source.id}`;
  const candidateStage = `front_profit_cost_sql_candidate_stage_${input.runId}_${spec.source.id}`;
  const phaseTimings: FrontProfitSqlSideSourceLoadPhaseTiming[] = [];
  const c = spec.columns;
  const sourceRowsSql = `
    SELECT (ROW_NUMBER() OVER (ORDER BY id) + 1)::int AS source_row_no,
           ${textExpr(c["出货ID"])} AS shipment_key,
           ${textExpr(c["发货日期"])} AS shipment_date,
           ${textExpr(c["平台"])} AS platform,
           ${textExpr(c["业务模式"])} AS business_mode,
           ${nullableTextExpr(c["组"])} AS group_name,
           ${textExpr(c["店铺"])} AS shop,
           ${nullableTextExpr(c["店铺2"])} AS shop_normalized,
           ${textExpr(c["运营"])} AS operator_key,
           ${textExpr(c.SKU)} AS sku_key,
           ${requiredNumericExpr(c["出货数量"])} AS quantity,
           ${optionalNumericZeroExpr(c["出货货值"])} AS shipment_value,
           ${nullableTextExpr(c["来源批次"])} AS source_batch,
           ${nullableTextExpr(c["备注"])} AS note
      FROM ${spec.tableRef}`;
  const candidateSql = `
    SELECT s.*,
           cp.unit_cost,
           cp.effective_from,
           cp.effective_to
      FROM ${sourceStage} s
      JOIN public.front_profit_cost_period cp
        ON cp.run_id = $1
       AND cp.sku_key = s.sku_key
       AND cp.cost_kind = 'product_cost'
       AND cp.effective_from <= s.shipment_date
       AND s.shipment_date <= cp.effective_to`;
  await recordSqlSidePhase(phaseTimings, "source_stage", async () => {
    await executor.unsafe(`CREATE TEMP TABLE ${sourceStage} ON COMMIT DROP AS ${sourceRowsSql}`);
    await executor.unsafe(`CREATE INDEX ON ${sourceStage} (source_row_no)`);
    await executor.unsafe(`CREATE INDEX ON ${sourceStage} (sku_key, shipment_date)`);
    await executor.unsafe(`ANALYZE ${sourceStage}`);
  });

  const dateIssues = await recordSqlSidePhase(phaseTimings, "date_validate", () =>
    executor.unsafe(
      `SELECT source_row_no AS "sourceRowNo",
            shipment_date AS "date",
            'FRONT_PROFIT_SOURCE_PERIOD_MISMATCH' AS code
       FROM ${sourceStage}
      WHERE ${dateIssueSql("shipment_date", "$1")}
      ORDER BY source_row_no
      LIMIT 20`,
      [input.period],
    ),
  );
  if (dateIssues.length > 0) {
    throw new FrontProfitSourceLoadError(
      "FRONT_PROFIT_SOURCE_PERIOD_MISMATCH",
      `front-profit cost_usage source has rows outside ${input.period}`,
      { sourceId: spec.source.id, period: input.period, issues: dateIssues },
    );
  }
  await recordSqlSidePhase(phaseTimings, "candidate_stage", async () => {
    await executor.unsafe(`CREATE TEMP TABLE ${candidateStage} ON COMMIT DROP AS ${candidateSql}`, [input.runId]);
    await executor.unsafe(`CREATE INDEX ON ${candidateStage} (source_row_no)`);
    await executor.unsafe(`ANALYZE ${candidateStage}`);
  });

  const costIssues = await recordSqlSidePhase(phaseTimings, "cost_validate", () =>
    executor.unsafe(
      `WITH issues AS (
            SELECT s.source_row_no AS "sourceRowNo",
                   'COST_PERIOD_MISSING' AS code,
                   jsonb_build_object(
                     'skuKey', s.sku_key,
                     'shipmentDate', s.shipment_date,
                     'costKind', 'product_cost'
                   ) AS evidence
              FROM ${sourceStage} s
              LEFT JOIN ${candidateStage} c ON c.source_row_no = s.source_row_no
             WHERE c.source_row_no IS NULL
            UNION ALL
            SELECT c.source_row_no AS "sourceRowNo",
                   'COST_PERIOD_OVERLAP' AS code,
                   jsonb_build_object(
                     'skuKey', MIN(c.sku_key),
                     'shipmentDate', MIN(c.shipment_date),
                     'costKind', 'product_cost',
                     'matches', jsonb_agg(jsonb_build_object(
                       'effectiveFrom', c.effective_from,
                       'effectiveTo', c.effective_to
                     ))
                   ) AS evidence
              FROM ${candidateStage} c
             GROUP BY c.source_row_no
            HAVING COUNT(*) > 1
          )
     SELECT * FROM issues ORDER BY "sourceRowNo" LIMIT 20`,
      [],
    ),
  );
  await assertNoSqlSideIssues(costIssues, {
    sourceId: spec.source.id,
    period: input.period,
    sourceFamily: FRONT_PROFIT_COST_APPLIED_SOURCE_FAMILY,
  });

  const [inserted] = await recordSqlSidePhase(phaseTimings, "l1_upsert", async () => {
    const hasExistingL1Rows = await hasFrontProfitL1RowsForSource(executor, {
      runId: input.runId,
      sourceFamily: FRONT_PROFIT_COST_APPLIED_SOURCE_FAMILY,
    });
    return executor.unsafe(
      `WITH resolved AS (
            SELECT *,
                   (quantity * unit_cost) AS product_cost
              FROM ${candidateStage}
          ),
          upserted AS (
            INSERT INTO public.front_profit_l1_source_row
              (run_id, source_id, source_row_no, period, source_family, source_record_key,
               event_date, platform, shop, operator_key, sku_key, amount_kind, amount_value,
               quantity, currency, row_payload)
            SELECT $1::bigint,
                   $2::bigint,
                   source_row_no,
                   $3::varchar,
                   $4::varchar,
                   shipment_key,
                   shipment_date,
                   platform,
                   shop,
                   operator_key,
                   sku_key,
                   $5::varchar,
                   product_cost,
                   0,
                   'CNY',
                   jsonb_build_object(
                     'sourceContractVersion', $6::text,
                     'sourceFile', $7::text,
                     'sourceBatch', source_batch,
                     'unitCost', unit_cost,
                     'costEffectiveFrom', effective_from,
                     'costEffectiveTo', effective_to,
                     'businessMode', business_mode,
                     'groupName', group_name,
                     'shopNormalized', shop_normalized,
                     'detailKey', CONCAT('cost:', shipment_key),
                     'recordId', CONCAT('COST_L3_', shipment_key),
                     'calculationRole', 'product_cost_contribution',
                     'product_cost', product_cost,
                     'shipment_value', 0,
                     'note', note
                   )
              FROM resolved
            ${hasExistingL1Rows ? l1ConflictUpdateSql() : ""}
            RETURNING 1
          )
     SELECT COUNT(*)::int AS row_count FROM upserted`,
      [
        input.runId,
        spec.source.id,
        input.period,
        FRONT_PROFIT_COST_APPLIED_SOURCE_FAMILY,
        FRONT_PROFIT_COST_APPLIED_AMOUNT_KIND,
        FRONT_PROFIT_COST_SOURCE_VERSION,
        spec.sourceFile,
      ],
    );
  });

  const reconMetricsStartedAt = Date.now();
  const [expected] = await executor.unsafe(
    `SELECT COUNT(*)::int AS row_count,
            COALESCE(SUM(quantity * unit_cost), 0)::float8 AS product_cost
       FROM ${candidateStage}`,
    [],
  );
  const [actual] = await executor.unsafe(
    `SELECT COUNT(*)::int AS row_count,
            COALESCE(SUM((row_payload->>'product_cost')::numeric), 0)::float8 AS product_cost
       FROM public.front_profit_l1_source_row
      WHERE run_id = $1 AND period = $2 AND source_id = $3 AND source_family = $4`,
    [input.runId, input.period, spec.source.id, FRONT_PROFIT_COST_APPLIED_SOURCE_FAMILY],
  );
  const reconFields = [
    ["row_count", Number(expected?.row_count ?? 0), Number(actual?.row_count ?? 0), 0],
    [
      "product_cost_sum",
      Number(expected?.product_cost ?? 0),
      Number(actual?.product_cost ?? 0),
      FRONT_PROFIT_MONEY_TOLERANCE,
    ],
  ] as const;
  for (const [metric, expectedValue, actualValue, tolerance] of reconFields) {
    await upsertSqlSideReconMetric(executor, {
      runId: input.runId,
      layer: "COST_APPLIED_L1",
      metric: sourceMetric(spec.source.id, metric),
      expected: expectedValue,
      actual: actualValue,
      tolerance,
      evidenceRef: {
        sourceId: spec.source.id,
        period: input.period,
        sourceFamily: FRONT_PROFIT_COST_APPLIED_SOURCE_FAMILY,
        sourceContractVersion: FRONT_PROFIT_COST_SOURCE_VERSION,
        loadPath: "sql_side_uf_to_l1",
      },
    });
  }
  phaseTimings.push({
    phase: "recon_metrics",
    seconds: Number(((Date.now() - reconMetricsStartedAt) / 1000).toFixed(3)),
  });

  return {
    sourceId: spec.source.id,
    rowCount: Number(expected?.row_count ?? 0),
    l1RowCount: Number(inserted?.row_count ?? 0),
    reconResultCount: reconFields.length,
    phaseTimings,
  };
}

function cell(row: Record<string, unknown>, header: string): string {
  return normalizeText(row[header]);
}

function standardRowToL4(row: Record<string, unknown>): FrontProfitL4AggRowForContract {
  return {
    date: cell(row, "日期"),
    platform: cell(row, "平台"),
    businessMode: cell(row, "业务模式"),
    groupName: cell(row, "组") || null,
    shop: cell(row, "店铺"),
    shopNormalized: cell(row, "店铺2") || null,
    operator: cell(row, "运营"),
    quantity: cell(row, "单量"),
    gmv: cell(row, "GMV"),
    fillOrderAmount: cell(row, "补单金额"),
    fillOrderProductCost: cell(row, "补单产品成本"),
    fillOrderQuantity: cell(row, "补单单量"),
    productCost: cell(row, "产品成本"),
    shipmentValue: cell(row, "出货货值"),
    platformFee: cell(row, "平台扣点/毛保"),
    taxFee: cell(row, "税点"),
    financeCost: cell(row, "财务成本"),
    freight: cell(row, "运费"),
    commission: cell(row, "佣金"),
    promotionFee: cell(row, "推广费"),
    sourceFile: cell(row, "来源文件") || null,
    sourceBatch: cell(row, "来源批次") || null,
    note: cell(row, "备注") || null,
    realRevenue: cell(row, "真实营业额"),
    frontProfit: cell(row, "前台利润"),
    paidRatio: cell(row, "付费占比"),
    recordId: cell(row, "record_id"),
    dataStatus: cell(row, "数据状态") || null,
  };
}

export async function readFrontProfitManualBaselineRowsFromUf(
  executor: FrontProfitSourceLoaderSqlExecutor,
  input: {
    sourceId: number;
  },
): Promise<FrontProfitL4AggRowForContract[]> {
  const source = await readFrontProfitSourceRecord(executor, input.sourceId);
  if (!isValidatedFrontProfitSourceConfig(source.config)) {
    throw new FrontProfitSourceLoadError(
      "FRONT_PROFIT_MANUAL_BASELINE_UNVALIDATED",
      `front-profit manual baseline source ${source.id} has no validated standard contract`,
      { sourceId: source.id },
    );
  }
  const rows = await readRowsForHeaders(executor, {
    source,
    headers: FRONT_PROFIT_STANDARD_HEADERS,
  });
  const dataRows = rows.map((row) =>
    FRONT_PROFIT_STANDARD_HEADERS.map((header) => (row as Record<string, unknown>)[header] ?? ""));
  canonicalRowsContract({
    headers: FRONT_PROFIT_STANDARD_HEADERS,
    dataRows,
    firstDataRowNumber: 2,
  });
  return rows.map((row) => standardRowToL4(row as Record<string, unknown>));
}
