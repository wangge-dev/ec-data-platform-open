import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  canonicalRowsContract,
  type FrontProfitCanonicalRowsContract,
} from "./front-profit-canonical-rows-contract.js";
import {
  calculateFrontProfitDerivedValues,
  FRONT_PROFIT_DERIVED_FIELDS,
  FRONT_PROFIT_FORMULA_VERSION,
  FRONT_PROFIT_MONEY_INPUT_FIELDS,
  FRONT_PROFIT_MONEY_TOLERANCE,
  frontProfitFormulaSqlExpressions,
  validateFrontProfitFormulaSqlExpressions,
  type FrontProfitFormulaInputField,
} from "./front-profit-formula.js";
import { FRONT_PROFIT_STANDARD_HEADERS, frontProfitAggregationKey } from "./front-profit-standard.js";

export const FRONT_PROFIT_L1_SOURCE_ROW_TABLE = "front_profit_l1_source_row" as const;
export const FRONT_PROFIT_L3_CALC_DETAIL_TABLE = "front_profit_l3_calc_detail" as const;
export const FRONT_PROFIT_L4_AGG_ROW_TABLE = "front_profit_l4_agg_row" as const;

export const FRONT_PROFIT_LAYER_TABLES = [
  FRONT_PROFIT_L1_SOURCE_ROW_TABLE,
  FRONT_PROFIT_L3_CALC_DETAIL_TABLE,
  FRONT_PROFIT_L4_AGG_ROW_TABLE,
] as const;

export const FRONT_PROFIT_LAYER_VERSION = "front-profit-layers/v1" as const;

export type FrontProfitL4AggRowForContract = {
  date: string;
  aggregationKey?: string;
  platform: string;
  businessMode: string;
  groupName?: string | null;
  shop: string;
  shopNormalized?: string | null;
  operator: string;
  quantity: number | string;
  gmv: number | string;
  fillOrderAmount: number | string;
  fillOrderProductCost: number | string;
  fillOrderQuantity: number | string;
  productCost: number | string;
  shipmentValue: number | string;
  platformFee: number | string;
  taxFee: number | string;
  financeCost: number | string;
  freight: number | string;
  commission: number | string;
  promotionFee: number | string;
  sourceFile?: string | null;
  sourceBatch?: string | null;
  note?: string | null;
  realRevenue: number | string;
  frontProfit: number | string;
  paidRatio: number | string;
  recordId: string;
  dataStatus?: string | null;
};

export type FrontProfitLayerSqlExecutor = {
  unsafe(query: string, parameters?: unknown[]): PromiseLike<Array<Record<string, unknown>>>;
};

type FrontProfitLayerCopySqlExecutor = FrontProfitLayerSqlExecutor & {
  (strings: TemplateStringsArray, ...values: unknown[]): {
    writable(): Promise<Writable>;
  };
};

export type FrontProfitL1SourceRowInput = {
  runId: number;
  sourceId: number;
  sourceRowNo: number;
  period: string;
  sourceFamily: string;
  sourceRecordKey: string;
  eventDate: string;
  platform?: string | null;
  shop?: string | null;
  operatorKey?: string | null;
  skuKey?: string | null;
  amountKind: string;
  amountValue?: number | string | null;
  quantity?: number | string | null;
  currency?: string;
  rowPayload?: Record<string, unknown>;
};

export type FrontProfitL3StageOptions = {
  runId: number;
  period: string;
  sourceFamily?: string;
  mappingVersionId?: number | null;
  ruleVersion: string;
  jobVersion: string;
};

export type FrontProfitLayerRowCount = {
  rowCount: number;
  writePath?: "parameter_batch" | "copy_direct" | "copy_stage_upsert";
  phaseTimings?: FrontProfitLayerPhaseTiming[];
};

export type FrontProfitLayerPhaseTiming = {
  phase: string;
  seconds: number;
};

export type FrontProfitReconMetric = {
  layer: string;
  metric: string;
  expected: number | null;
  actual: number | null;
  tolerance: number | null;
  passed: boolean;
  evidenceRef?: Record<string, unknown>;
};

export type FrontProfitL3L4AggregationResult = FrontProfitLayerRowCount & {
  contract: FrontProfitCanonicalRowsContract;
  reconResults: FrontProfitReconMetric[];
};

export type FrontProfitShadowReconResult = {
  reconResults: FrontProfitReconMetric[];
  dqEventCount: number;
};

type L1StoredRow = {
  id: number;
  sourceId: number;
  sourceRowNo: number;
  sourceRecordKey: string;
  eventDate: string;
  platform: string;
  shop: string;
  operatorKey: string;
  amountKind: string;
  amountValue: number;
  quantity: number;
  rowPayload: Record<string, unknown>;
};

const FRONT_PROFIT_INPUT_DB_COLUMNS = [
  "gmv",
  "fill_order_amount",
  "fill_order_product_cost",
  "product_cost",
  "shipment_value",
  "platform_fee",
  "tax_fee",
  "finance_cost",
  "freight",
  "commission",
  "promotion_fee",
] as const;

const FRONT_PROFIT_RECON_NUMERIC_COLUMNS = [
  "quantity",
  "gmv",
  "fill_order_amount",
  "fill_order_product_cost",
  "fill_order_quantity",
  "product_cost",
  "shipment_value",
  "platform_fee",
  "tax_fee",
  "finance_cost",
  "freight",
  "commission",
  "promotion_fee",
] as const;

const FRONT_PROFIT_BULK_WRITE_BATCH_SIZE = 1_000;
const FRONT_PROFIT_L1_COPY_WRITE_MIN_ROWS = 5_000;
const FRONT_PROFIT_L1_COPY_STAGE_TABLE = "front_profit_l1_source_row_stage" as const;

const formulaInputColumnByField = new Map<FrontProfitFormulaInputField, typeof FRONT_PROFIT_INPUT_DB_COLUMNS[number]>(
  FRONT_PROFIT_MONEY_INPUT_FIELDS.map((field, index) => [field, FRONT_PROFIT_INPUT_DB_COLUMNS[index]!]),
);

