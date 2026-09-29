import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PDD_STANDARD_SCHEMAS } from "./pdd-standardize.mjs";
import { OUTPUT_SCHEMAS as SYCM_STANDARD_SCHEMAS } from "./sycm-standardize.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(scriptDirectory, "..", "..");
const requireFromApi = createRequire(join(apiRoot, "package.json"));
const XLSX = requireFromApi("xlsx");

const headers = (schema) => schema.map((entry) => typeof entry === "string" ? entry : entry.name);
const day = (value) => {
  assert.ok(value instanceof Date && Number.isFinite(value.valueOf()), "日期单元格必须保持 Excel 日期类型");
  return value.toISOString().slice(0, 10);
};

const SAMPLE_CONTRACTS = Object.freeze({
  "taobao_trade_day.xlsx": {
    headers: headers(SYCM_STANDARD_SCHEMAS.trade_day),
    identity: (row) => day(row.period_start),
    identities: ["2099-12-28", "2099-12-29", "2099-12-30"],
  },
  "taobao_terminal_day.xlsx": {
    headers: headers(SYCM_STANDARD_SCHEMAS.terminal_day),
    identity: (row) => `${day(row.period_start)}|${row.terminal}`,
    identities: [
      "2099-12-28|示例·无线端", "2099-12-28|示例·PC端",
      "2099-12-29|示例·无线端", "2099-12-29|示例·PC端",
    ],
  },
  "taobao_price_band_day.xlsx": {
    headers: headers(SYCM_STANDARD_SCHEMAS.price_band_day),
    identity: (row) => `${day(row.period_start)}|${row.price_band_id}`,
    identities: [
      "2099-12-28|PRICE_SAMPLE_LOW", "2099-12-28|PRICE_SAMPLE_HIGH",
      "2099-12-29|PRICE_SAMPLE_LOW", "2099-12-29|PRICE_SAMPLE_HIGH",
    ],
  },
  "taobao_category_month.xlsx": {
    headers: headers(SYCM_STANDARD_SCHEMAS.category_month),
    identity: (row) => row.category_id,
    identities: ["CATEGORY_L1_SAMPLE", "CATEGORY_LEAF_SAMPLE_A", "CATEGORY_LEAF_SAMPLE_B"],
  },
  "pdd_order_item.xlsx": {
    headers: headers(PDD_STANDARD_SCHEMAS.order_item),
    identity: (row) => row.order_id,
    identities: ["ORDER_SAMPLE_001", "ORDER_SAMPLE_002", "ORDER_SAMPLE_003", "ORDER_SAMPLE_004"],
  },
  "pdd_ads_account_day.xlsx": {
    headers: headers(PDD_STANDARD_SCHEMAS.ads_account_day),
    identity: (row) => day(row.date),
    identities: ["2099-12-28", "2099-12-29", "2099-12-30"],
  },
  "pdd_ads_product_period.xlsx": {
    headers: headers(PDD_STANDARD_SCHEMAS.ads_product_period),
    identity: (row) => row.product_id,
    identities: ["PRODUCT_SAMPLE_A", "PRODUCT_SAMPLE_B", "PRODUCT_SAMPLE_C"],
  },
});

const SAFE_TEXT = new Set([
  "CATEGORY_L1_SAMPLE", "CATEGORY_LEAF_SAMPLE_A", "CATEGORY_LEAF_SAMPLE_B",
  "MERCHANT_SKU_SAMPLE_A", "MERCHANT_SKU_SAMPLE_A2", "MERCHANT_SKU_SAMPLE_B", "MERCHANT_SKU_SAMPLE_C",
  "ORDER_SAMPLE_001", "ORDER_SAMPLE_002", "ORDER_SAMPLE_003", "ORDER_SAMPLE_004",
  "PRICE_SAMPLE_HIGH", "PRICE_SAMPLE_LOW", "PRODUCT_SAMPLE_A", "PRODUCT_SAMPLE_B", "PRODUCT_SAMPLE_C",
  "SAMPLE_BATCH_20991231", "SKU_SAMPLE_A", "SKU_SAMPLE_A2", "SKU_SAMPLE_B", "SKU_SAMPLE_C",
  "day", "leaf", "level_1", "matched", "month", "pinduoduo", "sycm", "unmatched",
  "示例·PC端", "示例·一级类目", "示例·低价格带", "示例·全部终端", "示例·叶子类目A",
  "示例·叶子类目B", "示例·固定方式", "示例·已完成", "示例·待收货", "示例·无售后",
  "示例·无线端", "示例·栖木", "示例·清风", "示例·澄野", "示例·示例·栖木推广",
  "示例·示例·清风推广", "示例·示例·澄野推广", "示例·订单已取消", "示例·高价格带",
  "示例·默认分组", "示例账户",
]);

