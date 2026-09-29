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
import { deriveFrontProfitPeriod } from "./front-profit-period.js";
import { normalizeFrontProfitDate } from "./front-profit-standard.js";
import {
  createFrontProfitCostPeriodResolver,
  FrontProfitBusinessRuleBlockError,
  type FrontProfitCostPeriod,
} from "./front-profit-business-rules.js";

export const FRONT_PROFIT_COST_SOURCE_VERSION = "front-profit-cost-source/v1" as const;
export const FRONT_PROFIT_COST_SOURCE_FAMILY = "cost_period" as const;
export const FRONT_PROFIT_COST_APPLIED_SOURCE_FAMILY = "cost_applied" as const;
export const FRONT_PROFIT_COST_SOURCE_AMOUNT_KIND = "unit_cost" as const;
export const FRONT_PROFIT_COST_APPLIED_AMOUNT_KIND = "product_cost" as const;

const FRONT_PROFIT_COST_BULK_WRITE_BATCH_SIZE = 1_000;

export const FRONT_PROFIT_COST_SOURCE_HEADERS = [
  "SKU",
  "成本类型",
  "生效开始",
  "生效结束",
  "单位成本",
  "币种",
  "来源批次",
  "备注",
] as const;

export const FRONT_PROFIT_COST_USAGE_HEADERS = [
  "出货ID",
  "发货日期",
  "平台",
  "业务模式",
  "组",
  "店铺",
  "店铺2",
  "运营",
  "SKU",
  "出货数量",
  "出货货值",
  "来源批次",
  "备注",
] as const;

export type FrontProfitCostSourceHeader = typeof FRONT_PROFIT_COST_SOURCE_HEADERS[number];
export type FrontProfitCostUsageHeader = typeof FRONT_PROFIT_COST_USAGE_HEADERS[number];
export type FrontProfitCostSourceRawRow = Partial<Record<FrontProfitCostSourceHeader, unknown>>;
export type FrontProfitCostUsageRawRow = Partial<Record<FrontProfitCostUsageHeader, unknown>>;

export type FrontProfitCostSourceRow = {
  runId: number;
  sourceId: number;
  sourceRowNo: number;
  period: string;
  skuKey: string;
  costKind: "product_cost";
  effectiveFrom: string;
  effectiveTo: string;
  unitCost: number;
  currency: string;
  sourceBatch?: string | null;
  note?: string | null;
  rowPayload?: Record<string, unknown>;
};

export type FrontProfitCostUsageRow = {
  runId: number;
  sourceId: number;
  sourceRowNo: number;
  period: string;
  shipmentKey: string;
  shipmentDate: string;
  platform: string;
  businessMode: string;
  groupName?: string | null;
  shop: string;
  shopNormalized?: string | null;
  operatorKey: string;
  skuKey: string;
  quantity: number;
  shipmentValue: number;
  sourceFile?: string | null;
  sourceBatch?: string | null;
  note?: string | null;
  rowPayload?: Record<string, unknown>;
};

export type FrontProfitCostAppliedRow = FrontProfitCostUsageRow & {
  unitCost: number;
  productCost: number;
  costEffectiveFrom: string;
  costEffectiveTo: string;
};

export type FrontProfitCostLoadResult = {
  factRowCount: number;
  l1RowCount: number;
  reconResults: FrontProfitReconMetric[];
};

export type FrontProfitCostApplicationResult = {
  appliedRows: FrontProfitCostAppliedRow[];
  l1RowCount: number;
  reconResults: FrontProfitReconMetric[];
  l1WritePath?: "parameter_batch" | "copy_direct" | "copy_stage_upsert";
  l1WritePhaseTimings?: FrontProfitLayerPhaseTiming[];
};

type CostSourceSums = {
  rowCount: number;
  unitCost: number;
};

type CostAppliedSums = {
  rowCount: number;
  productCost: number;
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
    throw new Error("front-profit cost currency must be a 3-letter ISO code");
  }
  return currency;
}

