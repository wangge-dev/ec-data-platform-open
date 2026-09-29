// 版本化语义指标对比 API。
// 调用方只提交 metricId / dimensionId，不再提交物理字段名或任意聚合函数。
import { Hono } from "hono";

import { authMiddleware } from "../lib/auth.js";
import { executeLocalReadOnlyQueryWithMetadata } from "../lib/local-readonly-sql.js";
import {
  compileSemanticQuery,
  loadSemanticModels,
  SemanticQueryError,
  type CompiledSemanticQuery,
  type RuntimeSemanticModel,
} from "../services/semantic-model.js";

const r = new Hono();
r.use("*", authMiddleware);

type ComparePeriod = "dod" | "wow" | "mom" | "yoy";

function stableError(c: any, error: unknown) {
  if (error instanceof SemanticQueryError) {
    return c.json(
      {
        ok: false,
        code: error.code,
        message: error.publicMessage,
        ...(error.details ? { details: error.details } : {}),
      },
      error.status,
    );
  }
  console.error("[metrics] unexpected failure", error);
  return c.json({
    ok: false,
    code: "SEMANTIC_QUERY_FAILED",
    message: "指标查询失败，请稍后重试。",
  }, 500);
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? null
    : date;
}

function previousDate(value: string, period: ComparePeriod): string {
  const date = parseIsoDate(value);
  if (!date) {
    throw new SemanticQueryError(
      "SEMANTIC_QUERY_INVALID",
      "基准日期无效，请使用真实存在的 YYYY-MM-DD 日期。",
      400,
    );
  }
  if (period === "dod") date.setUTCDate(date.getUTCDate() - 1);
  if (period === "wow") date.setUTCDate(date.getUTCDate() - 7);
  if (period === "mom") date.setUTCMonth(date.getUTCMonth() - 1);
  if (period === "yoy") date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
}

function modelForModule(models: RuntimeSemanticModel[], moduleCode: string): RuntimeSemanticModel {
  const candidates = models.filter((model) => model.moduleCode === moduleCode);
  if (candidates.length !== 1) {
    throw new SemanticQueryError(
      "SEMANTIC_MODEL_NOT_FOUND",
      "该模块尚未建立唯一的语义指标清单。",
      404,
      { moduleCode },
    );
  }
  return candidates[0];
}

async function runComplete(compiled: CompiledSemanticQuery) {
  let result;
  try {
    result = await executeLocalReadOnlyQueryWithMetadata(
      compiled.sqlText,
      compiled.parameters,
      { limit: compiled.query.limit },
    );
  } catch (error) {
    console.error("[metrics] semantic execution failed", {
      modelId: compiled.lineage.modelId,
      modelVersion: compiled.lineage.modelVersion,
      error,
    });
    throw new SemanticQueryError(
      "SEMANTIC_QUERY_FAILED",
      "指标查询执行失败，请检查模型数据后重试。",
      500,
    );
  }
  if (result.truncated) {
    throw new SemanticQueryError(
      "SEMANTIC_QUERY_INCOMPLETE",
      `指标结果超过 ${result.rowLimit.toLocaleString("zh-CN")} 行，请缩小维度范围。`,
      422,
      { rowLimit: result.rowLimit },
    );
  }
  return result.rows as Array<Record<string, unknown>>;
}

