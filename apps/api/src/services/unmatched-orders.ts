import { sql } from "../db/client";

type SqlExecutor = {
  unsafe(query: string, params?: any[]): Promise<any[]>;
};

export interface UnmatchedOrdersDependencies {
  executor: SqlExecutor;
  resolveTableReference: () => Promise<string | null>;
}

export type UnmatchedReason = "missing_product_id" | "brand_dict_key_not_found";

export type UnmatchedOrderSample = {
  reason: UnmatchedReason;
  platform: string;
  productId: string;
  sourceFile: string;
  rows: number;
  amount: number;
  sampleOrderNo: string;
};

export type UnmatchedOrdersResult = {
  summary: {
    totalRows: number;
    matchedRows: number;
    unmatchedRows: number;
    unmatchedAmount: number;
    matchRate: number;
  };
  byPlatform: Array<{
    platform: string;
    totalRows: number;
    unmatchedRows: number;
    unmatchedAmount: number;
    unmatchedRate: number;
  }>;
  reasons: Array<{
    code: UnmatchedReason;
    label: string;
    description: string;
    rows: number;
    amount: number;
  }>;
  samples: UnmatchedOrderSample[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
  empty: boolean;
};

export function classifyUnmatchedReason(productId: unknown): UnmatchedReason {
  return productId == null || String(productId).trim() === ""
    ? "missing_product_id"
    : "brand_dict_key_not_found";
}

export class InvalidUnmatchedPaginationError extends Error {}

export function normalizeUnmatchedPagination(input: {
  limit?: string | number;
  offset?: string | number;
}): { limit: number; offset: number } {
  const limit = input.limit == null ? 50 : Number(input.limit);
  const offset = input.offset == null ? 0 : Number(input.offset);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new InvalidUnmatchedPaginationError("limit 必须是正整数");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new InvalidUnmatchedPaginationError("offset 必须是非负整数");
  }
  return { limit: Math.min(limit, 200), offset };
}

const reasonDetails: Record<
  UnmatchedReason,
  { label: string; description: string }
> = {
  missing_product_id: {
    label: "商品 ID 为空",
    description: "订单源文件中的关联商品 ID 为空，无法查询品牌维护表。",
  },
  brand_dict_key_not_found: {
    label: "维护表未找到商品 ID",
    description: "订单已有商品 ID，但品牌维护表尚未维护对应键；这不是当前 ETL 字段映射错误。",
  },
};

const emptyResult = (limit: number, offset: number): UnmatchedOrdersResult => ({
  summary: {
    totalRows: 0,
    matchedRows: 0,
    unmatchedRows: 0,
    unmatchedAmount: 0,
    matchRate: 0,
  },
  byPlatform: [],
  reasons: (Object.keys(reasonDetails) as UnmatchedReason[]).map((code) => ({
    code,
    ...reasonDetails[code],
    rows: 0,
    amount: 0,
  })),
  samples: [],
  pagination: { limit, offset, total: 0 },
  empty: true,
});

const numberValue = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const percent = (part: number, total: number): number =>
  total > 0 ? Number(((part / total) * 100).toFixed(2)) : 0;

const normalizedPlatform = "COALESCE(platform, '(未知平台)')";
const normalizedProductId = "COALESCE(NULLIF(BTRIM(product_id), ''), '')";
const normalizedSourceFile = "COALESCE(source_file, '')";
const reasonCase = `CASE
  WHEN NULLIF(BTRIM(product_id), '') IS NULL THEN 'missing_product_id'
  ELSE 'brand_dict_key_not_found'
END`;

export const UNMATCHED_SAMPLE_GROUP_BY =
  `${normalizedPlatform}, ${normalizedProductId}, ${normalizedSourceFile}, ${reasonCase}`;
export const UNMATCHED_SAMPLE_ORDER_BY =
  "rows DESC, amount DESC, platform, product_id, source_file, reason";

