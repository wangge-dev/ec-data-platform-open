import {
  calculateFrontProfitDerivedValues,
  FRONT_PROFIT_MONEY_TOLERANCE,
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
import { selectFrontProfitOperatorAssignmentsForShops } from "./front-profit-operator-source.js";
import { deriveFrontProfitPeriod } from "./front-profit-period.js";
import { normalizeFrontProfitDate } from "./front-profit-standard.js";
import {
  createFrontProfitOperatorResolver,
  type FrontProfitOperatorAuthorityKeyType,
} from "./front-profit-business-rules.js";

export const FRONT_PROFIT_PROMOTION_SOURCE_VERSION = "front-profit-promotion-source/v1" as const;
export const FRONT_PROFIT_PROMOTION_SOURCE_FAMILY = "promotion_spend" as const;
export const FRONT_PROFIT_PROMOTION_AMOUNT_KIND = "promotion_fee" as const;

export const FRONT_PROFIT_PROMOTION_SOURCE_HEADERS = [
  "推广ID",
  "推广日期",
  "平台",
  "业务模式",
  "组",
  "店铺",
  "店铺2",
  "广告账户",
  "SKU",
  "产品负责人",
  "订单负责人",
  "手工映射键",
  "推广费",
  "来源批次",
  "备注",
] as const;

export type FrontProfitPromotionSourceHeader = typeof FRONT_PROFIT_PROMOTION_SOURCE_HEADERS[number];
export type FrontProfitPromotionSourceRawRow =
  Partial<Record<FrontProfitPromotionSourceHeader, unknown>>;

export type FrontProfitPromotionSourceRow = {
  runId: number;
  sourceId: number;
  sourceRowNo: number;
  period: string;
  promotionKey: string;
  promotionDate: string;
  platform: string;
  businessMode: string;
  groupName?: string | null;
  shop: string;
  shopNormalized?: string | null;
  adAccountKey?: string | null;
  skuKey?: string | null;
  productOwnerKey?: string | null;
  orderOwnerKey?: string | null;
  manualMappingKey?: string | null;
  promotionFee: number;
  sourceFile?: string | null;
  sourceBatch?: string | null;
  note?: string | null;
  rowPayload?: Record<string, unknown>;
};

export type FrontProfitPromotionAppliedRow = FrontProfitPromotionSourceRow & {
  operatorKey: string;
  matchedAuthorityKeyType: FrontProfitOperatorAuthorityKeyType;
  matchedAuthorityKey: string;
};

export type FrontProfitPromotionLoadResult = {
  appliedRows: FrontProfitPromotionAppliedRow[];
  l1RowCount: number;
  reconResults: FrontProfitReconMetric[];
};

type PromotionSourceSums = {
  rowCount: number;
  promotionFee: number;
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

function decimalText(value: unknown): string {
  const parsed = strictNumber(value, "decimal");
  return Number.isInteger(parsed) ? String(parsed) : String(parsed);
}

function sourceMetric(sourceId: number, metric: string): string {
  return `source_${sourceId}_${metric}`;
}

function parsePromotionSourceSums(row: Record<string, unknown> | undefined): PromotionSourceSums {
  return {
    rowCount: Number(row?.rowCount ?? row?.row_count ?? 0),
    promotionFee: Number(row?.promotionFee ?? row?.promotion_fee ?? 0),
  };
}

async function selectFrontProfitPromotionL1Sums(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    sourceId: number;
  },
): Promise<PromotionSourceSums> {
  const [row] = await executor.unsafe(
    `SELECT COUNT(*)::int AS "rowCount",
            COALESCE(SUM((row_payload->>'promotion_fee')::numeric), 0)::float8 AS "promotionFee"
       FROM public.front_profit_l1_source_row
      WHERE run_id = $1 AND period = $2 AND source_id = $3 AND source_family = $4`,
    [input.runId, input.period, input.sourceId, FRONT_PROFIT_PROMOTION_SOURCE_FAMILY],
  );
  return parsePromotionSourceSums(row);
}

async function upsertFrontProfitPromotionReconMetric(
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

function promotionReconResults(
  input: {
    sourceId: number;
    period: string;
    expected: PromotionSourceSums;
    l1: PromotionSourceSums;
  },
): FrontProfitReconMetric[] {
  const fields = [
    ["row_count", input.expected.rowCount, input.l1.rowCount, 0],
    ["promotion_fee_sum", input.expected.promotionFee, input.l1.promotionFee, FRONT_PROFIT_MONEY_TOLERANCE],
  ] as const;

  return fields.map(([metric, expected, actual, tolerance]) => ({
    layer: "PROMOTION_SOURCE_L1",
    metric: sourceMetric(input.sourceId, metric),
    expected,
    actual,
    tolerance,
    passed: Math.abs(actual - expected) <= tolerance,
    evidenceRef: {
      sourceId: input.sourceId,
      period: input.period,
      sourceFamily: FRONT_PROFIT_PROMOTION_SOURCE_FAMILY,
      sourceContractVersion: FRONT_PROFIT_PROMOTION_SOURCE_VERSION,
    },
  }));
}

export function assertFrontProfitPromotionSourceHeaders(headers: readonly unknown[]): void {
  const normalized = headers.map(normalizedText);
  const expected = [...FRONT_PROFIT_PROMOTION_SOURCE_HEADERS];
  if (
    normalized.length !== expected.length
    || normalized.some((header, index) => header !== expected[index])
  ) {
    throw new Error("front-profit promotion source headers do not match front-profit-promotion-source/v1");
  }
}

export function normalizeFrontProfitPromotionSourceRows(input: {
  runId: number;
  sourceId: number;
  sourceFile?: string | null;
  firstDataRowNumber?: number;
  rows: FrontProfitPromotionSourceRawRow[];
}): FrontProfitPromotionSourceRow[] {
  const runId = assertPositiveSafeId(input.runId, "runId");
  const sourceId = assertPositiveSafeId(input.sourceId, "sourceId");
  const sourceFile = optionalText(input.sourceFile);
  const firstDataRowNumber = input.firstDataRowNumber ?? 2;

  return input.rows.map((row, index) => {
    const sourceRowNo = firstDataRowNumber + index;
    const promotionDate = assertIsoDateValue(row["推广日期"], `row ${sourceRowNo} 推广日期`);
    const normalized: FrontProfitPromotionSourceRow = {
      runId,
      sourceId,
      sourceRowNo,
      period: deriveFrontProfitPeriod(promotionDate),
      promotionKey: requiredText(row["推广ID"], `row ${sourceRowNo} 推广ID`),
      promotionDate,
      platform: requiredText(row["平台"], `row ${sourceRowNo} 平台`),
      businessMode: requiredText(row["业务模式"], `row ${sourceRowNo} 业务模式`),
      groupName: optionalText(row["组"]),
      shop: requiredText(row["店铺"], `row ${sourceRowNo} 店铺`),
      shopNormalized: optionalText(row["店铺2"]),
      adAccountKey: optionalText(row["广告账户"]),
      skuKey: optionalText(row.SKU),
      productOwnerKey: optionalText(row["产品负责人"]),
      orderOwnerKey: optionalText(row["订单负责人"]),
      manualMappingKey: optionalText(row["手工映射键"]),
      promotionFee: strictNumber(row["推广费"], `row ${sourceRowNo} 推广费`),
      sourceFile,
      sourceBatch: optionalText(row["来源批次"]),
      note: optionalText(row["备注"]),
    };
    return {
      ...normalized,
      rowPayload: {
        ...row,
        sourceFamily: FRONT_PROFIT_PROMOTION_SOURCE_FAMILY,
        sourceContractVersion: FRONT_PROFIT_PROMOTION_SOURCE_VERSION,
        sourceFile,
        sourceBatch: normalized.sourceBatch,
        sourceRecordKey: normalized.promotionKey,
      },
    };
  });
}

export function frontProfitPromotionAppliedRowToL1Input(
  row: FrontProfitPromotionAppliedRow,
): FrontProfitL1SourceRowInput {
  return {
    runId: row.runId,
    sourceId: row.sourceId,
    sourceRowNo: row.sourceRowNo,
    period: row.period,
    sourceFamily: FRONT_PROFIT_PROMOTION_SOURCE_FAMILY,
    sourceRecordKey: row.promotionKey,
    eventDate: row.promotionDate,
    platform: row.platform,
    shop: row.shop,
    operatorKey: row.operatorKey,
    skuKey: row.skuKey,
    amountKind: FRONT_PROFIT_PROMOTION_AMOUNT_KIND,
    amountValue: row.promotionFee,
    quantity: 0,
    currency: "CNY",
    rowPayload: {
      sourceFamily: FRONT_PROFIT_PROMOTION_SOURCE_FAMILY,
      sourceContractVersion: FRONT_PROFIT_PROMOTION_SOURCE_VERSION,
      promotionKey: row.promotionKey,
      promotionDate: row.promotionDate,
      businessMode: row.businessMode,
      groupName: row.groupName,
      shopNormalized: row.shopNormalized,
      adAccountKey: row.adAccountKey,
      skuKey: row.skuKey,
      productOwnerKey: row.productOwnerKey,
      orderOwnerKey: row.orderOwnerKey,
      manualMappingKey: row.manualMappingKey,
      matchedAuthorityKeyType: row.matchedAuthorityKeyType,
      matchedAuthorityKey: row.matchedAuthorityKey,
      detailKey: `promotion:${row.promotionKey}`,
      recordId: `PROMOTION_L3_${row.promotionKey}`,
      calculationRole: "promotion_fee_contribution",
      quantity: 0,
      gmv: 0,
      fill_order_amount: 0,
      fill_order_product_cost: 0,
      fill_order_quantity: 0,
      product_cost: 0,
      shipment_value: 0,
      platform_fee: 0,
      tax_fee: 0,
      finance_cost: 0,
      freight: 0,
      commission: 0,
      promotion_fee: row.promotionFee,
      sourceFile: row.sourceFile,
      sourceBatch: row.sourceBatch,
      note: row.note,
      raw: row.rowPayload ?? {},
    },
  };
}

export async function loadFrontProfitPromotionSource(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    rows: FrontProfitPromotionSourceRow[];
  },
): Promise<FrontProfitPromotionLoadResult> {
  if (input.rows.length === 0) {
    return { appliedRows: [], l1RowCount: 0, reconResults: [] };
  }

  const first = input.rows[0]!;
  const runId = assertPositiveSafeId(first.runId, "runId");
  const sourceId = assertPositiveSafeId(first.sourceId, "sourceId");
  const period = first.period;
  if (input.rows.some((row) => row.runId !== runId || row.sourceId !== sourceId || row.period !== period)) {
    throw new Error("front-profit promotion source load must receive one run/source/period at a time");
  }

  const shops = [...new Set(input.rows.map((row) => row.shop))].sort();
  const assignments = await selectFrontProfitOperatorAssignmentsForShops(executor, { runId, shops });
  const resolveOperator = createFrontProfitOperatorResolver(assignments);
  const appliedRows = input.rows.map((row) => {
    const assignment = resolveOperator({
      shop: row.shop,
      date: row.promotionDate,
      skuKey: row.skuKey,
      adAccountKey: row.adAccountKey,
      productOwnerKey: row.productOwnerKey,
      orderOwnerKey: row.orderOwnerKey,
      manualMappingKey: row.manualMappingKey,
    });
    return {
      ...row,
      operatorKey: assignment.operator,
      matchedAuthorityKeyType: assignment.authorityKeyType,
      matchedAuthorityKey: assignment.authorityKey,
    };
  });

  const l1Rows = appliedRows.map(frontProfitPromotionAppliedRowToL1Input);
  const l1Result = await upsertFrontProfitL1SourceRows(executor, { rows: l1Rows });
  const expected = {
    rowCount: appliedRows.length,
    promotionFee: appliedRows.reduce((total, row) => total + row.promotionFee, 0),
  };
  const l1 = await selectFrontProfitPromotionL1Sums(executor, { runId, period, sourceId });
  const reconResults = promotionReconResults({ sourceId, period, expected, l1 });
  for (const result of reconResults) {
    await upsertFrontProfitPromotionReconMetric(executor, runId, result);
  }

  return { appliedRows, l1RowCount: l1Result.rowCount, reconResults };
}

export async function stageFrontProfitPromotionL1ToL3(
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
    sourceFamily: FRONT_PROFIT_PROMOTION_SOURCE_FAMILY,
    mappingVersionId: input.mappingVersionId,
    ruleVersion: input.ruleVersion ?? FRONT_PROFIT_PROMOTION_SOURCE_VERSION,
    jobVersion: input.jobVersion,
  });
}

