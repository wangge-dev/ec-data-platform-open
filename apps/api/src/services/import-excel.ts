// Excel 导入核心：解析 + 列规范化去重 + 动态建表 + 批量插入。upload 和 文件夹扫描共用。
import { sql } from "../db/client";
import {
  resolveExistingRuntimeTableReferenceFromSql,
  runtimeTableReference,
  schemaTableReference,
} from "../db/table-scope";
import { withKeyedLock } from "../lib/keyed-lock.js";
import {
  FRONT_PROFIT_STANDARD_HEADERS,
  FRONT_PROFIT_STANDARD_SCHEMA_VERSION,
  FrontProfitValidationError,
  type FrontProfitValidationResult,
  frontProfitAggregationKey,
  isFrontProfitPreparationWorkbook,
  isFrontProfitStandardSheet,
  normalizeFrontProfitDate,
} from "./front-profit-standard.js";
import { canonicalRowsContract, type FrontProfitImportSummary } from "./front-profit-canonical-rows-contract.js";
import {
  FrontProfitAuthorityError,
  assertFrontProfitManualImportAuthority,
  frontProfitAuthorityIssues,
} from "./front-profit-authority.js";
import { FRONT_PROFIT_MODULE_CODE } from "./front-profit-period.js";
import { listSpreadsheetSheetNames, parseSpreadsheetRows } from "./spreadsheet-security.js";
import {
  prepareTabularSheet,
  type HeaderProcessingSummary,
  type HeaderRowCount,
  type ImportShapeMode,
  type TabularImportQuality,
  type WideToLongSummary,
} from "./tabular-import-shape.js";
import {
  addWorkbookSheetToBudget,
  emptyWorkbookImportBudget,
} from "./workbook-import-budget.js";

export const MAX_ROWS_DEFAULT = 50000;
export const MAX_ROWS_DICT = 100000;
export const FILE_TABLE_PREFIX = "uf_";
const MAX_POSTGRES_QUERY_PARAMETERS = 65_535;
const IMPORT_BATCH_ROWS = 200;

export function importInsertBatchSize(columnCount: number): number {
  if (!Number.isSafeInteger(columnCount) || columnCount < 1 || columnCount > MAX_POSTGRES_QUERY_PARAMETERS) {
    throw new Error("Invalid imported column count");
  }
  return Math.min(IMPORT_BATCH_ROWS, Math.floor(MAX_POSTGRES_QUERY_PARAMETERS / columnCount));
}

// 列名规范化：保留中英文数字下划线，其他换 _
export function normalizeColumnName(raw: string, idx: number): string {
  if (!raw || typeof raw !== "string") return `col_${idx}`;
  const trimmed = raw.trim();
  if (!trimmed) return `col_${idx}`;
  const cleaned = trimmed.replace(/[^\w一-龥]/g, "_").slice(0, 60);
  return cleaned || `col_${idx}`;
}

// 识别维护表(品牌字典)的语义列
export function detectBrandDictCols(cols: Array<{ raw: string; name: string }>) {
  const find = (pred: (raw: string) => boolean) => cols.find((c) => pred(c.raw))?.name ?? null;
  const raw = (c: { raw: string }) => c.raw.trim().toLowerCase();
  return {
    idCol: cols.find((c) => raw(c) === "id")?.name ?? find((r) => /商品id|货品id/i.test(r)),
    codeCol: find((r) => r.includes("商家编码") || r.includes("商品编码") || r.includes("货品编码")),
    brandCol: find((r) => r.includes("品牌")),
    shopCol: find((r) => r.includes("店铺")),
    operatorCol: find((r) => r.includes("运营")),
    productNameCol: find((r) => r.includes("产品名称") || r.includes("商品名称")),
    categoryCol: find((r) => r.includes("品类")),
  };
}

export type ImportResult = {
  sourceId: number;
  tableName: string;
  rowCount: number;
  columns: Array<{ raw: string; name: string }>;
  quality: TabularImportQuality;
  headerProcessing?: HeaderProcessingSummary;
  transform?: WideToLongSummary;
  frontProfitValidation?: FrontProfitImportSummary;
};

export type MultiSheetImportResult = {
  sources: ImportResult[];
  rowCount: number;
  sheetCount: number;
  skippedSheets: Array<{ sheetName: string; reason: "empty" }>;
};

export type ImportExcelOptions = {
  actorId?: number | null;
  today?: string;
  // Trusted callers may attach narrowly scoped lifecycle metadata. This is
  // never populated from an upload request body.
  systemMetadata?: Readonly<Record<string, string>>;
  sheetName?: string;
  shapeMode?: ImportShapeMode;
  headerRows?: HeaderRowCount;
  headerStartRow?: number;
  parentOriginalFileName?: string;
  importMode?: "single-sheet/v1" | "multi-sheet/v1";
};

