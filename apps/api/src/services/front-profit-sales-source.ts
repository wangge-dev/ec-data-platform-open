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
  type FrontProfitLayerPhaseTiming,
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

export const FRONT_PROFIT_SALES_SOURCE_VERSION = "front-profit-sales-source/v1" as const;
export const FRONT_PROFIT_SALES_SOURCE_FAMILY = "sales_fact" as const;
export const FRONT_PROFIT_SALES_AMOUNT_KIND = "sales_gmv" as const;

export const FRONT_PROFIT_SALES_SOURCE_HEADERS = [
  "销售ID",
  "销售日期",
  "平台",
  "业务模式",
  "组",
  "店铺",
  "店铺2",
  "SKU",
  "广告账户",
  "产品负责人",
  "订单负责人",
  "手工映射键",
  "单量",
  "GMV",
  "出货货值",
  "来源批次",
  "备注",
] as const;

export type FrontProfitSalesSourceHeader = typeof FRONT_PROFIT_SALES_SOURCE_HEADERS[number];
export type FrontProfitSalesSourceRawRow = Partial<Record<FrontProfitSalesSourceHeader, unknown>>;

export type FrontProfitSalesSourceRow = {
  runId: number;
  sourceId: number;
  sourceRowNo: number;
  period: string;
  saleKey: string;
  saleDate: string;
  platform: string;
  businessMode: string;
  groupName?: string | null;
  shop: string;
  shopNormalized?: string | null;
  skuKey?: string | null;
  adAccountKey?: string | null;
  productOwnerKey?: string | null;
  orderOwnerKey?: string | null;
  manualMappingKey?: string | null;
  quantity: number;
  gmv: number;
  shipmentValue: number;
  sourceFile?: string | null;
  sourceBatch?: string | null;
  note?: string | null;
  rowPayload?: Record<string, unknown>;
};

export type FrontProfitSalesAppliedRow = FrontProfitSalesSourceRow & {
  operatorKey: string;
  matchedAuthorityKeyType: FrontProfitOperatorAuthorityKeyType;
  matchedAuthorityKey: string;
};

export type FrontProfitSalesLoadResult = {
  appliedRows: FrontProfitSalesAppliedRow[];
  l1RowCount: number;
  reconResults: FrontProfitReconMetric[];
  l1WritePath?: "parameter_batch" | "copy_direct" | "copy_stage_upsert";
  l1WritePhaseTimings?: FrontProfitLayerPhaseTiming[];
};

type SalesSourceSums = {
  rowCount: number;
  quantity: number;
  gmv: number;
  shipmentValue: number;
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

function parseSalesSourceSums(row: Record<string, unknown> | undefined): SalesSourceSums {
  return {
    rowCount: Number(row?.rowCount ?? row?.row_count ?? 0),
    quantity: Number(row?.quantity ?? 0),
    gmv: Number(row?.gmv ?? 0),
    shipmentValue: Number(row?.shipmentValue ?? row?.shipment_value ?? 0),
  };
}

async function selectFrontProfitSalesL1Sums(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    sourceId: number;
  },
): Promise<SalesSourceSums> {
  const [row] = await executor.unsafe(
    `SELECT COUNT(*)::int AS "rowCount",
            COALESCE(SUM((row_payload->>'quantity')::numeric), 0)::float8 AS "quantity",
            COALESCE(SUM((row_payload->>'sales_gmv')::numeric), 0)::float8 AS "gmv",
            COALESCE(SUM((row_payload->>'sales_shipment_value')::numeric), 0)::float8 AS "shipmentValue"
       FROM public.front_profit_l1_source_row
      WHERE run_id = $1 AND period = $2 AND source_id = $3 AND source_family = $4`,
    [input.runId, input.period, input.sourceId, FRONT_PROFIT_SALES_SOURCE_FAMILY],
  );
  return parseSalesSourceSums(row);
}