r.get("/compare", async (c) => {
  try {
    const moduleCode = c.req.query("module") ?? "";
    const metricId = c.req.query("metricId") ?? "";
    const dimensionId = c.req.query("dimensionId") || undefined;
    const period = (c.req.query("period") || "mom") as ComparePeriod;
    const baseDate = c.req.query("date") || new Date().toISOString().slice(0, 10);

    if (!moduleCode || !metricId) {
      throw new SemanticQueryError(
        "SEMANTIC_QUERY_INVALID",
        "缺少 module 或 metricId 参数。",
        400,
      );
    }
    if (!(["dod", "wow", "mom", "yoy"] as string[]).includes(period)) {
      throw new SemanticQueryError(
        "SEMANTIC_QUERY_INVALID",
        "对比周期无效。",
        400,
      );
    }

    const models = await loadSemanticModels();
    const model = modelForModule(models, moduleCode);
    const timeDimension = model.dimensions.find((dimension) => dimension.kind === "time");
    if (!timeDimension) {
      throw new SemanticQueryError(
        "SEMANTIC_DIMENSION_NOT_FOUND",
        "该模块未声明时间维度，无法做时间对比。",
        400,
      );
    }

    const makeQuery = (date: string) => compileSemanticQuery({
      modelId: model.id,
      modelVersion: model.version,
      metricIds: [metricId],
      dimensionIds: dimensionId ? [dimensionId] : [],
      filters: [{ dimensionId: timeDimension.id, operator: "eq", value: date }],
      limit: 5_000,
    }, models);
    const currentQuery = makeQuery(baseDate);
    const previousQuery = makeQuery(previousDate(baseDate, period));
    const [current, previous] = await Promise.all([
      runComplete(currentQuery),
      runComplete(previousQuery),
    ]);

    const metricColumn = currentQuery.columns.find((column) => column.kind === "metric")!;
    const dimensionColumn = currentQuery.columns.find((column) => column.kind === "dimension");
    const keyFor = (row: Record<string, unknown>) => dimensionColumn
      ? String(row[dimensionColumn.alias] ?? "")
      : "(总)";
    const valueFor = (row: Record<string, unknown>) => Number(row[metricColumn.alias]) || 0;
    const previousMap = new Map(previous.map((row) => [keyFor(row), valueFor(row)]));
    const rows = current.map((row) => {
      const dim = keyFor(row);
      const currentValue = valueFor(row);
      const previousValue = previousMap.get(dim) ?? 0;
      const delta = currentValue - previousValue;
      return {
        dim,
        current: currentValue,
        previous: previousValue,
        delta,
        rate: previousValue === 0 ? null : (delta / previousValue) * 100,
      };
    });

    const metric = model.metrics.find((candidate) => candidate.id === metricId)!;
    const dimension = dimensionId
      ? model.dimensions.find((candidate) => candidate.id === dimensionId)!
      : null;
    return c.json({
      ok: true,
      data: {
        module: moduleCode,
        metricId,
        metricLabel: metric.label,
        aggregation: metric.aggregation,
        dimensionId: dimension?.id ?? null,
        dimensionLabel: dimension?.label ?? null,
        period,
        baseDate,
        rows,
        lineage: currentQuery.lineage,
        budget: currentQuery.budget,
      },
    });
  } catch (error) {
    return stableError(c, error);
  }
});

r.get("/dates", async (c) => {
  try {
    const moduleCode = c.req.query("module") ?? "";
    if (!moduleCode) {
      throw new SemanticQueryError("SEMANTIC_QUERY_INVALID", "缺少 module 参数。", 400);
    }
    const models = await loadSemanticModels();
    const model = modelForModule(models, moduleCode);
    const timeDimension = model.dimensions.find((dimension) => dimension.kind === "time");
    if (!timeDimension) return c.json({ ok: true, data: [] });

    const field = `"${timeDimension.field}"`;
    const where = [model.source.whereSql, `${field} IS NOT NULL`].filter(Boolean).join(" AND ");
    const result = await executeLocalReadOnlyQueryWithMetadata(
      `SELECT DISTINCT DATE(${field})::text AS d
       FROM ${model.source.tableReference}
       WHERE ${where}
       ORDER BY d DESC
       LIMIT 365`,
      [],
      { limit: 365 },
    );
    return c.json({
      ok: true,
      data: (result.rows as Array<{ d: string }>).map((row) => row.d),
    });
  } catch (error) {
    return stableError(c, error);
  }
});

export default r;
