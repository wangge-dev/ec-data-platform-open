import { describe, expect, test } from "vitest";
import {
  classifyUnmatchedReason,
  getUnmatchedOrders,
  neutralizeSpreadsheetFormula,
  normalizeUnmatchedPagination,
  resolveUnifiedSalesTableReference,
  UNMATCHED_SAMPLE_GROUP_BY,
  UNMATCHED_SAMPLE_ORDER_BY,
  toUnmatchedOrdersCsv,
  type UnmatchedOrdersDependencies,
  type UnmatchedOrderSample,
} from "../src/services/unmatched-orders.js";

describe("unmatched order diagnostics", () => {
  test("separates missing product IDs from dictionary misses", () => {
    expect(classifyUnmatchedReason(null)).toBe("missing_product_id");
    expect(classifyUnmatchedReason("   ")).toBe("missing_product_id");
    expect(classifyUnmatchedReason("SKU-001")).toBe("brand_dict_key_not_found");
  });

  test("bounds pagination and rejects invalid values", () => {
    expect(normalizeUnmatchedPagination({})).toEqual({ limit: 50, offset: 0 });
    expect(normalizeUnmatchedPagination({ limit: "500", offset: "12" })).toEqual({
      limit: 200,
      offset: 12,
    });
    expect(() => normalizeUnmatchedPagination({ limit: "0" })).toThrow("limit");
    expect(() => normalizeUnmatchedPagination({ offset: "-1" })).toThrow("offset");
    expect(() => normalizeUnmatchedPagination({ limit: "1.5" })).toThrow("limit");
  });

  test("returns an empty diagnostic result when unified_sales does not exist", async () => {
    const dependencies: UnmatchedOrdersDependencies = {
      executor: {
        unsafe: async () => {
          throw new Error("queries must not run without a table");
        },
      },
      resolveTableReference: async () => null,
    };

    const result = await getUnmatchedOrders({ limit: 20, offset: 0 }, dependencies);

    expect(result.empty).toBe(true);
    expect(result.summary.totalRows).toBe(0);
    expect(result.samples).toEqual([]);
    expect(result.pagination).toEqual({ limit: 20, offset: 0, total: 0 });
  });

  test("checks the catalog instead of assuming a fixed public table exists", async () => {
    const missing = await resolveUnifiedSalesTableReference({
      unsafe: async () => [{ relation: null }],
    });
    const present = await resolveUnifiedSalesTableReference({
      unsafe: async () => [{ relation: "unified_sales" }],
    });

    expect(missing).toBeNull();
    expect(present).toBe('"public"."unified_sales"');
  });

  test("orders every grouping key to keep offset pagination deterministic", () => {
    expect(UNMATCHED_SAMPLE_GROUP_BY).toContain("COALESCE(platform");
    expect(UNMATCHED_SAMPLE_GROUP_BY).toContain("NULLIF(BTRIM(product_id), '')");
    expect(UNMATCHED_SAMPLE_GROUP_BY).toContain("COALESCE(source_file");
    expect(UNMATCHED_SAMPLE_ORDER_BY).toContain("platform");
    expect(UNMATCHED_SAMPLE_ORDER_BY).toContain("product_id");
    expect(UNMATCHED_SAMPLE_ORDER_BY).toContain("source_file");
    expect(UNMATCHED_SAMPLE_ORDER_BY).toContain("reason");
  });

  test("exports UTF-8 BOM CSV and escapes commas, quotes, and newlines", () => {
    const samples: UnmatchedOrderSample[] = [
      {
        reason: "brand_dict_key_not_found",
        platform: "阿里健康",
        productId: 'SKU,"001"',
        sourceFile: "订单\n七月.csv",
        rows: 12,
        amount: 345.67,
        sampleOrderNo: "ORDER-1",
      },
    ];

    const csv = toUnmatchedOrdersCsv(samples);

    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("原因代码,原因说明,平台,商品ID,来源文件,未匹配行数,未匹配金额,样例订单号");
    expect(csv).toContain('"SKU,""001"""');
    expect(csv).toContain('"订单\n七月.csv"');
    expect(csv).toContain("维护表未找到商品 ID");
  });

  test("neutralizes spreadsheet formulas, including prefixes hidden by whitespace", () => {
    for (const value of [
      "=1+1",
      "+SUM(1,1)",
      "@HYPERLINK(\"https://invalid.example\")",
      "-cmd|' /C calc'!A0",
      " \t=1+1",
      "\r@SUM(1,1)",
      "\tordinary text",
      "\rordinary text",
      "\t-123.45",
      " \n-123.45",
    ]) {
      expect(neutralizeSpreadsheetFormula(value), value).toBe(`'${value}`);
    }
    expect(neutralizeSpreadsheetFormula("-123.45")).toBe("-123.45");
    expect(neutralizeSpreadsheetFormula("ordinary text")).toBe("ordinary text");
  });

  test("applies formula neutralization to every untrusted CSV text field", () => {
    const csv = toUnmatchedOrdersCsv([{
      reason: "brand_dict_key_not_found",
      platform: "=1+1",
      productId: " \t+SUM(1,1)",
      sourceFile: "@HYPERLINK.csv",
      rows: 1,
      amount: -12.34,
      sampleOrderNo: "-cmd|' /C calc'!A0",
    }]);

    expect(csv).toContain("'=1+1");
    expect(csv).toContain("' \t+SUM(1,1)");
    expect(csv).toContain("'@HYPERLINK.csv");
    expect(csv).toContain("-12.34");
    expect(csv).toContain("'-cmd|' /C calc'!A0");
  });
});
