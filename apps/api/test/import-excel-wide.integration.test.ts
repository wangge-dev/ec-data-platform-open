import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import * as XLSX from "xlsx";
import { resolveIsolatedTestDatabase } from "./helpers/isolated-database.js";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1";
const databaseUrl = runDatabaseTests ? resolveIsolatedTestDatabase(process.env, true) : undefined;
const describeDatabase = runDatabaseTests ? describe : describe.skip;

if (runDatabaseTests && databaseUrl) process.env.DATABASE_URL = databaseUrl;

describeDatabase("wide spreadsheet import parameter budget", () => {
  test("imports 200 rows with 328 columns without exceeding PostgreSQL's bind limit", async () => {
    const { importExcel, deleteFileSource } = await import("../src/services/import-excel.js");
    const headers = Array.from({ length: 328 }, (_, index) => `synthetic_col_${index + 1}`);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      headers,
      ...Array.from({ length: 200 }, (_, rowIndex) => [
        `synthetic_row_${rowIndex + 1}`,
        ...Array.from({ length: 327 }, () => "1"),
      ]),
    ]), "合成宽表");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    let sourceId: number | undefined;

    try {
      const imported = await importExcel(
        bytes,
        `synthetic-wide-${randomUUID()}.xlsx`,
        "合成宽表回归样例",
      );
      sourceId = imported.sourceId;
      expect(imported.rowCount).toBe(200);
      expect(imported.columns).toHaveLength(328);
    } finally {
      if (sourceId !== undefined) await deleteFileSource(sourceId);
    }
  });
});
