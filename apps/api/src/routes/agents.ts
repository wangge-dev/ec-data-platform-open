// 智能体（V0.5：通用 run 端点，支持 sql / text 双输入模式 · DeepSeek V4）
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, desc } from "drizzle-orm";

import { db, sql } from "../db/client";
import { agents, agentRuns, dataSources } from "../db/schema";
import { resolveExistingRuntimeTableReferenceFromSql } from "../db/table-scope";
import { authMiddleware } from "../lib/auth";
import { executeLocalReadOnlyQuery } from "../lib/local-readonly-sql";
import { chat, type ModelTier } from "../services/llm";

const r = new Hono();
r.use("*", authMiddleware);

// V4 价格（粗略，元/百万 token）
const PRICING: Record<ModelTier, { in: number; out: number }> = {
  flash: { in: 0.5, out: 1 },
  pro: { in: 4, out: 16 },
};

function estimateCost(tier: ModelTier, usage: any): string {
  const p = PRICING[tier];
  const cost =
    ((usage?.prompt_tokens || 0) * p.in + (usage?.completion_tokens || 0) * p.out) / 1_000_000;
  return cost.toFixed(4);
}

r.get("/", async (c) => {
  const list = await db.select().from(agents).orderBy(desc(agents.createdAt));
  return c.json({ ok: true, data: list });
});

r.get("/runs", async (c) => {
  const agentId = c.req.query("agentId");
  let q = db.select().from(agentRuns).orderBy(desc(agentRuns.createdAt)).limit(50).$dynamic();
  if (agentId) q = q.where(eq(agentRuns.agentId, Number(agentId)));
  const list = await q;
  return c.json({ ok: true, data: list });
});

r.get("/runs/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
  if (!run) return c.json({ ok: false, message: "运行记录不存在" }, 404);
  return c.json({ ok: true, data: run });
});

// 通用运行：按 agent.config.inputMode 决定输入来源
//   - sql      : 跑 SELECT 拿结构化行，JSON 喂给模型（保留给管理员配置的高级智能体）
//   - text     : 直接把用户 brief 当输入（详情页文案 / 客服话术）
//   - analysis : 针对某上传文件/分组读列结构+采样数据，按自定义维度或 AI 自动分析
const runSchema = z.object({
  datasetSql: z.string().optional(),
  inputText: z.string().optional(),
  modelTier: z.enum(["flash", "pro"]).optional(),
  // analysis 模式专用
  sourceId: z.number().int().positive().optional(),
  sourceIds: z.array(z.number().int().positive()).optional(),
  group: z.string().optional(),
  // V0.18：选某个模块的 unified_<code> 整表分析（比文件级更高维度，跨平台跨字典已 JOIN 完成）
  moduleCode: z.string().optional(),
  mode: z.enum(["auto", "custom"]).optional(),
  dimensions: z.string().trim().max(1000).optional(),
  question: z.string().trim().max(1000).optional(),
});

