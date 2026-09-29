// 看板 + 数据集 + 图表
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, desc } from "drizzle-orm";

import { db, sql } from "../db/client";
import { datasets, charts, dashboards } from "../db/schema";
import { resolveExistingRuntimeTableReferenceFromSql } from "../db/table-scope";
import { authMiddleware } from "../lib/auth";
import {
  executeLocalReadOnlyQueryWithMetadata,
  LOCAL_SQL_MAX_ROWS,
} from "../lib/local-readonly-sql";
import { ensureReadOnly } from "../lib/sql-guard";
import { chat, type ModelTier } from "../services/llm";
import { buildChartServerAggregationSql } from "../services/board-chart-aggregation";
import {
  compileSemanticQuery,
  loadSemanticModels,
  semanticColumnAlias,
  SemanticQueryError,
  SemanticQuerySchema,
  type CompiledSemanticQuery,
} from "../services/semantic-model";

const r = new Hono();
r.use("*", authMiddleware);

// 表名校验：table 模式只允许内部动态表名 uf_<id> 或 unified_<code>，杜绝注入
function safeTableName(t: string): string {
  const name = t.trim();
  if (!/^(uf_\d+|unified_[a-z][a-z0-9_]*)$/.test(name)) {
    throw new Error("非法表名");
  }
  return name;
}

class ChartRenderRequestError extends Error {
  constructor(
    readonly code: "CHART_DATA_INCOMPLETE" | "CHART_DATE_FILTER_INVALID" | "CHART_DATE_FILTER_FAILED" | "CHART_SERVER_AGGREGATION_FAILED",
    message: string,
    readonly status: 400 | 422,
  ) {
    super(message);
    this.name = "ChartRenderRequestError";
  }
}

function isIsoCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function chartRenderSql(input: {
  sqlText: string;
  dateField: unknown;
  from: string | undefined;
  to: string | undefined;
  parameterOffset?: number;
}): { queryText: string; parameters: string[]; filterApplied: boolean } {
  const hasFrom = input.from !== undefined;
  const hasTo = input.to !== undefined;
  if (!hasFrom && !hasTo) {
    return { queryText: input.sqlText, parameters: [], filterApplied: false };
  }

  if (
    (hasFrom && !isIsoCalendarDate(input.from!))
    || (hasTo && !isIsoCalendarDate(input.to!))
    || (hasFrom && hasTo && input.from! > input.to!)
  ) {
    throw new ChartRenderRequestError(
      "CHART_DATE_FILTER_INVALID",
      "日期筛选边界无效，请使用真实存在的 YYYY-MM-DD 日期，并确保开始日期不晚于结束日期。",
      400,
    );
  }

  if (typeof input.dateField !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(input.dateField)) {
    throw new ChartRenderRequestError(
      "CHART_DATE_FILTER_INVALID",
      "这张图表没有可安全应用的日期字段，请检查图表配置后重试。",
      400,
    );
  }

  const dateExpression = `(sub."${input.dateField}"::text)::date`;
  const firstParameter = (input.parameterOffset ?? 0) + 1;
  if (hasFrom && hasTo) {
    return {
      queryText: `SELECT * FROM (${input.sqlText}) sub WHERE ${dateExpression} BETWEEN $${firstParameter}::date AND $${firstParameter + 1}::date`,
      parameters: [input.from!, input.to!],
      filterApplied: true,
    };
  }
  return {
    queryText: `SELECT * FROM (${input.sqlText}) sub WHERE ${dateExpression} ${hasFrom ? ">=" : "<="} $${firstParameter}::date`,
    parameters: [hasFrom ? input.from! : input.to!],
    filterApplied: true,
  };
}

type DatasetQueryPlan = {
  sqlText: string;
  parameters: Array<string | number | boolean>;
  semantic?: CompiledSemanticQuery;
};