function decimalText(value: unknown): string {
  const parsed = strictNumber(value, "decimal");
  return Number.isInteger(parsed) ? String(parsed) : String(parsed);
}

function normalizeCostKind(value: unknown): "product_cost" {
  const costKind = requiredText(value, "costKind");
  if (costKind === "product_cost" || costKind === "产品成本") return "product_cost";
  throw new Error("front-profit cost kind must be product_cost");
}

function sourceMetric(sourceId: number, metric: string): string {
  return `source_${sourceId}_${metric}`;
}

function costSourceRecordKey(row: Pick<FrontProfitCostSourceRow, "skuKey" | "costKind" | "effectiveFrom">): string {
  return `${row.skuKey}:${row.costKind}:${row.effectiveFrom}`;
}

function parseCostSourceSums(row: Record<string, unknown> | undefined): CostSourceSums {
  return {
    rowCount: Number(row?.rowCount ?? row?.row_count ?? 0),
    unitCost: Number(row?.unitCost ?? row?.unit_cost ?? 0),
  };
}

function parseCostAppliedSums(row: Record<string, unknown> | undefined): CostAppliedSums {
  return {
    rowCount: Number(row?.rowCount ?? row?.row_count ?? 0),
    productCost: Number(row?.productCost ?? row?.product_cost ?? 0),
  };
}