const FRONT_PROFIT_L3_FIRST_AMOUNT_KIND_PARAMETER = 7;
const formulaInputParameterByColumn = new Map<typeof FRONT_PROFIT_INPUT_DB_COLUMNS[number], number>(
  FRONT_PROFIT_INPUT_DB_COLUMNS.map((column, index) => [
    column,
    FRONT_PROFIT_L3_FIRST_AMOUNT_KIND_PARAMETER + index,
  ] as const),
);

const DERIVED_REAL_REVENUE_FIELD = FRONT_PROFIT_DERIVED_FIELDS[0];
const DERIVED_FRONT_PROFIT_FIELD = FRONT_PROFIT_DERIVED_FIELDS[1];
const DERIVED_PAID_RATIO_FIELD = FRONT_PROFIT_DERIVED_FIELDS[2];

export function frontProfitL4AggRowToCanonicalRow(
  row: FrontProfitL4AggRowForContract,
): unknown[] {
  return [
    row.date,
    row.platform,
    row.businessMode,
    row.groupName ?? "",
    row.shop,
    row.shopNormalized ?? "",
    row.operator,
    row.quantity,
    row.gmv,
    row.fillOrderAmount,
    row.fillOrderProductCost,
    row.fillOrderQuantity,
    row.productCost,
    row.shipmentValue,
    row.platformFee,
    row.taxFee,
    row.financeCost,
    row.freight,
    row.commission,
    row.promotionFee,
    row.sourceFile ?? "",
    row.sourceBatch ?? "",
    row.note ?? "",
    row.realRevenue,
    row.frontProfit,
    row.paidRatio,
    row.recordId,
    row.dataStatus ?? "",
  ];
}

export function frontProfitL4RowsContract(input: {
  rows: FrontProfitL4AggRowForContract[];
  firstDataRowNumber?: number;
}): FrontProfitCanonicalRowsContract {
  return canonicalRowsContract({
    headers: FRONT_PROFIT_STANDARD_HEADERS,
    dataRows: input.rows.map(frontProfitL4AggRowToCanonicalRow),
    firstDataRowNumber: input.firstDataRowNumber,
  });
}

function assertPositiveSafeId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function assertPeriod(value: string): string {
  if (!/^\d{4}-\d{2}$/.test(value)) {
    throw new Error("front-profit period must use YYYY-MM");
  }
  return value;
}

const textValue = (row: Record<string, unknown>, key: string): string =>
  String(row[key] ?? "").trim();

const nullableTextValue = (row: Record<string, unknown>, key: string): string | null => {
  const value = textValue(row, key);
  return value === "" ? null : value;
};

const numericValue = (row: Record<string, unknown>, key: string): string =>
  String(row[key] ?? "0").trim();

function assertPositiveRowNo(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function assertIsoDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD`);
  }
  return value;
}

function assertRequiredText(value: string | null | undefined, label: string): string {
  const trimmed = String(value ?? "").trim();
  if (trimmed === "") {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

function optionalText(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

function numericOrZero(value: unknown): number {
  if (value == null || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) {
    throw new Error(`front-profit numeric value is invalid: ${String(value)}`);
  }
  return parsed;
}

function decimalText(value: unknown): string {
  const parsed = numericOrZero(value);
  return Number.isInteger(parsed) ? String(parsed) : String(parsed);
}

type PreparedFrontProfitL1SourceRow = {
  runId: number;
  sourceId: number;
  sourceRowNo: number;
  period: string;
  sourceFamily: string;
  sourceRecordKey: string;
  eventDate: string;
  platform: string | null;
  shop: string | null;
  operatorKey: string | null;
  skuKey: string | null;
  amountKind: string;
  amountValue: string | null;
  quantity: string | null;
  currency: string;
  rowPayload: Record<string, unknown>;
};

function prepareFrontProfitL1SourceRow(row: FrontProfitL1SourceRowInput): PreparedFrontProfitL1SourceRow {
  const runId = assertPositiveSafeId(row.runId, "runId");
  const sourceId = assertPositiveSafeId(row.sourceId, "sourceId");
  const sourceRowNo = assertPositiveRowNo(row.sourceRowNo, "sourceRowNo");
  const period = assertPeriod(row.period);
  const eventDate = assertIsoDate(row.eventDate, "eventDate");
  const sourceFamily = assertRequiredText(row.sourceFamily, "sourceFamily");
  const sourceRecordKey = assertRequiredText(row.sourceRecordKey, "sourceRecordKey");
  const amountKind = assertRequiredText(row.amountKind, "amountKind");
  const currency = String(row.currency ?? "CNY").trim();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error("front-profit source row currency must be a 3-letter ISO code");
  }

  return {
    runId,
    sourceId,
    sourceRowNo,
    period,
    sourceFamily,
    sourceRecordKey,
    eventDate,
    platform: optionalText(row.platform),
    shop: optionalText(row.shop),
    operatorKey: optionalText(row.operatorKey),
    skuKey: optionalText(row.skuKey),
    amountKind,
    amountValue: row.amountValue == null ? null : decimalText(row.amountValue),
    quantity: row.quantity == null ? null : decimalText(row.quantity),
    currency,
    rowPayload: row.rowPayload ?? {},
  };
}

function canUseFrontProfitL1Copy(executor: FrontProfitLayerSqlExecutor): executor is FrontProfitLayerCopySqlExecutor {
  return typeof executor === "function";
}

function copyCsvCell(value: unknown): string {
  if (value == null) return "\\N";
  return `"${String(value).replaceAll("\"", "\"\"")}"`;
}

function copyCsvRow(values: readonly unknown[]): string {
  return `${values.map(copyCsvCell).join(",")}\n`;
}

function l1CopyRow(row: PreparedFrontProfitL1SourceRow): string {
  return copyCsvRow([
    row.runId,
    row.sourceId,
    row.sourceRowNo,
    row.period,
    row.sourceFamily,
    row.sourceRecordKey,
    row.eventDate,
    row.platform,
    row.shop,
    row.operatorKey,
    row.skuKey,
    row.amountKind,
    row.amountValue,
    row.quantity,
    row.currency,
    JSON.stringify(row.rowPayload),
  ]);
}

function* l1CopyRows(rows: readonly PreparedFrontProfitL1SourceRow[]): Generator<string> {
  for (const row of rows) yield l1CopyRow(row);
}

