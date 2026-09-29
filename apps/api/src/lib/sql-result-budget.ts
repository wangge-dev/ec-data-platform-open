export const SQL_RESULT_MAX_TOTAL_BYTES = 5 * 1024 * 1024;
export const SQL_RESULT_MAX_CELL_BYTES = 256 * 1024;

export type SqlResultBudgetOptions = {
  maxTotalBytes?: number;
  maxCellBytes?: number;
  columns?: readonly string[];
};

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function serializeJson(value: unknown): string | undefined {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("SQL result contains a value that cannot be serialized safely");
  }
  return serialized;
}

function serializedByteLength(serialized: string | undefined): number {
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
}

/**
 * Fail closed before a SQL result is handed to the JSON response layer.
 *
 * The row cap limits cardinality, while these independent budgets prevent one
 * very large value (or many medium values) from producing an unbounded API
 * response. Byte counts use the JSON representation that Hono will send.
 */
export function assertSqlResultWithinBudget(
  rows: readonly Record<string, unknown>[],
  options: SqlResultBudgetOptions = {},
): void {
  const maxTotalBytes = positiveSafeInteger(
    options.maxTotalBytes ?? SQL_RESULT_MAX_TOTAL_BYTES,
    "SQL result total byte limit",
  );
  const maxCellBytes = positiveSafeInteger(
    options.maxCellBytes ?? SQL_RESULT_MAX_CELL_BYTES,
    "SQL result cell byte limit",
  );

  let totalBytes = options.columns === undefined
    ? 2 // JSON array brackets
    : Buffer.byteLength('{"rows":[]}', "utf8");
  let rowIndex = 0;
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("SQL result row is not a serializable record");
    }
    // Replace the empty rows-array representation with its first object, or
    // account for the comma before every later object.
    totalBytes += rowIndex === 0 ? 0 : 1;
    totalBytes += 2;
    let propertyIndex = 0;
    for (const [key, value] of Object.entries(row)) {
      // Avoid duplicating a huge string just to learn that it is already over
      // budget. JSON quoting can only make the representation larger.
      if (
        typeof value === "string"
        && Buffer.byteLength(value, "utf8") > maxCellBytes
      ) {
        throw new Error(`SQL result cell exceeds ${maxCellBytes}-byte limit`);
      }
      if (
        ArrayBuffer.isView(value)
        && value.byteLength > maxCellBytes
      ) {
        throw new Error(`SQL result cell exceeds ${maxCellBytes}-byte limit`);
      }
      const serialized = serializeJson(value);
      if (serialized === undefined) continue;
      const valueBytes = serializedByteLength(serialized);
      if (valueBytes > maxCellBytes) {
        throw new Error(`SQL result cell exceeds ${maxCellBytes}-byte limit`);
      }
      totalBytes += propertyIndex === 0 ? 0 : 1;
      totalBytes += Buffer.byteLength(JSON.stringify(key), "utf8") + 1 + valueBytes;
      propertyIndex++;
      if (totalBytes > maxTotalBytes) {
        throw new Error(`SQL result exceeds ${maxTotalBytes}-byte limit`);
      }
    }
    rowIndex++;
  }

  if (options.columns !== undefined) {
    const columns = serializeJson(options.columns);
    for (const column of options.columns) {
      if (serializedByteLength(serializeJson(column)) > maxCellBytes) {
        throw new Error(`SQL result cell exceeds ${maxCellBytes}-byte limit`);
      }
    }
    // `{"rows":[]}` already included the empty array and closing object. Add
    // the non-empty row bytes above, then the columns property before `}`.
    totalBytes += Buffer.byteLength(',"columns":', "utf8")
      + serializedByteLength(columns);
  }
  if (totalBytes > maxTotalBytes) {
    throw new Error(`SQL result exceeds ${maxTotalBytes}-byte limit`);
  }
}