const SAFE_NUMBERS = new Set([
  -0.5, -0.333333, -0.25, 0, 0.004, 0.006, 0.008, 0.01, 0.012, 0.015,
  0.016, 0.018, 0.02, 0.024, 0.03, 0.036, 0.04, 0.045, 0.054, 0.06,
  0.066667, 0.1, 0.2, 0.333333, 0.4, 0.5, 0.6, 0.666667, 0.75, 0.9,
  1, 1.5, 1.8, 2, 3, 4, 10, 15, 20, 30, 100, 200, 300,
]);

function assertSafeCell(value, context) {
  if (value === null || value === undefined) return;
  if (value instanceof Date) {
    assert.equal(day(value).startsWith("2099-"), true, `${context} 不是 2099 年合成日期`);
    return;
  }
  if (typeof value === "boolean") return;
  if (typeof value === "string") {
    assert.equal(SAFE_TEXT.has(value), true, `${context} 包含非合成文本：${value}`);
    return;
  }
  if (typeof value === "number") {
    assert.equal(Number.isFinite(value), true, `${context} 包含非有限数值`);
    assert.equal(SAFE_NUMBERS.has(Number(value.toFixed(6))), true, `${context} 包含未批准的样例数值：${value}`);
    return;
  }
  assert.fail(`${context} 包含不支持的值类型`);
}

export function verifyWorkbenchShareSamples(sampleRoot) {
  const absoluteRoot = resolve(sampleRoot);
  const actualFiles = readdirSync(absoluteRoot).sort();
  const expectedFiles = Object.keys(SAMPLE_CONTRACTS).sort();
  assert.deepEqual(actualFiles, expectedFiles, "样例目录必须且只能包含约定的七个工作簿");

  let totalRows = 0;
  for (const fileName of expectedFiles) {
    const contract = SAMPLE_CONTRACTS[fileName];
    const workbook = XLSX.readFile(join(absoluteRoot, fileName), {
      bookVBA: true,
      cellDates: true,
      UTC: true,
    });
    assert.deepEqual(workbook.SheetNames, ["standard_table"], `${fileName} 工作表结构异常`);
    assert.equal(workbook.Workbook?.Sheets?.[0]?.Hidden ?? 0, 0, `${fileName} 含隐藏工作表`);
    assert.deepEqual(workbook.Workbook?.Names ?? [], [], `${fileName} 含定义名称`);
    assert.equal(Boolean(workbook.vbaraw), false, `${fileName} 含 VBA`);
    for (const property of ["Author", "LastAuthor", "Company", "Manager", "Comments", "Keywords", "Subject", "Title"]) {
      assert.equal(Boolean(workbook.Props?.[property]), false, `${fileName} 含个人或业务元数据 ${property}`);
    }

    const worksheet = workbook.Sheets.standard_table;
    for (const [address, cell] of Object.entries(worksheet)) {
      if (address.startsWith("!")) continue;
      assert.equal(Boolean(cell.f), false, `${fileName}!${address} 含公式`);
      assert.equal(Boolean(cell.c?.length), false, `${fileName}!${address} 含批注`);
      assert.equal(Boolean(cell.l), false, `${fileName}!${address} 含链接`);
    }

    const matrix = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null, raw: true, UTC: true });
    assert.deepEqual(matrix[0], contract.headers, `${fileName} 表头不匹配`);
    const rows = matrix.slice(1).map((values) => Object.fromEntries(
      contract.headers.map((field, index) => [field, values[index] ?? null]),
    ));
    assert.equal(rows.length, contract.identities.length, `${fileName} 行数不匹配`);
    assert.deepEqual(rows.map(contract.identity).sort(), [...contract.identities].sort(), `${fileName} 示例主键不匹配`);
    rows.forEach((row, rowIndex) => {
      Object.entries(row).forEach(([field, value]) => assertSafeCell(value, `${fileName} 第 ${rowIndex + 2} 行 ${field}`));
    });
    totalRows += rows.length;
  }
  return { files: expectedFiles.length, rows: totalRows };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const sampleRoot = process.argv[2];
    if (!sampleRoot) throw new Error("provide the sample directory");
    console.log(JSON.stringify(verifyWorkbenchShareSamples(sampleRoot)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "workbench share sample verification failed");
    process.exitCode = 1;
  }
}
