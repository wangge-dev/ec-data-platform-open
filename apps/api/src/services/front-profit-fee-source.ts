import {
  calculateFrontProfitDerivedValues,
  FRONT_PROFIT_MONEY_TOLERANCE,
  type FrontProfitFormulaInputField,
} from "./front-profit-formula.js";
import {
  aggregateFrontProfitL3ToL4,
  stageFrontProfitL1PayloadRowsToL3,
  upsertFrontProfitL1SourceRows,
  writeFrontProfitShadowReconciliation,
  type FrontProfitL1SourceRowInput,
  type FrontProfitL3L4AggregationResult,
  type FrontProfitLayerRowCount,
  type FrontProfitLayerSqlExecutor,
  type FrontProfitL4AggRowForContract,
  type FrontProfitReconMetric,
  type FrontProfitShadowReconResult,
} from "./front-profit-layers.js";
import { deriveFrontProfitPeriod } from "./front-profit-period.js";
import { normalizeFrontProfitDate } from "./front-profit-standard.js";
import {
  FRONT_PROFIT_FEE_AUTHORITY_PRIORITY,
  FRONT_PROFIT_FEE_KINDS,
  selectAuthoritativeFrontProfitFeeSource,
  type FrontProfitFeeAuthoritySource,
  type FrontProfitFeeKind,
} from "./front-profit-business-rules.js";

export const FRONT_PROFIT_FEE_SOURCE_VERSION = "front-profit-fee-source/v1" as const;
export const FRONT_PROFIT_FEE_SOURCE_FAMILY = "fee_fact" as const;
export const FRONT_PROFIT_FEE_AUTHORITY_SOURCE_FAMILY = "fee_authoritative" as const;
export const FRONT_PROFIT_FEE_SOURCE_AMOUNT_KIND = "fee_amount" as const;
export const FRONT_PROFIT_FEE_AUTHORITY_AMOUNT_KIND = "authority_amount" as const;

const FRONT_PROFIT_FEE_BULK_WRITE_BATCH_SIZE = 1_000;

export const FRONT_PROFIT_FEE_SOURCE_HEADERS = [
  "费用ID",
  "费用日期",
  "费用项",
  "权威来源",
  "平台",
  "业务模式",
  "组",
  "店铺",
  "店铺2",
  "运营",
  "SKU",
  "广告账户",
  "金额",
  "币种",
  "来源批次",
  "备注",
] as const;

export type FrontProfitFeeSourceHeader = typeof FRONT_PROFIT_FEE_SOURCE_HEADERS[number];
export type FrontProfitFeeSourceRawRow = Partial<Record<FrontProfitFeeSourceHeader, unknown>>;

export type FrontProfitFeeSourceRow = {
  runId: number;
  sourceId: number;
  sourceRowNo: number;
  period: string;
  feeKey: string;
  eventDate: string;
  feeKind: FrontProfitFeeKind;
  authoritySource: FrontProfitFeeAuthoritySource;
  authorityPriority: number;
  platform: string;
  businessMode: string;
  groupName?: string | null;
  shop: string;
  shopNormalized?: string | null;
  operatorKey: string;
  skuKey?: string | null;
  adAccountKey?: string | null;
  amount: number;
  currency: string;
  sourceFile?: string | null;
  sourceBatch?: string | null;
  note?: string | null;
  rowPayload?: Record<string, unknown>;
};

export type FrontProfitFeeAuthoritativeRow = FrontProfitFeeSourceRow & {
  selectedAuthoritySource: FrontProfitFeeAuthoritySource;
};

export type FrontProfitFeeLoadResult = {
  factRowCount: number;
  l1RowCount: number;
  reconResults: FrontProfitReconMetric[];
};

export type FrontProfitFeeAuthorityApplicationResult = {
  authoritativeRows: FrontProfitFeeAuthoritativeRow[];
  l1RowCount: number;
  reconResults: FrontProfitReconMetric[];
};

type FeeSourceSums = {
  rowCount: number;
  amount: number;
};

