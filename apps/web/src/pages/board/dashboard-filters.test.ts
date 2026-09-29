import { describe, expect, it } from "vitest";
import type { BoardChart } from "./module-groups";
import {
  applyDashboardFilters,
  buildDashboardSlicers,
  chartFilterMetadata,
  filterFromChartClick,
  upsertDashboardFilter,
} from "./dashboard-filters";

function chart(id: number, xField: string, seriesField?: string): BoardChart {
  return {
    id,
    datasetId: id,
    name: `图表 ${id}`,
    chartType: "bar",
    config: { xField, yFields: ["amount"], seriesField },
    moduleCode: "orders",
    createdAt: "2026-08-20T00:00:00.000Z",
  };
}

describe("dashboard linked filters", () => {
  it("uses explicit shared filter fields even when they are not chart axes", () => {
    const first = chart(10, "event_date");
    first.config.filterFields = ["platform", "region"];
    const second = chart(11, "brand");
    second.config.filterFields = ["platform", "region"];
    const rows = [
      { event_date: "2026-08-20", platform: "天猫", region: "华东", amount: 10 },
      { event_date: "2026-08-20", platform: "京东", region: "华南", amount: 20 },
    ];
    const slicers = buildDashboardSlicers([
      chartFilterMetadata(first, rows, { platform: "平台", region: "区域" }),
      chartFilterMetadata(second, rows, { platform: "平台", region: "区域" }),
    ], "orders");

    expect(slicers.map((slicer) => [slicer.field, slicer.label, slicer.order])).toEqual([
      ["platform", "平台", 0],
      ["region", "区域", 1],
    ]);
  });

  it("turns treemap parent and leaf clicks into the correct hierarchy filter", () => {
    const treemap = {
      ...chart(12, "category", "brand"),
      chartType: "treemap" as const,
    };

    expect(filterFromChartClick(treemap, {
      treePathInfo: [{ name: "" }, { name: "个护" }],
    }, { category: "品类", brand: "品牌" })).toMatchObject({
      field: "category",
      value: "个护",
    });
    expect(filterFromChartClick(treemap, {
      treePathInfo: [{ name: "" }, { name: "个护" }, { name: "示例·澄野" }],
    }, { category: "品类", brand: "品牌" })).toMatchObject({
      field: "brand",
      value: "示例·澄野",
    });
  });

  it("offers a slicer only when at least two charts share a categorical field", () => {
    const metadata = [
      chartFilterMetadata(chart(1, "platform"), [
        { platform: "淘宝", amount: 1 },
        { platform: "京东", amount: 2 },
      ], { platform: "平台" }),
      chartFilterMetadata(chart(2, "date", "platform"), [
        { date: "2026-08-01", platform: "淘宝", amount: 1 },
        { date: "2026-08-01", platform: "京东", amount: 2 },
      ], { platform: "平台" }),
      chartFilterMetadata(chart(3, "brand"), [
        { brand: "A", amount: 1 },
        { brand: "B", amount: 2 },
      ], { brand: "品牌" }),
    ];

    expect(buildDashboardSlicers(metadata, "orders")).toEqual([
      expect.objectContaining({
        field: "platform",
        label: "平台",
        values: ["京东", "淘宝"],
        chartCount: 2,
      }),
    ]);
  });

  it("keeps child-module slicers visible when a category entry is selected", () => {
    const metadata = [
      chartFilterMetadata(chart(1, "platform"), [
        { platform: "淘宝", amount: 1 },
        { platform: "京东", amount: 2 },
      ]),
      chartFilterMetadata(chart(2, "platform"), [
        { platform: "淘宝", amount: 1 },
        { platform: "京东", amount: 2 },
      ]),
      {
        ...chartFilterMetadata(chart(3, "platform"), [
          { platform: "淘宝", amount: 1 },
          { platform: "京东", amount: 2 },
        ]),
        moduleCode: "outside",
      },
    ];

    expect(
      buildDashboardSlicers(metadata, "category:shop_ops", 10, ["orders"])
        .map((slicer) => slicer.moduleCode),
    ).toEqual(["orders"]);
  });

  it("filters charts containing the linked field and leaves unrelated charts intact", () => {
    const filter = {
      moduleCode: "orders",
      field: "platform",
      fieldLabel: "平台",
      value: "淘宝",
    };
    expect(applyDashboardFilters([
      { platform: "淘宝", amount: 1 },
      { platform: "京东", amount: 2 },
    ], "orders", [filter])).toEqual([{ platform: "淘宝", amount: 1 }]);
    expect(applyDashboardFilters([{ brand: "A", amount: 1 }], "orders", [filter]))
      .toEqual([{ brand: "A", amount: 1 }]);
  });

  it("uses the series dimension for a multi-series click and replaces its active value", () => {
    const clicked = filterFromChartClick(
      chart(1, "date", "platform"),
      { name: "2026-08-01", seriesName: "淘宝" },
      { platform: "平台" },
    );
    expect(clicked).toEqual({
      moduleCode: "orders",
      field: "platform",
      fieldLabel: "平台",
      value: "淘宝",
    });
    expect(upsertDashboardFilter([
      { ...clicked!, value: "京东" },
    ], clicked!)).toEqual([clicked]);
  });
});
