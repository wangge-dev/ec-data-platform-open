import type { ModuleDef } from "../modules/schema.js";
import {
  calculateFrontProfitDerivedValues,
  FRONT_PROFIT_INTEGER_FIELDS,
  FRONT_PROFIT_MONEY_INPUT_FIELDS,
  FRONT_PROFIT_MONEY_TOLERANCE,
  FRONT_PROFIT_NUMERIC_FIELDS,
  FRONT_PROFIT_RATIO_TOLERANCE,
  type FrontProfitFormulaInputField,
} from "./front-profit-formula.js";

export const FRONT_PROFIT_STANDARD_SCHEMA_VERSION = "front-profit-standard/v1" as const;

export const FRONT_PROFIT_STANDARD_HEADERS = [
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
] as const;

/**
 * The accounting contract is bound to the module's complete source-column
 * definition, not to a mutable display name or generated module code.  The
 * explicit dataContract flag is persisted for newly-created modules; the
 * column check keeps the already-created internal module protected as well.
 */
export function moduleRequiresFrontProfitStandard(
  module: Pick<ModuleDef, "columns" | "dataContract">,
): boolean {
  const sourceHeaders = new Set(moduleSourceHeaders(module));
  if (module.dataContract === FRONT_PROFIT_STANDARD_SCHEMA_VERSION) return true;
  return FRONT_PROFIT_STANDARD_HEADERS.every((header) => sourceHeaders.has(header));
}

function moduleSourceHeaders(
  module: Pick<ModuleDef, "columns">,
): string[] {
  return module.columns.flatMap((column) =>
    Array.isArray(column.source)
      ? column.source
      : typeof column.source === "string"
        ? [column.source]
        : [],
  );
}

export function isFrontProfitModuleContractValid(
  module: Pick<ModuleDef, "columns" | "dataContract">,
): boolean {
  if (!moduleRequiresFrontProfitStandard(module)) return true;
  const sourceHeaders = moduleSourceHeaders(module);
  return sourceHeaders.length === FRONT_PROFIT_STANDARD_HEADERS.length
    && new Set(sourceHeaders).size === sourceHeaders.length
    && FRONT_PROFIT_STANDARD_HEADERS.every((header) => sourceHeaders.includes(header));
}

export function isValidatedFrontProfitSourceConfig(config: unknown): boolean {
  if (!config || typeof config !== "object") return false;
  const source = config as Record<string, unknown>;
  const summary = source.frontProfitValidation;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return false;
  const validation = summary as Record<string, unknown>;
  if (
    validation.schemaVersion !== FRONT_PROFIT_STANDARD_SCHEMA_VERSION
    || !Number.isSafeInteger(validation.businessRowCount)
    || Number(validation.businessRowCount) <= 0
    || !Number.isSafeInteger(validation.warningCount)
    || Number(validation.warningCount) < 0
    || !Array.isArray(validation.warningCodes)
    || validation.warningCodes.some((code) => ![
      "NEGATIVE_QUANTITY",
      "NEGATIVE_VALUE",
      "PROMOTION_ORPHAN",
    ].includes(String(code)))
    || (Number(validation.warningCount) === 0) !== (validation.warningCodes.length === 0)
    || Object.keys(validation).sort().join("\u001f")
      !== ["businessRowCount", "schemaVersion", "warningCodes", "warningCount"].sort().join("\u001f")
    || source.rowCount !== validation.businessRowCount
    || !Array.isArray(source.columns)
  ) {
    return false;
  }
  const rawHeaders = source.columns.map((column) =>
    column && typeof column === "object" ? (column as Record<string, unknown>).raw : null,
  );
  return rawHeaders.length === FRONT_PROFIT_STANDARD_HEADERS.length
    && rawHeaders.every((header) => typeof header === "string" && header === header.trim())
    && new Set(rawHeaders).size === rawHeaders.length
    && FRONT_PROFIT_STANDARD_HEADERS.every((header) => rawHeaders.includes(header));
}

export class FrontProfitModuleContractDowngradeError extends Error {
  constructor() {
    super("前台利润模块的数据合同不能被移除或降级");
    this.name = "FrontProfitModuleContractDowngradeError";
  }
}

export class FrontProfitModuleContractInvalidError extends Error {
  constructor() {
    super("前台利润模块必须且只能完整映射 28 个标准字段，不能缺失、重复或改写来源字段");
    this.name = "FrontProfitModuleContractInvalidError";
  }
}

export function assertFrontProfitModuleContractValid(
  module: Pick<ModuleDef, "columns" | "dataContract">,
): void {
  if (!isFrontProfitModuleContractValid(module)) {
    throw new FrontProfitModuleContractInvalidError();
  }
}

export function assertFrontProfitModuleContractPreserved(
  current: Pick<ModuleDef, "columns" | "dataContract">,
  next: Pick<ModuleDef, "columns" | "dataContract">,
): void {
  assertFrontProfitModuleContractValid(next);
  if (
    moduleRequiresFrontProfitStandard(current)
    && !moduleRequiresFrontProfitStandard(next)
  ) {
    throw new FrontProfitModuleContractDowngradeError();
  }
}

