import { describe, expect, it } from "vitest";
import {
  addWorkbookSheetToBudget,
  emptyWorkbookImportBudget,
  WorkbookImportBudgetError,
} from "../src/services/workbook-import-budget.js";

describe("workbook import aggregate budget", () => {
  it("rejects aggregate rows even when each sheet is below the per-sheet limit", () => {
    const limits = { maxRows: 5, maxCells: 100, maxEstimatedBytes: 100_000 };
    const first = addWorkbookSheetToBudget(
      emptyWorkbookImportBudget(),
      "一月",
      [[1], [2], [3]],
      limits,
    );
    expect(() => addWorkbookSheetToBudget(first, "二月", [[4], [5], [6]], limits))
      .toThrowError(WorkbookImportBudgetError);
  });

  it("rejects aggregate cell count", () => {
    const limits = { maxRows: 100, maxCells: 3, maxEstimatedBytes: 100_000 };
    expect(() => addWorkbookSheetToBudget(
      emptyWorkbookImportBudget(),
      "明细",
      [[1, 2], [3, 4]],
      limits,
    )).toThrow(/单元格/);
  });

  it("rejects aggregate estimated memory", () => {
    const limits = { maxRows: 100, maxCells: 100, maxEstimatedBytes: 80 };
    expect(() => addWorkbookSheetToBudget(
      emptyWorkbookImportBudget(),
      "明细",
      [["一段足够长的文本"]],
      limits,
    )).toThrow(/估算内存/);
  });
});
