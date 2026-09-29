// 模块管理路由（V0.17 D 方案阶段 3，V0.22 加 AI 模块生成）
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authMiddleware } from "../lib/auth";
import { adminGuard } from "../lib/admin-guard";
import { loadModules } from "../modules/loader";
import { validateModuleConfig } from "../modules/schema";
import { sql } from "../db/client";
import { resolveExistingRuntimeTableReferenceFromSql } from "../db/table-scope";
import { chat } from "../services/llm";
import { moduleFieldSuggestions } from "../services/module-builder";
import {
  parseSpreadsheetRows,
  SpreadsheetSecurityError,
} from "../services/spreadsheet-security";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = path.resolve(__dirname, "../modules");
const MAX_INSPECT_FILE_BYTES = 20 * 1024 * 1024;

const r = new Hono();
r.use("*", authMiddleware);

// 列出所有模块（含平台、列定义、是否启用）
r.get("/", async (c) => {
  const mods = await loadModules();
  // 顺便查每个模块的行数（如果表存在）
  const rowCounts: Record<string, number> = {};
  for (const m of mods) {
    const tableName = m.outputTable ?? `unified_${m.code}`;
    try {
      const tableRef = await resolveExistingRuntimeTableReferenceFromSql(tableName, sql);
      if (!tableRef) {
        rowCounts[m.code] = 0;
        continue;
      }
      const [r] = (await sql.unsafe(
        `SELECT COUNT(*)::int AS n FROM ${tableRef}`,
      )) as any[];
      rowCounts[m.code] = r?.n ?? 0;
    } catch {
      rowCounts[m.code] = 0;
    }
  }
  // 同时算"被其他模块借走的字典 role"——给前端关联可视化用
  // 约定：模块的 outputTable 对应的 role 是模块的 code（除非显式标注）
  const referencedBy: Record<string, string[]> = {};
  for (const m of mods) {
    const allJoins = m.joins ?? (m.join ? [m.join] : []);
    for (const j of allJoins) {
      (referencedBy[j.dictRole] ??= []).push(m.code);
    }
  }
  // 简化字段返回给前端用，剥掉运行时函数
  const data = mods.map((m) => ({
    code: m.code,
    name: m.name,
    category: m.category,
    categoryLabel: m.categoryLabel,
    description: m.description,
    enabled: m.enabled,
    hasTransform: m.hasTransform,
    outputTable: m.outputTable ?? `unified_${m.code}`,
    isDict: m.isDict,
    role: m.role,
    timeKey: m.timeKey,
    schedule: m.schedule,
    usages: m.usages,
    semanticModel: m.semanticModel,
    columns: m.columns,
    platforms: m.platforms.map((p) => ({
      code: p.code,
      name: p.name,
      filePattern: p.filePattern,
      patternFlags: p.patternFlags,
      enabled: p.enabled,
      columnOverrides: p.columnOverrides ?? {},
    })),
    join: m.join,
    joins: m.joins,
    presets: m.presets,
    alerts: m.alerts,
    origin: m.origin,
    version: m.version,
    configurable: m.configurable,
    fieldSuggestions: moduleFieldSuggestions(m),
    totalRows: rowCounts[m.code] ?? 0,
    // 谁借用了本模块（按 code 匹配 dictRole；约定 dict 命名）
    referencedBy: referencedBy[m.code] ?? [],
  }));
  return c.json({ ok: true, data });
});

// 列出 modules 目录下所有 .json 文件名（含未启用的，调试用）
// 注意：这条路由必须在 /:code 之前注册，否则会被 :code 吃掉
r.get("/_files", async (c) => {
  try {
    const files = readdirSync(MODULES_DIR).filter((f) => f.endsWith(".json"));
    return c.json({ ok: true, data: files });
  } catch (e: any) {
    return c.json({ ok: false, message: e.message }, 500);
  }
});

// 热重载模块配置（V0.26）：AI/运营改完 modules/*.json 后调此接口立即生效，无需重启容器。
// 这是给 loadModules(force=true) 接上的第一个真实调用方。返回重载后的模块数。
r.post("/reload", adminGuard, async (c) => {
  try {
    const mods = await loadModules(true); // force=true 跳过进程级缓存，重扫 modules 目录
    return c.json({ ok: true, reloaded: mods.length, modules: mods.map((m) => m.code) });
  } catch (e: any) {
    return c.json({ ok: false, message: e.message }, 500);
  }
});

// 取单个模块
r.get("/:code", async (c) => {
  const code = c.req.param("code");
  const mods = await loadModules();
  const m = mods.find((x) => x.code === code);
  if (!m) return c.json({ ok: false, message: "模块不存在" }, 404);
  return c.json({
    ok: true,
    data: {
      code: m.code,
      name: m.name,
      category: m.category,
      categoryLabel: m.categoryLabel,
      description: m.description,
      enabled: m.enabled,
      hasTransform: m.hasTransform,
      outputTable: m.outputTable ?? `unified_${m.code}`,
      isDict: m.isDict,
      role: m.role,
      timeKey: m.timeKey,
      schedule: m.schedule,
      usages: m.usages,
      semanticModel: m.semanticModel,
      columns: m.columns,
      platforms: m.platforms,
      join: m.join,
      joins: m.joins,
      presets: m.presets,
    },
  });
});

