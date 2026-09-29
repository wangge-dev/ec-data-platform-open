import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterAll, test } from "vitest";

import {
  OUTPUT_SCHEMAS,
  standardizeSycmDirectory,
  validateStandardTables,
  writeStandardTables,
} from "./sycm-standardize.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..", "..");
const requireFromApi = createRequire(join(repositoryRoot, "apps", "api", "package.json"));
const XLSX = requireFromApi("xlsx");

const temporaryRoot = mkdtempSync(join(tmpdir(), "ec-sycm-standardize-"));
afterAll(() => {
  const resolvedTemporaryRoot = resolve(temporaryRoot);
  assert.ok(resolvedTemporaryRoot.startsWith(resolve(tmpdir())));
  rmSync(resolvedTemporaryRoot, { force: true, recursive: true });
});

const META_HEADERS = ["栏目", "菜单", "数据点", "维度", "日期范围", "终端", "导出时间"];

function writeWorkbook(directory, fileName, sheets) {
  mkdirSync(directory, { recursive: true });
  const workbook = XLSX.utils.book_new();
  for (const [sheetName, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  }
  XLSX.writeFile(workbook, join(directory, fileName), { bookType: "xlsx" });
}

function tradeRow(period, amount, buyers, visitors, exportedAt) {
  return [
    "栏目值",
    "菜单值",
    "数据点值",
    "维度值",
    period,
    "汇总终端",
    exportedAt,
    visitors,
    "0%",
    buyers,
    "0%",
    String(amount),
    "0%",
    buyers,
    "0%",
    String(amount),
    "0%",
    String(amount / buyers),
    "0%",
    "10%",
    "100%",
    "10%",
    "0%",
    buyers,
    buyers * 0.4,
    buyers * 0.6,
  ];
}

function createFixture(inputRoot) {
  const tradeHeaders = [
    ...META_HEADERS,
    "访客数",
    "访客数较上一周期",
    "下单买家数",
    "下单买家数较上一周期",
    "下单金额",
    "下单金额较上一周期",
    "支付买家数",
    "支付买家数较上一周期",
    "支付金额",
    "支付金额较上一周期",
    "客单价",
    "客单价较上一周期",
    "下单转化率",
    "下单-支付转化率",
    "支付转化率",
    "支付转化率较上一周期",
    "支付子订单数",
    "新买家数",
    "老买家数",
  ];
  writeWorkbook(join(inputRoot, "交易总览"), "trade-01.xlsx", {
    交易总览: [tradeHeaders, tradeRow("2026-01-01~2026-01-01", 100, 10, 100, "2026-02-01 12:00:00")],
  });
  writeWorkbook(join(inputRoot, "交易总览"), "trade-02.xlsx", {
    交易总览: [tradeHeaders, tradeRow("2026-01-02~2026-01-02", 200, 20, 200, "2026-02-01 12:00:00")],
  });

  const terminalHeaders = [
    "栏目",
    "菜单",
    "数据点",
    "维度",
    "日期范围",
    "导出时间",
    "终端",
    "支付金额",
    "支付金额占比",
    "支付商品数",
    "支付买家数",
    "支付转化率",
  ];
  for (const [day, amounts] of [["01", [60, 40]], ["02", [120, 80]]]) {
    writeWorkbook(join(inputRoot, "终端构成"), `terminal-${day}.xlsx`, {
      终端构成: [
        terminalHeaders,
        ["栏目值", "菜单值", "数据点值", "维度值", `2026-01-${day}~2026-01-${day}`, "2026-02-01 12:00:00", "终端A", String(amounts[0]), "60%", 3, Number(day), "10%"],
        ["栏目值", "菜单值", "数据点值", "维度值", `2026-01-${day}~2026-01-${day}`, "2026-02-01 12:00:00", "终端B", String(amounts[1]), "40%", 2, Number(day), "10%"],
      ],
    });
  }

  const priceHeaders = [
    ...META_HEADERS,
    "价格带ID",
    "价格带",
    "支付买家占比",
    "支付买家数",
    "支付金额",
    "支付转化率",
  ];
  for (const [day, amounts] of [["01", [30, 70]], ["02", [50, 150]]]) {
    writeWorkbook(join(inputRoot, "价格带构成"), `price-${day}.xlsx`, {
      价格带构成: [
        priceHeaders,
        ["栏目值", "菜单值", "数据点值", "维度值", `2026-01-${day}~2026-01-${day}`, "汇总终端", "2026-02-01 12:00:00", "001", "价格带A", "70%", Number(day), String(amounts[0]), null],
        ["栏目值", "菜单值", "数据点值", "维度值", `2026-01-${day}~2026-01-${day}`, "汇总终端", "2026-02-01 12:00:00", "002", "价格带B", "60%", Number(day), String(amounts[1]), "10%"],
      ],
    });
  }

  const levelOneHeaders = [
    ...META_HEADERS,
    "一级类目ID",
    "一级类目",
    "支付金额",
    "支付金额较上一周期",
    "支付金额占比",
    "支付金额占比较上一周期",
    "支付买家数",
    "支付买家数较上一周期",
    "支付转化率",
    "支付转化率较上一周期",
    "访客数较上一周期",
  ];
  const leafHeaders = [
    ...META_HEADERS,
    "一级类目ID",
    "一级类目",
    "叶子类目ID",
    "叶子类目",
    "支付金额",
    "支付金额较上一周期",
    "支付金额占比",
    "支付金额占比较上一周期",
    "支付买家数",
    "支付买家数较上一周期",
    "支付转化率",
    "支付转化率较上一周期",
    "访客数较上一周期",
  ];
  const common = ["栏目值", "菜单值", "数据点值", "维度值", "2026-01-01~2026-01-31", "汇总终端", "2026-02-01 12:00:00"];
  writeWorkbook(join(inputRoot, "类目构成"), "category-01.xlsx", {
    一级类目: [
      levelOneHeaders,
      [...common, "010", "一级类目A", "300", null, "100%", null, 30, null, "10%", null, null],
    ],
    叶子类目: [
      leafHeaders,
      [...common, "010", "一级类目A", "0101", "叶子类目A", "120", null, "40%", null, 12, null, "10%", null, null],
      [...common, "010", "一级类目A", "0102", "叶子类目B", "180", null, "60%", null, 18, null, "10%", null, null],
    ],
  });

  writeWorkbook(join(inputRoot, "品牌构成"), "brand-01.xlsx", {
    品牌构成: [["日期范围"], ["2026-01-01~2026-01-01"]],
  });
}

function sourceSnapshot(inputRoot) {
  const result = new Map();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const metadata = statSync(path);
        result.set(path, { bytes: readFileSync(path), mtimeMs: metadata.mtimeMs, size: metadata.size });
      }
    }
  };
  visit(inputRoot);
  return result;
}