function layerElapsedSeconds(startedAtMs: number): number {
  return Number(((Date.now() - startedAtMs) / 1000).toFixed(3));
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
  throw new Error("front-profit payload must be a JSON object");
}

function payloadText(payload: Record<string, unknown>, key: string): string | null {
  return optionalText(payload[key]);
}

function payloadNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  if (value == null || value === "") return null;
  return numericOrZero(value);
}

function formulaInputDbColumn(field: FrontProfitFormulaInputField): typeof FRONT_PROFIT_INPUT_DB_COLUMNS[number] {
  const column = formulaInputColumnByField.get(field);
  if (!column) {
    throw new Error(`front-profit formula input field has no L4 column mapping: ${field}`);
  }
  return column;
}

function formulaValueFromRow(row: FrontProfitL4AggRowForContract, field: FrontProfitFormulaInputField): number {
  const column = formulaInputDbColumn(field);
  const values: Record<string, unknown> = {
    gmv: row.gmv,
    fill_order_amount: row.fillOrderAmount,
    fill_order_product_cost: row.fillOrderProductCost,
    product_cost: row.productCost,
    shipment_value: row.shipmentValue,
    platform_fee: row.platformFee,
    tax_fee: row.taxFee,
    finance_cost: row.financeCost,
    freight: row.freight,
    commission: row.commission,
    promotion_fee: row.promotionFee,
  };
  return numericOrZero(values[column]);
}

function frontProfitL4AggregationKey(row: FrontProfitL4AggRowForContract): string {
  return row.aggregationKey ?? frontProfitAggregationKey({
    date: row.date,
    platform: row.platform,
    businessMode: row.businessMode,
    shop: row.shop,
    operator: row.operator,
  });
}

