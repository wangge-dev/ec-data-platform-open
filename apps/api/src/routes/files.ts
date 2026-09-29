// Excel 上传 + 文件类数据源列表/预览/删除（核心导入逻辑在 services/import-excel.ts）
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { eq, desc } from "drizzle-orm";

import { db, sql } from "../db/client";
import { dataSources } from "../db/schema";
import { authMiddleware, type AuthPayload } from "../lib/auth";
import { adminGuard } from "../lib/admin-guard";
import { parseBoundedQueryInteger } from "../lib/query-pagination";
import {
  importExcel,
  importWorkbookSheets,
  deleteFileSource,
  deleteFileSourcesAtomically,
  FILE_TABLE_PREFIX,
  isFileNameUniqueConflict,
  FileSourceDeleteBlockedError,
} from "../services/import-excel";
import { getModule, matchFileToPlatform } from "../modules/loader";
import { resolveFileAttribution } from "../services/file-attribution";
import {
  FRONT_PROFIT_STANDARD_SCHEMA_VERSION,
  FrontProfitValidationError,
  moduleRequiresFrontProfitStandard,
} from "../services/front-profit-standard";
import {
  importLargeCsvUpload,
  LARGE_CSV_MAX_BYTES,
  LargeCsvImportError,
} from "../services/large-csv-import";
import { SpreadsheetSecurityError } from "../services/spreadsheet-security";
import {
  TabularImportShapeError,
  type HeaderRowCount,
  type ImportShapeMode,
} from "../services/tabular-import-shape";
import { WorkbookImportBudgetError } from "../services/workbook-import-budget";

const r = new Hono<{ Variables: { user: AuthPayload } }>();
r.use("*", authMiddleware);

const MAX_FILE_BYTES = 30 * 1024 * 1024; // 30MB

r.post("/upload-large-csv", adminGuard, async (c) => {
  const contentType = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "text/csv" && contentType !== "application/csv") {
    return c.json({
      ok: false,
      code: "LARGE_CSV_CONTENT_TYPE_UNSUPPORTED",
      message: "百万行流式入口仅接受 text/csv 请求体",
    }, 415);
  }
  const contentEncoding = c.req.header("content-encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    return c.json({
      ok: false,
      code: "LARGE_CSV_CONTENT_ENCODING_UNSUPPORTED",
      message: "百万行流式入口不接受压缩请求体",
    }, 415);
  }
  const contentLengthText = c.req.header("content-length")?.trim();
  if (contentLengthText) {
    const contentLength = Number(contentLengthText);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      return c.json({ ok: false, code: "LARGE_CSV_CONTENT_LENGTH_INVALID", message: "Content-Length 无效" }, 400);
    }
    if (contentLength > LARGE_CSV_MAX_BYTES) {
      return c.json({
        ok: false,
        code: "LARGE_CSV_BYTE_LIMIT_EXCEEDED",
        message: `CSV 文件超过上限 ${LARGE_CSV_MAX_BYTES} 字节`,
      }, 413);
    }
  }

  const replaceText = c.req.query("replaceExisting")?.trim().toLowerCase();
  if (replaceText && replaceText !== "true" && replaceText !== "false") {
    return c.json({
      ok: false,
      code: "LARGE_CSV_REPLACE_FLAG_INVALID",
      message: "replaceExisting 只能是 true 或 false",
    }, 400);
  }
  const moduleCode = c.req.query("moduleCode")?.trim() || null;
  if (moduleCode) {
    const targetModule = await getModule(moduleCode);
    if (!targetModule) {
      return c.json({ ok: false, code: "LARGE_CSV_MODULE_UNKNOWN", message: "指定的归属模块不存在或已停用" }, 400);
    }
    if (moduleRequiresFrontProfitStandard(targetModule)) {
      return c.json({
        ok: false,
        code: "LARGE_CSV_FRONT_PROFIT_UNSUPPORTED",
        message: "前台利润标准表必须使用带完整业务校验的普通上传入口",
      }, 400);
    }
  }

  try {
    const result = await importLargeCsvUpload(c.req.raw.body, {
      originalFileName: c.req.query("filename") ?? "",
      displayName: c.req.query("name"),
      group: c.req.query("group"),
      moduleCode,
      replaceExisting: replaceText === "true",
      role: c.req.query("role"),
      expectedRows: Number(c.req.query("expectedRows")),
    });
    return c.json({ ok: true, data: result });
  } catch (error) {
    if (isFileNameUniqueConflict(error)) {
      return c.json({ ok: false, code: "LARGE_CSV_NAME_CONFLICT", message: "同名文件已存在" }, 409);
    }
    if (error instanceof FileSourceDeleteBlockedError) {
      return c.json({
        ok: false,
        code: error.code,
        message: error.message,
        sourceId: error.sourceId,
        references: error.references,
      }, 409);
    }
    if (error instanceof LargeCsvImportError) {
      return c.json({ ok: false, code: error.code, message: error.message }, error.status);
    }
    console.error("[large-csv-upload] failed", error);
    return c.json({ ok: false, code: "LARGE_CSV_IMPORT_FAILED", message: "百万行 CSV 导入失败" }, 500);
  }
});

