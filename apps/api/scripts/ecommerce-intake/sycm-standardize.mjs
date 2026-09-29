import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..", "..", "..", "..");
const requireFromApi = createRequire(join(repositoryRoot, "apps", "api", "package.json"));
const XLSX = requireFromApi("xlsx");

export const OUTPUT_SCHEMAS = Object.freeze({
  trade_day: Object.freeze([
    "source_system",
    "source_batch",
    "source_account_alias",
    "source_exported_at",
    "period_start",
    "period_end",
    "period_granularity",
    "terminal_scope",
    "visitors",
    "visitors_change_rate",
    "ordering_buyers",
    "ordering_buyers_change_rate",
    "ordering_amount",
    "ordering_amount_change_rate",
    "paying_buyers",
    "paying_buyers_change_rate",
    "paid_amount",
    "paid_amount_change_rate",
    "avg_order_value",
    "avg_order_value_change_rate",
    "order_conversion_rate",
    "order_to_pay_conversion_rate",
    "payment_conversion_rate",
    "payment_conversion_rate_change_rate",
    "paid_suborders",
    "new_buyers",
    "returning_buyers",
  ]),
  terminal_day: Object.freeze([
    "source_system",
    "source_batch",
    "source_account_alias",
    "source_exported_at",
    "period_start",
    "period_end",
    "period_granularity",
    "terminal",
    "paid_amount",
    "paid_amount_share",
    "paid_product_count",
    "paying_buyers",
    "payment_conversion_rate",
  ]),
  price_band_day: Object.freeze([
    "source_system",
    "source_batch",
    "source_account_alias",
    "source_exported_at",
    "period_start",
    "period_end",
    "period_granularity",
    "terminal_scope",
    "price_band_id",
    "price_band_label",
    "paying_buyer_share",
    "paying_buyers",
    "paid_amount",
    "payment_conversion_rate",
  ]),
  category_month: Object.freeze([
    "source_system",
    "source_batch",
    "source_account_alias",
    "source_exported_at",
    "period_start",
    "period_end",
    "period_granularity",
    "period_month",
    "category_level",
    "category_id",
    "category_label",
    "terminal_scope",
    "level_1_category_id",
    "level_1_category_label",
    "leaf_category_id",
    "leaf_category_label",
    "paid_amount",
    "paid_amount_change_rate",
    "paid_amount_share",
    "paid_amount_share_change_rate",
    "paying_buyers",
    "paying_buyers_change_rate",
    "payment_conversion_rate",
    "payment_conversion_rate_change_rate",
    "visitors_change_rate",
  ]),
});

const OUTPUT_FILE_NAMES = Object.freeze({
  trade_day: "taobao_trade_day.csv",
  terminal_day: "taobao_terminal_day.csv",
  price_band_day: "taobao_price_band_day.csv",
  category_month: "taobao_category_month.csv",
});

const REQUIRED_OUTPUT_FIELDS = Object.freeze({
  trade_day: [
    "source_system", "source_account_alias", "source_batch", "period_start", "period_end",
    "period_granularity", "visitors", "paid_amount",
  ],
  terminal_day: [
    "source_system", "source_account_alias", "source_batch", "period_start", "period_end",
    "period_granularity", "terminal", "paid_amount",
  ],
  price_band_day: [
    "source_system", "source_account_alias", "source_batch", "period_start", "period_end",
    "period_granularity", "price_band_id", "price_band_label", "paid_amount",
  ],
  category_month: [
    "source_system", "source_account_alias", "source_batch", "period_start", "period_end",
    "period_granularity", "category_level", "category_id", "category_label", "paid_amount",
  ],
});

const NULL_TEXT = new Set(["", "-", "--", "—", "n/a", "na", "null", "暂无", "无"]);