const FEE_KIND_ALIASES: Record<string, FrontProfitFeeKind> = {
  platform_fee: "platform_fee",
  "平台扣点/毛保": "platform_fee",
  tax_fee: "tax_fee",
  税点: "tax_fee",
  finance_cost: "finance_cost",
  财务成本: "finance_cost",
  freight: "freight",
  运费: "freight",
  commission: "commission",
  佣金: "commission",
  promotion_fee: "promotion_fee",
  推广费: "promotion_fee",
};

const AUTHORITY_SOURCE_ALIASES: Record<string, FrontProfitFeeAuthoritySource> = {
  settlement: "settlement",
  实际结算: "settlement",
  platform_bill: "platform_bill",
  平台账单: "platform_bill",
  rate_rule: "rate_rule",
  费率规则: "rate_rule",
  manual_estimate: "manual_estimate",
  人工估算: "manual_estimate",
};

const FEE_KIND_DB_COLUMN: Record<FrontProfitFeeKind, string> = {
  platform_fee: "platform_fee",
  tax_fee: "tax_fee",
  finance_cost: "finance_cost",
  freight: "freight",
  commission: "commission",
  promotion_fee: "promotion_fee",
};

const ZERO_FORMULA_INPUTS: Record<FrontProfitFormulaInputField, number> = {
  GMV: 0,
  补单金额: 0,
  补单产品成本: 0,
  产品成本: 0,
  出货货值: 0,
  "平台扣点/毛保": 0,
  税点: 0,
  财务成本: 0,
  运费: 0,
  佣金: 0,
  推广费: 0,
};