test("standardizes four SYCM tables while preserving nulls and text IDs", () => {
  const caseRoot = join(temporaryRoot, "standard");
  const inputRoot = join(caseRoot, "input");
  const outputRoot = join(caseRoot, "output");
  createFixture(inputRoot);
  const before = sourceSnapshot(inputRoot);

  const result = standardizeSycmDirectory({
    inputRoot,
    sourceBatch: "synthetic-batch",
    sourceAccountAlias: "account-a",
  });
  assert.deepEqual(result.sourceWorkbooks, {
    trade_day: 2,
    terminal_day: 2,
    price_band_day: 2,
    category_month: 1,
    skipped_brand: 1,
  });
  assert.deepEqual(
    Object.fromEntries(Object.entries(result.tables).map(([name, rows]) => [name, rows.length])),
    { trade_day: 2, terminal_day: 4, price_band_day: 4, category_month: 3 },
  );
  assert.equal(result.tables.price_band_day[0].price_band_id, "001");
  assert.equal(result.tables.price_band_day[0].source_account_alias, "account-a");
  assert.equal(result.tables.price_band_day[0].payment_conversion_rate, null);
  assert.equal(result.tables.category_month[0].leaf_category_id, null);
  assert.equal(result.tables.category_month[0].category_id, "010");
  assert.equal(result.tables.category_month[0].category_label, "一级类目A");
  assert.equal(result.tables.category_month[1].category_id, "0101");
  assert.equal(result.tables.category_month[1].category_label, "叶子类目A");
  assert.equal(result.tables.trade_day[0].payment_conversion_rate, 0.1);

  const validation = validateStandardTables(result.tables);
  for (const check of Object.values(validation.reconciliation)) {
    assert.equal(check.mismatched, 0);
    assert.ok(check.matched > 0);
  }

  const firstWrite = writeStandardTables({ inputRoot, outputRoot, tables: result.tables });
  assert.deepEqual(Object.keys(firstWrite), Object.keys(OUTPUT_SCHEMAS));
  assert.deepEqual(
    Object.fromEntries(Object.entries(firstWrite).map(([name, path]) => [name, path.split(/[\\/]/u).at(-1)])),
    {
      trade_day: "taobao_trade_day.csv",
      terminal_day: "taobao_terminal_day.csv",
      price_band_day: "taobao_price_band_day.csv",
      category_month: "taobao_category_month.csv",
    },
  );
  const firstContents = Object.fromEntries(
    Object.entries(firstWrite).map(([name, path]) => [name, readFileSync(path)]),
  );
  const secondWrite = writeStandardTables({ inputRoot, outputRoot, tables: result.tables });
  for (const [name, path] of Object.entries(secondWrite)) {
    assert.deepEqual(readFileSync(path), firstContents[name]);
  }

  const after = sourceSnapshot(inputRoot);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [path, snapshot] of before) {
    assert.equal(after.get(path).size, snapshot.size);
    assert.equal(after.get(path).mtimeMs, snapshot.mtimeMs);
    assert.deepEqual(after.get(path).bytes, snapshot.bytes);
  }
});