export async function resolveUnifiedSalesTableReference(
  executor: SqlExecutor = sql,
): Promise<string | null> {
  const rows = await executor.unsafe(
    "SELECT to_regclass($1)::text AS relation",
    ["public.unified_sales"],
  );
  return rows[0]?.relation ? '"public"."unified_sales"' : null;
}

const defaultDependencies = (): UnmatchedOrdersDependencies => ({
  executor: sql,
  resolveTableReference: () => resolveUnifiedSalesTableReference(sql),
});

async function querySamples(
  executor: SqlExecutor,
  tableRef: string,
  pagination?: { limit: number; offset: number },
): Promise<UnmatchedOrderSample[]> {
  const pagingSql = pagination ? " LIMIT $1 OFFSET $2" : "";
  const params = pagination ? [pagination.limit, pagination.offset] : [];
  const rows = (await executor.unsafe(
    `SELECT
       ${reasonCase} AS reason,
       ${normalizedPlatform} AS platform,
       ${normalizedProductId} AS product_id,
       ${normalizedSourceFile} AS source_file,
       COUNT(*)::int AS rows,
       COALESCE(SUM(amount), 0)::numeric AS amount,
       COALESCE(MIN(main_order_no), '') AS sample_order_no
     FROM ${tableRef}
     WHERE COALESCE(matched, false) = false
     GROUP BY ${UNMATCHED_SAMPLE_GROUP_BY}
     ORDER BY ${UNMATCHED_SAMPLE_ORDER_BY}${pagingSql}`,
    params,
  )) as any[];

  return rows.map((row) => ({
    reason: row.reason as UnmatchedReason,
    platform: String(row.platform),
    productId: String(row.product_id),
    sourceFile: String(row.source_file),
    rows: numberValue(row.rows),
    amount: numberValue(row.amount),
    sampleOrderNo: String(row.sample_order_no),
  }));
}

export async function getUnmatchedOrders(
  paginationInput: { limit?: string | number; offset?: string | number } = {},
  dependencies: UnmatchedOrdersDependencies = defaultDependencies(),
): Promise<UnmatchedOrdersResult> {
  const pagination = normalizeUnmatchedPagination(paginationInput);
  const tableRef = await dependencies.resolveTableReference();
  if (!tableRef) return emptyResult(pagination.limit, pagination.offset);
  const executor = dependencies.executor;

  const [overviewRows, platformRows, reasonRows, countRows, samples] = await Promise.all([
    executor.unsafe(
      `SELECT
         COUNT(*)::int AS total_rows,
         COUNT(*) FILTER (WHERE matched = true)::int AS matched_rows,
         COUNT(*) FILTER (WHERE COALESCE(matched, false) = false)::int AS unmatched_rows,
         COALESCE(SUM(amount) FILTER (WHERE COALESCE(matched, false) = false), 0)::numeric AS unmatched_amount
       FROM ${tableRef}`,
    ),
    executor.unsafe(
      `SELECT
         COALESCE(platform, '(未知平台)') AS platform,
         COUNT(*)::int AS total_rows,
         COUNT(*) FILTER (WHERE COALESCE(matched, false) = false)::int AS unmatched_rows,
         COALESCE(SUM(amount) FILTER (WHERE COALESCE(matched, false) = false), 0)::numeric AS unmatched_amount
       FROM ${tableRef}
       GROUP BY platform
       HAVING COUNT(*) FILTER (WHERE COALESCE(matched, false) = false) > 0
       ORDER BY unmatched_rows DESC, unmatched_amount DESC`,
    ),
    executor.unsafe(
      `SELECT
         ${reasonCase} AS reason,
         COUNT(*)::int AS rows,
         COALESCE(SUM(amount), 0)::numeric AS amount
       FROM ${tableRef}
       WHERE COALESCE(matched, false) = false
       GROUP BY ${reasonCase}`,
    ),
    executor.unsafe(
      `SELECT COUNT(*)::int AS total FROM (
         SELECT 1
         FROM ${tableRef}
         WHERE COALESCE(matched, false) = false
         GROUP BY ${UNMATCHED_SAMPLE_GROUP_BY}
       ) grouped_samples`,
    ),
    querySamples(executor, tableRef, pagination),
  ]);

  const overview = (overviewRows as any[])[0] ?? {};
  const totalRows = numberValue(overview.total_rows);
  const matchedRows = numberValue(overview.matched_rows);
  const unmatchedRows = numberValue(overview.unmatched_rows);
  const reasonMap = new Map(
    (reasonRows as any[]).map((row) => [
      row.reason as UnmatchedReason,
      { rows: numberValue(row.rows), amount: numberValue(row.amount) },
    ]),
  );

  return {
    summary: {
      totalRows,
      matchedRows,
      unmatchedRows,
      unmatchedAmount: numberValue(overview.unmatched_amount),
      matchRate: percent(matchedRows, totalRows),
    },
    byPlatform: (platformRows as any[]).map((row) => {
      const platformTotal = numberValue(row.total_rows);
      const platformUnmatched = numberValue(row.unmatched_rows);
      return {
        platform: String(row.platform),
        totalRows: platformTotal,
        unmatchedRows: platformUnmatched,
        unmatchedAmount: numberValue(row.unmatched_amount),
        unmatchedRate: percent(platformUnmatched, platformTotal),
      };
    }),
    reasons: (Object.keys(reasonDetails) as UnmatchedReason[]).map((code) => ({
      code,
      ...reasonDetails[code],
      rows: reasonMap.get(code)?.rows ?? 0,
      amount: reasonMap.get(code)?.amount ?? 0,
    })),
    samples,
    pagination: {
      ...pagination,
      total: numberValue((countRows as any[])[0]?.total),
    },
    empty: totalRows === 0,
  };
}

