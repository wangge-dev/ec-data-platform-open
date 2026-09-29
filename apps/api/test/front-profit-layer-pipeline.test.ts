import { describe, expect, test, vi } from "vitest";
import {
  calculateFrontProfitDerivedValues,
  FRONT_PROFIT_DERIVED_FIELDS,
  FRONT_PROFIT_MONEY_INPUT_FIELDS,
  type FrontProfitFormulaInputField,
} from "../src/services/front-profit-formula.js";
import {
  aggregateFrontProfitL3ToL4,
  frontProfitL4AggRowToCanonicalRow,
  stageSyntheticFrontProfitL1ToL3,
  upsertFrontProfitL1SourceRows,
  writeFrontProfitShadowReconciliation,
  type FrontProfitL1SourceRowInput,
  type FrontProfitL4AggRowForContract,
} from "../src/services/front-profit-layers.js";
import {
  FRONT_PROFIT_REBATE_SOURCE_HEADERS,
  assertFrontProfitRebateSourceHeaders,
  aggregateFrontProfitRebateL3ToL4,
  frontProfitRebateSourceRowsToManualBaseline,
  loadFrontProfitRebateSource,
  normalizeFrontProfitRebateSourceRows,
  stageFrontProfitRebateL1ToL3,
  writeFrontProfitRebateShadowReconciliation,
  type FrontProfitRebateSourceRawRow,
} from "../src/services/front-profit-rebate-source.js";
import {
  FRONT_PROFIT_COST_SOURCE_HEADERS,
  FRONT_PROFIT_COST_USAGE_HEADERS,
  applyFrontProfitCostToUsageRows,
  assertFrontProfitCostSourceHeaders,
  assertFrontProfitCostUsageHeaders,
  aggregateFrontProfitCostL3ToL4,
  frontProfitCostAppliedRowsToManualBaseline,
  loadFrontProfitCostSource,
  normalizeFrontProfitCostSourceRows,
  normalizeFrontProfitCostUsageRows,
  stageFrontProfitCostL1ToL3,
  writeFrontProfitCostShadowReconciliation,
  type FrontProfitCostSourceRawRow,
  type FrontProfitCostUsageRawRow,
} from "../src/services/front-profit-cost-source.js";
import {
  FRONT_PROFIT_FEE_SOURCE_HEADERS,
  applyFrontProfitFeeAuthorityToL1,
  assertFrontProfitFeeSourceHeaders,
  aggregateFrontProfitFeeL3ToL4,
  frontProfitFeeAuthoritativeRowsToManualBaseline,
  loadFrontProfitFeeSource,
  normalizeFrontProfitFeeSourceRows,
  stageFrontProfitFeeL1ToL3,
  writeFrontProfitFeeShadowReconciliation,
  type FrontProfitFeeSourceRawRow,
} from "../src/services/front-profit-fee-source.js";
import {
  FRONT_PROFIT_OPERATOR_ASSIGNMENT_HEADERS,
  FRONT_PROFIT_OPERATOR_USAGE_HEADERS,
  applyFrontProfitOperatorToUsageRows,
  assertFrontProfitOperatorAssignmentHeaders,
  assertFrontProfitOperatorUsageHeaders,
  aggregateFrontProfitOperatorL3ToL4,
  frontProfitOperatorAppliedRowsToManualBaseline,
  loadFrontProfitOperatorAssignmentSource,
  normalizeFrontProfitOperatorAssignmentRows,
  normalizeFrontProfitOperatorUsageRows,
  stageFrontProfitOperatorL1ToL3,
  writeFrontProfitOperatorShadowReconciliation,
  type FrontProfitOperatorAssignmentRawRow,
  type FrontProfitOperatorUsageRawRow,
} from "../src/services/front-profit-operator-source.js";
import {
  FRONT_PROFIT_SALES_SOURCE_HEADERS,
  assertFrontProfitSalesSourceHeaders,
  aggregateFrontProfitSalesL3ToL4,
  frontProfitSalesAppliedRowsToManualBaseline,
  loadFrontProfitSalesSource,
  normalizeFrontProfitSalesSourceRows,
  stageFrontProfitSalesL1ToL3,
  writeFrontProfitSalesShadowReconciliation,
  type FrontProfitSalesSourceRawRow,
} from "../src/services/front-profit-sales-source.js";
import {
  FRONT_PROFIT_PROMOTION_SOURCE_HEADERS,
  assertFrontProfitPromotionSourceHeaders,
  aggregateFrontProfitPromotionL3ToL4,
  frontProfitPromotionAppliedRowsToManualBaseline,
  loadFrontProfitPromotionSource,
  normalizeFrontProfitPromotionSourceRows,
  stageFrontProfitPromotionL1ToL3,
  writeFrontProfitPromotionShadowReconciliation,
  type FrontProfitPromotionSourceRawRow,
} from "../src/services/front-profit-promotion-source.js";
import { FrontProfitBusinessRuleBlockError } from "../src/services/front-profit-business-rules.js";
import { FRONT_PROFIT_STANDARD_HEADERS, frontProfitAggregationKey } from "../src/services/front-profit-standard.js";
import { runFrontProfitDraftShadow } from "../src/services/front-profit-draft-runner.js";
import type { FrontProfitSourceFamily } from "../src/services/front-profit-source-loader.js";
import { syntheticFrontProfitL4AggRow } from "./fixtures/front-profit-complex-fixtures.js";

type L1Row = {
  id: number;
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
  amountValue: number | null;
  quantity: number | null;
  currency: string;
  rowPayload: Record<string, unknown>;
};

type RebateFactRow = {
  id: number;
  runId: number;
  sourceId: number;
  sourceRowNo: number;
  period: string;
  rebateKey: string;
  rebateEventDate: string;
  platform: string | null;
  shop: string | null;
  operatorKey: string | null;
  skuKey: string | null;
  orderKey: string | null;
  fillOrderAmount: number;
  fillOrderProductCost: number;
  fillOrderQuantity: number;
  rowPayload: Record<string, unknown>;
};

type CostPeriodRow = {
  id: number;
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
  rowPayload: Record<string, unknown>;
};

type FeeFactRow = {
  id: number;
  runId: number;
  sourceId: number;
  sourceRowNo: number;
  period: string;
  feeKey: string;
  eventDate: string;
  feeKind: string;
  authoritySource: string;
  authorityPriority: number;
  platform: string | null;
  shop: string | null;
  operatorKey: string | null;
  skuKey: string | null;
  adAccountKey: string | null;
  amount: number;
  currency: string;
  rowPayload: Record<string, unknown>;
};

type OperatorAssignmentFactRow = {
  id: number;
  runId: number;
  sourceId: number;
  sourceRowNo: number;
  period: string;
  shop: string;
  authorityKeyType: string;
  authorityKey: string;
  operator: string;
  effectiveFrom: string;
  effectiveTo: string;
  rowPayload: Record<string, unknown>;
};

type L3Row = {
  id: number;
  runId: number;
  detailKey: string;
  l1SourceRowId: number | null;
  sourceId: number | null;
  period: string;
  recordId: string;
  aggregationKey: string;
  date: string;
  platform: string;
  businessMode: string;
  groupName: string | null;
  shop: string;
  shopNormalized: string | null;
  operator: string;
  calculationRole: string;
  mappingVersionId: number | null;
  ruleVersion: string;
  jobVersion: string;
  quantity: number;
  gmv: number;
  fillOrderAmount: number;
  fillOrderProductCost: number;
  fillOrderQuantity: number;
  productCost: number;
  shipmentValue: number;
  platformFee: number;
  taxFee: number;
  financeCost: number;
  freight: number;
  commission: number;
  promotionFee: number;
  lineagePayload: Record<string, unknown>;
};

type L4Row = FrontProfitL4AggRowForContract & {
  id: number;
  runId: number;
  period: string;
  publishVersionId: number | null;
};

type ReconRow = {
  runId: number;
  layer: string;
  metric: string;
  expected: number | null;
  actual: number | null;
  tolerance: number | null;
  passed: boolean;
  evidenceRef: Record<string, unknown>;
};

type DqEventRow = {
  runId: number;
  severity: string;
  code: string;
  sourceId: number | null;
  rowNo: number | null;
  payload: Record<string, unknown>;
};

type DataSourceRow = {
  id: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
};

type JobRunRow = {
  id: number;
  moduleCode: string;
  scopeKey: string;
  status: string;
  inputBatchIds: unknown[];
};

type JobStepRow = {
  runId: number;
  stepKey: string;
  attempt: number;
  status: string;
  rowsIn: number | null;
  rowsOut: number | null;
  errorCode: string | null;
};

const numericColumns = [
  "quantity",
  "gmv",
  "fillOrderAmount",
  "fillOrderProductCost",
  "fillOrderQuantity",
  "productCost",
  "shipmentValue",
  "platformFee",
  "taxFee",
  "financeCost",
  "freight",
  "commission",
  "promotionFee",
] as const;

