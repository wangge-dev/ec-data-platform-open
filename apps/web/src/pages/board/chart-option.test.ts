import { describe, expect, it } from "vitest";
import { buildOption, formatChartCategoryValue } from "./chart-option";

describe("board chart option", () => {
  it("uses business labels and crisp, collision-aware axis text", () => {
    const option: any = buildOption(
      {
        chartType: "bar",
        title: "店铺推广费",
        xField: "shop",
        yFields: ["field_20"],
        fieldLabels: { field_20: "推广费" },
      },
      [
        {
          shop: "妇炎洁医疗器械京东自营专区",
          field_20: 18033.320000000003,
        },
      ],
    );

    expect(option.series[0].name).toBe("推广费");
    expect(option.xAxis.axisLabel).toMatchObject({
      fontSize: 12,
      fontWeight: 500,
      hideOverlap: true,
      overflow: "truncate",
    });
    expect(option.textStyle.fontFamily).toContain("PingFang SC");
    expect(option.tooltip.valueFormatter(2330.4500000000003)).toBe(
      "2,330.45",
    );
  });

  it("escapes untrusted pie labels before rendering HTML tooltips", () => {
    const option: any = buildOption(
      {
        chartType: "pie",
        title: "Sales share",
        xField: "shop",
        yFields: ["gmv"],
      },
      [{ shop: '<img src=x onerror="alert(1)">&\'shop', gmv: 10 }],
    );
    const html = option.tooltip.formatter({
      name: '<img src=x onerror="alert(1)">&\'shop',
      value: 10,
      percent: 100,
    });

    expect(html).toContain(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#039;shop",
    );
    expect(html).not.toContain("<img");
  });

  it("shows PostgreSQL date values as calendar dates on category axes", () => {
    expect(formatChartCategoryValue("2026-07-03T00:00:00.000Z")).toBe("2026-07-03");
    expect(formatChartCategoryValue("2026-07-03T08:30:00.000Z")).toBe(
      "2026-07-03T08:30:00.000Z",
    );

    const option: any = buildOption(
      {
        chartType: "line",
        title: "销售额趋势",
        xField: "date",
        yFields: ["amount"],
      },
      [{ date: "2026-07-03T00:00:00.000Z", amount: 100 }],
    );

    expect(option.xAxis.data).toEqual(["2026-07-03"]);
  });

  it("lets dashboard cards hide the internal title to avoid duplicate text", () => {
    const option: any = buildOption(
      {
        chartType: "line",
        title: "销售额趋势",
        xField: "date",
        yFields: ["amount"],
        showTitle: false,
      },
      [{ date: "2026-07-03", amount: 100 }],
    );

    expect(option.title).toBeUndefined();
    expect(option.grid.top).toBe(16);
  });

  it("builds horizontal ranking and stacked composition axes", () => {
    const rows = [
      { brand: "品牌甲", online: 12, offline: 8 },
      { brand: "品牌乙", online: 9, offline: 5 },
    ];
    const horizontal: any = buildOption(
      {
        chartType: "horizontal_bar",
        title: "品牌排行",
        xField: "brand",
        yFields: ["online"],
      },
      rows,
    );
    const stacked: any = buildOption(
      {
        chartType: "stacked_bar",
        title: "渠道构成",
        xField: "brand",
        yFields: ["online", "offline"],
      },
      rows,
    );

    expect(horizontal.xAxis.type).toBe("value");
    expect(horizontal.yAxis).toMatchObject({ type: "category", inverse: true });
    expect(stacked.series.map((series: any) => series.stack)).toEqual(["总计", "总计"]);
    expect(Array.isArray(stacked.yAxis)).toBe(false);
  });

  it("renders a KPI as one summed business value", () => {
    const option: any = buildOption(
      {
        chartType: "kpi",
        title: "累计销售额",
        yFields: ["gmv"],
        fieldLabels: { gmv: "销售额" },
      },
      [{ gmv: 12000 }, { gmv: 8000 }],
    );

    expect(option.graphic[0].children[0].style.text).toBe("2.00 万");
    expect(option.graphic[0].children[1].style.text).toBe("销售额");
  });

  it("re-aggregates duplicated categories after dashboard slicing", () => {
    const option: any = buildOption(
      {
        chartType: "stacked_bar",
        title: "品类平台构成",
        xField: "category",
        seriesField: "platform",
        yFields: ["gmv"],
      },
      [
        { category: "个护", platform: "天猫", region: "华东", gmv: 10 },
        { category: "个护", platform: "天猫", region: "华南", gmv: 15 },
        { category: "个护", platform: "京东", region: "华东", gmv: 8 },
      ],
    );

    expect(option.xAxis.data).toEqual(["个护"]);
    expect(option.series.map((series: any) => [series.name, series.data[0]])).toEqual([
      ["天猫", 25],
      ["京东", 8],
    ]);
  });

  it("builds treemap, heatmap and gauge options from shared fact rows", () => {
    const rows = [
      { category: "个护", brand: "甲", hour: "09-12", weekday: "周一", gmv: 60, actual: 60, target: 100 },
      { category: "个护", brand: "乙", hour: "09-12", weekday: "周一", gmv: 40, actual: 40, target: 100 },
    ];
    const treemap: any = buildOption({
      chartType: "treemap",
      title: "利润版图",
      xField: "category",
      seriesField: "brand",
      yFields: ["gmv"],
    }, rows);
    const heatmap: any = buildOption({
      chartType: "heatmap",
      title: "订单热力",
      xField: "hour",
      seriesField: "weekday",
      yFields: ["gmv"],
    }, rows);
    const gauge: any = buildOption({
      chartType: "gauge",
      title: "目标达成",
      yFields: ["actual", "target"],
    }, rows);

    expect(treemap.series[0].data[0]).toMatchObject({ name: "个护", value: 100 });
    expect(treemap.series[0].data[0].children).toHaveLength(2);
    expect(heatmap.series[0].data).toEqual([[0, 0, 100]]);
    expect(gauge.series[0].data[0]).toEqual({ value: 50, name: "目标达成" });
  });

  it("shows a KPI benchmark comparison", () => {
    const option: any = buildOption({
      chartType: "kpi",
      title: "成交总额",
      yFields: ["gmv"],
      benchmarkField: "target",
      comparisonLabel: "目标达成",
      valuePrefix: "¥",
    }, [{ gmv: 120, target: 100 }]);

    expect(option.graphic[0].children[0].style.text).toBe("¥120");
    expect(option.graphic[0].children[2].style.text).toBe("目标达成 120.0%");
  });
});
