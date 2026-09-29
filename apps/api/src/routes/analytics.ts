// 分析中心后端（V0.23+）
// 跨模块视图：KPI 横条 / TOP 异常店铺 / 全局趋势
import { Hono } from "hono";
import { parseBoundedQueryInteger } from "../lib/query-pagination";
import { sql } from "../db/client";
import { authMiddleware } from "../lib/auth";
import { loadModules, moduleTableName } from "../modules/loader";
import { resolveExistingRuntimeTableFromSql } from "../db/table-scope";

const r = new Hono();
r.use("*", authMiddleware);

/**
 * GET /api/analytics/overview
 * 返回跨模块概要 KPI（今日 GMV、订单数、预警数、模块数等）
 * 自动探测每个模块的 metric/timeKey/dim 列存在性，没有就跳过
 */
r.get("/overview", async (c) => {
  const mods = await loadModules();

  // V0.27：支持日期范围（from/to）。传了按范围算 GMV；没传保持"最新一天"逻辑。
  const from = c.req.query("from");
  const to = c.req.query("to");
  const useRange = !!(from && to);

  // 1. 模块计数
  const moduleCount = mods.filter((m) => m.enabled).length;

  // 2. 最新有数据日的 GMV（B3 V0.24：改'今日 GMV'为'最新可用日 GMV'，否则订单数据落后一天永远 ¥0）
  // 找所有 timeKey + amount/gmv 模块里最新的一天，把该日各模块 amount 求和
  let latestDate: string | null = null;
  let latestDateGmv = 0;
  let latestDateOrders = 0;
  if (useRange) {
    // 按日期范围算：各 timeKey+amount 模块在 [from, to] 的 amount 合计
    for (const mod of mods) {
      if (!mod.enabled || !mod.timeKey) continue;
      const tableName = moduleTableName(mod);
      try {
        const table = await resolveExistingRuntimeTableFromSql(tableName, sql);
        if (!table) continue;
        const tableRef = table.reference;
        const tableSchema = table.schema;
        const cols = (await sql.unsafe(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
          [tableSchema, tableName],
        )) as any[];
        const colSet = new Set<string>(cols.map((c: any) => c.column_name));
        const metricCol = colSet.has("amount") ? "amount" : colSet.has("gmv") ? "gmv" : null;
        if (!metricCol) continue;
        const [r] = (await sql.unsafe(
          `SELECT COALESCE(SUM("${metricCol}"), 0)::numeric AS sum, COUNT(*)::int AS n
           FROM ${tableRef} WHERE "${mod.timeKey}"::date BETWEEN $1::date AND $2::date`,
          [from, to],
        )) as any[];
        latestDateGmv += Number(r?.sum) || 0;
        latestDateOrders += Number(r?.n) || 0;
      } catch {}
    }
    latestDate = `${from}~${to}`;
  } else {
    for (const mod of mods) {
      if (!mod.enabled || !mod.timeKey) continue;
      const tableName = moduleTableName(mod);
      try {
        const table = await resolveExistingRuntimeTableFromSql(tableName, sql);
        if (!table) continue;
        const tableRef = table.reference;
        const tableSchema = table.schema;

        const cols = (await sql.unsafe(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
          [tableSchema, tableName],
        )) as any[];
        const colSet = new Set<string>(cols.map((c: any) => c.column_name));
        const metricCol = colSet.has("amount") ? "amount" : colSet.has("gmv") ? "gmv" : null;
        if (!metricCol) continue;

        const [latestRow] = (await sql.unsafe(
          `SELECT MAX(DATE("${mod.timeKey}"))::text AS d
           FROM ${tableRef} WHERE "${mod.timeKey}" IS NOT NULL`,
        )) as any[];
        const modLatest = latestRow?.d as string | null;
        if (!modLatest) continue;

        if (!latestDate || modLatest > latestDate) {
          latestDate = modLatest;
          latestDateGmv = 0;
          latestDateOrders = 0;
        }
        if (modLatest === latestDate) {
          const [r] = (await sql.unsafe(
            `SELECT COALESCE(SUM("${metricCol}"), 0)::numeric AS sum, COUNT(*)::int AS n
             FROM ${tableRef} WHERE DATE("${mod.timeKey}") = $1::date`,
            [latestDate],
          )) as any[];
          latestDateGmv += Number(r?.sum) || 0;
          latestDateOrders += Number(r?.n) || 0;
        }
      } catch {}
    }
  }

  // 3. 未处理预警按严重程度
  const [{ openTotal }] = (await sql.unsafe(
    `SELECT COUNT(*)::int AS "openTotal" FROM public.alerts WHERE status = 'open'`,
  )) as any[];
  const bySev = (await sql.unsafe(
    `SELECT severity, COUNT(*)::int AS n FROM public.alerts WHERE status = 'open' GROUP BY severity`,
  )) as any[];

  // 4. 今天触发的预警数（vs 昨天）
  const [{ todayAlerts }] = (await sql.unsafe(
    `SELECT COUNT(*)::int AS "todayAlerts" FROM public.alerts WHERE DATE(triggered_at) = CURRENT_DATE`,
  )) as any[];
  const [{ yestAlerts }] = (await sql.unsafe(
    `SELECT COUNT(*)::int AS "yestAlerts" FROM public.alerts WHERE DATE(triggered_at) = CURRENT_DATE - INTERVAL '1 day'`,
  )) as any[];

  return c.json({
    ok: true,
    data: {
      moduleCount,
      // B3 (V0.24)：从 todayGmv 改成 latestDateGmv，配 latestDate 标签
      latestDate, // YYYY-MM-DD 或 null
      latestDateGmv: Math.round(latestDateGmv * 100) / 100,
      latestDateOrders,
      openTotal,
      bySev,
      todayAlerts,
      yestAlerts,
      asOf: new Date().toISOString(),
    },
  });
});