const dbNumericColumns = [
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

const formulaInputDbColumns = [
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

const toNumber = (value: unknown): number => Number(value ?? 0);

function jsonbParam<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

const formulaInputDbColumnByField = new Map<FrontProfitFormulaInputField, typeof formulaInputDbColumns[number]>(
  FRONT_PROFIT_MONEY_INPUT_FIELDS.map((field, index) => [field, formulaInputDbColumns[index]!]),
);

function payloadTextValue(payload: Record<string, unknown>, key: string): string | null {
  const value = String(payload[key] ?? "").trim();
  return value === "" ? null : value;
}

function stageNumberFromL1(row: L1Row, column: typeof dbNumericColumns[number]): number {
  if (column === "quantity") {
    if (row.amountKind === "quantity") return toNumber(row.amountValue);
    if (toNumber(row.quantity) !== 0) return toNumber(row.quantity);
  }
  const mappedColumn = formulaInputDbColumnByField.get(row.amountKind as FrontProfitFormulaInputField);
  if (mappedColumn === column) return toNumber(row.amountValue);
  return toNumber(row.rowPayload[column]);
}

function fakeLayerExecutor() {
  const dataSources: DataSourceRow[] = [];
  const ufTables = new Map<number, Array<Record<string, unknown>>>();
  const jobRuns: JobRunRow[] = [];
  const jobSteps: JobStepRow[] = [];
  const periodAuthority = new Map<string, { authority: string; close_day: number; reopened_at: null }>();
  const rebateFacts: RebateFactRow[] = [];
  const costPeriods: CostPeriodRow[] = [];
  const feeFacts: FeeFactRow[] = [];
  const operatorAssignments: OperatorAssignmentFactRow[] = [];
  const l1Rows: L1Row[] = [];
  const l3Rows: L3Row[] = [];
  const l4Rows: L4Row[] = [];
  const reconResults: ReconRow[] = [];
  const dqEvents: DqEventRow[] = [];
  let nextJobRunId = 9801;
  let nextPeriodAuthorityId = 1;
  let nextRebateFactId = 1;
  let nextCostPeriodId = 1;
  let nextFeeFactId = 1;
  let nextOperatorAssignmentId = 1;
  let nextL1Id = 1;
  let nextL3Id = 1;
  let nextL4Id = 1;

  const executor = {
    dataSources,
    ufTables,
    jobRuns,
    jobSteps,
    rebateFacts,
    costPeriods,
    feeFacts,
    operatorAssignments,
    l1Rows,
    l3Rows,
    l4Rows,
    reconResults,
    dqEvents,
    unsafe: vi.fn(async (query: string, parameters?: unknown[]) => {
      const text = String(query);

      if (text.startsWith("SELECT pg_advisory_xact_lock")) {
        return [];
      }

      if (text.startsWith("INSERT INTO public.period_authority")) {
        const scopeKey = String(parameters?.[1]);
        if (!periodAuthority.has(scopeKey)) {
          periodAuthority.set(scopeKey, {
            authority: "manual",
            close_day: Number(parameters?.[2] ?? 5),
            reopened_at: null,
          });
          return [{ id: nextPeriodAuthorityId++ }];
        }
        return [];
      }

      if (text.startsWith("INSERT INTO public.period_authority_event")) {
        return [];
      }

      if (text.startsWith("SELECT authority, close_day, reopened_at")) {
        const scopeKey = String(parameters?.[1]);
        return [periodAuthority.get(scopeKey) ?? {
          authority: "manual",
          close_day: 5,
          reopened_at: null,
        }];
      }

      if (text.startsWith("INSERT INTO public.job_run")) {
        const row = {
          id: nextJobRunId++,
          moduleCode: String(parameters?.[0]),
          scopeKey: String(parameters?.[1]),
          status: String(parameters?.[2]),
          inputBatchIds: jsonbParam<unknown[]>(parameters?.[3], []),
        };
        jobRuns.push(row);
        return [{ id: row.id }];
      }

      if (text.startsWith("UPDATE public.job_run")) {
        const runId = Number(parameters?.[0]);
        const status = String(parameters?.[2]);
        const row = jobRuns.find((item) => item.id === runId);
        if (row) row.status = status;
        return [];
      }

      if (text.startsWith("INSERT INTO public.job_step")) {
        const runId = Number(parameters?.[0]);
        const stepKey = String(parameters?.[1]);
        const attempt = Number(parameters?.[2]);
        const row: JobStepRow = {
          runId,
          stepKey,
          attempt,
          status: String(parameters?.[3]),
          rowsIn: parameters?.[4] == null ? null : Number(parameters?.[4]),
          rowsOut: parameters?.[5] == null ? null : Number(parameters?.[5]),
          errorCode: parameters?.[6] == null ? null : String(parameters?.[6]),
        };
        const existing = jobSteps.find((item) =>
          item.runId === runId && item.stepKey === stepKey && item.attempt === attempt);
        if (existing) Object.assign(existing, row);
        else jobSteps.push(row);
        return [];
      }

      if (text.startsWith("SELECT id, name, type, config")) {
        const sourceId = Number(parameters?.[0]);
        const source = dataSources.find((row) => row.id === sourceId);
        return source ? [source] : [];
      }

      if (text.startsWith("SELECT 1 FROM information_schema.tables")) {
        const tableName = String(parameters?.[1]);
        const sourceId = Number(/^uf_(\d+)$/.exec(tableName)?.[1]);
        return ufTables.has(sourceId) ? [{ "?column?": 1 }] : [];
      }

      const ufMatch = /FROM\s+"user_data"\."uf_(\d+)"/.exec(text);
      if (ufMatch) {
        return ufTables.get(Number(ufMatch[1])) ?? [];
      }

      if (text.startsWith("INSERT INTO public.front_profit_rebate_fact")) {
        const chunkSize = 15;
        const returned: Array<{ id: number }> = [];
        for (let i = 0; i < (parameters?.length ?? 0); i += chunkSize) {
          const runId = Number(parameters?.[i]);
          const rebateKey = String(parameters?.[i + 4]);
          const existing = rebateFacts.find((row) => row.runId === runId && row.rebateKey === rebateKey);
          const row: Omit<RebateFactRow, "id"> = {
            runId,
            sourceId: Number(parameters?.[i + 1]),
            sourceRowNo: Number(parameters?.[i + 2]),
            period: String(parameters?.[i + 3]),
            rebateKey,
            rebateEventDate: String(parameters?.[i + 5]),
            platform: parameters?.[i + 6] == null ? null : String(parameters?.[i + 6]),
            shop: parameters?.[i + 7] == null ? null : String(parameters?.[i + 7]),
            operatorKey: parameters?.[i + 8] == null ? null : String(parameters?.[i + 8]),
            skuKey: parameters?.[i + 9] == null ? null : String(parameters?.[i + 9]),
            orderKey: parameters?.[i + 10] == null ? null : String(parameters?.[i + 10]),
            fillOrderAmount: Number(parameters?.[i + 11]),
            fillOrderProductCost: Number(parameters?.[i + 12]),
            fillOrderQuantity: Number(parameters?.[i + 13]),
            rowPayload: jsonbParam<Record<string, unknown>>(parameters?.[i + 14], {}),
          };
          if (existing) {
            Object.assign(existing, row);
            returned.push({ id: existing.id });
          } else {
            const inserted = { id: nextRebateFactId++, ...row };
            rebateFacts.push(inserted);
            returned.push({ id: inserted.id });
          }
        }
        return returned;
      }

      if (text.startsWith("INSERT INTO public.front_profit_cost_period")) {
        const chunkSize = 11;
        const returned: Array<{ id: number }> = [];
        for (let i = 0; i < (parameters?.length ?? 0); i += chunkSize) {
          const runId = Number(parameters?.[i]);
          const skuKey = String(parameters?.[i + 4]);
          const costKind = "product_cost" as const;
          const effectiveFrom = String(parameters?.[i + 6]);
          const existing = costPeriods.find((row) =>
            row.runId === runId &&
            row.skuKey === skuKey &&
            row.costKind === costKind &&
            row.effectiveFrom === effectiveFrom,
          );
          const row: Omit<CostPeriodRow, "id"> = {
            runId,
            sourceId: Number(parameters?.[i + 1]),
            sourceRowNo: Number(parameters?.[i + 2]),
            period: String(parameters?.[i + 3]),
            skuKey,
            costKind,
            effectiveFrom,
            effectiveTo: String(parameters?.[i + 7]),
            unitCost: Number(parameters?.[i + 8]),
            currency: String(parameters?.[i + 9]),
            rowPayload: jsonbParam<Record<string, unknown>>(parameters?.[i + 10], {}),
          };
          if (existing) {
            Object.assign(existing, row);
            returned.push({ id: existing.id });
          } else {
            const inserted = { id: nextCostPeriodId++, ...row };
            costPeriods.push(inserted);
            returned.push({ id: inserted.id });
          }
        }
        return returned;
      }

      if (text.startsWith("INSERT INTO public.front_profit_fee_fact")) {
        const chunkSize = 17;
        const returned: Array<{ id: number }> = [];
        for (let i = 0; i < (parameters?.length ?? 0); i += chunkSize) {
          const runId = Number(parameters?.[i]);
          const feeKind = String(parameters?.[i + 4]);
          const authoritySource = String(parameters?.[i + 5]);
          const feeKey = String(parameters?.[i + 7]);
          const existing = feeFacts.find((row) =>
            row.runId === runId
            && row.feeKind === feeKind
            && row.authoritySource === authoritySource
            && row.feeKey === feeKey,
          );
          const row: Omit<FeeFactRow, "id"> = {
            runId,
            sourceId: Number(parameters?.[i + 1]),
            sourceRowNo: Number(parameters?.[i + 2]),
            period: String(parameters?.[i + 3]),
            feeKind,
            authoritySource,
            authorityPriority: Number(parameters?.[i + 6]),
            feeKey,
            eventDate: String(parameters?.[i + 8]),
            platform: parameters?.[i + 9] == null ? null : String(parameters?.[i + 9]),
            shop: parameters?.[i + 10] == null ? null : String(parameters?.[i + 10]),
            operatorKey: parameters?.[i + 11] == null ? null : String(parameters?.[i + 11]),
            skuKey: parameters?.[i + 12] == null ? null : String(parameters?.[i + 12]),
            adAccountKey: parameters?.[i + 13] == null ? null : String(parameters?.[i + 13]),
            amount: Number(parameters?.[i + 14]),
            currency: String(parameters?.[i + 15]),
            rowPayload: jsonbParam<Record<string, unknown>>(parameters?.[i + 16], {}),
          };
          if (existing) {
            Object.assign(existing, row);
            returned.push({ id: existing.id });
          } else {
            const inserted = { id: nextFeeFactId++, ...row };
            feeFacts.push(inserted);
            returned.push({ id: inserted.id });
          }
        }
        return returned;
      }

      if (text.startsWith("INSERT INTO public.front_profit_operator_assignment")) {
        const chunkSize = 11;
        const returned: Array<{ id: number }> = [];
        for (let i = 0; i < (parameters?.length ?? 0); i += chunkSize) {
          const runId = Number(parameters?.[i]);
          const shop = String(parameters?.[i + 4]);
          const authorityKeyType = String(parameters?.[i + 5]);
          const authorityKey = String(parameters?.[i + 6]);
          const effectiveFrom = String(parameters?.[i + 8]);
          const existing = operatorAssignments.find((row) =>
            row.runId === runId
            && row.shop === shop
            && row.authorityKeyType === authorityKeyType
            && row.authorityKey === authorityKey
            && row.effectiveFrom === effectiveFrom,
          );
          const row: Omit<OperatorAssignmentFactRow, "id"> = {
            runId,
            sourceId: Number(parameters?.[i + 1]),
            sourceRowNo: Number(parameters?.[i + 2]),
            period: String(parameters?.[i + 3]),
            shop,
            authorityKeyType,
            authorityKey,
            operator: String(parameters?.[i + 7]),
            effectiveFrom,
            effectiveTo: String(parameters?.[i + 9]),
            rowPayload: jsonbParam<Record<string, unknown>>(parameters?.[i + 10], {}),
          };
          if (existing) {
            Object.assign(existing, row);
            returned.push({ id: existing.id });
          } else {
            const inserted = { id: nextOperatorAssignmentId++, ...row };
            operatorAssignments.push(inserted);
            returned.push({ id: inserted.id });
          }
        }
        return returned;
      }

      if (text.startsWith("WITH input_rows AS") && text.includes("public.front_profit_l1_source_row")) {
        const rowCount = Array.isArray(parameters?.[0]) ? parameters[0].length : 0;
        const returned: Array<{ row_count: number }> = [];
        for (let i = 0; i < rowCount; i += 1) {
          const runId = Number((parameters?.[0] as unknown[])[i]);
          const sourceFamily = String((parameters?.[4] as unknown[])[i]);
          const sourceRecordKey = String((parameters?.[5] as unknown[])[i]);
          const amountKind = String((parameters?.[11] as unknown[])[i]);
          const existing = l1Rows.find((row) =>
            row.runId === runId &&
            row.sourceFamily === sourceFamily &&
            row.sourceRecordKey === sourceRecordKey &&
            row.amountKind === amountKind,
          );
          const row: Omit<L1Row, "id"> = {
            runId,
            sourceId: Number((parameters?.[1] as unknown[])[i]),
            sourceRowNo: Number((parameters?.[2] as unknown[])[i]),
            period: String((parameters?.[3] as unknown[])[i]),
            sourceFamily,
            sourceRecordKey,
            eventDate: String((parameters?.[6] as unknown[])[i]),
            platform: (parameters?.[7] as unknown[])[i] == null ? null : String((parameters?.[7] as unknown[])[i]),
            shop: (parameters?.[8] as unknown[])[i] == null ? null : String((parameters?.[8] as unknown[])[i]),
            operatorKey: (parameters?.[9] as unknown[])[i] == null ? null : String((parameters?.[9] as unknown[])[i]),
            skuKey: (parameters?.[10] as unknown[])[i] == null ? null : String((parameters?.[10] as unknown[])[i]),
            amountKind,
            amountValue: (parameters?.[12] as unknown[])[i] == null ? null : Number((parameters?.[12] as unknown[])[i]),
            quantity: (parameters?.[13] as unknown[])[i] == null ? null : Number((parameters?.[13] as unknown[])[i]),
            currency: String((parameters?.[14] as unknown[])[i]),
            rowPayload: jsonbParam<Record<string, unknown>>((parameters?.[15] as unknown[])[i], {}),
          };
          if (existing) Object.assign(existing, row);
          else l1Rows.push({ id: nextL1Id++, ...row });
        }
        returned.push({ row_count: rowCount });
        return returned;
      }

      if (text.startsWith("INSERT INTO public.front_profit_l1_source_row")) {
        const chunkSize = 16;
        const returned: Array<{ id: number }> = [];
        for (let i = 0; i < (parameters?.length ?? 0); i += chunkSize) {
          const runId = Number(parameters?.[i]);
          const sourceFamily = String(parameters?.[i + 4]);
          const sourceRecordKey = String(parameters?.[i + 5]);
          const amountKind = String(parameters?.[i + 11]);
          const existing = l1Rows.find((row) =>
            row.runId === runId &&
            row.sourceFamily === sourceFamily &&
            row.sourceRecordKey === sourceRecordKey &&
            row.amountKind === amountKind,
          );
          const row: Omit<L1Row, "id"> = {
            runId,
            sourceId: Number(parameters?.[i + 1]),
            sourceRowNo: Number(parameters?.[i + 2]),
            period: String(parameters?.[i + 3]),
            sourceFamily,
            sourceRecordKey,
            eventDate: String(parameters?.[i + 6]),
            platform: parameters?.[i + 7] == null ? null : String(parameters?.[i + 7]),
            shop: parameters?.[i + 8] == null ? null : String(parameters?.[i + 8]),
            operatorKey: parameters?.[i + 9] == null ? null : String(parameters?.[i + 9]),
            skuKey: parameters?.[i + 10] == null ? null : String(parameters?.[i + 10]),
            amountKind,
            amountValue: parameters?.[i + 12] == null ? null : Number(parameters?.[i + 12]),
            quantity: parameters?.[i + 13] == null ? null : Number(parameters?.[i + 13]),
            currency: String(parameters?.[i + 14]),
            rowPayload: jsonbParam<Record<string, unknown>>(parameters?.[i + 15], {}),
          };
          if (existing) {
            Object.assign(existing, row);
            returned.push({ id: existing.id });
          } else {
            const inserted = { id: nextL1Id++, ...row };
            l1Rows.push(inserted);
            returned.push({ id: inserted.id });
          }
        }
        return returned;
      }

      if (text.startsWith("SELECT COUNT(*)::int AS") && text.includes("FROM public.front_profit_rebate_fact")) {
        const runId = Number(parameters?.[0]);
        const period = String(parameters?.[1]);
        const sourceId = Number(parameters?.[2]);
        return [rebateFactSums(rebateFacts.filter((row) =>
          row.runId === runId && row.period === period && row.sourceId === sourceId,
        ))];
      }

      if (text.startsWith("SELECT COUNT(*)::int AS") && text.includes("FROM public.front_profit_cost_period")) {
        const runId = Number(parameters?.[0]);
        const period = String(parameters?.[1]);
        const sourceId = Number(parameters?.[2]);
        return [costPeriodSums(costPeriods.filter((row) =>
          row.runId === runId && row.period === period && row.sourceId === sourceId,
        ))];
      }

      if (text.startsWith("SELECT COUNT(*)::int AS") && text.includes("FROM public.front_profit_fee_fact")) {
        const runId = Number(parameters?.[0]);
        const period = String(parameters?.[1]);
        const sourceId = Number(parameters?.[2]);
        return [feeFactSums(feeFacts.filter((row) =>
          row.runId === runId && row.period === period && row.sourceId === sourceId,
        ))];
      }

      if (text.startsWith("SELECT COUNT(*)::int AS") && text.includes("FROM public.front_profit_operator_assignment")) {
        const runId = Number(parameters?.[0]);
        const period = String(parameters?.[1]);
        const sourceId = Number(parameters?.[2]);
        return [operatorAssignmentSums(operatorAssignments.filter((row) =>
          row.runId === runId && row.period === period && row.sourceId === sourceId,
        ))];
      }

      if (
        text.startsWith("SELECT COUNT(*)::int AS")
        && text.includes("FROM public.front_profit_l1_source_row")
        && text.includes("source_family")
      ) {
        const runId = Number(parameters?.[0]);
        const period = String(parameters?.[1]);
        const sourceId = Number(parameters?.[2]);
        const sourceFamily = String(parameters?.[3]);
        const scoped = l1Rows.filter((row) =>
          row.runId === runId
          && row.period === period
          && row.sourceId === sourceId
          && row.sourceFamily === sourceFamily);
        if (text.includes("row_payload->>'unit_cost'")) return [costPeriodL1Sums(scoped)];
        if (text.includes("row_payload->>'product_cost'")) return [costAppliedL1Sums(scoped)];
        if (text.includes("row_payload->>'fee_amount'")) return [feeL1Sums(scoped, "fee_amount")];
        if (text.includes("row_payload->>'authority_amount'")) return [feeL1Sums(scoped, "authority_amount")];
        if (text.includes("row_payload->>'operator_row_count'")) return [operatorAssignmentL1Sums(scoped)];
        if (text.includes("row_payload->>'operator_attributed_gmv'")) return [operatorAppliedL1Sums(scoped)];
        if (text.includes("row_payload->>'sales_gmv'")) return [salesL1Sums(scoped)];
        if (text.includes("row_payload->>'promotion_fee'")) return [promotionL1Sums(scoped)];
        return [rebateL1Sums(scoped)];
      }

      if (text.startsWith("SELECT sku_key AS")) {
        const runId = Number(parameters?.[0]);
        const skuKeys = Array.isArray(parameters?.[1]) ? parameters?.[1].map(String) : [];
        return costPeriods
          .filter((row) => row.runId === runId && skuKeys.includes(row.skuKey))
          .sort((left, right) =>
            left.skuKey.localeCompare(right.skuKey) || left.effectiveFrom.localeCompare(right.effectiveFrom),
          )
          .map((row) => ({
            skuKey: row.skuKey,
            costKind: row.costKind,
            effectiveFrom: row.effectiveFrom,
            effectiveTo: row.effectiveTo,
            unitCost: row.unitCost,
          }));
      }

      if (text.startsWith("SELECT run_id AS")) {
        const runId = Number(parameters?.[0]);
        const period = String(parameters?.[1]);
        return feeFacts
          .filter((row) => row.runId === runId && row.period === period)
          .sort((left, right) =>
            left.feeKind.localeCompare(right.feeKind)
            || left.feeKey.localeCompare(right.feeKey)
            || left.authorityPriority - right.authorityPriority
            || left.id - right.id,
          )
          .map((row) => ({
            runId: row.runId,
            sourceId: row.sourceId,
            sourceRowNo: row.sourceRowNo,
            period: row.period,
            feeKey: row.feeKey,
            eventDate: row.eventDate,
            feeKind: row.feeKind,
            authoritySource: row.authoritySource,
            authorityPriority: row.authorityPriority,
            platform: row.platform,
            shop: row.shop,
            operatorKey: row.operatorKey,
            skuKey: row.skuKey,
            adAccountKey: row.adAccountKey,
            amount: row.amount,
            currency: row.currency,
            rowPayload: row.rowPayload,
          }));
      }

      if (text.startsWith("SELECT shop,")) {
        const runId = Number(parameters?.[0]);
        const shops = Array.isArray(parameters?.[1]) ? parameters?.[1].map(String) : [];
        return operatorAssignments
          .filter((row) => row.runId === runId && shops.includes(row.shop))
          .sort((left, right) =>
            left.shop.localeCompare(right.shop)
            || left.authorityKeyType.localeCompare(right.authorityKeyType)
            || left.authorityKey.localeCompare(right.authorityKey)
            || left.effectiveFrom.localeCompare(right.effectiveFrom),
          )
          .map((row) => ({
            shop: row.shop,
            authorityKeyType: row.authorityKeyType,
            authorityKey: row.authorityKey,
            operator: row.operator,
            effectiveFrom: row.effectiveFrom,
            effectiveTo: row.effectiveTo,
          }));
      }

      if (text.startsWith("SELECT id, source_id AS")) {
        const runId = Number(parameters?.[0]);
        const period = String(parameters?.[1]);
        const sourceFamily = String(parameters?.[2]);
        return l1Rows
          .filter((row) => row.runId === runId && row.period === period && row.sourceFamily === sourceFamily)
          .sort((left, right) => left.id - right.id)
          .map((row) => ({
            id: row.id,
            sourceId: row.sourceId,
            sourceRowNo: row.sourceRowNo,
            sourceRecordKey: row.sourceRecordKey,
            eventDate: row.eventDate,
            platform: row.platform,
            shop: row.shop,
            operatorKey: row.operatorKey,
            amountKind: row.amountKind,
            amountValue: row.amountValue,
            quantity: row.quantity,
            rowPayload: row.rowPayload,
          }));
      }

      if (text.startsWith("WITH staged AS") && text.includes("INSERT INTO public.front_profit_l3_calc_detail")) {
        const runId = Number(parameters?.[0]);
        const period = String(parameters?.[1]);
        const sourceFamily = String(parameters?.[2]);
        const mappingVersionId = parameters?.[3] == null ? null : Number(parameters?.[3]);
        const ruleVersion = String(parameters?.[4]);
        const jobVersion = String(parameters?.[5]);
        let rowCount = 0;
        for (const sourceRow of l1Rows
          .filter((row) => row.runId === runId && row.period === period && row.sourceFamily === sourceFamily)
          .sort((left, right) => left.id - right.id)) {
          const businessMode = payloadTextValue(sourceRow.rowPayload, "businessMode") ?? "";
          const platform = String(sourceRow.platform ?? "");
          const shop = String(sourceRow.shop ?? "");
          const operator = String(sourceRow.operatorKey ?? "");
          const detailKey = payloadTextValue(sourceRow.rowPayload, "detailKey")
            ?? `synthetic:${sourceRow.sourceRecordKey}:${sourceRow.amountKind}`;
          const existing = l3Rows.find((row) => row.runId === runId && row.detailKey === detailKey);
          const row: Omit<L3Row, "id"> = {
            runId,
            detailKey,
            l1SourceRowId: sourceRow.id,
            sourceId: sourceRow.sourceId,
            period,
            recordId: payloadTextValue(sourceRow.rowPayload, "recordId")
              ?? `SYNTHETIC_L3_${sourceRow.sourceRecordKey}_${sourceRow.amountKind}`,
            aggregationKey: frontProfitAggregationKey({
              date: sourceRow.eventDate,
              platform,
              businessMode,
              shop,
              operator,
            }),
            date: sourceRow.eventDate,
            platform,
            businessMode,
            groupName: payloadTextValue(sourceRow.rowPayload, "groupName"),
            shop,
            shopNormalized: payloadTextValue(sourceRow.rowPayload, "shopNormalized"),
            operator,
            calculationRole: payloadTextValue(sourceRow.rowPayload, "calculationRole") ?? "synthetic_passthrough",
            mappingVersionId,
            ruleVersion,
            jobVersion,
            quantity: stageNumberFromL1(sourceRow, "quantity"),
            gmv: stageNumberFromL1(sourceRow, "gmv"),
            fillOrderAmount: stageNumberFromL1(sourceRow, "fill_order_amount"),
            fillOrderProductCost: stageNumberFromL1(sourceRow, "fill_order_product_cost"),
            fillOrderQuantity: stageNumberFromL1(sourceRow, "fill_order_quantity"),
            productCost: stageNumberFromL1(sourceRow, "product_cost"),
            shipmentValue: stageNumberFromL1(sourceRow, "shipment_value"),
            platformFee: stageNumberFromL1(sourceRow, "platform_fee"),
            taxFee: stageNumberFromL1(sourceRow, "tax_fee"),
            financeCost: stageNumberFromL1(sourceRow, "finance_cost"),
            freight: stageNumberFromL1(sourceRow, "freight"),
            commission: stageNumberFromL1(sourceRow, "commission"),
            promotionFee: stageNumberFromL1(sourceRow, "promotion_fee"),
            lineagePayload: {
              sourceRecordKey: sourceRow.sourceRecordKey,
            },
          };
          if (existing) Object.assign(existing, row);
          else l3Rows.push({ id: nextL3Id++, ...row });
          rowCount += 1;
        }
        return [{ row_count: rowCount }];
      }

      if (text.startsWith("INSERT INTO public.front_profit_l3_calc_detail")) {
        const chunkSize = 32;
        const returned: Array<{ id: number }> = [];
        for (let i = 0; i < (parameters?.length ?? 0); i += chunkSize) {
          const runId = Number(parameters?.[i]);
          const detailKey = String(parameters?.[i + 1]);
          const existing = l3Rows.find((row) => row.runId === runId && row.detailKey === detailKey);
          const row: Omit<L3Row, "id"> = {
            runId,
            detailKey,
            l1SourceRowId: parameters?.[i + 2] == null ? null : Number(parameters?.[i + 2]),
            sourceId: parameters?.[i + 3] == null ? null : Number(parameters?.[i + 3]),
            period: String(parameters?.[i + 4]),
            recordId: String(parameters?.[i + 5]),
            aggregationKey: String(parameters?.[i + 6]),
            date: String(parameters?.[i + 7]),
            platform: String(parameters?.[i + 8]),
            businessMode: String(parameters?.[i + 9]),
            groupName: parameters?.[i + 10] == null ? null : String(parameters?.[i + 10]),
            shop: String(parameters?.[i + 11]),
            shopNormalized: parameters?.[i + 12] == null ? null : String(parameters?.[i + 12]),
            operator: String(parameters?.[i + 13]),
            calculationRole: String(parameters?.[i + 14]),
            mappingVersionId: parameters?.[i + 15] == null ? null : Number(parameters?.[i + 15]),
            ruleVersion: String(parameters?.[i + 16]),
            jobVersion: String(parameters?.[i + 17]),
            quantity: Number(parameters?.[i + 18]),
            gmv: Number(parameters?.[i + 19]),
            fillOrderAmount: Number(parameters?.[i + 20]),
            fillOrderProductCost: Number(parameters?.[i + 21]),
            fillOrderQuantity: Number(parameters?.[i + 22]),
            productCost: Number(parameters?.[i + 23]),
            shipmentValue: Number(parameters?.[i + 24]),
            platformFee: Number(parameters?.[i + 25]),
            taxFee: Number(parameters?.[i + 26]),
            financeCost: Number(parameters?.[i + 27]),
            freight: Number(parameters?.[i + 28]),
            commission: Number(parameters?.[i + 29]),
            promotionFee: Number(parameters?.[i + 30]),
            lineagePayload: jsonbParam<Record<string, unknown>>(parameters?.[i + 31], {}),
          };
          if (existing) {
            Object.assign(existing, row);
            returned.push({ id: existing.id });
          } else {
            const inserted = { id: nextL3Id++, ...row };
            l3Rows.push(inserted);
            returned.push({ id: inserted.id });
          }
        }
        return returned;
      }

      if (text.startsWith("DELETE FROM public.front_profit_l4_agg_row")) {
        const runId = Number(parameters?.[0]);
        const period = String(parameters?.[1]);
        for (let i = l4Rows.length - 1; i >= 0; i--) {
          const row = l4Rows[i];
          if (row?.runId === runId && row.period === period && row.publishVersionId == null) {
            l4Rows.splice(i, 1);
          }
        }
        return [];
      }

      if (text.startsWith("WITH agg AS")) {
        const runId = Number(parameters?.[0]);
        const period = String(parameters?.[1]);
        const groups = new Map<string, L3Row[]>();
        for (const row of l3Rows.filter((item) => item.runId === runId && item.period === period)) {
          groups.set(row.aggregationKey, [...(groups.get(row.aggregationKey) ?? []), row]);
        }
        const returned: Array<{ id: number }> = [];
        for (const group of groups.values()) {
          const first = group[0]!;
          const sums = Object.fromEntries(numericColumns.map((column) => [
            column,
            group.reduce((total, row) => total + Number(row[column]), 0),
          ])) as Record<typeof numericColumns[number], number>;
          const formulaInput = Object.fromEntries(FRONT_PROFIT_MONEY_INPUT_FIELDS.map((field, index) => [
            field,
            sums[camelNumericColumn(formulaInputDbColumns[index]!)],
          ])) as Record<FrontProfitFormulaInputField, number>;
          const derived = calculateFrontProfitDerivedValues((field) => formulaInput[field]);
          const row: L4Row = {
            id: nextL4Id++,
            runId,
            publishVersionId: null,
            period,
            aggregationKey: first.aggregationKey,
            date: first.date,
            platform: first.platform,
            businessMode: first.businessMode,
            groupName: first.groupName,
            shop: first.shop,
            shopNormalized: first.shopNormalized,
            operator: first.operator,
            quantity: sums.quantity,
            gmv: sums.gmv,
            fillOrderAmount: sums.fillOrderAmount,
            fillOrderProductCost: sums.fillOrderProductCost,
            fillOrderQuantity: sums.fillOrderQuantity,
            productCost: sums.productCost,
            shipmentValue: sums.shipmentValue,
            platformFee: sums.platformFee,
            taxFee: sums.taxFee,
            financeCost: sums.financeCost,
            freight: sums.freight,
            commission: sums.commission,
            promotionFee: sums.promotionFee,
            sourceBatch: `front-profit-l3-run:${runId}`,
            note: "aggregated from front_profit_l3_calc_detail",
            realRevenue: derived[FRONT_PROFIT_DERIVED_FIELDS[0]],
            frontProfit: derived[FRONT_PROFIT_DERIVED_FIELDS[1]],
            paidRatio: derived[FRONT_PROFIT_DERIVED_FIELDS[2]],
            recordId: `FP_L4_FAKE_${nextL4Id}`,
            dataStatus: "auto_draft",
          };
          l4Rows.push(row);
          returned.push({ id: row.id });
        }
        return returned;
      }

      if (text.startsWith("SELECT COUNT") && text.includes("FROM public.front_profit_l3_calc_detail")) {
        return [layerSums(l3Rows.filter((row) =>
          row.runId === Number(parameters?.[0]) && row.period === String(parameters?.[1]),
        ), true)];
      }

      if (text.startsWith("SELECT COUNT") && text.includes("FROM public.front_profit_l4_agg_row")) {
        return [layerSums(l4Rows.filter((row) =>
          row.runId === Number(parameters?.[0]) && row.period === String(parameters?.[1]),
        ), false)];
      }

      if (text.startsWith("SELECT date,")) {
        const runId = Number(parameters?.[0]);
        const period = String(parameters?.[1]);
        return l4Rows
          .filter((row) => row.runId === runId && row.period === period)
          .sort((left, right) => left.id - right.id)
          .map((row) => ({
            date: row.date,
            aggregation_key: row.aggregationKey,
            platform: row.platform,
            business_mode: row.businessMode,
            group_name: row.groupName,
            shop: row.shop,
            shop_normalized: row.shopNormalized,
            operator: row.operator,
            quantity: row.quantity,
            gmv: row.gmv,
            fill_order_amount: row.fillOrderAmount,
            fill_order_product_cost: row.fillOrderProductCost,
            fill_order_quantity: row.fillOrderQuantity,
            product_cost: row.productCost,
            shipment_value: row.shipmentValue,
            platform_fee: row.platformFee,
            tax_fee: row.taxFee,
            finance_cost: row.financeCost,
            freight: row.freight,
            commission: row.commission,
            promotion_fee: row.promotionFee,
            source_file: row.sourceFile ?? null,
            source_batch: row.sourceBatch ?? null,
            note: row.note ?? null,
            real_revenue: row.realRevenue,
            front_profit: row.frontProfit,
            paid_ratio: row.paidRatio,
            record_id: row.recordId,
            data_status: row.dataStatus ?? null,
          }));
      }

      if (text.startsWith("INSERT INTO public.recon_result")) {
        const runId = Number(parameters?.[0]);
        const layer = String(parameters?.[1]);
        const metric = String(parameters?.[2]);
        const next: ReconRow = {
          runId,
          layer,
          metric,
          expected: parameters?.[3] == null ? null : Number(parameters?.[3]),
          actual: parameters?.[4] == null ? null : Number(parameters?.[4]),
          tolerance: parameters?.[5] == null ? null : Number(parameters?.[5]),
          passed: parameters?.[6] === true,
          evidenceRef: jsonbParam<Record<string, unknown>>(parameters?.[7], {}),
        };
        const existing = reconResults.find((row) =>
          row.runId === runId && row.layer === layer && row.metric === metric,
        );
        if (existing) Object.assign(existing, next);
        else reconResults.push(next);
        return [];
      }

      if (text.startsWith("INSERT INTO public.dq_event")) {
        dqEvents.push({
          runId: Number(parameters?.[0]),
          severity: String(parameters?.[1]),
          code: String(parameters?.[2]),
          sourceId: parameters?.[3] == null ? null : Number(parameters?.[3]),
          rowNo: parameters?.[4] == null ? null : Number(parameters?.[4]),
          payload: jsonbParam<Record<string, unknown>>(parameters?.[5], {}),
        });
        return [];
      }

      throw new Error(`unexpected SQL: ${text}`);
    }),
  };
  return executor;
}

function registerUfSource(
  executor: ReturnType<typeof fakeLayerExecutor>,
  input: {
    sourceId: number;
    name?: string;
    headers: readonly string[];
    rows: Array<Record<string, unknown>>;
    family?: FrontProfitSourceFamily;
    validatedStandard?: boolean;
  },
): void {
  const fileName = input.name ?? `source-${input.sourceId}.csv`;
  const columns = input.headers.map((header, index) => ({
    raw: header,
    name: `c_${index + 1}`,
  }));
  const config: Record<string, unknown> = {
    originalFileName: fileName,
    rowCount: input.rows.length,
    columns,
    role: "file",
    ...(input.family ? { frontProfitSourceFamily: input.family } : {}),
  };
  if (input.validatedStandard) {
    const periods = [...new Set(input.rows.map((row) => String(row["日期"]).slice(0, 7)))].sort();
    config.frontProfitValidation = {
      schemaVersion: "front-profit-standard/v1",
      businessRowCount: input.rows.length,
      warningCount: 0,
      warningCodes: [],
    };
    config.frontProfitPeriods = periods;
    config.frontProfitScopeKeys = periods.map((period) => `front_profit:${period}`);
    config.frontProfitAuthority = "manual";
  }
  executor.dataSources.push({
    id: input.sourceId,
    name: fileName,
    type: "file",
    config,
  });
  executor.ufTables.set(input.sourceId, input.rows);
}

function registerStandardBaselineSource(
  executor: ReturnType<typeof fakeLayerExecutor>,
  sourceId: number,
  rows: FrontProfitL4AggRowForContract[],
): void {
  registerUfSource(executor, {
    sourceId,
    name: `manual-baseline-${sourceId}.xlsx`,
    headers: FRONT_PROFIT_STANDARD_HEADERS,
    rows: rows.map((row) =>
      Object.fromEntries(FRONT_PROFIT_STANDARD_HEADERS.map((header, index) => [
        header,
        frontProfitL4AggRowToCanonicalRow(row)[index],
      ]))),
    validatedStandard: true,
  });
}

function rebateFactSums(rows: RebateFactRow[]): Record<string, number> {
  return {
    rowCount: rows.length,
    fillOrderAmount: rows.reduce((total, row) => total + row.fillOrderAmount, 0),
    fillOrderProductCost: rows.reduce((total, row) => total + row.fillOrderProductCost, 0),
    fillOrderQuantity: rows.reduce((total, row) => total + row.fillOrderQuantity, 0),
  };
}

function costPeriodSums(rows: CostPeriodRow[]): Record<string, number> {
  return {
    rowCount: rows.length,
    unitCost: rows.reduce((total, row) => total + row.unitCost, 0),
  };
}

function feeFactSums(rows: FeeFactRow[]): Record<string, number> {
  return {
    rowCount: rows.length,
    amount: rows.reduce((total, row) => total + row.amount, 0),
  };
}

function operatorAssignmentSums(rows: OperatorAssignmentFactRow[]): Record<string, number> {
  return {
    rowCount: rows.length,
    rowMarker: rows.length,
  };
}

function rebateL1Sums(rows: L1Row[]): Record<string, number> {
  return {
    rowCount: rows.length,
    fillOrderAmount: rows.reduce((total, row) => total + toNumber(row.rowPayload.fill_order_amount), 0),
    fillOrderProductCost: rows.reduce((total, row) => total + toNumber(row.rowPayload.fill_order_product_cost), 0),
    fillOrderQuantity: rows.reduce((total, row) => total + toNumber(row.rowPayload.fill_order_quantity), 0),
  };
}

function costPeriodL1Sums(rows: L1Row[]): Record<string, number> {
  return {
    rowCount: rows.length,
    unitCost: rows.reduce((total, row) => total + toNumber(row.rowPayload.unit_cost), 0),
  };
}

function costAppliedL1Sums(rows: L1Row[]): Record<string, number> {
  return {
    rowCount: rows.length,
    productCost: rows.reduce((total, row) => total + toNumber(row.rowPayload.product_cost), 0),
  };
}

function feeL1Sums(rows: L1Row[], amountPayloadKey: "fee_amount" | "authority_amount"): Record<string, number> {
  return {
    rowCount: rows.length,
    amount: rows.reduce((total, row) => total + toNumber(row.rowPayload[amountPayloadKey]), 0),
  };
}

function operatorAssignmentL1Sums(rows: L1Row[]): Record<string, number> {
  return {
    rowCount: rows.length,
    rowMarker: rows.reduce((total, row) => total + toNumber(row.rowPayload.operator_row_count), 0),
  };
}

function operatorAppliedL1Sums(rows: L1Row[]): Record<string, number> {
  return {
    rowCount: rows.length,
    quantity: rows.reduce((total, row) => total + toNumber(row.rowPayload.quantity), 0),
    gmv: rows.reduce((total, row) => total + toNumber(row.rowPayload.operator_attributed_gmv), 0),
    shipmentValue: rows.reduce((total, row) =>
      total + toNumber(row.rowPayload.operator_attributed_shipment_value), 0),
  };
}

function salesL1Sums(rows: L1Row[]): Record<string, number> {
  return {
    rowCount: rows.length,
    quantity: rows.reduce((total, row) => total + toNumber(row.rowPayload.quantity), 0),
    gmv: rows.reduce((total, row) => total + toNumber(row.rowPayload.sales_gmv), 0),
    shipmentValue: rows.reduce((total, row) => total + toNumber(row.rowPayload.sales_shipment_value), 0),
  };
}

function promotionL1Sums(rows: L1Row[]): Record<string, number> {
  return {
    rowCount: rows.length,
    promotionFee: rows.reduce((total, row) => total + toNumber(row.rowPayload.promotion_fee), 0),
  };
}

function camelNumericColumn(column: typeof dbNumericColumns[number]): typeof numericColumns[number] {
  const index = dbNumericColumns.indexOf(column);
  if (index < 0) throw new Error(`unknown numeric column: ${column}`);
  return numericColumns[index]!;
}

function layerSums(rows: Array<L3Row | L4Row>, countDistinctAggregation: boolean): Record<string, number> {
  const aggregationKeys = new Set(rows.map((row) => row.aggregationKey));
  const result: Record<string, number> = {
    aggregation_key_count: countDistinctAggregation ? aggregationKeys.size : rows.length,
  };
  for (const column of dbNumericColumns) {
    const camel = camelNumericColumn(column);
    result[column] = rows.reduce((total, row) => total + toNumber(row[camel]), 0);
  }
  return result;
}

function l1InputFromContractRow(
  row: FrontProfitL4AggRowForContract,
  overrides: Partial<FrontProfitL1SourceRowInput> = {},
): FrontProfitL1SourceRowInput {
  return {
    runId: 9001,
    sourceId: 7001,
    sourceRowNo: 2,
    period: row.date.slice(0, 7),
    sourceFamily: "synthetic",
    sourceRecordKey: row.recordId,
    eventDate: row.date,
    platform: row.platform,
    shop: row.shop,
    operatorKey: row.operator,
    amountKind: "GMV",
    amountValue: row.gmv,
    quantity: row.quantity,
    currency: "CNY",
    rowPayload: {
      businessMode: row.businessMode,
      groupName: row.groupName,
      shopNormalized: row.shopNormalized,
      quantity: row.quantity,
      gmv: row.gmv,
      fill_order_amount: row.fillOrderAmount,
      fill_order_product_cost: row.fillOrderProductCost,
      fill_order_quantity: row.fillOrderQuantity,
      product_cost: row.productCost,
      shipment_value: row.shipmentValue,
      platform_fee: row.platformFee,
      tax_fee: row.taxFee,
      finance_cost: row.financeCost,
      freight: row.freight,
      commission: row.commission,
      promotion_fee: row.promotionFee,
    },
    ...overrides,
  };
}

describe("front-profit L1/L3/L4 synthetic pipeline", () => {
  test("upserts L1 fixture rows and stages L3 with lineage/version markers", async () => {
    const executor = fakeLayerExecutor();
    const row = syntheticFrontProfitL4AggRow({
      date: "2098-02-01",
      recordId: "SYNTHETIC_L1_001",
    });
    const input = l1InputFromContractRow(row);

    await expect(upsertFrontProfitL1SourceRows(executor, { rows: [input] })).resolves.toEqual({ rowCount: 1 });
    await expect(upsertFrontProfitL1SourceRows(executor, { rows: [input] })).resolves.toEqual({ rowCount: 1 });
    expect(executor.l1Rows).toHaveLength(1);

    await expect(stageSyntheticFrontProfitL1ToL3(executor, {
      runId: 9001,
      period: "2098-02",
      mappingVersionId: 6001,
      ruleVersion: "synthetic-rule/v1",
      jobVersion: "synthetic-job/v1",
    })).resolves.toEqual({ rowCount: 1 });

    expect(executor.l3Rows).toEqual([expect.objectContaining({
      runId: 9001,
      l1SourceRowId: 1,
      mappingVersionId: 6001,
      ruleVersion: "synthetic-rule/v1",
      jobVersion: "synthetic-job/v1",
      lineagePayload: expect.objectContaining({
        sourceRecordKey: "SYNTHETIC_L1_001",
      }),
    })]);
  });

  test("aggregates L3 detail rows into L4 and writes passing recon evidence", async () => {
    const executor = fakeLayerExecutor();
    const row1 = syntheticFrontProfitL4AggRow({
      date: "2098-02-01",
      recordId: "SYNTHETIC_L1_001",
    });
    const row2 = syntheticFrontProfitL4AggRow({
      date: "2098-02-01",
      recordId: "SYNTHETIC_L1_002",
    });

    await upsertFrontProfitL1SourceRows(executor, {
      rows: [
        l1InputFromContractRow(row1, { sourceRowNo: 2, sourceRecordKey: "ROW-001" }),
        l1InputFromContractRow(row2, { sourceRowNo: 3, sourceRecordKey: "ROW-002" }),
      ],
    });
    await stageSyntheticFrontProfitL1ToL3(executor, {
      runId: 9001,
      period: "2098-02",
      mappingVersionId: 6001,
      ruleVersion: "synthetic-rule/v1",
      jobVersion: "synthetic-job/v1",
    });

    const result = await aggregateFrontProfitL3ToL4(executor, {
      runId: 9001,
      period: "2098-02",
    });

    expect(result).toMatchObject({
      rowCount: 1,
      contract: {
        summary: {
          schemaVersion: "front-profit-standard/v1",
          businessRowCount: 1,
          warningCount: 0,
        },
      },
    });
    expect(executor.l4Rows).toEqual([expect.objectContaining({
      runId: 9001,
      period: "2098-02",
      quantity: 2,
      gmv: 200,
      sourceBatch: "front-profit-l3-run:9001",
    })]);
    expect(executor.reconResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ layer: "L3_L4", metric: "aggregation_key_count", passed: true }),
      expect.objectContaining({ layer: "L3_L4", metric: "gmv_sum", expected: 200, actual: 200, passed: true }),
      expect.objectContaining({ layer: "L4_CONTRACT", metric: "canonical_rows_contract", passed: true }),
    ]));
  });

  test("shadow reconciliation only writes recon and dq evidence", async () => {
    const executor = fakeLayerExecutor();
    const autoRow = syntheticFrontProfitL4AggRow({
      date: "2098-02-01",
      recordId: "AUTO_ROW",
    });
    executor.l4Rows.push({
      id: 1,
      runId: 9001,
      period: "2098-02",
      publishVersionId: null,
      ...autoRow,
    });
    const manualExtra = syntheticFrontProfitL4AggRow({
      date: "2098-02-02",
      recordId: "MANUAL_EXTRA",
    });

    const result = await writeFrontProfitShadowReconciliation(executor, {
      runId: 9001,
      period: "2098-02",
      manualRows: [autoRow, manualExtra],
      baselineLabel: "manual-01",
    });

    expect(result.dqEventCount).toBe(1);
    expect(executor.dqEvents).toEqual([expect.objectContaining({
      severity: "warn",
      code: "FRONT_PROFIT_SHADOW_MISSING_AUTO",
    })]);
    expect(executor.reconResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ layer: "SHADOW_MANUAL_AUTO", metric: "aggregation_key_set", passed: false }),
      expect.objectContaining({ layer: "SHADOW_MANUAL_AUTO", metric: "row_mismatch_count", actual: 1, passed: false }),
    ]));
    expect(executor.unsafe.mock.calls.some(([query]) =>
      String(query).includes("front_profit_publish_row"),
    )).toBe(false);
  });
});

