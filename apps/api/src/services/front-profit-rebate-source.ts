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
import { deriveFrontProfitPeriod } from "./front-profit-period.js";
import { normalizeFrontProfitDate } from "./front-profit-standard.js";
import {
  assertUniqueFrontProfitRebateKeys,
} from "./front-profit-business-rules.js";

export const FRONT_PROFIT_REBATE_SOURCE_VERSION = "front-profit-rebate-source/v1" as const;
export const FRONT_PROFIT_REBATE_SOURCE_FAMILY = "rebate" as const;
export const FRONT_PROFIT_REBATE_SOURCE_AMOUNT_KIND = "rebate_fact" as const;

const FRONT_PROFIT_REBATE_BULK_WRITE_BATCH_SIZE = 1_000;

export const FRONT_PROFIT_REBATE_SOURCE_HEADERS = [
  "补单ID",
  "归属日期",
  "平台",
  "业务模式",
  "组",
  "店铺",
  "店铺2",
  "运营",
  "SKU",
  "订单号",
  "补单金额",
  "补单产品成本",
  "补单单量",
  "来源批次",
  "备注",
] as const;

export type FrontProfitRebateSourceHeader = typeof FRONT_PROFIT_REBATE_SOURCE_HEADERS[number];
export type FrontProfitRebateSourceRawRow = Partial<Record<FrontProfitRebateSourceHeader, unknown>>;

export type FrontProfitRebateSourceRow = {
  runId: number;
  sourceId: number;
  sourceRowNo: number;
  period: string;
  rebateKey: string;
  rebateEventDate: string;
  platform: string;
  businessMode: string;
  groupName?: string | null;
  shop: string;
  shopNormalized?: string | null;
  operatorKey: string;
  skuKey?: string | null;
  orderKey?: string | null;
  fillOrderAmount: number;
  fillOrderProductCost: number;
  fillOrderQuantity: number;
  sourceFile?: string | null;
  sourceBatch?: string | null;
  note?: string | null;
  rowPayload?: Record<string, unknown>;
};

export type FrontProfitRebateLoadResult = {
  factRowCount: number;
  l1RowCount: number;
  reconResults: FrontProfitReconMetric[];
};

