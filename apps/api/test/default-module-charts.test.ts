import { describe, expect, test, vi } from "vitest";
import type { ModuleDef } from "../src/modules/schema.js";
import {
  defaultModuleChartsSettingKey,
  ensureDefaultModuleCharts,
  type DefaultModuleChartDeps,
} from "../src/services/default-module-charts.js";

type Dataset = {
  id: number;
  name: string;
  queryType: string;
  queryText: string;
};

type Chart = {
  datasetId: number;
  name: string;
  chartType: string;
  config: unknown;
  moduleCode: string;
};

function samplePinduoduoModule(): ModuleDef {
  return {
    code: "pinduoduo_sales",
    name: "拼多多销售",
    columns: [
      {
        name: "paid_at",
        source: "支付时间",
        label: "支付时间",
        type: "timestamp",
        required: true,
        computed: false,
        semanticRole: "time",
      },
      {
        name: "sales_amount",
        source: "商品金额",
        label: "商品金额",
        type: "numeric",
        required: true,
        computed: false,
        semanticRole: "amount",
      },
      {
        name: "goods_name",
        source: "商品名称",
        label: "商品名称",
        type: "text",
        required: false,
        computed: false,
        semanticRole: "product_name",
      },
      {
        name: "order_status",
        source: "订单状态",
        label: "订单状态",
        type: "text",
        required: true,
        computed: false,
        semanticRole: "status",
      },
      {
        name: "quantity",
        source: "数量",
        label: "数量",
        type: "numeric",
        required: false,
        computed: false,
        semanticRole: "quantity",
      },
    ],
    platforms: [
      {
        code: "generic",
        name: "通用",
        filePattern: "orders_export",
        patternFlags: "i",
        enabled: true,
      },
    ],
    timeKey: "paid_at",
    semanticModel: {
      schemaVersion: "semantic-manifest/v1",
      id: "pinduoduo_sales.analysis",
      version: 1,
      dimensions: [
        { id: "pinduoduo_sales.date", label: "日期", field: "paid_at", kind: "time" },
        { id: "pinduoduo_sales.product", label: "商品", field: "goods_name", kind: "categorical" },
      ],
      metrics: [
        { id: "pinduoduo_sales.sales_amount", label: "销售额", aggregation: "sum", field: "sales_amount", unit: "currency", additiveAcrossTime: true },
      ],
    },
    usages: ["summary", "ai_chart", "ai_analysis"],
    enabled: true,
    hasTransform: false,
    isDict: false,
  };
}

function fakeChartDeps(options: {
  initialized?: boolean;
  failChartAt?: number;
  serializeTransactions?: boolean;
} = {}): DefaultModuleChartDeps & {
  settings: Map<string, string>;
  datasets: Dataset[];
  charts: Chart[];
  insertChart: ReturnType<typeof vi.fn>;
} {
  const settings = new Map<string, string>();
  if (options.initialized) {
    settings.set(
      defaultModuleChartsSettingKey("pinduoduo_sales"),
      "true",
    );
  }
  const datasets: Dataset[] = [];
  const charts: Chart[] = [];
  let chartAttempts = 0;
  let transactionTail = Promise.resolve();
  const deps: DefaultModuleChartDeps & {
    settings: Map<string, string>;
    datasets: Dataset[];
    charts: Chart[];
    insertChart: ReturnType<typeof vi.fn>;
  } = {
    settings,
    datasets,
    charts,
    async transaction(work) {
      let releaseTransaction = () => {};
      const previousTransaction = transactionTail;
      if (options.serializeTransactions) {
        transactionTail = new Promise<void>((resolve) => {
          releaseTransaction = resolve;
        });
        await previousTransaction;
      }
      const settingSnapshot = new Map(settings);
      const datasetsLength = datasets.length;
      const chartsLength = charts.length;
      try {
        return await work(deps);
      } catch (error) {
        settings.clear();
        for (const [key, value] of settingSnapshot) settings.set(key, value);
        datasets.splice(datasetsLength);
        charts.splice(chartsLength);
        throw error;
      } finally {
        releaseTransaction();
      }
    },
    async lock() {},
    async getSetting(key) {
      return settings.get(key) ?? null;
    },
    async setSetting(key, value) {
      settings.set(key, value);
    },
    async insertDataset(input) {
      const id = datasets.length + 1;
      datasets.push({ id, ...input });
      return id;
    },
    insertChart: vi.fn(async (input: Chart) => {
      chartAttempts += 1;
      if (chartAttempts === options.failChartAt) {
        throw new Error("chart insert failed");
      }
      charts.push(input);
    }),
  };
  return deps;
}