const SHEET_REQUIREMENTS = Object.freeze({
  交易总览: [
    "日期范围",
    "终端",
    "导出时间",
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
  ],
  终端构成: [
    "日期范围",
    "导出时间",
    "终端",
    "支付金额",
    "支付金额占比",
    "支付商品数",
    "支付买家数",
    "支付转化率",
  ],
  价格带构成: [
    "日期范围",
    "终端",
    "导出时间",
    "价格带ID",
    "价格带",
    "支付买家占比",
    "支付买家数",
    "支付金额",
    "支付转化率",
  ],
  一级类目: [
    "日期范围",
    "终端",
    "导出时间",
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
  ],
  叶子类目: [
    "日期范围",
    "终端",
    "导出时间",
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
  ],
});

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function nullableText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (NULL_TEXT.has(text.toLowerCase())) return null;
  return text;
}

function nullableNumber(value, fieldName) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new Error(`${fieldName} contains a non-finite number`);
  }

  const original = nullableText(value);
  if (original === null) return null;
  let text = original
    .replaceAll(",", "")
    .replaceAll("￥", "")
    .replaceAll("¥", "")
    .replaceAll(" ", "");
  let negative = false;
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
    throw new Error(`${fieldName} contains a non-numeric value`);
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) throw new Error(`${fieldName} contains a non-finite number`);
  return negative ? -parsed : parsed;
}

function nullableRate(value, fieldName) {
  const text = nullableText(value);
  if (text === null) return null;
  if (typeof value === "number") return nullableNumber(value, fieldName);
  const isPercent = text.endsWith("%");
  const parsed = nullableNumber(isPercent ? text.slice(0, -1) : text, fieldName);
  return parsed === null ? null : isPercent ? parsed / 100 : parsed;
}

function dateParts(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return [[value.getFullYear(), value.getMonth() + 1, value.getDate()]];
  }
  const text = nullableText(value);
  if (text === null) return [];
  const matches = [];
  const pattern = /(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/g;
  for (const match of text.matchAll(pattern)) {
    matches.push([Number(match[1]), Number(match[2]), Number(match[3])]);
  }
  return matches;
}

