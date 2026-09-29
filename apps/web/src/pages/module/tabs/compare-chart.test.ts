import { describe, expect, it } from "vitest";
import { buildCompareChartOption } from "./compare-chart";

describe("compare chart option", () => {
  const rows = [
    {
      dim: "妇炎洁医疗器械京东自营专区",
      current: 18033.320000000003,
      previous: 21450.51,
      delta: -3417.19,
      rate: -15.93,
    },
  ];

  it("uses readable axis and legend typography", () => {
    const option: any = buildCompareChartOption(rows);
    expect(option.textStyle.fontFamily).toContain("Microsoft YaHei");
    expect(option.xAxis.axisLabel).toMatchObject({
      fontSize: 12,
      fontWeight: 500,
      hideOverlap: true,
      overflow: "truncate",
    });
    expect(option.legend.textStyle.fontSize).toBe(12);
    expect(option.grid.containLabel).toBe(true);
  });

  it("renders tooltip values to two decimals without floating tails", () => {
    const option: any = buildCompareChartOption(rows);
    const html = option.tooltip.formatter([
      {
        axisValue: "妇炎洁医疗器械京东自营专区",
        seriesName: "本期",
        value: 18033.320000000003,
      },
      {
        axisValue: "妇炎洁医疗器械京东自营专区",
        seriesName: "上期",
        value: 21450.51,
      },
    ]);
    expect(html).toContain("本期：18,033.32");
    expect(html).toContain("上期：21,450.51");
    expect(html).not.toContain("0000000003");
  });

  it("escapes the dimension label in HTML tooltips", () => {
    const option: any = buildCompareChartOption(rows);
    const html = option.tooltip.formatter([
      {
        axisValue: '<svg onload="alert(1)">&\'shop',
        seriesName: "本期",
        value: 1,
      },
      {
        axisValue: '<svg onload="alert(1)">&\'shop',
        seriesName: "上期",
        value: 1,
      },
    ]);

    expect(html).toContain(
      "&lt;svg onload=&quot;alert(1)&quot;&gt;&amp;&#039;shop",
    );
    expect(html).not.toContain("<svg");
  });
});
