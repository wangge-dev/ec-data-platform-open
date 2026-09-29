import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, test } from "vitest";
import * as XLSX from "xlsx";
import { resolveIsolatedTestDatabase } from "./helpers/isolated-database.js";
import { readFileAnalysisSample } from "../src/services/agent-file-sample.js";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1";
const databaseUrl = runDatabaseTests ? resolveIsolatedTestDatabase(process.env, true) : undefined;
const describeDatabase = runDatabaseTests ? describe : describe.skip;

// importExcel uses the production client module. Point it only at the explicit
// isolated database before importing it; never fall back to DATABASE_URL.
if (runDatabaseTests && databaseUrl) process.env.DATABASE_URL = databaseUrl;

describeDatabase("file analysis sample SQL boundary", () => {
  test("keeps a malicious uploaded header as a JSON label, not executable SQL", async () => {
    const { importExcel, deleteFileSource } = await import("../src/services/import-excel.js");
    const repeated = "a".repeat(60);
    const maliciousHeader = `${repeated}", 'synthetic-leak' AS "leaked" FROM (SELECT 1 AS "${repeated}") t --`;
    const worksheet = XLSX.utils.aoa_to_sheet([
      [maliciousHeader, "平台", "数量"],
      ["合成测试值", "合成平台", 1],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "合成数据");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    const fileName = `synthetic-agent-header-${randomUUID()}.xlsx`;
    const verifier = postgres(databaseUrl!, { max: 1, connect_timeout: 5 });
    let sourceId: number | undefined;

    try {
      const imported = await importExcel(bytes, fileName, "合成恶意表头回归样例");
      sourceId = imported.sourceId;
      const sample = await readFileAnalysisSample(
        verifier,
        sourceId,
        imported.columns,
        50,
      );
      expect(sample).toEqual([{
        [maliciousHeader]: "合成测试值",
        平台: "合成平台",
        数量: "1",
      }]);
      expect(Object.keys(sample![0])).not.toContain("leaked");
    } finally {
      if (sourceId !== undefined) await deleteFileSource(sourceId);
      await verifier.end({ timeout: 1 });
    }
  });
});
