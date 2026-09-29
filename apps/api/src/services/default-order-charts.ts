import { sql } from "../db/client";

export const DEFAULT_ORDER_CHARTS_SETTING = "default_orders_charts_seeded_v1";

export type DefaultOrderChartSeedResult = {
  status: "no_data" | "existing_charts" | "created" | "already_seeded" | "error";
  created: number;
  message?: string;
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

export interface DefaultOrderChartRepository {
  transaction<T>(work: (repo: DefaultOrderChartRepository) => Promise<T>): Promise<T>;
  lock(): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  countUnifiedRows(): Promise<number>;
  countCharts(): Promise<number>;
  insertDataset(input: DatasetInput): Promise<number>;
  insertChart(input: ChartInput): Promise<void>;
}

const defaultDatasets: DatasetInput[] = [
  {
    name: "各平台销售额占比",
    queryType: "semantic",
    queryText: JSON.stringify({
      modelId: "orders.analysis",
      modelVersion: 1,
      metricIds: ["orders.sales_amount"],
      dimensionIds: ["orders.platform"],
      filters: [],
      limit: 100,
    }),
  },
  {
    name: "品牌销售额 TOP10",
    queryType: "semantic",
    queryText: JSON.stringify({
      modelId: "orders.analysis",
      modelVersion: 1,
      metricIds: ["orders.sales_amount"],
      dimensionIds: ["orders.brand"],
      filters: [],
      limit: 10,
    }),
  },
];

const defaultCharts = [
  {
    name: "各平台销售额占比",
    chartType: "pie",
    config: {
      title: "各平台销售额占比",
      xField: "d0__orders__platform",
      yFields: ["m0__orders__sales_amount"],
      aggregationMode: "none",
      semanticModelId: "orders.analysis",
      semanticModelVersion: 1,
      metricIds: ["orders.sales_amount"],
      dimensionIds: ["orders.platform"],
    },
  },
  {
    name: "品牌销售额 TOP10",
    chartType: "bar",
    config: {
      title: "品牌销售额 TOP10",
      xField: "d0__orders__brand",
      yFields: ["m0__orders__sales_amount"],
      aggregationMode: "none",
      semanticModelId: "orders.analysis",
      semanticModelVersion: 1,
      metricIds: ["orders.sales_amount"],
      dimensionIds: ["orders.brand"],
    },
  },
];

function sqlRepository(executor: any, root: boolean): DefaultOrderChartRepository {
  const repository: DefaultOrderChartRepository = {
    async transaction<T>(work: (repo: DefaultOrderChartRepository) => Promise<T>): Promise<T> {
      if (!root) return work(repository);
      return (await sql.begin(async (tx) => work(sqlRepository(tx, false)))) as T;
    },
    async lock() {
      await executor.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
        DEFAULT_ORDER_CHARTS_SETTING,
      ]);
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
        `INSERT INTO public.settings(key, value, updated_at) VALUES($1, $2, NOW())
         ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value],
      );
    },
    async countUnifiedRows() {
      const rows = await executor.unsafe(
        "SELECT COUNT(*)::int AS count FROM public.unified_sales",
      );
      return Number(rows[0]?.count ?? 0);
    },
    async countCharts() {
      const rows = await executor.unsafe("SELECT COUNT(*)::int AS count FROM public.charts");
      return Number(rows[0]?.count ?? 0);
    },
    async insertDataset(input) {
      const rows = await executor.unsafe(
        `INSERT INTO public.datasets(name, source_id, query_type, query_text, fields)
         VALUES($1, NULL, $2, $3, NULL) RETURNING id`,
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

export async function ensureDefaultOrderCharts(
  repository: DefaultOrderChartRepository = sqlRepository(sql, true),
): Promise<DefaultOrderChartSeedResult> {
  return repository.transaction(async (tx) => {
    await tx.lock();

    if ((await tx.getSetting(DEFAULT_ORDER_CHARTS_SETTING)) === "true") {
      return { status: "already_seeded", created: 0 };
    }

    if ((await tx.countUnifiedRows()) === 0) {
      return { status: "no_data", created: 0 };
    }

    if ((await tx.countCharts()) > 0) {
      await tx.setSetting(DEFAULT_ORDER_CHARTS_SETTING, "true");
      return { status: "existing_charts", created: 0 };
    }

    for (let index = 0; index < defaultDatasets.length; index += 1) {
      const datasetId = await tx.insertDataset(defaultDatasets[index]);
      await tx.insertChart({
        datasetId,
        ...defaultCharts[index],
        moduleCode: "orders",
      });
    }
    await tx.setSetting(DEFAULT_ORDER_CHARTS_SETTING, "true");
    return { status: "created", created: defaultCharts.length };
  });
}