type RebateSourceSums = {
  rowCount: number;
  fillOrderAmount: number;
  fillOrderProductCost: number;
  fillOrderQuantity: number;
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

function parseSums(row: Record<string, unknown> | undefined): RebateSourceSums {
  return {
    rowCount: Number(row?.rowCount ?? row?.row_count ?? 0),
    fillOrderAmount: Number(row?.fillOrderAmount ?? row?.fill_order_amount ?? 0),
    fillOrderProductCost: Number(row?.fillOrderProductCost ?? row?.fill_order_product_cost ?? 0),
    fillOrderQuantity: Number(row?.fillOrderQuantity ?? row?.fill_order_quantity ?? 0),
  };
}

async function upsertFrontProfitRebateFacts(
  executor: FrontProfitLayerSqlExecutor,
  rows: FrontProfitRebateSourceRow[],
): Promise<FrontProfitLayerRowCount> {
  if (rows.length === 0) return { rowCount: 0 };
  if (rows.length > FRONT_PROFIT_REBATE_BULK_WRITE_BATCH_SIZE) {
    let rowCount = 0;
    for (let index = 0; index < rows.length; index += FRONT_PROFIT_REBATE_BULK_WRITE_BATCH_SIZE) {
      const inserted = await upsertFrontProfitRebateFacts(
        executor,
        rows.slice(index, index + FRONT_PROFIT_REBATE_BULK_WRITE_BATCH_SIZE),
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
    const rebateEventDate = assertIsoDateValue(row.rebateEventDate, "rebateEventDate");
    const period = deriveFrontProfitPeriod(rebateEventDate);

    placeholders.push(
      `(${Array.from({ length: 14 }, () => `$${paramIndex++}`).join(", ")}, $${paramIndex++}::jsonb)`,
    );
    parameters.push(
      runId,
      sourceId,
      sourceRowNo,
      period,
      requiredText(row.rebateKey, "rebateKey"),
      rebateEventDate,
      optionalText(row.platform),
      optionalText(row.shop),
      optionalText(row.operatorKey),
      optionalText(row.skuKey),
      optionalText(row.orderKey),
      decimalText(row.fillOrderAmount),
      decimalText(row.fillOrderProductCost),
      decimalText(row.fillOrderQuantity),
      row.rowPayload ?? {},
    );
  }

  const inserted = await executor.unsafe(
    `INSERT INTO public.front_profit_rebate_fact
       (run_id, source_id, source_row_no, period, rebate_key, rebate_event_date,
        platform, shop, operator_key, sku_key, order_key, fill_order_amount,
        fill_order_product_cost, fill_order_quantity, row_payload)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (run_id, rebate_key) DO UPDATE SET
       source_id = EXCLUDED.source_id,
       source_row_no = EXCLUDED.source_row_no,
       period = EXCLUDED.period,
       rebate_event_date = EXCLUDED.rebate_event_date,
       platform = EXCLUDED.platform,
       shop = EXCLUDED.shop,
       operator_key = EXCLUDED.operator_key,
       sku_key = EXCLUDED.sku_key,
       order_key = EXCLUDED.order_key,
       fill_order_amount = EXCLUDED.fill_order_amount,
       fill_order_product_cost = EXCLUDED.fill_order_product_cost,
       fill_order_quantity = EXCLUDED.fill_order_quantity,
       row_payload = EXCLUDED.row_payload
     RETURNING id`,
    parameters,
  );

  return { rowCount: inserted.length };
}

async function selectFrontProfitRebateFactSums(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    sourceId: number;
  },
): Promise<RebateSourceSums> {
  const [row] = await executor.unsafe(
    `SELECT COUNT(*)::int AS "rowCount",
            COALESCE(SUM(fill_order_amount), 0)::float8 AS "fillOrderAmount",
            COALESCE(SUM(fill_order_product_cost), 0)::float8 AS "fillOrderProductCost",
            COALESCE(SUM(fill_order_quantity), 0)::float8 AS "fillOrderQuantity"
       FROM public.front_profit_rebate_fact
      WHERE run_id = $1 AND period = $2 AND source_id = $3`,
    [input.runId, input.period, input.sourceId],
  );
  return parseSums(row);
}

async function selectFrontProfitRebateL1Sums(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    sourceId: number;
  },
): Promise<RebateSourceSums> {
  const [row] = await executor.unsafe(
    `SELECT COUNT(*)::int AS "rowCount",
            COALESCE(SUM((row_payload->>'fill_order_amount')::numeric), 0)::float8 AS "fillOrderAmount",
            COALESCE(SUM((row_payload->>'fill_order_product_cost')::numeric), 0)::float8 AS "fillOrderProductCost",
            COALESCE(SUM((row_payload->>'fill_order_quantity')::numeric), 0)::float8 AS "fillOrderQuantity"
       FROM public.front_profit_l1_source_row
      WHERE run_id = $1 AND period = $2 AND source_id = $3 AND source_family = $4`,
    [input.runId, input.period, input.sourceId, FRONT_PROFIT_REBATE_SOURCE_FAMILY],
  );
  return parseSums(row);
}

async function upsertFrontProfitRebateReconMetric(
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

function rebateReconResults(
  input: {
    sourceId: number;
    period: string;
    fact: RebateSourceSums;
    l1: RebateSourceSums;
  },
): FrontProfitReconMetric[] {
  const fields = [
    ["row_count", input.fact.rowCount, input.l1.rowCount, 0],
    ["fill_order_amount_sum", input.fact.fillOrderAmount, input.l1.fillOrderAmount, FRONT_PROFIT_MONEY_TOLERANCE],
    ["fill_order_product_cost_sum", input.fact.fillOrderProductCost, input.l1.fillOrderProductCost, FRONT_PROFIT_MONEY_TOLERANCE],
    ["fill_order_quantity_sum", input.fact.fillOrderQuantity, input.l1.fillOrderQuantity, 0.000001],
  ] as const;

  return fields.map(([metric, expected, actual, tolerance]) => ({
    layer: "REBATE_SOURCE_L1",
    metric: sourceMetric(input.sourceId, metric),
    expected,
    actual,
    tolerance,
    passed: Math.abs(actual - expected) <= tolerance,
    evidenceRef: {
      sourceId: input.sourceId,
      period: input.period,
      sourceFamily: FRONT_PROFIT_REBATE_SOURCE_FAMILY,
      sourceContractVersion: FRONT_PROFIT_REBATE_SOURCE_VERSION,
    },
  }));
}

export function assertFrontProfitRebateSourceHeaders(headers: readonly unknown[]): void {
  const normalized = headers.map(normalizedText);
  const expected = [...FRONT_PROFIT_REBATE_SOURCE_HEADERS];
  if (
    normalized.length !== expected.length
    || normalized.some((header, index) => header !== expected[index])
  ) {
    throw new Error("front-profit rebate source headers do not match front-profit-rebate-source/v1");
  }
}

export function normalizeFrontProfitRebateSourceRows(input: {
  runId: number;
  sourceId: number;
  sourceFile?: string | null;
  firstDataRowNumber?: number;
  rows: FrontProfitRebateSourceRawRow[];
}): FrontProfitRebateSourceRow[] {
  const runId = assertPositiveSafeId(input.runId, "runId");
  const sourceId = assertPositiveSafeId(input.sourceId, "sourceId");
  const firstDataRowNumber = input.firstDataRowNumber ?? 2;

  const rows = input.rows.map((row, index) => {
    const sourceRowNo = firstDataRowNumber + index;
    const rebateEventDate = assertIsoDateValue(row["归属日期"], `row ${sourceRowNo} 归属日期`);
    const rebateKey = requiredText(row["补单ID"], `row ${sourceRowNo} 补单ID`);
    const period = deriveFrontProfitPeriod(rebateEventDate);
    const normalized: FrontProfitRebateSourceRow = {
      runId,
      sourceId,
      sourceRowNo,
      period,
      rebateKey,
      rebateEventDate,
      platform: requiredText(row["平台"], `row ${sourceRowNo} 平台`),
      businessMode: requiredText(row["业务模式"], `row ${sourceRowNo} 业务模式`),
      groupName: optionalText(row["组"]),
      shop: requiredText(row["店铺"], `row ${sourceRowNo} 店铺`),
      shopNormalized: optionalText(row["店铺2"]),
      operatorKey: requiredText(row["运营"], `row ${sourceRowNo} 运营`),
      skuKey: optionalText(row.SKU),
      orderKey: optionalText(row["订单号"]),
      fillOrderAmount: strictNumber(row["补单金额"], `row ${sourceRowNo} 补单金额`),
      fillOrderProductCost: strictNumber(row["补单产品成本"], `row ${sourceRowNo} 补单产品成本`),
      fillOrderQuantity: strictNumber(row["补单单量"], `row ${sourceRowNo} 补单单量`),
      sourceFile: optionalText(input.sourceFile),
      sourceBatch: optionalText(row["来源批次"]),
      note: optionalText(row["备注"]),
    };
    return {
      ...normalized,
      rowPayload: {
        ...row,
        sourceFamily: FRONT_PROFIT_REBATE_SOURCE_FAMILY,
        sourceContractVersion: FRONT_PROFIT_REBATE_SOURCE_VERSION,
        sourceFile: normalized.sourceFile,
        sourceBatch: normalized.sourceBatch,
      },
    };
  });

  assertUniqueFrontProfitRebateKeys(rows.map((row) => ({
    rebateKey: row.rebateKey,
    rowNumber: row.sourceRowNo,
  })));
  return rows;
}

export function frontProfitRebateSourceRowToL1Input(
  row: FrontProfitRebateSourceRow,
): FrontProfitL1SourceRowInput {
  return {
    runId: row.runId,
    sourceId: row.sourceId,
    sourceRowNo: row.sourceRowNo,
    period: row.period,
    sourceFamily: FRONT_PROFIT_REBATE_SOURCE_FAMILY,
    sourceRecordKey: row.rebateKey,
    eventDate: row.rebateEventDate,
    platform: row.platform,
    shop: row.shop,
    operatorKey: row.operatorKey,
    skuKey: row.skuKey,
    amountKind: FRONT_PROFIT_REBATE_SOURCE_AMOUNT_KIND,
    amountValue: row.fillOrderAmount,
    quantity: 0,
    currency: "CNY",
    rowPayload: {
      sourceFamily: FRONT_PROFIT_REBATE_SOURCE_FAMILY,
      sourceContractVersion: FRONT_PROFIT_REBATE_SOURCE_VERSION,
      rebateKey: row.rebateKey,
      orderKey: row.orderKey,
      skuKey: row.skuKey,
      businessMode: row.businessMode,
      groupName: row.groupName,
      shopNormalized: row.shopNormalized,
      detailKey: `rebate:${row.rebateKey}`,
      recordId: `REBATE_L3_${row.rebateKey}`,
      calculationRole: "rebate_contribution",
      quantity: 0,
      gmv: 0,
      fill_order_amount: row.fillOrderAmount,
      fill_order_product_cost: row.fillOrderProductCost,
      fill_order_quantity: row.fillOrderQuantity,
      product_cost: 0,
      shipment_value: 0,
      platform_fee: 0,
      tax_fee: 0,
      finance_cost: 0,
      freight: 0,
      commission: 0,
      promotion_fee: 0,
      sourceFile: row.sourceFile,
      sourceBatch: row.sourceBatch,
      note: row.note,
      raw: row.rowPayload ?? {},
    },
  };
}

export async function loadFrontProfitRebateSource(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    rows: FrontProfitRebateSourceRow[];
  },
): Promise<FrontProfitRebateLoadResult> {
  if (input.rows.length === 0) {
    return { factRowCount: 0, l1RowCount: 0, reconResults: [] };
  }

  assertUniqueFrontProfitRebateKeys(input.rows.map((row) => ({
    rebateKey: row.rebateKey,
    rowNumber: row.sourceRowNo,
  })));
  const first = input.rows[0]!;
  const runId = assertPositiveSafeId(first.runId, "runId");
  const sourceId = assertPositiveSafeId(first.sourceId, "sourceId");
  const period = first.period;
  if (input.rows.some((row) => row.runId !== runId || row.sourceId !== sourceId || row.period !== period)) {
    throw new Error("front-profit rebate source load must receive one run/source/period at a time");
  }

  const factResult = await upsertFrontProfitRebateFacts(executor, input.rows);
  const l1Rows = input.rows.map(frontProfitRebateSourceRowToL1Input);
  const l1Result = await upsertFrontProfitL1SourceRows(executor, { rows: l1Rows });
  const [fact, l1] = await Promise.all([
    selectFrontProfitRebateFactSums(executor, { runId, period, sourceId }),
    selectFrontProfitRebateL1Sums(executor, { runId, period, sourceId }),
  ]);
  const reconResults = rebateReconResults({ sourceId, period, fact, l1 });
  for (const result of reconResults) {
    await upsertFrontProfitRebateReconMetric(executor, runId, result);
  }

  return {
    factRowCount: factResult.rowCount,
    l1RowCount: l1Result.rowCount,
    reconResults,
  };
}

export async function stageFrontProfitRebateL1ToL3(
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
    sourceFamily: FRONT_PROFIT_REBATE_SOURCE_FAMILY,
    mappingVersionId: input.mappingVersionId,
    ruleVersion: input.ruleVersion ?? FRONT_PROFIT_REBATE_SOURCE_VERSION,
    jobVersion: input.jobVersion,
  });
}

