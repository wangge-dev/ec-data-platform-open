import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { test } from "vitest";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PDD_STANDARD_SCHEMAS,
  buildPddIntake,
  writePddShareSamples,
  writePddTables,
} from "./pdd-standardize.mjs";
import { verifyWorkbenchShareSamples } from "./verify-workbench-share-samples.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(scriptDirectory, "..", "..");
const repositoryRoot = resolve(apiRoot, "..", "..");
const requireFromApi = createRequire(join(apiRoot, "package.json"));
const XLSX = requireFromApi("xlsx");

const ORDER_HEADERS = [
  "商品",
  "订单号",
  "订单状态",
  "商品总价(元)",
  "邮费(元)",
  "店铺优惠折扣(元)",
  "平台优惠折扣(元)",
  "多多支付立减金额(元)",
  "用户实付金额(元)",
  "商家实收金额(元)",
  "商品数量(件)",
  "发货时间",
  "确认收货时间",
  "商品id",
  "商品规格",
  "样式ID",
  "商家编码-规格维度",
  "商家编码-商品维度",
  "商家备注",
  "售后状态",
  "快递单号",
  "快递公司",
  "订单成交时间",
  "是否分期",
  "分期期数",
  "手续费承担方",
  "分期方式",
];

const ADS_HEADERS = [
  "日期",
  "成交花费(元)",
  "交易额(元)",
  "实际投产比",
  "总花费(元)",
  "净交易额(元)",
  "净实际投产比",
  "净成交笔数",
  "每笔净成交花费(元)",
  "净交易额占比",
  "净成交笔数占比",
  "每笔净成交金额(元)",
  "结算交易额(元)",
  "结算投产比",
  "结算成交笔数",
  "退款豁免率",
  "退单豁免率",
  "每笔结算成交花费(元)",
  "交易额结算率",
  "订单结算率",
  "每笔结算成交金额(元)",
  "成交笔数",
  "每笔成交花费(元)",
  "每笔成交金额(元)",
  "曝光量",
  "点击量",
];

const PRODUCT_HEADERS = [
  "商品名称",
  "商品ID",
  "分组",
  "推广名称",
  "出价方式",
  "是否已删除",
  ...ADS_HEADERS.slice(1),
  "直接交易额(元)",
  "间接交易额(元)",
  "直接成交笔数",
  "间接成交笔数",
  "询单花费(元)",
  "询单量",
  "平均询单成本(元)",
  "收藏花费(元)",
  "收藏量",
  "平均收藏成本(元)",
  "关注花费(元)",
  "关注量",
  "平均关注成本(元)",
];

function writeSourceWorkbook(filePath, headers, rows, bookType) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...rows]), "Sheet0");
  XLSX.writeFile(workbook, filePath, { bookType });
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function datesBetween(start, end) {
  const result = [];
  for (
    let cursor = new Date(`${start}T00:00:00Z`);
    cursor <= new Date(`${end}T00:00:00Z`);
    cursor = new Date(cursor.valueOf() + 86_400_000)
  ) result.push(isoDate(cursor));
  return result;
}

function dailyRow(date, sequence) {
  const spend = (sequence + 1).toFixed(2);
  return [
    date,
    spend,
    ((sequence + 1) * 2).toFixed(2),
    "2.00",
    spend,
    ((sequence + 1) * 1.8).toFixed(2),
    "1.80",
    "1",
    spend,
    "90.00%",
    "100.00%",
    ((sequence + 1) * 1.8).toFixed(2),
    ((sequence + 1) * 1.5).toFixed(2),
    "1.50",
    "1",
    "100.00%",
    "100.00%",
    spend,
    "75.00%",
    "100.00%",
    ((sequence + 1) * 1.5).toFixed(2),
    "1",
    spend,
    ((sequence + 1) * 2).toFixed(2),
    String(100 + sequence),
    String(10 + sequence),
  ];
}

function productRow(productId, sequence, multiplier = 1) {
  const metricValues = dailyRow("unused", sequence).slice(1).map((value, index) => {
    if (String(value).endsWith("%")) return value;
    const number = Number(value);
    return Number.isFinite(number) ? String(number * multiplier) : value;
  });
  return [
    `SYNTHETIC_PRODUCT_${sequence}`,
    productId,
    "",
    `SYNTHETIC_PROMOTION_${sequence}`,
    "SYNTHETIC_BID",
    "",
    ...metricValues,
    String(10 * multiplier),
    String(5 * multiplier),
    "1",
    "1",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
  ];
}

