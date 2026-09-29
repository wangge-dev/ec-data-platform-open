import { z } from "zod";

import {
  LOCAL_SQL_MAX_CONCURRENCY,
  LOCAL_SQL_MAX_ROWS,
  LOCAL_SQL_STATEMENT_TIMEOUT_MS,
} from "../lib/local-readonly-sql.js";
import { runtimeTableReference } from "../db/table-scope.js";
import { loadModules, moduleTableName, type LoadedModule } from "../modules/loader.js";
import {
  SemanticModelSchema,
  type SemanticDimensionDef,
  type SemanticMetricDef,
  type SemanticModelDef,
} from "../modules/schema.js";
import { FRONT_PROFIT_MODULE_CODE } from "./front-profit-period.js";

export const SEMANTIC_QUERY_DEFAULT_LIMIT = 500;
export const SEMANTIC_QUERY_MAX_DIMENSIONS = 3;
export const SEMANTIC_QUERY_MAX_METRICS = 6;

const SemanticFilterSchema = z.object({
  dimensionId: z.string().min(1),
  operator: z.enum(["eq", "gte", "lte"]),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

export const SemanticQuerySchema = z.object({
  modelId: z.string().min(1),
  modelVersion: z.number().int().positive(),
  metricIds: z.array(z.string().min(1)).min(1).max(SEMANTIC_QUERY_MAX_METRICS),
  dimensionIds: z.array(z.string().min(1)).max(SEMANTIC_QUERY_MAX_DIMENSIONS).default([]),
  filters: z.array(SemanticFilterSchema).max(12).default([]),
  limit: z.number().int().positive().max(LOCAL_SQL_MAX_ROWS).default(SEMANTIC_QUERY_DEFAULT_LIMIT),
});
export type SemanticQuery = z.infer<typeof SemanticQuerySchema>;

export type RuntimeSemanticModel = SemanticModelDef & {
  moduleCode: string;
  moduleName: string;
  moduleVersion: number | null;
  origin: "builtin" | "user" | "fixed";
  source: {
    tableName: string;
    tableReference: string;
    whereSql?: string;
  };
};

export type SemanticColumnBinding = {
  id: string;
  alias: string;
  label: string;
  kind: "metric" | "dimension";
  unit?: SemanticMetricDef["unit"];
  dimensionKind?: SemanticDimensionDef["kind"];
};

export type CompiledSemanticQuery = {
  query: SemanticQuery;
  sqlText: string;
  parameters: Array<string | number | boolean>;
  columns: SemanticColumnBinding[];
  lineage: {
    schemaVersion: "semantic-lineage/v1";
    modelId: string;
    modelVersion: number;
    moduleCode: string;
    moduleVersion: number | null;
    sourceTable: string;
    metricIds: string[];
    dimensionIds: string[];
  };
  budget: {
    schemaVersion: "semantic-query-budget/v1";
    maxRows: number;
    statementTimeoutMs: number;
    maxConcurrency: number;
  };
};

export type SemanticErrorCode =
  | "SEMANTIC_QUERY_INVALID"
  | "SEMANTIC_MODEL_NOT_FOUND"
  | "SEMANTIC_MODEL_VERSION_MISMATCH"
  | "SEMANTIC_METRIC_NOT_FOUND"
  | "SEMANTIC_DIMENSION_NOT_FOUND"
  | "SEMANTIC_TIME_GRAIN_REQUIRED"
  | "SEMANTIC_QUERY_INCOMPLETE"
  | "SEMANTIC_QUERY_FAILED";

export class SemanticQueryError extends Error {
  constructor(
    readonly code: SemanticErrorCode,
    readonly publicMessage: string,
    readonly status: 400 | 404 | 409 | 422 | 500,
    readonly details?: Record<string, unknown>,
  ) {
    super(publicMessage);
    this.name = "SemanticQueryError";
  }
}

const FRONT_PROFIT_SEMANTIC_MODEL = SemanticModelSchema.parse({
  schemaVersion: "semantic-manifest/v1",
  id: "front_profit.performance",
  version: 1,
  dimensions: [
    { id: "front_profit.date", label: "日期", field: "date", kind: "time" },
    { id: "front_profit.platform", label: "平台", field: "platform" },
    { id: "front_profit.business_mode", label: "业务模式", field: "business_mode" },
    { id: "front_profit.shop", label: "店铺", field: "shop" },
    { id: "front_profit.operator", label: "运营", field: "operator" },
  ],
  metrics: [
    { id: "front_profit.gmv", label: "GMV", aggregation: "sum", field: "gmv", unit: "currency" },
    { id: "front_profit.real_revenue", label: "真实营业额", aggregation: "sum", field: "real_revenue", unit: "currency" },
    { id: "front_profit.profit", label: "前台利润", aggregation: "sum", field: "front_profit", unit: "currency" },
    { id: "front_profit.quantity", label: "单量", aggregation: "sum", field: "quantity", unit: "quantity" },
    { id: "front_profit.promotion_fee", label: "推广费", aggregation: "sum", field: "promotion_fee", unit: "currency" },
    {
      id: "front_profit.paid_ratio",
      label: "付费占比",
      aggregation: "ratio",
      numeratorField: "promotion_fee",
      denominatorField: "gmv",
      unit: "percent",
      description: "按推广费与 GMV 分别求和后再相除，禁止对行级比率直接求和或平均。",
    },
  ],
});

function runtimeModelFromModule(module: LoadedModule): RuntimeSemanticModel | null {
  if (!module.semanticModel) return null;
  const tableName = moduleTableName(module);
  return {
    ...module.semanticModel,
    moduleCode: module.code,
    moduleName: module.name,
    moduleVersion: module.version ?? null,
    origin: module.origin,
    source: {
      tableName,
      tableReference: runtimeTableReference(tableName),
      ...(module.origin === "user"
        ? { whereSql: `COALESCE("_included", true) = true` }
        : {}),
    },
  };
}

export async function loadSemanticModels(): Promise<RuntimeSemanticModel[]> {
  const modules = await loadModules();
  const configured = modules
    .map(runtimeModelFromModule)
    .filter((model): model is RuntimeSemanticModel => model !== null);
  return [
    {
      ...FRONT_PROFIT_SEMANTIC_MODEL,
      moduleCode: FRONT_PROFIT_MODULE_CODE,
      moduleName: "前台利润",
      moduleVersion: null,
      origin: "fixed",
      source: {
        tableName: "front_profit_publish_row",
        tableReference: `"public"."front_profit_publish_row"`,
        whereSql: `"status" = 'published'`,
      },
    },
    ...configured,
  ];
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
    throw new SemanticQueryError(
      "SEMANTIC_QUERY_INVALID",
      "语义模型包含不可安全引用的字段。",
      500,
    );
  }
  return `"${identifier}"`;
}

export function semanticColumnAlias(id: string, kind: "metric" | "dimension", index: number): string {
  const suffix = id.replace(/[^a-z0-9_]/g, "__").slice(-48);
  return `${kind === "metric" ? "m" : "d"}${index}__${suffix}`;
}

function metricSql(metric: SemanticMetricDef): string {
  if (metric.aggregation === "count") {
    return metric.field
      ? `COUNT(${quoteIdentifier(metric.field)})`
      : "COUNT(*)";
  }
  if (metric.aggregation === "ratio") {
    return `SUM(${quoteIdentifier(metric.numeratorField!)})::numeric / NULLIF(SUM(${quoteIdentifier(metric.denominatorField!)}), 0)`;
  }
  const functions = {
    sum: "SUM",
    average: "AVG",
    min: "MIN",
    max: "MAX",
  } as const;
  return `${functions[metric.aggregation]}(${quoteIdentifier(metric.field!)})`;
}

function dimensionSql(dimension: SemanticDimensionDef): string {
  const field = quoteIdentifier(dimension.field);
  if (dimension.kind !== "time") return field;
  return dimension.timeGrain === "month"
    ? `DATE_TRUNC('month', ${field})::date`
    : `DATE(${field})`;
}

function findModel(
  query: SemanticQuery,
  models: RuntimeSemanticModel[],
): RuntimeSemanticModel {
  const model = models.find((candidate) => candidate.id === query.modelId);
  if (!model) {
    throw new SemanticQueryError(
      "SEMANTIC_MODEL_NOT_FOUND",
      "请求的语义模型不存在或尚未启用。",
      404,
      { modelId: query.modelId },
    );
  }
  if (model.version !== query.modelVersion) {
    throw new SemanticQueryError(
      "SEMANTIC_MODEL_VERSION_MISMATCH",
      "语义模型版本已经变化，请刷新后重试。",
      409,
      { modelId: model.id, requestedVersion: query.modelVersion, currentVersion: model.version },
    );
  }
  return model;
}

function findDimension(model: RuntimeSemanticModel, id: string): SemanticDimensionDef {
  const dimension = model.dimensions.find((candidate) => candidate.id === id);
  if (!dimension) {
    throw new SemanticQueryError(
      "SEMANTIC_DIMENSION_NOT_FOUND",
      "请求包含模型未声明的维度。",
      400,
      { modelId: model.id, dimensionId: id },
    );
  }
  return dimension;
}

function findMetric(model: RuntimeSemanticModel, id: string): SemanticMetricDef {
  const metric = model.metrics.find((candidate) => candidate.id === id);
  if (!metric) {
    throw new SemanticQueryError(
      "SEMANTIC_METRIC_NOT_FOUND",
      "请求包含模型未声明的指标。",
      400,
      { modelId: model.id, metricId: id },
    );
  }
  return metric;
}

export function compileSemanticQuery(
  rawQuery: unknown,
  models: RuntimeSemanticModel[],
): CompiledSemanticQuery {
  const parsed = SemanticQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    throw new SemanticQueryError(
      "SEMANTIC_QUERY_INVALID",
      "语义查询格式无效。",
      400,
      { issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
    );
  }
  const query = parsed.data;
  const model = findModel(query, models);
  const metrics = query.metricIds.map((id) => findMetric(model, id));
  const dimensions = query.dimensionIds.map((id) => findDimension(model, id));
  const filters = query.filters.map((filter) => ({
    ...filter,
    dimension: findDimension(model, filter.dimensionId),
  }));

  const hasTimeGrain = dimensions.some((dimension) => dimension.kind === "time")
    || filters.some((filter) => filter.dimension.kind === "time" && filter.operator === "eq");
  const timeUnsafeMetric = metrics.find((metric) => metric.additiveAcrossTime === false);
  if (timeUnsafeMetric && !hasTimeGrain) {
    throw new SemanticQueryError(
      "SEMANTIC_TIME_GRAIN_REQUIRED",
      "该指标不能跨时间直接汇总，请选择时间维度或限定一个确切日期。",
      422,
      { metricId: timeUnsafeMetric.id },
    );
  }

  const columns: SemanticColumnBinding[] = [];
  const dimensionSelect = dimensions.map((dimension, index) => {
    const alias = semanticColumnAlias(dimension.id, "dimension", index);
    columns.push({
      id: dimension.id,
      alias,
      label: dimension.label,
      kind: "dimension",
      dimensionKind: dimension.kind,
    });
    return `${dimensionSql(dimension)} AS ${quoteIdentifier(alias)}`;
  });
  const metricSelect = metrics.map((metric, index) => {
    const alias = semanticColumnAlias(metric.id, "metric", index);
    columns.push({ id: metric.id, alias, label: metric.label, kind: "metric", unit: metric.unit });
    return `${metricSql(metric)}::numeric AS ${quoteIdentifier(alias)}`;
  });

  const parameters: Array<string | number | boolean> = [];
  const where = model.source.whereSql ? [model.source.whereSql] : [];
  for (const filter of filters) {
    parameters.push(filter.value);
    const operator = { eq: "=", gte: ">=", lte: "<=" }[filter.operator];
    const field = quoteIdentifier(filter.dimension.field);
    const expression = filter.dimension.kind === "time" ? `DATE(${field})` : field;
    const cast = filter.dimension.kind === "time" ? "::date" : "";
    where.push(`${expression} ${operator} $${parameters.length}${cast}`);
  }

  const select = [...dimensionSelect, ...metricSelect].join(", ");
  const groupBy = dimensions.length
    ? ` GROUP BY ${dimensions.map(dimensionSql).join(", ")}`
    : "";
  const firstMetricAlias = columns.find((column) => column.kind === "metric")!.alias;
  const dimensionColumns = columns.filter((column) => column.kind === "dimension");
  const orderBy = dimensions.length
    ? dimensions[0].kind === "time"
      ? ` ORDER BY ${dimensionColumns.map((column) => `${quoteIdentifier(column.alias)} ASC NULLS LAST`).join(", ")}`
      : ` ORDER BY ${quoteIdentifier(firstMetricAlias)} DESC NULLS LAST`
    : "";
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";

  return {
    query,
    sqlText: `SELECT ${select} FROM ${model.source.tableReference}${whereSql}${groupBy}${orderBy}`,
    parameters,
    columns,
    lineage: {
      schemaVersion: "semantic-lineage/v1",
      modelId: model.id,
      modelVersion: model.version,
      moduleCode: model.moduleCode,
      moduleVersion: model.moduleVersion,
      sourceTable: model.source.tableName,
      metricIds: [...query.metricIds],
      dimensionIds: [...query.dimensionIds],
    },
    budget: {
      schemaVersion: "semantic-query-budget/v1",
      maxRows: query.limit,
      statementTimeoutMs: LOCAL_SQL_STATEMENT_TIMEOUT_MS,
      maxConcurrency: LOCAL_SQL_MAX_CONCURRENCY,
    },
  };
}

export function publicSemanticModel(model: RuntimeSemanticModel) {
  return {
    schemaVersion: model.schemaVersion,
    id: model.id,
    version: model.version,
    moduleCode: model.moduleCode,
    moduleName: model.moduleName,
    moduleVersion: model.moduleVersion,
    origin: model.origin,
    dimensions: model.dimensions.map((dimension) => ({
      id: dimension.id,
      label: dimension.label,
      kind: dimension.kind,
      ...(dimension.kind === "time" ? { timeGrain: dimension.timeGrain ?? "day" } : {}),
      ...(dimension.description ? { description: dimension.description } : {}),
    })),
    metrics: model.metrics.map((metric) => ({
      id: metric.id,
      label: metric.label,
      aggregation: metric.aggregation,
      unit: metric.unit,
      additiveAcrossTime: metric.additiveAcrossTime,
      ...(metric.description ? { description: metric.description } : {}),
    })),
  };
}