describe("front-profit rebate source vertical slice", () => {
  test("pins the desensitized rebate source header contract", () => {
    expect(FRONT_PROFIT_REBATE_SOURCE_HEADERS).toEqual([
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
    ]);
    expect(() => assertFrontProfitRebateSourceHeaders(FRONT_PROFIT_REBATE_SOURCE_HEADERS)).not.toThrow();
    expect(() => assertFrontProfitRebateSourceHeaders([...FRONT_PROFIT_REBATE_SOURCE_HEADERS].reverse()))
      .toThrow("front-profit rebate source headers");
  });

  test("loads rebate rows through fact/L1/L3/L4 and compares them with a manual 01 baseline", async () => {
    const executor = fakeLayerExecutor();
    const rawRows: FrontProfitRebateSourceRawRow[] = [
      {
        补单ID: "REBATE-001",
        归属日期: "2026-08-10",
        平台: "Shopee",
        业务模式: "自营",
        组: "Kitchen",
        店铺: "SG Shop",
        店铺2: "SG Shop",
        运营: "Alice",
        SKU: "SKU-1",
        订单号: "ORDER-1",
        补单金额: "30.50",
        补单产品成本: "8.25",
        补单单量: "2",
        来源批次: "REBATE-202608",
        备注: "after-sale rebate",
      },
      {
        补单ID: "REBATE-002",
        归属日期: "2026-08-10",
        平台: "Shopee",
        业务模式: "自营",
        组: "Kitchen",
        店铺: "SG Shop",
        店铺2: "SG Shop",
        运营: "Alice",
        SKU: "SKU-2",
        订单号: "ORDER-2",
        补单金额: "19.50",
        补单产品成本: "3.75",
        补单单量: "1",
        来源批次: "REBATE-202608",
        备注: "shipping correction",
      },
    ];
    const rows = normalizeFrontProfitRebateSourceRows({
      runId: 9101,
      sourceId: 7201,
      sourceFile: "rebate-source-desensitized.csv",
      rows: rawRows,
    });

    expect(rows[0]).toMatchObject({
      sourceRowNo: 2,
      period: "2026-08",
      rebateKey: "REBATE-001",
      fillOrderAmount: 30.5,
      fillOrderProductCost: 8.25,
      fillOrderQuantity: 2,
    });

    const loadResult = await loadFrontProfitRebateSource(executor, { rows });
    expect(loadResult).toMatchObject({ factRowCount: 2, l1RowCount: 2 });
    expect(loadResult.reconResults.every((result) => result.passed)).toBe(true);
    expect(executor.rebateFacts).toHaveLength(2);
    expect(executor.l1Rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceFamily: "rebate",
        sourceRecordKey: "REBATE-001",
        amountKind: "rebate_fact",
        quantity: 0,
        rowPayload: expect.objectContaining({
          calculationRole: "rebate_contribution",
          fill_order_amount: 30.5,
          fill_order_product_cost: 8.25,
          fill_order_quantity: 2,
        }),
      }),
    ]));

    await expect(stageFrontProfitRebateL1ToL3(executor, {
      runId: 9101,
      period: "2026-08",
      mappingVersionId: 6101,
      jobVersion: "rebate-source-test/v1",
    })).resolves.toEqual({ rowCount: 2 });
    expect(executor.l3Rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        detailKey: "rebate:REBATE-001",
        quantity: 0,
        fillOrderAmount: 30.5,
        fillOrderProductCost: 8.25,
        fillOrderQuantity: 2,
        calculationRole: "rebate_contribution",
      }),
    ]));

    const aggregateResult = await aggregateFrontProfitRebateL3ToL4(executor, {
      runId: 9101,
      period: "2026-08",
    });
    expect(aggregateResult.contract.summary).toMatchObject({
      schemaVersion: "front-profit-standard/v1",
      businessRowCount: 1,
    });
    expect(executor.l4Rows).toEqual([expect.objectContaining({
      runId: 9101,
      period: "2026-08",
      quantity: 0,
      gmv: 0,
      fillOrderAmount: 50,
      fillOrderProductCost: 12,
      fillOrderQuantity: 3,
      frontProfit: -38,
      paidRatio: 0,
    })]);

    const shadowResult = await writeFrontProfitRebateShadowReconciliation(executor, {
      runId: 9101,
      period: "2026-08",
      manualRows: frontProfitRebateSourceRowsToManualBaseline(rows),
      baselineLabel: "manual-01-rebate",
    });
    expect(shadowResult.dqEventCount).toBe(0);
    expect(shadowResult.reconResults.every((result) => result.passed)).toBe(true);
    expect(executor.dqEvents).toEqual([]);
    expect(executor.unsafe.mock.calls.some(([query]) =>
      String(query).includes("front_profit_publish_row"),
    )).toBe(false);
  });
});

