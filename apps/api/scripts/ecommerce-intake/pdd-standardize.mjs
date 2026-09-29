import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const apiRoot = resolve(dirname(scriptPath), "..", "..");
const repositoryRoot = resolve(apiRoot, "..", "..");
const requireFromApi = createRequire(join(apiRoot, "package.json"));
const XLSX = requireFromApi("xlsx");

const DEFAULT_ACCOUNT_DAY_PERIOD = ["2026-05-01", "2026-08-31"];
const DEFAULT_PRODUCT_PERIOD = ["2026-06-05", "2026-06-30"];
const SPREADSHEET_PATTERN = /\.(xlsx|xls|csv)$/iu;
const SUMMARY_MARKER = /^(?:合计|汇总|总计|全部|--?|说明|提示)/u;

const ORDER_SCHEMA = [
  ["source_platform", "text"],
  ["source_account_alias", "text"],
  ["source_batch", "text"],
  ["order_id", "text"],
  ["order_status", "text"],
  ["order_created_at", "datetime"],
  ["order_date", "date"],
  ["has_order_created_at", "boolean"],
  ["product_id", "text"],
  ["sku_id", "text"],
  ["merchant_sku_code", "text"],
  ["promotion_coverage_status", "text"],
  ["order_weight", "integer"],
  ["matched_order_weight", "integer"],
  ["is_effective_sale", "boolean"],
  ["quantity", "integer"],
  ["effective_quantity", "integer"],
  ["product_gross_amount", "number"],
  ["shipping_amount", "number"],
  ["merchant_discount_amount", "number"],
  ["platform_discount_amount", "number"],
  ["payment_discount_amount", "number"],
  ["buyer_paid_amount", "number"],
  ["effective_buyer_paid_amount", "number"],
  ["merchant_receivable_amount", "number"],
  ["effective_merchant_receivable_amount", "number"],
  ["after_sale_status", "text"],
  ["shipped_at", "datetime"],
  ["received_at", "datetime"],
];

const ADS_METRICS = [
  ["conversion_spend", "成交花费(元)", "number"],
  ["attributed_gmv", "交易额(元)", "number"],
  ["actual_roas", "实际投产比", "number"],
  ["total_spend", "总花费(元)", "number"],
  ["net_gmv", "净交易额(元)", "number"],
  ["net_roas", "净实际投产比", "number"],
  ["net_orders", "净成交笔数", "integer"],
  ["net_cpa", "每笔净成交花费(元)", "number"],
  ["net_gmv_share", "净交易额占比", "ratio"],
  ["net_order_share", "净成交笔数占比", "ratio"],
  ["net_aov", "每笔净成交金额(元)", "number"],
  ["settled_gmv", "结算交易额(元)", "number"],
  ["settled_roas", "结算投产比", "number"],
  ["settled_orders", "结算成交笔数", "integer"],
  ["refund_exemption_rate", "退款豁免率", "ratio"],
  ["canceled_order_exemption_rate", "退单豁免率", "ratio"],
  ["settled_cpa", "每笔结算成交花费(元)", "number"],
  ["gmv_settlement_rate", "交易额结算率", "ratio"],
  ["order_settlement_rate", "订单结算率", "ratio"],
  ["settled_aov", "每笔结算成交金额(元)", "number"],
  ["attributed_orders", "成交笔数", "integer"],
  ["attributed_cpa", "每笔成交花费(元)", "number"],
  ["attributed_aov", "每笔成交金额(元)", "number"],
  ["impressions", "曝光量", "integer"],
  ["clicks", "点击量", "integer"],
];

const PRODUCT_EXTRA_METRICS = [
  ["direct_gmv", "直接交易额(元)", "number"],
  ["indirect_gmv", "间接交易额(元)", "number"],
  ["direct_orders", "直接成交笔数", "integer"],
  ["indirect_orders", "间接成交笔数", "integer"],
  ["inquiry_spend", "询单花费(元)", "number"],
  ["inquiries", "询单量", "integer"],
  ["inquiry_cpa", "平均询单成本(元)", "number"],
  ["favorite_spend", "收藏花费(元)", "number"],
  ["favorites", "收藏量", "integer"],
  ["favorite_cpa", "平均收藏成本(元)", "number"],
  ["follow_spend", "关注花费(元)", "number"],
  ["follows", "关注量", "integer"],
  ["follow_cpa", "平均关注成本(元)", "number"],
];

const ACCOUNT_DAY_SCHEMA = [
  ["source_platform", "text"],
  ["source_account_alias", "text"],
  ["source_batch", "text"],
  ["date", "date"],
  ...ADS_METRICS.map(([name, , type]) => [name, type]),
];

const PRODUCT_PERIOD_SCHEMA = [
  ["source_platform", "text"],
  ["source_account_alias", "text"],
  ["source_batch", "text"],
  ["period_start", "date"],
  ["period_end", "date"],
  ["product_id", "text"],
  ["product_name", "text"],
  ["group_name", "text"],
  ["promotion_name", "text"],
  ["bid_method", "text"],
  ["is_deleted", "boolean"],
  ...ADS_METRICS.map(([name, , type]) => [name, type]),
  ...PRODUCT_EXTRA_METRICS.map(([name, , type]) => [name, type]),
];