// 取原始 JSON 文件内容（给前端"查看 / 导出"用）。不暴露绝对路径，仅返回内容字符串
r.get("/:code/raw", async (c) => {
  const code = c.req.param("code");
  // 校验 code 合法性，防路径穿越
  if (!/^[a-z][a-z0-9_]*$/.test(code)) {
    return c.json({ ok: false, message: "非法模块代号" }, 400);
  }
  const filePath = path.join(MODULES_DIR, `${code}.json`);
  if (!existsSync(filePath)) {
    return c.json({ ok: false, message: "模块文件不存在" }, 404);
  }
  try {
    const raw = readFileSync(filePath, "utf-8");
    return c.json({
      ok: true,
      data: {
        code,
        fileName: `${code}.json`,
        content: raw,
      },
    });
  } catch (e: any) {
    return c.json({ ok: false, message: "读取失败：" + e.message }, 500);
  }
});

// 单模块统计（V0.23+）：mini KPI 用
// 返回：总行数 / 最近 7 天每日记录数 / 未处理预警数
r.get("/:code/stats", async (c) => {
  const code = c.req.param("code");
  if (!/^[a-z][a-z0-9_]*$/.test(code)) {
    return c.json({ ok: false, message: "非法模块代号" }, 400);
  }
  const mods = await loadModules();
  const mod = mods.find((m) => m.code === code);
  if (!mod) return c.json({ ok: false, message: "模块不存在" }, 404);

  const tableName = mod.outputTable ?? `unified_${mod.code}`;

  // 表存在校验
  const tableRef = await resolveExistingRuntimeTableReferenceFromSql(tableName, sql);

  let totalRows = 0;
  let trend: Array<{ date: string; n: number }> = [];

  if (tableRef) {
    const [r1] = (await sql.unsafe(
      `SELECT COUNT(*)::int AS n FROM ${tableRef}`,
    )) as any[];
    totalRows = r1?.n ?? 0;

    // 最近 7 天趋势（需要 timeKey）
    if (mod.timeKey) {
      try {
        const rows = (await sql.unsafe(
          `SELECT DATE("${mod.timeKey}") AS date, COUNT(*)::int AS n
           FROM ${tableRef}
           WHERE "${mod.timeKey}" IS NOT NULL
             AND DATE("${mod.timeKey}") >= CURRENT_DATE - INTERVAL '7 days'
           GROUP BY DATE("${mod.timeKey}")
           ORDER BY date`,
        )) as any[];
        trend = rows.map((r: any) => ({
          date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
          n: r.n,
        }));
      } catch {}
    }
  }

  // 本模块未处理预警数
  const [{ openAlerts }] = (await sql.unsafe(
    `SELECT COUNT(*)::int AS "openAlerts" FROM public.alerts WHERE status = 'open' AND module_code = $1`,
    [code],
  )) as any[];

  return c.json({
    ok: true,
    data: {
      totalRows,
      trend, // [{ date, n }, ...]
      openAlerts,
      timeKey: mod.timeKey ?? null,
    },
  });
});

// ==========================================================
// V0.22：AI 生成模块助手
// ==========================================================