function orderRow({
  buyerPaid,
  createdAt,
  merchantReceivable,
  orderId,
  productId,
  quantity,
  skuId,
  status,
}) {
  return [
    "SENSITIVE_PRODUCT_NAME",
    orderId,
    status,
    String(buyerPaid),
    "0",
    "0",
    "0",
    "0",
    String(buyerPaid),
    String(merchantReceivable),
    String(quantity),
    createdAt || "",
    createdAt || "",
    productId,
    "SENSITIVE_VARIANT",
    skuId,
    "SENSITIVE_MERCHANT_SKU",
    "",
    "SENSITIVE_MERCHANT_NOTE",
    "SYNTHETIC_AFTER_SALE_STATUS",
    "SENSITIVE_TRACKING_NUMBER",
    "SENSITIVE_CARRIER",
    createdAt || "",
    "否",
    "",
    "",
    "",
  ];
}

function createSyntheticSources(root) {
  const inputDir = join(root, "source");
  const outputDir = join(root, "private-output");
  const shareDir = join(root, "share-output");
  const fullDates = datesBetween("2026-05-01", "2026-08-31");
  const fullRows = fullDates.map(dailyRow);
  const rowsByDate = new Map(fullRows.map((row) => [row[0], row]));
  const juneRows = datesBetween("2026-06-01", "2026-06-30").map((date) => rowsByDate.get(date));
  const alignedRows = datesBetween("2026-06-05", "2026-06-30").map((date) => rowsByDate.get(date));
  const footer = ["合计", ...Array.from({ length: ADS_HEADERS.length - 1 }, () => "0")];
  mkdirSync(inputDir, { recursive: true });

  const orderRows = [
    orderRow({ buyerPaid: 10, createdAt: new Date(2026, 5, 5, 10, 0, 1), merchantReceivable: 9, orderId: "9000000000000000000001", productId: "P1", quantity: 1, skuId: "S1", status: "已完成" }),
    orderRow({ buyerPaid: 20, createdAt: "", merchantReceivable: 18, orderId: "9000000000000000000002", productId: "P9", quantity: 2, skuId: "S9", status: "订单已取消" }),
    orderRow({ buyerPaid: 30, createdAt: new Date(2026, 5, 6, 11, 0, 2), merchantReceivable: 27, orderId: "9000000000000000000003", productId: "P2", quantity: 1, skuId: "S2", status: "退款成功" }),
    orderRow({ buyerPaid: 40, createdAt: new Date(2026, 5, 7, 12, 0, 3), merchantReceivable: 36, orderId: "9000000000000000000004", productId: "P2", quantity: 3, skuId: "S2B", status: "已完成" }),
    orderRow({ buyerPaid: 5, createdAt: new Date(2026, 5, 5, 10, 1, 1), merchantReceivable: 4.5, orderId: "9000000000000000000001", productId: "P8", quantity: 1, skuId: "S8", status: "已完成" }),
  ];
  writeSourceWorkbook(join(inputDir, "synthetic-orders.xlsx"), ORDER_HEADERS, orderRows, "xlsx");
  writeSourceWorkbook(join(inputDir, "ads-account-day-20260501-20260831.xls"), ADS_HEADERS, [...fullRows, footer], "biff8");
  writeSourceWorkbook(join(inputDir, "ads-account-day-20260601-20260630.xls"), ADS_HEADERS, [...juneRows, footer], "biff8");
  writeSourceWorkbook(join(inputDir, "ads-account-day-20260605-20260630.xls"), ADS_HEADERS, [...alignedRows, footer], "biff8");
  writeSourceWorkbook(join(inputDir, "ads-product-period-20260501-20260831.xls"), PRODUCT_HEADERS, [
    productRow("P1", 1, 4),
    productRow("P2", 2, 4),
    productRow("P3", 3, 4),
    ["合计", "全部", ...Array.from({ length: PRODUCT_HEADERS.length - 2 }, () => "0")],
    ["说明：固定合成测试数据"],
  ], "biff8");
  writeSourceWorkbook(join(inputDir, "ads-product-period-20260605-20260630.xls"), PRODUCT_HEADERS, [
    productRow("P1", 1),
    productRow("P2", 2),
    productRow("P3", 3),
    ["合计", "全部", ...Array.from({ length: PRODUCT_HEADERS.length - 2 }, () => "0")],
    ["说明：固定合成测试数据"],
  ], "biff8");
  return { inputDir, outputDir, shareDir };
}

function worksheetWithHeaderMap(filePath, { cellDates = true } = {}) {
  const workbook = XLSX.readFile(filePath, { cellDates, cellNF: true });
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(worksheet, { defval: "", header: 1, raw: true });
  return {
    header: new Map(rows[0].map((name, index) => [name, index])),
    rows,
    worksheet,
  };
}

