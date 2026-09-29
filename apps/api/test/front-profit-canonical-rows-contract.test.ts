import { describe, expect, test } from "vitest";
import { canonicalRowsContract } from "../src/services/front-profit-canonical-rows-contract.js";
import { FRONT_PROFIT_STANDARD_HEADERS } from "../src/services/front-profit-standard.js";

const row = (overrides: Record<number, unknown> = {}): unknown[] => {
  const base: unknown[] = [
    new Date(2098, 1, 1, 15, 30),
    "合成平台",
    "自营",
    "合成组",
    "合成店铺",
    "合成归一店铺",
    "合成运营",
    1,
    100,
    10,
    2,
    1,
    30,
    100,
    5,
    1,
    2,
    3,
    4,
    5,
    "synthetic-source.xlsx",
    "BATCH-1",
    "synthetic",
    90,
    42,
    0.05,
    "SYNTHETIC_CANONICAL_001",
    "原状态",
  ];
  for (const [index, value] of Object.entries(overrides)) {
    base[Number(index)] = value;
  }
  return base;
};

describe("front-profit canonical rows contract", () => {
  test("is the shared source of validation, identities, period and sanitized summary", () => {
    const rows = [row()];

    const contract = canonicalRowsContract({
      headers: FRONT_PROFIT_STANDARD_HEADERS,
      dataRows: rows,
    });

    expect(contract.periods).toEqual(["2098-02"]);
    expect(contract.scopeKeys).toEqual(["front_profit:2098-02"]);
    expect(contract.identities).toHaveLength(1);
    expect(contract.summary).toEqual({
      schemaVersion: "front-profit-standard/v1",
      businessRowCount: 1,
      warningCount: 0,
      warningCodes: [],
    });
    expect(rows[0]?.[0]).toBe("2098-02-01");
  });

  test("keeps warning detail out of the summary while marking imported rows", () => {
    const rows = [row({
      7: 0,
      8: 0,
      9: 0,
      10: 0,
      11: 0,
      12: 0,
      13: 0,
      14: 0,
      15: 0,
      16: 0,
      17: 0,
      18: 0,
      19: 1,
      23: 0,
      24: -1,
      25: 0,
      26: "SYNTHETIC_CANONICAL_WARN",
    })];

    const contract = canonicalRowsContract({
      headers: FRONT_PROFIT_STANDARD_HEADERS,
      dataRows: rows,
    });

    expect(contract.summary).toEqual({
      schemaVersion: "front-profit-standard/v1",
      businessRowCount: 1,
      warningCount: 1,
      warningCodes: ["PROMOTION_ORPHAN"],
    });
    expect(JSON.stringify(contract.summary)).not.toMatch(/SYNTHETIC_CANONICAL_WARN|合成店铺|合成运营/);
    expect(rows[0]?.[27]).toBe("原状态；推广孤儿（保留）");
  });
});
