import { describe, expect, test } from "vitest";
import {
  DEFAULT_ORDER_CHARTS_SETTING,
  ensureDefaultOrderCharts,
  type DefaultOrderChartRepository,
} from "../src/services/default-order-charts.js";

class MemoryChartRepository implements DefaultOrderChartRepository {
  settings = new Map<string, string>();
  unifiedRows = 0;
  charts: Array<{ datasetId: number; name: string; chartType: string; config: unknown; moduleCode: string }> = [];
  datasets: Array<{ id: number; name: string; queryType: string; queryText: string }> = [];

  async transaction<T>(work: (repo: DefaultOrderChartRepository) => Promise<T>): Promise<T> {
    return work(this);
  }
  async lock(): Promise<void> {}
  async getSetting(key: string): Promise<string | null> {
    return this.settings.get(key) ?? null;
  }
  async setSetting(key: string, value: string): Promise<void> {
    this.settings.set(key, value);
  }
  async countUnifiedRows(): Promise<number> {
    return this.unifiedRows;
  }
  async countCharts(): Promise<number> {
    return this.charts.length;
  }
  async insertDataset(input: { name: string; queryType: string; queryText: string }): Promise<number> {
    const id = this.datasets.length + 1;
    this.datasets.push({ id, ...input });
    return id;
  }
  async insertChart(input: {
    datasetId: number;
    name: string;
    chartType: string;
    config: unknown;
    moduleCode: string;
  }): Promise<void> {
    this.charts.push(input);
  }
}

describe("ensureDefaultOrderCharts", () => {
  test("does not mark an empty unified table as seeded", async () => {
    const repo = new MemoryChartRepository();
    const result = await ensureDefaultOrderCharts(repo);

    expect(result).toEqual({ status: "no_data", created: 0 });
    expect(repo.settings.has(DEFAULT_ORDER_CHARTS_SETTING)).toBe(false);
  });

  test("respects existing charts and records the one-time marker", async () => {
    const repo = new MemoryChartRepository();
    repo.unifiedRows = 42;
    repo.charts.push({
      datasetId: 9,
      name: "用户图表",
      chartType: "bar",
      config: {},
      moduleCode: "orders",
    });

    const result = await ensureDefaultOrderCharts(repo);

    expect(result).toEqual({ status: "existing_charts", created: 0 });
    expect(repo.settings.get(DEFAULT_ORDER_CHARTS_SETTING)).toBe("true");
    expect(repo.datasets).toHaveLength(0);
  });

  test("creates the platform pie and brand TOP10 bar once", async () => {
    const repo = new MemoryChartRepository();
    repo.unifiedRows = 42_306;

    const first = await ensureDefaultOrderCharts(repo);
    expect(first).toEqual({ status: "created", created: 2 });
    expect(repo.datasets.map((item) => item.name)).toEqual([
      "各平台销售额占比",
      "品牌销售额 TOP10",
    ]);
    expect(repo.datasets.map((item) => item.queryType)).toEqual(["semantic", "semantic"]);
    expect(JSON.parse(repo.datasets[0].queryText)).toMatchObject({
      modelId: "orders.analysis",
      metricIds: ["orders.sales_amount"],
      dimensionIds: ["orders.platform"],
    });
    expect(JSON.parse(repo.datasets[1].queryText)).toMatchObject({
      modelId: "orders.analysis",
      metricIds: ["orders.sales_amount"],
      dimensionIds: ["orders.brand"],
    });
    expect(repo.charts.map((item) => [item.name, item.chartType, item.moduleCode])).toEqual([
      ["各平台销售额占比", "pie", "orders"],
      ["品牌销售额 TOP10", "bar", "orders"],
    ]);

    repo.charts = [];
    const second = await ensureDefaultOrderCharts(repo);
    expect(second).toEqual({ status: "already_seeded", created: 0 });
    expect(repo.datasets).toHaveLength(2);
  });
});