r.post(
  "/upload",
  bodyLimit({
    maxSize: MAX_FILE_BYTES,
    onError: (c) =>
      c.json({ ok: false, message: `文件超过上限 ${MAX_FILE_BYTES / 1024 / 1024}MB` }, 413),
  }),
  async (c) => {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ ok: false, message: "上传表单格式无效" }, 400);
    }
    const file = form.get("file") as File | null;
    const name = (form.get("name") as string) || "未命名上传";
    let role = (form.get("role") as string) || "file";
    const group = (form.get("group") as string)?.trim() || null;
    // V0.27：上传时可选指定归属模块（不传则 ETL 时按 filePattern 自动匹配）
    const moduleCode = (form.get("moduleCode") as string)?.trim() || null;
    const sheetMode = ((form.get("sheetMode") as string)?.trim() || "first") as "first" | "all";
    const shapeMode = ((form.get("shapeMode") as string)?.trim() || "table") as ImportShapeMode;
    const headerRowsText = (form.get("headerRows") as string)?.trim() || "1";
    const headerStartRowText = (form.get("headerStartRow") as string)?.trim() || "";
    if (!file) return c.json({ ok: false, message: "缺少文件" }, 400);
    if (sheetMode !== "first" && sheetMode !== "all") {
      return c.json({ ok: false, code: "SHEET_MODE_INVALID", message: "工作表导入模式无效" }, 400);
    }
    if (shapeMode !== "table" && shapeMode !== "date-columns-to-rows") {
      return c.json({ ok: false, code: "SHAPE_MODE_INVALID", message: "表格形态转换模式无效" }, 400);
    }
    if (!/^[123]$/.test(headerRowsText)) {
      return c.json({ ok: false, code: "HEADER_ROWS_INVALID", message: "表头层数只支持 1、2 或 3 行" }, 400);
    }
    const headerRows = Number(headerRowsText) as HeaderRowCount;
    if (headerStartRowText && !/^[1-9]\d{0,5}$/.test(headerStartRowText)) {
      return c.json({
        ok: false,
        code: "HEADER_START_ROW_INVALID",
        message: "表头起始行必须是 1 到 999999 的整数",
      }, 400);
    }
    const headerStartRow = headerStartRowText ? Number(headerStartRowText) : undefined;
    if (headerRows > 1 && shapeMode === "date-columns-to-rows") {
      return c.json({
        ok: false,
        code: "HEADER_ROWS_WITH_WIDE_TO_LONG_UNSUPPORTED",
        message: "多层表头合并不能同时使用日期宽表转长表，请先选择一种处理方式",
      }, 400);
    }
    if (sheetMode === "all" && !/\.xlsx?$/i.test(file.name)) {
      return c.json({ ok: false, code: "MULTI_SHEET_FILE_UNSUPPORTED", message: "多工作表拆分仅适用于 .xlsx / .xls" }, 400);
    }

    // V0.25+：自动识别字典模块——按文件名匹配 isDict=true 模块的 filePattern
    // 用户没显式标 role 时，靠模块声明自动归类
    const VALID_DICT_ROLES = ["brand_dict", "cost_dict", "shop_pic_dict"];
    if (role === "file") {
      try {
        const match = await matchFileToPlatform(file.name);
        if (match?.module.isDict && match.module.role) {
          role = match.module.role;
        }
      } catch {
        // 匹配失败按 file 处理
      }
    }
    // role 校验（防 form 传非法值）
    if (role !== "file" && !VALID_DICT_ROLES.includes(role)) {
      role = "file";
    }
    const user = c.get("user");
    const isAdmin = user?.isAdmin === true;
    if (role !== "file" && !isAdmin) {
      return c.json({ ok: false, message: "字典和维护表仅允许管理员上传" }, 403);
    }
    if (role !== "file" && (
      sheetMode === "all"
      || shapeMode !== "table"
      || headerRows !== 1
      || headerStartRow !== undefined
    )) {
      return c.json({ ok: false, code: "DICT_SHAPING_UNSUPPORTED", message: "维护表仅支持原样导入第一个工作表" }, 400);
    }
    // 编码校验（防 curl/GBK 命令行把中文名编码坏后存进库变永久乱码）
    // 浏览器 fetch 是 UTF-8 不受影响；命令行工具若用 GBK 会让 name 含 U+FFFD 替换字符
    if (name.includes("�") || (group && group.includes("�"))) {
      return c.json(
        {
          ok: false,
          message:
            "名称含无效编码字符（常见于命令行 curl 用 GBK 传中文）。请用浏览器上传，或在脚本里用 UTF-8 编码传 name。",
        },
        400,
      );
    }

    try {
      let requiredDataContract: typeof FRONT_PROFIT_STANDARD_SCHEMA_VERSION | null = null;
      if (moduleCode) {
        const targetModule = await getModule(moduleCode);
        if (!targetModule) throw new Error("指定的归属模块不存在或已停用");
        if (moduleRequiresFrontProfitStandard(targetModule)) {
          requiredDataContract = FRONT_PROFIT_STANDARD_SCHEMA_VERSION;
        }
      }
      if (requiredDataContract && (
        sheetMode === "all"
        || shapeMode !== "table"
        || headerRows !== 1
        || headerStartRow !== undefined
      )) {
        return c.json({
          ok: false,
          code: "FRONT_PROFIT_SHAPING_UNSUPPORTED",
          message: "前台利润标准表必须保持标准单表结构，不能拆分、合并表头或宽表转长表",
        }, 400);
      }
      const ab = await file.arrayBuffer();
      const result = sheetMode === "all"
        ? await importWorkbookSheets(
            ab,
            file.name,
            name,
            isAdmin,
            group,
            moduleCode,
            {
              actorId: user?.uid ?? null,
              shapeMode,
              ...(headerRows > 1 ? { headerRows } : {}),
              ...(headerStartRow !== undefined ? { headerStartRow } : {}),
            },
          )
        : await importExcel(
            ab,
            file.name,
            name,
            role as any,
            isAdmin,
            group,
            moduleCode,
            requiredDataContract,
            {
              actorId: user?.uid ?? null,
              ...(shapeMode === "date-columns-to-rows" ? { shapeMode } : {}),
              ...(headerRows > 1 ? { headerRows } : {}),
              ...(headerStartRow !== undefined ? { headerStartRow } : {}),
            },
          );
      return c.json({ ok: true, data: result });
    } catch (e: any) {
      if (isFileNameUniqueConflict(e)) {
        return c.json({ ok: false, message: "同名文件正在上传，请稍后重试" }, 409);
      }
      if (e instanceof FrontProfitValidationError) {
        return c.json({
          ok: false,
          code: e.code,
          message: e.message,
          issues: e.issues.map(({ code, rowNumber, field }) => ({
            code,
            ...(rowNumber == null ? {} : { rowNumber }),
            ...(field == null ? {} : { field }),
          })),
        }, 400);
      }
      if (e instanceof FileSourceDeleteBlockedError) {
        return c.json({
          ok: false,
          code: e.code,
          message: e.message,
          sourceId: e.sourceId,
          references: e.references,
        }, 409);
      }
      if (
        e instanceof SpreadsheetSecurityError
        || e instanceof TabularImportShapeError
        || e instanceof WorkbookImportBudgetError
      ) {
        return c.json({ ok: false, code: e.code, message: e.message }, 400);
      }
      if (e instanceof Error && (e as any).code === "MULTI_SHEET_NAME_CONFLICT") {
        return c.json({ ok: false, code: "MULTI_SHEET_NAME_CONFLICT", message: e.message }, 409);
      }
      if (e instanceof Error && e.message === "指定的归属模块不存在或已停用") {
        return c.json({ ok: false, message: e.message }, 400);
      }
      console.error("[file-upload] failed", e);
      return c.json({ ok: false, code: "FILE_IMPORT_FAILED", message: "文件导入失败，请稍后重试" }, 500);
    }
  },
);