describe("ensureDefaultModuleCharts", () => {
  test("creates semantic trend and ranking from versioned IDs", async () => {
    const deps = fakeChartDeps();

    const result = await ensureDefaultModuleCharts(
      samplePinduoduoModule(),
      deps,
    );

    expect(result).toEqual({
      createdDatasets: 2,
      createdCharts: 2,
      skipped: false,
    });
    expect(deps.charts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          moduleCode: "pinduoduo_sales",
          chartType: "line",
        }),
        expect.objectContaining({
          moduleCode: "pinduoduo_sales",
          chartType: "bar",
        }),
      ]),
    );
    expect(deps.datasets).toHaveLength(2);
    for (const dataset of deps.datasets) {
      expect(dataset.queryType).toBe("semantic");
      expect(JSON.parse(dataset.queryText)).toMatchObject({
        modelId: "pinduoduo_sales.analysis",
        modelVersion: 1,
        metricIds: ["pinduoduo_sales.sales_amount"],
      });
    }
    expect(deps.datasets.map((dataset) => JSON.parse(dataset.queryText).dimensionIds)).toEqual([
      ["pinduoduo_sales.date"],
      ["pinduoduo_sales.product"],
    ]);
    expect(deps.settings.get(
      defaultModuleChartsSettingKey("pinduoduo_sales"),
    )).toBe("true");
  });

  test("prefers shop over high-cardinality product identifiers for ranking", async () => {
    const deps = fakeChartDeps();
    const module = samplePinduoduoModule();
    module.columns.splice(2, 0,
      {
        name: "product_id",
        source: "商品ID",
        label: "商品ID",
        type: "text",
        required: false,
        computed: false,
        semanticRole: "product_id",
      },
      {
        name: "shop",
        source: "店铺",
        label: "店铺",
        type: "text",
        required: false,
        computed: false,
        semanticRole: "shop",
      },
    );
    module.semanticModel!.dimensions.splice(1, 0,
      { id: "pinduoduo_sales.product_id", label: "商品ID", field: "product_id", kind: "categorical" },
      { id: "pinduoduo_sales.shop", label: "店铺", field: "shop", kind: "categorical" },
    );

    await ensureDefaultModuleCharts(module, deps);

    expect(JSON.parse(deps.datasets[1].queryText).dimensionIds).toEqual([
      "pinduoduo_sales.shop",
    ]);
  });

  test("uses a module-declared business dimension instead of the global role guess", async () => {
    const deps = fakeChartDeps();
    const module = samplePinduoduoModule();
    module.columns.push({
      name: "shop",
      source: "店铺",
      label: "店铺",
      type: "text",
      required: false,
      computed: false,
      semanticRole: "shop",
    });
    module.semanticModel!.dimensions.push(
      { id: "pinduoduo_sales.status", label: "订单状态", field: "order_status", kind: "categorical" },
      { id: "pinduoduo_sales.shop", label: "店铺", field: "shop", kind: "categorical" },
    );
    (module.semanticModel as any).defaultRankingDimensionId = "pinduoduo_sales.status";

    await ensureDefaultModuleCharts(module, deps);

    expect(JSON.parse(deps.datasets[1].queryText).dimensionIds).toEqual([
      "pinduoduo_sales.status",
    ]);
  });

  test("allows summary modules to explicitly omit a meaningless ranking", async () => {
    const deps = fakeChartDeps();
    const module = samplePinduoduoModule();
    (module.semanticModel as any).defaultRankingDimensionId = null;

    const result = await ensureDefaultModuleCharts(module, deps);

    expect(result).toMatchObject({ createdDatasets: 1, createdCharts: 1 });
    expect(deps.charts.map((chart) => chart.chartType)).toEqual(["line"]);
  });

  test("adds the declared time dimension to rankings for non-additive snapshot metrics", async () => {
    const deps = fakeChartDeps();
    const module = samplePinduoduoModule();
    module.semanticModel!.metrics[0].additiveAcrossTime = false;

    await ensureDefaultModuleCharts(module, deps);

    expect(JSON.parse(deps.datasets[1].queryText).dimensionIds).toEqual([
      "pinduoduo_sales.product",
      "pinduoduo_sales.date",
    ]);
    expect(deps.charts[1].config).toMatchObject({
      xField: "d0__pinduoduo_sales__product",
      seriesField: "d1__pinduoduo_sales__date",
      dateField: "d1__pinduoduo_sales__date",
      dimensionIds: [
        "pinduoduo_sales.product",
        "pinduoduo_sales.date",
      ],
    });
  });

  test("does not recreate defaults after the user deletes them", async () => {
    const deps = fakeChartDeps({ initialized: true });

    const result = await ensureDefaultModuleCharts(
      samplePinduoduoModule(),
      deps,
    );

    expect(result).toEqual({
      createdDatasets: 0,
      createdCharts: 0,
      skipped: true,
      reason: "already_initialized",
    });
    expect(deps.insertChart).not.toHaveBeenCalled();
  });

  test("serializes concurrent initialization behind the durable marker", async () => {
    const deps = fakeChartDeps({ serializeTransactions: true });

    const [first, second] = await Promise.all([
      ensureDefaultModuleCharts(samplePinduoduoModule(), deps),
      ensureDefaultModuleCharts(samplePinduoduoModule(), deps),
    ]);

    expect([first.skipped, second.skipped].sort()).toEqual([false, true]);
    expect([first.reason, second.reason]).toContain("already_initialized");
    expect(deps.datasets).toHaveLength(2);
    expect(deps.charts).toHaveLength(2);
  });

  test("does not mark modules without supported role combinations", async () => {
    const deps = fakeChartDeps();
    const module = samplePinduoduoModule();
    module.semanticModel = undefined;

    const result = await ensureDefaultModuleCharts(module, deps);

    expect(result).toEqual({
      createdDatasets: 0,
      createdCharts: 0,
      skipped: true,
      reason: "no_supported_roles",
    });
    expect(deps.settings).toHaveLength(0);
  });

  test("does not guess defaults from physical roles without a semantic manifest", async () => {
    const deps = fakeChartDeps();
    const module = samplePinduoduoModule();
    module.semanticModel = undefined;

    const result = await ensureDefaultModuleCharts(module, deps);

    expect(result).toEqual({
      createdDatasets: 0,
      createdCharts: 0,
      skipped: true,
      reason: "no_supported_roles",
    });
    expect(deps.settings).toHaveLength(0);
  });

  test("uses the manifest instead of re-guessing changed column roles", async () => {
    const deps = fakeChartDeps();
    const module = samplePinduoduoModule();
    module.columns = module.columns.map((column) => {
      if (column.semanticRole === "time") {
        return { ...column, type: "text" as const };
      }
      if (column.semanticRole === "product_name") {
        return { ...column, type: "int" as const };
      }
      if (column.semanticRole === "status") {
        return { ...column, type: "boolean" as const };
      }
      return column;
    });

    const result = await ensureDefaultModuleCharts(module, deps);

    expect(result).toEqual({
      createdDatasets: 2,
      createdCharts: 2,
      skipped: false,
    });
    expect(deps.charts.map((chart) => chart.chartType).sort()).toEqual([
      "bar",
      "line",
    ]);
    const queries = deps.datasets.map((dataset) => dataset.queryText);
    expect(queries.every((query) => JSON.parse(query).modelId === "pinduoduo_sales.analysis")).toBe(true);
  });

  test("accepts date time and integer amount role types", async () => {
    const deps = fakeChartDeps();
    const module = samplePinduoduoModule();
    module.columns = module.columns.map((column) => {
      if (column.semanticRole === "time") {
        return { ...column, type: "date" as const };
      }
      if (column.semanticRole === "amount") {
        return { ...column, type: "int" as const };
      }
      return column;
    });

    const result = await ensureDefaultModuleCharts(module, deps);

    expect(result.skipped).toBe(false);
    expect(deps.charts.some((chart) => chart.chartType === "line")).toBe(
      true,
    );
  });

  test("bounds deterministic dataset and chart names to varchar 128", async () => {
    const deps = fakeChartDeps();
    const module = samplePinduoduoModule();
    module.name = "长".repeat(128);

    await ensureDefaultModuleCharts(module, deps);

    expect(deps.datasets).toHaveLength(2);
    expect(deps.datasets.map((dataset) => dataset.name)).toEqual(
      deps.charts.map((chart) => chart.name),
    );
    for (const name of deps.datasets.map((dataset) => dataset.name)) {
      expect(Array.from(name)).toHaveLength(128);
    }
    expect(new Set(deps.datasets.map((dataset) => dataset.name)).size).toBe(
      2,
    );
    expect(deps.datasets.some((dataset) =>
      dataset.name.endsWith("指标趋势"),
    )).toBe(true);
    expect(deps.datasets.some((dataset) =>
      dataset.name.endsWith("指标排行"),
    )).toBe(true);
  });

  test("rolls back charts and marker when any supported chart fails", async () => {
    const deps = fakeChartDeps({ failChartAt: 2 });

    await expect(
      ensureDefaultModuleCharts(samplePinduoduoModule(), deps),
    ).rejects.toThrow("chart insert failed");

    expect(deps.datasets).toHaveLength(0);
    expect(deps.charts).toHaveLength(0);
    expect(deps.settings).toHaveLength(0);
  });
});
