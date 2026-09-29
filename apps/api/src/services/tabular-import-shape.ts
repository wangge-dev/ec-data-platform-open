export type ImportShapeMode = "table" | "date-columns-to-rows";
export type HeaderRowCount = 1 | 2 | 3;

export type TabularImportQuality = {
  inputRows: number;
  importedRows: number;
  blankRowsSkipped: number;
  blankRowRatio: number;
  status: "ok" | "warning";
  warningCodes: string[];
};

export type WideToLongSummary = {
  mode: "date-columns-to-rows";
  sourceRows: number;
  outputRows: number;
  dimensionColumns: number;
  dateColumns: number;
  blankValuesSkipped: number;
  repeatedHeaderRowsSkipped: number;
  dateColumnName: string;
  valueColumnName: string;
};

export type HeaderProcessingSummary = {
  mode: "merge-header-rows";
  headerRows: 2 | 3;
  sourceStartRow: number;
  sourceEndRow: number;
  outputColumns: number;
};

export type PreparedTabularSheet = {
  headerRowIndex: number;
  headerRow: unknown[];
  dataRows: unknown[][];
  quality: TabularImportQuality;
  headerProcessing?: HeaderProcessingSummary;
  transform?: WideToLongSummary;
};

export type TabularImportShapeCode =
  | "TABULAR_HEADER_NOT_FOUND"
  | "TABULAR_NO_DATA_ROWS"
  | "HEADER_ROWS_INVALID"
  | "HEADER_START_ROW_INVALID"
  | "HEADER_ROWS_WITH_WIDE_TO_LONG_UNSUPPORTED"
  | "WIDE_TO_LONG_DATE_COLUMNS_NOT_FOUND"
  | "WIDE_TO_LONG_DIMENSIONS_NOT_FOUND";

export class TabularImportShapeError extends Error {
  constructor(
    readonly code: TabularImportShapeCode,
    message: string,
  ) {
    super(message);
    this.name = "TabularImportShapeError";
  }
}