function assertPositiveSafeId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function assertPositiveRowNo(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function normalizedText(value: unknown): string {
  return String(value ?? "").trim();
}

function requiredText(value: unknown, label: string): string {
  const normalized = normalizedText(value);
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function optionalText(value: unknown): string | null {
  const normalized = normalizedText(value);
  return normalized === "" ? null : normalized;
}

function strictNumber(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.trim();
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
      const parsed = Number(normalized);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  throw new Error(`${label} must be a finite decimal number`);
}

function assertIsoDateValue(value: unknown, label: string): string {
  const normalized = normalizeFrontProfitDate(value);
  if (!normalized) {
    throw new Error(`${label} must use YYYY-MM-DD`);
  }
  return normalized;
}

function assertCurrency(value: unknown): string {
  const currency = optionalText(value) ?? "CNY";
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error("front-profit fee currency must be a 3-letter ISO code");
  }
  return currency;
}

function decimalText(value: unknown): string {
  const parsed = strictNumber(value, "decimal");
  return Number.isInteger(parsed) ? String(parsed) : String(parsed);
}

function normalizeFeeKind(value: unknown): FrontProfitFeeKind {
  const normalized = requiredText(value, "feeKind");
  const feeKind = FEE_KIND_ALIASES[normalized];
  if (feeKind && (FRONT_PROFIT_FEE_KINDS as readonly string[]).includes(feeKind)) return feeKind;
  throw new Error(`front-profit fee kind is unsupported: ${normalized}`);
}

function normalizeAuthoritySource(value: unknown): FrontProfitFeeAuthoritySource {
  const normalized = requiredText(value, "authoritySource");
  const authoritySource = AUTHORITY_SOURCE_ALIASES[normalized];
  if (
    authoritySource
    && (FRONT_PROFIT_FEE_AUTHORITY_PRIORITY as readonly string[]).includes(authoritySource)
  ) {
    return authoritySource;
  }
  throw new Error(`front-profit fee authority source is unsupported: ${normalized}`);
}

function authorityPriority(authoritySource: FrontProfitFeeAuthoritySource): number {
  return FRONT_PROFIT_FEE_AUTHORITY_PRIORITY.indexOf(authoritySource) + 1;
}

function sourceMetric(sourceId: number, metric: string): string {
  return `source_${sourceId}_${metric}`;
}

function feeSourceRecordKey(row: Pick<FrontProfitFeeSourceRow, "feeKind" | "authoritySource" | "feeKey">): string {
  return `${row.feeKind}:${row.authoritySource}:${row.feeKey}`;
}

function feeAuthorityRecordKey(row: Pick<FrontProfitFeeAuthoritativeRow, "feeKind" | "feeKey">): string {
  return `${row.feeKind}:${row.feeKey}`;
}

function parseFeeSourceSums(row: Record<string, unknown> | undefined): FeeSourceSums {
  return {
    rowCount: Number(row?.rowCount ?? row?.row_count ?? 0),
    amount: Number(row?.amount ?? 0),
  };
}

async function upsertFrontProfitFeeFacts(
  executor: FrontProfitLayerSqlExecutor,
  rows: FrontProfitFeeSourceRow[],
): Promise<FrontProfitLayerRowCount> {
  if (rows.length === 0) return { rowCount: 0 };
  if (rows.length > FRONT_PROFIT_FEE_BULK_WRITE_BATCH_SIZE) {
    let rowCount = 0;
    for (let index = 0; index < rows.length; index += FRONT_PROFIT_FEE_BULK_WRITE_BATCH_SIZE) {
      const inserted = await upsertFrontProfitFeeFacts(
        executor,
        rows.slice(index, index + FRONT_PROFIT_FEE_BULK_WRITE_BATCH_SIZE),
      );
      rowCount += inserted.rowCount;
    }
    return { rowCount };
  }

  const placeholders: string[] = [];
  const parameters: unknown[] = [];
  let paramIndex = 1;
  for (const row of rows) {
    const runId = assertPositiveSafeId(row.runId, "runId");
    const sourceId = assertPositiveSafeId(row.sourceId, "sourceId");
    const sourceRowNo = assertPositiveRowNo(row.sourceRowNo, "sourceRowNo");
    const eventDate = assertIsoDateValue(row.eventDate, "eventDate");
    const period = deriveFrontProfitPeriod(eventDate);

    placeholders.push(
      `(${Array.from({ length: 16 }, () => `$${paramIndex++}`).join(", ")}, $${paramIndex++}::jsonb)`,
    );
    parameters.push(
      runId,
      sourceId,
      sourceRowNo,
      period,
      row.feeKind,
      row.authoritySource,
      authorityPriority(row.authoritySource),
      requiredText(row.feeKey, "feeKey"),
      eventDate,
      optionalText(row.platform),
      optionalText(row.shop),
      optionalText(row.operatorKey),
      optionalText(row.skuKey),
      optionalText(row.adAccountKey),
      decimalText(row.amount),
      assertCurrency(row.currency),
      row.rowPayload ?? {},
    );
  }

  const inserted = await executor.unsafe(
    `INSERT INTO public.front_profit_fee_fact
       (run_id, source_id, source_row_no, period, fee_kind, authority_source,
        authority_priority, fee_key, event_date, platform, shop, operator_key,
        sku_key, ad_account_key, amount, currency, row_payload)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (run_id, fee_kind, authority_source, fee_key) DO UPDATE SET
       source_id = EXCLUDED.source_id,
       source_row_no = EXCLUDED.source_row_no,
       period = EXCLUDED.period,
       authority_priority = EXCLUDED.authority_priority,
       event_date = EXCLUDED.event_date,
       platform = EXCLUDED.platform,
       shop = EXCLUDED.shop,
       operator_key = EXCLUDED.operator_key,
       sku_key = EXCLUDED.sku_key,
       ad_account_key = EXCLUDED.ad_account_key,
       amount = EXCLUDED.amount,
       currency = EXCLUDED.currency,
       row_payload = EXCLUDED.row_payload
     RETURNING id`,
    parameters,
  );

  return { rowCount: inserted.length };
}

async function selectFrontProfitFeeFactSums(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    sourceId: number;
  },
): Promise<FeeSourceSums> {
  const [row] = await executor.unsafe(
    `SELECT COUNT(*)::int AS "rowCount",
            COALESCE(SUM(amount), 0)::float8 AS "amount"
       FROM public.front_profit_fee_fact
      WHERE run_id = $1 AND period = $2 AND source_id = $3`,
    [input.runId, input.period, input.sourceId],
  );
  return parseFeeSourceSums(row);
}

async function selectFrontProfitFeeL1Sums(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    sourceId: number;
    sourceFamily: string;
    amountPayloadKey: "fee_amount" | "authority_amount";
  },
): Promise<FeeSourceSums> {
  const amountPayloadKey = input.amountPayloadKey;
  const [row] = await executor.unsafe(
    `SELECT COUNT(*)::int AS "rowCount",
            COALESCE(SUM((row_payload->>'${amountPayloadKey}')::numeric), 0)::float8 AS "amount"
       FROM public.front_profit_l1_source_row
      WHERE run_id = $1 AND period = $2 AND source_id = $3 AND source_family = $4`,
    [input.runId, input.period, input.sourceId, input.sourceFamily],
  );
  return parseFeeSourceSums(row);
}