// 批量删除（级联清理底层 uf_ 表）
r.post("/batch-delete", adminGuard, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const ids: number[] = Array.isArray(body.ids)
    ? body.ids.filter((x: any) => Number.isSafeInteger(x) && x > 0)
    : [];
  if (!ids.length) return c.json({ ok: false, message: "未指定要删除的文件" }, 400);
  try {
    const deleted = await deleteFileSourcesAtomically(ids);
    return c.json({ ok: true, data: { deleted } });
  } catch (e) {
    if (e instanceof FileSourceDeleteBlockedError) {
      return c.json({
        ok: false,
        code: e.code,
        message: e.message,
        sourceId: e.sourceId,
        references: e.references,
      }, 409);
    }
    throw e;
  }
});

// 文件类数据源列表
r.get("/", async (c) => {
  const list = await db
    .select()
    .from(dataSources)
    .where(eq(dataSources.type, "file"))
    .orderBy(desc(dataSources.createdAt));

  // 给每个文件标记归属：明确保存的 moduleCode 优先，文件名匹配只作兜底。
  const enriched = await Promise.all(
    list.map(async (s) => {
      return {
        ...s,
        attribution: await resolveFileAttribution(s, {
          getModule,
          matchFileToPlatform,
        }),
      };
    }),
  );

  return c.json({ ok: true, data: enriched });
});