function isoDate(parts, fieldName) {
  const [year, month, day] = parts;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() + 1 !== month
    || candidate.getUTCDate() !== day
  ) {
    throw new Error(`${fieldName} contains an invalid date`);
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parsePeriod(value, expectedGranularity) {
  const parts = dateParts(value);
  if (parts.length === 0) throw new Error("日期范围 is missing or invalid");
  const periodStart = isoDate(parts[0], "日期范围");
  const periodEnd = isoDate(parts.at(-1), "日期范围");
  if (periodEnd < periodStart) throw new Error("日期范围 ends before it starts");
  if (expectedGranularity === "day" && periodStart !== periodEnd) {
    throw new Error("daily input contains a multi-day 日期范围");
  }
  if (expectedGranularity === "month" && periodStart.slice(0, 7) !== periodEnd.slice(0, 7)) {
    throw new Error("monthly category input crosses calendar months");
  }
  return { periodStart, periodEnd };
}

function parseExportedAt(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const date = isoDate(
      [value.getFullYear(), value.getMonth() + 1, value.getDate()],
      "导出时间",
    );
    const time = [value.getHours(), value.getMinutes(), value.getSeconds()]
      .map((part) => String(part).padStart(2, "0"))
      .join(":");
    return `${date}T${time}`;
  }
  const text = nullableText(value);
  if (text === null) return null;
  const match = text.match(
    /(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (!match) throw new Error("导出时间 is invalid");
  const date = isoDate([Number(match[1]), Number(match[2]), Number(match[3])], "导出时间");
  if (match[4] === undefined) return date;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) throw new Error("导出时间 is invalid");
  return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function nonEmptyRow(row) {
  return row.some((value) => nullableText(value) !== null);
}

function sheetObjects(workbook, sheetName) {
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) return [];
  const matrix = XLSX.utils.sheet_to_json(worksheet, {
    blankrows: false,
    defval: null,
    header: 1,
    raw: true,
  });
  if (matrix.length === 0) return [];
  const headers = matrix[0].map((value) => nullableText(value));
  const seen = new Set();
  for (const header of headers) {
    if (header === null) continue;
    if (seen.has(header)) throw new Error(`${sheetName} contains a duplicate header`);
    seen.add(header);
  }
  for (const required of SHEET_REQUIREMENTS[sheetName]) {
    if (!seen.has(required)) throw new Error(`${sheetName} is missing required header: ${required}`);
  }
  return matrix.slice(1).filter(nonEmptyRow).map((values) => {
    const row = {};
    headers.forEach((header, index) => {
      if (header !== null) row[header] = values[index] ?? null;
    });
    return row;
  });
}

function commonFields(sourceBatch, sourceAccountAlias, row, granularity) {
  const { periodStart, periodEnd } = parsePeriod(row["日期范围"], granularity);
  return {
    source_system: "sycm",
    source_batch: sourceBatch,
    source_account_alias: sourceAccountAlias,
    source_exported_at: parseExportedAt(row["导出时间"]),
    period_start: periodStart,
    period_end: periodEnd,
    period_granularity: granularity,
  };
}

function mapTradeRow(sourceBatch, sourceAccountAlias, row) {
  return {
    ...commonFields(sourceBatch, sourceAccountAlias, row, "day"),
    terminal_scope: nullableText(row["终端"]),
    visitors: nullableNumber(row["访客数"], "访客数"),
    visitors_change_rate: nullableRate(row["访客数较上一周期"], "访客数较上一周期"),
    ordering_buyers: nullableNumber(row["下单买家数"], "下单买家数"),
    ordering_buyers_change_rate: nullableRate(row["下单买家数较上一周期"], "下单买家数较上一周期"),
    ordering_amount: nullableNumber(row["下单金额"], "下单金额"),
    ordering_amount_change_rate: nullableRate(row["下单金额较上一周期"], "下单金额较上一周期"),
    paying_buyers: nullableNumber(row["支付买家数"], "支付买家数"),
    paying_buyers_change_rate: nullableRate(row["支付买家数较上一周期"], "支付买家数较上一周期"),
    paid_amount: nullableNumber(row["支付金额"], "支付金额"),
    paid_amount_change_rate: nullableRate(row["支付金额较上一周期"], "支付金额较上一周期"),
    avg_order_value: nullableNumber(row["客单价"], "客单价"),
    avg_order_value_change_rate: nullableRate(row["客单价较上一周期"], "客单价较上一周期"),
    order_conversion_rate: nullableRate(row["下单转化率"], "下单转化率"),
    order_to_pay_conversion_rate: nullableRate(row["下单-支付转化率"], "下单-支付转化率"),
    payment_conversion_rate: nullableRate(row["支付转化率"], "支付转化率"),
    payment_conversion_rate_change_rate: nullableRate(row["支付转化率较上一周期"], "支付转化率较上一周期"),
    paid_suborders: nullableNumber(row["支付子订单数"], "支付子订单数"),
    new_buyers: nullableNumber(row["新买家数"], "新买家数"),
    returning_buyers: nullableNumber(row["老买家数"], "老买家数"),
  };
}

function mapTerminalRow(sourceBatch, sourceAccountAlias, row) {
  return {
    ...commonFields(sourceBatch, sourceAccountAlias, row, "day"),
    terminal: nullableText(row["终端"]),
    paid_amount: nullableNumber(row["支付金额"], "支付金额"),
    paid_amount_share: nullableRate(row["支付金额占比"], "支付金额占比"),
    paid_product_count: nullableNumber(row["支付商品数"], "支付商品数"),
    paying_buyers: nullableNumber(row["支付买家数"], "支付买家数"),
    payment_conversion_rate: nullableRate(row["支付转化率"], "支付转化率"),
  };
}

function mapPriceBandRow(sourceBatch, sourceAccountAlias, row) {
  return {
    ...commonFields(sourceBatch, sourceAccountAlias, row, "day"),
    terminal_scope: nullableText(row["终端"]),
    price_band_id: nullableText(row["价格带ID"]),
    price_band_label: nullableText(row["价格带"]),
    paying_buyer_share: nullableRate(row["支付买家占比"], "支付买家占比"),
    paying_buyers: nullableNumber(row["支付买家数"], "支付买家数"),
    paid_amount: nullableNumber(row["支付金额"], "支付金额"),
    payment_conversion_rate: nullableRate(row["支付转化率"], "支付转化率"),
  };
}

function mapCategoryRow(sourceBatch, sourceAccountAlias, row, categoryLevel) {
  const common = commonFields(sourceBatch, sourceAccountAlias, row, "month");
  const levelOneId = nullableText(row["一级类目ID"]);
  const levelOneLabel = nullableText(row["一级类目"]);
  const leafId = categoryLevel === "leaf" ? nullableText(row["叶子类目ID"]) : null;
  const leafLabel = categoryLevel === "leaf" ? nullableText(row["叶子类目"]) : null;
  return {
    ...common,
    period_month: common.period_start.slice(0, 7),
    category_level: categoryLevel,
    category_id: categoryLevel === "leaf" ? leafId : levelOneId,
    category_label: categoryLevel === "leaf" ? leafLabel : levelOneLabel,
    terminal_scope: nullableText(row["终端"]),
    level_1_category_id: levelOneId,
    level_1_category_label: levelOneLabel,
    leaf_category_id: leafId,
    leaf_category_label: leafLabel,
    paid_amount: nullableNumber(row["支付金额"], "支付金额"),
    paid_amount_change_rate: nullableRate(row["支付金额较上一周期"], "支付金额较上一周期"),
    paid_amount_share: nullableRate(row["支付金额占比"], "支付金额占比"),
    paid_amount_share_change_rate: nullableRate(row["支付金额占比较上一周期"], "支付金额占比较上一周期"),
    paying_buyers: nullableNumber(row["支付买家数"], "支付买家数"),
    paying_buyers_change_rate: nullableRate(row["支付买家数较上一周期"], "支付买家数较上一周期"),
    payment_conversion_rate: nullableRate(row["支付转化率"], "支付转化率"),
    payment_conversion_rate_change_rate: nullableRate(row["支付转化率较上一周期"], "支付转化率较上一周期"),
    visitors_change_rate: nullableRate(row["访客数较上一周期"], "访客数较上一周期"),
  };
}

function discoverXlsxFiles(inputRoot) {
  const files = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => utf8Compare(left.name, right.name));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".xlsx")) files.push(absolutePath);
    }
  };
  visit(inputRoot);
  return files;
}

