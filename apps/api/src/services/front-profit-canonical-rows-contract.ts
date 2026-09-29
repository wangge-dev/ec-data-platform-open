import {
  FRONT_PROFIT_STANDARD_HEADERS,
  FRONT_PROFIT_STANDARD_SCHEMA_VERSION,
  FrontProfitValidationError,
  type FrontProfitValidationResult,
  normalizeFrontProfitDate,
  validateFrontProfitStandardSheet,
} from "./front-profit-standard.js";
import { deriveFrontProfitPeriod, frontProfitScopeKey } from "./front-profit-period.js";

export type FrontProfitImportSummary = {
  schemaVersion: typeof FRONT_PROFIT_STANDARD_SCHEMA_VERSION;
  businessRowCount: number;
  warningCount: number;
  warningCodes: string[];
};

export type FrontProfitCanonicalRowsContract = {
  validation: FrontProfitValidationResult;
  identities: FrontProfitValidationResult["identities"];
  summary: FrontProfitImportSummary;
  periods: string[];
  scopeKeys: string[];
};

const FRONT_PROFIT_WARNING_LABELS: Record<string, string> = {
  PROMOTION_ORPHAN: "推广孤儿（保留）",
  NEGATIVE_QUANTITY: "负数待复核",
  NEGATIVE_VALUE: "负数待复核",
};

function applyFrontProfitWarnings(
  headers: readonly unknown[],
  dataRows: unknown[][],
  validation: FrontProfitValidationResult,
  firstDataRowNumber: number,
): void {
  const statusIndex = headers.findIndex((header) =>
    String(header ?? "").trim() === FRONT_PROFIT_STANDARD_HEADERS[27],
  );
  if (statusIndex < 0) return;

  const labelsByRow = new Map<number, Set<string>>();
  for (const warning of validation.warnings) {
    if (warning.rowNumber == null) continue;
    const label = FRONT_PROFIT_WARNING_LABELS[warning.code];
    if (!label) continue;
    const labels = labelsByRow.get(warning.rowNumber) ?? new Set<string>();
    labels.add(label);
    labelsByRow.set(warning.rowNumber, labels);
  }

  for (const [rowNumber, labels] of labelsByRow) {
    const rowIndex = rowNumber - firstDataRowNumber;
    const row = dataRows[rowIndex];
    if (!row) continue;
    const existing = String(row[statusIndex] ?? "").trim();
    const parts = new Set(
      existing
        ? existing.split("；").map((part) => part.trim()).filter(Boolean)
        : [],
    );
    for (const label of labels) parts.add(label);
    row[statusIndex] = [...parts].join("；");
  }
}

function canonicalizeFrontProfitDates(headers: readonly unknown[], dataRows: unknown[][]): void {
  const dateIndex = headers.findIndex((header) =>
    String(header ?? "").trim() === FRONT_PROFIT_STANDARD_HEADERS[0],
  );
  if (dateIndex < 0) return;
  for (const row of dataRows) {
    const canonical = normalizeFrontProfitDate(row[dateIndex]);
    if (canonical) row[dateIndex] = canonical;
  }
}

function frontProfitSummary(validation: FrontProfitValidationResult): FrontProfitImportSummary {
  return {
    schemaVersion: FRONT_PROFIT_STANDARD_SCHEMA_VERSION,
    businessRowCount: validation.businessRowCount,
    warningCount: validation.warnings.length,
    warningCodes: [...new Set(validation.warnings.map((warning) => warning.code))].sort(),
  };
}

function frontProfitPeriodsFromRows(
  headers: readonly unknown[],
  dataRows: readonly (readonly unknown[])[],
): string[] {
  const dateIndex = headers.findIndex((header) =>
    String(header ?? "").trim() === FRONT_PROFIT_STANDARD_HEADERS[0],
  );
  if (dateIndex < 0) throw new FrontProfitValidationError([{ code: "HEADER_CONTRACT" }]);
  return [...new Set(dataRows.map((row) => deriveFrontProfitPeriod(row[dateIndex])))].sort();
}

export function canonicalRowsContract(input: {
  headers: readonly unknown[];
  dataRows: unknown[][];
  firstDataRowNumber?: number;
}): FrontProfitCanonicalRowsContract {
  const firstDataRowNumber = input.firstDataRowNumber ?? 2;
  const validation = validateFrontProfitStandardSheet(
    input.headers,
    input.dataRows,
    firstDataRowNumber,
  );
  const periods = frontProfitPeriodsFromRows(input.headers, input.dataRows);
  canonicalizeFrontProfitDates(input.headers, input.dataRows);
  applyFrontProfitWarnings(input.headers, input.dataRows, validation, firstDataRowNumber);
  return {
    validation,
    identities: validation.identities,
    summary: frontProfitSummary(validation),
    periods,
    scopeKeys: periods.map(frontProfitScopeKey),
  };
}