describe("front-profit cost source vertical slice", () => {
  test("pins the desensitized cost source and shipment usage header contracts", () => {
    expect(FRONT_PROFIT_COST_SOURCE_HEADERS).toEqual([
      "SKU",
      "成本类型",
      "生效开始",
      "生效结束",
      "单位成本",
      "币种",
      "来源批次",
      "备注",
    ]);
    expect(FRONT_PROFIT_COST_USAGE_HEADERS).toEqual([
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
    ]);
    expect(() => assertFrontProfitCostSourceHeaders(FRONT_PROFIT_COST_SOURCE_HEADERS)).not.toThrow();
    expect(() => assertFrontProfitCostUsageHeaders(FRONT_PROFIT_COST_USAGE_HEADERS)).not.toThrow();
    expect(() => assertFrontProfitCostSourceHeaders([...FRONT_PROFIT_COST_SOURCE_HEADERS].reverse()))
      .toThrow("front-profit cost source headers");
    expect(() => normalizeFrontProfitCostSourceRows({
      runId: 9201,
      sourceId: 7301,
      rows: [
        {
          SKU: "SKU-1",
          成本类型: "product_cost",
          生效开始: "2026-08-01",
          生效结束: "2026-08-20",
          单位成本: "12",
          币种: "CNY",
        },
        {
          SKU: "SKU-1",
          成本类型: "product_cost",
          生效开始: "2026-08-20",
          生效结束: "2026-08-31",
          单位成本: "13",
          币种: "CNY",
        },
      ],
    })).toThrow(FrontProfitBusinessRuleBlockError);
  });

  test("loads cost periods, applies shipment-date cost, and compares L4 with a manual 01 baseline", async () => {
    const executor = fakeLayerExecutor();
    const costRows = normalizeFrontProfitCostSourceRows({
      runId: 9201,
      sourceId: 7301,
      rows: [
        {
          SKU: "SKU-1",
          成本类型: "product_cost",
          生效开始: "2026-08-01",
          生效结束: "2026-08-31",
          单位成本: "12.50",
          币种: "CNY",
          来源批次: "COST-202608",
          备注: "monthly cost",
        },
        {
          SKU: "SKU-2",
          成本类型: "产品成本",
          生效开始: "2026-08-01",
          生效结束: "2026-08-31",
          单位成本: "7.00",
          币种: "CNY",
          来源批次: "COST-202608",
          备注: "monthly cost",
        },
      ] satisfies FrontProfitCostSourceRawRow[],
    });

    const costLoad = await loadFrontProfitCostSource(executor, { rows: costRows });
    expect(costLoad).toMatchObject({ factRowCount: 2, l1RowCount: 2 });
    expect(costLoad.reconResults.every((result) => result.passed)).toBe(true);
    expect(executor.costPeriods).toEqual(expect.arrayContaining([
      expect.objectContaining({
        skuKey: "SKU-1",
        effectiveFrom: "2026-08-01",
        effectiveTo: "2026-08-31",
        unitCost: 12.5,
      }),
    ]));

    const usageRows = normalizeFrontProfitCostUsageRows({
      runId: 9201,
      sourceId: 7302,
      sourceFile: "shipment-usage-desensitized.csv",
      rows: [
        {
          出货ID: "SHIP-001",
          发货日期: "2026-08-10",
          平台: "Shopee",
          业务模式: "自营",
          组: "Kitchen",
          店铺: "SG Shop",
          店铺2: "SG Shop",
          运营: "Alice",
          SKU: "SKU-1",
          出货数量: "2",
          出货货值: "100",
          来源批次: "SHIP-202608",
          备注: "cost usage fixture",
        },
        {
          出货ID: "SHIP-002",
          发货日期: "2026-08-10",
          平台: "Shopee",
          业务模式: "自营",
          组: "Kitchen",
          店铺: "SG Shop",
          店铺2: "SG Shop",
          运营: "Alice",
          SKU: "SKU-2",
          出货数量: "3",
          出货货值: "150",
          来源批次: "SHIP-202608",
          备注: "cost usage fixture",
        },
      ] satisfies FrontProfitCostUsageRawRow[],
    });

    const application = await applyFrontProfitCostToUsageRows(executor, { rows: usageRows });
    expect(application.l1RowCount).toBe(2);
    expect(application.reconResults.every((result) => result.passed)).toBe(true);
    expect(application.appliedRows).toEqual([
      expect.objectContaining({
        shipmentKey: "SHIP-001",
        unitCost: 12.5,
        productCost: 25,
        costEffectiveFrom: "2026-08-01",
      }),
      expect.objectContaining({
        shipmentKey: "SHIP-002",
        unitCost: 7,
        productCost: 21,
      }),
    ]);
    expect(executor.l1Rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceFamily: "cost_applied",
        sourceRecordKey: "SHIP-001",
        amountKind: "product_cost",
        quantity: 0,
        rowPayload: expect.objectContaining({
          calculationRole: "product_cost_contribution",
          product_cost: 25,
          shipment_value: 0,
        }),
      }),
    ]));

    await expect(stageFrontProfitCostL1ToL3(executor, {
      runId: 9201,
      period: "2026-08",
      mappingVersionId: 6201,
      jobVersion: "cost-source-test/v1",
    })).resolves.toEqual({ rowCount: 2 });

    const aggregateResult = await aggregateFrontProfitCostL3ToL4(executor, {
      runId: 9201,
      period: "2026-08",
    });
    expect(aggregateResult.contract.summary).toMatchObject({
      schemaVersion: "front-profit-standard/v1",
      businessRowCount: 1,
    });
    expect(executor.l4Rows).toEqual([expect.objectContaining({
      runId: 9201,
      period: "2026-08",
      quantity: 0,
      gmv: 0,
      productCost: 46,
      shipmentValue: 0,
      frontProfit: -46,
      paidRatio: 0,
    })]);

    const shadowResult = await writeFrontProfitCostShadowReconciliation(executor, {
      runId: 9201,
      period: "2026-08",
      manualRows: frontProfitCostAppliedRowsToManualBaseline(application.appliedRows),
      baselineLabel: "manual-01-cost",
    });
    expect(shadowResult.dqEventCount).toBe(0);
    expect(shadowResult.reconResults.every((result) => result.passed)).toBe(true);
    expect(executor.dqEvents).toEqual([]);
  });

  test("blocks cost application when shipment date has no matching cost period", async () => {
    const executor = fakeLayerExecutor();
    const costRows = normalizeFrontProfitCostSourceRows({
      runId: 9202,
      sourceId: 7301,
      rows: [{
        SKU: "SKU-1",
        成本类型: "product_cost",
        生效开始: "2026-08-01",
        生效结束: "2026-08-31",
        单位成本: "12.50",
        币种: "CNY",
      }],
    });
    await loadFrontProfitCostSource(executor, { rows: costRows });

    const usageRows = normalizeFrontProfitCostUsageRows({
      runId: 9202,
      sourceId: 7302,
      rows: [{
        出货ID: "SHIP-MISSING",
        发货日期: "2026-09-01",
        平台: "Shopee",
        业务模式: "自营",
        店铺: "SG Shop",
        运营: "Alice",
        SKU: "SKU-1",
        出货数量: "1",
        出货货值: "50",
      }],
    });

    await expect(applyFrontProfitCostToUsageRows(executor, { rows: usageRows }))
      .rejects.toMatchObject({ code: "COST_PERIOD_MISSING" });
  });
});