async function selectFrontProfitFeeFactsForPeriod(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
  },
): Promise<FrontProfitFeeSourceRow[]> {
  const rows = await executor.unsafe(
    `SELECT run_id AS "runId",
            source_id AS "sourceId",
            source_row_no AS "sourceRowNo",
            period,
            fee_key AS "feeKey",
            event_date AS "eventDate",
            fee_kind AS "feeKind",
            authority_source AS "authoritySource",
            authority_priority AS "authorityPriority",
            platform,
            shop,
            operator_key AS "operatorKey",
            sku_key AS "skuKey",
            ad_account_key AS "adAccountKey",
            amount,
            currency,
            row_payload AS "rowPayload"
       FROM public.front_profit_fee_fact
      WHERE run_id = $1 AND period = $2
      ORDER BY fee_kind, fee_key, authority_priority, id`,
    [input.runId, input.period],
  );

  return rows.map((row) => ({
    runId: Number(row.runId ?? row.run_id),
    sourceId: Number(row.sourceId ?? row.source_id),
    sourceRowNo: Number(row.sourceRowNo ?? row.source_row_no),
    period: requiredText(row.period, "period"),
    feeKey: requiredText(row.feeKey ?? row.fee_key, "feeKey"),
    eventDate: assertIsoDateValue(row.eventDate ?? row.event_date, "eventDate"),
    feeKind: normalizeFeeKind(row.feeKind ?? row.fee_kind),
    authoritySource: normalizeAuthoritySource(row.authoritySource ?? row.authority_source),
    authorityPriority: strictNumber(row.authorityPriority ?? row.authority_priority, "authorityPriority"),
    platform: requiredText(row.platform, "platform"),
    businessMode: requiredText((row.rowPayload as Record<string, unknown> | undefined)?.businessMode, "businessMode"),
    groupName: optionalText((row.rowPayload as Record<string, unknown> | undefined)?.groupName),
    shop: requiredText(row.shop, "shop"),
    shopNormalized: optionalText((row.rowPayload as Record<string, unknown> | undefined)?.shopNormalized),
    operatorKey: requiredText(row.operatorKey ?? row.operator_key, "operatorKey"),
    skuKey: optionalText(row.skuKey ?? row.sku_key),
    adAccountKey: optionalText(row.adAccountKey ?? row.ad_account_key),
    amount: strictNumber(row.amount, "amount"),
    currency: assertCurrency(row.currency),
    sourceFile: optionalText((row.rowPayload as Record<string, unknown> | undefined)?.sourceFile),
    sourceBatch: optionalText((row.rowPayload as Record<string, unknown> | undefined)?.sourceBatch),
    note: optionalText((row.rowPayload as Record<string, unknown> | undefined)?.note),
    rowPayload: row.rowPayload && typeof row.rowPayload === "object" && !Array.isArray(row.rowPayload)
      ? row.rowPayload as Record<string, unknown>
      : {},
  }));
}

async function upsertFrontProfitFeeReconMetric(
  executor: FrontProfitLayerSqlExecutor,
  runId: number,
  result: FrontProfitReconMetric,
): Promise<void> {
  await executor.unsafe(
    `INSERT INTO public.recon_result
       (run_id, layer, metric, expected, actual, tolerance, passed, evidence_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (run_id, layer, metric) DO UPDATE SET
       expected = EXCLUDED.expected,
       actual = EXCLUDED.actual,
       tolerance = EXCLUDED.tolerance,
       passed = EXCLUDED.passed,
       evidence_ref = EXCLUDED.evidence_ref`,
    [
      runId,
      result.layer,
      result.metric,
      result.expected == null ? null : decimalText(result.expected),
      result.actual == null ? null : decimalText(result.actual),
      result.tolerance == null ? null : decimalText(result.tolerance),
      result.passed,
      result.evidenceRef ?? {},
    ],
  );
}