export async function aggregateFrontProfitPromotionL3ToL4(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    writeRecon?: boolean;
  },
): Promise<FrontProfitL3L4AggregationResult> {
  return aggregateFrontProfitL3ToL4(executor, input);
}

export async function writeFrontProfitPromotionShadowReconciliation(
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

export function frontProfitPromotionAppliedRowsToManualBaseline(
  rows: FrontProfitPromotionAppliedRow[],
): FrontProfitL4AggRowForContract[] {
  const grouped = new Map<string, FrontProfitPromotionAppliedRow[]>();
  for (const row of rows) {
    const key = [
      row.promotionDate,
      row.platform,
      row.businessMode,
      row.shop,
      row.operatorKey,
    ].join("\u001f");
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  return [...grouped.values()].map((group) => {
    const first = group[0]!;
    const promotionFee = group.reduce((total, row) => total + row.promotionFee, 0);
    const derived = calculateFrontProfitDerivedValues((field) => ({
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
      推广费: promotionFee,
    })[field]);

    return {
      date: first.promotionDate,
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
      platformFee: 0,
      taxFee: 0,
      financeCost: 0,
      freight: 0,
      commission: 0,
      promotionFee,
      sourceFile: first.sourceFile,
      sourceBatch: first.sourceBatch,
      note: "manual 01 baseline derived from promotion source fixture",
      realRevenue: derived["真实营业额"],
      frontProfit: derived["前台利润"],
      paidRatio: derived["付费占比"],
      recordId: `MANUAL_PROMOTION_BASELINE_${first.promotionKey}`,
      dataStatus: "manual_baseline",
    };
  });
}