describe("front-profit fee source vertical slice", () => {
  test("pins the desensitized fee source header contract and enum mappings", () => {
    expect(FRONT_PROFIT_FEE_SOURCE_HEADERS).toEqual([
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
    ]);
    expect(() => assertFrontProfitFeeSourceHeaders(FRONT_PROFIT_FEE_SOURCE_HEADERS)).not.toThrow();
    expect(() => assertFrontProfitFeeSourceHeaders([...FRONT_PROFIT_FEE_SOURCE_HEADERS].reverse()))
      .toThrow("front-profit fee source headers");

    const [row] = normalizeFrontProfitFeeSourceRows({
      runId: 9301,
      sourceId: 7401,
      rows: [{
        费用ID: "FEE-FREIGHT-001",
        费用日期: "2026-08-10",
        费用项: "运费",
        权威来源: "实际结算",
        平台: "Shopee",
        业务模式: "自营",
        店铺: "SG Shop",
        运营: "Alice",
        金额: "11.00",
        币种: "CNY",
      }],
    });
    expect(row).toMatchObject({
      period: "2026-08",
      feeKind: "freight",
      authoritySource: "settlement",
      authorityPriority: 1,
      amount: 11,
    });
  });

  test("loads fee facts, applies authority priority, and compares L4 with a manual 01 baseline", async () => {
    const executor = fakeLayerExecutor();
    const rows = normalizeFrontProfitFeeSourceRows({
      runId: 9301,
      sourceId: 7401,
      sourceFile: "fee-source-desensitized.csv",
      rows: [
        {
          费用ID: "FEE-FREIGHT-001",
          费用日期: "2026-08-10",
          费用项: "运费",
          权威来源: "费率规则",
          平台: "Shopee",
          业务模式: "自营",
          组: "Kitchen",
          店铺: "SG Shop",
          店铺2: "SG Shop",
          运营: "Alice",
          SKU: "SKU-1",
          广告账户: "AD-1",
          金额: "14.00",
          币种: "CNY",
          来源批次: "FEE-202608",
          备注: "rate estimate",
        },
        {
          费用ID: "FEE-FREIGHT-001",
          费用日期: "2026-08-10",
          费用项: "运费",
          权威来源: "实际结算",
          平台: "Shopee",
          业务模式: "自营",
          组: "Kitchen",
          店铺: "SG Shop",
          店铺2: "SG Shop",
          运营: "Alice",
          SKU: "SKU-1",
          广告账户: "AD-1",
          金额: "11.00",
          币种: "CNY",
          来源批次: "FEE-202608",
          备注: "settlement wins",
        },
        {
          费用ID: "FEE-COMMISSION-001",
          费用日期: "2026-08-10",
          费用项: "佣金",
          权威来源: "平台账单",
          平台: "Shopee",
          业务模式: "自营",
          组: "Kitchen",
          店铺: "SG Shop",
          店铺2: "SG Shop",
          运营: "Alice",
          SKU: "SKU-2",
          广告账户: "AD-2",
          金额: "6.00",
          币种: "CNY",
          来源批次: "FEE-202608",
          备注: "platform bill only",
        },
      ] satisfies FrontProfitFeeSourceRawRow[],
    });

    const loadResult = await loadFrontProfitFeeSource(executor, { rows });
    expect(loadResult).toMatchObject({ factRowCount: 3, l1RowCount: 3 });
    expect(loadResult.reconResults.every((result) => result.passed)).toBe(true);
    expect(executor.feeFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        feeKey: "FEE-FREIGHT-001",
        feeKind: "freight",
        authoritySource: "settlement",
        authorityPriority: 1,
        amount: 11,
      }),
      expect.objectContaining({
        feeKey: "FEE-FREIGHT-001",
        feeKind: "freight",
        authoritySource: "rate_rule",
        authorityPriority: 3,
        amount: 14,
      }),
    ]));

    const authority = await applyFrontProfitFeeAuthorityToL1(executor, {
      runId: 9301,
      period: "2026-08",
      requiredFeeKinds: ["freight", "commission"],
    });
    expect(authority.l1RowCount).toBe(2);
    expect(authority.reconResults.every((result) => result.passed)).toBe(true);
    expect(authority.authoritativeRows).toEqual([
      expect.objectContaining({
        feeKey: "FEE-COMMISSION-001",
        feeKind: "commission",
        selectedAuthoritySource: "platform_bill",
        amount: 6,
      }),
      expect.objectContaining({
        feeKey: "FEE-FREIGHT-001",
        feeKind: "freight",
        selectedAuthoritySource: "settlement",
        amount: 11,
      }),
    ]);
    expect(executor.l1Rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceFamily: "fee_authoritative",
        sourceRecordKey: "freight:FEE-FREIGHT-001",
        amountKind: "authority_amount",
        quantity: 0,
        rowPayload: expect.objectContaining({
          calculationRole: "fee_contribution",
          freight: 11,
          commission: 0,
          authority_amount: 11,
        }),
      }),
      expect.objectContaining({
        sourceFamily: "fee_authoritative",
        sourceRecordKey: "commission:FEE-COMMISSION-001",
        amountKind: "authority_amount",
        rowPayload: expect.objectContaining({
          freight: 0,
          commission: 6,
          authority_amount: 6,
        }),
      }),
    ]));

    await expect(stageFrontProfitFeeL1ToL3(executor, {
      runId: 9301,
      period: "2026-08",
      mappingVersionId: 6301,
      jobVersion: "fee-source-test/v1",
    })).resolves.toEqual({ rowCount: 2 });
    expect(executor.l3Rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        detailKey: "fee:freight:FEE-FREIGHT-001",
        quantity: 0,
        freight: 11,
        commission: 0,
        calculationRole: "fee_contribution",
      }),
      expect.objectContaining({
        detailKey: "fee:commission:FEE-COMMISSION-001",
        freight: 0,
        commission: 6,
        calculationRole: "fee_contribution",
      }),
    ]));

    const aggregateResult = await aggregateFrontProfitFeeL3ToL4(executor, {
      runId: 9301,
      period: "2026-08",
    });
    expect(aggregateResult.contract.summary).toMatchObject({
      schemaVersion: "front-profit-standard/v1",
      businessRowCount: 1,
    });
    expect(executor.l4Rows).toEqual([expect.objectContaining({
      runId: 9301,
      period: "2026-08",
      quantity: 0,
      gmv: 0,
      freight: 11,
      commission: 6,
      frontProfit: -17,
      paidRatio: 0,
    })]);

    const shadowResult = await writeFrontProfitFeeShadowReconciliation(executor, {
      runId: 9301,
      period: "2026-08",
      manualRows: frontProfitFeeAuthoritativeRowsToManualBaseline(authority.authoritativeRows),
      baselineLabel: "manual-01-fee",
    });
    expect(shadowResult.dqEventCount).toBe(0);
    expect(shadowResult.reconResults.every((result) => result.passed)).toBe(true);
    expect(executor.dqEvents).toEqual([]);
    expect(executor.unsafe.mock.calls.some(([query]) =>
      String(query).includes("front_profit_publish_row"),
    )).toBe(false);
  });

  test("blocks required fee kind when no authoritative candidate exists in the period", async () => {
    const executor = fakeLayerExecutor();
    const rows = normalizeFrontProfitFeeSourceRows({
      runId: 9302,
      sourceId: 7401,
      rows: [{
        费用ID: "FEE-FREIGHT-ONLY",
        费用日期: "2026-08-10",
        费用项: "运费",
        权威来源: "实际结算",
        平台: "Shopee",
        业务模式: "自营",
        店铺: "SG Shop",
        运营: "Alice",
        金额: "11.00",
        币种: "CNY",
      }],
    });
    await loadFrontProfitFeeSource(executor, { rows });

    await expect(applyFrontProfitFeeAuthorityToL1(executor, {
      runId: 9302,
      period: "2026-08",
      requiredFeeKinds: ["commission"],
    })).rejects.toMatchObject({ code: "FEE_AUTHORITY_MISSING" });
  });
});