function feeSourceReconResults(
  input: {
    sourceId: number;
    period: string;
    layer: string;
    sourceFamily: string;
    expected: FeeSourceSums;
    actual: FeeSourceSums;
  },
): FrontProfitReconMetric[] {
  const fields = [
    ["row_count", input.expected.rowCount, input.actual.rowCount, 0],
    ["amount_sum", input.expected.amount, input.actual.amount, FRONT_PROFIT_MONEY_TOLERANCE],
  ] as const;

  return fields.map(([metric, expected, actual, tolerance]) => ({
    layer: input.layer,
    metric: sourceMetric(input.sourceId, metric),
    expected,
    actual,
    tolerance,
    passed: Math.abs(actual - expected) <= tolerance,
    evidenceRef: {
      sourceId: input.sourceId,
      period: input.period,
      sourceFamily: input.sourceFamily,
      sourceContractVersion: FRONT_PROFIT_FEE_SOURCE_VERSION,
    },
  }));
}

export function assertFrontProfitFeeSourceHeaders(headers: readonly unknown[]): void {
  const normalized = headers.map(normalizedText);
  const expected = [...FRONT_PROFIT_FEE_SOURCE_HEADERS];
  if (
    normalized.length !== expected.length
    || normalized.some((header, index) => header !== expected[index])
  ) {
    throw new Error("front-profit fee source headers do not match front-profit-fee-source/v1");
  }
}

export function normalizeFrontProfitFeeSourceRows(input: {
  runId: number;
  sourceId: number;
  sourceFile?: string | null;
  firstDataRowNumber?: number;
  rows: FrontProfitFeeSourceRawRow[];
}): FrontProfitFeeSourceRow[] {
  const runId = assertPositiveSafeId(input.runId, "runId");
  const sourceId = assertPositiveSafeId(input.sourceId, "sourceId");
  const sourceFile = optionalText(input.sourceFile);
  const firstDataRowNumber = input.firstDataRowNumber ?? 2;

  return input.rows.map((row, index) => {
    const sourceRowNo = firstDataRowNumber + index;
    const eventDate = assertIsoDateValue(row["费用日期"], `row ${sourceRowNo} 费用日期`);
    const feeKind = normalizeFeeKind(row["费用项"]);
    const authoritySource = normalizeAuthoritySource(row["权威来源"]);
    const normalized: FrontProfitFeeSourceRow = {
      runId,
      sourceId,
      sourceRowNo,
      period: deriveFrontProfitPeriod(eventDate),
      feeKey: requiredText(row["费用ID"], `row ${sourceRowNo} 费用ID`),
      eventDate,
      feeKind,
      authoritySource,
      authorityPriority: authorityPriority(authoritySource),
      platform: requiredText(row["平台"], `row ${sourceRowNo} 平台`),
      businessMode: requiredText(row["业务模式"], `row ${sourceRowNo} 业务模式`),
      groupName: optionalText(row["组"]),
      shop: requiredText(row["店铺"], `row ${sourceRowNo} 店铺`),
      shopNormalized: optionalText(row["店铺2"]),
      operatorKey: requiredText(row["运营"], `row ${sourceRowNo} 运营`),
      skuKey: optionalText(row.SKU),
      adAccountKey: optionalText(row["广告账户"]),
      amount: strictNumber(row["金额"], `row ${sourceRowNo} 金额`),
      currency: assertCurrency(row["币种"]),
      sourceFile,
      sourceBatch: optionalText(row["来源批次"]),
      note: optionalText(row["备注"]),
    };
    return {
      ...normalized,
      rowPayload: {
        ...row,
        sourceFamily: FRONT_PROFIT_FEE_SOURCE_FAMILY,
        sourceContractVersion: FRONT_PROFIT_FEE_SOURCE_VERSION,
        sourceFile,
        sourceBatch: normalized.sourceBatch,
        sourceRecordKey: feeSourceRecordKey(normalized),
        feeKey: normalized.feeKey,
        eventDate: normalized.eventDate,
        feeKind,
        authoritySource,
        authorityPriority: normalized.authorityPriority,
        businessMode: normalized.businessMode,
        groupName: normalized.groupName,
        shopNormalized: normalized.shopNormalized,
        adAccountKey: normalized.adAccountKey,
        amount: normalized.amount,
        currency: normalized.currency,
        note: normalized.note,
      },
    };
  });
}