/**
 * GET /api/analytics/top-alert-shops
 * TOP 异常实体：按"未处理预警条数 + 严重程度加权"排序
 * 从 alerts.detail JSON 字段里抓 shop_id/product_id/pic 等关键标识
 */
r.get("/top-alert-shops", async (c) => {
  const limit = parseBoundedQueryInteger(c.req.query("limit"), {
    defaultValue: 10,
    minimum: 1,
    maximum: 50,
  });

  // detail JSON 里常见的实体字段：shop_id / shop_name / pic / product_id
  // 简化：按 module_code + rule_key 分桶，加权 critical=3 warning=2 info=1
  const rows = (await sql.unsafe(
    `SELECT
       module_code AS "moduleCode",
       rule_key AS "ruleKey",
       rule_label AS "ruleLabel",
       COUNT(*)::int AS n,
       SUM(CASE severity
             WHEN 'critical' THEN 3
             WHEN 'warning' THEN 2
             ELSE 1
           END)::int AS score,
       MAX(severity) AS "topSeverity",
       MAX(triggered_at) AS "latestAt"
     FROM public.alerts
     WHERE status = 'open'
     GROUP BY module_code, rule_key, rule_label
     ORDER BY score DESC, n DESC
     LIMIT ${limit}`,
  )) as any[];

  return c.json({ ok: true, data: rows });
});

/**
 * POST /api/analytics/ack-all
 * 一键已读所有未处理预警（可选 module 限定）
 */
r.post("/ack-all", async (c) => {
  let moduleCode: string | undefined;
  try {
    const body = await c.req.json().catch(() => ({}));
    moduleCode = body?.module ?? undefined;
  } catch {}

  if (moduleCode) {
    const r = await sql.unsafe(
      `UPDATE public.alerts SET status = 'ack' WHERE status = 'open' AND module_code = $1`,
      [moduleCode],
    );
    return c.json({ ok: true, data: { ackedCount: (r as any).count ?? 0, moduleCode } });
  } else {
    const r = await sql.unsafe(
      `UPDATE public.alerts SET status = 'ack' WHERE status = 'open'`,
    );
    return c.json({ ok: true, data: { ackedCount: (r as any).count ?? 0, moduleCode: null } });
  }
});

export default r;
