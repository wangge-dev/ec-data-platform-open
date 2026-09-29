import { describe, expect, test } from "vitest";
import {
  FRONT_PROFIT_BUSINESS_RULE_VERSION,
  FRONT_PROFIT_COST_MATCH_DATE_ROLE,
  FRONT_PROFIT_FEE_AUTHORITY_PRIORITY,
  FRONT_PROFIT_OPERATOR_AUTHORITY_KEY_PRIORITY,
  FRONT_PROFIT_REBATE_KEY_POLICY,
  FrontProfitBusinessRuleBlockError,
  assertUniqueFrontProfitRebateKeys,
  resolveFrontProfitOperator,
  selectAuthoritativeFrontProfitFeeSource,
  selectFrontProfitCostPeriod,
} from "../src/services/front-profit-business-rules.js";

describe("front-profit accepted P0 business rules", () => {
  test("pins the accepted defaults as a versioned rule contract", () => {
    expect(FRONT_PROFIT_BUSINESS_RULE_VERSION).toBe("front-profit-business-rules/v1");
    expect(FRONT_PROFIT_REBATE_KEY_POLICY).toEqual({
      keyField: "rebate_key",
      attributionDate: "rebate_event_date",
      duplicate: "block",
    });
    expect(FRONT_PROFIT_FEE_AUTHORITY_PRIORITY).toEqual([
      "settlement",
      "platform_bill",
      "rate_rule",
      "manual_estimate",
    ]);
    expect(FRONT_PROFIT_OPERATOR_AUTHORITY_KEY_PRIORITY).toEqual([
      "sku",
      "ad_account",
      "product_owner",
      "order_owner",
      "manual_mapping",
    ]);
    expect(FRONT_PROFIT_COST_MATCH_DATE_ROLE).toBe("shipment_date");
  });

  test("blocks duplicate rebate business keys", () => {
    expect(() =>
      assertUniqueFrontProfitRebateKeys([
        { rebateKey: "REBATE-001", rowNumber: 2 },
        { rebateKey: "REBATE-001", rowNumber: 7 },
      ]),
    ).toThrow(FrontProfitBusinessRuleBlockError);
  });

  test("prefers settlement facts over platform bills, rules, and manual estimates", () => {
    expect(selectAuthoritativeFrontProfitFeeSource([
      { feeKind: "freight", authoritySource: "manual_estimate", amount: 8 },
      { feeKind: "freight", authoritySource: "rate_rule", amount: 9 },
      { feeKind: "freight", authoritySource: "platform_bill", amount: 10 },
      { feeKind: "freight", authoritySource: "settlement", amount: 11 },
    ], "freight")).toBe("settlement");

    expect(() => selectAuthoritativeFrontProfitFeeSource([], "commission"))
      .toThrow(FrontProfitBusinessRuleBlockError);
  });

  test("resolves one-shop-multi-operator by authority key and never averages ambiguity", () => {
    const assignments = [
      {
        shop: "Shop A",
        authorityKeyType: "sku" as const,
        authorityKey: "SKU-1",
        operator: "Alice",
        effectiveFrom: "2026-08-01",
        effectiveTo: "2026-08-31",
      },
      {
        shop: "Shop A",
        authorityKeyType: "ad_account" as const,
        authorityKey: "AD-9",
        operator: "Bob",
        effectiveFrom: "2026-08-01",
        effectiveTo: "2026-08-31",
      },
    ];

    expect(resolveFrontProfitOperator({
      shop: "Shop A",
      date: "2026-08-10",
      skuKey: "SKU-1",
      adAccountKey: "AD-9",
    }, assignments).operator).toBe("Alice");

    expect(() => resolveFrontProfitOperator({
      shop: "Shop A",
      date: "2026-08-10",
      skuKey: "SKU-404",
    }, assignments)).toThrow(FrontProfitBusinessRuleBlockError);
  });

  test("blocks ambiguous operator mappings for the same authority key", () => {
    expect(() => resolveFrontProfitOperator({
      shop: "Shop A",
      date: "2026-08-10",
      skuKey: "SKU-1",
    }, [
      {
        shop: "Shop A",
        authorityKeyType: "sku",
        authorityKey: "SKU-1",
        operator: "Alice",
        effectiveFrom: "2026-08-01",
        effectiveTo: "2026-08-31",
      },
      {
        shop: "Shop A",
        authorityKeyType: "sku",
        authorityKey: "SKU-1",
        operator: "Bob",
        effectiveFrom: "2026-08-01",
        effectiveTo: "2026-08-31",
      },
    ])).toThrow(FrontProfitBusinessRuleBlockError);
  });

  test("matches product cost by shipment date and blocks gaps or overlaps", () => {
    const period = {
      skuKey: "SKU-1",
      effectiveFrom: "2026-08-01",
      effectiveTo: "2026-08-31",
      unitCost: 12,
    };

    expect(selectFrontProfitCostPeriod({
      skuKey: "SKU-1",
      shipmentDate: "2026-08-31",
    }, [period])).toEqual(period);

    expect(() => selectFrontProfitCostPeriod({
      skuKey: "SKU-1",
      shipmentDate: "2026-09-01",
    }, [period])).toThrow(FrontProfitBusinessRuleBlockError);

    expect(() => selectFrontProfitCostPeriod({
      skuKey: "SKU-1",
      shipmentDate: "2026-08-15",
    }, [
      period,
      {
        skuKey: "SKU-1",
        effectiveFrom: "2026-08-10",
        effectiveTo: "2026-08-20",
        unitCost: 13,
      },
    ])).toThrow(FrontProfitBusinessRuleBlockError);
  });
});