async function upsertFrontProfitSalesReconMetric(
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

function salesReconResults(
  input: {
    sourceId: number;
    period: string;
    expected: SalesSourceSums;
    l1: SalesSourceSums;
  },
): FrontProfitReconMetric[] {
  const fields = [
    ["row_count", input.expected.rowCount, input.l1.rowCount, 0],
    ["quantity_sum", input.expected.quantity, input.l1.quantity, FRONT_PROFIT_MONEY_TOLERANCE],
    ["gmv_sum", input.expected.gmv, input.l1.gmv, FRONT_PROFIT_MONEY_TOLERANCE],
    ["shipment_value_sum", input.expected.shipmentValue, input.l1.shipmentValue, FRONT_PROFIT_MONEY_TOLERANCE],
  ] as const;

  return fields.map(([metric, expected, actual, tolerance]) => ({
    layer: "SALES_SOURCE_L1",
    metric: sourceMetric(input.sourceId, metric),
    expected,
    actual,
    tolerance,
    passed: Math.abs(actual - expected) <= tolerance,
    evidenceRef: {
      sourceId: input.sourceId,
      period: input.period,
      sourceFamily: FRONT_PROFIT_SALES_SOURCE_FAMILY,
      sourceContractVersion: FRONT_PROFIT_SALES_SOURCE_VERSION,
    },
  }));
}

export function assertFrontProfitSalesSourceHeaders(headers: readonly unknown[]): void {
  const normalized = headers.map(normalizedText);
  const expected = [...FRONT_PROFIT_SALES_SOURCE_HEADERS];
  if (
    normalized.length !== expected.length
    || normalized.some((header, index) => header !== expected[index])
  ) {
    throw new Error("front-profit sales source headers do not match front-profit-sales-source/v1");
  }
}

export function normalizeFrontProfitSalesSourceRows(input: {
  runId: number;
  sourceId: number;
  sourceFile?: string | null;
  firstDataRowNumber?: number;
  rows: FrontProfitSalesSourceRawRow[];
}): FrontProfitSalesSourceRow[] {
  const runId = assertPositiveSafeId(input.runId, "runId");
  const sourceId = assertPositiveSafeId(input.sourceId, "sourceId");
  const sourceFile = optionalText(input.sourceFile);
  const firstDataRowNumber = input.firstDataRowNumber ?? 2;

  return input.rows.map((row, index) => {
    const sourceRowNo = firstDataRowNumber + index;
    const saleDate = assertIsoDateValue(row["销售日期"], `row ${sourceRowNo} 销售日期`);
    const normalized: FrontProfitSalesSourceRow = {
      runId,
      sourceId,
      sourceRowNo,
      period: deriveFrontProfitPeriod(saleDate),
      saleKey: requiredText(row["销售ID"], `row ${sourceRowNo} 销售ID`),
      saleDate,
      platform: requiredText(row["平台"], `row ${sourceRowNo} 平台`),
      businessMode: requiredText(row["业务模式"], `row ${sourceRowNo} 业务模式`),
      groupName: optionalText(row["组"]),
      shop: requiredText(row["店铺"], `row ${sourceRowNo} 店铺`),
      shopNormalized: optionalText(row["店铺2"]),
      skuKey: optionalText(row.SKU),
      adAccountKey: optionalText(row["广告账户"]),
      productOwnerKey: optionalText(row["产品负责人"]),
      orderOwnerKey: optionalText(row["订单负责人"]),
      manualMappingKey: optionalText(row["手工映射键"]),
      quantity: strictNumber(row["单量"], `row ${sourceRowNo} 单量`),
      gmv: strictNumber(row.GMV, `row ${sourceRowNo} GMV`),
      shipmentValue: row["出货货值"] == null || normalizedText(row["出货货值"]) === ""
        ? 0
        : strictNumber(row["出货货值"], `row ${sourceRowNo} 出货货值`),
      sourceFile,
      sourceBatch: optionalText(row["来源批次"]),
      note: optionalText(row["备注"]),
    };
    return {
      ...normalized,
      rowPayload: {
        ...row,
        sourceFamily: FRONT_PROFIT_SALES_SOURCE_FAMILY,
        sourceContractVersion: FRONT_PROFIT_SALES_SOURCE_VERSION,
        sourceFile,
        sourceBatch: normalized.sourceBatch,
        sourceRecordKey: normalized.saleKey,
      },
    };
  });
}

export function frontProfitSalesAppliedRowToL1Input(
  row: FrontProfitSalesAppliedRow,
): FrontProfitL1SourceRowInput {
  return {
    runId: row.runId,
    sourceId: row.sourceId,
    sourceRowNo: row.sourceRowNo,
    period: row.period,
    sourceFamily: FRONT_PROFIT_SALES_SOURCE_FAMILY,
    sourceRecordKey: row.saleKey,
    eventDate: row.saleDate,
    platform: row.platform,
    shop: row.shop,
    operatorKey: row.operatorKey,
    skuKey: row.skuKey,
    amountKind: FRONT_PROFIT_SALES_AMOUNT_KIND,
    amountValue: row.gmv,
    quantity: row.quantity,
    currency: "CNY",
    rowPayload: {
      sourceContractVersion: FRONT_PROFIT_SALES_SOURCE_VERSION,
      businessMode: row.businessMode,
      groupName: row.groupName,
      shopNormalized: row.shopNormalized,
      adAccountKey: row.adAccountKey,
      productOwnerKey: row.productOwnerKey,
      orderOwnerKey: row.orderOwnerKey,
      manualMappingKey: row.manualMappingKey,
      matchedAuthorityKeyType: row.matchedAuthorityKeyType,
      matchedAuthorityKey: row.matchedAuthorityKey,
      detailKey: `sales:${row.saleKey}`,
      recordId: `SALES_L3_${row.saleKey}`,
      calculationRole: "sales_contribution",
      quantity: row.quantity,
      gmv: row.gmv,
      sales_gmv: row.gmv,
      shipment_value: row.shipmentValue,
      sales_shipment_value: row.shipmentValue,
      sourceFile: row.sourceFile,
      sourceBatch: row.sourceBatch,
      note: row.note,
      raw: row.rowPayload ?? {},
    },
  };
}

export async function loadFrontProfitSalesSource(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    rows: FrontProfitSalesSourceRow[];
    insertOnlyIfEmpty?: boolean;
  },
): Promise<FrontProfitSalesLoadResult> {
  if (input.rows.length === 0) {
    return { appliedRows: [], l1RowCount: 0, reconResults: [] };
  }

  const first = input.rows[0]!;
  const runId = assertPositiveSafeId(first.runId, "runId");
  const sourceId = assertPositiveSafeId(first.sourceId, "sourceId");
  const period = first.period;
  if (input.rows.some((row) => row.runId !== runId || row.sourceId !== sourceId || row.period !== period)) {
    throw new Error("front-profit sales source load must receive one run/source/period at a time");
  }

  const shops = [...new Set(input.rows.map((row) => row.shop))].sort();
  const assignments = await selectFrontProfitOperatorAssignmentsForShops(executor, { runId, shops });
  const resolveOperator = createFrontProfitOperatorResolver(assignments);
  const appliedRows = input.rows.map((row) => {
    const assignment = resolveOperator({
      shop: row.shop,
      date: row.saleDate,
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

  const l1Rows = appliedRows.map(frontProfitSalesAppliedRowToL1Input);
  const l1Result = await upsertFrontProfitL1SourceRows(executor, {
    rows: l1Rows,
    insertOnlyIfEmpty: input.insertOnlyIfEmpty,
  });
  const expected = {
    rowCount: appliedRows.length,
    quantity: appliedRows.reduce((total, row) => total + row.quantity, 0),
    gmv: appliedRows.reduce((total, row) => total + row.gmv, 0),
    shipmentValue: appliedRows.reduce((total, row) => total + row.shipmentValue, 0),
  };
  const l1 = await selectFrontProfitSalesL1Sums(executor, { runId, period, sourceId });
  const reconResults = salesReconResults({ sourceId, period, expected, l1 });
  for (const result of reconResults) {
    await upsertFrontProfitSalesReconMetric(executor, runId, result);
  }

  return {
    appliedRows,
    l1RowCount: l1Result.rowCount,
    reconResults,
    l1WritePath: l1Result.writePath,
    l1WritePhaseTimings: l1Result.phaseTimings,
  };
}

export async function stageFrontProfitSalesL1ToL3(
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
    sourceFamily: FRONT_PROFIT_SALES_SOURCE_FAMILY,
    mappingVersionId: input.mappingVersionId,
    ruleVersion: input.ruleVersion ?? FRONT_PROFIT_SALES_SOURCE_VERSION,
    jobVersion: input.jobVersion,
  });
}

export async function aggregateFrontProfitSalesL3ToL4(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    writeRecon?: boolean;
  },
): Promise<FrontProfitL3L4AggregationResult> {
  return aggregateFrontProfitL3ToL4(executor, input);
}

export async function writeFrontProfitSalesShadowReconciliation(
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

export function frontProfitSalesAppliedRowsToManualBaseline(
  rows: FrontProfitSalesAppliedRow[],
): FrontProfitL4AggRowForContract[] {
  const grouped = new Map<string, FrontProfitSalesAppliedRow[]>();
  for (const row of rows) {
    const key = [
      row.saleDate,
      row.platform,
      row.businessMode,
      row.shop,
      row.operatorKey,
    ].join("\u001f");
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  return [...grouped.values()].map((group) => {
    const first = group[0]!;
    const quantity = group.reduce((total, row) => total + row.quantity, 0);
    const gmv = group.reduce((total, row) => total + row.gmv, 0);
    const shipmentValue = group.reduce((total, row) => total + row.shipmentValue, 0);
    const derived = calculateFrontProfitDerivedValues((field) => ({
      GMV: gmv,
      补单金额: 0,
      补单产品成本: 0,
      产品成本: 0,
      出货货值: shipmentValue,
      "平台扣点/毛保": 0,
      税点: 0,
      财务成本: 0,
      运费: 0,
      佣金: 0,
      推广费: 0,
    })[field]);

    return {
      date: first.saleDate,
      platform: first.platform,
      businessMode: first.businessMode,
      groupName: first.groupName,
      shop: first.shop,
      shopNormalized: first.shopNormalized,
      operator: first.operatorKey,
      quantity,
      gmv,
      fillOrderAmount: 0,
      fillOrderProductCost: 0,
      fillOrderQuantity: 0,
      productCost: 0,
      shipmentValue,
      platformFee: 0,
      taxFee: 0,
      financeCost: 0,
      freight: 0,
      commission: 0,
      promotionFee: 0,
      sourceFile: first.sourceFile,
      sourceBatch: first.sourceBatch,
      note: "manual 01 baseline derived from sales source fixture",
      realRevenue: derived["真实营业额"],
      frontProfit: derived["前台利润"],
      paidRatio: derived["付费占比"],
      recordId: `MANUAL_SALES_BASELINE_${first.saleKey}`,
      dataStatus: "manual_baseline",
    };
  });
}
