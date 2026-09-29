// 订单 ETL 路由：对上传的订单表跑 ETL → unified_sales；汇总查询；导出 Excel；扫描文件夹
// V0.17：切到模块化 ETL 引擎（routes 不再直接调 etlOrderSource），订单走 modules/orders.transform.ts 钩子
import { Hono } from "hono";
import * as XLSX from "xlsx";
import { db, sql } from "../db/client";
import { dataSources } from "../db/schema";
import { resolveExistingRuntimeTableFromSql } from "../db/table-scope";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../lib/auth";
import { adminGuard } from "../lib/admin-guard";
import { findBrandDict } from "../services/etl";
import { importExcel } from "../services/import-excel";
import { runModuleEtl } from "../modules/engine";
import { matchFileToPlatform, loadModules, moduleTableName } from "../modules/loader";
import {
  exportUnmatchedOrdersCsv,
  getUnmatchedOrders,
  InvalidUnmatchedPaginationError,
} from "../services/unmatched-orders.js";
import { publicProcessingError } from "../services/public-processing-error.js";
import {
  SafeSpreadsheetDirectory,
} from "../services/safe-spreadsheet-file.js";

export function sanitizeEtlRouteReport<T extends { error?: unknown }>(
  report: T,
): Omit<T, "error"> & { error?: string } {
  if (!report.error) return report as Omit<T, "error"> & { error?: string };
  return {
    ...report,
    error: publicProcessingError(report.error),
  };
}

const r = new Hono();
r.use("*", authMiddleware);

// 订单品牌未匹配诊断（当前只对 orders / unified_sales 提供）
r.get("/unmatched", async (c) => {
  if ((c.req.query("module") || "orders") !== "orders") {
    return c.json({ ok: false, message: "未匹配诊断目前仅支持销售订单模块" }, 400);
  }
  try {
    const data = await getUnmatchedOrders({
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    });
    return c.json({ ok: true, data });
  } catch (error: any) {
    if (error instanceof InvalidUnmatchedPaginationError) {
      return c.json({ ok: false, message: error.message }, 400);
    }
    throw error;
  }
});

r.get("/unmatched/export", async (c) => {
  if ((c.req.query("module") || "orders") !== "orders") {
    return c.json({ ok: false, message: "未匹配诊断目前仅支持销售订单模块" }, 400);
  }
  const csv = await exportUnmatchedOrdersCsv();
  return c.body(csv, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition":
      "attachment; filename=\"unmatched-orders.csv\"; filename*=UTF-8''%E6%9C%AA%E5%8C%B9%E9%85%8D%E8%AE%A2%E5%8D%95.csv",
  });
});

// 对已上传的订单表跑 ETL（自动按文件名识别平台）。
// V0.17 切流：用模块化引擎 runModuleEtl()，由 modules/orders.transform.ts 走原 SQL
// V0.27：支持 moduleCode（上传时存的 data_sources.config.moduleCode 或调用方传），跳过文件名猜测
r.post("/run/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const [src] = await db.select().from(dataSources).where(eq(dataSources.id, id)).limit(1);
  if (!src || src.type !== "file") return c.json({ ok: false, message: "数据源不存在" }, 404);

  // moduleCode 优先级：query > source.config（上传时存）> 无（走自动匹配）
  const moduleCode =
    (c.req.query("moduleCode") as string | undefined) ||
    ((src.config as any)?.moduleCode as string | undefined) ||
    undefined;

  let report;
  try {
    report = await runModuleEtl(
      id,
      moduleCode ? { moduleCode } : undefined,
    );
  } catch (error) {
    console.error("[etl:run] exception", {
      sourceId: id,
      moduleCode,
      error,
    });
    return c.json(
      {
        ok: false,
        data: {
          sourceId: id,
          error: publicProcessingError(error),
        },
      },
      500,
    );
  }
  if (!report) {
    const fileName = (src.config as any)?.originalFileName ?? src.name;
    return c.json({ ok: false, message: `文件 ${fileName} 不属于任何已启用的模块` }, 400);
  }
  if (report.error) {
    console.error("[etl:run] processing failed", {
      sourceId: id,
      moduleCode,
      error: report.error,
    });
    return c.json({
      ok: false,
      data: sanitizeEtlRouteReport(report),
    });
  }
  return c.json({ ok: true, data: report });
});