async function datasetQueryPlan(queryType: string, queryText: string): Promise<DatasetQueryPlan> {
  if (queryType === "sql") {
    return { sqlText: ensureReadOnly(queryText), parameters: [] };
  }
  if (queryType === "semantic") {
    let payload: unknown;
    try {
      payload = JSON.parse(queryText);
    } catch {
      throw new SemanticQueryError(
        "SEMANTIC_QUERY_INVALID",
        "语义数据集配置不是合法 JSON。",
        400,
      );
    }
    const models = await loadSemanticModels();
    const semantic = compileSemanticQuery(payload, models);
    return {
      sqlText: semantic.sqlText,
      parameters: semantic.parameters,
      semantic,
    };
  }
  if (queryType !== "table") throw new Error("非法数据集查询类型");
  const tableName = safeTableName(queryText);
  const tableRef = await resolveExistingRuntimeTableReferenceFromSql(tableName, sql);
  if (!tableRef) throw new Error(`数据表 ${tableName} 不存在`);
  return { sqlText: `SELECT * FROM ${tableRef}`, parameters: [] };
}

function semanticChartContractIssue(
  chartType: string,
  compiled: CompiledSemanticQuery,
): string | null {
  const metrics = compiled.columns.filter((column) => column.kind === "metric");
  const dimensions = compiled.columns.filter((column) => column.kind === "dimension");
  if (!["kpi", "gauge"].includes(chartType) && dimensions.length === 0) {
    return "该图表类型至少需要一个已声明维度。";
  }
  if (["line", "area"].includes(chartType) && dimensions[0]?.dimensionKind !== "time") {
    return "趋势图的第一个维度必须是时间维度。";
  }
  if (chartType === "pie" && (metrics.length !== 1 || dimensions.length !== 1)) {
    return "饼图必须使用一个指标和一个维度。";
  }
  if (chartType === "combo" && metrics.length !== 2) {
    return "组合图必须使用两个指标。";
  }
  if (chartType === "heatmap" && (metrics.length !== 1 || dimensions.length !== 2)) {
    return "热力图必须使用一个指标和两个维度。";
  }
  if (chartType === "stacked_bar" && metrics.length < 2 && dimensions.length < 2) {
    return "堆叠柱图至少需要两个指标或两个维度。";
  }
  return null;
}

// ============== datasets ==============
r.get("/datasets", async (c) => {
  const list = await db.select().from(datasets).orderBy(desc(datasets.createdAt));
  return c.json({ ok: true, data: list });
});

const datasetSchema = z.object({
  name: z.string().min(1).max(128),
  sourceId: z.number().int().positive().optional().nullable(),
  queryType: z.enum(["sql", "table", "semantic"]),
  queryText: z.string().min(1),
});
const semanticDatasetSchema = datasetSchema.extend({
  queryType: z.literal("semantic"),
});

r.post("/datasets", zValidator("json", semanticDatasetSchema), async (c) => {
  const body = c.req.valid("json");
  const [created] = await db
    .insert(datasets)
    .values({ ...body, fields: null })
    .returning();
  return c.json({ ok: true, data: created }, 201);
});

r.delete("/datasets/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  await db.delete(datasets).where(eq(datasets.id, id));
  return c.json({ ok: true });
});