function isEmptyCell(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function nonEmptyCellCount(row: unknown[]): number {
  return row.filter((value) => !isEmptyCell(value)).length;
}

function isBlankRow(row: unknown[], width: number): boolean {
  for (let index = 0; index < width; index += 1) {
    if (!isEmptyCell(row[index])) return false;
  }
  return true;
}

function findHeaderRowIndex(rows: unknown[][], headerRows: HeaderRowCount): number {
  for (let index = 0; index < rows.length - headerRows; index += 1) {
    const group = rows.slice(index, index + headerRows);
    if (nonEmptyCellCount(group[0] ?? []) < (headerRows === 1 ? 3 : 2)) continue;
    if (group.some((row) => nonEmptyCellCount(row ?? []) === 0)) continue;
    if (nonEmptyCellCount(group.at(-1) ?? []) < 3) continue;
    let nextDataIndex = index + headerRows;
    while (nextDataIndex < rows.length && nonEmptyCellCount(rows[nextDataIndex] ?? []) === 0) {
      nextDataIndex += 1;
    }
    if (nextDataIndex < rows.length && nonEmptyCellCount(rows[nextDataIndex] ?? []) >= 1) {
      return index;
    }
  }
  throw new TabularImportShapeError(
    "TABULAR_HEADER_NOT_FOUND",
    "没有识别到至少 3 列的表头，请检查工作表结构",
  );
}

function explicitHeaderRowIndex(
  rows: unknown[][],
  headerRows: HeaderRowCount,
  headerStartRow: number,
): number {
  if (!Number.isSafeInteger(headerStartRow) || headerStartRow < 1) {
    throw new TabularImportShapeError(
      "HEADER_START_ROW_INVALID",
      "表头起始行必须是从 1 开始的正整数",
    );
  }
  const startIndex = headerStartRow - 1;
  const group = rows.slice(startIndex, startIndex + headerRows);
  if (
    group.length !== headerRows
    || startIndex + headerRows >= rows.length
    || group.some((row) => nonEmptyCellCount(row ?? []) === 0)
    || nonEmptyCellCount(group.at(-1) ?? []) < 3
  ) {
    throw new TabularImportShapeError(
      "HEADER_START_ROW_INVALID",
      "指定的表头起始行无效：表头必须连续、末行至少 3 列，且表头后需要有数据",
    );
  }
  return startIndex;
}

function mergedHeaderRows(
  rows: unknown[][],
  startIndex: number,
  headerRows: 2 | 3,
): { headerRow: unknown[]; summary: HeaderProcessingSummary } {
  const levels = rows.slice(startIndex, startIndex + headerRows);
  const width = Math.max(...levels.map((row) => row.length));
  const filledLevels = levels.map((row) => {
    const filled: unknown[] = [];
    let previous: unknown = null;
    for (let index = 0; index < width; index += 1) {
      const value = row[index];
      if (!isEmptyCell(value)) previous = value;
      filled.push(isEmptyCell(value) ? previous : value);
    }
    return filled;
  });
  const headerRow = Array.from({ length: width }, (_, columnIndex) => {
    const parts = filledLevels
      .map((level) => level[columnIndex])
      .filter((value) => !isEmptyCell(value))
      .map((value) => String(value).trim())
      .filter((value, index, values) => index === 0 || value !== values[index - 1]);
    return parts.join(" / ");
  });
  if (nonEmptyCellCount(headerRow) < 3) {
    throw new TabularImportShapeError(
      "TABULAR_HEADER_NOT_FOUND",
      "合并多层表头后不足 3 列，请检查表头层数",
    );
  }
  return {
    headerRow,
    summary: {
      mode: "merge-header-rows",
      headerRows,
      sourceStartRow: startIndex + 1,
      sourceEndRow: startIndex + headerRows,
      outputColumns: headerRow.length,
    },
  };
}

function localDateText(date: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dateHeaderText(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return localDateText(value);
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const match = text.match(/^(20\d{2})[\/.年-](0?[1-9]|1[0-2])[\/.月-](0?[1-9]|[12]\d|3[01])日?$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return localDateText(date);
}

function uniqueOutputHeader(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

function wideToLong(
  headerRow: unknown[],
  dataRows: unknown[][],
): { headerRow: unknown[]; dataRows: unknown[][]; summary: WideToLongSummary } {
  const dateColumns = headerRow
    .map((header, index) => ({ index, date: dateHeaderText(header) }))
    .filter((column): column is { index: number; date: string } => column.date != null);
  if (dateColumns.length === 0) {
    throw new TabularImportShapeError(
      "WIDE_TO_LONG_DATE_COLUMNS_NOT_FOUND",
      "宽表转长表未识别到 YYYY-MM-DD、YYYY/MM/DD 或日期类型的列名",
    );
  }
  const dateIndexes = new Set(dateColumns.map((column) => column.index));
  const dimensionColumns = headerRow
    .map((header, index) => ({ index, header }))
    .filter(({ index, header }) => (
      !dateIndexes.has(index)
      && !isEmptyCell(header)
      && !/^(合计|总计)$/i.test(String(header).trim())
    ));
  if (dimensionColumns.length === 0) {
    throw new TabularImportShapeError(
      "WIDE_TO_LONG_DIMENSIONS_NOT_FOUND",
      "宽表转长表至少需要一个非日期维度列",
    );
  }

  const existing = new Set(dimensionColumns.map(({ header }) => String(header).trim()));
  const dateColumnName = uniqueOutputHeader("统计日期", existing);
  existing.add(dateColumnName);
  const valueColumnName = uniqueOutputHeader("指标值", existing);
  const outputHeader = [
    ...dimensionColumns.map(({ header }) => header),
    dateColumnName,
    valueColumnName,
  ];
  const outputRows: unknown[][] = [];
  let blankValuesSkipped = 0;
  let repeatedHeaderRowsSkipped = 0;
  const sectionDimension = dimensionColumns[0];
  let sectionLabel = sectionDimension && !isEmptyCell(sectionDimension.header)
    ? sectionDimension.header
    : null;
  for (const row of dataRows) {
    const matchingDateHeaders = dateColumns.filter((column) => (
      dateHeaderText(row[column.index]) === column.date
    )).length;
    if (
      matchingDateHeaders >= 2
      && matchingDateHeaders >= Math.ceil(dateColumns.length * 0.8)
    ) {
      const nextSectionLabel = dimensionColumns
        .map(({ index, header }) => ({ value: row[index], header }))
        .find(({ value, header }) => !isEmptyCell(value) && String(value).trim() !== String(header).trim())
        ?.value;
      if (!isEmptyCell(nextSectionLabel)) sectionLabel = nextSectionLabel;
      repeatedHeaderRowsSkipped += 1;
      continue;
    }
    const dimensions = dimensionColumns.map(({ index }, dimensionIndex) => {
      const value = row[index];
      return dimensionIndex === 0 && isEmptyCell(value) && !isEmptyCell(sectionLabel)
        ? sectionLabel
        : value ?? null;
    });
    for (const dateColumn of dateColumns) {
      const value = row[dateColumn.index];
      if (isEmptyCell(value)) {
        blankValuesSkipped += 1;
        continue;
      }
      outputRows.push([...dimensions, dateColumn.date, value]);
    }
  }
  if (outputRows.length === 0) {
    throw new TabularImportShapeError(
      "TABULAR_NO_DATA_ROWS",
      "日期列中没有可导入的指标值",
    );
  }
  return {
    headerRow: outputHeader,
    dataRows: outputRows,
    summary: {
      mode: "date-columns-to-rows",
      sourceRows: dataRows.length,
      outputRows: outputRows.length,
      dimensionColumns: dimensionColumns.length,
      dateColumns: dateColumns.length,
      blankValuesSkipped,
      repeatedHeaderRowsSkipped,
      dateColumnName,
      valueColumnName,
    },
  };
}

export function prepareTabularSheet(
  rows: unknown[][],
  options: {
    shapeMode?: ImportShapeMode;
    headerRows?: HeaderRowCount;
    /** One-based start row. Omit to use conservative automatic detection. */
    headerStartRow?: number;
  } = {},
): PreparedTabularSheet {
  const headerRows = options.headerRows ?? 1;
  if (![1, 2, 3].includes(headerRows)) {
    throw new TabularImportShapeError(
      "HEADER_ROWS_INVALID",
      "表头层数只支持 1、2 或 3 行",
    );
  }
  if (headerRows > 1 && options.shapeMode === "date-columns-to-rows") {
    throw new TabularImportShapeError(
      "HEADER_ROWS_WITH_WIDE_TO_LONG_UNSUPPORTED",
      "多层表头合并不能同时使用日期宽表转长表，请先选择一种处理方式",
    );
  }
  const headerRowIndex = options.headerStartRow === undefined
    ? findHeaderRowIndex(rows, headerRows)
    : explicitHeaderRowIndex(rows, headerRows, options.headerStartRow);
  const headerEndIndex = headerRowIndex + headerRows - 1;
  const header = headerRows === 1
    ? { headerRow: rows[headerRowIndex] ?? [], summary: undefined }
    : mergedHeaderRows(rows, headerRowIndex, headerRows);
  const sourceHeader = header.headerRow;
  const inputRows = rows.slice(headerEndIndex + 1);
  const nonBlankRows = inputRows.filter((row) => !isBlankRow(row, sourceHeader.length));
  const blankRowsSkipped = inputRows.length - nonBlankRows.length;
  if (nonBlankRows.length === 0) {
    throw new TabularImportShapeError(
      "TABULAR_NO_DATA_ROWS",
      "表头后只有空行，没有可导入的数据",
    );
  }

  const shaped = options.shapeMode === "date-columns-to-rows"
    ? wideToLong(sourceHeader, nonBlankRows)
    : { headerRow: sourceHeader, dataRows: nonBlankRows, summary: undefined };
  const warningCodes = blankRowsSkipped > 0 ? ["BLANK_ROWS_SKIPPED"] : [];
  return {
    headerRowIndex: headerEndIndex,
    headerRow: shaped.headerRow,
    dataRows: shaped.dataRows,
    quality: {
      inputRows: inputRows.length,
      importedRows: shaped.dataRows.length,
      blankRowsSkipped,
      blankRowRatio: inputRows.length === 0 ? 0 : blankRowsSkipped / inputRows.length,
      status: warningCodes.length > 0 ? "warning" : "ok",
      warningCodes,
    },
    ...(header.summary ? { headerProcessing: header.summary } : {}),
    ...(shaped.summary ? { transform: shaped.summary } : {}),
  };
}