export type FrontProfitValidationIssue = {
  code: string;
  rowNumber?: number;
  field?: string;
};

export type FrontProfitValidationWarning = FrontProfitValidationIssue;

export type FrontProfitValidationResult = {
  businessRowCount: number;
  warnings: FrontProfitValidationWarning[];
  identities: Array<{
    recordId: string;
    aggregationKey: string;
    rowNumber: number;
  }>;
};

export class FrontProfitValidationError extends Error {
  readonly code = "FRONT_PROFIT_STANDARD_INVALID";

  constructor(readonly issues: FrontProfitValidationIssue[]) {
    super(`前台利润标准表校验失败（${issues.length} 个问题）`);
    this.name = "FrontProfitValidationError";
  }
}

const MARKER_HEADERS = ["record_id", "真实营业额", "前台利润", "付费占比", "推广费"];
const REQUIRED_TEXT_FIELDS = ["平台", "业务模式", "店铺", "运营"] as const;
const INTEGER_FIELDS = FRONT_PROFIT_INTEGER_FIELDS;
const MONEY_INPUT_FIELDS = FRONT_PROFIT_MONEY_INPUT_FIELDS;
const NUMERIC_FIELDS = FRONT_PROFIT_NUMERIC_FIELDS;
const ALLOWED_BUSINESS_MODES = new Set(["自营", "POP", "其他"]);
const TEMPLATE_RECORD_ID = "TEMPLATE_EXAMPLE_20991231";
const PREPARATION_WORKBOOK_PHRASE = "前台利润数据准备与映射模板";

const normalizedHeader = (value: unknown): string => String(value ?? "").trim();
const isBlank = (value: unknown): boolean => value == null || String(value).trim() === "";

export function isFrontProfitStandardSheet(
  headers: readonly unknown[],
  fileName: string,
): boolean {
  const normalized = headers.map(normalizedHeader);
  const normalizedFileName = fileName.normalize("NFC").toLowerCase();
  const markerCount = MARKER_HEADERS.filter((header) => normalized.includes(header)).length;
  const recognizedFileName = [
    "前台利润单表上传模板",
    "前台利润标准表",
    "前台利润标准数据",
    "front-profit-standard",
  ].some((phrase) => normalizedFileName.includes(phrase));
  return recognizedFileName || markerCount >= 3;
}

export function isFrontProfitPreparationWorkbook(fileName: string): boolean {
  return fileName.normalize("NFC").includes(PREPARATION_WORKBOOK_PHRASE);
}

export function frontProfitAggregationKey(values: {
  date: string;
  platform: string;
  businessMode: string;
  shop: string;
  operator: string;
}): string {
  return [
    values.date,
    values.platform.trim(),
    values.businessMode.trim(),
    values.shop.trim(),
    values.operator.trim(),
  ].join("\u001f");
}

function parseStrictNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeFrontProfitDate(value: unknown): string | null {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    const year = value.getFullYear();
    const month = value.getMonth() + 1;
    const day = value.getDate();
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(year!, month! - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) {
    return null;
  }
  return value;
}

function rowRecord(
  headers: readonly string[],
  row: readonly unknown[],
): Record<string, unknown> {
  return Object.fromEntries(headers.map((header, index) => [header, row[index]]));
}

function differenceExceeds(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) > tolerance;
}

