import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import * as XLSX from "xlsx";
import { FRONT_PROFIT_STANDARD_HEADERS } from "../src/services/front-profit-standard.js";

const root = resolve(import.meta.dirname, "../../..");
const templateRoot = resolve(root, "templates/front-profit");
const manifest = JSON.parse(
  readFileSync(resolve(templateRoot, "template-manifest.json"), "utf8"),
);

const expectedHeaders = [
  "日期",
  "平台",
  "业务模式",
  "组",
  "店铺",
  "店铺2",
  "运营",
  "单量",
  "GMV",
  "补单金额",
  "补单产品成本",
  "补单单量",
  "产品成本",
  "出货货值",
  "平台扣点/毛保",
  "税点",
  "财务成本",
  "运费",
  "佣金",
  "推广费",
  "来源文件",
  "来源批次",
  "备注",
  "真实营业额",
  "前台利润",
  "付费占比",
  "record_id",
  "数据状态",
];

const approvedTemplateHashes: Record<string, string> = {
  "01-电商前台利润单表上传模板.xlsx": "B8EEEA0E44FA2D12E37B4FF024E7C54017D5FA4CFCD7A4EC6B5964657B1CFD6B",
  "02-电商前台利润数据准备与映射模板.xlsx": "14D6B31AB8A02AC1E7DB48E55E479AFC25A171463762AC1BCDEA3055F5930F94",
};

const templateSha256 = (name: string): string =>
  createHash("sha256")
    .update(readFileSync(resolve(templateRoot, name)))
    .digest("hex")
    .toUpperCase();

const readWorkbook = (name: string) =>
  XLSX.read(readFileSync(resolve(templateRoot, name)), {
    type: "buffer",
    cellDates: true,
    cellFormula: true,
    cellStyles: true,
  });

describe("front profit release templates", () => {
  test("locks the two approved workbooks to the published manifest hashes", () => {
    expect(manifest.schemaVersion).toBe("front-profit-template/v1.1");
    expect(manifest.containsRealBusinessData).toBe(false);
    expect(manifest.files).toHaveLength(2);
    expect(Object.keys(approvedTemplateHashes).sort()).toEqual(
      manifest.files.map((file: { name: string }) => file.name).sort(),
    );
    expect(manifest.files.find(
      (file: { purpose?: string }) => file.purpose === "self-service-single-table-upload",
    ).headers).toEqual(FRONT_PROFIT_STANDARD_HEADERS);

    for (const file of manifest.files) {
      expect(file.sha256).toBe(approvedTemplateHashes[file.name]);
      expect(templateSha256(file.name)).toBe(approvedTemplateHashes[file.name]);
    }
  });

  test("keeps the single-table upload contract stable and marks its only sample as synthetic", () => {
    const file = manifest.files.find(
      (candidate: { purpose?: string }) =>
        candidate.purpose === "self-service-single-table-upload",
    );
    expect(file).toBeDefined();
    const workbook = readWorkbook(file.name);
    expect(workbook.SheetNames).toEqual(["前台利润标准数据"]);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets[workbook.SheetNames[0]],
      { header: 1, defval: null, raw: false },
    );

    expect(rows[0]).toEqual(expectedHeaders);
    expect(rows).toHaveLength(2);
    expect(rows[1][expectedHeaders.indexOf("record_id")]).toBe(
      "TEMPLATE_EXAMPLE_20991231",
    );
    expect(String(rows[1][expectedHeaders.indexOf("数据状态")])).toContain(
      "示例行",
    );
    expect(file.businessDataRows).toBe(0);
    expect(file.syntheticTypeHintRows).toBe(1);
  });

  test("keeps the mapping workbook blank at every business input contract and preserves formulas", () => {
    const file = manifest.files.find(
      (candidate: { purpose?: string }) =>
        candidate.purpose === "data-preparation-mapping-and-validation",
    );
    expect(file).toBeDefined();
    const workbook = readWorkbook(file.name);
    expect(workbook.SheetNames).toEqual(file.sheetNames);

    for (const sheetName of [
      "经营明细接口",
      "费用事实接口",
      "SKU运营映射",
      "店铺账户映射",
    ]) {
      const sheet = workbook.Sheets[sheetName];
      const range = XLSX.utils.decode_range(sheet["!ref"]!);
      expect(range.e.r).toBe(4);
      const inputRow = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        defval: null,
        raw: false,
      })[4];
      expect(inputRow.every((value) => value === null || value === "")).toBe(
        true,
      );
    }

    const profit = workbook.Sheets["前台利润标准表"];
    expect(profit.V5.f).toBe('IF(COUNTA($A5:$U5)=0,"",$J5-$K5)');
    expect(profit.W5.f).toBe(
      'IF(COUNTA($A5:$U5)=0,"",$O5-$N5-$S5-$K5-$P5-$Q5-$R5-$T5-$U5+$L5)',
    );
    expect(profit.X5.f).toBe(
      'IF(COUNTA($A5:$U5)=0,"",IFERROR($U5/$J5,0))',
    );

    expect(workbook.Sheets["经营明细接口"].H5.z).toBe("@");
    expect(workbook.Sheets["费用事实接口"].J5.z).toBe("@");
    expect(workbook.Sheets["SKU运营映射"].E5.z).toBe("@");

    const rulesText = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets["规则与验收"],
      { header: 1, defval: null, raw: false },
    ).flat().filter(Boolean).join("\n");
    for (const testId of ["UT_ZERO_SHIP", "UT_NEG_SHIP", "UT_SKU_TEXT", "UT_PROMO_ORPHAN"]) {
      expect(rulesText).toContain(testId);
    }
    expect(rulesText).toContain("进入计算的运营仍未解析，或一键多运营未消歧");
    expect(rulesText).toContain("禁止自动分摊");
    expect(rulesText).toContain("推广孤儿必须100%保留");

    const checksText = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets.Checks,
      { header: 1, defval: null, raw: false },
    ).flat().filter(Boolean).join("\n");
    expect(checksText).toContain("未解析映射=0");
    expect(checksText).toContain("推广孤儿100%保留");
    expect(file.businessDataRows).toBe(0);
  });
});