describe("front-profit operator source vertical slice", () => {
  test("pins the desensitized operator assignment and usage header contracts", () => {
    expect(FRONT_PROFIT_OPERATOR_ASSIGNMENT_HEADERS).toEqual([
      "店铺",
      "权威键类型",
      "权威键",
      "运营",
      "生效开始",
      "生效结束",
      "来源批次",
      "备注",
    ]);
    expect(FRONT_PROFIT_OPERATOR_USAGE_HEADERS).toEqual([
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
    ]);
    expect(() => assertFrontProfitOperatorAssignmentHeaders(FRONT_PROFIT_OPERATOR_ASSIGNMENT_HEADERS))
      .not.toThrow();
    expect(() => assertFrontProfitOperatorUsageHeaders(FRONT_PROFIT_OPERATOR_USAGE_HEADERS))
      .not.toThrow();
    expect(() => assertFrontProfitOperatorAssignmentHeaders([...FRONT_PROFIT_OPERATOR_ASSIGNMENT_HEADERS].reverse()))
      .toThrow("front-profit operator assignment headers");
    expect(() => normalizeFrontProfitOperatorAssignmentRows({
      runId: 9401,
      sourceId: 7501,
      rows: [
        {
          店铺: "SG Shop",
          权威键类型: "SKU",
          权威键: "SKU-1",
          运营: "Alice",
          生效开始: "2026-08-01",
          生效结束: "2026-08-20",
        },
        {
          店铺: "SG Shop",
          权威键类型: "sku",
          权威键: "SKU-1",
          运营: "Bob",
          生效开始: "2026-08-20",
          生效结束: "2026-08-31",
        },
      ],
    })).toThrow(FrontProfitBusinessRuleBlockError);
  });

  test("loads operator assignments, resolves usage rows, and compares L4 with a manual 01 baseline", async () => {
    const executor = fakeLayerExecutor();
    const assignments = normalizeFrontProfitOperatorAssignmentRows({
      runId: 9401,
      sourceId: 7501,
      rows: [
        {
          店铺: "SG Shop",
          权威键类型: "SKU",
          权威键: "SKU-1",
          运营: "Alice",
          生效开始: "2026-08-01",
          生效结束: "2026-08-31",
          来源批次: "OWNER-202608",
          备注: "sku owner wins",
        },
        {
          店铺: "SG Shop",
          权威键类型: "广告账户",
          权威键: "AD-1",
          运营: "Bob",
          生效开始: "2026-08-01",
          生效结束: "2026-08-31",
          来源批次: "OWNER-202608",
          备注: "lower priority than sku",
        },
        {
          店铺: "SG Shop",
          权威键类型: "ad_account",
          权威键: "AD-2",
          运营: "Carol",
          生效开始: "2026-08-01",
          生效结束: "2026-08-31",
          来源批次: "OWNER-202608",
          备注: "ad account fallback",
        },
      ] satisfies FrontProfitOperatorAssignmentRawRow[],
    });

    const loadResult = await loadFrontProfitOperatorAssignmentSource(executor, { rows: assignments });
    expect(loadResult).toMatchObject({ assignmentRowCount: 3, l1RowCount: 3 });
    expect(loadResult.reconResults.every((result) => result.passed)).toBe(true);
    expect(executor.operatorAssignments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        shop: "SG Shop",
        authorityKeyType: "sku",
        authorityKey: "SKU-1",
        operator: "Alice",
      }),
      expect.objectContaining({
        shop: "SG Shop",
        authorityKeyType: "ad_account",
        authorityKey: "AD-2",
        operator: "Carol",
      }),
    ]));

    const usageRows = normalizeFrontProfitOperatorUsageRows({
      runId: 9401,
      sourceId: 7502,
      sourceFile: "operator-usage-desensitized.csv",
      rows: [
        {
          归属ID: "ATTR-001",
          归属日期: "2026-08-10",
          平台: "Shopee",
          业务模式: "自营",
          组: "Kitchen",
          店铺: "SG Shop",
          店铺2: "SG Shop",
          SKU: "SKU-1",
          广告账户: "AD-1",
          产品负责人: "PRODUCT-9",
          订单负责人: "ORDER-9",
          手工映射键: "MANUAL-9",
          单量: "2",
          GMV: "100",
          出货货值: "80",
          来源批次: "ATTR-202608",
          备注: "sku should win over ad account",
        },
        {
          归属ID: "ATTR-002",
          归属日期: "2026-08-10",
          平台: "Shopee",
          业务模式: "自营",
          组: "Kitchen",
          店铺: "SG Shop",
          店铺2: "SG Shop",
          SKU: "SKU-404",
          广告账户: "AD-2",
          产品负责人: "PRODUCT-8",
          订单负责人: "ORDER-8",
          手工映射键: "MANUAL-8",
          单量: "1",
          GMV: "50",
          出货货值: "40",
          来源批次: "ATTR-202608",
          备注: "ad account fallback",
        },
      ] satisfies FrontProfitOperatorUsageRawRow[],
    });

    const application = await applyFrontProfitOperatorToUsageRows(executor, { rows: usageRows });
    expect(application.l1RowCount).toBe(2);
    expect(application.reconResults.every((result) => result.passed)).toBe(true);
    expect(application.appliedRows).toEqual([
      expect.objectContaining({
        attributionKey: "ATTR-001",
        operatorKey: "Alice",
        matchedAuthorityKeyType: "sku",
        matchedAuthorityKey: "SKU-1",
      }),
      expect.objectContaining({
        attributionKey: "ATTR-002",
        operatorKey: "Carol",
        matchedAuthorityKeyType: "ad_account",
        matchedAuthorityKey: "AD-2",
      }),
    ]);
    expect(executor.l1Rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceFamily: "operator_applied",
        sourceRecordKey: "ATTR-001",
        operatorKey: "Alice",
        amountKind: "operator_attributed_gmv",
        quantity: 2,
        rowPayload: expect.objectContaining({
          calculationRole: "operator_attributed_contribution",
          matchedAuthorityKeyType: "sku",
          quantity: 2,
          gmv: 100,
          shipment_value: 80,
        }),
      }),
    ]));

    await expect(stageFrontProfitOperatorL1ToL3(executor, {
      runId: 9401,
      period: "2026-08",
      mappingVersionId: 6401,
      jobVersion: "operator-source-test/v1",
    })).resolves.toEqual({ rowCount: 2 });
    expect(executor.l3Rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        detailKey: "operator:ATTR-001",
        operator: "Alice",
        quantity: 2,
        gmv: 100,
        shipmentValue: 80,
        calculationRole: "operator_attributed_contribution",
      }),
      expect.objectContaining({
        detailKey: "operator:ATTR-002",
        operator: "Carol",
        quantity: 1,
        gmv: 50,
        shipmentValue: 40,
      }),
    ]));

    const aggregateResult = await aggregateFrontProfitOperatorL3ToL4(executor, {
      runId: 9401,
      period: "2026-08",
    });
    expect(aggregateResult.contract.summary).toMatchObject({
      schemaVersion: "front-profit-standard/v1",
      businessRowCount: 2,
    });
    expect(executor.l4Rows).toEqual([
      expect.objectContaining({
        runId: 9401,
        period: "2026-08",
        operator: "Alice",
        quantity: 2,
        gmv: 100,
        shipmentValue: 80,
        realRevenue: 100,
        frontProfit: 80,
      }),
      expect.objectContaining({
        runId: 9401,
        period: "2026-08",
        operator: "Carol",
        quantity: 1,
        gmv: 50,
        shipmentValue: 40,
        realRevenue: 50,
        frontProfit: 40,
      }),
    ]);

    const shadowResult = await writeFrontProfitOperatorShadowReconciliation(executor, {
      runId: 9401,
      period: "2026-08",
      manualRows: frontProfitOperatorAppliedRowsToManualBaseline(application.appliedRows),
      baselineLabel: "manual-01-operator",
    });
    expect(shadowResult.dqEventCount).toBe(0);
    expect(shadowResult.reconResults.every((result) => result.passed)).toBe(true);
    expect(executor.dqEvents).toEqual([]);
  });

  test("blocks operator application when no authority key matches", async () => {
    const executor = fakeLayerExecutor();
    const assignments = normalizeFrontProfitOperatorAssignmentRows({
      runId: 9402,
      sourceId: 7501,
      rows: [{
        店铺: "SG Shop",
        权威键类型: "SKU",
        权威键: "SKU-1",
        运营: "Alice",
        生效开始: "2026-08-01",
        生效结束: "2026-08-31",
      }],
    });
    await loadFrontProfitOperatorAssignmentSource(executor, { rows: assignments });

    const usageRows = normalizeFrontProfitOperatorUsageRows({
      runId: 9402,
      sourceId: 7502,
      rows: [{
        归属ID: "ATTR-MISSING",
        归属日期: "2026-08-10",
        平台: "Shopee",
        业务模式: "自营",
        店铺: "SG Shop",
        SKU: "SKU-404",
        广告账户: "AD-404",
        产品负责人: "PRODUCT-404",
        订单负责人: "ORDER-404",
        手工映射键: "MANUAL-404",
        单量: "1",
        GMV: "50",
        出货货值: "40",
      }],
    });

    await expect(applyFrontProfitOperatorToUsageRows(executor, { rows: usageRows }))
      .rejects.toMatchObject({ code: "OWNER_MISSING" });
  });
});

