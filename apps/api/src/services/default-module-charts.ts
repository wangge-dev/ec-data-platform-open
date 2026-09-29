import { sql } from "../db/client.js";
import type { ModuleDef } from "../modules/schema.js";
import { semanticColumnAlias } from "./semantic-model.js";

const SETTING_PREFIX = "default_module_charts_seeded_v1:";

export type DefaultModuleChartResult = {
  createdDatasets: number;
  createdCharts: number;
  skipped: boolean;
  reason?:
    | "already_initialized"
    | "no_supported_roles"
    | "no_successful_etl";
};

type DatasetInput = {
  name: string;
  queryType: string;
  queryText: string;
};

type ChartInput = {
  datasetId: number;
  name: string;
  chartType: string;
  config: unknown;
  moduleCode: string;
};

export interface DefaultModuleChartDeps {
  transaction<T>(
    work: (deps: DefaultModuleChartDeps) => Promise<T>,
  ): Promise<T>;
  lock(key: string): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  insertDataset(input: DatasetInput): Promise<number>;
  insertChart(input: ChartInput): Promise<void>;
}

type ChartTemplate = {
  dataset: DatasetInput;
  chart: Omit<ChartInput, "datasetId" | "moduleCode">;
};

export function defaultModuleChartsSettingKey(moduleCode: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(moduleCode)) {
    throw new Error(`Invalid module code: ${moduleCode}`);
  }
  return `${SETTING_PREFIX}${moduleCode}`;
}

function boundedChartName(moduleName: string, suffix: string): string {
  const suffixCharacters = Array.from(suffix);
  const prefixCharacters = Array.from(moduleName);
  const prefixLimit = Math.max(0, 128 - suffixCharacters.length);
  return [
    ...prefixCharacters.slice(0, prefixLimit),
    ...suffixCharacters.slice(0, 128),
  ]
    .slice(0, 128)
    .join("");
}

function buildSemanticTemplates(module: ModuleDef): ChartTemplate[] {
  const model = module.semanticModel;
  if (!model) return [];
  const metric = model.metrics[0];
  const time = model.dimensions.find((dimension) => dimension.kind === "time");
  // Default dashboards must not group tens of thousands of rows by order or
  // product IDs. Prefer business slices that are normally low-cardinality;
  // only fall back to the first categorical dimension for unusual modules.
  const preferredCategoryColumn = ([
    "shop",
    "dimension",
    "status",
    "product_name",
    "sku",
  ] as const)
    .map((role) => module.columns.find((column) => column.semanticRole === role))
    .find((column) => column !== undefined);
  const inferredCategory = (
    preferredCategoryColumn
      ? model.dimensions.find((dimension) => (
          dimension.kind === "categorical"
          && dimension.field === preferredCategoryColumn.name
        ))
      : undefined
  ) ?? model.dimensions.find((dimension) => dimension.kind === "categorical");
  const category = model.defaultRankingDimensionId === null
    ? undefined
    : typeof model.defaultRankingDimensionId === "string"
      ? model.dimensions.find(
          (dimension) => dimension.id === model.defaultRankingDimensionId,
        )
      : inferredCategory;
  const templates: ChartTemplate[] = [];

  const add = (
    suffix: string,
    chartType: "line" | "bar",
    dimensionIds: string[],
    limit: number,
  ) => {
    const name = boundedChartName(module.name, suffix);
    const timeIndex = time
      ? dimensionIds.findIndex((dimensionId) => dimensionId === time.id)
      : -1;
    const semanticQuery = {
      modelId: model.id,
      modelVersion: model.version,
      metricIds: [metric.id],
      dimensionIds,
      filters: [],
      limit,
    };
    templates.push({
      dataset: {
        name,
        queryType: "semantic",
        queryText: JSON.stringify(semanticQuery),
      },
      chart: {
        name,
        chartType,
        config: {
          title: name,
          xField: semanticColumnAlias(dimensionIds[0], "dimension", 0),
          yFields: [semanticColumnAlias(metric.id, "metric", 0)],
          ...(dimensionIds.length > 1
            ? { seriesField: semanticColumnAlias(dimensionIds[1], "dimension", 1) }
            : {}),
          aggregationMode: "none",
          semanticModelId: model.id,
          semanticModelVersion: model.version,
          metricIds: [metric.id],
          dimensionIds,
          ...(timeIndex >= 0
            ? { dateField: semanticColumnAlias(time!.id, "dimension", timeIndex) }
            : {}),
        },
      },
    });
  };

  if (time) add("指标趋势", "line", [time.id], 500);
  if (category && metric.additiveAcrossTime !== false) {
    add("指标排行", "bar", [category.id], 100);
  } else if (category && time) {
    // 快照/余额类指标不能跨时间相加。排行同时携带时间维度，既满足
    // 语义编译器的口径约束，也让图表按报告期分系列展示。
    add("指标排行", "bar", [category.id, time.id], 100);
  }
  return templates;
}