// 上传 Excel 提取表头 + 前 5 行采样（给 AI 看实际数据）
r.post(
  "/inspect-excel",
  bodyLimit({
    maxSize: MAX_INSPECT_FILE_BYTES,
    onError: (c) => c.json({ ok: false, message: "文件超过 20MB" }, 413),
  }),
  async (c) => {
  try {
    const form = await c.req.formData();
    const file = form.get("file") as File | null;
    if (!file) return c.json({ ok: false, message: "缺少 file" }, 400);
    if (file.size > MAX_INSPECT_FILE_BYTES) {
      return c.json({ ok: false, message: "文件超过 20MB" }, 400);
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const { sheetName, rows } = await parseSpreadsheetRows(buf, file.name);

    const headers = (rows[0] as any[]).map((h) => String(h ?? ""));
    const sample = rows.slice(1, 6).map((r) => {
      const obj: Record<string, any> = {};
      headers.forEach((h, i) => {
        obj[h] = r[i];
      });
      return obj;
    });

    return c.json({
      ok: true,
      data: {
        fileName: file.name,
        sheetName,
        rowCount: rows.length - 1,
        headers,
        sample,
      },
    });
  } catch (e: any) {
    const status = e instanceof SpreadsheetSecurityError ? 400 : 500;
    return c.json({ ok: false, message: "解析失败：" + e.message }, status);
  }
  },
);

// AI 生成模块 JSON 草稿
r.post("/generate", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const {
    code,
    name,
    description,
    category,
    categoryLabel,
    headers,
    sample,
    extraHint,
  } = body as {
    code?: string;
    name?: string;
    description?: string;
    category?: string;
    categoryLabel?: string;
    headers?: string[];
    sample?: Record<string, any>[];
    extraHint?: string;
  };

  if (!code || !/^[a-z][a-z0-9_]*$/.test(code)) {
    return c.json(
      { ok: false, message: "code 必填，且只能小写字母+数字+下划线（如 inventory_v2）" },
      400,
    );
  }
  if (!name || !description) {
    return c.json({ ok: false, message: "name 和 description 必填" }, 400);
  }
  if (!headers || headers.length === 0) {
    return c.json({ ok: false, message: "headers 必填（Excel 表头）" }, 400);
  }

  // 读两个参考模块作为 AI 学习样本（一简一繁）
  let invRef = "";
  let costRef = "";
  try {
    invRef = readFileSync(path.join(MODULES_DIR, "inventory.json"), "utf-8");
    costRef = readFileSync(path.join(MODULES_DIR, "cost.json"), "utf-8");
  } catch {}

  const systemPrompt = `你是电商数据中台模块配置助手。用户要新建一个声明式 ETL 模块，给你 Excel 表头和样本，你产出合法的 JSON 模块配置。

## 模块配置 schema 要点
- code: 英文小写下划线，已由用户给定
- name / description / category / categoryLabel: 已由用户给定
- enabled: true
- hasTransform: false（默认行映射够用）
- outputTable: 默认 unified_<code>，可省略
- timeKey: 如果列里有日期/时间字段，指向该字段的 name，启用同比环比
- usages: 默认 ["summary","ai_chart","ai_analysis"]
- columns: 每个字段一项
  · name: 英文小写下划线
  · source: 中文原列名（用户表头里的），多候选用数组
  · type: text/int/numeric/timestamp/date/boolean
  · label: 中文显示名
  · required: 关键字段标 true，其他默认 false
  · maxLen: text 字段加（防 value too long）
  · hint: 给运营/AI 看的描述
  · computed + expression: 如果是公式计算字段（如 总成本 = 采购+物流+包装），写 SQL 片段（除零用 NULLIF）
- platforms: 至少一个
  · code: 英文小写下划线
  · name: 中文
  · filePattern: 受限文件名匹配模式（优先写稳定文字；仅支持顶层 |、^/$、每分支一个 .*、每分支一个单字符 ? 和转义标点；不要用括号、字符类、+、{}）
  · patternFlags: "i"（仅允许 i/u）
  · enabled: true
  · columnOverrides: 该平台特殊列名（可选）
- joins / alerts / presets / schedule: 可选，按需要加

## 输出要求
- 只输出一个 JSON 对象（jsonMode 严格 JSON）
- 不要 markdown 代码块、不要解释
- 字符串里如果有双引号、反斜杠按 JSON 转义
- 必须能 JSON.parse + zod 校验通过

## 参考模块（学语法 + 命名习惯）

### 简单模块 inventory.json
${invRef}

### 含计算字段 cost.json
${costRef}
`;

  const userPrompt = `请基于以下信息生成模块 JSON：

模块基本信息：
- code: ${code}
- name: ${name}
- description: ${description}
${category ? `- category: ${category}` : ""}
${categoryLabel ? `- categoryLabel: ${categoryLabel}` : ""}

Excel 表头（${headers.length} 列）：
${JSON.stringify(headers, null, 2)}

${sample && sample.length ? `前 ${sample.length} 行数据样本：\n${JSON.stringify(sample, null, 2)}` : ""}

${extraHint ? `用户额外说明：${extraHint}` : ""}

请生成模块 JSON。`;

  try {
    const result = await chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      { tier: "flash", jsonMode: true, maxTokens: 4096, temperature: 0.3 },
    );

    // 校验 LLM 返回是合法 JSON
    let parsed: any;
    try {
      parsed = JSON.parse(result.content);
    } catch (e: any) {
      return c.json(
        {
          ok: false,
          message: "AI 返回不是合法 JSON：" + e.message,
          raw: result.content,
        },
        500,
      );
    }

    // 强制覆盖用户给的基本字段（防 AI 乱改 code）
    parsed.code = code;
    parsed.name = name;
    parsed.description = description;
    if (category) parsed.category = category;
    if (categoryLabel) parsed.categoryLabel = categoryLabel;

    // zod 校验
    let valid = true;
    let validateError: string | null = null;
    try {
      validateModuleConfig(parsed, `${code}.json`);
    } catch (e: any) {
      valid = false;
      validateError = e.message;
    }

    return c.json({
      ok: true,
      data: {
        valid,
        validateError,
        json: parsed,
        jsonText: JSON.stringify(parsed, null, 2),
        usage: result.usage,
      },
    });
  } catch (e: any) {
    return c.json({ ok: false, message: "AI 生成失败：" + e.message }, 500);
  }
});

export default r;