describe("front-profit sales source vertical slice", () => {
  test("pins the desensitized sales source header contract", () => {
    expect(FRONT_PROFIT_SALES_SOURCE_HEADERS).toEqual([
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
    ]);
    expect(() => assertFrontProfitSalesSourceHeaders(FRONT_PROFIT_SALES_SOURCE_HEADERS)).not.toThrow();
    expect(() => assertFrontProfitSalesSourceHeaders([...FRONT_PROFIT_SALES_SOURCE_HEADERS].reverse()))
      .toThrow("front-profit sales source headers");

    const [row] = normalizeFrontProfitSalesSourceRows({
      runId: 9501,
      sourceId: 7601,
      rows: [{
        销售ID: "SALE-001",
        销售日期: "2026-08-10",
        平台: "Shopee",
        业务模式: "自营",
        店铺: "SG Shop",
        SKU: "SKU-1",
        单量: "2",
        GMV: "100",
        出货货值: "80",
      }],
    });
    expect(row).toMatchObject({
      period: "2026-08",
      saleKey: "SALE-001",
      quantity: 2,
      gmv: 100,
      shipmentValue: 80,
    });
  });

  test("loads sales rows after operator resolution and compares L4 with a manual 01 baseline", async () => {
    const executor = fakeLayerExecutor();
    const assignments = normalizeFrontProfitOperatorAssignmentRows({
      runId: 9501,
      sourceId: 7501,
      rows: [
        {
          店铺: "SG Shop",
          权威键类型: "SKU",
          权威键: "SKU-1",
          运营: "Alice",
          生效开始: "2026-08-01",
          生效结束: "2026-08-31",
        },
        {
          店铺: "SG Shop",
          权威键类型: "广告账户",
          权威键: "AD-2",
          运营: "Carol",
          生效开始: "2026-08-01",
          生效结束: "2026-08-31",
        },
      ] satisfies FrontProfitOperatorAssignmentRawRow[],
    });
    await loadFrontProfitOperatorAssignmentSource(executor, { rows: assignments });

    const rows = normalizeFrontProfitSalesSourceRows({
      runId: 9501,
      sourceId: 7601,
      sourceFile: "sales-source-desensitized.csv",
      rows: [
        {
          销售ID: "SALE-001",
          销售日期: "2026-08-10",
          平台: "Shopee",
          业务模式: "自营",
          组: "Kitchen",
          店铺: "SG Shop",
          店铺2: "SG Shop",
          SKU: "SKU-1",
          广告账户: "AD-1",
          产品负责人: "PRODUCT-1",
          订单负责人: "ORDER-1",
          手工映射键: "MANUAL-1",
          单量: "2",
          GMV: "100",
          出货货值: "80",
          来源批次: "SALES-202608",
          备注: "sku owner",
        },
        {
          销售ID: "SALE-002",
          销售日期: "2026-08-10",
          平台: "Shopee",
          业务模式: "自营",
          组: "Kitchen",
          店铺: "SG Shop",
          店铺2: "SG Shop",
          SKU: "SKU-404",
          广告账户: "AD-2",
          产品负责人: "PRODUCT-2",
          订单负责人: "ORDER-2",
          手工映射键: "MANUAL-2",
          单量: "1",
          GMV: "50",
          出货货值: "40",
          来源批次: "SALES-202608",
          备注: "ad account owner",
        },
      ] satisfies FrontProfitSalesSourceRawRow[],
    });

    const loadResult = await loadFrontProfitSalesSource(executor, { rows });
    expect(loadResult.l1RowCount).toBe(2);
    expect(loadResult.reconResults.every((result) => result.passed)).toBe(true);
    expect(loadResult.appliedRows).toEqual([
      expect.objectContaining({
        saleKey: "SALE-001",
        operatorKey: "Alice",
        matchedAuthorityKeyType: "sku",
      }),
      expect.objectContaining({
        saleKey: "SALE-002",
        operatorKey: "Carol",
        matchedAuthorityKeyType: "ad_account",
      }),
    ]);
    expect(executor.l1Rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceFamily: "sales_fact",
        sourceRecordKey: "SALE-001",
        operatorKey: "Alice",
        amountKind: "sales_gmv",
        quantity: 2,
        rowPayload: expect.objectContaining({
          calculationRole: "sales_contribution",
          matchedAuthorityKeyType: "sku",
          quantity: 2,
          gmv: 100,
          shipment_value: 80,
        }),
      }),
    ]));

    await expect(stageFrontProfitSalesL1ToL3(executor, {
      runId: 9501,
      period: "2026-08",
      mappingVersionId: 6501,
      jobVersion: "sales-source-test/v1",
    })).resolves.toEqual({ rowCount: 2 });
    const l3StageCall = executor.unsafe.mock.calls.find(([query]) =>
      String(query).startsWith("WITH staged AS")
      && String(query).includes("INSERT INTO public.front_profit_l3_calc_detail")
    );
    expect(String(l3StageCall?.[0])).not.toContain("amount_kind_map");
    expect(String(l3StageCall?.[0])).not.toContain("unnest(");
    expect(String(l3StageCall?.[0])).toContain("WHEN l1.amount_kind = $7::text");
    expect(l3StageCall?.[1]?.slice(6)).toEqual([...FRONT_PROFIT_MONEY_INPUT_FIELDS]);

    const aggregateResult = await aggregateFrontProfitSalesL3ToL4(executor, {
      runId: 9501,
      period: "2026-08",
    });
    expect(aggregateResult.contract.summary).toMatchObject({
      schemaVersion: "front-profit-standard/v1",
      businessRowCount: 2,
    });
    expect(executor.l4Rows).toEqual([
      expect.objectContaining({
        runId: 9501,
        operator: "Alice",
        quantity: 2,
        gmv: 100,
        shipmentValue: 80,
        realRevenue: 100,
        frontProfit: 80,
      }),
      expect.objectContaining({
        runId: 9501,
        operator: "Carol",
        quantity: 1,
        gmv: 50,
        shipmentValue: 40,
        realRevenue: 50,
        frontProfit: 40,
      }),
    ]);

    const shadowResult = await writeFrontProfitSalesShadowReconciliation(executor, {
      runId: 9501,
      period: "2026-08",
      manualRows: frontProfitSalesAppliedRowsToManualBaseline(loadResult.appliedRows),
      baselineLabel: "manual-01-sales",
    });
    expect(shadowResult.dqEventCount).toBe(0);
    expect(shadowResult.reconResults.every((result) => result.passed)).toBe(true);
    expect(executor.dqEvents).toEqual([]);
  });

  test("blocks sales rows when operator authority mapping is missing", async () => {
    const executor = fakeLayerExecutor();
    const rows = normalizeFrontProfitSalesSourceRows({
      runId: 9502,
      sourceId: 7601,
      rows: [{
        销售ID: "SALE-MISSING",
        销售日期: "2026-08-10",
        平台: "Shopee",
        业务模式: "自营",
        店铺: "SG Shop",
        SKU: "SKU-404",
        单量: "1",
        GMV: "50",
        出货货值: "40",
      }],
    });

    await expect(loadFrontProfitSalesSource(executor, { rows }))
      .rejects.toMatchObject({ code: "OWNER_MISSING" });
  });
});

describe("front-profit promotion source vertical slice", () => {
  test("pins the desensitized promotion source header contract", () => {
    expect(FRONT_PROFIT_PROMOTION_SOURCE_HEADERS).toEqual([
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
    ]);
    expect(() => assertFrontProfitPromotionSourceHeaders(FRONT_PROFIT_PROMOTION_SOURCE_HEADERS))
      .not.toThrow();
    expect(() => assertFrontProfitPromotionSourceHeaders([...FRONT_PROFIT_PROMOTION_SOURCE_HEADERS].reverse()))
      .toThrow("front-profit promotion source headers");

    const [row] = normalizeFrontProfitPromotionSourceRows({
      runId: 9601,
      sourceId: 7701,
      rows: [{
        推广ID: "PROMO-001",
        推广日期: "2026-08-10",
        平台: "Shopee",
        业务模式: "自营",
        店铺: "SG Shop",
        广告账户: "AD-1",
        推广费: "12.50",
      }],
    });
    expect(row).toMatchObject({
      period: "2026-08",
      promotionKey: "PROMO-001",
      adAccountKey: "AD-1",
      promotionFee: 12.5,
    });
  });

  test("loads promotion rows through operator resolution and compares L4 with a manual 01 baseline", async () => {
    const executor = fakeLayerExecutor();
    const assignments = normalizeFrontProfitOperatorAssignmentRows({
      runId: 9601,
      sourceId: 7501,
      rows: [
        {
          店铺: "SG Shop",
          权威键类型: "SKU",
          权威键: "SKU-1",
          运营: "Alice",
          生效开始: "2026-08-01",
          生效结束: "2026-08-31",
        },
        {
          店铺: "SG Shop",
          权威键类型: "广告账户",
          权威键: "AD-1",
          运营: "Bob",
          生效开始: "2026-08-01",
          生效结束: "2026-08-31",
        },
      ] satisfies FrontProfitOperatorAssignmentRawRow[],
    });
    await loadFrontProfitOperatorAssignmentSource(executor, { rows: assignments });

    const rows = normalizeFrontProfitPromotionSourceRows({
      runId: 9601,
      sourceId: 7701,
      sourceFile: "promotion-source-desensitized.csv",
      rows: [
        {
          推广ID: "PROMO-001",
          推广日期: "2026-08-10",
          平台: "Shopee",
          业务模式: "自营",
          组: "Kitchen",
          店铺: "SG Shop",
          店铺2: "SG Shop",
          广告账户: "AD-1",
          SKU: "SKU-404",
          产品负责人: "PRODUCT-1",
          订单负责人: "ORDER-1",
          手工映射键: "MANUAL-1",
          推广费: "12.50",
          来源批次: "PROMO-202608",
          备注: "ad account owner",
        },
        {
          推广ID: "PROMO-002",
          推广日期: "2026-08-10",
          平台: "Shopee",
          业务模式: "自营",
          组: "Kitchen",
          店铺: "SG Shop",
          店铺2: "SG Shop",
          广告账户: "AD-1",
          SKU: "SKU-1",
          产品负责人: "PRODUCT-2",
          订单负责人: "ORDER-2",
          手工映射键: "MANUAL-2",
          推广费: "7.50",
          来源批次: "PROMO-202608",
          备注: "sku owner wins",
        },
      ] satisfies FrontProfitPromotionSourceRawRow[],
    });

    const loadResult = await loadFrontProfitPromotionSource(executor, { rows });
    expect(loadResult.l1RowCount).toBe(2);
    expect(loadResult.reconResults.every((result) => result.passed)).toBe(true);
    expect(loadResult.appliedRows).toEqual([
      expect.objectContaining({
        promotionKey: "PROMO-001",
        operatorKey: "Bob",
        matchedAuthorityKeyType: "ad_account",
      }),
      expect.objectContaining({
        promotionKey: "PROMO-002",
        operatorKey: "Alice",
        matchedAuthorityKeyType: "sku",
      }),
    ]);
    expect(executor.l1Rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceFamily: "promotion_spend",
        sourceRecordKey: "PROMO-001",
        operatorKey: "Bob",
        amountKind: "promotion_fee",
        quantity: 0,
        rowPayload: expect.objectContaining({
          calculationRole: "promotion_fee_contribution",
          matchedAuthorityKeyType: "ad_account",
          promotion_fee: 12.5,
        }),
      }),
    ]));

    await expect(stageFrontProfitPromotionL1ToL3(executor, {
      runId: 9601,
      period: "2026-08",
      mappingVersionId: 6601,
      jobVersion: "promotion-source-test/v1",
    })).resolves.toEqual({ rowCount: 2 });

    const aggregateResult = await aggregateFrontProfitPromotionL3ToL4(executor, {
      runId: 9601,
      period: "2026-08",
    });
    expect(aggregateResult.contract.summary).toMatchObject({
      schemaVersion: "front-profit-standard/v1",
      businessRowCount: 2,
    });
    expect(executor.l4Rows).toEqual([
      expect.objectContaining({
        runId: 9601,
        operator: "Bob",
        promotionFee: 12.5,
        frontProfit: -12.5,
        paidRatio: 0,
      }),
      expect.objectContaining({
        runId: 9601,
        operator: "Alice",
        promotionFee: 7.5,
        frontProfit: -7.5,
        paidRatio: 0,
      }),
    ]);

    const shadowResult = await writeFrontProfitPromotionShadowReconciliation(executor, {
      runId: 9601,
      period: "2026-08",
      manualRows: frontProfitPromotionAppliedRowsToManualBaseline(loadResult.appliedRows),
      baselineLabel: "manual-01-promotion",
    });
    expect(shadowResult.dqEventCount).toBe(0);
    expect(shadowResult.reconResults.every((result) => result.passed)).toBe(true);
    expect(executor.dqEvents).toEqual([]);
  });

  test("blocks promotion rows when no operator authority mapping matches", async () => {
    const executor = fakeLayerExecutor();
    const rows = normalizeFrontProfitPromotionSourceRows({
      runId: 9602,
      sourceId: 7701,
      rows: [{
        推广ID: "PROMO-MISSING",
        推广日期: "2026-08-10",
        平台: "Shopee",
        业务模式: "自营",
        店铺: "SG Shop",
        广告账户: "AD-404",
        推广费: "12.50",
      }],
    });

    await expect(loadFrontProfitPromotionSource(executor, { rows }))
      .rejects.toMatchObject({ code: "OWNER_MISSING" });
  });
});