export function validateFrontProfitStandardSheet(
  rawHeaders: readonly unknown[],
  dataRows: readonly (readonly unknown[])[],
  firstDataRowNumber = 2,
): FrontProfitValidationResult {
  const headers = rawHeaders.map(normalizedHeader);
  const hasNonCanonicalHeader = rawHeaders.some(
    (header, index) => typeof header !== "string" || header !== headers[index],
  );
  const issues: FrontProfitValidationIssue[] = [];
  const headerCounts = new Map<string, number>();
  for (const header of headers) headerCounts.set(header, (headerCounts.get(header) ?? 0) + 1);
  const expected = new Set<string>(FRONT_PROFIT_STANDARD_HEADERS);
  const missing = FRONT_PROFIT_STANDARD_HEADERS.filter((header) => !headerCounts.has(header));
  const unexpected = headers.filter((header) => !expected.has(header));
  const duplicates = [...headerCounts.entries()].filter(([, count]) => count > 1);
  if (
    hasNonCanonicalHeader
    || headers.length !== FRONT_PROFIT_STANDARD_HEADERS.length
    || missing.length > 0
    || unexpected.length > 0
    || duplicates.length > 0
  ) {
    issues.push({ code: "HEADER_CONTRACT" });
    throw new FrontProfitValidationError(issues);
  }
  if (dataRows.length === 0) {
    throw new FrontProfitValidationError([{ code: "NO_DATA_ROWS" }]);
  }

  const records = dataRows.map((row) => rowRecord(headers, row));
  const exampleRows = records
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => (
      typeof row.record_id === "string" && row.record_id.trim() === TEMPLATE_RECORD_ID
    ) || (
      typeof row.数据状态 === "string" && row.数据状态.includes("示例行")
    ));
  if (exampleRows.length > 0) {
    throw new FrontProfitValidationError(exampleRows.map(({ index }) => ({
      code: "TEMPLATE_EXAMPLE_NOT_REMOVED",
      rowNumber: firstDataRowNumber + index,
    })));
  }

  const warnings: FrontProfitValidationWarning[] = [];
  const identities: FrontProfitValidationResult["identities"] = [];
  const recordIds = new Map<string, number>();
  const aggregationKeys = new Map<string, number>();

  for (const [index, record] of records.entries()) {
    const rowNumber = firstDataRowNumber + index;
    const rawRow = dataRows[index]!;
    if (rawRow.every(isBlank)) {
      issues.push({ code: "EMPTY_ROW", rowNumber });
      continue;
    }

    const date = normalizeFrontProfitDate(record.日期);
    if (!date) issues.push({ code: "INVALID_DATE", rowNumber, field: "日期" });

    const requiredText = new Map<string, string>();
    for (const field of REQUIRED_TEXT_FIELDS) {
      const value = record[field];
      if (typeof value !== "string" || value.trim() === "") {
        issues.push({ code: "REQUIRED_TEXT", rowNumber, field });
      } else {
        requiredText.set(field, value.trim());
      }
    }
    const mode = requiredText.get("业务模式");
    if (mode && !ALLOWED_BUSINESS_MODES.has(mode)) {
      issues.push({ code: "INVALID_BUSINESS_MODE", rowNumber, field: "业务模式" });
    }

    const recordIdValue = record.record_id;
    let recordId: string | null = null;
    if (
      typeof recordIdValue !== "string"
      || recordIdValue.trim() === ""
      || /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d+$/.test(recordIdValue.trim())
    ) {
      issues.push({ code: "INVALID_RECORD_ID", rowNumber, field: "record_id" });
    } else {
      recordId = recordIdValue.trim();
      if (recordIds.has(recordId)) {
        issues.push({ code: "DUPLICATE_RECORD_ID", rowNumber, field: "record_id" });
      } else {
        recordIds.set(recordId, rowNumber);
      }
    }

    let aggregationKey: string | null = null;
    if (date && REQUIRED_TEXT_FIELDS.every((field) => requiredText.has(field))) {
      aggregationKey = frontProfitAggregationKey({
        date,
        platform: requiredText.get("平台")!,
        businessMode: requiredText.get("业务模式")!,
        shop: requiredText.get("店铺")!,
        operator: requiredText.get("运营")!,
      });
      if (aggregationKeys.has(aggregationKey)) {
        issues.push({ code: "DUPLICATE_AGGREGATION_KEY", rowNumber });
      } else {
        aggregationKeys.set(aggregationKey, rowNumber);
      }
    }
    if (recordId && aggregationKey) identities.push({ recordId, aggregationKey, rowNumber });

    const numbers = new Map<string, number>();
    for (const field of NUMERIC_FIELDS) {
      const parsed = parseStrictNumber(record[field]);
      if (parsed == null) {
        issues.push({ code: "INVALID_NUMBER", rowNumber, field });
      } else {
        numbers.set(field, parsed);
      }
    }
    for (const field of INTEGER_FIELDS) {
      const value = numbers.get(field);
      if (value != null && !Number.isInteger(value)) {
        issues.push({ code: "INVALID_INTEGER", rowNumber, field });
      }
    }
    if (!NUMERIC_FIELDS.every((field) => numbers.has(field))) continue;

    const value = (field: typeof NUMERIC_FIELDS[number]): number => numbers.get(field)!;
    const expected = calculateFrontProfitDerivedValues(
      (field: FrontProfitFormulaInputField) => value(field),
    );

    if (differenceExceeds(value("真实营业额"), expected["真实营业额"], FRONT_PROFIT_MONEY_TOLERANCE)) {
      issues.push({ code: "REAL_REVENUE_MISMATCH", rowNumber, field: "真实营业额" });
    }
    if (differenceExceeds(value("前台利润"), expected["前台利润"], FRONT_PROFIT_MONEY_TOLERANCE)) {
      issues.push({ code: "FRONT_PROFIT_MISMATCH", rowNumber, field: "前台利润" });
    }
    if (differenceExceeds(value("付费占比"), expected["付费占比"], FRONT_PROFIT_RATIO_TOLERANCE)) {
      issues.push({ code: "PAID_RATIO_MISMATCH", rowNumber, field: "付费占比" });
    }

    if (value("推广费") !== 0 && value("GMV") === 0 && value("出货货值") === 0 && value("单量") === 0) {
      warnings.push({ code: "PROMOTION_ORPHAN", rowNumber });
    }
    for (const field of INTEGER_FIELDS) {
      if (value(field) < 0) warnings.push({ code: "NEGATIVE_QUANTITY", rowNumber, field });
    }
    for (const field of MONEY_INPUT_FIELDS) {
      if (value(field) < 0) warnings.push({ code: "NEGATIVE_VALUE", rowNumber, field });
    }
  }

  if (issues.length > 0) throw new FrontProfitValidationError(issues);
  return { businessRowCount: records.length, warnings, identities };
}