// 统一表汇总概况
// V0.18：支持 ?module=xxx 选模块，默认 orders（unified_sales）
r.get("/summary", async (c) => {
  const moduleCode = c.req.query("module") || "orders";
  const mods = await loadModules();
  const mod = mods.find((m) => m.code === moduleCode);
  if (!mod) return c.json({ ok: false, message: `模块 ${moduleCode} 不存在` }, 404);

  const tableName = moduleTableName(mod);

  // 查表存在，否则返回空（首次使用没数据时不报错）
  const table = await resolveExistingRuntimeTableFromSql(tableName, sql);
  if (!table) {
    return c.json({
      ok: true,
      data: { total: 0, byPlatform: [], byBrand: [], moduleCode, tableName, empty: true },
    });
  }
  const tableRef = table.reference;
  const tableSchema = table.schema;
  const includedWhere = mod.origin === "user"
    ? `WHERE COALESCE("_included", true) = true`
    : "";

  // 计算分组列：优先 platform/_platform、brand/pic/shop_id 等存在的列
  const cols = (await sql.unsafe(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
    [tableSchema, tableName],
  )) as any[];
  const colSet = new Set<string>(cols.map((c: any) => c.column_name));
  const platformCol = colSet.has("platform")
    ? "platform"
    : colSet.has("_platform") ? "_platform" : null;
  const groupCol = colSet.has("brand")
    ? "brand"
    : colSet.has("pic") ? "pic"
    : colSet.has("shop_id") ? "shop_id"
    : colSet.has("warehouse") ? "warehouse"
    : null;
  // 指标：优先 amount，其次 gmv，再退到 COUNT
  const metricCol = colSet.has("amount")
    ? "amount"
    : colSet.has("gmv") ? "gmv"
    : colSet.has("ads_spend") ? "ads_spend"
    : null;

  const [{ total }] = (await sql.unsafe(
    `SELECT COUNT(*)::int AS total FROM ${tableRef} ${includedWhere}`,
  )) as any[];

  let byPlatform: any[] = [];
  if (platformCol) {
    const metricSelect = metricCol
      ? `COALESCE(SUM("${metricCol}"),0)::numeric AS amount`
      : `0::numeric AS amount`;
    const matchedSelect = colSet.has("matched")
      ? `SUM(matched::int)::int AS matched`
      : colSet.has("_matched")
      ? `SUM("_matched"::int)::int AS matched`
      : `0::int AS matched`;
    byPlatform = (await sql.unsafe(
      `SELECT "${platformCol}" AS platform, COUNT(*)::int AS rows, ${metricSelect}, ${matchedSelect}
       FROM ${tableRef} ${includedWhere} GROUP BY "${platformCol}" ORDER BY amount DESC`,
    )) as any[];
  }

  let byBrand: any[] = [];
  if (groupCol) {
    const metricSelect = metricCol
      ? `COALESCE(SUM("${metricCol}"),0)::numeric AS amount`
      : `0::numeric AS amount`;
    byBrand = (await sql.unsafe(
      `SELECT COALESCE("${groupCol}",'(未匹配)') AS brand, COUNT(*)::int AS rows, ${metricSelect}
       FROM ${tableRef} ${includedWhere} GROUP BY "${groupCol}" ORDER BY amount DESC NULLS LAST LIMIT 50`,
    )) as any[];
  }

  return c.json({
    ok: true,
    data: {
      total,
      byPlatform,
      byBrand,
      moduleCode,
      tableName,
      metricCol,
      groupCol,
      platformCol,
    },
  });
});