function assertNoCostPeriodOverlaps(rows: FrontProfitCostSourceRow[]): void {
  const grouped = new Map<string, FrontProfitCostSourceRow[]>();
  for (const row of rows) {
    const key = `${row.skuKey}\u001f${row.costKind}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  for (const group of grouped.values()) {
    const sorted = [...group].sort((left, right) =>
      left.effectiveFrom.localeCompare(right.effectiveFrom),
    );
    for (let index = 1; index < sorted.length; index++) {
      const previous = sorted[index - 1]!;
      const current = sorted[index]!;
      if (previous.effectiveTo >= current.effectiveFrom) {
        throw new FrontProfitBusinessRuleBlockError("COST_PERIOD_OVERLAP", {
          skuKey: current.skuKey,
          costKind: current.costKind,
          previous: {
            effectiveFrom: previous.effectiveFrom,
            effectiveTo: previous.effectiveTo,
            rowNumber: previous.sourceRowNo,
          },
          current: {
            effectiveFrom: current.effectiveFrom,
            effectiveTo: current.effectiveTo,
            rowNumber: current.sourceRowNo,
          },
        });
      }
    }
  }
}

async function upsertFrontProfitCostPeriods(
  executor: FrontProfitLayerSqlExecutor,
  rows: FrontProfitCostSourceRow[],
): Promise<FrontProfitLayerRowCount> {
  if (rows.length === 0) return { rowCount: 0 };
  if (rows.length > FRONT_PROFIT_COST_BULK_WRITE_BATCH_SIZE) {
    let rowCount = 0;
    for (let index = 0; index < rows.length; index += FRONT_PROFIT_COST_BULK_WRITE_BATCH_SIZE) {
      const inserted = await upsertFrontProfitCostPeriods(
        executor,
        rows.slice(index, index + FRONT_PROFIT_COST_BULK_WRITE_BATCH_SIZE),
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
    const effectiveFrom = assertIsoDateValue(row.effectiveFrom, "effectiveFrom");
    const effectiveTo = assertIsoDateValue(row.effectiveTo, "effectiveTo");
    if (effectiveTo < effectiveFrom) {
      throw new Error("front-profit cost effectiveTo must be on or after effectiveFrom");
    }

    placeholders.push(
      `(${Array.from({ length: 10 }, () => `$${paramIndex++}`).join(", ")}, $${paramIndex++}::jsonb)`,
    );
    parameters.push(
      runId,
      sourceId,
      sourceRowNo,
      deriveFrontProfitPeriod(effectiveFrom),
      requiredText(row.skuKey, "skuKey"),
      row.costKind,
      effectiveFrom,
      effectiveTo,
      decimalText(row.unitCost),
      assertCurrency(row.currency),
      row.rowPayload ?? {},
    );
  }

  const inserted = await executor.unsafe(
    `INSERT INTO public.front_profit_cost_period
       (run_id, source_id, source_row_no, period, sku_key, cost_kind,
        effective_from, effective_to, unit_cost, currency, row_payload)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (run_id, sku_key, cost_kind, effective_from) DO UPDATE SET
       source_id = EXCLUDED.source_id,
       source_row_no = EXCLUDED.source_row_no,
       period = EXCLUDED.period,
       effective_to = EXCLUDED.effective_to,
       unit_cost = EXCLUDED.unit_cost,
       currency = EXCLUDED.currency,
       row_payload = EXCLUDED.row_payload
     RETURNING id`,
    parameters,
  );

  return { rowCount: inserted.length };
}

async function selectFrontProfitCostPeriodSums(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    sourceId: number;
  },
): Promise<CostSourceSums> {
  const [row] = await executor.unsafe(
    `SELECT COUNT(*)::int AS "rowCount",
            COALESCE(SUM(unit_cost), 0)::float8 AS "unitCost"
       FROM public.front_profit_cost_period
      WHERE run_id = $1 AND period = $2 AND source_id = $3`,
    [input.runId, input.period, input.sourceId],
  );
  return parseCostSourceSums(row);
}

async function selectFrontProfitCostPeriodL1Sums(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    sourceId: number;
  },
): Promise<CostSourceSums> {
  const [row] = await executor.unsafe(
    `SELECT COUNT(*)::int AS "rowCount",
            COALESCE(SUM((row_payload->>'unit_cost')::numeric), 0)::float8 AS "unitCost"
       FROM public.front_profit_l1_source_row
      WHERE run_id = $1 AND period = $2 AND source_id = $3 AND source_family = $4`,
    [input.runId, input.period, input.sourceId, FRONT_PROFIT_COST_SOURCE_FAMILY],
  );
  return parseCostSourceSums(row);
}

async function selectFrontProfitCostAppliedL1Sums(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    sourceId: number;
  },
): Promise<CostAppliedSums> {
  const [row] = await executor.unsafe(
    `SELECT COUNT(*)::int AS "rowCount",
            COALESCE(SUM((row_payload->>'product_cost')::numeric), 0)::float8 AS "productCost"
       FROM public.front_profit_l1_source_row
      WHERE run_id = $1 AND period = $2 AND source_id = $3 AND source_family = $4`,
    [input.runId, input.period, input.sourceId, FRONT_PROFIT_COST_APPLIED_SOURCE_FAMILY],
  );
  return parseCostAppliedSums(row);
}

async function selectFrontProfitCostPeriodsForSkus(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    skuKeys: string[];
  },
): Promise<FrontProfitCostPeriod[]> {
  if (input.skuKeys.length === 0) return [];
  const rows = await executor.unsafe(
    `SELECT sku_key AS "skuKey",
            cost_kind AS "costKind",
            effective_from AS "effectiveFrom",
            effective_to AS "effectiveTo",
            unit_cost AS "unitCost"
       FROM public.front_profit_cost_period
      WHERE run_id = $1 AND sku_key = ANY($2::text[]) AND cost_kind = 'product_cost'
      ORDER BY sku_key, effective_from`,
    [input.runId, input.skuKeys],
  );
  return rows.map((row) => ({
    skuKey: requiredText(row.skuKey ?? row.sku_key, "skuKey"),
    costKind: "product_cost",
    effectiveFrom: assertIsoDateValue(row.effectiveFrom ?? row.effective_from, "effectiveFrom"),
    effectiveTo: assertIsoDateValue(row.effectiveTo ?? row.effective_to, "effectiveTo"),
    unitCost: strictNumber(row.unitCost ?? row.unit_cost, "unitCost"),
  }));
}

async function upsertFrontProfitCostReconMetric(
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

function costSourceReconResults(
  input: {
    sourceId: number;
    period: string;
    fact: CostSourceSums;
    l1: CostSourceSums;
  },
): FrontProfitReconMetric[] {
  const fields = [
    ["row_count", input.fact.rowCount, input.l1.rowCount, 0],
    ["unit_cost_sum", input.fact.unitCost, input.l1.unitCost, FRONT_PROFIT_MONEY_TOLERANCE],
  ] as const;

  return fields.map(([metric, expected, actual, tolerance]) => ({
    layer: "COST_SOURCE_L1",
    metric: sourceMetric(input.sourceId, metric),
    expected,
    actual,
    tolerance,
    passed: Math.abs(actual - expected) <= tolerance,
    evidenceRef: {
      sourceId: input.sourceId,
      period: input.period,
      sourceFamily: FRONT_PROFIT_COST_SOURCE_FAMILY,
      sourceContractVersion: FRONT_PROFIT_COST_SOURCE_VERSION,
    },
  }));
}

function costAppliedReconResults(
  input: {
    sourceId: number;
    period: string;
    expected: CostAppliedSums;
    l1: CostAppliedSums;
  },
): FrontProfitReconMetric[] {
  const fields = [
    ["row_count", input.expected.rowCount, input.l1.rowCount, 0],
    ["product_cost_sum", input.expected.productCost, input.l1.productCost, FRONT_PROFIT_MONEY_TOLERANCE],
  ] as const;

  return fields.map(([metric, expected, actual, tolerance]) => ({
    layer: "COST_APPLIED_L1",
    metric: sourceMetric(input.sourceId, metric),
    expected,
    actual,
    tolerance,
    passed: Math.abs(actual - expected) <= tolerance,
    evidenceRef: {
      sourceId: input.sourceId,
      period: input.period,
      sourceFamily: FRONT_PROFIT_COST_APPLIED_SOURCE_FAMILY,
      sourceContractVersion: FRONT_PROFIT_COST_SOURCE_VERSION,
    },
  }));
}

export function assertFrontProfitCostSourceHeaders(headers: readonly unknown[]): void {
  const normalized = headers.map(normalizedText);
  const expected = [...FRONT_PROFIT_COST_SOURCE_HEADERS];
  if (
    normalized.length !== expected.length
    || normalized.some((header, index) => header !== expected[index])
  ) {
    throw new Error("front-profit cost source headers do not match front-profit-cost-source/v1");
  }
}

export function assertFrontProfitCostUsageHeaders(headers: readonly unknown[]): void {
  const normalized = headers.map(normalizedText);
  const expected = [...FRONT_PROFIT_COST_USAGE_HEADERS];
  if (
    normalized.length !== expected.length
    || normalized.some((header, index) => header !== expected[index])
  ) {
    throw new Error("front-profit cost usage headers do not match front-profit-cost-source/v1");
  }
}

export function normalizeFrontProfitCostSourceRows(input: {
  runId: number;
  sourceId: number;
  firstDataRowNumber?: number;
  rows: FrontProfitCostSourceRawRow[];
}): FrontProfitCostSourceRow[] {
  const runId = assertPositiveSafeId(input.runId, "runId");
  const sourceId = assertPositiveSafeId(input.sourceId, "sourceId");
  const firstDataRowNumber = input.firstDataRowNumber ?? 2;
  const rows = input.rows.map((row, index) => {
    const sourceRowNo = firstDataRowNumber + index;
    const effectiveFrom = assertIsoDateValue(row["生效开始"], `row ${sourceRowNo} 生效开始`);
    const effectiveTo = assertIsoDateValue(row["生效结束"], `row ${sourceRowNo} 生效结束`);
    if (effectiveTo < effectiveFrom) {
      throw new Error(`row ${sourceRowNo} 生效结束 must be on or after 生效开始`);
    }
    const normalized: FrontProfitCostSourceRow = {
      runId,
      sourceId,
      sourceRowNo,
      period: deriveFrontProfitPeriod(effectiveFrom),
      skuKey: requiredText(row.SKU, `row ${sourceRowNo} SKU`),
      costKind: normalizeCostKind(row["成本类型"]),
      effectiveFrom,
      effectiveTo,
      unitCost: strictNumber(row["单位成本"], `row ${sourceRowNo} 单位成本`),
      currency: assertCurrency(row["币种"]),
      sourceBatch: optionalText(row["来源批次"]),
      note: optionalText(row["备注"]),
    };
    return {
      ...normalized,
      rowPayload: {
        ...row,
        sourceFamily: FRONT_PROFIT_COST_SOURCE_FAMILY,
        sourceContractVersion: FRONT_PROFIT_COST_SOURCE_VERSION,
        sourceRecordKey: costSourceRecordKey(normalized),
      },
    };
  });
  assertNoCostPeriodOverlaps(rows);
  return rows;
}

export function normalizeFrontProfitCostUsageRows(input: {
  runId: number;
  sourceId: number;
  sourceFile?: string | null;
  firstDataRowNumber?: number;
  rows: FrontProfitCostUsageRawRow[];
}): FrontProfitCostUsageRow[] {
  const runId = assertPositiveSafeId(input.runId, "runId");
  const sourceId = assertPositiveSafeId(input.sourceId, "sourceId");
  const firstDataRowNumber = input.firstDataRowNumber ?? 2;

  return input.rows.map((row, index) => {
    const sourceRowNo = firstDataRowNumber + index;
    const shipmentDate = assertIsoDateValue(row["发货日期"], `row ${sourceRowNo} 发货日期`);
    const normalized: FrontProfitCostUsageRow = {
      runId,
      sourceId,
      sourceRowNo,
      period: deriveFrontProfitPeriod(shipmentDate),
      shipmentKey: requiredText(row["出货ID"], `row ${sourceRowNo} 出货ID`),
      shipmentDate,
      platform: requiredText(row["平台"], `row ${sourceRowNo} 平台`),
      businessMode: requiredText(row["业务模式"], `row ${sourceRowNo} 业务模式`),
      groupName: optionalText(row["组"]),
      shop: requiredText(row["店铺"], `row ${sourceRowNo} 店铺`),
      shopNormalized: optionalText(row["店铺2"]),
      operatorKey: requiredText(row["运营"], `row ${sourceRowNo} 运营`),
      skuKey: requiredText(row.SKU, `row ${sourceRowNo} SKU`),
      quantity: strictNumber(row["出货数量"], `row ${sourceRowNo} 出货数量`),
      shipmentValue: row["出货货值"] == null || normalizedText(row["出货货值"]) === ""
        ? 0
        : strictNumber(row["出货货值"], `row ${sourceRowNo} 出货货值`),
      sourceFile: optionalText(input.sourceFile),
      sourceBatch: optionalText(row["来源批次"]),
      note: optionalText(row["备注"]),
    };
    return {
      ...normalized,
      rowPayload: {
        ...row,
        sourceFamily: FRONT_PROFIT_COST_APPLIED_SOURCE_FAMILY,
        sourceContractVersion: FRONT_PROFIT_COST_SOURCE_VERSION,
        sourceFile: normalized.sourceFile,
        sourceBatch: normalized.sourceBatch,
      },
    };
  });
}

export function frontProfitCostSourceRowToL1Input(
  row: FrontProfitCostSourceRow,
): FrontProfitL1SourceRowInput {
  return {
    runId: row.runId,
    sourceId: row.sourceId,
    sourceRowNo: row.sourceRowNo,
    period: row.period,
    sourceFamily: FRONT_PROFIT_COST_SOURCE_FAMILY,
    sourceRecordKey: costSourceRecordKey(row),
    eventDate: row.effectiveFrom,
    platform: null,
    shop: null,
    operatorKey: null,
    skuKey: row.skuKey,
    amountKind: FRONT_PROFIT_COST_SOURCE_AMOUNT_KIND,
    amountValue: row.unitCost,
    quantity: null,
    currency: row.currency,
    rowPayload: {
      sourceFamily: FRONT_PROFIT_COST_SOURCE_FAMILY,
      sourceContractVersion: FRONT_PROFIT_COST_SOURCE_VERSION,
      sourceRecordKey: costSourceRecordKey(row),
      skuKey: row.skuKey,
      costKind: row.costKind,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      unit_cost: row.unitCost,
      currency: row.currency,
      sourceBatch: row.sourceBatch,
      note: row.note,
      raw: row.rowPayload ?? {},
    },
  };
}

export function frontProfitCostAppliedRowToL1Input(
  row: FrontProfitCostAppliedRow,
): FrontProfitL1SourceRowInput {
  return {
    runId: row.runId,
    sourceId: row.sourceId,
    sourceRowNo: row.sourceRowNo,
    period: row.period,
    sourceFamily: FRONT_PROFIT_COST_APPLIED_SOURCE_FAMILY,
    sourceRecordKey: row.shipmentKey,
    eventDate: row.shipmentDate,
    platform: row.platform,
    shop: row.shop,
    operatorKey: row.operatorKey,
    skuKey: row.skuKey,
    amountKind: FRONT_PROFIT_COST_APPLIED_AMOUNT_KIND,
    amountValue: row.productCost,
    quantity: 0,
    currency: "CNY",
    rowPayload: {
      sourceContractVersion: FRONT_PROFIT_COST_SOURCE_VERSION,
      unitCost: row.unitCost,
      costEffectiveFrom: row.costEffectiveFrom,
      costEffectiveTo: row.costEffectiveTo,
      businessMode: row.businessMode,
      groupName: row.groupName,
      shopNormalized: row.shopNormalized,
      detailKey: `cost:${row.shipmentKey}`,
      recordId: `COST_L3_${row.shipmentKey}`,
      calculationRole: "product_cost_contribution",
      product_cost: row.productCost,
      shipment_value: 0,
      sourceFile: row.sourceFile,
      sourceBatch: row.sourceBatch,
      note: row.note,
      raw: row.rowPayload ?? {},
    },
  };
}

export async function loadFrontProfitCostSource(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    rows: FrontProfitCostSourceRow[];
  },
): Promise<FrontProfitCostLoadResult> {
  if (input.rows.length === 0) {
    return { factRowCount: 0, l1RowCount: 0, reconResults: [] };
  }

  assertNoCostPeriodOverlaps(input.rows);
  const first = input.rows[0]!;
  const runId = assertPositiveSafeId(first.runId, "runId");
  const sourceId = assertPositiveSafeId(first.sourceId, "sourceId");
  const period = first.period;
  if (input.rows.some((row) => row.runId !== runId || row.sourceId !== sourceId || row.period !== period)) {
    throw new Error("front-profit cost source load must receive one run/source/period at a time");
  }

  const factResult = await upsertFrontProfitCostPeriods(executor, input.rows);
  const l1Rows = input.rows.map(frontProfitCostSourceRowToL1Input);
  const l1Result = await upsertFrontProfitL1SourceRows(executor, { rows: l1Rows });
  const [fact, l1] = await Promise.all([
    selectFrontProfitCostPeriodSums(executor, { runId, period, sourceId }),
    selectFrontProfitCostPeriodL1Sums(executor, { runId, period, sourceId }),
  ]);
  const reconResults = costSourceReconResults({ sourceId, period, fact, l1 });
  for (const result of reconResults) {
    await upsertFrontProfitCostReconMetric(executor, runId, result);
  }

  return {
    factRowCount: factResult.rowCount,
    l1RowCount: l1Result.rowCount,
    reconResults,
  };
}

export async function applyFrontProfitCostToUsageRows(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    rows: FrontProfitCostUsageRow[];
    insertOnlyIfEmpty?: boolean;
  },
): Promise<FrontProfitCostApplicationResult> {
  if (input.rows.length === 0) {
    return { appliedRows: [], l1RowCount: 0, reconResults: [] };
  }

  const first = input.rows[0]!;
  const runId = assertPositiveSafeId(first.runId, "runId");
  const sourceId = assertPositiveSafeId(first.sourceId, "sourceId");
  const period = first.period;
  if (input.rows.some((row) => row.runId !== runId || row.sourceId !== sourceId || row.period !== period)) {
    throw new Error("front-profit cost application must receive one run/source/period at a time");
  }

  const skuKeys = [...new Set(input.rows.map((row) => row.skuKey))].sort();
  const costPeriods = await selectFrontProfitCostPeriodsForSkus(executor, { runId, skuKeys });
  const resolveCostPeriod = createFrontProfitCostPeriodResolver(costPeriods);
  const appliedRows = input.rows.map((row) => {
    const periodMatch = resolveCostPeriod({
      skuKey: row.skuKey,
      shipmentDate: row.shipmentDate,
    });
    return {
      ...row,
      unitCost: periodMatch.unitCost,
      productCost: row.quantity * periodMatch.unitCost,
      costEffectiveFrom: periodMatch.effectiveFrom,
      costEffectiveTo: periodMatch.effectiveTo,
    };
  });

  const l1Rows = appliedRows.map(frontProfitCostAppliedRowToL1Input);
  const l1Result = await upsertFrontProfitL1SourceRows(executor, {
    rows: l1Rows,
    insertOnlyIfEmpty: input.insertOnlyIfEmpty,
  });
  const expected = {
    rowCount: appliedRows.length,
    productCost: appliedRows.reduce((total, row) => total + row.productCost, 0),
  };
  const l1 = await selectFrontProfitCostAppliedL1Sums(executor, { runId, period, sourceId });
  const reconResults = costAppliedReconResults({ sourceId, period, expected, l1 });
  for (const result of reconResults) {
    await upsertFrontProfitCostReconMetric(executor, runId, result);
  }

  return {
    appliedRows,
    l1RowCount: l1Result.rowCount,
    reconResults,
    l1WritePath: l1Result.writePath,
    l1WritePhaseTimings: l1Result.phaseTimings,
  };
}

export async function stageFrontProfitCostL1ToL3(
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
    sourceFamily: FRONT_PROFIT_COST_APPLIED_SOURCE_FAMILY,
    mappingVersionId: input.mappingVersionId,
    ruleVersion: input.ruleVersion ?? FRONT_PROFIT_COST_SOURCE_VERSION,
    jobVersion: input.jobVersion,
  });
}

export async function aggregateFrontProfitCostL3ToL4(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    writeRecon?: boolean;
  },
): Promise<FrontProfitL3L4AggregationResult> {
  return aggregateFrontProfitL3ToL4(executor, input);
}

export async function writeFrontProfitCostShadowReconciliation(
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

export function frontProfitCostAppliedRowsToManualBaseline(
  rows: FrontProfitCostAppliedRow[],
): FrontProfitL4AggRowForContract[] {
  const grouped = new Map<string, FrontProfitCostAppliedRow[]>();
  for (const row of rows) {
    const key = [
      row.shipmentDate,
      row.platform,
      row.businessMode,
      row.shop,
      row.operatorKey,
    ].join("\u001f");
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  return [...grouped.values()].map((group) => {
    const first = group[0]!;
    const productCost = group.reduce((total, row) => total + row.productCost, 0);
    const derived = calculateFrontProfitDerivedValues((field) => ({
      GMV: 0,
      补单金额: 0,
      补单产品成本: 0,
      产品成本: productCost,
      出货货值: 0,
      "平台扣点/毛保": 0,
      税点: 0,
      财务成本: 0,
      运费: 0,
      佣金: 0,
      推广费: 0,
    })[field]);

    return {
      date: first.shipmentDate,
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
      productCost,
      shipmentValue: 0,
      platformFee: 0,
      taxFee: 0,
      financeCost: 0,
      freight: 0,
      commission: 0,
      promotionFee: 0,
      sourceFile: first.sourceFile,
      sourceBatch: first.sourceBatch,
      note: "manual 01 baseline derived from cost source fixture",
      realRevenue: derived["真实营业额"],
      frontProfit: derived["前台利润"],
      paidRatio: derived["付费占比"],
      recordId: `MANUAL_COST_BASELINE_${first.shipmentKey}`,
      dataStatus: "manual_baseline",
    };
  });
}