export function frontProfitFeeSourceRowToL1Input(
  row: FrontProfitFeeSourceRow,
): FrontProfitL1SourceRowInput {
  return {
    runId: row.runId,
    sourceId: row.sourceId,
    sourceRowNo: row.sourceRowNo,
    period: row.period,
    sourceFamily: FRONT_PROFIT_FEE_SOURCE_FAMILY,
    sourceRecordKey: feeSourceRecordKey(row),
    eventDate: row.eventDate,
    platform: row.platform,
    shop: row.shop,
    operatorKey: row.operatorKey,
    skuKey: row.skuKey,
    amountKind: FRONT_PROFIT_FEE_SOURCE_AMOUNT_KIND,
    amountValue: row.amount,
    quantity: 0,
    currency: row.currency,
    rowPayload: {
      sourceFamily: FRONT_PROFIT_FEE_SOURCE_FAMILY,
      sourceContractVersion: FRONT_PROFIT_FEE_SOURCE_VERSION,
      sourceRecordKey: feeSourceRecordKey(row),
      feeKey: row.feeKey,
      eventDate: row.eventDate,
      feeKind: row.feeKind,
      authoritySource: row.authoritySource,
      authorityPriority: row.authorityPriority,
      businessMode: row.businessMode,
      groupName: row.groupName,
      shopNormalized: row.shopNormalized,
      adAccountKey: row.adAccountKey,
      fee_amount: row.amount,
      currency: row.currency,
      sourceFile: row.sourceFile,
      sourceBatch: row.sourceBatch,
      note: row.note,
      raw: row.rowPayload ?? {},
    },
  };
}

export function frontProfitFeeAuthoritativeRowToL1Input(
  row: FrontProfitFeeAuthoritativeRow,
): FrontProfitL1SourceRowInput {
  const column = FEE_KIND_DB_COLUMN[row.feeKind];
  return {
    runId: row.runId,
    sourceId: row.sourceId,
    sourceRowNo: row.sourceRowNo,
    period: row.period,
    sourceFamily: FRONT_PROFIT_FEE_AUTHORITY_SOURCE_FAMILY,
    sourceRecordKey: feeAuthorityRecordKey(row),
    eventDate: row.eventDate,
    platform: row.platform,
    shop: row.shop,
    operatorKey: row.operatorKey,
    skuKey: row.skuKey,
    amountKind: FRONT_PROFIT_FEE_AUTHORITY_AMOUNT_KIND,
    amountValue: row.amount,
    quantity: 0,
    currency: row.currency,
    rowPayload: {
      sourceFamily: FRONT_PROFIT_FEE_AUTHORITY_SOURCE_FAMILY,
      sourceContractVersion: FRONT_PROFIT_FEE_SOURCE_VERSION,
      sourceRecordKey: feeAuthorityRecordKey(row),
      feeKey: row.feeKey,
      eventDate: row.eventDate,
      feeKind: row.feeKind,
      selectedAuthoritySource: row.selectedAuthoritySource,
      businessMode: row.businessMode,
      groupName: row.groupName,
      shopNormalized: row.shopNormalized,
      adAccountKey: row.adAccountKey,
      detailKey: `fee:${row.feeKind}:${row.feeKey}`,
      recordId: `FEE_L3_${row.feeKind}_${row.feeKey}`,
      calculationRole: "fee_contribution",
      quantity: 0,
      gmv: 0,
      fill_order_amount: 0,
      fill_order_product_cost: 0,
      fill_order_quantity: 0,
      product_cost: 0,
      shipment_value: 0,
      platform_fee: column === "platform_fee" ? row.amount : 0,
      tax_fee: column === "tax_fee" ? row.amount : 0,
      finance_cost: column === "finance_cost" ? row.amount : 0,
      freight: column === "freight" ? row.amount : 0,
      commission: column === "commission" ? row.amount : 0,
      promotion_fee: column === "promotion_fee" ? row.amount : 0,
      authority_amount: row.amount,
      currency: row.currency,
      sourceFile: row.sourceFile,
      sourceBatch: row.sourceBatch,
      note: row.note,
      raw: row.rowPayload ?? {},
    },
  };
}