// 导出 Excel（按平台分 sheet，金额表格式）
r.get("/export", async (c) => {
  const rows = await sql.unsafe(
    `SELECT platform, product_id, pay_time, qty, amount, main_order_no, shop, operator, brand, order_month
     FROM public.unified_sales ORDER BY platform, pay_time`,
  );
  const wb = XLSX.utils.book_new();
  const platforms = [...new Set(rows.map((r: any) => r.platform))];
  for (const p of platforms) {
    const data = rows
      .filter((r: any) => r.platform === p)
      .map((r: any) => ({
        id: r.product_id,
        下单日期: r.pay_time ? new Date(r.pay_time).toLocaleString("zh-CN") : "",
        数量: r.qty,
        金额: r.amount,
        主订单编号: r.main_order_no,
        店铺: r.shop ?? "",
        运营: r.operator ?? "",
        品牌: r.brand ?? "(未匹配)",
        部门: "",
        组: "",
        小组: "",
        月: r.order_month ?? "",
      }));
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, String(p).slice(0, 31));
  }
  if (!platforms.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["暂无数据"]]), "空");
  const buf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return c.body(buf, 200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="unified_sales.xlsx"`,
  });
});

// 清空统一表（重跑用）
r.delete("/clear", adminGuard, async (c) => {
  await sql.unsafe(`TRUNCATE public.unified_sales`);
  return c.json({ ok: true });
});

// 重跑所有已上传文件的 ETL（兜底：批量上传时个别文件自动 ETL 漏跑/失败，一键补齐）
// 遍历所有 file 类型数据源，逐个 runModuleEtl；字典/未匹配自动跳过。
r.post("/rerun-all", adminGuard, async (c) => {
  const files = await db.select().from(dataSources).where(eq(dataSources.type, "file"));
  const report = { total: files.length, ran: 0, skipped: 0, failed: 0, details: [] as any[] };
  for (const f of files) {
    const moduleCode = (f.config as any)?.moduleCode as string | undefined;
    try {
      const etl = await runModuleEtl(f.id, moduleCode ? { moduleCode } : undefined);
      if (!etl) {
        report.skipped++; // 未匹配任何模块（字典/无关文件）
        continue;
      }
      if (etl.error) {
        console.error("[etl:batch] processing failed", {
          sourceId: f.id,
          error: etl.error,
        });
        report.failed++;
        report.details.push({
          id: f.id,
          name: f.name,
          error: publicProcessingError(etl.error),
        });
      } else {
        report.ran++;
        report.details.push({ id: f.id, platform: etl.platform, inserted: etl.inserted, total: etl.total });
      }
    } catch (e: any) {
      console.error("[etl:batch] exception", {
        sourceId: f.id,
        error: e,
      });
      report.failed++;
      report.details.push({
        id: f.id,
        name: f.name,
        error: publicProcessingError(e),
      });
    }
  }
  return c.json({ ok: true, data: report });
});

// 读/写 扫描文件夹路径
r.get("/folder", adminGuard, async (c) => {
  const [row] = await sql.unsafe(`SELECT value FROM public.settings WHERE key='scan_folder'`);
  return c.json({ ok: true, data: { folder: row?.value ?? "" } });
});
r.post("/folder", adminGuard, async (c) => {
  try {
    const raw = await c.req.text();
    const folder = raw ? (JSON.parse(raw).folder ?? "") : "";
    await sql.unsafe(
      `INSERT INTO public.settings(key,value,updated_at) VALUES('scan_folder',$1,NOW())
       ON CONFLICT(key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [folder],
    );
    return c.json({ ok: true, data: { folder } });
  } catch (e: any) {
    console.error("[etl:scan] save failed", e);
    return c.json({ ok: false, message: "保存失败，请稍后重试" }, 500);
  }
});

