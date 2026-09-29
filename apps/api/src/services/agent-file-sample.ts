import {
  quoteSqlIdentifier,
  resolveExistingRuntimeTableReferenceFromSql,
} from "../db/table-scope.js";

type SqlExecutor = {
  unsafe(query: string, parameters?: any[]): PromiseLike<Array<Record<string, unknown>>>;
};

type ImportedColumn = { raw: string; name: string };

/** Read only imported columns; restore display headers after SQL has completed. */
export async function readFileAnalysisSample(
  executor: SqlExecutor,
  sourceId: number,
  columns: ImportedColumn[],
  limit: number,
): Promise<Array<Record<string, unknown>> | null> {
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0) {
    throw new Error("Invalid file source id");
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Invalid sample limit");
  }

  const tableRef = await resolveExistingRuntimeTableReferenceFromSql(`uf_${sourceId}`, executor);
  if (!tableRef) return null;
  const selection = columns.map((column) => quoteSqlIdentifier(column.name)).join(", ");
  const rows = await executor.unsafe(
    `SELECT ${selection} FROM ${tableRef} LIMIT $1`,
    [limit],
  );
  return rows.map((row) => Object.fromEntries(
    columns.map((column) => [column.raw, row[column.name]]),
  ));
}