export async function loadFrontProfitFeeSource(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    rows: FrontProfitFeeSourceRow[];
  },
): Promise<FrontProfitFeeLoadResult> {
  if (input.rows.length === 0) {
    return { factRowCount: 0, l1RowCount: 0, reconResults: [] };
  }

  const first = input.rows[0]!;
  const runId = assertPositiveSafeId(first.runId, "runId");
  const sourceId = assertPositiveSafeId(first.sourceId, "sourceId");
  const period = first.period;
  if (input.rows.some((row) => row.runId !== runId || row.sourceId !== sourceId || row.period !== period)) {
    throw new Error("front-profit fee source load must receive one run/source/period at a time");
  }

  const factResult = await upsertFrontProfitFeeFacts(executor, input.rows);
  const l1Rows = input.rows.map(frontProfitFeeSourceRowToL1Input);
  const l1Result = await upsertFrontProfitL1SourceRows(executor, { rows: l1Rows });
  const [fact, l1] = await Promise.all([
    selectFrontProfitFeeFactSums(executor, { runId, period, sourceId }),
    selectFrontProfitFeeL1Sums(executor, {
      runId,
      period,
      sourceId,
      sourceFamily: FRONT_PROFIT_FEE_SOURCE_FAMILY,
      amountPayloadKey: "fee_amount",
    }),
  ]);
  const reconResults = feeSourceReconResults({
    sourceId,
    period,
    layer: "FEE_SOURCE_L1",
    sourceFamily: FRONT_PROFIT_FEE_SOURCE_FAMILY,
    expected: fact,
    actual: l1,
  });
  for (const result of reconResults) {
    await upsertFrontProfitFeeReconMetric(executor, runId, result);
  }

  return {
    factRowCount: factResult.rowCount,
    l1RowCount: l1Result.rowCount,
    reconResults,
  };
}