// 扫描固定文件夹：自动识别平台 → 导入 → ETL（维护表优先，同名文件替换）
r.post("/scan", adminGuard, async (c) => {
  const user = c.get("user") as { uid?: number } | undefined;
  const [row] = await sql.unsafe(`SELECT value FROM public.settings WHERE key='scan_folder'`);
  const folder = row?.value as string | undefined;
  if (!folder) {
    return c.json({ ok: false, message: "扫描文件夹未配置或不存在，请先在设置里配置" }, 400);
  }
  let scanDirectory: SafeSpreadsheetDirectory | null = null;
  let files: string[];
  try {
    scanDirectory = await SafeSpreadsheetDirectory.open(folder);
    files = await scanDirectory.listSpreadsheetFiles();
  } catch (error) {
    await scanDirectory?.close();
    console.error("[etl:scan] unsafe scan directory", { error });
    return c.json({ ok: false, message: "扫描文件夹不可安全读取，请检查目录设置" }, 400);
  }
  if (!scanDirectory) {
    return c.json({ ok: false, message: "扫描文件夹不可安全读取，请检查目录设置" }, 400);
  }
  const report: any = { folder, fileCount: files.length, dict: null, platforms: [], skipped: [] };
  let dictDirectory: SafeSpreadsheetDirectory | null = null;

  try {

  // 维护表来源（两处都收，方便把维护表和订单文件分开管理）：
  //   ① 主文件夹里文件名含「维护表」的文件
  //   ② 子文件夹 <folder>\维护表\ 里的任意 Excel
  const dictCandidates: { directory: SafeSpreadsheetDirectory; name: string }[] = [];
  for (const f of files) {
    if (f.includes("维护表")) dictCandidates.push({ directory: scanDirectory, name: f });
  }
  try {
    dictDirectory = await scanDirectory.openSubdirectory("维护表");
    if (dictDirectory) {
      for (const f of await dictDirectory.listSpreadsheetFiles()) {
        dictCandidates.push({ directory: dictDirectory, name: f });
      }
    }
  } catch (error) {
    console.error("[etl:scan] unsafe dictionary directory", { error });
    report.dict = { error: "维护表目录不可安全读取，请检查目录设置" };
  }
  // 导入维护表（子文件夹候选排在后面，会覆盖同名，作为最新）
  for (const cand of dictCandidates) {
    try {
      const buf = await cand.directory.readFile(cand.name);
      const res = await importExcel(buf, cand.name, "品牌维护表", "brand_dict", true);
      report.dict = { file: cand.name, rows: res.rowCount };
    } catch (e: any) {
      console.error("[etl:scan] dictionary import failed", {
        file: cand.name,
        error: e,
      });
      report.dict = {
        file: cand.name,
        error: "维护表导入失败，请稍后重试",
      };
    }
  }

  // 兜底：本轮文件夹没有维护表文件，但库里已有品牌字典（之前单独上传）
  // → 沿用已存在的，避免误报"无维护表"（订单照样能关联品牌）
  if (!report.dict) {
    const existing = await findBrandDict();
    if (existing) {
      const [{ rows }] = await sql.unsafe(
        `SELECT COUNT(*)::int AS rows FROM ${existing.tableRef}`,
      );
      report.dict = { table: existing.table, rows, existing: true };
    }
  }

  // 订单文件：用模块化引擎匹配 + 跑 ETL
  for (const f of files) {
    if (f.includes("维护表")) continue;
    const match = await matchFileToPlatform(f);
    if (!match) {
      report.skipped.push(f);
      continue;
    }
    try {
      const buf = await scanDirectory.readFile(f);
      // 显示名加平台前缀，表浏览/AI 出图里一眼能认出是哪个平台的数据（物理表名仍是 uf_<id>）
      const baseName = f.replace(/\.(xlsx|xls|csv)$/i, "");
      const res = await importExcel(
        buf,
        f,
        `${match.platform.name}·${baseName}`,
        "file",
        true,
        null,
        null,
        null,
        { actorId: user?.uid ?? null },
      );
      const etl = await runModuleEtl(res.sourceId);
      if (etl?.error) {
        console.error("[etl:scan] processing failed", {
          sourceId: res.sourceId,
          platform: match.platform.name,
          fileName: f,
          error: etl.error,
        });
        report.platforms.push(sanitizeEtlRouteReport(etl));
      } else if (etl) {
        report.platforms.push(etl);
      }
    } catch (e: any) {
      console.error("[etl:scan] platform import failed", {
        platform: match.platform.name,
        fileName: f,
        error: e,
      });
      report.platforms.push({
        platform: match.platform.name,
        fileName: f,
        error: publicProcessingError(e),
      });
    }
  }

  return c.json({ ok: true, data: report });
  } finally {
    await dictDirectory?.close();
    await scanDirectory.close();
  }
});

export default r;