export type DataSourcePublishedReference = {
  publishVersionId: number;
  moduleCode: string;
  scopeKey: string;
  versionNo: number;
};

export function isFileNameUniqueConflict(error: unknown): boolean {
  const value = error as { code?: string; constraint_name?: string; constraint?: string };
  const constraint = value?.constraint_name ?? value?.constraint;
  return value?.code === "23505" && constraint === "uq_data_sources_file_original_name";
}

export function serializeImportedCellValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const pad = (part: number, width = 2) => String(part).padStart(width, "0");
    const date = [
      pad(value.getFullYear(), 4),
      pad(value.getMonth() + 1),
      pad(value.getDate()),
    ].join("-");
    const hasTime =
      value.getHours() !== 0 ||
      value.getMinutes() !== 0 ||
      value.getSeconds() !== 0 ||
      value.getMilliseconds() !== 0;
    if (!hasTime) return date;

    const time = [
      pad(value.getHours()),
      pad(value.getMinutes()),
      pad(value.getSeconds()),
    ].join(":");
    const milliseconds = value.getMilliseconds();
    return `${date} ${time}${milliseconds ? `.${pad(milliseconds, 3)}` : ""}`;
  }
  return String(value);
}

const FRONT_PROFIT_LOCK_KEY = "front-profit-standard-import";
const GENERIC_FILE_IMPORT_LOCK_NAMESPACE = "ec-data-platform:file-import:";

export class DataSourceDeleteBlockedError extends Error {
  readonly code: string;

  constructor(
    readonly sourceId: number,
    readonly references: DataSourcePublishedReference[],
    code = "DATA_SOURCE_REFERENCED_BY_PUBLISHED_VERSION",
    label = "data source",
  ) {
    super(`${label} ${sourceId} is referenced by a published version`);
    this.name = "DataSourceDeleteBlockedError";
    this.code = code;
  }
}

export class FileSourceDeleteBlockedError extends DataSourceDeleteBlockedError {
  constructor(sourceId: number, references: DataSourcePublishedReference[]) {
    super(sourceId, references, "FILE_SOURCE_REFERENCED_BY_PUBLISHED_VERSION", "file source");
    this.name = "FileSourceDeleteBlockedError";
  }
}