function compareRows(columns) {
  return (left, right) => {
    for (const column of columns) {
      const leftText = left[column] === null ? "" : String(left[column]);
      const rightText = right[column] === null ? "" : String(right[column]);
      const compared = utf8Compare(leftText, rightText);
      if (compared !== 0) return compared;
    }
    return 0;
  };
}

function assertUniqueRows(tableName, rows, keyColumns) {
  const seen = new Set();
  for (const row of rows) {
    const key = keyColumns.map((column) => row[column] ?? "<null>").join("\u0000");
    if (seen.has(key)) throw new Error(`${tableName} contains a duplicate logical row`);
    seen.add(key);
  }
}

function readWorkbook(filePath) {
  return XLSX.read(readFileSync(filePath), {
    cellDates: true,
    cellFormula: false,
    cellHTML: false,
    cellNF: false,
    cellStyles: false,
    type: "buffer",
  });
}

function tableCounts(tables) {
  return Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length]));
}

export function standardizeSycmDirectory({ inputRoot, sourceBatch, sourceAccountAlias }) {
  const absoluteInputRoot = resolve(inputRoot);
  if (!existsSync(absoluteInputRoot) || !statSync(absoluteInputRoot).isDirectory()) {
    throw new Error("input root is not an existing directory");
  }
  const normalizedBatch = nullableText(sourceBatch);
  if (normalizedBatch === null) throw new Error("source batch is required");
  const normalizedAccountAlias = nullableText(sourceAccountAlias);
  if (
    normalizedAccountAlias === null
    || !/^[a-z][a-z0-9_-]{0,63}$/.test(normalizedAccountAlias)
  ) {
    throw new Error("source account alias must be an explicit safe opaque alias");
  }

  const files = discoverXlsxFiles(absoluteInputRoot);
  if (files.length === 0) throw new Error("input root contains no .xlsx workbooks");

  const tables = {
    trade_day: [],
    terminal_day: [],
    price_band_day: [],
    category_month: [],
  };
  const sourceWorkbooks = {
    trade_day: 0,
    terminal_day: 0,
    price_band_day: 0,
    category_month: 0,
    skipped_brand: 0,
  };

  for (const filePath of files) {
    const workbook = readWorkbook(filePath);
    const recognizedSheets = workbook.SheetNames.filter((name) =>
      Object.prototype.hasOwnProperty.call(SHEET_REQUIREMENTS, name)
      || name === "品牌构成"
    );
    if (recognizedSheets.length !== workbook.SheetNames.length) {
      throw new Error("input contains an unsupported non-empty worksheet");
    }

    if (workbook.SheetNames.includes("交易总览")) {
      sourceWorkbooks.trade_day += 1;
      tables.trade_day.push(
        ...sheetObjects(workbook, "交易总览").map((row) =>
          mapTradeRow(normalizedBatch, normalizedAccountAlias, row)
        ),
      );
    }
    if (workbook.SheetNames.includes("终端构成")) {
      sourceWorkbooks.terminal_day += 1;
      tables.terminal_day.push(
        ...sheetObjects(workbook, "终端构成").map((row) =>
          mapTerminalRow(normalizedBatch, normalizedAccountAlias, row)
        ),
      );
    }
    if (workbook.SheetNames.includes("价格带构成")) {
      sourceWorkbooks.price_band_day += 1;
      tables.price_band_day.push(
        ...sheetObjects(workbook, "价格带构成").map((row) =>
          mapPriceBandRow(normalizedBatch, normalizedAccountAlias, row)
        ),
      );
    }
    const hasLevelOne = workbook.SheetNames.includes("一级类目");
    const hasLeaf = workbook.SheetNames.includes("叶子类目");
    if (hasLevelOne || hasLeaf) {
      if (!hasLevelOne || !hasLeaf) throw new Error("category workbook must contain both category sheets");
      sourceWorkbooks.category_month += 1;
      tables.category_month.push(
        ...sheetObjects(workbook, "一级类目").map((row) =>
          mapCategoryRow(normalizedBatch, normalizedAccountAlias, row, "level_1")
        ),
        ...sheetObjects(workbook, "叶子类目").map((row) =>
          mapCategoryRow(normalizedBatch, normalizedAccountAlias, row, "leaf")
        ),
      );
    }
    if (workbook.SheetNames.length === 1 && workbook.SheetNames[0] === "品牌构成") {
      sourceWorkbooks.skipped_brand += 1;
    }
  }

  for (const [tableName, rows] of Object.entries(tables)) {
    if (rows.length === 0) throw new Error(`${tableName} has no output rows`);
  }

  tables.trade_day.sort(compareRows(["period_start"]));
  tables.terminal_day.sort(compareRows(["period_start", "terminal"]));
  tables.price_band_day.sort(compareRows([
    "period_start",
    "terminal_scope",
    "price_band_id",
    "price_band_label",
  ]));
  tables.category_month.sort((left, right) => {
    const periodComparison = utf8Compare(left.period_start, right.period_start);
    if (periodComparison !== 0) return periodComparison;
    const levelComparison = (left.category_level === "level_1" ? 0 : 1)
      - (right.category_level === "level_1" ? 0 : 1);
    if (levelComparison !== 0) return levelComparison;
    return compareRows(["level_1_category_id", "leaf_category_id"])(left, right);
  });

  assertUniqueRows("trade_day", tables.trade_day, ["period_start"]);
  assertUniqueRows("terminal_day", tables.terminal_day, ["period_start", "terminal"]);
  assertUniqueRows("price_band_day", tables.price_band_day, [
    "period_start",
    "terminal_scope",
    "price_band_id",
  ]);
  assertUniqueRows("category_month", tables.category_month, [
    "period_start",
    "period_end",
    "category_level",
    "level_1_category_id",
    "leaf_category_id",
  ]);

  return {
    inputRoot: absoluteInputRoot,
    inputWorkbookCount: files.length,
    sourceWorkbooks,
    tables,
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot serialize a non-finite number");
    return String(value);
  }
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function serializeStandardTable(tableName, rows) {
  const headers = OUTPUT_SCHEMAS[tableName];
  if (!headers) throw new Error(`unknown standard table: ${tableName}`);
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(headers.map((header) => csvCell(row[header])).join(","));
  return `\uFEFF${lines.join("\n")}\n`;
}

function isSameOrWithin(candidate, parent) {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function writeStandardTables({ inputRoot, outputRoot, tables }) {
  const absoluteInputRoot = resolve(inputRoot);
  const absoluteOutputRoot = resolve(outputRoot);
  if (isSameOrWithin(absoluteOutputRoot, absoluteInputRoot)) {
    throw new Error("output root must be outside the source directory");
  }
  assertStandardTablesReady(tables);
  mkdirSync(absoluteOutputRoot, { recursive: true });
  const writtenFiles = {};
  for (const tableName of Object.keys(OUTPUT_SCHEMAS)) {
    const finalPath = join(absoluteOutputRoot, OUTPUT_FILE_NAMES[tableName]);
    const temporaryPath = `${finalPath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, serializeStandardTable(tableName, tables[tableName]), "utf8");
    if (existsSync(finalPath)) rmSync(finalPath);
    renameSync(temporaryPath, finalPath);
    writtenFiles[tableName] = finalPath;
  }
  return writtenFiles;
}

function nearlyEqual(left, right, absoluteTolerance = 0.02, relativeTolerance = 1e-8) {
  if (left === null || right === null) return false;
  return Math.abs(left - right) <= Math.max(absoluteTolerance, Math.abs(left) * relativeTolerance);
}

function compareAmountPartitions(tradeRows, detailRows) {
  const tradeByDate = new Map(tradeRows.map((row) => [row.period_start, row.paid_amount]));
  const detailByDate = new Map();
  for (const row of detailRows) {
    const current = detailByDate.get(row.period_start) ?? 0;
    detailByDate.set(row.period_start, row.paid_amount === null ? current : current + row.paid_amount);
  }
  let checked = 0;
  let matched = 0;
  const periods = new Set([...tradeByDate.keys(), ...detailByDate.keys()]);
  for (const period of periods) {
    checked += 1;
    if (!tradeByDate.has(period) || !detailByDate.has(period)) continue;
    const paidAmount = tradeByDate.get(period);
    if (paidAmount !== null && nearlyEqual(paidAmount, detailByDate.get(period))) matched += 1;
  }
  return { checked, matched, mismatched: checked - matched };
}

function compareCategoryMonths(tradeRows, categoryRows) {
  const leafByPeriod = new Map();
  for (const row of categoryRows) {
    if (row.category_level !== "leaf") continue;
    const key = `${row.period_start}\u0000${row.period_end}`;
    const current = leafByPeriod.get(key) ?? 0;
    leafByPeriod.set(key, row.paid_amount === null ? current : current + row.paid_amount);
  }
  let checked = 0;
  let matched = 0;
  for (const [key, categoryAmount] of leafByPeriod) {
    const [periodStart, periodEnd] = key.split("\u0000");
    const dailyRows = tradeRows.filter((row) =>
      row.period_start >= periodStart && row.period_start <= periodEnd
    );
    checked += 1;
    if (dailyRows.length === 0 || dailyRows.some((row) => row.paid_amount === null)) continue;
    const tradeAmount = dailyRows.reduce((sum, row) => sum + row.paid_amount, 0);
    if (nearlyEqual(tradeAmount, categoryAmount)) matched += 1;
  }
  return { checked, matched, mismatched: checked - matched };
}

function checkTradeIdentity(rows, predicate) {
  let checked = 0;
  let matched = 0;
  for (const row of rows) {
    const result = predicate(row);
    if (result === null) continue;
    checked += 1;
    if (result) matched += 1;
  }
  return { checked, matched, mismatched: checked - matched };
}

export function validateStandardTables(tables) {
  const requiredNulls = {};
  for (const [tableName, fields] of Object.entries(REQUIRED_OUTPUT_FIELDS)) {
    requiredNulls[tableName] = Object.fromEntries(fields.map((field) => [
      field,
      tables[tableName].filter((row) => row[field] === null || row[field] === undefined || row[field] === "").length,
    ]));
  }
  return {
    outputRows: tableCounts(tables),
    requiredNulls,
    reconciliation: {
      price_band_paid_amount: compareAmountPartitions(tables.trade_day, tables.price_band_day),
      terminal_paid_amount: compareAmountPartitions(tables.trade_day, tables.terminal_day),
      leaf_category_paid_amount: compareCategoryMonths(tables.trade_day, tables.category_month),
      trade_avg_order_value: checkTradeIdentity(tables.trade_day, (row) => {
        if (row.paid_amount === null || row.paying_buyers === null || row.avg_order_value === null) return null;
        if (row.paying_buyers === 0) return row.paid_amount === 0 && row.avg_order_value === 0;
        return nearlyEqual(row.paid_amount / row.paying_buyers, row.avg_order_value);
      }),
      trade_buyer_split: checkTradeIdentity(tables.trade_day, (row) => {
        if (row.new_buyers === null || row.returning_buyers === null || row.paying_buyers === null) return null;
        return nearlyEqual(row.new_buyers + row.returning_buyers, row.paying_buyers, 0.000001, 0);
      }),
      trade_payment_conversion: checkTradeIdentity(tables.trade_day, (row) => {
        if (row.paying_buyers === null || row.visitors === null || row.payment_conversion_rate === null) return null;
        if (row.visitors === 0) return row.paying_buyers === 0 && row.payment_conversion_rate === 0;
        return nearlyEqual(row.paying_buyers / row.visitors, row.payment_conversion_rate, 0.00011, 0);
      }),
    },
  };
}

export function assertStandardTablesReady(tables) {
  const validation = validateStandardTables(tables);
  const problems = [];
  for (const [tableName, fields] of Object.entries(validation.requiredNulls)) {
    for (const [field, count] of Object.entries(fields)) {
      if (count > 0) problems.push(`${tableName}.${field} has ${count} blank required value(s)`);
    }
  }
  for (const [name, check] of Object.entries(validation.reconciliation)) {
    if (check.mismatched > 0) problems.push(`${name} has ${check.mismatched} reconciliation mismatch(es)`);
  }
  if (problems.length > 0) throw new Error(`standard table quality check failed: ${problems.join("; ")}`);
  return validation;
}

function usage() {
  return [
    "Usage:",
    "  node apps/api/scripts/ecommerce-intake/sycm-standardize.mjs \\",
    "    --input <extracted-directory> \\",
    "    --output <output-directory> \\",
    "    --source-batch <stable-batch-label> \\",
    "    --source-account-alias <safe-opaque-alias>",
    "",
    "The source directory is read only. Four UTF-8 CSV tables are written outside it.",
  ].join("\n");
}

function cliArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (!["--input", "--output", "--source-batch", "--source-account-alias"].includes(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    parsed[argument.slice(2)] = value;
    index += 1;
  }
  if (!parsed.input || !parsed.output || !parsed["source-batch"] || !parsed["source-account-alias"]) {
    throw new Error("--input, --output, --source-batch and --source-account-alias are required");
  }
  return {
    inputRoot: parsed.input,
    outputRoot: parsed.output,
    sourceBatch: parsed["source-batch"],
    sourceAccountAlias: parsed["source-account-alias"],
  };
}

export function runCli(argv) {
  const options = cliArguments(argv);
  if (options.help) {
    console.log(usage());
    return null;
  }
  const standardized = standardizeSycmDirectory(options);
  const validation = assertStandardTablesReady(standardized.tables);
  const writtenFiles = writeStandardTables({
    inputRoot: standardized.inputRoot,
    outputRoot: options.outputRoot,
    tables: standardized.tables,
  });
  const summary = {
    inputWorkbooks: standardized.inputWorkbookCount,
    sourceWorkbooks: standardized.sourceWorkbooks,
    outputRows: validation.outputRows,
    reconciliation: validation.reconciliation,
    outputFiles: Object.fromEntries(
      Object.entries(writtenFiles).map(([name, filePath]) => [name, filePath.split(/[\\/]/).at(-1)]),
    ),
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "SYCM standardization failed");
    process.exitCode = 1;
  }
}
