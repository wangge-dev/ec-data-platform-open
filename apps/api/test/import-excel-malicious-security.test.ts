import { describe, expect, test, vi } from "vitest";
import * as XLSX from "xlsx";

const { dbSelect, sqlUnsafe, sqlBegin } = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  sqlUnsafe: vi.fn(),
  sqlBegin: vi.fn(),
}));

vi.mock("../src/db/client.js", () => ({
  db: { select: dbSelect },
  sql: { unsafe: sqlUnsafe, begin: sqlBegin },
}));

import { importExcel } from "../src/services/import-excel.js";

describe("importExcel malicious workbook boundary", () => {
  test("rejects external XLSX relationships before any database operation", async () => {
    const sheet = XLSX.utils.aoa_to_sheet([["字段", "金额"], ["值", 1]]);
    sheet.A1!.l = { Target: "file:///C:/sensitive.txt" };
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "数据");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    await expect(importExcel(
      bytes,
      "external.xlsx",
      "external",
      "file",
      true,
    )).rejects.toMatchObject({
      name: "SpreadsheetSecurityError",
      code: "EXTERNAL_RELATIONSHIP",
    });

    expect(dbSelect).not.toHaveBeenCalled();
    expect(sqlUnsafe).not.toHaveBeenCalled();
    expect(sqlBegin).not.toHaveBeenCalled();
  });
});