function storedFileName(source: { config: unknown }): string {
  return String((source.config as any)?.originalFileName ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .pop()!
    .normalize("NFC");
}

function isStoredFrontProfitSource(source: { config: unknown }): boolean {
  const config = (source.config as any) ?? {};
  if (config.frontProfitValidation?.schemaVersion === "front-profit-standard/v1") return true;
  const rawHeaders = Array.isArray(config.columns)
    ? config.columns.map((column: any) => String(column?.raw ?? "").trim())
    : [];
  return rawHeaders.length === FRONT_PROFIT_STANDARD_HEADERS.length
    && FRONT_PROFIT_STANDARD_HEADERS.every((header) => rawHeaders.includes(header));
}

function sourceFrontProfitScopeKeys(source: { config: unknown }): string[] | null {
  const config = (source.config as any) ?? {};
  if (Array.isArray(config.frontProfitScopeKeys)) {
    const scopeKeys: string[] = config.frontProfitScopeKeys
      .map((value: unknown) => String(value ?? "").trim())
      .filter((value: string) => value.startsWith(`${FRONT_PROFIT_MODULE_CODE}:`));
    if (scopeKeys.length > 0) return [...new Set(scopeKeys)].sort();
  }
  if (Array.isArray(config.frontProfitPeriods)) {
    const scopeKeys: string[] = config.frontProfitPeriods
      .map((value: unknown) => String(value ?? "").trim())
      .filter((value: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value))
      .map((period: string) => `${FRONT_PROFIT_MODULE_CODE}:${period}`);
    if (scopeKeys.length > 0) return [...new Set(scopeKeys)].sort();
  }
  return null;
}

async function frontProfitDuplicateScopeSources(
  incomingScopeKeys: readonly string[],
  existingSources: Array<{ id: number; config: unknown }>,
  executor: { unsafe(query: string, parameters?: unknown[]): PromiseLike<any[]> },
): Promise<Array<{ id: number; config: unknown }>> {
  const incomingScopes = new Set(incomingScopeKeys);
  const candidates = existingSources
    .filter(isStoredFrontProfitSource)
    .filter((source) => {
      const sourceScopes = sourceFrontProfitScopeKeys(source);
      return sourceScopes == null || sourceScopes.some((scopeKey) => incomingScopes.has(scopeKey));
    });
  if (candidates.length === 0) return [];

  const placeholders = candidates.map((_, index) => `$${index + 2}`).join(", ");
  const references = await executor.unsafe(
    `SELECT pvs.source_id,
            pv.scope_key,
            pv.status
     FROM public.publish_version_source pvs
     INNER JOIN public.publish_version pv ON pv.id = pvs.publish_version_id
     WHERE pv.module_code = $1 AND pvs.source_id IN (${placeholders})`,
    [FRONT_PROFIT_MODULE_CODE, ...candidates.map((source) => source.id)],
  ) as Array<{ source_id: number | string; scope_key: string; status: string }>;
  const referencesBySource = new Map<number, Array<{ scopeKey: string; status: string }>>();
  for (const reference of references) {
    const sourceId = Number(reference.source_id);
    const list = referencesBySource.get(sourceId) ?? [];
    list.push({ scopeKey: String(reference.scope_key), status: String(reference.status) });
    referencesBySource.set(sourceId, list);
  }

  return candidates.filter((source) => {
    const config = (source.config as any) ?? {};
    if (config.frontProfitAuthority !== "auto") return true;
    const sourceScopes = sourceFrontProfitScopeKeys(source);
    const relevantReferences = (referencesBySource.get(source.id) ?? []).filter((reference) =>
      incomingScopes.has(reference.scopeKey)
      || sourceScopes == null
      || sourceScopes.includes(reference.scopeKey),
    );
    return relevantReferences.some((reference) => reference.status === "published");
  });
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function assertNoExistingFrontProfitIdentity(
  incoming: FrontProfitValidationResult,
  existingSources: Array<{ id: number; config: unknown }>,
  executor: { unsafe(query: string, parameters?: unknown[]): PromiseLike<any[]> },
): Promise<void> {
  const incomingByRecordId = new Map(incoming.identities.map((identity) => [identity.recordId, identity]));
  const incomingByAggregationKey = new Map(incoming.identities.map((identity) => [identity.aggregationKey, identity]));
  const issues: Array<{ code: string; rowNumber: number }> = [];

  for (const source of existingSources) {
    const config = (source.config as any) ?? {};
    const columns = Array.isArray(config.columns) ? config.columns : [];
    const columnName = (raw: string): string | null => {
      const match = columns.find((column: any) => String(column?.raw ?? "").trim() === raw);
      return typeof match?.name === "string" && match.name ? match.name : null;
    };
    const required = {
      recordId: columnName("record_id"),
      date: columnName("日期"),
      platform: columnName("平台"),
      businessMode: columnName("业务模式"),
      shop: columnName("店铺"),
      operator: columnName("运营"),
    };
    if (Object.values(required).some((value) => !value)) {
      throw new FrontProfitValidationError([{ code: "EXISTING_SOURCE_UNREADABLE" }]);
    }

    let rows: Array<Record<string, unknown>>;
    try {
      const tableRef = await resolveExistingRuntimeTableReferenceFromSql(
        `${FILE_TABLE_PREFIX}${source.id}`,
        executor,
      );
      if (!tableRef) throw new Error("front-profit source table is missing");
      rows = await executor.unsafe(
        `SELECT ${quoteSqlIdentifier(required.recordId!)} AS "record_id", `
        + `${quoteSqlIdentifier(required.date!)} AS "date", `
        + `${quoteSqlIdentifier(required.platform!)} AS "platform", `
        + `${quoteSqlIdentifier(required.businessMode!)} AS "business_mode", `
        + `${quoteSqlIdentifier(required.shop!)} AS "shop", `
        + `${quoteSqlIdentifier(required.operator!)} AS "operator" FROM ${tableRef}`,
      ) as Array<Record<string, unknown>>;
    } catch {
      throw new FrontProfitValidationError([{ code: "EXISTING_SOURCE_UNREADABLE" }]);
    }

    for (const row of rows) {
      const recordId = String(row.record_id ?? "").trim();
      const existingRecord = incomingByRecordId.get(recordId);
      if (existingRecord) {
        issues.push({ code: "DUPLICATE_RECORD_ID_EXISTING", rowNumber: existingRecord.rowNumber });
      }
      const storedDateText = String(row.date ?? "").trim();
      const storedDate = normalizeFrontProfitDate(row.date)
        ?? (/^\d{4}-\d{2}-\d{2}(?=[ T])/.exec(storedDateText)?.[0] ?? "");
      const values = {
        date: storedDate,
        platform: String(row.platform ?? "").trim(),
        businessMode: String(row.business_mode ?? "").trim(),
        shop: String(row.shop ?? "").trim(),
        operator: String(row.operator ?? "").trim(),
      };
      if (Object.values(values).every(Boolean)) {
        const existingKey = frontProfitAggregationKey(values);
        const existingAggregation = incomingByAggregationKey.get(existingKey);
        if (existingAggregation) {
          issues.push({
            code: "DUPLICATE_AGGREGATION_KEY_EXISTING",
            rowNumber: existingAggregation.rowNumber,
          });
        }
      }
    }
  }

  if (issues.length > 0) throw new FrontProfitValidationError(issues);
}

async function publishedDataSourceReferences(tx: any, id: number): Promise<DataSourcePublishedReference[]> {
  const references = await tx.unsafe(
    `SELECT pv.id AS publish_version_id,
            pv.module_code,
            pv.scope_key,
            pv.version_no
     FROM public.publish_version_source pvs
     INNER JOIN public.publish_version pv ON pv.id = pvs.publish_version_id
     WHERE pvs.source_id = $1 AND pv.status = 'published'
     ORDER BY pv.id
     LIMIT 20`,
    [id],
  ) as Array<{
    publish_version_id: number | string;
    module_code: string;
    scope_key: string;
    version_no: number | string;
  }>;
  return references.map((reference) => ({
    publishVersionId: Number(reference.publish_version_id),
    moduleCode: String(reference.module_code),
    scopeKey: String(reference.scope_key),
    versionNo: Number(reference.version_no),
  }));
}

export async function assertDataSourceNotReferencedByPublishedVersion(tx: any, id: number): Promise<void> {
  const references = await publishedDataSourceReferences(tx, id);
  if (references.length > 0) {
    throw new DataSourceDeleteBlockedError(id, references);
  }
}

async function assertFileSourceNotReferencedByPublishedVersion(tx: any, id: number): Promise<void> {
  const references = await publishedDataSourceReferences(tx, id);
  if (references.length > 0) {
    throw new FileSourceDeleteBlockedError(id, references);
  }
}

async function deleteFileSourceContentsInTransaction(tx: any, id: number): Promise<void> {
  const tableName = `${FILE_TABLE_PREFIX}${id}`;
  const dsets = await tx`SELECT id FROM public.datasets WHERE source_id = ${id}`;
  const dsetIds = dsets.map((d: any) => d.id);
  if (dsetIds.length) {
    await tx`DELETE FROM public.charts WHERE dataset_id IN ${tx(dsetIds)}`;
    await tx`DELETE FROM public.datasets WHERE source_id = ${id}`;
  }
  await tx`DELETE FROM public.data_sources WHERE id = ${id}`;
  // 核验修复（CRITICAL）：清 default 路径写进 unified_* 表的残留行。
  // 旧实现只 DROP uf 表，不清 unified——替换上传换了新 sourceId 后，
  // default-transform 的幂等 DELETE 只按新 _source_id 清理，旧行永久残留 → GMV/花费双计。
  // 这里按 _source_id = 本文件 id，扫所有带 _source_id 列的 unified_* 表删掉。
  const unifiedTables = (await tx.unsafe(
    `SELECT DISTINCT c.table_schema, c.table_name FROM information_schema.columns c
     WHERE c.column_name = '_source_id' AND c.table_name LIKE 'unified_%'
        AND c.table_schema IN ('public', 'user_data')`,
  )) as Array<{ table_schema: "public" | "user_data"; table_name: string }>;
  for (const t of unifiedTables) {
    const tableRef = schemaTableReference(t.table_schema, t.table_name);
    await tx.unsafe(`DELETE FROM ${tableRef} WHERE "_source_id" = ${id}`);
  }
  for (const schema of ["user_data", "public"] as const) {
    await tx.unsafe(`DROP TABLE IF EXISTS ${schemaTableReference(schema, tableName)}`);
  }
}

function buildImportedColumns(headerRow: unknown[]): Array<{ raw: string; name: string }> {
  const used = new Set<string>(["id"]);
  return headerRow.map((header, index) => {
    const raw = String(header ?? `col_${index}`);
    let name = normalizeColumnName(raw, index);
    if (used.has(name)) {
      let suffix = 2;
      let candidate = `${name}_${suffix}`;
      while (used.has(candidate)) candidate = `${name}_${++suffix}`;
      name = candidate;
    }
    used.add(name);
    return { raw, name };
  });
}

export async function deleteFileSourceInTransaction(tx: any, id: number): Promise<void> {
  await tx.unsafe(
    "SELECT id FROM public.data_sources WHERE id = $1 FOR UPDATE",
    [id],
  );
  await assertFileSourceNotReferencedByPublishedVersion(tx, id);
  await deleteFileSourceContentsInTransaction(tx, id);
}

export async function deleteFileSourcesAtomically(
  ids: readonly number[],
  database: Pick<typeof sql, "begin"> = sql,
): Promise<number> {
  const uniqueIds = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (uniqueIds.length === 0) return 0;

  return database.begin(async (tx) => {
    const sources = await tx.unsafe(
      `SELECT id, type FROM public.data_sources
       WHERE id = ANY($1::bigint[])
       ORDER BY array_position($1::bigint[], id)
       FOR UPDATE`,
      [uniqueIds],
    ) as Array<{ id: number | string; type: string }>;
    const fileIds = sources
      .filter((source) => source.type === "file")
      .map((source) => Number(source.id));

    // Complete the full protection preflight before the first destructive query.
    for (const id of fileIds) {
      await assertFileSourceNotReferencedByPublishedVersion(tx, id);
    }
    for (const id of fileIds) {
      await deleteFileSourceContentsInTransaction(tx, id);
    }
    return fileIds.length;
  });
}

// 级联删除一个文件数据源（charts -> datasets -> data_source -> 清 unified 残留 -> DROP 表），事务保证原子
export async function deleteFileSource(id: number): Promise<void> {
  await sql.begin(async (tx) => deleteFileSourceInTransaction(tx, id));
}

// 导入一个 Excel/CSV buffer → 建 uf 表。role: 'file' | 'brand_dict'。replaceExisting: 同 originalFileName 先删。group: 分组标签(文件夹名)
export async function importExcel(
  buf: ArrayBuffer | Buffer,
  originalFileName: string,
  displayName: string,
  role: string = "file", // V0.25+: 任意 role 字符串（brand_dict / cost_dict / shop_pic_dict / file）
  replaceExisting = false,
  group: string | null = null,
  moduleCode: string | null = null, // V0.27: 用户上传时指定的归属模块（不传则 ETL 时自动匹配）
  requiredDataContract: typeof FRONT_PROFIT_STANDARD_SCHEMA_VERSION | null = null,
  options: ImportExcelOptions = {},
): Promise<ImportResult> {
  const bytes = buf instanceof Buffer ? buf : Buffer.from(new Uint8Array(buf));
  // 所有上传和文件夹扫描入口共用同一层 fail-closed ZIP 预检，并在受资源限制的
  // Worker 中调用 SheetJS。这样压缩炸弹、恶意工作表范围或解析器卡死都不会先占满 API 主线程。
  const { sheetName, rows } = await parseSpreadsheetRows(bytes, originalFileName, {
    ...(options.sheetName ? { sheetName: options.sheetName } : {}),
  });
  // A single preparation boundary owns header detection, blank-row rejection and
  // optional wide-to-long shaping.  Nothing below this point can persist a fully
  // blank record.
  const prepared = prepareTabularSheet(rows, {
    shapeMode: options.shapeMode,
    headerRows: options.headerRows,
    headerStartRow: options.headerStartRow,
  });
  const headerIdx = prepared.headerRowIndex;
  const headerRow = prepared.headerRow;
  const dataRows = prepared.dataRows;

  const maxRows = role === "brand_dict" ? MAX_ROWS_DICT : MAX_ROWS_DEFAULT;
  if (dataRows.length > maxRows) throw new Error(`数据 ${dataRows.length} 行，超过上限 ${maxRows} 行`);

  // 列规范化 + 去重（避开主键 id）
  const cols = buildImportedColumns(headerRow);

  const cleanFileName = originalFileName
    .replaceAll("\\", "/")
    .split("/")
    .pop()!
    .normalize("NFC");

  if (isFrontProfitPreparationWorkbook(cleanFileName)) {
    throw new FrontProfitValidationError([{ code: "PREPARATION_WORKBOOK_NOT_UPLOADABLE" }]);
  }

  // 前台利润模块接收的是“已经计算好的标准表”，不是原始费用源。这里在任何
  // 同名源删除或数据库写入之前复核 28 列合同和三项计算结果，避免错误结果
  // 被默认转换器宽松解析后静默进入看板。
  let frontProfitValidation: FrontProfitValidationResult | null = null;
  let importSummary: FrontProfitImportSummary | undefined;
  let frontProfitPeriods: string[] = [];
  let frontProfitScopeKeys: string[] = [];
  const recognizedFrontProfit = isFrontProfitStandardSheet(headerRow, cleanFileName);
  if (
    requiredDataContract === FRONT_PROFIT_STANDARD_SCHEMA_VERSION
    && !recognizedFrontProfit
  ) {
    throw new FrontProfitValidationError([{ code: "FRONT_PROFIT_CONTRACT_REQUIRED" }]);
  }
  if (recognizedFrontProfit) {
    const contract = canonicalRowsContract({
      headers: headerRow,
      dataRows,
      firstDataRowNumber: headerIdx + 2,
    });
    frontProfitValidation = contract.validation;
    frontProfitPeriods = contract.periods;
    frontProfitScopeKeys = contract.scopeKeys;
    importSummary = contract.summary;
  }

  const sourceConfig = {
    sheetName,
    rowCount: dataRows.length,
    columns: cols,
    originalFileName: cleanFileName,
    ...(options.parentOriginalFileName
      ? { parentOriginalFileName: options.parentOriginalFileName }
      : {}),
    importMode: options.importMode ?? "single-sheet/v1",
    uploadedAt: new Date().toISOString(),
    role,
    group,
    ...(moduleCode ? { moduleCode } : {}),
    ...(options.systemMetadata ? { systemMetadata: { ...options.systemMetadata } } : {}),
    ...(role === "brand_dict" ? { brandDict: detectBrandDictCols(cols) } : {}),
    quality: prepared.quality,
    ...(prepared.headerProcessing ? { headerProcessing: prepared.headerProcessing } : {}),
    ...(prepared.transform ? { transform: prepared.transform } : {}),
    ...(importSummary ? { frontProfitValidation: importSummary } : {}),
    ...(frontProfitPeriods.length
      ? {
          frontProfitPeriods,
          frontProfitScopeKeys,
          frontProfitAuthority: "manual",
        }
      : {}),
  };

  const persistRows = async (executor: any, sourceId: number): Promise<ImportResult> => {
    const tableName = `${FILE_TABLE_PREFIX}${sourceId}`;
    const tableRef = runtimeTableReference(tableName);
    const colDefs = cols.map((c) => `"${c.name}" TEXT`).join(", ");
    await executor.unsafe(`CREATE TABLE IF NOT EXISTS ${tableRef} (id BIGSERIAL PRIMARY KEY, ${colDefs})`);

    const colNames = cols.map((c) => `"${c.name}"`).join(", ");
    const BATCH = importInsertBatchSize(cols.length);
    for (let i = 0; i < dataRows.length; i += BATCH) {
      const slice = dataRows.slice(i, i + BATCH);
      if (!slice.length) continue;
      const placeholders: string[] = [];
      const params: any[] = [];
      let pIdx = 1;
      for (const row of slice) {
        placeholders.push(`(${cols.map(() => `$${pIdx++}`).join(", ")})`);
        cols.forEach((_, ci) => {
          params.push(serializeImportedCellValue((row as any[])[ci]));
        });
      }
      await executor.unsafe(
        `INSERT INTO ${tableRef} (${colNames}) VALUES ${placeholders.join(", ")}`,
        params,
      );
    }

    return {
      sourceId,
      tableName,
      rowCount: dataRows.length,
      columns: cols,
      quality: prepared.quality,
      ...(prepared.headerProcessing ? { headerProcessing: prepared.headerProcessing } : {}),
      ...(prepared.transform ? { transform: prepared.transform } : {}),
      ...(importSummary ? { frontProfitValidation: importSummary } : {}),
    };
  };

  if (frontProfitValidation) {
    // The advisory transaction lock serializes imports across API processes and
    // replicas. Acquire it before reading existing identities so the second
    // transaction observes the first transaction's committed source and fails
    // duplicate validation instead of writing a second accounting result.
    return sql.begin(async (tx) => {
      await tx.unsafe(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [FRONT_PROFIT_LOCK_KEY],
      );
      try {
        await assertFrontProfitManualImportAuthority(tx, frontProfitPeriods, {
          actorId: options.actorId,
          today: options.today,
        });
      } catch (error) {
        if (error instanceof FrontProfitAuthorityError) {
          throw new FrontProfitValidationError(frontProfitAuthorityIssues(error));
        }
        throw error;
      }
      const existing = await tx.unsafe(
        "SELECT id, config FROM public.data_sources WHERE type = 'file' ORDER BY id",
      ) as Array<{ id: number; config: unknown }>;
      const retainedSources = replaceExisting
        ? existing.filter((source) => storedFileName(source) !== cleanFileName)
        : existing;
      const duplicateScopeSources = await frontProfitDuplicateScopeSources(
        frontProfitScopeKeys,
        retainedSources,
        tx,
      );
      await assertNoExistingFrontProfitIdentity(frontProfitValidation, duplicateScopeSources, tx);

      if (replaceExisting) {
        for (const e of existing) {
          if (storedFileName(e) === cleanFileName) {
            await deleteFileSourceInTransaction(tx, e.id);
          }
        }
      }
      const inserted = await tx.unsafe(
        `INSERT INTO public.data_sources (name, type, platform, config, status)
         VALUES ($1, 'file', NULL, $2::jsonb, 'active') RETURNING id`,
        [displayName, JSON.stringify(sourceConfig)],
      ) as Array<{ id: number | string }>;
      const sourceId = Number(inserted[0]?.id);
      if (!Number.isSafeInteger(sourceId) || sourceId <= 0) {
        throw new Error("Failed to create front-profit data source");
      }
      return persistRows(tx, sourceId);
    });
  }

  // Keep the lightweight process-local queue to avoid tying up multiple pool
  // connections in one API process. The PostgreSQL transaction-scoped advisory
  // lock is the actual cross-process serialization boundary. A namespaced,
  // normalized filename is hashed to 64 bits so unrelated advisory-lock users
  // cannot share this key space and hash collisions are far less likely than
  // with PostgreSQL's 32-bit hashtext().
  return withKeyedLock(cleanFileName, async () => {
    return sql.begin(async (tx) => {
      await tx.unsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${GENERIC_FILE_IMPORT_LOCK_NAMESPACE}${cleanFileName}`],
      );

      const existing = await tx.unsafe(
        `SELECT id, config FROM public.data_sources
         WHERE type = 'file' AND config->>'originalFileName' = $1
         ORDER BY id`,
        [cleanFileName],
      ) as Array<{ id: number; config: unknown }>;
      if (replaceExisting) {
        for (const e of existing) {
          if (storedFileName(e) === cleanFileName) {
            await deleteFileSourceInTransaction(tx, e.id);
          }
        }
      }

      const inserted = await tx.unsafe(
        `INSERT INTO public.data_sources (name, type, platform, config, status)
         VALUES ($1, 'file', NULL, $2::jsonb, 'active') RETURNING id`,
        [displayName, JSON.stringify(sourceConfig)],
      ) as Array<{ id: number | string }>;
      const sourceId = Number(inserted[0]?.id);
      if (!Number.isSafeInteger(sourceId) || sourceId <= 0) {
        throw new Error("Failed to create file data source");
      }
      return persistRows(tx, sourceId);
    });
  });
}

function splitWorkbookFileName(parentFileName: string, sheetName: string, index: number): string {
  const extensionMatch = parentFileName.match(/(\.[^.]+)$/);
  const extension = extensionMatch?.[1] ?? ".xlsx";
  const stem = parentFileName.slice(0, extensionMatch ? -extension.length : undefined).slice(0, 120);
  const safeSheet = sheetName
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 48) || `sheet_${index + 1}`;
  return `${stem}__sheet_${String(index + 1).padStart(2, "0")}_${safeSheet}${extension}`;
}

/**
 * Split every non-empty sheet into an independent file source, but publish all
 * sources in one transaction.  A malformed sheet or blocked replacement rolls
 * back the entire workbook, so callers never observe a half-imported workbook.
 */
export async function importWorkbookSheets(
  buf: ArrayBuffer | Buffer,
  originalFileName: string,
  displayName: string,
  replaceExisting = false,
  group: string | null = null,
  moduleCode: string | null = null,
  options: Pick<ImportExcelOptions, "actorId" | "shapeMode" | "headerRows" | "headerStartRow"> = {},
): Promise<MultiSheetImportResult> {
  const bytes = buf instanceof Buffer ? buf : Buffer.from(new Uint8Array(buf));
  const cleanParentFileName = originalFileName
    .replaceAll("\\", "/")
    .split("/")
    .pop()!
    .normalize("NFC");
  if (isFrontProfitPreparationWorkbook(cleanParentFileName)) {
    throw new FrontProfitValidationError([{ code: "PREPARATION_WORKBOOK_NOT_UPLOADABLE" }]);
  }

  const sheetNames = await listSpreadsheetSheetNames(bytes, cleanParentFileName);
  const skippedSheets: MultiSheetImportResult["skippedSheets"] = [];
  const preparedSheets: Array<{
    sheetName: string;
    derivedFileName: string;
    columns: Array<{ raw: string; name: string }>;
    dataRows: unknown[][];
    quality: TabularImportQuality;
    headerProcessing?: HeaderProcessingSummary;
    transform?: WideToLongSummary;
  }> = [];
  let workbookBudget = emptyWorkbookImportBudget();

  for (let index = 0; index < sheetNames.length; index += 1) {
    const sheetName = sheetNames[index];
    const parsed = await parseSpreadsheetRows(bytes, cleanParentFileName, { sheetName });
    const hasAnyCell = parsed.rows.some((row) => row.some((cell) => (
      cell != null && (typeof cell !== "string" || cell.trim() !== "")
    )));
    if (!hasAnyCell) {
      skippedSheets.push({ sheetName, reason: "empty" });
      continue;
    }
    const prepared = prepareTabularSheet(parsed.rows, {
      shapeMode: options.shapeMode,
      headerRows: options.headerRows,
      headerStartRow: options.headerStartRow,
    });
    if (prepared.dataRows.length > MAX_ROWS_DEFAULT) {
      throw new Error(
        `工作表「${sheetName}」转换后 ${prepared.dataRows.length} 行，超过上限 ${MAX_ROWS_DEFAULT} 行`,
      );
    }
    workbookBudget = addWorkbookSheetToBudget(workbookBudget, sheetName, prepared.dataRows);
    preparedSheets.push({
      sheetName,
      derivedFileName: splitWorkbookFileName(cleanParentFileName, sheetName, index),
      columns: buildImportedColumns(prepared.headerRow),
      dataRows: prepared.dataRows,
      quality: prepared.quality,
      ...(prepared.headerProcessing ? { headerProcessing: prepared.headerProcessing } : {}),
      ...(prepared.transform ? { transform: prepared.transform } : {}),
    });
  }
  if (preparedSheets.length === 0) {
    throw new Error("工作簿没有可导入的非空工作表");
  }

  return withKeyedLock(cleanParentFileName, async () => sql.begin(async (tx) => {
    await tx.unsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${GENERIC_FILE_IMPORT_LOCK_NAMESPACE}${cleanParentFileName}`],
    );
    const existing = await tx.unsafe(
      `SELECT id, config FROM public.data_sources
       WHERE type = 'file'
         AND (config->>'parentOriginalFileName' = $1 OR config->>'originalFileName' = $1)
       ORDER BY id
       FOR UPDATE`,
      [cleanParentFileName],
    ) as Array<{ id: number; config: unknown }>;
    if (existing.length > 0 && !replaceExisting) {
      const conflict = new Error("同名工作簿已存在");
      (conflict as any).code = "MULTI_SHEET_NAME_CONFLICT";
      throw conflict;
    }
    for (const source of existing) {
      await deleteFileSourceInTransaction(tx, Number(source.id));
    }

    const results: ImportResult[] = [];
    for (const sheet of preparedSheets) {
      const sourceConfig = {
        sheetName: sheet.sheetName,
        rowCount: sheet.dataRows.length,
        columns: sheet.columns,
        originalFileName: sheet.derivedFileName,
        parentOriginalFileName: cleanParentFileName,
        importMode: "multi-sheet/v1",
        uploadedAt: new Date().toISOString(),
        role: "file",
        group,
        ...(moduleCode ? { moduleCode } : {}),
        quality: sheet.quality,
        ...(sheet.headerProcessing ? { headerProcessing: sheet.headerProcessing } : {}),
        ...(sheet.transform ? { transform: sheet.transform } : {}),
      };
      const inserted = await tx.unsafe(
        `INSERT INTO public.data_sources (name, type, platform, config, status)
         VALUES ($1, 'file', NULL, $2::jsonb, 'active') RETURNING id`,
        [`${displayName} · ${sheet.sheetName}`, JSON.stringify(sourceConfig)],
      ) as Array<{ id: number | string }>;
      const sourceId = Number(inserted[0]?.id);
      if (!Number.isSafeInteger(sourceId) || sourceId <= 0) {
        throw new Error("Failed to create split workbook data source");
      }

      const tableName = `${FILE_TABLE_PREFIX}${sourceId}`;
      const tableRef = runtimeTableReference(tableName);
      const colDefs = sheet.columns.map((column) => `"${column.name}" TEXT`).join(", ");
      await tx.unsafe(`CREATE TABLE ${tableRef} (id BIGSERIAL PRIMARY KEY, ${colDefs})`);
      const colNames = sheet.columns.map((column) => `"${column.name}"`).join(", ");
      const batchSize = importInsertBatchSize(sheet.columns.length);
      for (let offset = 0; offset < sheet.dataRows.length; offset += batchSize) {
        const batch = sheet.dataRows.slice(offset, offset + batchSize);
        const placeholders: string[] = [];
        const parameters: Array<string | null> = [];
        let parameterIndex = 1;
        for (const row of batch) {
          placeholders.push(`(${sheet.columns.map(() => `$${parameterIndex++}`).join(", ")})`);
          for (let columnIndex = 0; columnIndex < sheet.columns.length; columnIndex += 1) {
            parameters.push(serializeImportedCellValue(row[columnIndex]));
          }
        }
        await tx.unsafe(
          `INSERT INTO ${tableRef} (${colNames}) VALUES ${placeholders.join(", ")}`,
          parameters,
        );
      }
      results.push({
        sourceId,
        tableName,
        rowCount: sheet.dataRows.length,
        columns: sheet.columns,
        quality: sheet.quality,
        ...(sheet.headerProcessing ? { headerProcessing: sheet.headerProcessing } : {}),
        ...(sheet.transform ? { transform: sheet.transform } : {}),
      });
    }
    return {
      sources: results,
      rowCount: results.reduce((sum, result) => sum + result.rowCount, 0),
      sheetCount: results.length,
      skippedSheets,
    };
  }));
}
