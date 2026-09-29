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
  FRONT_PROFIT_OPERATOR_AUTHORITY_KEY_PRIORITY,
  FrontProfitBusinessRuleBlockError,
  createFrontProfitOperatorResolver,
  type FrontProfitOperatorAssignment,
  type FrontProfitOperatorAuthorityKeyType,
} from "./front-profit-business-rules.js";

export const FRONT_PROFIT_OPERATOR_SOURCE_VERSION = "front-profit-operator-source/v1" as const;
export const FRONT_PROFIT_OPERATOR_ASSIGNMENT_SOURCE_FAMILY = "operator_assignment" as const;
export const FRONT_PROFIT_OPERATOR_APPLIED_SOURCE_FAMILY = "operator_applied" as const;
export const FRONT_PROFIT_OPERATOR_ASSIGNMENT_AMOUNT_KIND = "operator_assignment" as const;
export const FRONT_PROFIT_OPERATOR_APPLIED_AMOUNT_KIND = "operator_attributed_gmv" as const;

export const FRONT_PROFIT_OPERATOR_ASSIGNMENT_HEADERS = [
  "店铺",
  "权威键类型",
  "权威键",
  "运营",
  "生效开始",
  "生效结束",
  "来源批次",
  "备注",
] as const;

export const FRONT_PROFIT_OPERATOR_USAGE_HEADERS = [
  "归属ID",
  "归属日期",
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

export type FrontProfitOperatorAssignmentHeader = typeof FRONT_PROFIT_OPERATOR_ASSIGNMENT_HEADERS[number];
export type FrontProfitOperatorUsageHeader = typeof FRONT_PROFIT_OPERATOR_USAGE_HEADERS[number];
export type FrontProfitOperatorAssignmentRawRow =
  Partial<Record<FrontProfitOperatorAssignmentHeader, unknown>>;
export type FrontProfitOperatorUsageRawRow =
  Partial<Record<FrontProfitOperatorUsageHeader, unknown>>;

export type FrontProfitOperatorAssignmentRow = FrontProfitOperatorAssignment & {
  runId: number;
  sourceId: number;
  sourceRowNo: number;
  period: string;
  sourceBatch?: string | null;
  note?: string | null;
  rowPayload?: Record<string, unknown>;
};

export type FrontProfitOperatorUsageRow = {
  runId: number;
  sourceId: number;
  sourceRowNo: number;
  period: string;
  attributionKey: string;
  attributionDate: string;
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

export type FrontProfitOperatorAppliedRow = FrontProfitOperatorUsageRow & {
  operatorKey: string;
  matchedAuthorityKeyType: FrontProfitOperatorAuthorityKeyType;
  matchedAuthorityKey: string;
};

export type FrontProfitOperatorAssignmentLoadResult = {
  assignmentRowCount: number;
  l1RowCount: number;
  reconResults: FrontProfitReconMetric[];
};

export type FrontProfitOperatorApplicationResult = {
  appliedRows: FrontProfitOperatorAppliedRow[];
  l1RowCount: number;
  reconResults: FrontProfitReconMetric[];
};

type RowCountSums = {
  rowCount: number;
  rowMarker: number;
};

type OperatorAppliedSums = {
  rowCount: number;
  quantity: number;
  gmv: number;
  shipmentValue: number;
};

const FRONT_PROFIT_OPERATOR_BULK_WRITE_BATCH_SIZE = 1_000;

const AUTHORITY_KEY_TYPE_ALIASES: Record<string, FrontProfitOperatorAuthorityKeyType> = {
  sku: "sku",
  SKU: "sku",
  ad_account: "ad_account",
  广告账户: "ad_account",
  product_owner: "product_owner",
  产品负责人: "product_owner",
  order_owner: "order_owner",
  订单负责人: "order_owner",
  manual_mapping: "manual_mapping",
  手工映射: "manual_mapping",
  手工映射键: "manual_mapping",
  人工映射: "manual_mapping",
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

function normalizeAuthorityKeyType(value: unknown): FrontProfitOperatorAuthorityKeyType {
  const normalized = requiredText(value, "authorityKeyType");
  const keyType = AUTHORITY_KEY_TYPE_ALIASES[normalized];
  if (
    keyType
    && (FRONT_PROFIT_OPERATOR_AUTHORITY_KEY_PRIORITY as readonly string[]).includes(keyType)
  ) {
    return keyType;
  }
  throw new Error(`front-profit operator authority key type is unsupported: ${normalized}`);
}

function sourceMetric(sourceId: number, metric: string): string {
  return `source_${sourceId}_${metric}`;
}

function assignmentRecordKey(
  row: Pick<FrontProfitOperatorAssignmentRow, "shop" | "authorityKeyType" | "authorityKey" | "effectiveFrom">,
): string {
  return `${row.shop}:${row.authorityKeyType}:${row.authorityKey}:${row.effectiveFrom}`;
}

function parseRowCountSums(row: Record<string, unknown> | undefined): RowCountSums {
  return {
    rowCount: Number(row?.rowCount ?? row?.row_count ?? 0),
    rowMarker: Number(row?.rowMarker ?? row?.row_marker ?? 0),
  };
}

function parseOperatorAppliedSums(row: Record<string, unknown> | undefined): OperatorAppliedSums {
  return {
    rowCount: Number(row?.rowCount ?? row?.row_count ?? 0),
    quantity: Number(row?.quantity ?? 0),
    gmv: Number(row?.gmv ?? 0),
    shipmentValue: Number(row?.shipmentValue ?? row?.shipment_value ?? 0),
  };
}

function assertNoOperatorAssignmentOverlaps(rows: FrontProfitOperatorAssignmentRow[]): void {
  const grouped = new Map<string, FrontProfitOperatorAssignmentRow[]>();
  for (const row of rows) {
    const key = `${row.shop}\u001f${row.authorityKeyType}\u001f${row.authorityKey}`;
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
        throw new FrontProfitBusinessRuleBlockError("OWNER_AMBIGUOUS", {
          shop: current.shop,
          authorityKeyType: current.authorityKeyType,
          authorityKey: current.authorityKey,
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

async function upsertFrontProfitOperatorAssignments(
  executor: FrontProfitLayerSqlExecutor,
  rows: FrontProfitOperatorAssignmentRow[],
): Promise<FrontProfitLayerRowCount> {
  if (rows.length === 0) return { rowCount: 0 };
  if (rows.length > FRONT_PROFIT_OPERATOR_BULK_WRITE_BATCH_SIZE) {
    let rowCount = 0;
    for (let index = 0; index < rows.length; index += FRONT_PROFIT_OPERATOR_BULK_WRITE_BATCH_SIZE) {
      const inserted = await upsertFrontProfitOperatorAssignments(
        executor,
        rows.slice(index, index + FRONT_PROFIT_OPERATOR_BULK_WRITE_BATCH_SIZE),
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
      throw new Error("front-profit operator effectiveTo must be on or after effectiveFrom");
    }

    placeholders.push(
      `(${Array.from({ length: 10 }, () => `$${paramIndex++}`).join(", ")}, $${paramIndex++}::jsonb)`,
    );
    parameters.push(
      runId,
      sourceId,
      sourceRowNo,
      deriveFrontProfitPeriod(effectiveFrom),
      requiredText(row.shop, "shop"),
      row.authorityKeyType,
      requiredText(row.authorityKey, "authorityKey"),
      requiredText(row.operator, "operator"),
      effectiveFrom,
      effectiveTo,
      row.rowPayload ?? {},
    );
  }

  const inserted = await executor.unsafe(
    `INSERT INTO public.front_profit_operator_assignment
       (run_id, source_id, source_row_no, period, shop, authority_key_type,
        authority_key, operator, effective_from, effective_to, row_payload)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (run_id, shop, authority_key_type, authority_key, effective_from) DO UPDATE SET
       source_id = EXCLUDED.source_id,
       source_row_no = EXCLUDED.source_row_no,
       period = EXCLUDED.period,
       operator = EXCLUDED.operator,
       effective_to = EXCLUDED.effective_to,
       row_payload = EXCLUDED.row_payload
     RETURNING id`,
    parameters,
  );

  return { rowCount: inserted.length };
}

async function selectFrontProfitOperatorAssignmentSums(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    sourceId: number;
  },
): Promise<RowCountSums> {
  const [row] = await executor.unsafe(
    `SELECT COUNT(*)::int AS "rowCount",
            COUNT(*)::int AS "rowMarker"
       FROM public.front_profit_operator_assignment
      WHERE run_id = $1 AND period = $2 AND source_id = $3`,
    [input.runId, input.period, input.sourceId],
  );
  return parseRowCountSums(row);
}

async function selectFrontProfitOperatorAssignmentL1Sums(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    sourceId: number;
  },
): Promise<RowCountSums> {
  const [row] = await executor.unsafe(
    `SELECT COUNT(*)::int AS "rowCount",
            COALESCE(SUM((row_payload->>'operator_row_count')::numeric), 0)::float8 AS "rowMarker"
       FROM public.front_profit_l1_source_row
      WHERE run_id = $1 AND period = $2 AND source_id = $3 AND source_family = $4`,
    [input.runId, input.period, input.sourceId, FRONT_PROFIT_OPERATOR_ASSIGNMENT_SOURCE_FAMILY],
  );
  return parseRowCountSums(row);
}

async function selectFrontProfitOperatorAppliedL1Sums(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    sourceId: number;
  },
): Promise<OperatorAppliedSums> {
  const [row] = await executor.unsafe(
    `SELECT COUNT(*)::int AS "rowCount",
            COALESCE(SUM((row_payload->>'quantity')::numeric), 0)::float8 AS "quantity",
            COALESCE(SUM((row_payload->>'operator_attributed_gmv')::numeric), 0)::float8 AS "gmv",
            COALESCE(SUM((row_payload->>'operator_attributed_shipment_value')::numeric), 0)::float8 AS "shipmentValue"
       FROM public.front_profit_l1_source_row
      WHERE run_id = $1 AND period = $2 AND source_id = $3 AND source_family = $4`,
    [input.runId, input.period, input.sourceId, FRONT_PROFIT_OPERATOR_APPLIED_SOURCE_FAMILY],
  );
  return parseOperatorAppliedSums(row);
}

export async function selectFrontProfitOperatorAssignmentsForShops(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    shops: string[];
  },
): Promise<FrontProfitOperatorAssignment[]> {
  if (input.shops.length === 0) return [];
  const rows = await executor.unsafe(
    `SELECT shop,
            authority_key_type AS "authorityKeyType",
            authority_key AS "authorityKey",
            operator,
            effective_from AS "effectiveFrom",
            effective_to AS "effectiveTo"
       FROM public.front_profit_operator_assignment
      WHERE run_id = $1 AND shop = ANY($2::text[])
      ORDER BY shop, authority_key_type, authority_key, effective_from`,
    [input.runId, input.shops],
  );
  return rows.map((row) => ({
    shop: requiredText(row.shop, "shop"),
    authorityKeyType: normalizeAuthorityKeyType(row.authorityKeyType ?? row.authority_key_type),
    authorityKey: requiredText(row.authorityKey ?? row.authority_key, "authorityKey"),
    operator: requiredText(row.operator, "operator"),
    effectiveFrom: assertIsoDateValue(row.effectiveFrom ?? row.effective_from, "effectiveFrom"),
    effectiveTo: assertIsoDateValue(row.effectiveTo ?? row.effective_to, "effectiveTo"),
  }));
}

async function upsertFrontProfitOperatorReconMetric(
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

function assignmentReconResults(
  input: {
    sourceId: number;
    period: string;
    fact: RowCountSums;
    l1: RowCountSums;
  },
): FrontProfitReconMetric[] {
  const fields = [
    ["row_count", input.fact.rowCount, input.l1.rowCount, 0],
    ["operator_row_marker", input.fact.rowMarker, input.l1.rowMarker, 0],
  ] as const;

  return fields.map(([metric, expected, actual, tolerance]) => ({
    layer: "OPERATOR_ASSIGNMENT_L1",
    metric: sourceMetric(input.sourceId, metric),
    expected,
    actual,
    tolerance,
    passed: Math.abs(actual - expected) <= tolerance,
    evidenceRef: {
      sourceId: input.sourceId,
      period: input.period,
      sourceFamily: FRONT_PROFIT_OPERATOR_ASSIGNMENT_SOURCE_FAMILY,
      sourceContractVersion: FRONT_PROFIT_OPERATOR_SOURCE_VERSION,
    },
  }));
}

function operatorAppliedReconResults(
  input: {
    sourceId: number;
    period: string;
    expected: OperatorAppliedSums;
    l1: OperatorAppliedSums;
  },
): FrontProfitReconMetric[] {
  const fields = [
    ["row_count", input.expected.rowCount, input.l1.rowCount, 0],
    ["quantity_sum", input.expected.quantity, input.l1.quantity, FRONT_PROFIT_MONEY_TOLERANCE],
    ["gmv_sum", input.expected.gmv, input.l1.gmv, FRONT_PROFIT_MONEY_TOLERANCE],
    ["shipment_value_sum", input.expected.shipmentValue, input.l1.shipmentValue, FRONT_PROFIT_MONEY_TOLERANCE],
  ] as const;

  return fields.map(([metric, expected, actual, tolerance]) => ({
    layer: "OPERATOR_APPLIED_L1",
    metric: sourceMetric(input.sourceId, metric),
    expected,
    actual,
    tolerance,
    passed: Math.abs(actual - expected) <= tolerance,
    evidenceRef: {
      sourceId: input.sourceId,
      period: input.period,
      sourceFamily: FRONT_PROFIT_OPERATOR_APPLIED_SOURCE_FAMILY,
      sourceContractVersion: FRONT_PROFIT_OPERATOR_SOURCE_VERSION,
    },
  }));
}

export function assertFrontProfitOperatorAssignmentHeaders(headers: readonly unknown[]): void {
  const normalized = headers.map(normalizedText);
  const expected = [...FRONT_PROFIT_OPERATOR_ASSIGNMENT_HEADERS];
  if (
    normalized.length !== expected.length
    || normalized.some((header, index) => header !== expected[index])
  ) {
    throw new Error("front-profit operator assignment headers do not match front-profit-operator-source/v1");
  }
}

export function assertFrontProfitOperatorUsageHeaders(headers: readonly unknown[]): void {
  const normalized = headers.map(normalizedText);
  const expected = [...FRONT_PROFIT_OPERATOR_USAGE_HEADERS];
  if (
    normalized.length !== expected.length
    || normalized.some((header, index) => header !== expected[index])
  ) {
    throw new Error("front-profit operator usage headers do not match front-profit-operator-source/v1");
  }
}

export function normalizeFrontProfitOperatorAssignmentRows(input: {
  runId: number;
  sourceId: number;
  firstDataRowNumber?: number;
  rows: FrontProfitOperatorAssignmentRawRow[];
}): FrontProfitOperatorAssignmentRow[] {
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
    const normalized: FrontProfitOperatorAssignmentRow = {
      runId,
      sourceId,
      sourceRowNo,
      period: deriveFrontProfitPeriod(effectiveFrom),
      shop: requiredText(row["店铺"], `row ${sourceRowNo} 店铺`),
      authorityKeyType: normalizeAuthorityKeyType(row["权威键类型"]),
      authorityKey: requiredText(row["权威键"], `row ${sourceRowNo} 权威键`),
      operator: requiredText(row["运营"], `row ${sourceRowNo} 运营`),
      effectiveFrom,
      effectiveTo,
      sourceBatch: optionalText(row["来源批次"]),
      note: optionalText(row["备注"]),
    };
    return {
      ...normalized,
      rowPayload: {
        ...row,
        sourceFamily: FRONT_PROFIT_OPERATOR_ASSIGNMENT_SOURCE_FAMILY,
        sourceContractVersion: FRONT_PROFIT_OPERATOR_SOURCE_VERSION,
        sourceRecordKey: assignmentRecordKey(normalized),
        operator_row_count: 1,
        shop: normalized.shop,
        authorityKeyType: normalized.authorityKeyType,
        authorityKey: normalized.authorityKey,
        operator: normalized.operator,
        effectiveFrom,
        effectiveTo,
        sourceBatch: normalized.sourceBatch,
        note: normalized.note,
      },
    };
  });
  assertNoOperatorAssignmentOverlaps(rows);
  return rows;
}

export function normalizeFrontProfitOperatorUsageRows(input: {
  runId: number;
  sourceId: number;
  sourceFile?: string | null;
  firstDataRowNumber?: number;
  rows: FrontProfitOperatorUsageRawRow[];
}): FrontProfitOperatorUsageRow[] {
  const runId = assertPositiveSafeId(input.runId, "runId");
  const sourceId = assertPositiveSafeId(input.sourceId, "sourceId");
  const sourceFile = optionalText(input.sourceFile);
  const firstDataRowNumber = input.firstDataRowNumber ?? 2;

  return input.rows.map((row, index) => {
    const sourceRowNo = firstDataRowNumber + index;
    const attributionDate = assertIsoDateValue(row["归属日期"], `row ${sourceRowNo} 归属日期`);
    const normalized: FrontProfitOperatorUsageRow = {
      runId,
      sourceId,
      sourceRowNo,
      period: deriveFrontProfitPeriod(attributionDate),
      attributionKey: requiredText(row["归属ID"], `row ${sourceRowNo} 归属ID`),
      attributionDate,
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
        sourceFamily: FRONT_PROFIT_OPERATOR_APPLIED_SOURCE_FAMILY,
        sourceContractVersion: FRONT_PROFIT_OPERATOR_SOURCE_VERSION,
        sourceFile,
        sourceBatch: normalized.sourceBatch,
      },
    };
  });
}

export function frontProfitOperatorAssignmentRowToL1Input(
  row: FrontProfitOperatorAssignmentRow,
): FrontProfitL1SourceRowInput {
  return {
    runId: row.runId,
    sourceId: row.sourceId,
    sourceRowNo: row.sourceRowNo,
    period: row.period,
    sourceFamily: FRONT_PROFIT_OPERATOR_ASSIGNMENT_SOURCE_FAMILY,
    sourceRecordKey: assignmentRecordKey(row),
    eventDate: row.effectiveFrom,
    platform: null,
    shop: row.shop,
    operatorKey: row.operator,
    skuKey: row.authorityKeyType === "sku" ? row.authorityKey : null,
    amountKind: FRONT_PROFIT_OPERATOR_ASSIGNMENT_AMOUNT_KIND,
    amountValue: null,
    quantity: null,
    currency: "CNY",
    rowPayload: {
      sourceFamily: FRONT_PROFIT_OPERATOR_ASSIGNMENT_SOURCE_FAMILY,
      sourceContractVersion: FRONT_PROFIT_OPERATOR_SOURCE_VERSION,
      sourceRecordKey: assignmentRecordKey(row),
      operator_row_count: 1,
      shop: row.shop,
      authorityKeyType: row.authorityKeyType,
      authorityKey: row.authorityKey,
      operator: row.operator,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      sourceBatch: row.sourceBatch,
      note: row.note,
      raw: row.rowPayload ?? {},
    },
  };
}

export function frontProfitOperatorAppliedRowToL1Input(
  row: FrontProfitOperatorAppliedRow,
): FrontProfitL1SourceRowInput {
  return {
    runId: row.runId,
    sourceId: row.sourceId,
    sourceRowNo: row.sourceRowNo,
    period: row.period,
    sourceFamily: FRONT_PROFIT_OPERATOR_APPLIED_SOURCE_FAMILY,
    sourceRecordKey: row.attributionKey,
    eventDate: row.attributionDate,
    platform: row.platform,
    shop: row.shop,
    operatorKey: row.operatorKey,
    skuKey: row.skuKey,
    amountKind: FRONT_PROFIT_OPERATOR_APPLIED_AMOUNT_KIND,
    amountValue: row.gmv,
    quantity: row.quantity,
    currency: "CNY",
    rowPayload: {
      sourceFamily: FRONT_PROFIT_OPERATOR_APPLIED_SOURCE_FAMILY,
      sourceContractVersion: FRONT_PROFIT_OPERATOR_SOURCE_VERSION,
      attributionKey: row.attributionKey,
      attributionDate: row.attributionDate,
      businessMode: row.businessMode,
      groupName: row.groupName,
      shopNormalized: row.shopNormalized,
      skuKey: row.skuKey,
      adAccountKey: row.adAccountKey,
      productOwnerKey: row.productOwnerKey,
      orderOwnerKey: row.orderOwnerKey,
      manualMappingKey: row.manualMappingKey,
      matchedAuthorityKeyType: row.matchedAuthorityKeyType,
      matchedAuthorityKey: row.matchedAuthorityKey,
      detailKey: `operator:${row.attributionKey}`,
      recordId: `OPERATOR_L3_${row.attributionKey}`,
      calculationRole: "operator_attributed_contribution",
      quantity: row.quantity,
      gmv: row.gmv,
      operator_attributed_gmv: row.gmv,
      fill_order_amount: 0,
      fill_order_product_cost: 0,
      fill_order_quantity: 0,
      product_cost: 0,
      shipment_value: row.shipmentValue,
      operator_attributed_shipment_value: row.shipmentValue,
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

export async function loadFrontProfitOperatorAssignmentSource(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    rows: FrontProfitOperatorAssignmentRow[];
  },
): Promise<FrontProfitOperatorAssignmentLoadResult> {
  if (input.rows.length === 0) {
    return { assignmentRowCount: 0, l1RowCount: 0, reconResults: [] };
  }

  assertNoOperatorAssignmentOverlaps(input.rows);
  const first = input.rows[0]!;
  const runId = assertPositiveSafeId(first.runId, "runId");
  const sourceId = assertPositiveSafeId(first.sourceId, "sourceId");
  const period = first.period;
  if (input.rows.some((row) => row.runId !== runId || row.sourceId !== sourceId || row.period !== period)) {
    throw new Error("front-profit operator assignment load must receive one run/source/period at a time");
  }

  const assignmentResult = await upsertFrontProfitOperatorAssignments(executor, input.rows);
  const l1Rows = input.rows.map(frontProfitOperatorAssignmentRowToL1Input);
  const l1Result = await upsertFrontProfitL1SourceRows(executor, { rows: l1Rows });
  const [fact, l1] = await Promise.all([
    selectFrontProfitOperatorAssignmentSums(executor, { runId, period, sourceId }),
    selectFrontProfitOperatorAssignmentL1Sums(executor, { runId, period, sourceId }),
  ]);
  const reconResults = assignmentReconResults({ sourceId, period, fact, l1 });
  for (const result of reconResults) {
    await upsertFrontProfitOperatorReconMetric(executor, runId, result);
  }

  return {
    assignmentRowCount: assignmentResult.rowCount,
    l1RowCount: l1Result.rowCount,
    reconResults,
  };
}

export async function applyFrontProfitOperatorToUsageRows(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    rows: FrontProfitOperatorUsageRow[];
  },
): Promise<FrontProfitOperatorApplicationResult> {
  if (input.rows.length === 0) {
    return { appliedRows: [], l1RowCount: 0, reconResults: [] };
  }

  const first = input.rows[0]!;
  const runId = assertPositiveSafeId(first.runId, "runId");
  const sourceId = assertPositiveSafeId(first.sourceId, "sourceId");
  const period = first.period;
  if (input.rows.some((row) => row.runId !== runId || row.sourceId !== sourceId || row.period !== period)) {
    throw new Error("front-profit operator application must receive one run/source/period at a time");
  }

  const shops = [...new Set(input.rows.map((row) => row.shop))].sort();
  const assignments = await selectFrontProfitOperatorAssignmentsForShops(executor, { runId, shops });
  const resolveOperator = createFrontProfitOperatorResolver(assignments);
  const appliedRows = input.rows.map((row) => {
    const assignment = resolveOperator({
      shop: row.shop,
      date: row.attributionDate,
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

  const l1Rows = appliedRows.map(frontProfitOperatorAppliedRowToL1Input);
  const l1Result = await upsertFrontProfitL1SourceRows(executor, { rows: l1Rows });
  const expected = {
    rowCount: appliedRows.length,
    quantity: appliedRows.reduce((total, row) => total + row.quantity, 0),
    gmv: appliedRows.reduce((total, row) => total + row.gmv, 0),
    shipmentValue: appliedRows.reduce((total, row) => total + row.shipmentValue, 0),
  };
  const l1 = await selectFrontProfitOperatorAppliedL1Sums(executor, { runId, period, sourceId });
  const reconResults = operatorAppliedReconResults({ sourceId, period, expected, l1 });
  for (const result of reconResults) {
    await upsertFrontProfitOperatorReconMetric(executor, runId, result);
  }

  return { appliedRows, l1RowCount: l1Result.rowCount, reconResults };
}

export async function stageFrontProfitOperatorL1ToL3(
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
    sourceFamily: FRONT_PROFIT_OPERATOR_APPLIED_SOURCE_FAMILY,
    mappingVersionId: input.mappingVersionId,
    ruleVersion: input.ruleVersion ?? FRONT_PROFIT_OPERATOR_SOURCE_VERSION,
    jobVersion: input.jobVersion,
  });
}

export async function aggregateFrontProfitOperatorL3ToL4(
  executor: FrontProfitLayerSqlExecutor,
  input: {
    runId: number;
    period: string;
    writeRecon?: boolean;
  },
): Promise<FrontProfitL3L4AggregationResult> {
  return aggregateFrontProfitL3ToL4(executor, input);
}

export async function writeFrontProfitOperatorShadowReconciliation(
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

export function frontProfitOperatorAppliedRowsToManualBaseline(
  rows: FrontProfitOperatorAppliedRow[],
): FrontProfitL4AggRowForContract[] {
  const grouped = new Map<string, FrontProfitOperatorAppliedRow[]>();
  for (const row of rows) {
    const key = [
      row.attributionDate,
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
      date: first.attributionDate,
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
      note: "manual 01 baseline derived from operator source fixture",
      realRevenue: derived["真实营业额"],
      frontProfit: derived["前台利润"],
      paidRatio: derived["付费占比"],
      recordId: `MANUAL_OPERATOR_BASELINE_${first.attributionKey}`,
      dataStatus: "manual_baseline",
    };
  });
}