export const PDD_STANDARD_SCHEMAS = Object.freeze({
  order_item: ORDER_SCHEMA.map(([name, type]) => ({ name, type })),
  ads_account_day: ACCOUNT_DAY_SCHEMA.map(([name, type]) => ({ name, type })),
  ads_product_period: PRODUCT_PERIOD_SCHEMA.map(([name, type]) => ({ name, type })),
});

function normalizeHeader(value) {
  return String(value ?? "").replace(/^\uFEFF/u, "").trim().toLowerCase();
}

function normalizeCell(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}T${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}:${String(value.getSeconds()).padStart(2, "0")}`;
  }
  return String(value ?? "").trim();
}

function parsePeriodDate(compact) {
  const match = /^(20\d{2})(\d{2})(\d{2})$/u.exec(compact);
  if (!match) return null;
  return normalizeDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
}

function normalizeDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function extractFilenamePeriod(fileName) {
  const compactDates = basename(fileName).match(/(?<!\d)20\d{6}(?!\d)/gu) ?? [];
  if (compactDates.length < 2) return null;
  const start = parsePeriodDate(compactDates[0]);
  const end = parsePeriodDate(compactDates[1]);
  return start && end ? [start, end] : null;
}

function parseDate(value, context, { optional = false } = {}) {
  const text = normalizeCell(value);
  if (!text) {
    if (optional) return null;
    throw new Error(`${context}: required date is blank`);
  }
  const match = /^(20\d{2})[-/]([01]?\d)[-/]([0-3]?\d)(?:[ T].*)?$/u.exec(text);
  const date = match
    ? normalizeDateParts(Number(match[1]), Number(match[2]), Number(match[3]))
    : null;
  if (!date) throw new Error(`${context}: invalid date`);
  return date;
}

function parseDateTime(value, context, { optional = false } = {}) {
  const text = normalizeCell(value);
  if (!text) {
    if (optional) return null;
    throw new Error(`${context}: required datetime is blank`);
  }
  const match = /^(20\d{2})[-/]([01]?\d)[-/]([0-3]?\d)(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/u.exec(text);
  if (!match) throw new Error(`${context}: invalid datetime`);
  const date = normalizeDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);
  if (!date || hour > 23 || minute > 59 || second > 59) {
    throw new Error(`${context}: invalid datetime`);
  }
  return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function parseNumber(value, context, { integer = false, ratio = false } = {}) {
  const original = normalizeCell(value);
  if (!original || /^(?:--?|null|n\/a)$/iu.test(original)) return null;
  const percentage = original.endsWith("%");
  const cleaned = original
    .replace(/[,%￥¥元\s]/gu, "")
    .replace(/^\((.*)\)$/u, "-$1");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) throw new Error(`${context}: invalid numeric value`);
  const result = ratio && percentage ? parsed / 100 : parsed;
  if (integer && !Number.isInteger(result)) {
    throw new Error(`${context}: expected an integer`);
  }
  return result;
}

function parseBoolean(value, context) {
  const text = normalizeCell(value);
  if (!text || text === "--" || text === "-") return null;
  if (/^(?:是|true|1)$/iu.test(text)) return true;
  if (/^(?:否|false|0)$/iu.test(text)) return false;
  throw new Error(`${context}: invalid boolean value`);
}

function requiredText(value, context) {
  const text = normalizeCell(value);
  if (!text) throw new Error(`${context}: required text is blank`);
  return text;
}

function optionalText(value) {
  const text = normalizeCell(value);
  return text || null;
}

function periodEquals(left, right) {
  return Boolean(left && left[0] === right[0] && left[1] === right[1]);
}

function periodLabel(period) {
  return period ? `${period[0]}:${period[1]}` : null;
}

function readDataset(filePath, sourceRef) {
  const workbook = XLSX.read(readFileSync(filePath), {
    cellDates: true,
    type: "buffer",
  });
  if (workbook.SheetNames.length !== 1) {
    throw new Error(`${sourceRef}: expected exactly one worksheet`);
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json(sheet, {
    blankrows: true,
    defval: "",
    header: 1,
    raw: true,
  });
  if (matrix.length === 0) throw new Error(`${sourceRef}: workbook is empty`);
  const headers = matrix[0].map(normalizeCell);
  const headerIndex = new Map(headers.map((header, index) => [normalizeHeader(header), index]));
  const rows = matrix
    .slice(1)
    .map((cells, index) => ({
      cells: Array.from({ length: headers.length }, (_, column) => normalizeCell(cells[column])),
      sourceRow: index + 2,
    }))
    .filter(({ cells }) => cells.some(Boolean));
  return {
    filePath,
    headers,
    headerIndex,
    period: extractFilenamePeriod(filePath),
    rows,
    sourceRef,
  };
}

function hasHeaders(dataset, names) {
  return names.every((name) => dataset.headerIndex.has(normalizeHeader(name)));
}

function classifyDataset(dataset) {
  if (hasHeaders(dataset, ["订单号", "商品id", "订单成交时间"])) return "order_item";
  if (hasHeaders(dataset, ["商品ID", "推广名称", "总花费(元)"])) return "ads_product_period";
  if (hasHeaders(dataset, ["日期", "总花费(元)", "曝光量", "点击量"])) return "ads_account_day";
  return "unrecognized";
}

function sourceValue(dataset, row, header, { optional = false } = {}) {
  const index = dataset.headerIndex.get(normalizeHeader(header));
  if (index === undefined) {
    if (optional) return "";
    throw new Error(`${dataset.sourceRef}: missing required column ${header}`);
  }
  return row.cells[index];
}

function rowContext(dataset, row, target) {
  return `${dataset.sourceRef}: row ${row.sourceRow}, ${target}`;
}

function splitDailyRows(dataset) {
  const data = [];
  let excludedFooterRows = 0;
  for (const row of dataset.rows) {
    const first = sourceValue(dataset, row, "日期");
    try {
      parseDate(first, rowContext(dataset, row, "date"));
      data.push(row);
    } catch (error) {
      if (SUMMARY_MARKER.test(first)) {
        excludedFooterRows += 1;
      } else {
        throw error;
      }
    }
  }
  return { data, excludedFooterRows };
}

function splitProductRows(dataset) {
  const data = [];
  let excludedFooterRows = 0;
  for (const row of dataset.rows) {
    const productId = sourceValue(dataset, row, "商品ID");
    const productName = sourceValue(dataset, row, "商品名称");
    if (
      !productId
      || SUMMARY_MARKER.test(productId)
      || SUMMARY_MARKER.test(productName)
    ) {
      excludedFooterRows += 1;
      continue;
    }
    data.push(row);
  }
  return { data, excludedFooterRows };
}

function standardizeMetricFields(dataset, row, mappings) {
  return Object.fromEntries(mappings.map(([target, source, type]) => {
    const context = rowContext(dataset, row, target);
    const raw = sourceValue(dataset, row, source);
    if (type === "integer") return [target, parseNumber(raw, context, { integer: true })];
    if (type === "ratio") return [target, parseNumber(raw, context, { ratio: true })];
    return [target, parseNumber(raw, context)];
  }));
}

function standardizeOrders(dataset, accountAlias, sourceBatch, promotedProductIds) {
  const rows = dataset.rows.map((row) => {
    const orderCreatedAt = parseDateTime(
      sourceValue(dataset, row, "订单成交时间"),
      rowContext(dataset, row, "order_created_at"),
      { optional: true },
    );
    const orderStatus = requiredText(
      sourceValue(dataset, row, "订单状态"),
      rowContext(dataset, row, "order_status"),
    );
    const productId = requiredText(
      sourceValue(dataset, row, "商品id"),
      rowContext(dataset, row, "product_id"),
    );
    const quantity = parseNumber(
      sourceValue(dataset, row, "商品数量(件)"),
      rowContext(dataset, row, "quantity"),
      { integer: true },
    );
    const buyerPaidAmount = parseNumber(
      sourceValue(dataset, row, "用户实付金额(元)"),
      rowContext(dataset, row, "buyer_paid_amount"),
    );
    const merchantReceivableAmount = parseNumber(
      sourceValue(dataset, row, "商家实收金额(元)"),
      rowContext(dataset, row, "merchant_receivable_amount"),
    );
    const isEffectiveSale = !/(?:取消|退款成功)/u.test(orderStatus);
    return {
      source_platform: "pinduoduo",
      source_account_alias: accountAlias,
      source_batch: sourceBatch,
      order_id: requiredText(sourceValue(dataset, row, "订单号"), rowContext(dataset, row, "order_id")),
      order_status: orderStatus,
      order_created_at: orderCreatedAt,
      order_date: orderCreatedAt?.slice(0, 10) ?? null,
      has_order_created_at: Boolean(orderCreatedAt),
      product_id: productId,
      sku_id: requiredText(sourceValue(dataset, row, "样式ID"), rowContext(dataset, row, "sku_id")),
      merchant_sku_code: optionalText(sourceValue(dataset, row, "商家编码-规格维度", { optional: true })),
      promotion_coverage_status: promotedProductIds.has(productId) ? "matched" : "unmatched",
      is_effective_sale: isEffectiveSale,
      quantity,
      effective_quantity: isEffectiveSale ? quantity : 0,
      product_gross_amount: parseNumber(sourceValue(dataset, row, "商品总价(元)"), rowContext(dataset, row, "product_gross_amount")),
      shipping_amount: parseNumber(sourceValue(dataset, row, "邮费(元)"), rowContext(dataset, row, "shipping_amount")),
      merchant_discount_amount: parseNumber(sourceValue(dataset, row, "店铺优惠折扣(元)"), rowContext(dataset, row, "merchant_discount_amount")),
      platform_discount_amount: parseNumber(sourceValue(dataset, row, "平台优惠折扣(元)"), rowContext(dataset, row, "platform_discount_amount")),
      payment_discount_amount: parseNumber(sourceValue(dataset, row, "多多支付立减金额(元)"), rowContext(dataset, row, "payment_discount_amount")),
      buyer_paid_amount: buyerPaidAmount,
      effective_buyer_paid_amount: isEffectiveSale ? buyerPaidAmount : 0,
      merchant_receivable_amount: merchantReceivableAmount,
      effective_merchant_receivable_amount: isEffectiveSale ? merchantReceivableAmount : 0,
      after_sale_status: optionalText(sourceValue(dataset, row, "售后状态", { optional: true })),
      shipped_at: parseDateTime(sourceValue(dataset, row, "发货时间", { optional: true }), rowContext(dataset, row, "shipped_at"), { optional: true }),
      received_at: parseDateTime(sourceValue(dataset, row, "确认收货时间", { optional: true }), rowContext(dataset, row, "received_at"), { optional: true }),
    };
  });
  const orderHasPromotion = new Map();
  for (const row of rows) {
    const key = `${row.source_account_alias}\u001F${row.order_id}`;
    orderHasPromotion.set(
      key,
      Boolean(orderHasPromotion.get(key)) || row.promotion_coverage_status === "matched",
    );
  }
  const seenOrders = new Set();
  return rows.map((row) => {
    const key = `${row.source_account_alias}\u001F${row.order_id}`;
    const isFirstOrderRow = !seenOrders.has(key);
    seenOrders.add(key);
    return {
      ...row,
      order_weight: isFirstOrderRow ? 1 : 0,
      matched_order_weight: isFirstOrderRow && orderHasPromotion.get(key) ? 1 : 0,
    };
  });
}

function standardizeAccountDays(dataset, accountAlias, sourceBatch) {
  const split = splitDailyRows(dataset);
  return {
    excludedFooterRows: split.excludedFooterRows,
    rows: split.data.map((row) => ({
      source_platform: "pinduoduo",
      source_account_alias: accountAlias,
      source_batch: sourceBatch,
      date: parseDate(sourceValue(dataset, row, "日期"), rowContext(dataset, row, "date")),
      ...standardizeMetricFields(dataset, row, ADS_METRICS),
    })),
  };
}

function standardizeProductPeriods(dataset, accountAlias, sourceBatch) {
  if (!dataset.period) throw new Error(`${dataset.sourceRef}: product report period is missing from filename`);
  const split = splitProductRows(dataset);
  return {
    excludedFooterRows: split.excludedFooterRows,
    rows: split.data.map((row) => ({
      source_platform: "pinduoduo",
      source_account_alias: accountAlias,
      source_batch: sourceBatch,
      period_start: dataset.period[0],
      period_end: dataset.period[1],
      product_id: requiredText(sourceValue(dataset, row, "商品ID"), rowContext(dataset, row, "product_id")),
      product_name: optionalText(sourceValue(dataset, row, "商品名称")),
      group_name: optionalText(sourceValue(dataset, row, "分组", { optional: true })),
      promotion_name: optionalText(sourceValue(dataset, row, "推广名称")),
      bid_method: optionalText(sourceValue(dataset, row, "出价方式", { optional: true })),
      is_deleted: parseBoolean(sourceValue(dataset, row, "是否已删除", { optional: true }), rowContext(dataset, row, "is_deleted")),
      ...standardizeMetricFields(dataset, row, ADS_METRICS),
      ...standardizeMetricFields(dataset, row, PRODUCT_EXTRA_METRICS),
    })),
  };
}

function uniqueCount(rows, key) {
  return new Set(rows.map(key)).size;
}

function minMax(values) {
  const present = values.filter(Boolean).sort();
  return {
    max: present.at(-1) ?? null,
    min: present[0] ?? null,
  };
}

function sum(rows, field, predicate = () => true) {
  return rows.reduce((total, row) => (
    predicate(row) && typeof row[field] === "number" ? total + row[field] : total
  ), 0);
}

function rounded(value, precision = 2) {
  const scale = 10 ** precision;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function rawRowSignature(row) {
  return JSON.stringify(row.cells);
}

function dailyOverlap(selected, candidate) {
  const selectedRows = splitDailyRows(selected).data;
  const candidateRows = splitDailyRows(candidate).data;
  const selectedByDate = new Map(selectedRows.map((row) => [
    parseDate(sourceValue(selected, row, "日期"), rowContext(selected, row, "date")),
    rawRowSignature(row),
  ]));
  let overlappingDates = 0;
  let exactRows = 0;
  for (const row of candidateRows) {
    const date = parseDate(sourceValue(candidate, row, "日期"), rowContext(candidate, row, "date"));
    if (!selectedByDate.has(date)) continue;
    overlappingDates += 1;
    if (selectedByDate.get(date) === rawRowSignature(row)) exactRows += 1;
  }
  return { exactRows, overlappingDates, rows: candidateRows.length };
}

function productOverlap(selected, candidate) {
  const selectedRows = splitProductRows(selected).data;
  const candidateRows = splitProductRows(candidate).data;
  const selectedByProduct = new Map(selectedRows.map((row) => [
    sourceValue(selected, row, "商品ID"),
    rawRowSignature(row),
  ]));
  let overlappingProducts = 0;
  let exactRows = 0;
  for (const row of candidateRows) {
    const productId = sourceValue(candidate, row, "商品ID");
    if (!selectedByProduct.has(productId)) continue;
    overlappingProducts += 1;
    if (selectedByProduct.get(productId) === rawRowSignature(row)) exactRows += 1;
  }
  return { exactRows, overlappingProducts, rows: candidateRows.length };
}

function exactlyOne(candidates, label) {
  if (candidates.length !== 1) {
    throw new Error(`expected exactly one ${label} source, found ${candidates.length}`);
  }
  return candidates[0];
}

function assertSafeLabel(value, label) {
  value = normalizeCell(value);
  if (!value || value.length > 80 || /[\u0000-\u001F]/u.test(value)) {
    throw new Error(`${label} must be a non-empty label of at most 80 characters`);
  }
  return value;
}

export function buildPddIntake({
  accountAlias,
  accountDayPeriod = DEFAULT_ACCOUNT_DAY_PERIOD,
  inputDir,
  productPeriod = DEFAULT_PRODUCT_PERIOD,
  sourceBatch,
}) {
  const safeAlias = assertSafeLabel(accountAlias, "account alias");
  const safeBatch = assertSafeLabel(sourceBatch, "source batch");
  const absoluteInput = resolve(inputDir);
  if (!statSync(absoluteInput).isDirectory()) throw new Error("input path must be a directory");
  const files = readdirSync(absoluteInput, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SPREADSHEET_PATTERN.test(entry.name))
    .sort((left, right) => Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")));
  if (files.length === 0) throw new Error("input directory contains no supported spreadsheets");

  const datasets = files.map((entry, index) => {
    const dataset = readDataset(join(absoluteInput, entry.name), `source_${String(index + 1).padStart(2, "0")}`);
    dataset.kind = classifyDataset(dataset);
    return dataset;
  });
  const order = exactlyOne(datasets.filter((item) => item.kind === "order_item"), "order_item");
  const selectedAccountDay = exactlyOne(
    datasets.filter((item) => item.kind === "ads_account_day" && periodEquals(item.period, accountDayPeriod)),
    `ads_account_day ${periodLabel(accountDayPeriod)}`,
  );
  const selectedProductPeriod = exactlyOne(
    datasets.filter((item) => item.kind === "ads_product_period" && periodEquals(item.period, productPeriod)),
    `ads_product_period ${periodLabel(productPeriod)}`,
  );

  const accountDay = standardizeAccountDays(selectedAccountDay, safeAlias, safeBatch);
  const productPeriodRows = standardizeProductPeriods(selectedProductPeriod, safeAlias, safeBatch);
  const promotedProducts = new Set(productPeriodRows.rows.map((row) => row.product_id));
  const orderRows = standardizeOrders(order, safeAlias, safeBatch, promotedProducts);
  for (const [tableName, rows] of Object.entries({
    ads_account_day: accountDay.rows,
    ads_product_period: productPeriodRows.rows,
    order_item: orderRows,
  })) {
    if (rows.length === 0) throw new Error(`${tableName} has no business rows after standardization`);
  }
  if (uniqueCount(accountDay.rows, (row) => row.date) !== accountDay.rows.length) {
    throw new Error("selected ads_account_day contains duplicate dates");
  }
  if (
    uniqueCount(
      productPeriodRows.rows,
      (row) => `${row.period_start}\u001F${row.period_end}\u001F${row.product_id}\u001F${row.promotion_name ?? ""}`,
    ) !== productPeriodRows.rows.length
  ) throw new Error("selected ads_product_period contains duplicate business keys");

  const selected = new Set([order, selectedAccountDay, selectedProductPeriod]);
  const skipped = datasets.filter((item) => !selected.has(item)).map((item) => {
    if (item.kind === "ads_account_day") {
      const overlap = dailyOverlap(selectedAccountDay, item);
      return {
        ...overlap,
        kind: item.kind,
        period: periodLabel(item.period),
        reason: overlap.exactRows === overlap.rows
          ? "exact_overlapping_subset_of_selected_account_day"
          : "unselected_account_day_period",
      };
    }
    if (item.kind === "ads_product_period") {
      const overlap = productOverlap(selectedProductPeriod, item);
      return {
        ...overlap,
        kind: item.kind,
        period: periodLabel(item.period),
        reason: "different_period_snapshot_not_selected",
      };
    }
    return { kind: item.kind, period: periodLabel(item.period), reason: "unrecognized_schema" };
  });

  const orderProducts = new Set(orderRows.map((row) => row.product_id));
  const overlappingProducts = [...promotedProducts].filter((productId) => orderProducts.has(productId));
  const matchedOrderRows = orderRows.filter((row) => row.promotion_coverage_status === "matched").length;
  const orderDateRange = minMax(orderRows.map((row) => row.order_date));
  const accountDateRange = minMax(accountDay.rows.map((row) => row.date));
  const effectiveRows = orderRows.filter((row) => row.is_effective_sale);
  const excludedRows = orderRows.filter((row) => !row.is_effective_sale);
  const rawQuantity = sum(orderRows, "quantity");
  const effectiveQuantity = sum(orderRows, "effective_quantity");
  const rawBuyerPaid = sum(orderRows, "buyer_paid_amount");
  const effectiveBuyerPaid = sum(orderRows, "effective_buyer_paid_amount");
  const rawMerchantReceivable = sum(orderRows, "merchant_receivable_amount");
  const effectiveMerchantReceivable = sum(orderRows, "effective_merchant_receivable_amount");
  const excludedBuyerPaid = sum(excludedRows, "buyer_paid_amount");
  const excludedMerchantReceivable = sum(excludedRows, "merchant_receivable_amount");
  const orderWeightTotal = sum(orderRows, "order_weight");
  const matchedOrderWeightTotal = sum(orderRows, "matched_order_weight");

  return {
    inputDir: absoluteInput,
    summary: {
      crossTableCoverage: {
        matchedOrderRows,
        matchedOrderWeightTotal,
        orderProductCount: orderProducts.size,
        orderRows: orderRows.length,
        orderWeightTotal,
        overlappingProductCount: overlappingProducts.length,
        promotionCoverageRate: orderWeightTotal > 0
          ? rounded(matchedOrderWeightTotal / orderWeightTotal, 6)
          : null,
        promotedProductCount: promotedProducts.size,
        unmatchedOrderRows: orderRows.length - matchedOrderRows,
      },
      selected: {
        ads_account_day: {
          dateMax: accountDateRange.max,
          dateMin: accountDateRange.min,
          excludedFooterRows: accountDay.excludedFooterRows,
          period: periodLabel(selectedAccountDay.period),
          rows: accountDay.rows.length,
        },
        ads_product_period: {
          excludedFooterRows: productPeriodRows.excludedFooterRows,
          period: periodLabel(selectedProductPeriod.period),
          rows: productPeriodRows.rows.length,
          uniqueProducts: promotedProducts.size,
        },
        order_item: {
          effectiveSaleRows: effectiveRows.length,
          excludedSaleRows: excludedRows.length,
          effectiveQuantity: rounded(effectiveQuantity, 4),
          rawQuantity: rounded(rawQuantity, 4),
          excludedQuantity: rounded(rawQuantity - effectiveQuantity, 4),
          effectiveBuyerPaidAmount: rounded(effectiveBuyerPaid),
          excludedBuyerPaidAmount: rounded(excludedBuyerPaid),
          rawBuyerPaidAmount: rounded(rawBuyerPaid),
          buyerPaidReconciliationDifference: rounded(rawBuyerPaid - effectiveBuyerPaid - excludedBuyerPaid),
          effectiveMerchantReceivableAmount: rounded(effectiveMerchantReceivable),
          excludedMerchantReceivableAmount: rounded(excludedMerchantReceivable),
          rawMerchantReceivableAmount: rounded(rawMerchantReceivable),
          merchantReceivableReconciliationDifference: rounded(
            rawMerchantReceivable - effectiveMerchantReceivable - excludedMerchantReceivable,
          ),
          missingOrderCreatedAt: orderRows.filter((row) => !row.order_created_at).length,
          orderDateMax: orderDateRange.max,
          orderDateMin: orderDateRange.min,
          rows: orderRows.length,
          uniqueOrders: uniqueCount(orderRows, (row) => row.order_id),
          uniqueProducts: orderProducts.size,
        },
      },
      skipped,
    },
    tables: {
      ads_account_day: accountDay.rows,
      ads_product_period: productPeriodRows.rows,
      order_item: orderRows,
    },
  };
}

function dateValue(value, type) {
  if (value === null || value === undefined || value === "") return null;
  const match = /^(20\d{2})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?$/u.exec(String(value));
  if (!match) throw new Error(`cannot write invalid ${type}: ${value}`);
  // Excel serials are timezone-free wall-clock values. Pair an explicit UTC
  // Date with SheetJS UTC mode so the host timezone and DST cannot shift them.
  return new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] ?? 0),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0),
  ));
}

function workbookBuffer(tableName, rows) {
  const schema = PDD_STANDARD_SCHEMAS[tableName];
  const matrix = [
    schema.map(({ name }) => name),
    ...rows.map((row) => schema.map(({ name, type }) => (
      type === "date" || type === "datetime" ? dateValue(row[name], type) : row[name]
    ))),
  ];
  const sheet = XLSX.utils.aoa_to_sheet(matrix, { cellDates: true, UTC: true });
  for (let column = 0; column < schema.length; column += 1) {
    const { type } = schema[column];
    for (let row = 1; row < matrix.length; row += 1) {
      const address = XLSX.utils.encode_cell({ c: column, r: row });
      const cell = sheet[address];
      if (!cell) continue;
      if (type === "text") {
        cell.t = "s";
        cell.v = String(cell.v);
        cell.z = "@";
      } else if (type === "date") {
        cell.z = "yyyy-mm-dd";
      } else if (type === "datetime") {
        cell.z = "yyyy-mm-dd hh:mm:ss";
      } else if (type === "ratio") {
        cell.z = "0.00%";
      } else if (type === "number") {
        cell.z = "0.00";
      } else if (type === "integer") {
        cell.z = "0";
      }
    }
  }
  sheet["!cols"] = schema.map(({ name, type }) => ({
    wch: Math.max(name.length + 2, type === "datetime" ? 20 : 12),
  }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "standard_table");
  return XLSX.write(workbook, { bookType: "xlsx", compression: true, type: "buffer" });
}

function isWithin(parent, candidate) {
  const pathFromParent = relative(resolve(parent), resolve(candidate));
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

function assertSafeOutputDirectory(outputDir, inputDir) {
  const absoluteOutput = resolve(outputDir);
  if (isWithin(repositoryRoot, absoluteOutput)) {
    throw new Error("output directory must be outside the Git repository");
  }
  if (inputDir && isWithin(resolve(inputDir), absoluteOutput)) {
    throw new Error("output directory must be outside the source directory");
  }
  return absoluteOutput;
}

function writeTablesInternal(tables, outputDir) {
  mkdirSync(dirname(outputDir), { recursive: true });
  try {
    mkdirSync(outputDir);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new Error("output directory must not already exist");
    }
    throw error;
  }
  const written = [];
  for (const tableName of ["order_item", "ads_account_day", "ads_product_period"]) {
    const fileName = `pdd_${tableName}.xlsx`;
    writeFileSync(join(outputDir, fileName), workbookBuffer(tableName, tables[tableName]));
    written.push(fileName);
  }
  return written;
}

export function writePddTables(result, outputDir) {
  const absoluteOutput = assertSafeOutputDirectory(outputDir, result.inputDir);
  return writeTablesInternal(result.tables, absoluteOutput);
}

function emptyRow(tableName) {
  return Object.fromEntries(PDD_STANDARD_SCHEMAS[tableName].map(({ name }) => [name, null]));
}

export function buildPddShareSamples() {
  const common = {
    source_platform: "pinduoduo",
    source_account_alias: "示例账户",
    source_batch: "SAMPLE_BATCH_20991231",
  };
  const metrics = (scale) => ({
    conversion_spend: 0.01 * scale,
    attributed_gmv: 0.02 * scale,
    actual_roas: 2,
    total_spend: 0.01 * scale,
    net_gmv: 0.018 * scale,
    net_roas: 1.8,
    net_orders: scale,
    net_cpa: 0.01,
    net_gmv_share: 0.9,
    net_order_share: 1,
    net_aov: 0.018,
    settled_gmv: 0.015 * scale,
    settled_roas: 1.5,
    settled_orders: scale,
    refund_exemption_rate: 1,
    canceled_order_exemption_rate: 1,
    settled_cpa: 0.01,
    gmv_settlement_rate: 0.75,
    order_settlement_rate: 1,
    settled_aov: 0.015,
    attributed_orders: scale,
    attributed_cpa: 0.01,
    attributed_aov: 0.02,
    impressions: 100 * scale,
    clicks: 10 * scale,
  });
  const order = (values) => ({
    ...emptyRow("order_item"),
    ...common,
    shipping_amount: 0,
    merchant_discount_amount: 0,
    platform_discount_amount: 0,
    payment_discount_amount: 0,
    after_sale_status: "示例·无售后",
    ...values,
  });
  const orders = [
    order({
      order_id: "ORDER_SAMPLE_001", order_status: "示例·已完成",
      order_created_at: "2099-12-28T10:00:00", order_date: "2099-12-28", has_order_created_at: true,
      product_id: "PRODUCT_SAMPLE_A", sku_id: "SKU_SAMPLE_A", merchant_sku_code: "MERCHANT_SKU_SAMPLE_A",
      promotion_coverage_status: "matched", order_weight: 1, matched_order_weight: 1,
      is_effective_sale: true, quantity: 1, effective_quantity: 1,
      product_gross_amount: 0.01, buyer_paid_amount: 0.01, effective_buyer_paid_amount: 0.01,
      merchant_receivable_amount: 0.01, effective_merchant_receivable_amount: 0.01,
      shipped_at: "2099-12-28T12:00:00", received_at: "2099-12-29T12:00:00",
    }),
    order({
      order_id: "ORDER_SAMPLE_002", order_status: "示例·待收货",
      order_created_at: "2099-12-29T10:00:00", order_date: "2099-12-29", has_order_created_at: true,
      product_id: "PRODUCT_SAMPLE_B", sku_id: "SKU_SAMPLE_B", merchant_sku_code: "MERCHANT_SKU_SAMPLE_B",
      promotion_coverage_status: "unmatched", order_weight: 1, matched_order_weight: 0,
      is_effective_sale: true, quantity: 2, effective_quantity: 2,
      product_gross_amount: 0.02, buyer_paid_amount: 0.02, effective_buyer_paid_amount: 0.02,
      merchant_receivable_amount: 0.02, effective_merchant_receivable_amount: 0.02,
      shipped_at: "2099-12-29T12:00:00",
    }),
    order({
      order_id: "ORDER_SAMPLE_003", order_status: "示例·订单已取消",
      order_created_at: "2099-12-30T10:00:00", order_date: "2099-12-30", has_order_created_at: true,
      product_id: "PRODUCT_SAMPLE_C", sku_id: "SKU_SAMPLE_C", merchant_sku_code: "MERCHANT_SKU_SAMPLE_C",
      promotion_coverage_status: "matched", order_weight: 1, matched_order_weight: 1,
      is_effective_sale: false, quantity: 1, effective_quantity: 0,
      product_gross_amount: 0.01, buyer_paid_amount: 0.01, effective_buyer_paid_amount: 0,
      merchant_receivable_amount: 0.01, effective_merchant_receivable_amount: 0,
    }),
    order({
      order_id: "ORDER_SAMPLE_004", order_status: "示例·已完成", has_order_created_at: false,
      product_id: "PRODUCT_SAMPLE_A", sku_id: "SKU_SAMPLE_A2", merchant_sku_code: "MERCHANT_SKU_SAMPLE_A2",
      promotion_coverage_status: "matched", order_weight: 1, matched_order_weight: 1,
      is_effective_sale: true, quantity: 1, effective_quantity: 1,
      product_gross_amount: 0.01, buyer_paid_amount: 0.01, effective_buyer_paid_amount: 0.01,
      merchant_receivable_amount: 0.01, effective_merchant_receivable_amount: 0.01,
    }),
  ];
  const dates = ["2099-12-28", "2099-12-29", "2099-12-30"];
  const accountDays = dates.map((date, index) => ({
    ...emptyRow("ads_account_day"), ...common, date, ...metrics(index + 1),
  }));
  const products = [
    ["PRODUCT_SAMPLE_A", "示例·清风"],
    ["PRODUCT_SAMPLE_B", "示例·栖木"],
    ["PRODUCT_SAMPLE_C", "示例·澄野"],
  ].map(([product_id, product_name], index) => ({
    ...emptyRow("ads_product_period"),
    ...common,
    period_start: "2099-12-28",
    period_end: "2099-12-30",
    product_id,
    product_name,
    group_name: "示例·默认分组",
    promotion_name: `示例·${product_name}推广`,
    bid_method: "示例·固定方式",
    is_deleted: false,
    ...metrics(index + 1),
    direct_gmv: 0.012 * (index + 1),
    indirect_gmv: 0.008 * (index + 1),
    direct_orders: index + 1,
    indirect_orders: 0,
    inquiry_spend: 0,
    inquiries: 0,
    inquiry_cpa: 0,
    favorite_spend: 0,
    favorites: index + 1,
    favorite_cpa: 0,
    follow_spend: 0,
    follows: index + 1,
    follow_cpa: 0,
  }));
  return {
    ads_account_day: accountDays,
    ads_product_period: products,
    order_item: orders,
  };
}

export function writePddShareSamples(outputDir) {
  const absoluteOutput = assertSafeOutputDirectory(outputDir);
  return writeTablesInternal(buildPddShareSamples(), absoluteOutput);
}

function parsePeriodOption(value, label) {
  const match = /^(20\d{2}-\d{2}-\d{2}):(20\d{2}-\d{2}-\d{2})$/u.exec(value ?? "");
  if (!match) throw new Error(`${label} must use YYYY-MM-DD:YYYY-MM-DD`);
  parseDate(match[1], label);
  parseDate(match[2], label);
  return [match[1], match[2]];
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--validate-only" || argument === "--help") {
      options[argument.slice(2).replaceAll("-", "_")] = true;
      continue;
    }
    if (!argument.startsWith("--") || index + 1 >= args.length) {
      throw new Error(`invalid argument ${argument}`);
    }
    options[argument.slice(2).replaceAll("-", "_")] = args[index + 1];
    index += 1;
  }
  return options;
}

function usage() {
  return [
    "Validate without writing:",
    "  node apps/api/scripts/ecommerce-intake/pdd-standardize.mjs --input-dir <source> --account-alias <alias> --source-batch <batch> --validate-only",
    "Write three private standard tables outside the repository and source directory:",
    "  node apps/api/scripts/ecommerce-intake/pdd-standardize.mjs --input-dir <source> --account-alias <alias> --source-batch <batch> --output-dir <output>",
    "Choose a different report period when the exports are not the built-in acceptance fixture:",
    "  --ads-account-period YYYY-MM-DD:YYYY-MM-DD --ads-product-period YYYY-MM-DD:YYYY-MM-DD",
    "Write synthetic share samples only:",
    "  node apps/api/scripts/ecommerce-intake/pdd-standardize.mjs --share-sample-dir <output>",
  ].join("\n");
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    if (options.validate_only && options.share_sample_dir) {
      throw new Error("--validate-only cannot be combined with --share-sample-dir");
    }
    let result = null;
    const written = {};
    if (options.input_dir) {
      if (!options.account_alias) throw new Error("--account-alias is required with --input-dir");
      if (!options.source_batch) throw new Error("--source-batch is required with --input-dir");
      result = buildPddIntake({
        accountAlias: options.account_alias,
        accountDayPeriod: options.ads_account_period
          ? parsePeriodOption(options.ads_account_period, "--ads-account-period")
          : DEFAULT_ACCOUNT_DAY_PERIOD,
        inputDir: options.input_dir,
        productPeriod: options.ads_product_period
          ? parsePeriodOption(options.ads_product_period, "--ads-product-period")
          : DEFAULT_PRODUCT_PERIOD,
        sourceBatch: options.source_batch,
      });
      if (!options.validate_only && !options.output_dir) {
        throw new Error("use --validate-only or provide --output-dir");
      }
      if (!options.validate_only && options.output_dir) {
        written.privateTables = writePddTables(result, options.output_dir);
      }
    }
    if (options.share_sample_dir) {
      written.shareSamples = writePddShareSamples(options.share_sample_dir);
    }
    if (!result && !options.share_sample_dir) throw new Error("provide --input-dir or --share-sample-dir");
    console.log(JSON.stringify({
      ...(result ? result.summary : {}),
      ...(Object.keys(written).length > 0 ? { written } : {}),
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "PDD intake failed");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) main();