// 新建/预览只接受语义合同；sql/table 仅用于渲染升级前的存量数据集。
r.post(
  "/datasets/preview",
  zValidator(
    "json",
    z.object({
      queryType: z.literal("semantic"),
      queryText: z.string().min(1),
      limit: z.number().int().positive().max(500).optional(),
    }),
  ),
  async (c) => {
    const { queryType, queryText, limit = 100 } = c.req.valid("json");
    try {
      const plan = await datasetQueryPlan(queryType, queryText);
      const effectiveLimit = Math.min(limit, plan.semantic?.query.limit ?? limit);
      const result = await executeLocalReadOnlyQueryWithMetadata(
        plan.sqlText,
        plan.parameters,
        { limit: effectiveLimit },
      );
      if (plan.semantic && result.truncated) {
        throw new SemanticQueryError(
          "SEMANTIC_QUERY_INCOMPLETE",
          `查询结果超过 ${result.rowLimit.toLocaleString("zh-CN")} 行，请增加筛选条件或减少维度。`,
          422,
          { rowLimit: result.rowLimit },
        );
      }
      const cols = result.rows.length ? Object.keys(result.rows[0] as object) : [];
      return c.json({
        ok: true,
        data: {
          rows: result.rows,
          columns: cols,
          total: result.rows.length,
          ...(plan.semantic
            ? { lineage: plan.semantic.lineage, budget: plan.semantic.budget }
            : {}),
        },
      });
    } catch (e: any) {
      if (e instanceof SemanticQueryError) {
        return c.json({
          ok: false,
          code: e.code,
          message: e.publicMessage,
          ...(e.details ? { details: e.details } : {}),
        }, e.status);
      }
      console.error("[board-dataset-preview] failed", e);
      return c.json({ ok: false, code: "DATASET_QUERY_FAILED", message: "数据集查询失败，请检查查询配置。" }, 400);
    }
  },
);

// ============== charts ==============
r.get("/charts", async (c) => {
  const moduleCode = c.req.query("moduleCode");
  let list;
  if (moduleCode) {
    list = await db.select().from(charts).where(eq(charts.moduleCode, moduleCode)).orderBy(desc(charts.createdAt));
  } else {
    list = await db.select().from(charts).orderBy(desc(charts.createdAt));
  }
  return c.json({ ok: true, data: list });
});

const chartSchema = z.object({
  datasetId: z.number().int().positive(),
  name: z.string().min(1).max(128),
  chartType: z.enum([
    "bar",
    "horizontal_bar",
    "stacked_bar",
    "line",
    "area",
    "pie",
    "radar",
    "combo",
    "scatter",
    "funnel",
    "treemap",
    "heatmap",
    "gauge",
    "kpi",
    "table",
  ]),
  config: z.record(z.any()),
  moduleCode: z.string().max(64).optional(), // V0.27：图表归属模块，看板按模块分组
});

// UI 创建图表时，数据集只是该图表的私有依赖。两条记录必须同成同败，
// 否则第二步失败会留下用户无法识别和回收的孤儿数据集。
r.post(
  "/chart-bundles",
  zValidator(
    "json",
    z.object({
      dataset: semanticDatasetSchema,
      chart: chartSchema.omit({ datasetId: true }),
    }),
  ),
  async (c) => {
    const body = c.req.valid("json");
    if (body.dataset.queryType === "semantic") {
      let queryPayload: unknown;
      try {
        queryPayload = JSON.parse(body.dataset.queryText);
      } catch {
        queryPayload = null;
      }
      const parsedQuery = SemanticQuerySchema.safeParse(queryPayload);
      const config = body.chart.config as Record<string, unknown>;
      if (
        !parsedQuery.success
        || config.semanticModelId !== parsedQuery.data.modelId
        || config.semanticModelVersion !== parsedQuery.data.modelVersion
        || JSON.stringify(config.metricIds) !== JSON.stringify(parsedQuery.data.metricIds)
        || JSON.stringify(config.dimensionIds ?? []) !== JSON.stringify(parsedQuery.data.dimensionIds)
      ) {
        return c.json({
          ok: false,
          code: "SEMANTIC_CHART_CONTRACT_MISMATCH",
          message: "图表的语义指标引用与数据集不一致。",
        }, 400);
      }
      try {
        const plan = await datasetQueryPlan(body.dataset.queryType, body.dataset.queryText);
        const issue = plan.semantic
          ? semanticChartContractIssue(body.chart.chartType, plan.semantic)
          : null;
        if (issue) {
          return c.json({
            ok: false,
            code: "SEMANTIC_CHART_CONTRACT_MISMATCH",
            message: issue,
          }, 400);
        }
      } catch (error) {
        if (error instanceof SemanticQueryError) {
          return c.json({
            ok: false,
            code: error.code,
            message: error.publicMessage,
            ...(error.details ? { details: error.details } : {}),
          }, error.status);
        }
        throw error;
      }
    }
    const created = await db.transaction(async (tx) => {
      const [dataset] = await tx
        .insert(datasets)
        .values({ ...body.dataset, fields: null })
        .returning();
      const [chart] = await tx
        .insert(charts)
        .values({ ...body.chart, datasetId: dataset.id })
        .returning();
      return { dataset, chart };
    });
    return c.json({ ok: true, data: created }, 201);
  },
);

