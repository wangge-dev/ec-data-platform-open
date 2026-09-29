import { describe, expect, it } from "vitest";
import {
  chartRenderErrorMessage,
  chartRenderQueryKey,
  requireCompleteChartRenderData,
} from "./chart-render-state";

describe("chart render error message", () => {
  it("explains a legacy table permission failure without exposing SQL names", () => {
    const message = chartRenderErrorMessage({
      message: "permission denied for table unified_pinduoduo_sales",
    });

    expect(message).toContain("读取权限迁移");
    expect(message).not.toContain("unified_pinduoduo_sales");
  });

  it("gives a useful fallback for unknown failures", () => {
    expect(chartRenderErrorMessage(new Error("network failed"))).toContain("重新加载");
  });

  it("explains that incomplete rows cannot be aggregated as a complete chart", () => {
    const message = chartRenderErrorMessage({
      code: "CHART_DATA_INCOMPLETE",
      message: "chart dataset exceeds the row limit",
    });

    expect(message).toContain("数据不完整");
    expect(message).toContain("不会展示");
  });

  it.each([
    { rows: Array.from({ length: 4999 }, (_, id) => ({ id })), complete: true, truncated: false },
    { rows: Array.from({ length: 5000 }, (_, id) => ({ id })), complete: true, truncated: false },
  ])("accepts a proven complete $rows.length-row response", (payload) => {
    expect(requireCompleteChartRenderData({ ...payload, rowLimit: 5000 }).rows).toHaveLength(
      payload.rows.length,
    );
  });

  it("rejects a greater-than-5000 response before browser aggregation", () => {
    expect(() => requireCompleteChartRenderData({
      rows: Array.from({ length: 5000 }, (_, id) => ({ id })),
      complete: false,
      truncated: true,
      rowLimit: 5000,
    })).toThrow("CHART_DATA_INCOMPLETE");
  });

  it("accepts a complete server-aggregated response", () => {
    const result = requireCompleteChartRenderData({
      rows: [{ platform: "天猫", category: "家居", gmv: 123 }],
      complete: true,
      truncated: false,
      rowLimit: 5000,
      aggregation: {
        mode: "server",
        groupFields: ["platform", "category"],
        sumFields: ["gmv"],
        sourceRowLimit: 5000,
      },
    });
    expect(result.aggregation?.mode).toBe("server");
  });

  it("uses the chart id in cache keys because server aggregation depends on chart config", () => {
    expect(chartRenderQueryKey({
      chartId: 7,
      datasetId: 9,
      dateField: "event_date",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-20",
    })).not.toEqual(chartRenderQueryKey({
      chartId: 8,
      datasetId: 9,
      dateField: "event_date",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-20",
    }));
  });

  it("rejects legacy responses that cannot prove completeness", () => {
    expect(() => requireCompleteChartRenderData({ rows: [{ id: 1 }] })).toThrow(
      "CHART_DATA_INCOMPLETE",
    );
  });
});