test("selects the canonical PDD files and proves overlap without modifying sources", () => {
  const root = mkdtempSync(join(tmpdir(), "pdd-standardize-"));
  try {
    const { inputDir } = createSyntheticSources(root);
    const before = new Map(readdirSync(inputDir).map((name) => [name, readFileSync(join(inputDir, name))]));
    const result = buildPddIntake({ accountAlias: "pdd_account_01", inputDir, sourceBatch: "synthetic_batch_01" });

    assert.equal(result.tables.order_item.length, 5);
    assert.equal(result.tables.ads_account_day.length, 123);
    assert.equal(result.tables.ads_product_period.length, 3);
    assert.equal(result.summary.selected.ads_account_day.excludedFooterRows, 1);
    assert.equal(result.summary.selected.ads_product_period.excludedFooterRows, 2);

    const dailySkips = result.summary.skipped.filter(({ kind }) => kind === "ads_account_day");
    assert.deepEqual(dailySkips.map(({ exactRows, overlappingDates, rows }) => ({ exactRows, overlappingDates, rows })), [
      { exactRows: 30, overlappingDates: 30, rows: 30 },
      { exactRows: 26, overlappingDates: 26, rows: 26 },
    ]);
    const productSkip = result.summary.skipped.find(({ kind }) => kind === "ads_product_period");
    assert.deepEqual(
      { exactRows: productSkip.exactRows, overlappingProducts: productSkip.overlappingProducts, rows: productSkip.rows },
      { exactRows: 0, overlappingProducts: 3, rows: 3 },
    );

    assert.deepEqual(result.summary.crossTableCoverage, {
      matchedOrderRows: 3,
      matchedOrderWeightTotal: 3,
      orderProductCount: 4,
      orderRows: 5,
      orderWeightTotal: 4,
      overlappingProductCount: 2,
      promotionCoverageRate: 0.75,
      promotedProductCount: 3,
      unmatchedOrderRows: 2,
    });
    assert.equal(result.summary.selected.order_item.effectiveSaleRows, 3);
    assert.equal(result.summary.selected.order_item.excludedSaleRows, 2);
    assert.equal(result.summary.selected.order_item.missingOrderCreatedAt, 1);
    assert.equal(result.summary.selected.order_item.rawQuantity, 8);
    assert.equal(result.summary.selected.order_item.effectiveQuantity, 5);
    assert.equal(result.summary.selected.order_item.rawBuyerPaidAmount, 105);
    assert.equal(result.summary.selected.order_item.effectiveBuyerPaidAmount, 55);
    assert.equal(result.summary.selected.order_item.buyerPaidReconciliationDifference, 0);
    assert.equal(result.summary.selected.order_item.rawMerchantReceivableAmount, 94.5);
    assert.equal(result.summary.selected.order_item.effectiveMerchantReceivableAmount, 49.5);
    assert.equal(result.summary.selected.order_item.merchantReceivableReconciliationDifference, 0);
    assert.deepEqual(
      result.tables.order_item.map(({ promotion_coverage_status }) => promotion_coverage_status),
      ["matched", "unmatched", "matched", "matched", "unmatched"],
    );
    assert.deepEqual(
      result.tables.order_item.map(({ is_effective_sale }) => is_effective_sale),
      [true, false, false, true, true],
    );
    assert.deepEqual(result.tables.order_item.map(({ order_weight }) => order_weight), [1, 1, 1, 1, 0]);
    assert.deepEqual(result.tables.order_item.map(({ matched_order_weight }) => matched_order_weight), [1, 0, 1, 1, 0]);
    for (const rows of Object.values(result.tables)) {
      assert.equal(rows.every(({ source_batch }) => source_batch === "synthetic_batch_01"), true);
    }

    for (const [name, contents] of before) {
      assert.deepEqual(readFileSync(join(inputDir, name)), contents);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("writes exactly three typed workbooks and excludes unnecessary sensitive source fields", () => {
  const root = mkdtempSync(join(tmpdir(), "pdd-standardize-"));
  try {
    const { inputDir, outputDir } = createSyntheticSources(root);
    const result = buildPddIntake({ accountAlias: "pdd_account_01", inputDir, sourceBatch: "synthetic_batch_01" });
    assert.deepEqual(writePddTables(result, outputDir), [
      "pdd_order_item.xlsx",
      "pdd_ads_account_day.xlsx",
      "pdd_ads_product_period.xlsx",
    ]);
    assert.deepEqual(readdirSync(outputDir).sort(), [
      "pdd_ads_account_day.xlsx",
      "pdd_ads_product_period.xlsx",
      "pdd_order_item.xlsx",
    ]);

    const order = worksheetWithHeaderMap(join(outputDir, "pdd_order_item.xlsx"), { cellDates: false });
    const orderId = order.worksheet[XLSX.utils.encode_cell({ c: order.header.get("order_id"), r: 1 })];
    const orderDate = order.worksheet[XLSX.utils.encode_cell({ c: order.header.get("order_created_at"), r: 1 })];
    const paid = order.worksheet[XLSX.utils.encode_cell({ c: order.header.get("buyer_paid_amount"), r: 1 })];
    const effective = order.worksheet[XLSX.utils.encode_cell({ c: order.header.get("is_effective_sale"), r: 1 })];
    assert.equal(orderId.t, "s");
    assert.equal(orderId.v, "9000000000000000000001");
    assert.equal(orderDate.t, "n");
    assert.deepEqual(
      (({ y, m, d, H, M, S }) => ({ y, m, d, H, M, S }))(XLSX.SSF.parse_date_code(orderDate.v)),
      { y: 2026, m: 6, d: 5, H: 10, M: 0, S: 0 },
    );
    assert.equal(orderDate.w, "2026-06-05 10:00:00");
    assert.equal(paid.t, "n");
    assert.equal(effective.t, "b");
    for (const excluded of ["商品", "商品规格", "商家备注", "快递单号", "快递公司", "分期方式"]) {
      assert.equal(order.header.has(excluded), false);
    }

    const account = worksheetWithHeaderMap(join(outputDir, "pdd_ads_account_day.xlsx"), { cellDates: false });
    const date = account.worksheet[XLSX.utils.encode_cell({ c: account.header.get("date"), r: 1 })];
    const spend = account.worksheet[XLSX.utils.encode_cell({ c: account.header.get("total_spend"), r: 1 })];
    const rate = account.worksheet[XLSX.utils.encode_cell({ c: account.header.get("net_gmv_share"), r: 1 })];
    assert.equal(date.t, "n");
    assert.deepEqual(
      (({ y, m, d, H, M, S }) => ({ y, m, d, H, M, S }))(XLSX.SSF.parse_date_code(date.v)),
      { y: 2026, m: 5, d: 1, H: 0, M: 0, S: 0 },
    );
    assert.equal(date.w, "2026-05-01");
    assert.equal(spend.t, "n");
    assert.equal(rate.t, "n");
    assert.equal(rate.z, "0.00%");

    assert.throws(
      () => writePddTables(result, join(repositoryRoot, "should-not-write-real-pdd-data")),
      /outside the Git repository/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("validate-only never writes even when an output directory is supplied", () => {
  const root = mkdtempSync(join(tmpdir(), "pdd-standardize-"));
  try {
    const { inputDir } = createSyntheticSources(root);
    const outputDir = join(root, "must-not-exist");
    const child = spawnSync(process.execPath, [
      join(scriptDirectory, "pdd-standardize.mjs"),
      "--input-dir", inputDir,
      "--account-alias", "pdd_account_01",
      "--source-batch", "synthetic_batch_01",
      "--output-dir", outputDir,
      "--validate-only",
    ], { encoding: "utf8" });

    assert.equal(child.status, 0, child.stderr);
    assert.equal(existsSync(outputDir), false);
    assert.equal(JSON.parse(child.stdout).written, undefined);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("validate-only rejects the synthetic sample writer", () => {
  const root = mkdtempSync(join(tmpdir(), "pdd-standardize-"));
  try {
    const shareDir = join(root, "must-not-exist");
    const child = spawnSync(process.execPath, [
      join(scriptDirectory, "pdd-standardize.mjs"),
      "--share-sample-dir", shareDir,
      "--validate-only",
    ], { encoding: "utf8" });

    assert.equal(child.status, 1);
    assert.match(child.stderr, /cannot be combined/u);
    assert.equal(existsSync(shareDir), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("share samples are fixed synthetic records and never reuse private source values", () => {
  const root = mkdtempSync(join(tmpdir(), "pdd-standardize-"));
  try {
    const { shareDir } = createSyntheticSources(root);
    writePddShareSamples(shareDir);
    const visible = readdirSync(shareDir)
      .map((name) => worksheetWithHeaderMap(join(shareDir, name)).rows)
      .flat(3)
      .map(String)
      .join("\n");
    for (const sensitive of [
      "9000000000000000000001",
      "SENSITIVE_PRODUCT_NAME",
      "SENSITIVE_VARIANT",
      "SENSITIVE_MERCHANT_NOTE",
      "SENSITIVE_TRACKING_NUMBER",
      "SYNTHETIC_PROMOTION_1",
    ]) assert.equal(visible.includes(sensitive), false);
    assert.match(visible, /2099-12-28|示例·清风/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("CLI-generated PDD share samples pass the formal seven-workbook verifier", () => {
  const root = mkdtempSync(join(tmpdir(), "pdd-standardize-"));
  try {
    const generatedPddDir = join(root, "generated-pdd");
    const child = spawnSync(process.execPath, [
      join(scriptDirectory, "pdd-standardize.mjs"),
      "--share-sample-dir", generatedPddDir,
    ], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);

    const packageDir = join(root, "seven-sample-package");
    mkdirSync(packageDir);
    const checkedInSamples = join(repositoryRoot, "templates", "ecommerce-workbench", "samples");
    for (const fileName of [
      "taobao_trade_day.xlsx",
      "taobao_terminal_day.xlsx",
      "taobao_price_band_day.xlsx",
      "taobao_category_month.xlsx",
    ]) copyFileSync(join(checkedInSamples, fileName), join(packageDir, fileName));
    for (const fileName of readdirSync(generatedPddDir)) {
      copyFileSync(join(generatedPddDir, fileName), join(packageDir, fileName));
    }

    assert.deepEqual(verifyWorkbenchShareSamples(packageDir), { files: 7, rows: 24 });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test.each([
  ["order_item", "synthetic-orders.xlsx", ORDER_HEADERS, []],
  ["ads_account_day", "ads-account-day-20260501-20260831.xls", ADS_HEADERS, [["合计"]]],
  ["ads_product_period", "ads-product-period-20260605-20260630.xls", PRODUCT_HEADERS, [["合计"], ["说明：无业务行"]]],
])("rejects %s when standardization yields zero business rows", (_table, fileName, headers, rows) => {
  const root = mkdtempSync(join(tmpdir(), "pdd-standardize-"));
  try {
    const { inputDir } = createSyntheticSources(root);
    writeSourceWorkbook(join(inputDir, fileName), headers, rows, fileName.endsWith(".xlsx") ? "xlsx" : "biff8");
    assert.throws(
      () => buildPddIntake({ accountAlias: "pdd_account_01", inputDir, sourceBatch: "synthetic_batch_01" }),
      /has no business rows after standardization/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("refuses an existing output directory", () => {
  const root = mkdtempSync(join(tmpdir(), "pdd-standardize-"));
  try {
    const { inputDir, outputDir } = createSyntheticSources(root);
    mkdirSync(outputDir);
    const result = buildPddIntake({ accountAlias: "pdd_account_01", inputDir, sourceBatch: "synthetic_batch_01" });
    assert.throws(() => writePddTables(result, outputDir), /must not already exist/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("leaves a failed batch directory unusable so a retry cannot mix batches", () => {
  const root = mkdtempSync(join(tmpdir(), "pdd-standardize-"));
  try {
    const { inputDir, outputDir } = createSyntheticSources(root);
    const result = buildPddIntake({ accountAlias: "pdd_account_01", inputDir, sourceBatch: "synthetic_batch_01" });
    const invalid = {
      ...result,
      tables: {
        ...result.tables,
        ads_account_day: [{ ...result.tables.ads_account_day[0], date: "invalid" }],
      },
    };
    assert.throws(() => writePddTables(invalid, outputDir), /cannot write invalid date/u);
    assert.equal(existsSync(outputDir), true);
    assert.throws(() => writePddTables(result, outputDir), /must not already exist/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("published schemas keep identifiers as text and effective fields typed", () => {
  for (const schema of Object.values(PDD_STANDARD_SCHEMAS)) {
    assert.equal(schema.find(({ name }) => name === "source_batch")?.type, "text");
  }
  const orderTypes = new Map(PDD_STANDARD_SCHEMAS.order_item.map(({ name, type }) => [name, type]));
  for (const id of ["order_id", "product_id", "sku_id", "merchant_sku_code"]) {
    assert.equal(orderTypes.get(id), "text");
  }
  assert.equal(orderTypes.get("has_order_created_at"), "boolean");
  assert.equal(orderTypes.get("promotion_coverage_status"), "text");
  assert.equal(orderTypes.get("order_weight"), "integer");
  assert.equal(orderTypes.get("matched_order_weight"), "integer");
  assert.equal(orderTypes.get("is_effective_sale"), "boolean");
  assert.equal(orderTypes.get("effective_quantity"), "integer");
  assert.equal(orderTypes.get("effective_buyer_paid_amount"), "number");
  assert.equal(orderTypes.get("effective_merchant_receivable_amount"), "number");
});