function metricPassed(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

async function upsertFrontProfitReconMetric(
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

async function insertFrontProfitDqEvent(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    severity: "block" | "warn" | "allow";
    code: string;
    sourceId?: number | null;
    rowNo?: number | null;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await executor.unsafe(
    `INSERT INTO public.dq_event
       (run_id, severity, code, source_id, row_no, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.runId,
      input.severity,
      input.code,
      input.sourceId ?? null,
      input.rowNo ?? null,
      input.payload ?? {},
    ],
  );
}

export async function selectFrontProfitL4RowsForRun(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
  },
): Promise<FrontProfitL4AggRowForContract[]> {
  const runId = assertPositiveSafeId(input.runId, "runId");
  const period = assertPeriod(input.period);
  const rows = await executor.unsafe(
    `SELECT date, aggregation_key, platform, business_mode, group_name, shop, shop_normalized, operator,
            quantity, gmv, fill_order_amount, fill_order_product_cost, fill_order_quantity,
            product_cost, shipment_value, platform_fee, tax_fee, finance_cost, freight,
            commission, promotion_fee, source_file, source_batch, note, real_revenue,
            front_profit, paid_ratio, record_id, data_status
       FROM public.front_profit_l4_agg_row
      WHERE run_id = $1 AND period = $2
      ORDER BY id`,
    [runId, period],
  );

  return rows.map((row) => ({
    date: textValue(row, "date"),
    aggregationKey: textValue(row, "aggregation_key"),
    platform: textValue(row, "platform"),
    businessMode: textValue(row, "business_mode"),
    groupName: nullableTextValue(row, "group_name"),
    shop: textValue(row, "shop"),
    shopNormalized: nullableTextValue(row, "shop_normalized"),
    operator: textValue(row, "operator"),
    quantity: numericValue(row, "quantity"),
    gmv: numericValue(row, "gmv"),
    fillOrderAmount: numericValue(row, "fill_order_amount"),
    fillOrderProductCost: numericValue(row, "fill_order_product_cost"),
    fillOrderQuantity: numericValue(row, "fill_order_quantity"),
    productCost: numericValue(row, "product_cost"),
    shipmentValue: numericValue(row, "shipment_value"),
    platformFee: numericValue(row, "platform_fee"),
    taxFee: numericValue(row, "tax_fee"),
    financeCost: numericValue(row, "finance_cost"),
    freight: numericValue(row, "freight"),
    commission: numericValue(row, "commission"),
    promotionFee: numericValue(row, "promotion_fee"),
    sourceFile: nullableTextValue(row, "source_file"),
    sourceBatch: nullableTextValue(row, "source_batch"),
    note: nullableTextValue(row, "note"),
    realRevenue: numericValue(row, "real_revenue"),
    frontProfit: numericValue(row, "front_profit"),
    paidRatio: numericValue(row, "paid_ratio"),
    recordId: textValue(row, "record_id"),
    dataStatus: nullableTextValue(row, "data_status"),
  }));
}

async function upsertFrontProfitL1SourceRowsWithCopy(
  executor: FrontProfitLayerCopySqlExecutor,
  rows: PreparedFrontProfitL1SourceRow[],
): Promise<FrontProfitLayerRowCount> {
  const phaseTimings: FrontProfitLayerPhaseTiming[] = [];
  let phaseStartedAt = Date.now();
  await executor.unsafe(
    `CREATE TEMP TABLE ${FRONT_PROFIT_L1_COPY_STAGE_TABLE} (
       run_id bigint NOT NULL,
       source_id bigint NOT NULL,
       source_row_no integer NOT NULL,
       period varchar(7) NOT NULL,
       source_family varchar(64) NOT NULL,
       source_record_key varchar(192) NOT NULL,
       event_date varchar(10) NOT NULL,
       platform varchar(64),
       shop varchar(128),
       operator_key varchar(128),
       sku_key varchar(128),
       amount_kind varchar(64) NOT NULL,
       amount_value numeric(24, 6),
       quantity numeric(24, 6),
       currency varchar(3) NOT NULL,
       row_payload jsonb NOT NULL
     ) ON COMMIT DROP`,
  );
  phaseTimings.push({ phase: "copy_stage_create", seconds: layerElapsedSeconds(phaseStartedAt) });

  phaseStartedAt = Date.now();
  const writable = await executor`
    COPY front_profit_l1_source_row_stage
      (run_id, source_id, source_row_no, period, source_family, source_record_key,
       event_date, platform, shop, operator_key, sku_key, amount_kind, amount_value,
       quantity, currency, row_payload)
    FROM STDIN WITH (FORMAT csv, NULL '\\N')
  `.writable();
  await pipeline(Readable.from(l1CopyRows(rows)), writable);
  phaseTimings.push({ phase: "copy_stage_load", seconds: layerElapsedSeconds(phaseStartedAt) });

  phaseStartedAt = Date.now();
  const [result] = await executor.unsafe(
    `WITH upserted AS (
       INSERT INTO public.front_profit_l1_source_row
         (run_id, source_id, source_row_no, period, source_family, source_record_key,
          event_date, platform, shop, operator_key, sku_key, amount_kind, amount_value,
          quantity, currency, row_payload)
       SELECT run_id, source_id, source_row_no, period, source_family, source_record_key,
              event_date, platform, shop, operator_key, sku_key, amount_kind, amount_value,
              quantity, currency, row_payload
         FROM ${FRONT_PROFIT_L1_COPY_STAGE_TABLE}
       ON CONFLICT (run_id, source_family, source_record_key, amount_kind) DO UPDATE SET
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
         row_payload = EXCLUDED.row_payload
       RETURNING 1
     )
     SELECT COUNT(*)::int AS row_count FROM upserted`,
  );
  phaseTimings.push({ phase: "copy_stage_upsert", seconds: layerElapsedSeconds(phaseStartedAt) });

  phaseStartedAt = Date.now();
  await executor.unsafe(`DROP TABLE ${FRONT_PROFIT_L1_COPY_STAGE_TABLE}`);
  phaseTimings.push({ phase: "copy_stage_drop", seconds: layerElapsedSeconds(phaseStartedAt) });

  return {
    rowCount: Number(result?.row_count ?? result?.rowCount ?? 0),
    writePath: "copy_stage_upsert",
    phaseTimings,
  };
}

async function canCopyFrontProfitL1RowsDirectly(
  executor: FrontProfitLayerCopySqlExecutor,
  rows: readonly PreparedFrontProfitL1SourceRow[],
): Promise<boolean> {
  const first = rows[0];
  if (!first) return false;
  if (rows.some((row) => row.runId !== first.runId || row.sourceFamily !== first.sourceFamily)) {
    return false;
  }
  const [existing] = await executor.unsafe(
    `SELECT EXISTS (
       SELECT 1
         FROM public.front_profit_l1_source_row
        WHERE run_id = $1 AND source_family = $2
        LIMIT 1
     ) AS has_rows`,
    [first.runId, first.sourceFamily],
  );
  return existing?.has_rows !== true && existing?.hasRows !== true;
}

async function copyFrontProfitL1SourceRowsDirect(
  executor: FrontProfitLayerCopySqlExecutor,
  rows: readonly PreparedFrontProfitL1SourceRow[],
): Promise<FrontProfitLayerRowCount> {
  const startedAt = Date.now();
  const writable = await executor`
    COPY public.front_profit_l1_source_row
      (run_id, source_id, source_row_no, period, source_family, source_record_key,
       event_date, platform, shop, operator_key, sku_key, amount_kind, amount_value,
       quantity, currency, row_payload)
    FROM STDIN WITH (FORMAT csv, NULL '\\N')
  `.writable();
  await pipeline(Readable.from(l1CopyRows(rows)), writable);
  return {
    rowCount: rows.length,
    writePath: "copy_direct",
    phaseTimings: [{ phase: "copy_direct", seconds: layerElapsedSeconds(startedAt) }],
  };
}

export async function upsertFrontProfitL1SourceRows(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    rows: FrontProfitL1SourceRowInput[];
    insertOnlyIfEmpty?: boolean;
  },
): Promise<FrontProfitLayerRowCount> {
  if (input.rows.length === 0) return { rowCount: 0 };
  if (input.rows.length >= FRONT_PROFIT_L1_COPY_WRITE_MIN_ROWS && canUseFrontProfitL1Copy(executor)) {
    const prepareStartedAt = Date.now();
    const preparedRows = input.rows.map(prepareFrontProfitL1SourceRow);
    const prepareTiming = {
      phase: "prepare_rows",
      seconds: layerElapsedSeconds(prepareStartedAt),
    };
    const directCheckStartedAt = Date.now();
    const useDirectCopy = input.insertOnlyIfEmpty === true
      && await canCopyFrontProfitL1RowsDirectly(executor, preparedRows);
    const directCheckTiming = input.insertOnlyIfEmpty === true
      ? [{ phase: "copy_direct_empty_check", seconds: layerElapsedSeconds(directCheckStartedAt) }]
      : [];
    const result = useDirectCopy
      ? await copyFrontProfitL1SourceRowsDirect(executor, preparedRows)
      : await upsertFrontProfitL1SourceRowsWithCopy(executor, preparedRows);
    return {
      ...result,
      phaseTimings: [prepareTiming, ...directCheckTiming, ...(result.phaseTimings ?? [])],
    };
  }
  if (input.rows.length > FRONT_PROFIT_BULK_WRITE_BATCH_SIZE) {
    let rowCount = 0;
    for (let index = 0; index < input.rows.length; index += FRONT_PROFIT_BULK_WRITE_BATCH_SIZE) {
      const inserted = await upsertFrontProfitL1SourceRows(executor, {
        rows: input.rows.slice(index, index + FRONT_PROFIT_BULK_WRITE_BATCH_SIZE),
        insertOnlyIfEmpty: input.insertOnlyIfEmpty,
      });
      rowCount += inserted.rowCount;
    }
    return { rowCount };
  }

  const placeholders: string[] = [];
  const parameters: unknown[] = [];
  let paramIndex = 1;
  for (const row of input.rows) {
    const prepared = prepareFrontProfitL1SourceRow(row);

    placeholders.push(
      `(${Array.from({ length: 15 }, () => `$${paramIndex++}`).join(", ")}, $${paramIndex++}::jsonb)`,
    );
    parameters.push(
      prepared.runId,
      prepared.sourceId,
      prepared.sourceRowNo,
      prepared.period,
      prepared.sourceFamily,
      prepared.sourceRecordKey,
      prepared.eventDate,
      prepared.platform,
      prepared.shop,
      prepared.operatorKey,
      prepared.skuKey,
      prepared.amountKind,
      prepared.amountValue,
      prepared.quantity,
      prepared.currency,
      prepared.rowPayload,
    );
  }

  const inserted = await executor.unsafe(
    `INSERT INTO public.front_profit_l1_source_row
       (run_id, source_id, source_row_no, period, source_family, source_record_key,
        event_date, platform, shop, operator_key, sku_key, amount_kind, amount_value,
        quantity, currency, row_payload)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (run_id, source_family, source_record_key, amount_kind) DO UPDATE SET
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
       row_payload = EXCLUDED.row_payload
     RETURNING id`,
    parameters,
  );

  return { rowCount: inserted.length };
}

function parseL1StoredRow(row: Record<string, unknown>): L1StoredRow {
  return {
    id: Number(row.id),
    sourceId: Number(row.sourceId ?? row.source_id),
    sourceRowNo: Number(row.sourceRowNo ?? row.source_row_no),
    sourceRecordKey: textValue(row, "sourceRecordKey") || textValue(row, "source_record_key"),
    eventDate: textValue(row, "eventDate") || textValue(row, "event_date"),
    platform: textValue(row, "platform"),
    shop: textValue(row, "shop"),
    operatorKey: textValue(row, "operatorKey") || textValue(row, "operator_key"),
    amountKind: textValue(row, "amountKind") || textValue(row, "amount_kind"),
    amountValue: numericOrZero(row.amountValue ?? row.amount_value),
    quantity: numericOrZero(row.quantity),
    rowPayload: jsonObject(row.rowPayload ?? row.row_payload),
  };
}

function syntheticDetailNumbersFromL1Row(row: L1StoredRow): Record<typeof FRONT_PROFIT_RECON_NUMERIC_COLUMNS[number], number> {
  const numbers = Object.fromEntries(
    FRONT_PROFIT_RECON_NUMERIC_COLUMNS.map((column) => [column, payloadNumber(row.rowPayload, column) ?? 0]),
  ) as Record<typeof FRONT_PROFIT_RECON_NUMERIC_COLUMNS[number], number>;

  if (row.quantity !== 0) {
    numbers.quantity = row.quantity;
  }
  if (row.amountKind === "quantity") {
    numbers.quantity = row.amountValue;
  }
  const formulaField = FRONT_PROFIT_MONEY_INPUT_FIELDS.find((field) => field === row.amountKind);
  if (formulaField) {
    numbers[formulaInputDbColumn(formulaField)] = row.amountValue;
  }
  return numbers;
}

const payloadNumericSql = (column: typeof FRONT_PROFIT_RECON_NUMERIC_COLUMNS[number]): string =>
  `COALESCE(NULLIF(l1.row_payload->>'${column}', '')::numeric, 0)`;

const stageNumericSql = (column: typeof FRONT_PROFIT_RECON_NUMERIC_COLUMNS[number]): string => {
  if (column === "quantity") {
    return `CASE
              WHEN l1.amount_kind = 'quantity' THEN COALESCE(l1.amount_value, 0)
              WHEN COALESCE(l1.quantity, 0) <> 0 THEN l1.quantity
              ELSE ${payloadNumericSql(column)}
            END`;
  }
  const amountKindParameter = formulaInputParameterByColumn.get(
    column as typeof FRONT_PROFIT_INPUT_DB_COLUMNS[number],
  );
  if (amountKindParameter == null) return payloadNumericSql(column);
  return `CASE
            WHEN l1.amount_kind = $${amountKindParameter}::text THEN COALESCE(l1.amount_value, 0)
            ELSE ${payloadNumericSql(column)}
          END`;
};

export async function stageFrontProfitL1PayloadRowsToL3(
  executor: FrontProfitLayerSqlExecutor,
  input: FrontProfitL3StageOptions,
): Promise<FrontProfitLayerRowCount> {
  const runId = assertPositiveSafeId(input.runId, "runId");
  const period = assertPeriod(input.period);
  const sourceFamily = assertRequiredText(input.sourceFamily ?? "synthetic", "sourceFamily");
  const mappingVersionId = input.mappingVersionId == null
    ? null
    : assertPositiveSafeId(input.mappingVersionId, "mappingVersionId");
  const ruleVersion = assertRequiredText(input.ruleVersion, "ruleVersion");
  const jobVersion = assertRequiredText(input.jobVersion, "jobVersion");

  const staged = await executor.unsafe(
    `WITH staged AS (
       SELECT l1.run_id,
              COALESCE(NULLIF(l1.row_payload->>'detailKey', ''), CONCAT('synthetic:', l1.source_record_key, ':', l1.amount_kind)) AS detail_key,
              l1.id AS l1_source_row_id,
              l1.source_id,
              l1.period,
              COALESCE(NULLIF(l1.row_payload->>'recordId', ''), CONCAT('SYNTHETIC_L3_', l1.source_record_key, '_', l1.amount_kind)) AS record_id,
              CONCAT(
                l1.event_date,
                chr(31),
                btrim(l1.platform),
                chr(31),
                btrim(NULLIF(l1.row_payload->>'businessMode', '')),
                chr(31),
                btrim(l1.shop),
                chr(31),
                btrim(l1.operator_key)
              ) AS aggregation_key,
              l1.event_date AS date,
              l1.platform,
              NULLIF(l1.row_payload->>'businessMode', '') AS business_mode,
              NULLIF(l1.row_payload->>'groupName', '') AS group_name,
              l1.shop,
              NULLIF(l1.row_payload->>'shopNormalized', '') AS shop_normalized,
              l1.operator_key AS operator,
              COALESCE(NULLIF(l1.row_payload->>'calculationRole', ''), 'synthetic_passthrough') AS calculation_role,
              $4::bigint AS mapping_version_id,
              $5::text AS rule_version,
              $6::text AS job_version,
              ${stageNumericSql("quantity")} AS quantity,
              ${stageNumericSql("gmv")} AS gmv,
              ${stageNumericSql("fill_order_amount")} AS fill_order_amount,
              ${stageNumericSql("fill_order_product_cost")} AS fill_order_product_cost,
              ${stageNumericSql("fill_order_quantity")} AS fill_order_quantity,
              ${stageNumericSql("product_cost")} AS product_cost,
              ${stageNumericSql("shipment_value")} AS shipment_value,
              ${stageNumericSql("platform_fee")} AS platform_fee,
              ${stageNumericSql("tax_fee")} AS tax_fee,
              ${stageNumericSql("finance_cost")} AS finance_cost,
              ${stageNumericSql("freight")} AS freight,
              ${stageNumericSql("commission")} AS commission,
              ${stageNumericSql("promotion_fee")} AS promotion_fee,
              jsonb_build_object(
                'sourceRecordKey', l1.source_record_key
              ) AS lineage_payload
         FROM public.front_profit_l1_source_row l1
        WHERE l1.run_id = $1 AND l1.period = $2 AND l1.source_family = $3
     ),
     upserted AS (
       INSERT INTO public.front_profit_l3_calc_detail
         (run_id, detail_key, l1_source_row_id, source_id, period, record_id, aggregation_key,
          date, platform, business_mode, group_name, shop, shop_normalized, operator,
          calculation_role, mapping_version_id, rule_version, job_version, quantity, gmv,
          fill_order_amount, fill_order_product_cost, fill_order_quantity, product_cost,
          shipment_value, platform_fee, tax_fee, finance_cost, freight, commission,
          promotion_fee, lineage_payload)
       SELECT run_id, detail_key, l1_source_row_id, source_id, period, record_id, aggregation_key,
              date, platform, business_mode, group_name, shop, shop_normalized, operator,
              calculation_role, mapping_version_id, rule_version, job_version, quantity, gmv,
              fill_order_amount, fill_order_product_cost, fill_order_quantity, product_cost,
              shipment_value, platform_fee, tax_fee, finance_cost, freight, commission,
              promotion_fee, lineage_payload
         FROM staged
        ORDER BY l1_source_row_id
       ON CONFLICT (run_id, detail_key) DO UPDATE SET
         l1_source_row_id = EXCLUDED.l1_source_row_id,
         source_id = EXCLUDED.source_id,
         period = EXCLUDED.period,
         record_id = EXCLUDED.record_id,
         aggregation_key = EXCLUDED.aggregation_key,
         date = EXCLUDED.date,
         platform = EXCLUDED.platform,
         business_mode = EXCLUDED.business_mode,
         group_name = EXCLUDED.group_name,
         shop = EXCLUDED.shop,
         shop_normalized = EXCLUDED.shop_normalized,
         operator = EXCLUDED.operator,
         calculation_role = EXCLUDED.calculation_role,
         mapping_version_id = EXCLUDED.mapping_version_id,
         rule_version = EXCLUDED.rule_version,
         job_version = EXCLUDED.job_version,
         quantity = EXCLUDED.quantity,
         gmv = EXCLUDED.gmv,
         fill_order_amount = EXCLUDED.fill_order_amount,
         fill_order_product_cost = EXCLUDED.fill_order_product_cost,
         fill_order_quantity = EXCLUDED.fill_order_quantity,
         product_cost = EXCLUDED.product_cost,
         shipment_value = EXCLUDED.shipment_value,
         platform_fee = EXCLUDED.platform_fee,
         tax_fee = EXCLUDED.tax_fee,
         finance_cost = EXCLUDED.finance_cost,
         freight = EXCLUDED.freight,
         commission = EXCLUDED.commission,
         promotion_fee = EXCLUDED.promotion_fee,
         lineage_payload = EXCLUDED.lineage_payload
       RETURNING 1
     )
     SELECT COUNT(*)::int AS row_count FROM upserted`,
    [
      runId,
      period,
      sourceFamily,
      mappingVersionId,
      ruleVersion,
      jobVersion,
      ...FRONT_PROFIT_MONEY_INPUT_FIELDS,
    ],
  );

  return { rowCount: Number(staged[0]?.row_count ?? 0) };
}

export async function stageSyntheticFrontProfitL1ToL3(
  executor: FrontProfitLayerSqlExecutor,
  input: FrontProfitL3StageOptions,
): Promise<FrontProfitLayerRowCount> {
  return stageFrontProfitL1PayloadRowsToL3(executor, input);
}

function frontProfitL4FormulaSql() {
  const validation = validateFrontProfitFormulaSqlExpressions();
  if (!validation.ok) {
    throw new Error(`front-profit formula SQL is invalid for ${validation.field}: ${validation.reason}`);
  }
  return frontProfitFormulaSqlExpressions((field) => `agg.${formulaInputDbColumn(field)}`);
}

export async function aggregateFrontProfitL3ToL4(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    writeRecon?: boolean;
  },
): Promise<FrontProfitL3L4AggregationResult> {
  const runId = assertPositiveSafeId(input.runId, "runId");
  const period = assertPeriod(input.period);
  const formulaSql = frontProfitL4FormulaSql();

  await executor.unsafe(
    `DELETE FROM public.front_profit_l4_agg_row
      WHERE run_id = $1 AND period = $2 AND publish_version_id IS NULL`,
    [runId, period],
  );

  const inserted = await executor.unsafe(
    `WITH agg AS (
       SELECT run_id, period, aggregation_key, date, platform, business_mode,
              MAX(group_name) AS group_name,
              shop,
              MAX(shop_normalized) AS shop_normalized,
              operator,
              COUNT(*)::int AS source_row_count,
              COALESCE(SUM(quantity), 0)::numeric(24, 6) AS quantity,
              COALESCE(SUM(gmv), 0)::numeric(24, 6) AS gmv,
              COALESCE(SUM(fill_order_amount), 0)::numeric(24, 6) AS fill_order_amount,
              COALESCE(SUM(fill_order_product_cost), 0)::numeric(24, 6) AS fill_order_product_cost,
              COALESCE(SUM(fill_order_quantity), 0)::numeric(24, 6) AS fill_order_quantity,
              COALESCE(SUM(product_cost), 0)::numeric(24, 6) AS product_cost,
              COALESCE(SUM(shipment_value), 0)::numeric(24, 6) AS shipment_value,
              COALESCE(SUM(platform_fee), 0)::numeric(24, 6) AS platform_fee,
              COALESCE(SUM(tax_fee), 0)::numeric(24, 6) AS tax_fee,
              COALESCE(SUM(finance_cost), 0)::numeric(24, 6) AS finance_cost,
              COALESCE(SUM(freight), 0)::numeric(24, 6) AS freight,
              COALESCE(SUM(commission), 0)::numeric(24, 6) AS commission,
              COALESCE(SUM(promotion_fee), 0)::numeric(24, 6) AS promotion_fee
         FROM public.front_profit_l3_calc_detail
        WHERE run_id = $1 AND period = $2
        GROUP BY run_id, period, aggregation_key, date, platform, business_mode, shop, operator
     )
     INSERT INTO public.front_profit_l4_agg_row
       (run_id, publish_version_id, period, record_id, aggregation_key, date, platform,
        business_mode, group_name, shop, shop_normalized, operator, quantity, gmv,
        fill_order_amount, fill_order_product_cost, fill_order_quantity, product_cost,
        shipment_value, platform_fee, tax_fee, finance_cost, freight, commission,
        promotion_fee, source_file, source_batch, note, real_revenue, front_profit,
        paid_ratio, data_status, row_payload)
     SELECT agg.run_id,
            NULL,
            agg.period,
            CONCAT('FP_L4_', md5(agg.aggregation_key)),
            agg.aggregation_key,
            agg.date,
            agg.platform,
            agg.business_mode,
            agg.group_name,
            agg.shop,
            agg.shop_normalized,
            agg.operator,
            agg.quantity,
            agg.gmv,
            agg.fill_order_amount,
            agg.fill_order_product_cost,
            agg.fill_order_quantity,
            agg.product_cost,
            agg.shipment_value,
            agg.platform_fee,
            agg.tax_fee,
            agg.finance_cost,
            agg.freight,
            agg.commission,
            agg.promotion_fee,
            NULL,
            CONCAT('front-profit-l3-run:', agg.run_id::text),
            'aggregated from L3 calculation detail',
            ROUND((${formulaSql[DERIVED_REAL_REVENUE_FIELD]})::numeric, 6),
            ROUND((${formulaSql[DERIVED_FRONT_PROFIT_FIELD]})::numeric, 6),
            ROUND((${formulaSql[DERIVED_PAID_RATIO_FIELD]})::numeric, 8),
            'auto_draft',
            jsonb_build_object(
              'sourceLayer', $3::text,
              'layerVersion', $4::text,
              'formulaVersion', $5::text,
              'sourceRowCount', agg.source_row_count
            )
       FROM agg
      ORDER BY agg.date, agg.platform, agg.business_mode, agg.shop, agg.operator
     RETURNING id`,
    [
      runId,
      period,
      FRONT_PROFIT_L3_CALC_DETAIL_TABLE,
      FRONT_PROFIT_LAYER_VERSION,
      FRONT_PROFIT_FORMULA_VERSION,
    ],
  );

  const reconResults = input.writeRecon === false
    ? []
    : await writeFrontProfitL3L4Reconciliation(executor, { runId, period });
  const rows = await selectFrontProfitL4RowsForRun(executor, { runId, period });
  const contract = frontProfitL4RowsContract({ rows });
  return { rowCount: inserted.length, contract, reconResults };
}

async function selectFrontProfitLayerSums(
  executor: FrontProfitLayerSqlExecutor,
  tableName: typeof FRONT_PROFIT_L3_CALC_DETAIL_TABLE | typeof FRONT_PROFIT_L4_AGG_ROW_TABLE,
  input: {
    runId: number;
    period: string;
  },
): Promise<Record<string, number>> {
  const aggregationCountSql = tableName === FRONT_PROFIT_L3_CALC_DETAIL_TABLE
    ? "COUNT(DISTINCT aggregation_key)::int"
    : "COUNT(*)::int";
  const [row] = await executor.unsafe(
    `SELECT ${aggregationCountSql} AS aggregation_key_count,
            ${FRONT_PROFIT_RECON_NUMERIC_COLUMNS
              .map((column) => `(COALESCE(SUM(${column}), 0))::float8 AS ${column}`)
              .join(", ")}
       FROM public.${tableName}
      WHERE run_id = $1 AND period = $2`,
    [input.runId, input.period],
  );
  const result: Record<string, number> = {
    aggregation_key_count: numericOrZero(row?.aggregation_key_count),
  };
  for (const column of FRONT_PROFIT_RECON_NUMERIC_COLUMNS) {
    result[column] = numericOrZero(row?.[column]);
  }
  return result;
}

export async function writeFrontProfitL3L4Reconciliation(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
  },
): Promise<FrontProfitReconMetric[]> {
  const runId = assertPositiveSafeId(input.runId, "runId");
  const period = assertPeriod(input.period);
  const l3 = await selectFrontProfitLayerSums(executor, FRONT_PROFIT_L3_CALC_DETAIL_TABLE, { runId, period });
  const l4 = await selectFrontProfitLayerSums(executor, FRONT_PROFIT_L4_AGG_ROW_TABLE, { runId, period });
  const results: FrontProfitReconMetric[] = [];

  const aggregationExpected = l3.aggregation_key_count ?? 0;
  const aggregationActual = l4.aggregation_key_count ?? 0;
  results.push({
    layer: "L3_L4",
    metric: "aggregation_key_count",
    expected: aggregationExpected,
    actual: aggregationActual,
    tolerance: 0,
    passed: aggregationExpected === aggregationActual,
    evidenceRef: { period },
  });

  for (const column of FRONT_PROFIT_RECON_NUMERIC_COLUMNS) {
    const expected = l3[column] ?? 0;
    const actual = l4[column] ?? 0;
    const tolerance = column === "quantity" ? 0.000001 : FRONT_PROFIT_MONEY_TOLERANCE;
    results.push({
      layer: "L3_L4",
      metric: `${column}_sum`,
      expected,
      actual,
      tolerance,
      passed: metricPassed(actual, expected, tolerance),
      evidenceRef: { period, sourceLayer: FRONT_PROFIT_L3_CALC_DETAIL_TABLE, targetLayer: FRONT_PROFIT_L4_AGG_ROW_TABLE },
    });
  }

  const l4Rows = await selectFrontProfitL4RowsForRun(executor, { runId, period });
  try {
    const contract = frontProfitL4RowsContract({ rows: l4Rows });
    results.push({
      layer: "L4_CONTRACT",
      metric: "canonical_rows_contract",
      expected: l4Rows.length,
      actual: contract.summary.businessRowCount,
      tolerance: 0,
      passed: true,
      evidenceRef: {
        period,
        schemaVersion: contract.summary.schemaVersion,
        warningCodes: contract.summary.warningCodes,
      },
    });
  } catch (error) {
    results.push({
      layer: "L4_CONTRACT",
      metric: "canonical_rows_contract",
      expected: l4Rows.length,
      actual: 0,
      tolerance: 0,
      passed: false,
      evidenceRef: {
        period,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }

  for (const result of results) {
    await upsertFrontProfitReconMetric(executor, runId, result);
  }
  return results;
}

function l4RowMetric(row: FrontProfitL4AggRowForContract, metric: "gmv" | "frontProfit"): number {
  return metric === "gmv" ? numericOrZero(row.gmv) : numericOrZero(row.frontProfit);
}

export async function writeFrontProfitShadowReconciliation(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    manualRows: FrontProfitL4AggRowForContract[];
    baselineLabel?: string;
  },
): Promise<FrontProfitShadowReconResult> {
  const runId = assertPositiveSafeId(input.runId, "runId");
  const period = assertPeriod(input.period);
  frontProfitL4RowsContract({ rows: input.manualRows });

  const autoRows = await selectFrontProfitL4RowsForRun(executor, { runId, period });
  const manualByKey = new Map(input.manualRows.map((row) => [frontProfitL4AggregationKey(row), row]));
  const autoByKey = new Map(autoRows.map((row) => [frontProfitL4AggregationKey(row), row]));
  const missingAuto = [...manualByKey.keys()].filter((key) => !autoByKey.has(key));
  const extraAuto = [...autoByKey.keys()].filter((key) => !manualByKey.has(key));
  const mismatchedKeys: string[] = [];

  for (const key of manualByKey.keys()) {
    const manual = manualByKey.get(key);
    const auto = autoByKey.get(key);
    if (!manual || !auto) continue;
    const gmvDiff = Math.abs(l4RowMetric(auto, "gmv") - l4RowMetric(manual, "gmv"));
    const profitDiff = Math.abs(l4RowMetric(auto, "frontProfit") - l4RowMetric(manual, "frontProfit"));
    if (gmvDiff > FRONT_PROFIT_MONEY_TOLERANCE || profitDiff > FRONT_PROFIT_MONEY_TOLERANCE) {
      mismatchedKeys.push(key);
    }
  }

  let dqEventCount = 0;
  for (const key of missingAuto) {
    dqEventCount += 1;
    await insertFrontProfitDqEvent(executor, {
      runId,
      severity: "warn",
      code: "FRONT_PROFIT_SHADOW_MISSING_AUTO",
      payload: { period, aggregationKey: key, baselineLabel: input.baselineLabel ?? "manual" },
    });
  }
  for (const key of extraAuto) {
    dqEventCount += 1;
    await insertFrontProfitDqEvent(executor, {
      runId,
      severity: "warn",
      code: "FRONT_PROFIT_SHADOW_EXTRA_AUTO",
      payload: { period, aggregationKey: key, baselineLabel: input.baselineLabel ?? "manual" },
    });
  }
  for (const key of mismatchedKeys) {
    dqEventCount += 1;
    await insertFrontProfitDqEvent(executor, {
      runId,
      severity: "warn",
      code: "FRONT_PROFIT_SHADOW_AMOUNT_MISMATCH",
      payload: { period, aggregationKey: key, baselineLabel: input.baselineLabel ?? "manual" },
    });
  }

  const sum = (rows: FrontProfitL4AggRowForContract[], metric: "gmv" | "frontProfit"): number =>
    rows.reduce((total, row) => total + l4RowMetric(row, metric), 0);
  const manualGmv = sum(input.manualRows, "gmv");
  const autoGmv = sum(autoRows, "gmv");
  const manualProfit = sum(input.manualRows, "frontProfit");
  const autoProfit = sum(autoRows, "frontProfit");
  const mismatchCount = missingAuto.length + extraAuto.length + mismatchedKeys.length;
  const results: FrontProfitReconMetric[] = [
    {
      layer: "SHADOW_MANUAL_AUTO",
      metric: "aggregation_key_set",
      expected: manualByKey.size,
      actual: autoByKey.size,
      tolerance: 0,
      passed: missingAuto.length === 0 && extraAuto.length === 0,
      evidenceRef: { period, missingAuto, extraAuto, baselineLabel: input.baselineLabel ?? "manual" },
    },
    {
      layer: "SHADOW_MANUAL_AUTO",
      metric: "gmv_sum",
      expected: manualGmv,
      actual: autoGmv,
      tolerance: FRONT_PROFIT_MONEY_TOLERANCE,
      passed: metricPassed(autoGmv, manualGmv, FRONT_PROFIT_MONEY_TOLERANCE),
      evidenceRef: { period, baselineLabel: input.baselineLabel ?? "manual" },
    },
    {
      layer: "SHADOW_MANUAL_AUTO",
      metric: "front_profit_sum",
      expected: manualProfit,
      actual: autoProfit,
      tolerance: FRONT_PROFIT_MONEY_TOLERANCE,
      passed: metricPassed(autoProfit, manualProfit, FRONT_PROFIT_MONEY_TOLERANCE),
      evidenceRef: { period, baselineLabel: input.baselineLabel ?? "manual" },
    },
    {
      layer: "SHADOW_MANUAL_AUTO",
      metric: "row_mismatch_count",
      expected: 0,
      actual: mismatchCount,
      tolerance: 0,
      passed: mismatchCount === 0,
      evidenceRef: { period, mismatchedKeys, baselineLabel: input.baselineLabel ?? "manual" },
    },
  ];

  for (const result of results) {
    await upsertFrontProfitReconMetric(executor, runId, result);
  }
  return { reconResults: results, dqEventCount };
}

export async function markFrontProfitL4RowsPublishVersion(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    publishVersionId: number;
  },
): Promise<void> {
  const runId = assertPositiveSafeId(input.runId, "runId");
  const publishVersionId = assertPositiveSafeId(input.publishVersionId, "publishVersionId");
  const period = assertPeriod(input.period);
  await executor.unsafe(
    `UPDATE public.front_profit_l4_agg_row
        SET publish_version_id = $1
      WHERE run_id = $2 AND period = $3`,
    [publishVersionId, runId, period],
  );
}