const CSV_FORMULA_PREFIX = /^[\s\u0000-\u001f\u007f]*[=+@-]/u;
const CSV_DANGEROUS_CONTROL_PREFIX = /^[\s\u0000-\u001f\u007f]*[\t\r\n]/u;
const SAFE_NUMERIC_LITERAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;

export const neutralizeSpreadsheetFormula = (value: string): string => {
  const dangerousControl = CSV_DANGEROUS_CONTROL_PREFIX.test(value);
  if (
    !CSV_FORMULA_PREFIX.test(value)
    && !dangerousControl
  ) return value;
  // A plain negative number is data, not a spreadsheet formula. Keeping this
  // narrow exception preserves numeric formatting for negative amounts.
  if (!dangerousControl && SAFE_NUMERIC_LITERAL.test(value.trim())) return value;
  return `'${value}`;
};

const csvCell = (value: unknown): string => {
  const raw = String(value ?? "");
  const text = typeof value === "string"
    ? neutralizeSpreadsheetFormula(raw)
    : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function toUnmatchedOrdersCsv(samples: UnmatchedOrderSample[]): string {
  const header = [
    "原因代码",
    "原因说明",
    "平台",
    "商品ID",
    "来源文件",
    "未匹配行数",
    "未匹配金额",
    "样例订单号",
  ];
  const lines = samples.map((sample) =>
    [
      sample.reason,
      reasonDetails[sample.reason].label,
      sample.platform,
      sample.productId,
      sample.sourceFile,
      sample.rows,
      sample.amount.toFixed(2),
      sample.sampleOrderNo,
    ]
      .map(csvCell)
      .join(","),
  );
  return `\uFEFF${[header.join(","), ...lines].join("\r\n")}`;
}

export async function exportUnmatchedOrdersCsv(
  dependencies: UnmatchedOrdersDependencies = defaultDependencies(),
): Promise<string> {
  const tableRef = await dependencies.resolveTableReference();
  if (!tableRef) return toUnmatchedOrdersCsv([]);
  return toUnmatchedOrdersCsv(await querySamples(dependencies.executor, tableRef));
}
