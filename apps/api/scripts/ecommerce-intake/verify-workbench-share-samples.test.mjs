import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, test } from "vitest";

import { verifyWorkbenchShareSamples } from "./verify-workbench-share-samples.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..", "..");
const sampleRoot = join(repositoryRoot, "templates", "ecommerce-workbench", "samples");
const requireFromApi = createRequire(join(repositoryRoot, "apps", "api", "package.json"));
const XLSX = requireFromApi("xlsx");
const temporaryRoot = mkdtempSync(join(tmpdir(), "ec-workbench-samples-"));

afterAll(() => rmSync(temporaryRoot, { force: true, recursive: true }));

test("accepts exactly the seven fixed synthetic workbooks", () => {
  assert.deepEqual(verifyWorkbenchShareSamples(sampleRoot), { files: 7, rows: 24 });
});

test("rejects a real-looking value even when the synthetic markers remain", () => {
  const tamperedRoot = join(temporaryRoot, "tampered");
  cpSync(sampleRoot, tamperedRoot, { recursive: true });
  const workbookPath = join(tamperedRoot, "pdd_ads_product_period.xlsx");
  const workbook = XLSX.readFile(workbookPath, { cellDates: true, UTC: true });
  workbook.Sheets.standard_table.H2.v = "真实店铺商品";
  XLSX.writeFile(workbook, workbookPath, { bookType: "xlsx", UTC: true });

  assert.throws(
    () => verifyWorkbenchShareSamples(tamperedRoot),
    /包含非合成文本/u,
  );
});
