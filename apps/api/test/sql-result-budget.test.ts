import { describe, expect, test } from "vitest";

import {
  assertSqlResultWithinBudget,
} from "../src/lib/sql-result-budget.js";

describe("SQL result response budgets", () => {
  test("accepts a result within both the cell and total byte limits", () => {
    expect(() => assertSqlResultWithinBudget(
      [{ id: 1, label: "synthetic" }],
      { maxCellBytes: 32, maxTotalBytes: 128, columns: ["id", "label"] },
    )).not.toThrow();
  });

  test("counts UTF-8 JSON bytes and rejects a single oversized cell", () => {
    expect(() => assertSqlResultWithinBudget(
      [{ label: "中文" }],
      { maxCellBytes: 7, maxTotalBytes: 128 },
    )).toThrow("SQL result cell exceeds 7-byte limit");
  });

  test("rejects an oversized aggregate even when every cell is small", () => {
    expect(() => assertSqlResultWithinBudget(
      [{ value: "12345" }, { value: "67890" }],
      { maxCellBytes: 16, maxTotalBytes: 20 },
    )).toThrow("SQL result exceeds 20-byte limit");
  });

  test("rejects an oversized binary cell before JSON expansion", () => {
    expect(() => assertSqlResultWithinBudget(
      [{ payload: Buffer.alloc(17) }],
      { maxCellBytes: 16, maxTotalBytes: 128 },
    )).toThrow("SQL result cell exceeds 16-byte limit");
  });

  test("fails closed for values that JSON cannot serialize", () => {
    expect(() => assertSqlResultWithinBudget(
      [{ value: 1n }],
      { maxCellBytes: 32, maxTotalBytes: 128 },
    )).toThrow("cannot be serialized safely");
  });
});
