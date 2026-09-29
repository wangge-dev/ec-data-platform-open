import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

import { sql } from "../db/client.js";
import { runtimeTableReference } from "../db/table-scope.js";
import { withKeyedLock } from "../lib/keyed-lock.js";
import {
  deleteFileSourceInTransaction,
  FILE_TABLE_PREFIX,
  normalizeColumnName,
  type ImportResult,
} from "./import-excel.js";

export const LARGE_CSV_MAX_BYTES = 512 * 1024 * 1024;
export const LARGE_CSV_MAX_ROWS = 1_000_000;
export const LARGE_CSV_MAX_COLUMNS = 256;
export const LARGE_CSV_MAX_RECORD_BYTES = 4 * 1024 * 1024;
export const LARGE_CSV_MAX_HEADER_BYTES = 64 * 1024;

// Share the database lock namespace with the ordinary file importer so the
// same normalized filename cannot be replaced concurrently through two API
// entry points or two replicas. The large-upload performance claim itself is
// still single-request only.
const LARGE_CSV_IMPORT_LOCK_NAMESPACE = "ec-data-platform:file-import:";

export type LargeCsvUploadMetadataInput = {
  originalFileName: string;
  displayName?: string | null;
  group?: string | null;
  moduleCode?: string | null;
  replaceExisting?: boolean;
  role?: string | null;
  expectedRows?: number | null;
};

export type LargeCsvUploadMetadata = {
  originalFileName: string;
  displayName: string;
  group: string | null;
  moduleCode: string | null;
  replaceExisting: boolean;
  expectedRows: number;
};

export type LargeCsvInspection = {
  byteCount: number;
  rowCount: number;
  headers: string[];
};

type LargeCsvInspectionLimits = {
  maxBytes?: number;
  maxRows?: number;
  maxColumns?: number;
  maxRecordBytes?: number;
  maxHeaderBytes?: number;
};

export class LargeCsvImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 409 | 413 | 415 = 400,
  ) {
    super(message);
    this.name = "LargeCsvImportError";
  }
}

function cleanOptionalText(value: string | null | undefined, maxLength: number, label: string): string | null {
  const clean = value?.trim() ?? "";
  if (!clean) return null;
  if (clean.length > maxLength || clean.includes("�") || /[\u0000-\u001f\u007f]/u.test(clean)) {
    throw new LargeCsvImportError("LARGE_CSV_METADATA_INVALID", `${label}无效`);
  }
  return clean;
}