// 预览数据：分页
r.get("/:id{[0-9]+}/preview", async (c) => {
  const id = Number(c.req.param("id"));
  const limit = parseBoundedQueryInteger(c.req.query("limit"), {
    defaultValue: 50,
    minimum: 1,
    maximum: 500,
  });
  const offset = parseBoundedQueryInteger(c.req.query("offset"), {
    defaultValue: 0,
    minimum: 0,
    maximum: 1_000_000_000,
  });

  const [src] = await db.select().from(dataSources).where(eq(dataSources.id, id)).limit(1);
  if (!src || src.type !== "file") return c.json({ ok: false, message: "文件不存在" }, 404);
  const tableName = `${FILE_TABLE_PREFIX}${id}`;

  const cols = (src.config as any)?.columns as Array<{ raw: string; name: string }> | undefined;
  if (!cols) return c.json({ ok: false, message: "列信息缺失" }, 500);

  const rows = await sql.unsafe(
    `SELECT id, ${cols.map((c) => `"${c.name}"`).join(", ")} FROM "${tableName}" ORDER BY id LIMIT ${limit} OFFSET ${offset}`,
  );
  const [{ count }] = await sql.unsafe(`SELECT COUNT(*)::int AS count FROM "${tableName}"`);

  return c.json({ ok: true, data: { total: count, rows, columns: cols } });
});

// 删文件（级联清理）
r.delete("/:id{[0-9]+}", adminGuard, async (c) => {
  const id = Number(c.req.param("id"));
  const [src] = await db.select().from(dataSources).where(eq(dataSources.id, id)).limit(1);
  if (!src || src.type !== "file") return c.json({ ok: false, message: "文件不存在" }, 404);
  try {
    await deleteFileSource(id);
  } catch (e) {
    if (e instanceof FileSourceDeleteBlockedError) {
      return c.json({
        ok: false,
        code: e.code,
        message: e.message,
        sourceId: e.sourceId,
        references: e.references,
      }, 409);
    }
    throw e;
  }
  return c.json({ ok: true });
});

export default r;