describe("front-profit cross-source composition fixture", () => {
  test("combines sales, cost, rebate, fee, and promotion rows into one L4 result", async () => {
    const executor = fakeLayerExecutor();
    const runId = 9701;
    const period = "2026-08";

    const assignments = normalizeFrontProfitOperatorAssignmentRows({
      runId,
      sourceId: 7501,
      rows: [{
        店铺: "SG Shop",
        权威键类型: "SKU",
        权威键: "SKU-1",
        运营: "Alice",
        生效开始: "2026-08-01",
        生效结束: "2026-08-31",
      }] satisfies FrontProfitOperatorAssignmentRawRow[],
    });
    await loadFrontProfitOperatorAssignmentSource(executor, { rows: assignments });

    const salesRows = normalizeFrontProfitSalesSourceRows({
      runId,
      sourceId: 7601,
      rows: [{
        销售ID: "SALE-COMBO-001",
        销售日期: "2026-08-10",
        平台: "Shopee",
        业务模式: "自营",
        组: "Kitchen",
        店铺: "SG Shop",
        店铺2: "SG Shop",
        SKU: "SKU-1",
        广告账户: "AD-1",
        单量: "2",
        GMV: "100",
        出货货值: "80",
        来源批次: "COMBO-202608",
      }],
    });
    await loadFrontProfitSalesSource(executor, { rows: salesRows });
    await stageFrontProfitSalesL1ToL3(executor, {
      runId,
      period,
      mappingVersionId: 6701,
      jobVersion: "combo-source-test/v1",
    });

    const costRows = normalizeFrontProfitCostSourceRows({
      runId,
      sourceId: 7301,
      rows: [{
        SKU: "SKU-1",
        成本类型: "product_cost",
        生效开始: "2026-08-01",
        生效结束: "2026-08-31",
        单位成本: "20",
        币种: "CNY",
      }],
    });
    await loadFrontProfitCostSource(executor, { rows: costRows });
    const costUsageRows = normalizeFrontProfitCostUsageRows({
      runId,
      sourceId: 7302,
      rows: [{
        出货ID: "SHIP-COMBO-001",
        发货日期: "2026-08-10",
        平台: "Shopee",
        业务模式: "自营",
        组: "Kitchen",
        店铺: "SG Shop",
        店铺2: "SG Shop",
        运营: "Alice",
        SKU: "SKU-1",
        出货数量: "2",
        出货货值: "80",
      }],
    });
    await applyFrontProfitCostToUsageRows(executor, { rows: costUsageRows });
    await stageFrontProfitCostL1ToL3(executor, {
      runId,
      period,
      mappingVersionId: 6701,
      jobVersion: "combo-source-test/v1",
    });

    const rebateRows = normalizeFrontProfitRebateSourceRows({
      runId,
      sourceId: 7201,
      rows: [{
        补单ID: "REBATE-COMBO-001",
        归属日期: "2026-08-10",
        平台: "Shopee",
        业务模式: "自营",
        组: "Kitchen",
        店铺: "SG Shop",
        店铺2: "SG Shop",
        运营: "Alice",
        SKU: "SKU-1",
        补单金额: "10",
        补单产品成本: "3",
        补单单量: "1",
      }],
    });
    await loadFrontProfitRebateSource(executor, { rows: rebateRows });
    await stageFrontProfitRebateL1ToL3(executor, {
      runId,
      period,
      mappingVersionId: 6701,
      jobVersion: "combo-source-test/v1",
    });

    const feeRows = normalizeFrontProfitFeeSourceRows({
      runId,
      sourceId: 7401,
      rows: [{
        费用ID: "FEE-COMBO-FREIGHT",
        费用日期: "2026-08-10",
        费用项: "运费",
        权威来源: "实际结算",
        平台: "Shopee",
        业务模式: "自营",
        组: "Kitchen",
        店铺: "SG Shop",
        店铺2: "SG Shop",
        运营: "Alice",
        SKU: "SKU-1",
        金额: "5",
        币种: "CNY",
      }],
    });
    await loadFrontProfitFeeSource(executor, { rows: feeRows });
    await applyFrontProfitFeeAuthorityToL1(executor, {
      runId,
      period,
      requiredFeeKinds: ["freight"],
    });
    await stageFrontProfitFeeL1ToL3(executor, {
      runId,
      period,
      mappingVersionId: 6701,
      jobVersion: "combo-source-test/v1",
    });

    const promotionRows = normalizeFrontProfitPromotionSourceRows({
      runId,
      sourceId: 7701,
      rows: [{
        推广ID: "PROMO-COMBO-001",
        推广日期: "2026-08-10",
        平台: "Shopee",
        业务模式: "自营",
        组: "Kitchen",
        店铺: "SG Shop",
        店铺2: "SG Shop",
        广告账户: "AD-1",
        SKU: "SKU-1",
        推广费: "8",
      }],
    });
    await loadFrontProfitPromotionSource(executor, { rows: promotionRows });
    await stageFrontProfitPromotionL1ToL3(executor, {
      runId,
      period,
      mappingVersionId: 6701,
      jobVersion: "combo-source-test/v1",
    });

    const aggregateResult = await aggregateFrontProfitL3ToL4(executor, { runId, period });
    expect(aggregateResult.contract.summary).toMatchObject({
      schemaVersion: "front-profit-standard/v1",
      businessRowCount: 1,
    });
    expect(executor.l4Rows).toEqual([expect.objectContaining({
      runId,
      period,
      operator: "Alice",
      quantity: 2,
      gmv: 100,
      fillOrderAmount: 10,
      fillOrderProductCost: 3,
      fillOrderQuantity: 1,
      productCost: 40,
      shipmentValue: 80,
      freight: 5,
      promotionFee: 8,
      realRevenue: 90,
      frontProfit: 20,
      paidRatio: 0.08,
    })]);

    const manualCombinedRow: FrontProfitL4AggRowForContract = {
      date: "2026-08-10",
      platform: "Shopee",
      businessMode: "自营",
      groupName: "Kitchen",
      shop: "SG Shop",
      shopNormalized: "SG Shop",
      operator: "Alice",
      quantity: 2,
      gmv: 100,
      fillOrderAmount: 10,
      fillOrderProductCost: 3,
      fillOrderQuantity: 1,
      productCost: 40,
      shipmentValue: 80,
      platformFee: 0,
      taxFee: 0,
      financeCost: 0,
      freight: 5,
      commission: 0,
      promotionFee: 8,
      realRevenue: 90,
      frontProfit: 20,
      paidRatio: 0.08,
      recordId: "MANUAL_COMBO_BASELINE_001",
      dataStatus: "manual_baseline",
    };
    const shadowResult = await writeFrontProfitShadowReconciliation(executor, {
      runId,
      period,
      manualRows: [manualCombinedRow],
      baselineLabel: "manual-01-combo",
    });
    expect(shadowResult.dqEventCount).toBe(0);
    expect(shadowResult.reconResults.every((result) => result.passed)).toBe(true);
    expect(executor.dqEvents).toEqual([]);
  });
});

describe("front-profit uf source draft/shadow runner", () => {
  test("loads declared uf source families into an auto draft run without touching publish tables", async () => {
    const executor = fakeLayerExecutor();
    const period = "2026-08";
    registerUfSource(executor, {
      sourceId: 8101,
      headers: FRONT_PROFIT_OPERATOR_ASSIGNMENT_HEADERS,
      family: "operator_assignment",
      rows: [{
        店铺: "SG Shop",
        权威键类型: "SKU",
        权威键: "SKU-1",
        运营: "Alice",
        生效开始: "2026-08-01",
        生效结束: "2026-08-31",
      }],
    });
    registerUfSource(executor, {
      sourceId: 8102,
      headers: FRONT_PROFIT_SALES_SOURCE_HEADERS,
      family: "sales_fact",
      rows: [{
        销售ID: "SALE-UF-001",
        销售日期: "2026-08-10",
        平台: "Shopee",
        业务模式: "自营",
        组: "Kitchen",
        店铺: "SG Shop",
        店铺2: "SG Shop",
        SKU: "SKU-1",
        广告账户: "AD-1",
        单量: "2",
        GMV: "100",
        出货货值: "80",
        来源批次: "UF-SALES-202608",
      }],
    });
    const derived = calculateFrontProfitDerivedValues((field) => ({
      GMV: 100,
      补单金额: 0,
      补单产品成本: 0,
      产品成本: 0,
      出货货值: 80,
      "平台扣点/毛保": 0,
      税点: 0,
      财务成本: 0,
      运费: 0,
      佣金: 0,
      推广费: 0,
    })[field]);
    registerStandardBaselineSource(executor, 8103, [{
      date: "2026-08-10",
      platform: "Shopee",
      businessMode: "自营",
      groupName: "Kitchen",
      shop: "SG Shop",
      shopNormalized: "SG Shop",
      operator: "Alice",
      quantity: 2,
      gmv: 100,
      fillOrderAmount: 0,
      fillOrderProductCost: 0,
      fillOrderQuantity: 0,
      productCost: 0,
      shipmentValue: 80,
      platformFee: 0,
      taxFee: 0,
      financeCost: 0,
      freight: 0,
      commission: 0,
      promotionFee: 0,
      realRevenue: derived["真实营业额"],
      frontProfit: derived["前台利润"],
      paidRatio: derived["付费占比"],
      recordId: "MANUAL-UF-SALES-001",
      dataStatus: "manual_baseline",
    }]);

    const result = await runFrontProfitDraftShadow(executor, {
      period,
      sources: {
        operatorAssignmentSourceIds: [8101],
        salesSourceIds: [8102],
      },
      manualBaselineSourceId: 8103,
      today: "2026-08-20",
    });

    expect(result).toMatchObject({
      period,
      status: "recon_pending",
      l3RowCount: 1,
      l4RowCount: 1,
      dqEventCount: 0,
    });
    expect(executor.jobRuns).toEqual([expect.objectContaining({
      moduleCode: "front_profit",
      scopeKey: "front_profit:2026-08",
      status: "recon_pending",
      inputBatchIds: ["source:8101", "source:8102", "source:8103"],
    })]);
    expect(executor.jobSteps.map((step) => step.stepKey)).toEqual([
      "source_load",
      "l3_stage",
      "l4_aggregate",
      "shadow_recon",
    ]);
    expect(executor.l4Rows).toEqual([expect.objectContaining({
      runId: result.runId,
      period,
      dataStatus: "auto_draft",
      publishVersionId: null,
      gmv: 100,
      frontProfit: 80,
    })]);
    expect(executor.reconResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ layer: "SHADOW_MANUAL_AUTO", metric: "row_mismatch_count", passed: true }),
    ]));
    expect(executor.unsafe.mock.calls.some(([query]) =>
      String(query).includes("front_profit_publish_row"),
    )).toBe(false);
  });

  test("records a block event when a declared uf source is missing a required header", async () => {
    const executor = fakeLayerExecutor();
    registerUfSource(executor, {
      sourceId: 8201,
      headers: FRONT_PROFIT_SALES_SOURCE_HEADERS.filter((header) => header !== "GMV"),
      family: "sales_fact",
      rows: [{ 销售ID: "SALE-BAD-HEADER", 销售日期: "2026-08-10" }],
    });

    const result = await runFrontProfitDraftShadow(executor, {
      period: "2026-08",
      sources: { salesSourceIds: [8201] },
      today: "2026-08-20",
    });

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "FRONT_PROFIT_SOURCE_HEADER_MISSING",
    });
    expect(executor.dqEvents).toEqual([expect.objectContaining({
      severity: "block",
      code: "FRONT_PROFIT_SOURCE_HEADER_MISSING",
    })]);
  });

  test("records a block event when event rows cross the requested period", async () => {
    const executor = fakeLayerExecutor();
    registerUfSource(executor, {
      sourceId: 8202,
      headers: FRONT_PROFIT_SALES_SOURCE_HEADERS,
      family: "sales_fact",
      rows: [{
        销售ID: "SALE-CROSS-PERIOD",
        销售日期: "2026-09-01",
        平台: "Shopee",
        业务模式: "自营",
        店铺: "SG Shop",
        SKU: "SKU-1",
        单量: "1",
        GMV: "10",
      }],
    });

    const result = await runFrontProfitDraftShadow(executor, {
      period: "2026-08",
      sources: { salesSourceIds: [8202] },
      today: "2026-08-20",
    });

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "FRONT_PROFIT_SOURCE_PERIOD_MISMATCH",
    });
    expect(executor.dqEvents[0]).toMatchObject({
      severity: "block",
      code: "FRONT_PROFIT_SOURCE_PERIOD_MISMATCH",
    });
  });

  test("records OWNER_MISSING when sales rows have no operator authority mapping", async () => {
    const executor = fakeLayerExecutor();
    registerUfSource(executor, {
      sourceId: 8203,
      headers: FRONT_PROFIT_SALES_SOURCE_HEADERS,
      family: "sales_fact",
      rows: [{
        销售ID: "SALE-NO-OWNER",
        销售日期: "2026-08-10",
        平台: "Shopee",
        业务模式: "自营",
        店铺: "SG Shop",
        SKU: "SKU-404",
        单量: "1",
        GMV: "10",
      }],
    });

    const result = await runFrontProfitDraftShadow(executor, {
      period: "2026-08",
      sources: { salesSourceIds: [8203] },
      today: "2026-08-20",
    });

    expect(result).toMatchObject({ status: "failed", errorCode: "OWNER_MISSING" });
    expect(executor.dqEvents[0]).toMatchObject({ severity: "block", code: "OWNER_MISSING" });
  });

  test("records COST_PERIOD_MISSING when usage rows have no effective cost interval", async () => {
    const executor = fakeLayerExecutor();
    registerUfSource(executor, {
      sourceId: 8204,
      headers: FRONT_PROFIT_COST_USAGE_HEADERS,
      family: "cost_usage",
      rows: [{
        出货ID: "SHIP-NO-COST",
        发货日期: "2026-08-10",
        平台: "Shopee",
        业务模式: "自营",
        店铺: "SG Shop",
        运营: "Alice",
        SKU: "SKU-404",
        出货数量: "1",
      }],
    });

    const result = await runFrontProfitDraftShadow(executor, {
      period: "2026-08",
      sources: { costUsageSourceIds: [8204] },
      today: "2026-08-20",
    });

    expect(result).toMatchObject({ status: "failed", errorCode: "COST_PERIOD_MISSING" });
    expect(executor.dqEvents[0]).toMatchObject({ severity: "block", code: "COST_PERIOD_MISSING" });
  });

  test("records FEE_AUTHORITY_MISSING when a required fee kind has no candidate", async () => {
    const executor = fakeLayerExecutor();

    const result = await runFrontProfitDraftShadow(executor, {
      period: "2026-08",
      sources: {},
      requiredFeeKinds: ["freight"],
      today: "2026-08-20",
    });

    expect(result).toMatchObject({ status: "failed", errorCode: "FEE_AUTHORITY_MISSING" });
    expect(executor.dqEvents[0]).toMatchObject({ severity: "block", code: "FEE_AUTHORITY_MISSING" });
  });

  test("redacts unknown draft failures from result and DQ evidence while retaining service-log detail", async () => {
    const executor = fakeLayerExecutor();
    const originalUnsafe = executor.unsafe.getMockImplementation();
    if (!originalUnsafe) throw new Error("fake executor implementation missing");
    const sensitiveDetail = [
      "password=top-secret",
      "postgres://ec_app:top-secret@127.0.0.1:5432/ec_data",
      "SELECT * FROM user_data.uf_8299",
      "C:\\private\\front-profit\\source.csv",
    ].join(" ");
    executor.unsafe.mockImplementation(async (query: string, parameters?: unknown[]) => {
      if (String(query).startsWith("SELECT id, name, type, config")) {
        throw new Error(sensitiveDetail);
      }
      return originalUnsafe(query, parameters);
    });
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const result = await runFrontProfitDraftShadow(executor, {
        period: "2026-08",
        sources: { salesSourceIds: [8299] },
        today: "2026-08-20",
      });

      expect(result).toMatchObject({
        status: "failed",
        errorCode: "FRONT_PROFIT_DRAFT_RUN_FAILED",
        message: "前台利润草稿处理失败，请稍后重试",
      });
      expect(executor.dqEvents).toEqual([expect.objectContaining({
        severity: "block",
        code: "FRONT_PROFIT_DRAFT_RUN_FAILED",
        payload: { message: "前台利润草稿处理失败，请稍后重试" },
      })]);
      const publicEvidence = JSON.stringify({ result, dqEvents: executor.dqEvents });
      expect(publicEvidence).not.toContain("top-secret");
      expect(publicEvidence).not.toContain("postgres://");
      expect(publicEvidence).not.toContain("user_data");
      expect(publicEvidence).not.toContain("source.csv");

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0]?.[0]).toBe("[front-profit:draft] unexpected failure");
      const logContext = logSpy.mock.calls[0]?.[1] as {
        runId: number;
        stepKey: string;
        error: Error;
      };
      expect(logContext).toMatchObject({ runId: result.runId, stepKey: "source_load" });
      expect(logContext.error.message).toBe(sensitiveDetail);
    } finally {
      logSpy.mockRestore();
    }
  });
});