r.post("/charts", async (c) => {
  return c.json({
    ok: false,
    code: "SEMANTIC_BUNDLE_REQUIRED",
    message: "新图表必须通过语义数据集与图表原子创建。",
  }, 410);
});

r.delete("/charts/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  await db.delete(charts).where(eq(charts.id, id));
  return c.json({ ok: true });
});

// 渲染图表数据（执行 dataset 的 SQL）
r.get("/charts/:id{[0-9]+}/render", async (c) => {
  const id = Number(c.req.param("id"));
  const [chart] = await db.select().from(charts).where(eq(charts.id, id)).limit(1);
  if (!chart) return c.json({ ok: false, message: "图表不存在" }, 404);
  const [ds] = await db.select().from(datasets).where(eq(datasets.id, chart.datasetId!)).limit(1);
  if (!ds) return c.json({ ok: false, message: "关联数据集已删除" }, 400);

  // 全局日期筛选优先使用显式 dateField，旧图表继续回退到 xField。
  // 任何已请求但无法应用的日期筛选都关闭失败，不能回退到未过滤结果。
  const from = c.req.query("from");
  const to = c.req.query("to");
  const config = (chart.config as any) ?? {};
  const dateField = config.dateField || config.xField;

  try {
    const plan = await datasetQueryPlan(ds.queryType!, ds.queryText!);
    const renderSql = chartRenderSql({
      sqlText: plan.sqlText,
      dateField,
      from,
      to,
      parameterOffset: plan.parameters.length,
    });
    const queryParameters = [...plan.parameters, ...renderSql.parameters];
    const rowLimit = Math.min(LOCAL_SQL_MAX_ROWS, plan.semantic?.query.limit ?? LOCAL_SQL_MAX_ROWS);
    let result;
    try {
      result = await executeLocalReadOnlyQueryWithMetadata(
        renderSql.queryText,
        queryParameters,
        { limit: rowLimit },
      );
    } catch (error) {
      if (renderSql.filterApplied) {
        throw new ChartRenderRequestError(
          "CHART_DATE_FILTER_FAILED",
          "日期筛选无法应用到这张图表的数据。请检查日期字段中的无效值或图表日期字段配置。",
          400,
        );
      }
      throw error;
    }
    let aggregation: {
      mode: "server";
      groupFields: string[];
      sumFields: string[];
      sourceRowLimit: number;
    } | undefined;
    if (result.truncated && !plan.semantic) {
      const aggregationSql = buildChartServerAggregationSql({
        sqlText: renderSql.queryText,
        chartType: chart.chartType,
        config,
      });
      if (aggregationSql) {
        const sourceRowLimit = result.rowLimit;
        try {
          result = await executeLocalReadOnlyQueryWithMetadata(
            aggregationSql.queryText,
            queryParameters,
            { limit: rowLimit },
          );
        } catch {
          throw new ChartRenderRequestError(
            "CHART_SERVER_AGGREGATION_FAILED",
            "图表数据超过浏览器行数上限，但服务端聚合没有成功。请检查图表字段类型或缩小数据范围。",
            400,
          );
        }
        aggregation = {
          mode: "server",
          groupFields: aggregationSql.groupFields,
          sumFields: aggregationSql.sumFields,
          sourceRowLimit,
        };
      }
    }
    if (result.truncated) {
      throw new ChartRenderRequestError(
        "CHART_DATA_INCOMPLETE",
        `图表数据超过 ${result.rowLimit.toLocaleString("zh-CN")} 行，且无法压缩为完整的服务端聚合结果。请缩小数据范围或调整图表维度。`,
        422,
      );
    }
    return c.json({
      ok: true,
      data: {
        chart,
        rows: result.rows,
        complete: true,
        truncated: false,
        rowLimit: result.rowLimit,
        filterApplied: renderSql.filterApplied,
        ...(plan.semantic
          ? { lineage: plan.semantic.lineage, budget: plan.semantic.budget }
          : {}),
        ...(aggregation ? { aggregation } : {}),
      },
    });
  } catch (e: any) {
    if (e instanceof SemanticQueryError) {
      return c.json({
        ok: false,
        code: e.code,
        message: e.publicMessage,
        ...(e.details ? { details: e.details } : {}),
      }, e.status);
    }
    if (e instanceof ChartRenderRequestError) {
      return c.json({
        ok: false,
        code: e.code,
        message: e.message,
        ...(e.code === "CHART_DATA_INCOMPLETE"
          ? { data: { complete: false, truncated: true, rowLimit: LOCAL_SQL_MAX_ROWS } }
          : {}),
      }, e.status);
    }
    console.error("[board-chart-render] failed", e);
    return c.json({
      ok: false,
      code: "CHART_QUERY_FAILED",
      message: "图表数据查询失败，请检查数据集或图表配置。",
    }, 400);
  }
});

