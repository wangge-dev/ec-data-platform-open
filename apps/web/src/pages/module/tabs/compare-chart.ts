import {
  CHART_AXIS_LABEL_STYLE,
  CHART_LEGEND_TEXT_STYLE,
  CHART_TOOLTIP_STYLE,
  escapeHtml,
  formatBusinessNumber,
  withChartDefaults,
} from "@/components/charts/chart-visuals";

export type CompareChartRow = {
  dim: string;
  current: number;
  previous: number;
  delta: number;
  rate: number | null;
};

export function buildCompareChartOption(rows: CompareChartRow[]) {
  const top = rows.slice(0, 15);
  const dimLabels = top.map((row) => row.dim || "(空)");

  return withChartDefaults({
    tooltip: {
      ...CHART_TOOLTIP_STYLE,
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: any[]) => {
        const dim = escapeHtml(params[0]?.axisValue);
        const current = Number(
          params.find((item) => item.seriesName === "本期")?.value ?? 0,
        );
        const previous = Number(
          params.find((item) => item.seriesName === "上期")?.value ?? 0,
        );
        const delta = current - previous;
        const rate =
          previous === 0
            ? "—"
            : `${((delta / previous) * 100).toFixed(2)}%`;
        const arrow = delta >= 0 ? "↑" : "↓";
        return (
          `${dim}<br/>` +
          `本期：${formatBusinessNumber(current, { fixed: true })}<br/>` +
          `上期：${formatBusinessNumber(previous, { fixed: true })}<br/>` +
          `${arrow} 差额：${formatBusinessNumber(delta, { fixed: true })}（${rate}）`
        );
      },
    },
    legend: {
      data: ["本期", "上期"],
      top: 0,
      textStyle: CHART_LEGEND_TEXT_STYLE,
    },
    grid: {
      left: 16,
      right: 20,
      top: 38,
      bottom: 12,
      containLabel: true,
    },
    xAxis: {
      type: "category",
      data: dimLabels,
      axisLine: { lineStyle: { color: "#E2DDD4" } },
      axisTick: { alignWithLabel: true },
      axisLabel: {
        ...CHART_AXIS_LABEL_STYLE,
        interval: "auto",
        rotate: top.length > 8 ? 28 : 0,
        width: top.length > 8 ? 108 : undefined,
        overflow: "truncate",
      },
    },
    yAxis: {
      type: "value",
      axisLabel: {
        ...CHART_AXIS_LABEL_STYLE,
        formatter: (value: number) =>
          formatBusinessNumber(value, { compact: true }),
      },
      splitLine: { lineStyle: { color: "#F0ECE4", type: "dashed" } },
    },
    series: [
      {
        name: "本期",
        type: "bar",
        data: top.map((row) => Number(row.current) || 0),
        itemStyle: { color: "#9d8b7b", borderRadius: [3, 3, 0, 0] },
        barGap: "20%",
        barMaxWidth: 34,
      },
      {
        name: "上期",
        type: "bar",
        data: top.map((row) => Number(row.previous) || 0),
        itemStyle: { color: "#c9bfb3", borderRadius: [3, 3, 0, 0] },
        barMaxWidth: 34,
      },
    ],
  });
}