r.post("/:code/run", zValidator("json", runSchema), async (c) => {
  const code = c.req.param("code");
  const { datasetSql, inputText, modelTier = "flash", sourceId, sourceIds, group, moduleCode, mode = "auto", dimensions, question } =
    c.req.valid("json");

  const [agent] = await db.select().from(agents).where(eq(agents.code, code)).limit(1);
  if (!agent) return c.json({ ok: false, message: "智能体未注册" }, 404);

  const cfg = (agent.config as any) ?? {};
  const inputMode: "sql" | "text" | "analysis" = code === "competitor_analysis"
    ? "analysis"
    : (cfg.inputMode ?? "sql");
  const maxTokens: number = cfg.maxTokens ?? 4096;
  const temperature: number = cfg.temperature ?? 0.4;

  // 1. 组装输入
  let userPrompt: string;
  let inputsMeta: Record<string, any>;
  const analysisRequest = question?.trim() || dimensions?.trim() || "";
  const analysisMode = question?.trim() || (mode === "custom" && analysisRequest)
    ? "custom"
    : "auto";

  if (inputMode === "sql") {
    if (!datasetSql?.trim()) return c.json({ ok: false, message: "需要数据 SQL" }, 400);
    let rows: any[];
    try {
      rows = await executeLocalReadOnlyQuery(datasetSql, [], { limit: 30 });
    } catch (e: any) {
      return c.json({ ok: false, message: "SQL 执行失败：" + e.message }, 400);
    }
    if (!rows.length) return c.json({ ok: false, message: "查询无数据" }, 400);
    userPrompt = `以下是 ${rows.length} 条结构化数据（JSON）：\n\n${JSON.stringify(rows, null, 2)}\n\n请按你的框架输出。`;
    inputsMeta = { sql: datasetSql, rowCount: rows.length, modelTier };
  } else if (inputMode === "analysis") {
    // V0.18：模块级分析（moduleCode 优先）→ 直接对 unified_<code> 整表采样
    if (moduleCode) {
      const { loadModules, moduleTableName } = await import("../modules/loader.js");
      const mods = await loadModules();
      const mod = mods.find((m) => m.code === moduleCode);
      if (!mod) return c.json({ ok: false, message: `模块 ${moduleCode} 不存在` }, 400);

      const tableName = moduleTableName(mod);
      // 表存在校验
      const tableRef = await resolveExistingRuntimeTableReferenceFromSql(tableName, sql);
      if (!tableRef) return c.json({ ok: false, message: `模块 ${moduleCode} 还没有数据（${tableName} 不存在）` }, 400);
      const includedWhere = mod.origin === "user"
        ? `WHERE COALESCE("_included", true) = true`
        : "";

      const [{ total }] = (await sql.unsafe(
        `SELECT COUNT(*)::int AS total FROM ${tableRef} ${includedWhere}`,
      )) as any[];
      if (!total) return c.json({ ok: false, message: `模块 ${moduleCode} 当前为空，没有可分析的数据` }, 400);

      // 采样：含 platform/brand/pic 维度时拉 80 行，否则 50 行
      const limit = 80;
      const sample = (await sql.unsafe(
        `SELECT * FROM ${tableRef} ${includedWhere} ORDER BY id DESC LIMIT ${limit}`,
      )) as any[];

      // 元信息说明（让 LLM 知道这张表是怎么来的、字段含义）
      const fieldLines = mod.columns.map((c) => {
        const lbl = c.label ? `(${c.label})` : "";
        const tag = c.computed ? "[计算字段]" : "";
        const hint = c.hint ? ` — ${c.hint}` : "";
        return `- ${c.name}${lbl} ${tag}${hint}`;
      }).join("\n");
      const joinNote = (mod.joins?.length || mod.join)
        ? `\n该表已关联字典：${(mod.joins ?? [mod.join!]).map((j) => j.label || j.dictRole).join("、")}（字典字段已 enrich 到表中）`
        : "";
      const timeNote = mod.timeKey ? `\n时间维度字段：${mod.timeKey}（可做 DoD/MoM/YoY 对比）` : "";

      const dimLine =
        analysisMode === "custom" && analysisRequest
          ? `请严格围绕用户的问题展开：${analysisRequest}\n\n`
          : `请你判断这份数据最值得分析的维度并展开。\n\n`;

      userPrompt = `${dimLine}数据来源：模块「${mod.name}」(${moduleCode}) 的统一宽表 ${tableName}\n` +
        `模块描述：${mod.description}\n` +
        `字段说明：\n${fieldLines}${joinNote}${timeNote}\n\n` +
        `共 ${total} 行，以下为最近 ${sample.length} 行采样（JSON）：\n\n${JSON.stringify(sample, null, 2)}`;

      inputsMeta = {
        mode: analysisMode,
        question: analysisRequest || null,
        moduleCode,
        tableName,
        tableCount: 1,
        modelTier,
      };
    } else {
    // 解析目标文件：多文件(sourceIds) > 单文件(sourceId) > 分组(group)
    const fileSrcs = await db.select().from(dataSources).where(eq(dataSources.type, "file"));
    let targets = fileSrcs;
    if (sourceIds && sourceIds.length > 0) {
      const idSet = new Set(sourceIds);
      targets = fileSrcs.filter((s) => idSet.has(s.id));
    } else if (sourceId) targets = fileSrcs.filter((s) => s.id === sourceId);
    else if (group) targets = fileSrcs.filter((s) => ((s.config as any)?.group || "（未分组）") === group);
    else return c.json({ ok: false, message: "请选择要分析的文件或分组" }, 400);

    // 只保留物理表存在的
    const realTabs = await sql`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'uf_%'`;
    const realSet = new Set(realTabs.map((t: any) => t.table_name));
    targets = targets.filter((s) => realSet.has(`uf_${s.id}`));
    if (!targets.length) return c.json({ ok: false, message: "未找到可分析的数据表" }, 400);

    // 每张表取列结构 + 采样行（多表时每表少采，控制 prompt 体量）
    const perTable = targets.length > 1 ? 20 : 50;
    const blocks: string[] = [];
    for (const s of targets) {
      const cols = ((s.config as any)?.columns ?? []) as Array<{ raw: string; name: string }>;
      if (!cols.length) continue;
      const colExpr = cols.map((col) => `"${col.name}" AS "${col.raw}"`).join(", ");
      const sample = await sql.unsafe(`SELECT ${colExpr} FROM "uf_${s.id}" LIMIT ${perTable}`);
      blocks.push(
        `### 表「${s.name}」（约 ${(s.config as any)?.rowCount ?? "?"} 行，以下为 ${sample.length} 行采样）\n` +
          JSON.stringify(sample, null, 2),
      );
    }
    const dimLine =
      analysisMode === "custom" && analysisRequest
        ? `请严格围绕用户的问题展开：${analysisRequest}\n\n`
        : `请你判断这份数据最值得分析的维度并展开。\n\n`;
    userPrompt = `${dimLine}数据如下：\n\n${blocks.join("\n\n")}`;
    inputsMeta = { mode: analysisMode, question: analysisRequest || null, sourceId: sourceId ?? null, sourceIds: sourceIds ?? null, group: group ?? null, tableCount: targets.length, modelTier };
    }
  } else {
    if (!inputText?.trim()) return c.json({ ok: false, message: "需要填写输入" }, 400);
    userPrompt = inputText.trim();
    inputsMeta = { inputText, modelTier };
  }

  // 2. 创建 run 记录
  const [run] = await db
    .insert(agentRuns)
    .values({ agentId: agent.id, status: "running", inputs: inputsMeta })
    .returning();

  const t0 = Date.now();
  try {
    // 3. 调模型
    const result = await chat(
      [
        { role: "system", content: agent.promptTemplate },
        { role: "user", content: userPrompt },
      ],
      { tier: modelTier, maxTokens, temperature },
    );

    const [updated] = await db
      .update(agentRuns)
      .set({
        status: "succeeded",
        outputs: {
          content: result.content,
          reasoning: result.reasoning,
          usage: result.usage,
          model: agent.model,
        },
        costCny: estimateCost(modelTier, result.usage),
        durationMs: Date.now() - t0,
        completedAt: new Date(),
      })
      .where(eq(agentRuns.id, run.id))
      .returning();

    return c.json({ ok: true, data: updated });
  } catch (e: any) {
    const [updated] = await db
      .update(agentRuns)
      .set({
        status: "failed",
        outputs: { error: e.message },
        durationMs: Date.now() - t0,
        completedAt: new Date(),
      })
      .where(eq(agentRuns.id, run.id))
      .returning();
    return c.json({ ok: false, message: e.message, data: updated }, 500);
  }
});

export default r;
