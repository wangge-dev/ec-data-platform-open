import {
  calculateFrontProfitDerivedValues,
  type FrontProfitFormulaInputField,
} from "../../src/services/front-profit-formula.js";
import { frontProfitAggregationKey } from "../../src/services/front-profit-standard.js";
import type { FrontProfitL4AggRowForContract } from "../../src/services/front-profit-layers.js";

type LayerMoneyInputs = Record<FrontProfitFormulaInputField, number>;

const baseMoneyInputs = (): LayerMoneyInputs => ({
  GMV: 100,
  补单金额: 10,
  补单产品成本: 2,
  产品成本: 30,
  出货货值: 100,
  "平台扣点/毛保": 5,
  税点: 1,
  财务成本: 2,
  运费: 3,
  佣金: 4,
  推广费: 5,
});

export function syntheticFrontProfitL4AggRow(
  overrides: Partial<FrontProfitL4AggRowForContract> = {},
): FrontProfitL4AggRowForContract {
  const input = baseMoneyInputs();
  const derived = calculateFrontProfitDerivedValues((field) => input[field]);
  const base = {
    date: "2098-02-01",
    platform: "合成平台",
    businessMode: "自营",
    groupName: "合成组",
    shop: "合成店铺",
    shopNormalized: "合成归一店铺",
    operator: "合成运营",
    quantity: 1,
    gmv: input.GMV,
    fillOrderAmount: input.补单金额,
    fillOrderProductCost: input.补单产品成本,
    fillOrderQuantity: 1,
    productCost: input.产品成本,
    shipmentValue: input.出货货值,
    platformFee: input["平台扣点/毛保"],
    taxFee: input.税点,
    financeCost: input.财务成本,
    freight: input.运费,
    commission: input.佣金,
    promotionFee: input.推广费,
    sourceFile: "synthetic-front-profit-source.xlsx",
    sourceBatch: "SYNTHETIC-BATCH-1",
    note: "synthetic fixture",
    realRevenue: derived["真实营业额"],
    frontProfit: derived["前台利润"],
    paidRatio: derived["付费占比"],
    recordId: "SYNTHETIC_FRONT_PROFIT_L4_001",
    dataStatus: "合成",
  } satisfies FrontProfitL4AggRowForContract;

  const row = { ...base, ...overrides };
  return {
    ...row,
    aggregationKey: frontProfitAggregationKey({
      date: row.date,
      platform: row.platform,
      businessMode: row.businessMode,
      shop: row.shop,
      operator: row.operator,
    }),
  };
}

export const syntheticFrontProfitL1SourceRow = {
  runId: 9001,
  sourceId: 7001,
  sourceRowNo: 2,
  period: "2098-02",
  sourceFamily: "sales",
  sourceRecordKey: "SYNTHETIC-SALES-ROW-001",
  eventDate: "2098-02-01",
  amountKind: "GMV",
  amountValue: 100,
  quantity: 1,
  currency: "CNY",
} as const;

export const syntheticFrontProfitL3CalcDetail = {
  runId: 9001,
  detailKey: "SYNTHETIC-L3-DETAIL-001",
  l1SourceRowId: 8001,
  sourceId: 7001,
  period: "2098-02",
  calculationRole: "sales_contribution",
  mappingVersionId: 6001,
  ruleVersion: "synthetic-rule/v1",
  jobVersion: "synthetic-job/v1",
} as const;