test("refuses to write standardized output into the source tree", () => {
  const caseRoot = join(temporaryRoot, "source-boundary");
  const inputRoot = join(caseRoot, "input");
  createFixture(inputRoot);
  const result = standardizeSycmDirectory({
    inputRoot,
    sourceBatch: "synthetic-batch",
    sourceAccountAlias: "account-a",
  });
  const nestedOutput = join(inputRoot, "generated");
  assert.throws(
    () => writeStandardTables({ inputRoot, outputRoot: nestedOutput, tables: result.tables }),
    /outside the source directory/,
  );
  assert.equal(existsSync(nestedOutput), false);
});

test("rejects blank required values and reconciliation mismatches before creating output", () => {
  const caseRoot = join(temporaryRoot, "quality-gate");
  const inputRoot = join(caseRoot, "input");
  createFixture(inputRoot);
  const result = standardizeSycmDirectory({
    inputRoot,
    sourceBatch: "synthetic-batch",
    sourceAccountAlias: "account-a",
  });

  const blankOutput = join(caseRoot, "blank-output");
  const withBlank = structuredClone(result.tables);
  withBlank.trade_day[0].paid_amount = null;
  assert.throws(
    () => writeStandardTables({ inputRoot, outputRoot: blankOutput, tables: withBlank }),
    /trade_day\.paid_amount has 1 blank required value/u,
  );
  assert.equal(existsSync(blankOutput), false);

  const mismatchOutput = join(caseRoot, "mismatch-output");
  const withMismatch = structuredClone(result.tables);
  withMismatch.terminal_day[0].paid_amount += 10;
  assert.throws(
    () => writeStandardTables({ inputRoot, outputRoot: mismatchOutput, tables: withMismatch }),
    /terminal_paid_amount has 1 reconciliation mismatch/u,
  );
  assert.equal(existsSync(mismatchOutput), false);

  const orphanOutput = join(caseRoot, "orphan-output");
  const withOrphan = structuredClone(result.tables);
  withOrphan.terminal_day.push({
    ...withOrphan.terminal_day[0],
    period_start: "2099-01-01",
    period_end: "2099-01-01",
  });
  assert.throws(
    () => writeStandardTables({ inputRoot, outputRoot: orphanOutput, tables: withOrphan }),
    /terminal_paid_amount has 1 reconciliation mismatch/u,
  );
  assert.equal(existsSync(orphanOutput), false);
});

test("rejects a recognized sheet whose required schema is incomplete", () => {
  const caseRoot = join(temporaryRoot, "bad-schema");
  const inputRoot = join(caseRoot, "input");
  writeWorkbook(inputRoot, "bad.xlsx", {
    交易总览: [["日期范围", "导出时间"], ["2026-01-01~2026-01-01", "2026-02-01"]],
  });
  assert.throws(
    () => standardizeSycmDirectory({
      inputRoot,
      sourceBatch: "synthetic-batch",
      sourceAccountAlias: "account-a",
    }),
    /missing required header/,
  );
});

test("requires a safe opaque account alias instead of a store name", () => {
  const caseRoot = join(temporaryRoot, "account-alias");
  const inputRoot = join(caseRoot, "input");
  createFixture(inputRoot);
  assert.throws(
    () => standardizeSycmDirectory({
      inputRoot,
      sourceBatch: "synthetic-batch",
      sourceAccountAlias: "真实店铺名称",
    }),
    /safe opaque alias/,
  );
});