// ============== dashboards ==============
r.get("/dashboards", async (c) => {
  const list = await db.select().from(dashboards).orderBy(desc(dashboards.createdAt));
  return c.json({ ok: true, data: list });
});

r.get("/dashboards/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const [item] = await db.select().from(dashboards).where(eq(dashboards.id, id)).limit(1);
  if (!item) return c.json({ ok: false, message: "看板不存在" }, 404);
  return c.json({ ok: true, data: item });
});

r.post(
  "/dashboards",
  zValidator(
    "json",
    z.object({
      name: z.string().min(1).max(128),
      description: z.string().nullable().optional(),
      layout: z.array(z.any()).optional(),
    }),
  ),
  async (c) => {
    const body = c.req.valid("json");
    const [created] = await db
      .insert(dashboards)
      .values({
        name: body.name,
        description: body.description ?? null,
        layout: body.layout ?? [],
      })
      .returning();
    return c.json({ ok: true, data: created }, 201);
  },
);

r.put("/dashboards/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const [updated] = await db
    .update(dashboards)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(dashboards.id, id))
    .returning();
  return c.json({ ok: true, data: updated });
});

r.delete("/dashboards/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  await db.delete(dashboards).where(eq(dashboards.id, id));
  return c.json({ ok: true });
});

// ============== AI 出图（NL → semantic IDs → ECharts spec） ==============

const AI_PRICING: Record<ModelTier, { in: number; out: number }> = {
  flash: { in: 0.5, out: 1 },
  pro: { in: 4, out: 16 },
};

// ====== 图型自适应：LLM 选图常退化成柱状图，跑完 SQL 后按数据特征 + 问题关键词确定性校正 ======

// 时间维度列名特征（dt/date/month/year/月/日期 等）
const TIME_COL_PAT = /(^|_)(dt|date|day|week|month|year|time)($|_)|时间|日期|月份|年份|^月$|^日$|^周$|^年$/i;
// 时间维度值特征（2026-06 / 2026-06-21 / 2026/6/1）
const TIME_VAL_PAT = /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?$/;
const Q_PIE = /(占比|构成|比例|份额|分布|结构|百分比)/;
const Q_TREND = /(趋势|走势|变化|增长|增幅|环比|同比|逐月|逐日|逐周|逐年|按.{0,4}(月|日|周|年|时间|日期))/;
const Q_RANK = /(对比|比较|排名|排行|top|前\d+|最高|最多|最大|最少|最低)/i;