export function normalizeLargeCsvUploadMetadata(input: LargeCsvUploadMetadataInput): LargeCsvUploadMetadata {
  if (input.role != null && input.role !== "" && input.role !== "file") {
    throw new LargeCsvImportError(
      "LARGE_CSV_ROLE_UNSUPPORTED",
      "百万行流式入口仅支持普通文件数据源",
    );
  }
  const originalFileName = String(input.originalFileName ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .pop()!
    .normalize("NFC")
    .trim();
  if (
    !originalFileName
    || originalFileName.length > 255
    || originalFileName.includes("�")
    || /[\u0000-\u001f\u007f]/u.test(originalFileName)
    || !/\.csv$/iu.test(originalFileName)
    || originalFileName.slice(0, -4).trim().length === 0
  ) {
    throw new LargeCsvImportError(
      "LARGE_CSV_FILE_NAME_INVALID",
      "filename 必须是有效的 .csv 文件名",
    );
  }

  const defaultName = originalFileName.slice(0, -4).slice(0, 128);
  const displayName = cleanOptionalText(input.displayName, 128, "name") ?? defaultName;
  const group = cleanOptionalText(input.group, 128, "group");
  const moduleCode = cleanOptionalText(input.moduleCode, 64, "moduleCode");
  const expectedRows = Number(input.expectedRows);
  if (!Number.isSafeInteger(expectedRows) || expectedRows < 1 || expectedRows > LARGE_CSV_MAX_ROWS) {
    throw new LargeCsvImportError(
      "LARGE_CSV_EXPECTED_ROWS_INVALID",
      `expectedRows 必须是 1 到 ${LARGE_CSV_MAX_ROWS} 的整数`,
    );
  }
  return {
    originalFileName,
    displayName,
    group,
    moduleCode,
    replaceExisting: input.replaceExisting === true,
    expectedRows,
  };
}

export function shouldBypassDefaultBodyLimit(method: string, requestPath: string): boolean {
  return method.toUpperCase() === "POST" && requestPath === "/api/files/upload-large-csv";
}

function parseCsvHeader(headerBytes: Buffer, maxColumns: number): string[] {
  let header: string;
  try {
    header = new TextDecoder("utf-8", { fatal: true }).decode(headerBytes);
  } catch {
    throw new LargeCsvImportError(
      "LARGE_CSV_HEADER_ENCODING_INVALID",
      "CSV 表头必须使用 UTF-8 编码",
    );
  }
  if (header.charCodeAt(0) === 0xfeff) header = header.slice(1);

  const fields: string[] = [];
  let index = 0;
  while (index <= header.length) {
    let value = "";
    if (header[index] === '"') {
      index++;
      let closed = false;
      while (index < header.length) {
        const char = header[index++];
        if (char !== '"') {
          value += char;
          continue;
        }
        if (header[index] === '"') {
          value += '"';
          index++;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed || (index < header.length && header[index] !== ",")) {
        throw new LargeCsvImportError("LARGE_CSV_MALFORMED", "CSV 表头格式无效");
      }
    } else {
      const start = index;
      while (index < header.length && header[index] !== ",") {
        if (header[index] === '"') {
          throw new LargeCsvImportError("LARGE_CSV_MALFORMED", "CSV 表头格式无效");
        }
        index++;
      }
      value = header.slice(start, index);
    }
    fields.push(value);
    if (fields.length > maxColumns) {
      throw new LargeCsvImportError(
        "LARGE_CSV_COLUMN_LIMIT_EXCEEDED",
        `CSV 列数超过上限 ${maxColumns}`,
        413,
      );
    }
    if (index >= header.length) break;
    index++;
    if (index === header.length) {
      fields.push("");
      if (fields.length > maxColumns) {
        throw new LargeCsvImportError(
          "LARGE_CSV_COLUMN_LIMIT_EXCEEDED",
          `CSV 列数超过上限 ${maxColumns}`,
          413,
        );
      }
      break;
    }
  }
  if (fields.length === 0 || fields.every((field) => field.trim() === "")) {
    throw new LargeCsvImportError("LARGE_CSV_HEADER_EMPTY", "CSV 表头不能为空");
  }
  return fields;
}

class LargeCsvInspector {
  private readonly maxBytes: number;
  private readonly maxRows: number;
  private readonly maxColumns: number;
  private readonly maxRecordBytes: number;
  private readonly maxHeaderBytes: number;
  private inQuotes = false;
  private quotePending = false;
  private afterQuotedField = false;
  private atFieldStart = true;
  private fieldCount = 1;
  private recordBytes = 0;
  private recordCount = 0;
  private recordHasContent = false;
  private header: number[] = [];
  private parsedHeaders: string[] | null = null;
  private finished = false;
  private readonly utf8Decoder = new TextDecoder("utf-8", { fatal: true });
  byteCount = 0;

  constructor(limits: LargeCsvInspectionLimits = {}) {
    this.maxBytes = limits.maxBytes ?? LARGE_CSV_MAX_BYTES;
    this.maxRows = limits.maxRows ?? LARGE_CSV_MAX_ROWS;
    this.maxColumns = limits.maxColumns ?? LARGE_CSV_MAX_COLUMNS;
    this.maxRecordBytes = limits.maxRecordBytes ?? LARGE_CSV_MAX_RECORD_BYTES;
    this.maxHeaderBytes = limits.maxHeaderBytes ?? LARGE_CSV_MAX_HEADER_BYTES;
  }

  feed(chunk: Buffer): void {
    if (this.finished) throw new Error("large CSV inspector already finished");
    this.byteCount += chunk.byteLength;
    if (this.byteCount > this.maxBytes) {
      throw new LargeCsvImportError(
        "LARGE_CSV_BYTE_LIMIT_EXCEEDED",
        `CSV 文件超过上限 ${this.maxBytes} 字节`,
        413,
      );
    }
    try {
      this.utf8Decoder.decode(chunk, { stream: true });
    } catch {
      throw new LargeCsvImportError(
        this.parsedHeaders ? "LARGE_CSV_DATA_ENCODING_INVALID" : "LARGE_CSV_HEADER_ENCODING_INVALID",
        this.parsedHeaders ? "CSV 数据必须使用 UTF-8 编码" : "CSV 表头必须使用 UTF-8 编码",
      );
    }
    for (const byte of chunk) this.feedByte(byte);
  }

  private appendByte(byte: number): void {
    this.recordBytes++;
    if (this.recordBytes > this.maxRecordBytes) {
      throw new LargeCsvImportError(
        "LARGE_CSV_RECORD_LIMIT_EXCEEDED",
        `CSV 单条记录超过上限 ${this.maxRecordBytes} 字节`,
        413,
      );
    }
    if (this.recordCount === 0) {
      this.header.push(byte);
      if (this.header.length > this.maxHeaderBytes) {
        throw new LargeCsvImportError(
          "LARGE_CSV_HEADER_LIMIT_EXCEEDED",
          `CSV 表头超过上限 ${this.maxHeaderBytes} 字节`,
          413,
        );
      }
    }
  }

  private completeRecord(): void {
    if (this.recordCount === 0) {
      if (this.header.at(-1) === 13) this.header.pop();
      this.parsedHeaders = parseCsvHeader(Buffer.from(this.header), this.maxColumns);
      this.header = [];
    } else {
      if (!this.recordHasContent) {
        throw new LargeCsvImportError(
          "LARGE_CSV_BLANK_ROW_REJECTED",
          `CSV 第 ${this.recordCount + 1} 条记录为空，请先删除空行后重试`,
        );
      }
      if (this.fieldCount !== this.parsedHeaders!.length) {
        throw new LargeCsvImportError(
          "LARGE_CSV_COLUMN_COUNT_MISMATCH",
          `CSV 第 ${this.recordCount + 1} 条记录列数与表头不一致`,
        );
      }
      if (this.recordCount > this.maxRows) {
        throw new LargeCsvImportError(
          "LARGE_CSV_ROW_LIMIT_EXCEEDED",
          `CSV 数据行超过上限 ${this.maxRows}`,
          413,
        );
      }
    }
    this.recordCount++;
    if (this.recordCount - 1 > this.maxRows) {
      throw new LargeCsvImportError(
        "LARGE_CSV_ROW_LIMIT_EXCEEDED",
        `CSV 数据行超过上限 ${this.maxRows}`,
        413,
      );
    }
    this.recordBytes = 0;
    this.fieldCount = 1;
    this.atFieldStart = true;
    this.afterQuotedField = false;
    this.recordHasContent = false;
  }

  private feedByte(byte: number): void {
    if (byte === 0) {
      throw new LargeCsvImportError("LARGE_CSV_NUL_BYTE_UNSUPPORTED", "CSV 不能包含 NUL 字节");
    }
    if (this.quotePending) {
      if (byte === 34) {
        this.quotePending = false;
        this.recordHasContent = true;
        this.appendByte(byte);
        return;
      }
      this.quotePending = false;
      this.inQuotes = false;
      this.afterQuotedField = true;
    }
    if (this.inQuotes) {
      if (byte === 34) this.quotePending = true;
      else if (byte !== 9 && byte !== 32 && byte !== 13) this.recordHasContent = true;
      this.appendByte(byte);
      return;
    }
    if (this.afterQuotedField) {
      if (byte === 13) {
        this.appendByte(byte);
        return;
      }
      if (byte === 44) {
        this.afterQuotedField = false;
        this.atFieldStart = true;
        this.fieldCount++;
        this.appendByte(byte);
        return;
      }
      if (byte === 10) {
        this.completeRecord();
        return;
      }
      throw new LargeCsvImportError("LARGE_CSV_MALFORMED", "CSV 引号字段结束位置无效");
    }
    if (byte === 34) {
      if (!this.atFieldStart) {
        throw new LargeCsvImportError("LARGE_CSV_MALFORMED", "CSV 未转义引号位置无效");
      }
      this.inQuotes = true;
      this.atFieldStart = false;
      this.appendByte(byte);
      return;
    }
    if (byte === 44) {
      this.fieldCount++;
      this.atFieldStart = true;
      this.appendByte(byte);
      return;
    }
    if (byte === 10) {
      this.completeRecord();
      return;
    }
    if (byte !== 9 && byte !== 13 && byte !== 32) this.recordHasContent = true;
    this.atFieldStart = false;
    this.appendByte(byte);
  }

  finish(): LargeCsvInspection {
    if (this.finished) throw new Error("large CSV inspector already finished");
    this.finished = true;
    if (this.quotePending) {
      this.quotePending = false;
      this.inQuotes = false;
    }
    if (this.inQuotes) {
      throw new LargeCsvImportError("LARGE_CSV_MALFORMED", "CSV 存在未闭合的引号");
    }
    try {
      this.utf8Decoder.decode();
    } catch {
      throw new LargeCsvImportError(
        this.parsedHeaders ? "LARGE_CSV_DATA_ENCODING_INVALID" : "LARGE_CSV_HEADER_ENCODING_INVALID",
        this.parsedHeaders ? "CSV 数据必须使用 UTF-8 编码" : "CSV 表头必须使用 UTF-8 编码",
      );
    }
    if (this.recordBytes > 0) this.completeRecord();
    if (!this.parsedHeaders) {
      throw new LargeCsvImportError("LARGE_CSV_HEADER_EMPTY", "CSV 表头不能为空");
    }
    const rowCount = this.recordCount - 1;
    if (rowCount < 1) {
      throw new LargeCsvImportError("LARGE_CSV_DATA_EMPTY", "CSV 至少需要一条数据记录");
    }
    return { byteCount: this.byteCount, rowCount, headers: this.parsedHeaders };
  }
}

export function inspectLargeCsvChunks(
  chunks: Iterable<Uint8Array>,
  limits: LargeCsvInspectionLimits = {},
): LargeCsvInspection {
  const inspector = new LargeCsvInspector(limits);
  for (const chunk of chunks) inspector.feed(Buffer.from(chunk));
  return inspector.finish();
}

class LargeCsvGuardTransform extends Transform {
  private readonly inspector: LargeCsvInspector;
  private readonly hash = createHash("sha256");
  private inspection: LargeCsvInspection | null = null;

  constructor(limits: LargeCsvInspectionLimits = {}) {
    super();
    this.inspector = new LargeCsvInspector(limits);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.inspector.feed(bytes);
      this.hash.update(bytes);
      callback(null, bytes);
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.inspection = this.inspector.finish();
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  result(): LargeCsvInspection & { sha256: string } {
    if (!this.inspection) throw new Error("large CSV stream has not completed");
    return { ...this.inspection, sha256: this.hash.digest("hex") };
  }
}

type LargeCsvSpool = LargeCsvInspection & {
  directory: string;
  filePath: string;
  sha256: string;
};

async function spoolLargeCsvBody(body: ReadableStream<Uint8Array> | null): Promise<LargeCsvSpool> {
  if (!body) throw new LargeCsvImportError("LARGE_CSV_BODY_REQUIRED", "请求体不能为空");
  const directory = await mkdtemp(path.join(tmpdir(), "ec-large-csv-"));
  const filePath = path.join(directory, "upload.csv");
  const guard = new LargeCsvGuardTransform();
  try {
    await pipeline(
      Readable.fromWeb(body as any),
      guard,
      createWriteStream(filePath, { flags: "wx", mode: 0o600 }),
    );
    return { directory, filePath, ...guard.result() };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function normalizedColumns(headers: readonly string[]): Array<{ raw: string; name: string }> {
  const used = new Set<string>(["id"]);
  return headers.map((header, index) => {
    const raw = String(header ?? `col_${index}`);
    let name = normalizeColumnName(raw, index);
    if (used.has(name)) {
      let suffix = 2;
      while (used.has(`${name}_${suffix}`)) suffix++;
      name = `${name}_${suffix}`;
    }
    used.add(name);
    return { raw, name };
  });
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function isCsvCopyInputError(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? "");
  return ["22P02", "22P04", "22021", "22023"].includes(code);
}

async function persistLargeCsv(
  spool: LargeCsvSpool,
  metadata: LargeCsvUploadMetadata,
): Promise<ImportResult & { byteCount: number; sha256: string }> {
  const columns = normalizedColumns(spool.headers);
  const sourceConfig = {
    sheetName: "CSV",
    rowCount: spool.rowCount,
    columns,
    originalFileName: metadata.originalFileName,
    uploadedAt: new Date().toISOString(),
    role: "file",
    quality: {
      inputRows: spool.rowCount,
      importedRows: spool.rowCount,
      blankRowsSkipped: 0,
      blankRowRatio: 0,
      status: "ok" as const,
      warningCodes: [] as string[],
    },
    group: metadata.group,
    ...(metadata.moduleCode ? { moduleCode: metadata.moduleCode } : {}),
    largeCsvUpload: {
      contractVersion: "large-csv/v1",
      byteCount: spool.byteCount,
      sha256: spool.sha256,
      maxRows: LARGE_CSV_MAX_ROWS,
      expectedRows: metadata.expectedRows,
    },
  };

  return withKeyedLock(metadata.originalFileName, async () => sql.begin(async (tx) => {
    await tx.unsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${LARGE_CSV_IMPORT_LOCK_NAMESPACE}${metadata.originalFileName}`],
    );
    const existing = await tx.unsafe(
      `SELECT id, config FROM public.data_sources
       WHERE type = 'file' AND config->>'originalFileName' = $1
       ORDER BY id`,
      [metadata.originalFileName],
    ) as Array<{ id: number; config: unknown }>;
    if (metadata.replaceExisting) {
      for (const source of existing) await deleteFileSourceInTransaction(tx, Number(source.id));
    }

    const inserted = await tx.unsafe(
      `INSERT INTO public.data_sources (name, type, platform, config, status)
       VALUES ($1, 'file', NULL, $2::jsonb, 'active') RETURNING id`,
      [metadata.displayName, JSON.stringify(sourceConfig)],
    ) as Array<{ id: number | string }>;
    const sourceId = Number(inserted[0]?.id);
    if (!Number.isSafeInteger(sourceId) || sourceId <= 0) {
      throw new Error("failed to allocate large CSV source id");
    }

    const tableName = `${FILE_TABLE_PREFIX}${sourceId}`;
    const tableReference = runtimeTableReference(tableName);
    const columnDefinitions = columns
      .map((column) => `${quoteSqlIdentifier(column.name)} TEXT`)
      .join(", ");
    await tx.unsafe(
      `CREATE TABLE ${tableReference} (id BIGSERIAL PRIMARY KEY, ${columnDefinitions})`,
    );
    const copyColumns = columns.map((column) => quoteSqlIdentifier(column.name)).join(", ");
    try {
      const writable = await (tx.unsafe(
        `COPY ${tableReference} (${copyColumns}) FROM STDIN WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')`,
      ) as any).writable();
      await pipeline(createReadStream(spool.filePath), writable);
    } catch (error) {
      if (isCsvCopyInputError(error)) {
        throw new LargeCsvImportError("LARGE_CSV_COPY_INVALID", "CSV 数据格式与表头不一致");
      }
      throw error;
    }
    const [countRow] = await tx.unsafe(`SELECT COUNT(*)::bigint AS count FROM ${tableReference}`);
    const actualRowCount = Number(countRow?.count ?? -1);
    if (actualRowCount !== spool.rowCount) {
      throw new LargeCsvImportError(
        "LARGE_CSV_ROW_COUNT_MISMATCH",
        "CSV 写入行数与流式校验结果不一致",
      );
    }
    if (actualRowCount !== metadata.expectedRows) {
      throw new LargeCsvImportError(
        "LARGE_CSV_EXPECTED_ROWS_MISMATCH",
        `CSV 实际写入 ${actualRowCount} 行，与声明的 ${metadata.expectedRows} 行不一致`,
      );
    }
    return {
      sourceId,
      tableName,
      rowCount: actualRowCount,
      columns,
      quality: sourceConfig.quality,
      byteCount: spool.byteCount,
      sha256: spool.sha256,
    };
  }));
}

export async function importLargeCsvUpload(
  body: ReadableStream<Uint8Array> | null,
  inputMetadata: LargeCsvUploadMetadataInput,
): Promise<ImportResult & { byteCount: number; sha256: string }> {
  const metadata = normalizeLargeCsvUploadMetadata(inputMetadata);
  const spool = await spoolLargeCsvBody(body);
  try {
    return await persistLargeCsv(spool, metadata);
  } finally {
    await rm(spool.directory, { recursive: true, force: true });
  }
}
