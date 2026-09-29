// 设置（用户信息 / DeepSeek 用量统计 / 系统连通）
import { Hono } from "hono";
import { z } from "zod";
import { eq, sql as drizzleSql } from "drizzle-orm";

import { db, sql } from "../db/client";
import { settings, agentRuns } from "../db/schema";
import { authMiddleware } from "../lib/auth";
import { adminGuard } from "../lib/admin-guard";

const r = new Hono();
r.use("*", authMiddleware);

r.get("/system-info", async (c) => {
  const stats = await sql.unsafe<any[]>(`
    SELECT
      (SELECT COUNT(*) FROM public.data_sources) AS data_sources,
      (SELECT COUNT(*) FROM public.data_sources WHERE type='shop_account') AS shop_accounts,
      (SELECT COUNT(*) FROM public.data_sources WHERE type='file') AS files,
      (SELECT COUNT(*) FROM public.datasets) AS datasets,
      (SELECT COUNT(*) FROM public.charts) AS charts,
      (SELECT COUNT(*) FROM public.agents) AS agents,
      (SELECT COUNT(*) FROM public.agent_runs) AS agent_runs,
      (SELECT COUNT(*) FROM public.agent_runs WHERE status='succeeded') AS agent_runs_ok,
      (SELECT COALESCE(SUM(cost_cny), 0)::numeric(10,4) FROM public.agent_runs WHERE status='succeeded') AS total_cost_cny
  `);

  // 最近 7 天的运行
  const recent = await sql.unsafe<any[]>(`
    SELECT
      DATE(created_at) AS d,
      COUNT(*)::int AS runs,
      COALESCE(SUM(cost_cny), 0)::numeric(10,4) AS cost
    FROM public.agent_runs
    WHERE created_at > NOW() - INTERVAL '7 days'
    GROUP BY d
    ORDER BY d DESC
  `);

  return c.json({
    ok: true,
    data: {
      stats: stats[0],
      recentDays: recent,
      services: {
        api: { status: "up" },
        db: { status: "up", type: "PostgreSQL 16" },
        llm: { status: "configured", provider: "DeepSeek V4" },
      },
      version: "0.1.0",
    },
  });
});

// 简单 settings KV
r.get("/kv", adminGuard, async (c) => {
  const list = await db.select().from(settings);
  return c.json({ ok: true, data: list });
});

r.put("/kv/:key", adminGuard, async (c) => {
  const key = c.req.param("key");
  const body = (await c.req.json()) as { value?: string };
  await db
    .insert(settings)
    .values({ key, value: body.value ?? null })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: body.value ?? null, updatedAt: new Date() },
    });
  return c.json({ ok: true });
});

export default r;