export async function aggregateFrontProfitRebateL3ToL4(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    writeRecon?: boolean;
  },
): Promise<FrontProfitL3L4AggregationResult> {
  return aggregateFrontProfitL3ToL4(executor, input);
}

export async function writeFrontProfitRebateShadowReconciliation(
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

export function frontProfitRebateSourceRowsToManualBaseline(
  rows: FrontProfitRebateSourceRow[],
): FrontProfitL4AggRowForContract[] {
  const grouped = new Map<string, FrontProfitRebateSourceRow[]>();
  for (const row of rows) {
    const key = [
      row.rebateEventDate,
      row.platform,
      row.businessMode,
      row.shop,
      row.operatorKey,
    ].join("\u001f");
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  return [...grouped.values()].map((group) => {
    const first = group[0]!;
    const fillOrderAmount = group.reduce((total, row) => total + row.fillOrderAmount, 0);
    const fillOrderProductCost = group.reduce((total, row) => total + row.fillOrderProductCost, 0);
    const fillOrderQuantity = group.reduce((total, row) => total + row.fillOrderQuantity, 0);
    const derived = calculateFrontProfitDerivedValues((field) => ({
      GMV: 0,
      补单金额: fillOrderAmount,
      补单产品成本: fillOrderProductCost,
      产品成本: 0,
      出货货值: 0,
      "平台扣点/毛保": 0,
      税点: 0,
      财务成本: 0,
      运费: 0,
      佣金: 0,
      推广费: 0,
    })[field]);

    return {
      date: first.rebateEventDate,
      platform: first.platform,
      businessMode: first.businessMode,
      groupName: first.groupName,
      shop: first.shop,
      shopNormalized: first.shopNormalized,
      operator: first.operatorKey,
      quantity: 0,
      gmv: 0,
      fillOrderAmount,
      fillOrderProductCost,
      fillOrderQuantity,
      productCost: 0,
      shipmentValue: 0,
      platformFee: 0,
      taxFee: 0,
      financeCost: 0,
      freight: 0,
      commission: 0,
      promotionFee: 0,
      sourceFile: first.sourceFile,
      sourceBatch: first.sourceBatch,
      note: "manual 01 baseline derived from rebate source fixture",
      realRevenue: derived["真实营业额"],
      frontProfit: derived["前台利润"],
      paidRatio: derived["付费占比"],
      recordId: `MANUAL_REBATE_BASELINE_${first.rebateKey}`,
      dataStatus: "manual_baseline",
    };
  });
}
