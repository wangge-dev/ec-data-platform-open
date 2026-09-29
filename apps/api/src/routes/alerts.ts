// 预警引擎路由（V0.18+，V0.20 抽公共执行器到 modules/alerts-engine）
// POST /api/alerts/run    手动跑一次全量规则（或指定模块）→ 命中行写入 alerts 表
// GET  /api/alerts        预警事件列表（按时间倒序）
// GET  /api/alerts/rules  当前所有声明的规则（含模块来源）
// GET  /api/alerts/schedule  当前定时调度状态
// POST /api/alerts/:id/ack 标记已读
// POST /api/alerts/:id/close 关闭事件
// DELETE /api/alerts/clear 清空所有事件（重跑用）
import { Hono } from "hono";
import { parseBoundedQueryInteger } from "../lib/query-pagination";
import { sql } from "../db/client";
import { authMiddleware } from "../lib/auth";
import { adminGuard } from "../lib/admin-guard";
import { loadModules } from "../modules/loader";
import { runAlerts } from "../modules/alerts-engine";
import { getScheduleStatus } from "../modules/scheduler";

const r = new Hono();
r.use("*", authMiddleware);

// 跑一次规则（全量 / 指定模块）
r.post("/run", async (c) => {
  let moduleCode: string | undefined;
  try {
    const body = await c.req.json().catch(() => ({}));
    moduleCode = body?.module ?? undefined;
  } catch {}

  const mods = await loadModules();
  if (moduleCode && !mods.find((m) => m.code === moduleCode)) {
    return c.json({ ok: false, message: `模块 ${moduleCode} 不存在` }, 404);
  }
  if (!mods.length) {
    return c.json({ ok: false, message: "无模块" }, 404);
  }

  const result = await runAlerts(moduleCode);
  return c.json({ ok: true, data: result });
});

// 列表（按触发时间倒序）
r.get("/", async (c) => {
  const status = c.req.query("status"); // open/ack/closed/all
  const severity = c.req.query("severity");
  const moduleCode = c.req.query("module");
  const limit = parseBoundedQueryInteger(c.req.query("limit"), {
    defaultValue: 200,
    minimum: 1,
    maximum: 500,
  });

  const conds: string[] = [];
  const params: any[] = [];
  let pIdx = 1;
  if (status && status !== "all") {
    conds.push(`status = $${pIdx++}`);
    params.push(status);
  }
  if (severity) {
    conds.push(`severity = $${pIdx++}`);
    params.push(severity);
  }
  if (moduleCode) {
    conds.push(`module_code = $${pIdx++}`);
    params.push(moduleCode);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = await sql.unsafe(
    `SELECT id, module_code AS "moduleCode", rule_key AS "ruleKey", rule_label AS "ruleLabel",
            severity, message, detail, status,
            triggered_at AS "triggeredAt", resolved_at AS "resolvedAt"
     FROM public.alerts ${where} ORDER BY triggered_at DESC LIMIT ${limit}`,
    params,
  );

  const [{ openTotal }] = (await sql.unsafe(
    `SELECT COUNT(*)::int AS "openTotal" FROM public.alerts WHERE status = 'open'`,
  )) as any[];
  const bySev = (await sql.unsafe(
    `SELECT severity, COUNT(*)::int AS n FROM public.alerts WHERE status = 'open' GROUP BY severity`,
  )) as any[];

  return c.json({ ok: true, data: { rows, summary: { openTotal, bySev } } });
});

// 列出当前所有规则（含模块来源）
r.get("/rules", async (c) => {
  const mods = await loadModules();
  const rules: any[] = [];
  for (const mod of mods) {
    for (const rule of mod.alerts ?? []) {
      rules.push({
        moduleCode: mod.code,
        moduleName: mod.name,
        key: rule.key,
        label: rule.label,
        severity: rule.severity,
        enabled: rule.enabled,
        sql: rule.sql,
        message: rule.message,
      });
    }
  }
  return c.json({ ok: true, data: rules });
});

// 当前调度状态（V0.20+）
r.get("/schedule", async (c) => {
  const status = getScheduleStatus();
  return c.json({ ok: true, data: status });
});

// 标记 ack
r.post("/:id{[0-9]+}/ack", async (c) => {
  const id = Number(c.req.param("id"));
  await sql.unsafe(`UPDATE public.alerts SET status = 'ack' WHERE id = $1`, [id]);
  return c.json({ ok: true });
});

// 关闭
r.post("/:id{[0-9]+}/close", async (c) => {
  const id = Number(c.req.param("id"));
  await sql.unsafe(
    `UPDATE public.alerts SET status = 'closed', resolved_at = NOW() WHERE id = $1`,
    [id],
  );
  return c.json({ ok: true });
});

// 清空所有事件（重跑用）
r.delete("/clear", adminGuard, async (c) => {
  await sql.unsafe(`TRUNCATE public.alerts`);
  return c.json({ ok: true });
});

export default r;