function buildTemplates(module: ModuleDef): ChartTemplate[] {
  return module.semanticModel ? buildSemanticTemplates(module) : [];
}

function sqlRepository(
  executor: any,
  root: boolean,
): DefaultModuleChartDeps {
  const repository: DefaultModuleChartDeps = {
    async transaction<T>(
      work: (deps: DefaultModuleChartDeps) => Promise<T>,
    ): Promise<T> {
      if (!root) return work(repository);
      return (await sql.begin(async (tx) =>
        work(sqlRepository(tx, false)),
      )) as T;
    },
    async lock(key) {
      await executor.unsafe(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [key],
      );
    },
    async getSetting(key) {
      const rows = await executor.unsafe(
        "SELECT value FROM public.settings WHERE key = $1 LIMIT 1",
        [key],
      );
      return rows[0]?.value ?? null;
    },
    async setSetting(key, value) {
      await executor.unsafe(
        `INSERT INTO public.settings(key, value, updated_at)
         VALUES($1, $2, NOW())
         ON CONFLICT(key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value],
      );
    },
    async insertDataset(input) {
      const rows = await executor.unsafe(
        `INSERT INTO public.datasets(name, source_id, query_type, query_text, fields)
         VALUES($1, NULL, $2, $3, NULL)
         RETURNING id`,
        [input.name, input.queryType, input.queryText],
      );
      return Number(rows[0].id);
    },
    async insertChart(input) {
      await executor.unsafe(
        `INSERT INTO public.charts(dataset_id, name, chart_type, config, module_code)
         VALUES($1, $2, $3, $4::jsonb, $5)`,
        [
          input.datasetId,
          input.name,
          input.chartType,
          JSON.stringify(input.config),
          input.moduleCode,
        ],
      );
    },
  };
  return repository;
}

export async function ensureDefaultModuleCharts(
  module: ModuleDef,
  deps: DefaultModuleChartDeps = sqlRepository(sql, true),
): Promise<DefaultModuleChartResult> {
  const templates = buildTemplates(module);
  if (templates.length === 0) {
    return {
      createdDatasets: 0,
      createdCharts: 0,
      skipped: true,
      reason: "no_supported_roles",
    };
  }

  const settingKey = defaultModuleChartsSettingKey(module.code);
  return deps.transaction(async (tx) => {
    await tx.lock(settingKey);
    if ((await tx.getSetting(settingKey)) === "true") {
      return {
        createdDatasets: 0,
        createdCharts: 0,
        skipped: true,
        reason: "already_initialized",
      };
    }

    for (const template of templates) {
      const datasetId = await tx.insertDataset(template.dataset);
      await tx.insertChart({
        datasetId,
        ...template.chart,
        moduleCode: module.code,
      });
    }
    await tx.setSetting(settingKey, "true");
    return {
      createdDatasets: templates.length,
      createdCharts: templates.length,
      skipped: false,
    };
  });
}