export async function applyFrontProfitFeeAuthorityToL1(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    requiredFeeKinds?: FrontProfitFeeKind[];
  },
): Promise<FrontProfitFeeAuthorityApplicationResult> {
  const runId = assertPositiveSafeId(input.runId, "runId");
  const period = requiredText(input.period, "period");
  const facts = await selectFrontProfitFeeFactsForPeriod(executor, { runId, period });

  for (const feeKind of input.requiredFeeKinds ?? []) {
    selectAuthoritativeFrontProfitFeeSource(facts, feeKind);
  }

  const groups = new Map<string, FrontProfitFeeSourceRow[]>();
  for (const row of facts) {
    const key = `${row.feeKind}\u001f${row.feeKey}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const authoritativeRows = [...groups.values()].map((group) => {
    const first = group[0]!;
    const selectedAuthoritySource = selectAuthoritativeFrontProfitFeeSource(group, first.feeKind);
    const selected = group.find((row) => row.authoritySource === selectedAuthoritySource);
    if (!selected) {
      throw new Error("front-profit fee authority selection returned a missing source");
    }
    return {
      ...selected,
      selectedAuthoritySource,
    };
  });

  const l1Rows = authoritativeRows.map(frontProfitFeeAuthoritativeRowToL1Input);
  const l1Result = await upsertFrontProfitL1SourceRows(executor, { rows: l1Rows });
  const sourceIds = [...new Set(authoritativeRows.map((row) => row.sourceId))].sort((left, right) => left - right);
  const expected = {
    rowCount: authoritativeRows.length,
    amount: authoritativeRows.reduce((total, row) => total + row.amount, 0),
  };
  const l1Sums = await Promise.all(sourceIds.map((sourceId) =>
    selectFrontProfitFeeL1Sums(executor, {
      runId,
      period,
      sourceId,
      sourceFamily: FRONT_PROFIT_FEE_AUTHORITY_SOURCE_FAMILY,
      amountPayloadKey: "authority_amount",
    }),
  ));
  const actual = l1Sums.reduce<FeeSourceSums>((total, sums) => ({
    rowCount: total.rowCount + sums.rowCount,
    amount: total.amount + sums.amount,
  }), { rowCount: 0, amount: 0 });
  const reconResults = feeSourceReconResults({
    sourceId: 0,
    period,
    layer: "FEE_AUTHORITY_L1",
    sourceFamily: FRONT_PROFIT_FEE_AUTHORITY_SOURCE_FAMILY,
    expected,
    actual,
  }).map((result) => ({
    ...result,
    metric: `period_${period}_${result.metric}`,
    evidenceRef: {
      ...result.evidenceRef,
      sourceIds,
      selectedRowCount: authoritativeRows.length,
    },
  }));
  for (const result of reconResults) {
    await upsertFrontProfitFeeReconMetric(executor, runId, result);
  }

  return { authoritativeRows, l1RowCount: l1Result.rowCount, reconResults };
}

export async function stageFrontProfitFeeL1ToL3(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    mappingVersionId?: number | null;
    ruleVersion?: string;
    jobVersion: string;
  },
): Promise<FrontProfitLayerRowCount> {
  return stageFrontProfitL1PayloadRowsToL3(executor, {
    runId: input.runId,
    period: input.period,
    sourceFamily: FRONT_PROFIT_FEE_AUTHORITY_SOURCE_FAMILY,
    mappingVersionId: input.mappingVersionId,
    ruleVersion: input.ruleVersion ?? FRONT_PROFIT_FEE_SOURCE_VERSION,
    jobVersion: input.jobVersion,
  });
}

export async function aggregateFrontProfitFeeL3ToL4(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    writeRecon?: boolean;
  },
): Promise<FrontProfitL3L4AggregationResult> {
  return aggregateFrontProfitL3ToL4(executor, input);
}

export async function writeFrontProfitFeeShadowReconciliation(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    manualRows: FrontProfitL4AggRowForContract[];
    baselineLabel?: string;
  },
): Promise<FrontProfitShadowReconResult> {
  return writeFrontProfitShadowReconciliation(executor, input);
}

export function frontProfitFeeAuthoritativeRowsToManualBaseline(
  rows: FrontProfitFeeAuthoritativeRow[],
): FrontProfitL4AggRowForContract[] {
  const grouped = new Map<string, FrontProfitFeeAuthoritativeRow[]>();
  for (const row of rows) {
    const key = [
      row.eventDate,
      row.platform,
      row.businessMode,
      row.shop,
      row.operatorKey,
    ].join("\u001f");
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  return [...grouped.values()].map((group) => {
    const first = group[0]!;
    const feeSums = {
      platform_fee: 0,
      tax_fee: 0,
      finance_cost: 0,
      freight: 0,
      commission: 0,
      promotion_fee: 0,
    };
    for (const row of group) {
      feeSums[FEE_KIND_DB_COLUMN[row.feeKind] as keyof typeof feeSums] += row.amount;
    }
    const derived = calculateFrontProfitDerivedValues((field) => ({
      ...ZERO_FORMULA_INPUTS,
      "平台扣点/毛保": feeSums.platform_fee,
      税点: feeSums.tax_fee,
      财务成本: feeSums.finance_cost,
      运费: feeSums.freight,
      佣金: feeSums.commission,
      推广费: feeSums.promotion_fee,
    })[field]);

    return {
      date: first.eventDate,
      platform: first.platform,
      businessMode: first.businessMode,
      groupName: first.groupName,
      shop: first.shop,
      shopNormalized: first.shopNormalized,
      operator: first.operatorKey,
      quantity: 0,
      gmv: 0,
      fillOrderAmount: 0,
      fillOrderProductCost: 0,
      fillOrderQuantity: 0,
      productCost: 0,
      shipmentValue: 0,
      platformFee: feeSums.platform_fee,
      taxFee: feeSums.tax_fee,
      financeCost: feeSums.finance_cost,
      freight: feeSums.freight,
      commission: feeSums.commission,
      promotionFee: feeSums.promotion_fee,
      sourceFile: first.sourceFile,
      sourceBatch: first.sourceBatch,
      note: "manual 01 baseline derived from fee source fixture",
      realRevenue: derived["真实营业额"],
      frontProfit: derived["前台利润"],
      paidRatio: derived["付费占比"],
      recordId: `MANUAL_FEE_BASELINE_${first.feeKey}`,
      dataStatus: "manual_baseline",
    };
  });
}
