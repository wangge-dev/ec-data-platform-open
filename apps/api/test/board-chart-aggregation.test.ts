import { describe, expect, test } from "vitest";

import { buildChartServerAggregationSql } from "../src/services/board-chart-aggregation.js";

describe("board chart server aggregation", () => {
  test("preserves shared slicers and chart dimensions while summing metrics", () => {
    const result = buildChartServerAggregationSql({
      sqlText: "SELECT platform, region, category, gmv, target FROM user_data.uf_1",
      chartType: "stacked_bar",
      config: {
        aggregationMode: "sum",
        filterFields: ["platform", "region"],
        xField: "category",
        seriesField: "platform",
        yFields: ["gmv"],
        benchmarkField: "target",
      },
    });

    expect(result).not.toBeNull();
    expect(result?.groupFields).toEqual(["platform", "region", "category"]);
    expect(result?.sumFields).toEqual(["gmv", "target"]);
    expect(result?.queryText).toContain('sub."platform" AS "platform"');
    expect(result?.queryText).toContain('SUM(COALESCE((sub."gmv")::numeric, 0)) AS "gmv"');
    expect(result?.queryText).toContain('GROUP BY sub."platform", sub."region", sub."category"');
    expect(result?.queryText).toContain('ORDER BY "platform", "region", "category"');
  });

  test("keeps detail tables and non-weighted average KPIs out of server aggregation", () => {
    expect(buildChartServerAggregationSql({
      sqlText: "SELECT * FROM user_data.uf_1",
      chartType: "table",
      config: { aggregationMode: "sum", xField: "category", yFields: ["gmv"] },
    })).toBeNull();
    expect(buildChartServerAggregationSql({
      sqlText: "SELECT * FROM user_data.uf_1",
      chartType: "kpi",
      config: { aggregationMode: "sum", yFields: ["rating"], valueMode: "average" },
    })).toBeNull();
    expect(buildChartServerAggregationSql({
      sqlText: "SELECT * FROM user_data.uf_1",
      chartType: "unknown_chart_type",
      config: { aggregationMode: "sum", xField: "category", yFields: ["gmv"] },
    })).toBeNull();
    expect(buildChartServerAggregationSql({
      sqlText: "SELECT * FROM user_data.uf_1",
      chartType: "radar",
      config: { aggregationMode: "sum", xField: "brand", yFields: ["gmv", "profit"] },
    })).toBeNull();
  });

  test("requires an explicit additive metric contract", () => {
    expect(buildChartServerAggregationSql({
      sqlText: "SELECT category, conversion_rate FROM user_data.uf_1",
      chartType: "line",
      config: { xField: "category", yFields: ["conversion_rate"] },
    })).toBeNull();
    expect(buildChartServerAggregationSql({
      sqlText: "SELECT category, conversion_rate FROM user_data.uf_1",
      chartType: "line",
      config: {
        aggregationMode: "none",
        xField: "category",
        yFields: ["conversion_rate"],
      },
    })).toBeNull();
  });

  test("only aggregates scatter plots that have a stable point key", () => {
    expect(buildChartServerAggregationSql({
      sqlText: "SELECT * FROM user_data.uf_1",
      chartType: "scatter",
      config: { aggregationMode: "sum", xField: "ad_spend", yFields: ["profit"], seriesField: "platform" },
    })).toBeNull();

    const result = buildChartServerAggregationSql({
      sqlText: "SELECT * FROM user_data.uf_1",
      chartType: "scatter",
      config: {
        aggregationMode: "sum",
        filterFields: ["region"],
        xField: "ad_spend",
        yFields: ["profit"],
        seriesField: "platform",
        pointField: "brand",
        sizeField: "gmv",
      },
    });
    expect(result?.groupFields).toEqual(["region", "platform", "brand"]);
    expect(result?.sumFields).toEqual(["ad_spend", "profit", "gmv"]);
  });

  test("rejects unsafe or overlapping field contracts instead of interpolating them", () => {
    expect(buildChartServerAggregationSql({
      sqlText: "SELECT * FROM user_data.uf_1",
      chartType: "bar",
      config: { aggregationMode: "sum", xField: "category; DROP TABLE x", yFields: ["gmv"] },
    })).toBeNull();
    expect(buildChartServerAggregationSql({
      sqlText: "SELECT * FROM user_data.uf_1",
      chartType: "bar",
      config: { aggregationMode: "sum", filterFields: ["gmv"], xField: "category", yFields: ["gmv"] },
    })).toBeNull();
  });
});
