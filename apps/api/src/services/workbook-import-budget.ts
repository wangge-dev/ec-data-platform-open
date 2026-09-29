export const WORKBOOK_IMPORT_LIMITS = Object.freeze({
  maxRows: 200_000,
  maxCells: 4_000_000,
  maxEstimatedBytes: 128 * 1024 * 1024,
});

export type WorkbookImportBudget = {
  rows: number;
  cells: number;
  estimatedBytes: number;
};

export class WorkbookImportBudgetError extends Error {
  readonly code = "WORKBOOK_RESOURCE_LIMIT";

  constructor(message: string) {
    super(message);
    this.name = "WorkbookImportBudgetError";
  }
}

export function emptyWorkbookImportBudget(): WorkbookImportBudget {
  return { rows: 0, cells: 0, estimatedBytes: 0 };
}

function cellPayloadBytes(value: unknown): number {
  if (value == null) return 0;
  if (value instanceof Date) return 24;
  if (typeof value === "number" || typeof value === "boolean") return 16;
  return Buffer.byteLength(String(value), "utf8");
}

export function addWorkbookSheetToBudget(
  current: WorkbookImportBudget,
  sheetName: string,
  rows: unknown[][],
  limits: Readonly<typeof WORKBOOK_IMPORT_LIMITS> = WORKBOOK_IMPORT_LIMITS,
): WorkbookImportBudget {
  const cells = rows.reduce<number>((total, row) => total + row.length, 0);
  const estimatedBytes = rows.reduce<number>(
    (total, row) => total + 32 + row.reduce<number>(
      (rowTotal, value) => rowTotal + 16 + cellPayloadBytes(value),
      0,
    ),
    Buffer.byteLength(sheetName, "utf8") + 64,
  );
  const next = {
    rows: current.rows + rows.length,
    cells: current.cells + cells,
    estimatedBytes: current.estimatedBytes + estimatedBytes,
  };
  if (next.rows > limits.maxRows) {
    throw new WorkbookImportBudgetError(`整本工作簿可导入数据超过 ${limits.maxRows} 行上限`);
  }
  if (next.cells > limits.maxCells) {
    throw new WorkbookImportBudgetError(`整本工作簿可导入单元格超过 ${limits.maxCells} 个上限`);
  }
  if (next.estimatedBytes > limits.maxEstimatedBytes) {
    throw new WorkbookImportBudgetError("整本工作簿解析后的估算内存超过安全上限");
  }
  return next;
}
