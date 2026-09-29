import { describe, expect, test } from "vitest";
import {
  DEMO_COCKPIT_CHARTS,
  DEMO_FILTER_FIELDS,
  DEMO_MODULE_CODE,
  DEMO_PERIOD,
  buildDemoCockpitFactQuery,
  buildSyntheticCockpitRows,
} from "../src/services/demo-cockpit";

describe("synthetic demo cockpit", () => {
  test("generates a deterministic multidimensional fact set", () => {
    const first = buildSyntheticCockpitRows();
    const second = buildSyntheticCockpitRows();

    expect(first).toHaveLength(4_480);
    expect(first[0].日期).toBe(DEMO_PERIOD.from);
    expect(first.at(-1)?.日期).toBe(DEMO_PERIOD.to);
    expect(first[137]).toEqual(second[137]);
    expect(new Set(first.map((row) => row.记录编号)).size).toBe(first.length);
    expect(new Set(first.map((row) => row.平台)).size).toBe(4);
    expect(new Set(first.map((row) => row.区域)).size).toBe(6);
    expect(new Set(first.map((row) => row.品类)).size).toBe(5);
    expect(new Set(first.map((row) => row.品牌)).size).toBe(4);
  });

  test("keeps conversion and profit values internally plausible", () => {
    const rows = buildSyntheticCockpitRows(7);

    expect(rows.every((row) => row.商品浏览量 <= row.访客数)).toBe(true);
    expect(rows.every((row) => row.加购人数 <= row.商品浏览量)).toBe(true);
    expect(rows.every((row) => row.支付订单数 <= row.加购人数)).toBe(true);
    expect(rows.every((row) => row.毛利润 > 0 && row.成交金额 > row.毛利润)).toBe(true);
  });

  test("builds one safe shared fact query and a rich linked chart suite", () => {
    const query = buildDemoCockpitFactQuery("uf_123");

    expect(query).toContain('FROM "user_data"."uf_123"');
    expect(query).toContain('"日期"::date AS event_date');
    expect(() => buildDemoCockpitFactQuery('uf_1"; DROP TABLE charts')).toThrow("非法演示数据表名");
    expect(DEMO_COCKPIT_CHARTS).toHaveLength(13);
    const chartTypes = new Set(DEMO_COCKPIT_CHARTS.map((chart) => chart.chartType));
    for (const chartType of ["kpi", "combo", "gauge", "stacked_bar", "treemap", "heatmap", "funnel", "scatter", "horizontal_bar", "table"]) {
      expect(chartTypes.has(chartType as any)).toBe(true);
    }
    expect(DEMO_COCKPIT_CHARTS.every((chart) =>
      chart.config.moduleName && chart.config.dateField === "event_date"
      && JSON.stringify(chart.config.filterFields) === JSON.stringify(DEMO_FILTER_FIELDS),
    )).toBe(true);
    expect(DEMO_MODULE_CODE).toBe("cockpit_demo");
  });
});
