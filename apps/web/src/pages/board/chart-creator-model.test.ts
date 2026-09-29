import { describe, expect, test } from "vitest";
import type { ModuleChartPrefill } from "./module-groups";
import {
  buildChartCreatePayload,
  createChartCreatorInitialState,
} from "./chart-creator-model";

const prefill: ModuleChartPrefill = {
  moduleCode: "pinduoduo_sales",
  moduleName: "拼多多销售",
  suggestionLabel: "佣金趋势",
  datasetName: "拼多多销售 · 佣金趋势",
  chartName: "拼多多销售 · 佣金趋势",
  chartType: "line",
  queryText: JSON.stringify({ modelId: "pinduoduo_sales.analysis" }),
  modelId: "pinduoduo_sales.analysis",
  modelVersion: 1,
  metricIds: ["pinduoduo_sales.commission"],
  dimensionIds: ["pinduoduo_sales.date"],
  xField: "d0__pinduoduo_sales__date",
  yFields: ["m0__pinduoduo_sales__commission"],
};

describe("chart creator model", () => {
  test("starts each ordinary or prefilled reopening from its own clean values", () => {
    const suggested = createChartCreatorInitialState(prefill);
    const ordinary = createChartCreatorInitialState();

    expect(suggested).toMatchObject({
      datasetName: "拼多多销售 · 佣金趋势",
      chartType: "line",
      modelId: "pinduoduo_sales.analysis",
      metricIds: ["pinduoduo_sales.commission"],
      dimensionIds: ["pinduoduo_sales.date"],
    });
    expect(ordinary).toMatchObject({
      datasetName: "数据集 1",
      chartName: "图表 1",
      chartType: "bar",
      xField: "",
      yFields: [],
      modelId: "",
      metricIds: [],
      dimensionIds: [],
    });
  });

  test("submits moduleCode only for a module-suggestion chart", () => {
    const state = createChartCreatorInitialState(prefill);

    expect(buildChartCreatePayload(9, state, prefill)).toMatchObject({
      datasetId: 9,
      moduleCode: "pinduoduo_sales",
      chartType: "line",
      config: expect.objectContaining({
        aggregationMode: "none",
        semanticModelId: "pinduoduo_sales.analysis",
        semanticModelVersion: 1,
      }),
    });
    expect(
      buildChartCreatePayload(10, createChartCreatorInitialState()),
    ).not.toHaveProperty("moduleCode");
  });
});