// 判断某字段是不是时间维度：先看列名，再抽样看值
function isTimeDimension(field: string, rows: any[]): boolean {
  if (TIME_COL_PAT.test(field)) return true;
  const sample = rows.slice(0, 5).map((r) => String(r[field] ?? "").trim());
  return sample.length > 0 && sample.every((v) => TIME_VAL_PAT.test(v));
}

// 规则校正图型：返回 { type, reason } 表示需要覆盖，返回 null 表示保留 LLM 选择
function reconcileChartType(
  spec: { chartType: string; xField: string; yFields: string[]; seriesField?: string },
  rows: any[],
  question: string,
): { type: string; reason: string } | null {
  const { chartType, xField, yFields, seriesField } = spec;
  const nY = yFields.length;
  const isTime = isTimeDimension(xField, rows);
  const hasSeries = !!seriesField;

  // 0) 多系列时禁用无法表达分组的图型。
  if (hasSeries && ["pie", "radar", "funnel", "gauge", "kpi"].includes(chartType)) {
    return {
      type: isTime ? "line" : "stacked_bar",
      reason: `检测到多系列分组（${seriesField}），已改为${isTime ? "折线" : "堆叠柱"}图`,
    };
  }
  // 1) 有时间维度 → 趋势，LLM 却选了柱/饼 → 改折线（最强信号）
  if (isTime && (chartType === "bar" || chartType === "pie")) {
    return { type: "line", reason: "检测到时间维度（按时间看走势），已自动改为折线趋势图" };
  }
  // 2) 占比类问题 + 单数值 + 非时间 + 无多系列 → 饼图
  if (
    Q_PIE.test(question) &&
    nY === 1 &&
    !isTime &&
    !hasSeries &&
    ["bar", "horizontal_bar", "stacked_bar", "line", "area", "combo"].includes(chartType)
  ) {
    return { type: "pie", reason: "检测到占比/构成类问题，已自动改为饼图" };
  }
  // 3) 对比/排名 + 非时间，LLM 却选了折线/面积 → 柱状图
  if (Q_RANK.test(question) && !isTime && (chartType === "line" || chartType === "area")) {
    return { type: "bar", reason: "检测到对比/排名类问题（无时间轴），已自动改为柱状图" };
  }
  // 4) 趋势类问题但当前不是 line/area/combo，且确有时间维度 → 折线
  if (Q_TREND.test(question) && isTime && !["line", "area", "combo"].includes(chartType)) {
    return { type: "line", reason: "检测到趋势类问题，已自动改为折线图" };
  }
  return null;
}

// 多级容错解析模型返回的 JSON spec：返回对象或 null
function parseSpecJson(raw: string): any | null {
  if (!raw) return null;
  // 去掉 markdown 代码块围栏 ```json ... ```
  let text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  // ① 直接 parse（jsonMode 正常时走这里）
  try {
    return JSON.parse(text);
  } catch {
    /* 继续容错 */
  }
  // ② 截取最外层 {...}，再去掉字符串外的控制字符后 parse
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      try {
        // SQL 里的字面换行会让字符串非法，去掉控制字符再试
        return JSON.parse(match[0].replace(/[\n\r\t]/g, " "));
      } catch {
        /* 继续 */
      }
    }
  }
  // ③ 截断修复：从开头找 {，逐步往后扫描，补齐未闭合的引号/括号再 parse
  const start = text.indexOf("{");
  if (start >= 0) {
    const body = text.slice(start).replace(/[\n\r\t]/g, " ");
    for (let cut = body.length; cut > 50; cut -= 1) {
      const candidate = repairJson(body.slice(0, cut));
      if (!candidate) continue;
      try {
        return JSON.parse(candidate);
      } catch {
        // try next shorter cut
      }
    }
  }
  return null;
}

// 简单 JSON 修复：补齐未闭合的字符串和大括号。失败返回 null。
function repairJson(s: string): string | null {
  let inStr = false;
  let escape = false;
  let depth = 0;
  let lastSafe = -1; // 最后一个可作为字符串边界 token 的位置
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === "," || ch === "]" || ch === "}") lastSafe = i;
    }
  }
  let fixed = s;
  if (inStr) fixed += '"';
  // 去掉末尾未完成的 key/value（最后一个逗号之后的内容）
  const lastComma = fixed.lastIndexOf(",");
  const lastBrace = fixed.lastIndexOf("{");
  if (inStr && lastComma > lastBrace) {
    fixed = fixed.slice(0, lastComma);
  }
  // 补齐右大括号
  while (depth > 0) {
    fixed += "}";
    depth--;
  }
  return fixed;
}

const aiChartSchema = z.object({
  question: z.string().min(1).max(500),
  modelTier: z.enum(["flash", "pro"]).optional(),
  scope: z
    .object({
      kind: z.enum(["all", "file", "files", "group", "module"]).optional(),
      value: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
});

const SEMANTIC_AI_SYSTEM_PROMPT = `你是电商分析图表规划助手。你只能从服务端提供的语义模型中选择稳定的 modelId、metricIds 和 dimensionIds；禁止生成 SQL、物理表名或字段名。

输出合法 JSON：
- modelId：必须来自可用语义模型
- metricIds：1~2 个已声明指标 ID
- dimensionIds：0~2 个已声明维度 ID；趋势图第一个维度必须是时间维度
- chartType：bar/line/area/pie/horizontal_bar/stacked_bar/combo/kpi 之一
- title：简短标题
- reason：一句话说明选择理由

选图规则：时间趋势用 line/area；类别对比或排名用 bar/horizontal_bar；单指标占比可用 pie；无维度汇总用 kpi；两个量纲可用 combo；两个维度的构成可用 stacked_bar。只输出 JSON。`;

r.post("/ai-chart", zValidator("json", aiChartSchema), async (c) => {
  const { question, modelTier = "pro", scope } = c.req.valid("json");
  if (scope?.kind && !["all", "module"].includes(scope.kind)) {
    return c.json({
      ok: false,
      code: "SEMANTIC_MODEL_REQUIRED",
      message: "AI 出图只支持已发布语义清单的模块；原始文件请先创建或关联模块。",
    }, 400);
  }

  const allModels = await loadSemanticModels();
  const models = scope?.kind === "module"
    ? allModels.filter((model) => model.moduleCode === String(scope.value ?? ""))
    : allModels;
  if (models.length === 0) {
    return c.json({
      ok: false,
      code: "SEMANTIC_MODEL_NOT_FOUND",
      message: "所选范围还没有可用的语义指标清单。",
    }, 404);
  }
  const catalog = models.map((model) => ({
    modelId: model.id,
    modelVersion: model.version,
    module: model.moduleName,
    metrics: model.metrics.map((metric) => ({ id: metric.id, label: metric.label, unit: metric.unit })),
    dimensions: model.dimensions.map((dimension) => ({ id: dimension.id, label: dimension.label, kind: dimension.kind })),
  }));

  let raw: string;
  let usage: any;
  try {
    const result = await chat(
      [
        { role: "system", content: SEMANTIC_AI_SYSTEM_PROMPT },
        { role: "user", content: `可用语义模型：\n${JSON.stringify(catalog)}\n\n问题：${question}` },
      ],
      { tier: modelTier, maxTokens: 1200, temperature: 0.1, jsonMode: true },
    );
    raw = result.content;
    usage = result.usage;
  } catch (error) {
    console.error("[board-ai-chart-model] failed", error);
    return c.json({
      ok: false,
      code: "AI_MODEL_FAILED",
      message: "模型调用失败，请稍后重试。",
    }, 500);
  }

  const selectionSchema = z.object({
    modelId: z.string().min(1),
    metricIds: z.array(z.string().min(1)).min(1).max(2),
    dimensionIds: z.array(z.string().min(1)).max(2).default([]),
    chartType: z.enum([
      "bar",
      "line",
      "area",
      "pie",
      "horizontal_bar",
      "stacked_bar",
      "combo",
      "kpi",
    ]),
    title: z.string().min(1).max(128),
    reason: z.string().max(500).default(""),
  });
  const selection = selectionSchema.safeParse(parseSpecJson(raw));
  if (!selection.success) {
    return c.json({
      ok: false,
      code: "AI_SEMANTIC_SELECTION_INVALID",
      message: "模型没有返回有效的指标与维度选择，请换一种问法。",
    }, 400);
  }
  const model = models.find((candidate) => candidate.id === selection.data.modelId);
  if (!model) {
    return c.json({
      ok: false,
      code: "AI_SEMANTIC_SELECTION_INVALID",
      message: "模型选择了范围外的语义模型，请重试。",
    }, 400);
  }

  try {
    const semanticQuery = {
      modelId: model.id,
      modelVersion: model.version,
      metricIds: selection.data.metricIds,
      dimensionIds: selection.data.dimensionIds,
      filters: [],
      limit: 200,
    };
    const compiled = compileSemanticQuery(semanticQuery, models);
    const chartIssue = semanticChartContractIssue(selection.data.chartType, compiled);
    if (chartIssue) {
      return c.json({
        ok: false,
        code: "AI_SEMANTIC_SELECTION_INVALID",
        message: chartIssue,
      }, 400);
    }
    const result = await executeLocalReadOnlyQueryWithMetadata(
      compiled.sqlText,
      compiled.parameters,
      { limit: compiled.query.limit },
    );
    if (result.truncated) {
      return c.json({
        ok: false,
        code: "SEMANTIC_QUERY_INCOMPLETE",
        message: "AI 选择的维度结果过多，请缩小问题范围。",
      }, 422);
    }
    if (result.rows.length === 0) {
      return c.json({
        ok: false,
        code: "SEMANTIC_QUERY_EMPTY",
        message: "查询无数据，请换个问题试试。",
      }, 400);
    }

    const dimensionColumns = compiled.columns.filter((column) => column.kind === "dimension");
    const metricColumns = compiled.columns.filter((column) => column.kind === "metric");
    const finalSpec = {
      chartType: selection.data.chartType,
      xField: dimensionColumns[0]?.alias ?? "",
      yFields: metricColumns.map((column) => column.alias),
      seriesField: dimensionColumns[1]?.alias ?? "",
      title: selection.data.title,
      reason: selection.data.reason,
      semanticQuery,
      semanticModelId: model.id,
      semanticModelVersion: model.version,
      metricIds: selection.data.metricIds,
      dimensionIds: selection.data.dimensionIds,
    };
    const fix = reconcileChartType(finalSpec, result.rows, question);
    if (fix && fix.type !== finalSpec.chartType) {
      finalSpec.chartType = fix.type as typeof finalSpec.chartType;
      finalSpec.reason = `${fix.reason}${finalSpec.reason ? `（原因：${finalSpec.reason}）` : ""}`;
    }

    const pricing = AI_PRICING[modelTier];
    const cost = (
      ((usage?.prompt_tokens || 0) * pricing.in + (usage?.completion_tokens || 0) * pricing.out)
      / 1_000_000
    ).toFixed(4);
    return c.json({
      ok: true,
      data: {
        spec: finalSpec,
        rows: result.rows,
        columns: compiled.columns.map((column) => column.alias),
        warning: null,
        lineage: compiled.lineage,
        budget: compiled.budget,
        usage,
        costCny: cost,
      },
    });
  } catch (error) {
    if (error instanceof SemanticQueryError) {
      return c.json({
        ok: false,
        code: error.code,
        message: error.publicMessage,
        ...(error.details ? { details: error.details } : {}),
      }, error.status);
    }
    console.error("[board-ai-chart-semantic-query] failed", error);
    return c.json({
      ok: false,
      code: "SEMANTIC_QUERY_FAILED",
      message: "AI 指标查询失败，请稍后重试。",
    }, 500);
  }
});

export default r;
