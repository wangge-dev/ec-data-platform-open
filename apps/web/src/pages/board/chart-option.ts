// ECharts 配置生成：手动建图 / AI 出图预览共用
// 支持趋势、排行、构成、关系、漏斗、指标卡等经营看板图表。
// 多系列：传 seriesField 时把长表 {x, series, y} pivot 成 N 条系列
import {
  CHART_AXIS_LABEL_STYLE,
  CHART_FONT_FAMILY,
  CHART_LEGEND_TEXT_STYLE,
  CHART_TITLE_TEXT_STYLE,
  CHART_TOOLTIP_STYLE,
  displayFieldName,
  escapeHtml,
  formatBusinessNumber,
  withChartDefaults,
} from "@/components/charts/chart-visuals";

export type ChartType =
  | "bar"
  | "horizontal_bar"
  | "stacked_bar"
  | "line"
  | "area"
  | "pie"
  | "radar"
  | "combo"
  | "scatter"
  | "funnel"
  | "treemap"
  | "heatmap"
  | "gauge"
  | "kpi"
  | "table";

export type ChartSpec = {
  chartType: ChartType;
  title: string;
  xField?: string;
  yFields?: string[];
  seriesField?: string;
  fieldLabels?: Record<string, string>;
  showTitle?: boolean;
  benchmarkField?: string;
  comparisonLabel?: string;
  valueMode?: "sum" | "average" | "ratio";
  targetValue?: number;
  valuePrefix?: string;
  valueSuffix?: string;
  valueDecimals?: number;
  valueLabel?: string;
  pointField?: string;
  sizeField?: string;
};

// 莫兰迪低饱和配色（参考 Tableau 的成套色板，区分度更高）
const PALETTE = [
  "#7E9CA8",
  "#C98D7A",
  "#9CA87E",
  "#C2A878",
  "#8B7E9C",
  "#A8857E",
  "#6E8B9C",
  "#B5A07A",
  "#8FA88F",
  "#C89CB0",
];

const AXIS_LINE = { lineStyle: { color: "#E2DDD4" } };
const SPLIT_LINE = { lineStyle: { color: "#F0ECE4", type: "dashed" as const } };

const SERIALIZED_DATE_RE = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z$/;

// PostgreSQL date values can become midnight UTC timestamps after JSON serialization.
export function formatChartCategoryValue(value: unknown): string {
  const text = String(value ?? "");
  return text.match(SERIALIZED_DATE_RE)?.[1] ?? text;
}

// 千分位 + 紧凑（1.2万 / 3.4亿）
function fmtNum(v: number): string {
  return formatBusinessNumber(v, { compact: true });
}

function numericValues(rows: any[], field: string): number[] {
  return rows
    .map((row) => Number(row[field]))
    .filter((value) => Number.isFinite(value));
}

function sumField(rows: any[], field: string): number {
  return numericValues(rows, field).reduce((total, value) => total + value, 0);
}

function aggregateCategoryRows(
  rows: any[],
  xField: string,
  yFields: string[],
  seriesField = "",
): any[] {
  const aggregated = new Map<string, any>();
  for (const row of rows) {
    const xValue = formatChartCategoryValue(row[xField]);
    const seriesValue = seriesField ? String(row[seriesField] ?? "未分类") : "";
    const key = `${xValue}\u0000${seriesValue}`;
    const current = aggregated.get(key) ?? {
      [xField]: xValue,
      ...(seriesField ? { [seriesField]: seriesValue } : {}),
    };
    for (const field of yFields) {
      current[field] = (Number(current[field]) || 0) + (Number(row[field]) || 0);
    }
    aggregated.set(key, current);
  }
  return [...aggregated.values()];
}

function orderedDimensionValues(values: string[]): string[] {
  const weekdayOrder = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  if (values.every((value) => weekdayOrder.includes(value))) {
    return [...values].sort((left, right) => weekdayOrder.indexOf(left) - weekdayOrder.indexOf(right));
  }
  if (values.every((value) => /^\d{2}-\d{2}$/.test(value))) {
    return [...values].sort((left, right) => left.localeCompare(right));
  }
  return values;
}

function formatKpiValue(
  value: number,
  prefix: string,
  suffix: string,
  decimals?: number,
): string {
  const formatted = decimals == null ? fmtNum(value) : value.toFixed(decimals);
  return `${prefix}${formatted}${suffix}`;
}

function baseTitle(title: string) {
  return {
    text: title,
    left: "left" as const,
    textStyle: CHART_TITLE_TEXT_STYLE,
  };
}

export function buildOption(spec: ChartSpec, rows: any[]) {
  const {
    chartType,
    title,
    xField = "",
    yFields = [],
    seriesField = "",
    fieldLabels = {},
    showTitle = true,
    benchmarkField = "",
    comparisonLabel = "目标达成",
    valueMode = "sum",
    targetValue,
    valuePrefix = "",
    valueSuffix = "",
    valueDecimals,
    valueLabel = "",
    pointField = "",
    sizeField = "",
  } = spec;
  if (chartType === "table" || !rows?.length) return null;
  const fieldLabel = (name: string) =>
    displayFieldName(
      name,
      Object.entries(fieldLabels).map(([fieldName, label]) => ({
        name: fieldName,
        label,
      })),
      name,
    );

  if (chartType === "kpi") {
    const valueField = yFields[0] || "value";
    const values = numericValues(rows, valueField);
    const value = valueMode === "ratio"
      ? sumField(rows, valueField) / Math.max(sumField(rows, yFields[1] || ""), Number.EPSILON)
      : valueMode === "average"
        ? values.reduce((total, current) => total + current, 0) / Math.max(values.length, 1)
        : values.reduce((total, current) => total + current, 0);
    const benchmark = benchmarkField
      ? sumField(rows, benchmarkField)
      : typeof targetValue === "number" && Number.isFinite(targetValue)
        ? Number(targetValue)
        : null;
    const attainment = benchmark && benchmark > 0 ? value / benchmark : null;
    const comparisonText = attainment == null
      ? ""
      : comparisonLabel === "目标达成"
        ? `${comparisonLabel} ${(attainment * 100).toFixed(1)}%`
        : `${comparisonLabel} ${attainment >= 1 ? "+" : ""}${((attainment - 1) * 100).toFixed(1)}%`;
    return withChartDefaults({
      title: showTitle ? baseTitle(title) : undefined,
      tooltip: { ...CHART_TOOLTIP_STYLE, show: false },
      graphic: [
        {
          type: "group",
          left: "center",
          top: "middle",
          children: [
            {
              type: "text",
              left: "center",
              top: -26,
              style: {
                text: formatKpiValue(value, valuePrefix, valueSuffix, valueDecimals),
                fill: "#2C2825",
                fontFamily: CHART_FONT_FAMILY,
                fontSize: 31,
                fontWeight: 600,
                textAlign: "center",
              },
            },
            {
              type: "text",
              left: "center",
              top: 20,
              style: {
                text: valueLabel || fieldLabel(valueField),
                fill: "#6B655F",
                fontFamily: CHART_FONT_FAMILY,
                fontSize: 13,
                textAlign: "center",
              },
            },
            ...(comparisonText
              ? [{
                  type: "text",
                  left: "center",
                  top: 44,
                  style: {
                    text: comparisonText,
                    fill: attainment != null && attainment >= 1 ? "#657A68" : "#A4675A",
                    fontFamily: CHART_FONT_FAMILY,
                    fontSize: 12,
                    fontWeight: 500,
                    textAlign: "center",
                  },
                }]
              : []),
          ],
        },
      ],
      series: [],
    });
  }

  if (chartType === "gauge") {
    const actual = sumField(rows, yFields[0] || "value");
    const target = yFields[1]
      ? sumField(rows, yFields[1])
      : typeof targetValue === "number" && Number.isFinite(targetValue)
        ? Number(targetValue)
        : 100;
    const percent = target > 0 ? actual / target * 100 : 0;
    return withChartDefaults({
      title: showTitle ? baseTitle(title) : undefined,
      tooltip: {
        ...CHART_TOOLTIP_STYLE,
        formatter: `${fieldLabel(yFields[0] || "value")}：{c}%`,
      },
      series: [{
        type: "gauge",
        startAngle: 210,
        endAngle: -30,
        center: ["50%", "58%"],
        radius: "94%",
        min: 0,
        max: Math.max(120, Math.ceil(percent / 20) * 20),
        splitNumber: 6,
        progress: {
          show: true,
          width: 16,
          roundCap: true,
          itemStyle: { color: percent >= 100 ? "#7D9A80" : "#C39A72" },
        },
        axisLine: { lineStyle: { width: 16, color: [[1, "#ECE8E1"]] } },
        pointer: { show: false },
        axisTick: { show: false },
        splitLine: { distance: -24, length: 6, lineStyle: { color: "#B7AFA6", width: 1 } },
        axisLabel: { distance: -44, ...CHART_AXIS_LABEL_STYLE, formatter: (value: number) => `${value}%` },
        anchor: { show: false },
        title: { offsetCenter: [0, "42%"], ...CHART_AXIS_LABEL_STYLE, fontSize: 12 },
        detail: {
          valueAnimation: true,
          offsetCenter: [0, "5%"],
          formatter: (value: number) => `${value.toFixed(1)}%`,
          color: "#2C2825",
          fontFamily: CHART_FONT_FAMILY,
          fontSize: 30,
          fontWeight: 600,
        },
        data: [{ value: Number(percent.toFixed(1)), name: "目标达成" }],
      }],
    });
  }

  if (chartType === "funnel") {
    const valueField = yFields[0] || "value";
    const funnelData = xField
      ? aggregateCategoryRows(rows, xField, [valueField]).map((row) => ({
          name: formatChartCategoryValue(row[xField]),
          value: Number(row[valueField]) || 0,
        }))
      : yFields.map((field) => ({
          name: fieldLabel(field),
          value: sumField(rows, field),
        }));
    return withChartDefaults({
      title: showTitle ? baseTitle(title) : undefined,
      tooltip: {
        ...CHART_TOOLTIP_STYLE,
        trigger: "item",
        formatter: (params: any) =>
          `${escapeHtml(params.name)}<br/>${formatBusinessNumber(params.value, { fixed: true })}`,
      },
      series: [
        {
          type: "funnel",
          top: showTitle ? 44 : 12,
          left: "8%",
          width: "84%",
          bottom: 8,
          minSize: "24%",
          maxSize: "100%",
          sort: "none",
          gap: 2,
          label: {
            show: true,
            position: "inside",
            formatter: (params: any) => `${params.name}  ${fmtNum(params.value)}`,
            color: "#fff",
            fontFamily: CHART_FONT_FAMILY,
            fontSize: 12,
          },
          data: funnelData,
        },
      ],
      color: PALETTE,
    });
  }

  if (chartType === "treemap") {
    const valueField = yFields[0] || "value";
    const aggregated = aggregateCategoryRows(rows, xField, [valueField], seriesField);
    const data = seriesField
      ? [...new Set(aggregated.map((row) => String(row[xField])))].map((groupName) => ({
          name: groupName,
          value: aggregated
            .filter((row) => String(row[xField]) === groupName)
            .reduce((total, row) => total + (Number(row[valueField]) || 0), 0),
          children: aggregated
            .filter((row) => String(row[xField]) === groupName)
            .map((row) => ({
              name: String(row[seriesField]),
              value: Number(row[valueField]) || 0,
            })),
        }))
      : aggregated.map((row) => ({
          name: String(row[xField]),
          value: Number(row[valueField]) || 0,
        }));
    return withChartDefaults({
      title: showTitle ? baseTitle(title) : undefined,
      tooltip: {
        ...CHART_TOOLTIP_STYLE,
        formatter: (params: any) =>
          `${escapeHtml(params.treePathInfo?.map((item: any) => item.name).filter(Boolean).join(" / ") || params.name)}<br/>${fieldLabel(valueField)}：${formatBusinessNumber(params.value, { fixed: true })}`,
      },
      series: [{
        type: "treemap",
        top: showTitle ? 42 : 6,
        left: 4,
        right: 4,
        bottom: 4,
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        label: {
          show: true,
          formatter: "{b}",
          color: "#fff",
          fontFamily: CHART_FONT_FAMILY,
          fontSize: 12,
          overflow: "truncate",
        },
        upperLabel: {
          show: Boolean(seriesField),
          height: 24,
          color: "#fff",
          fontFamily: CHART_FONT_FAMILY,
          fontSize: 12,
          fontWeight: 600,
        },
        itemStyle: { borderColor: "#fff", borderWidth: 2, gapWidth: 2 },
        levels: [
          { itemStyle: { borderWidth: 0, gapWidth: 3 } },
          { colorSaturation: [0.24, 0.48], itemStyle: { gapWidth: 2 } },
        ],
        data,
      }],
      color: PALETTE,
    });
  }

  if (chartType === "heatmap") {
    const valueField = yFields[0] || "value";
    const aggregated = aggregateCategoryRows(rows, xField, [valueField], seriesField);
    const xValues = orderedDimensionValues([...new Set(aggregated.map((row) => String(row[xField])))]);
    const yValues = orderedDimensionValues([...new Set(aggregated.map((row) => String(row[seriesField])))]);
    const data = aggregated.map((row) => [
      xValues.indexOf(String(row[xField])),
      yValues.indexOf(String(row[seriesField])),
      Number(row[valueField]) || 0,
    ]);
    const max = Math.max(...data.map((item) => item[2]), 1);
    return withChartDefaults({
      title: showTitle ? baseTitle(title) : undefined,
      tooltip: {
        ...CHART_TOOLTIP_STYLE,
        position: "top",
        formatter: (params: any) =>
          `${escapeHtml(yValues[params.value?.[1]] ?? "")} · ${escapeHtml(xValues[params.value?.[0]] ?? "")}<br/>${fieldLabel(valueField)}：${formatBusinessNumber(params.value?.[2], { fixed: true })}`,
      },
      grid: { top: showTitle ? 44 : 12, left: 12, right: 16, bottom: 48, containLabel: true },
      xAxis: {
        type: "category",
        data: xValues,
        splitArea: { show: true },
        axisLine: AXIS_LINE,
        axisLabel: CHART_AXIS_LABEL_STYLE,
      },
      yAxis: {
        type: "category",
        data: yValues,
        splitArea: { show: true },
        axisLine: AXIS_LINE,
        axisLabel: CHART_AXIS_LABEL_STYLE,
      },
      visualMap: {
        min: 0,
        max,
        calculable: false,
        orient: "horizontal",
        left: "center",
        bottom: 2,
        textStyle: CHART_LEGEND_TEXT_STYLE,
        inRange: { color: ["#F3EFE9", "#C7D0C3", "#7E9CA8", "#6F7F68"] },
      },
      series: [{
        type: "heatmap",
        data,
        label: {
          show: true,
          formatter: (params: any) => fmtNum(params.value?.[2]),
          ...CHART_AXIS_LABEL_STYLE,
          color: "#fff",
          fontSize: 11,
          fontWeight: 600,
          textBorderColor: "rgba(44,40,37,.38)",
          textBorderWidth: 2,
        },
        emphasis: { itemStyle: { shadowBlur: 8, shadowColor: "rgba(44,40,37,.18)" } },
      }],
    });
  }

  if (chartType === "scatter") {
    const valueField = yFields[0] || "value";
    const grouped = new Map<string, Map<string, { x: number; y: number; size: number }>>();
    rows.forEach((row, index) => {
      const seriesName = seriesField ? String(row[seriesField] ?? "未分类") : fieldLabel(valueField);
      const pointName = pointField ? String(row[pointField] ?? "未分类") : String(index);
      const points = grouped.get(seriesName) ?? new Map();
      const point = points.get(pointName) ?? { x: 0, y: 0, size: 0 };
      point.x += Number(row[xField]) || 0;
      point.y += Number(row[valueField]) || 0;
      point.size += Number(row[sizeField]) || 0;
      points.set(pointName, point);
      grouped.set(seriesName, points);
    });
    const maxSize = Math.max(
      ...[...grouped.values()].flatMap((points) => [...points.values()].map((point) => point.size)),
      1,
    );
    const scatterSeries = [...grouped.entries()].map(([name, points]) => ({
      name,
      type: "scatter",
      symbolSize: (value: number[]) => sizeField
        ? 9 + Math.sqrt(Math.max(value?.[2] ?? 0, 0) / maxSize) * 22
        : 9,
      data: [...points.entries()].map(([itemName, point]) => ({
        name: pointField ? itemName : name,
        value: [point.x, point.y, point.size],
      })),
      itemStyle: { opacity: 0.78 },
    }));
    return withChartDefaults({
      title: showTitle ? baseTitle(title) : undefined,
      tooltip: {
        ...CHART_TOOLTIP_STYLE,
        trigger: "item",
        formatter: (params: any) =>
          `${escapeHtml(params.name || params.seriesName)}${params.name && params.name !== params.seriesName ? `<br/>${escapeHtml(params.seriesName)}` : ""}<br/>${fieldLabel(xField)}：${formatBusinessNumber(params.value?.[0], { fixed: true })}<br/>${fieldLabel(valueField)}：${formatBusinessNumber(params.value?.[1], { fixed: true })}${sizeField ? `<br/>${fieldLabel(sizeField)}：${formatBusinessNumber(params.value?.[2], { fixed: true })}` : ""}`,
      },
      legend: scatterSeries.length > 1
        ? { top: 0, right: 0, type: "scroll", textStyle: CHART_LEGEND_TEXT_STYLE }
        : undefined,
      grid: {
        top: showTitle ? 48 : (scatterSeries.length > 1 ? 38 : 16),
        left: 12,
        right: 36,
        bottom: 8,
        containLabel: true,
      },
      xAxis: {
        type: "value",
        name: fieldLabel(xField),
        axisLine: AXIS_LINE,
        splitLine: SPLIT_LINE,
        axisLabel: { ...CHART_AXIS_LABEL_STYLE, formatter: fmtNum },
      },
      yAxis: {
        type: "value",
        name: fieldLabel(valueField),
        axisLine: AXIS_LINE,
        splitLine: SPLIT_LINE,
        axisLabel: { ...CHART_AXIS_LABEL_STYLE, formatter: fmtNum },
      },
      series: scatterSeries,
      color: PALETTE,
    });
  }

  // ---------- 饼图 / 环形图：占比（不支持多系列）----------
  if (chartType === "pie") {
    const valueField = yFields[0] || "value";
    const aggregated = aggregateCategoryRows(rows, xField, [valueField]);
    return withChartDefaults({
      title: showTitle ? baseTitle(title) : undefined,
      tooltip: {
        ...CHART_TOOLTIP_STYLE,
        trigger: "item",
        formatter: (p: any) =>
          `${escapeHtml(p.name)}<br/>${formatBusinessNumber(p.value, { fixed: true })} (${p.percent}%)`,
      },
      legend: { type: "scroll", bottom: 0, textStyle: CHART_LEGEND_TEXT_STYLE },
      series: [
        {
          type: "pie",
          radius: ["45%", "72%"],
          center: ["50%", "46%"],
          avoidLabelOverlap: true,
          data: aggregated.map((row) => ({
            name: formatChartCategoryValue(row[xField]),
            value: Number(row[valueField]),
          })),
          itemStyle: { borderRadius: 6, borderColor: "#fff", borderWidth: 2 },
          label: {
            formatter: "{b}\n{d}%",
            ...CHART_AXIS_LABEL_STYLE,
            fontSize: 12,
          },
          labelLine: { length: 10, length2: 8 },
          emphasis: { scale: true, scaleSize: 6 },
        },
      ],
      color: PALETTE,
    });
  }

  // ---------- 雷达图：多维度对比（不支持 seriesField，每个 yField 一个轴，每行一个系列）----------
  if (chartType === "radar") {
    const metrics = yFields.length ? yFields : [];
    const maxByMetric = metrics.map((m) => Math.max(...rows.map((r) => Number(r[m]) || 0), 0));
    return withChartDefaults({
      title: showTitle ? baseTitle(title) : undefined,
      tooltip: { ...CHART_TOOLTIP_STYLE, trigger: "item" },
      legend: { type: "scroll", bottom: 0, textStyle: CHART_LEGEND_TEXT_STYLE },
      radar: {
        indicator: metrics.map((m, i) => ({ name: fieldLabel(m), max: maxByMetric[i] * 1.1 || 1 })),
        radius: "62%",
        center: ["50%", "50%"],
        axisName: CHART_AXIS_LABEL_STYLE,
        splitLine: { lineStyle: { color: "#EDE8E0" } },
        splitArea: { areaStyle: { color: ["#FBF9F5", "#fff"] } },
        axisLine: { lineStyle: { color: "#E2DDD4" } },
      },
      series: [
        {
          type: "radar",
          data: rows.map((row) => ({
            name: formatChartCategoryValue(row[xField]),
            value: metrics.map((m) => Number(row[m]) || 0),
            areaStyle: { opacity: 0.12 },
          })),
          symbolSize: 4,
        },
      ],
      color: PALETTE,
    });
  }

  // ---------- bar / line / area / combo ----------
  const isCombo = chartType === "combo";
  const isStacked = chartType === "stacked_bar";
  const isHorizontal = chartType === "horizontal_bar";
  const asLineBase = chartType === "line" || chartType === "area";

  // 多系列模式：长表 {x, series, y} → pivot 成 N 条系列
  const hasSeries = !!seriesField && yFields.length >= 1;
  const chartRows = aggregateCategoryRows(rows, xField, yFields, hasSeries ? seriesField : "");
  if (isHorizontal && yFields[0]) {
    chartRows.sort((left, right) => (Number(right[yFields[0]]) || 0) - (Number(left[yFields[0]]) || 0));
  }
  let xData: string[];
  let series: any[];
  let dualAxis: boolean;

  if (hasSeries) {
    const valueField = yFields[0];
    // 保持 SQL 返回的顺序，去重得到 X 轴和系列
    const xSeen = new Set<string>();
    xData = [];
    const sSeen = new Set<string>();
    const sNames: string[] = [];
    for (const row of chartRows) {
      const xv = formatChartCategoryValue(row[xField]);
      const sv = String(row[seriesField] ?? "");
      if (!xSeen.has(xv)) {
        xSeen.add(xv);
        xData.push(xv);
      }
      if (!sSeen.has(sv)) {
        sSeen.add(sv);
        sNames.push(sv);
      }
    }
    // 行索引：(x, series) -> y
    const cell = new Map<string, number>();
    for (const row of chartRows) {
      const k = `${formatChartCategoryValue(row[xField])}__${row[seriesField]}`;
      cell.set(k, Number(row[valueField]) || 0);
    }
    series = sNames.map((sn) => ({
      name: sn,
      type: asLineBase ? "line" : "bar",
      data: xData.map((xv) => cell.get(`${xv}__${sn}`) ?? 0),
      smooth: asLineBase,
      symbol: asLineBase ? "circle" : undefined,
      symbolSize: asLineBase ? 4 : undefined,
      barMaxWidth: 24,
      itemStyle: { borderRadius: asLineBase ? 0 : [3, 3, 0, 0] },
      ...(isStacked ? { stack: "总计" } : {}),
      ...(chartType === "area" ? { areaStyle: { opacity: 0.15 } } : {}),
    }));
    dualAxis = false;
  } else {
    xData = chartRows.map((row) => formatChartCategoryValue(row[xField]));
    dualAxis = isCombo || (!isStacked && yFields.length === 2);
    series = yFields.map((y, i) => {
      // combo: 第 1 个 yField 柱，第 2 个 yField 折线（右轴）
      const asLine = isCombo ? i >= 1 : asLineBase;
      return {
        name: fieldLabel(y),
        type: asLine ? "line" : "bar",
        data: chartRows.map((row) => Number(row[y])),
        yAxisIndex: dualAxis ? Math.min(i, 1) : 0,
        smooth: asLine,
        symbol: asLine ? "circle" : undefined,
        symbolSize: asLine ? 5 : undefined,
        barMaxWidth: 38,
        itemStyle: { borderRadius: asLine ? 0 : [4, 4, 0, 0] },
        ...(isStacked ? { stack: "总计" } : {}),
        // 面积图 / combo 折线填充
        ...(((chartType === "area" && asLine) || (isCombo && asLine))
          ? { areaStyle: { opacity: 0.15 } }
          : {}),
        // 单系列柱状图在柱顶显示数值
        ...(!asLine && yFields.length === 1
          ? {
              label: {
                show: true,
                position: "top",
                formatter: (p: any) => fmtNum(p.value),
                ...CHART_AXIS_LABEL_STYLE,
                fontSize: 11,
              },
            }
          : {}),
      };
    });
  }

  if (isHorizontal) {
    return withChartDefaults({
      title: showTitle ? baseTitle(title) : undefined,
      tooltip: {
        ...CHART_TOOLTIP_STYLE,
        trigger: "axis",
        axisPointer: { type: "shadow" },
        valueFormatter: (value: any) => formatBusinessNumber(value, { fixed: true }),
      },
      legend: series.length > 1
        ? { top: 0, right: 0, type: "scroll", textStyle: CHART_LEGEND_TEXT_STYLE }
        : undefined,
      grid: {
        top: showTitle ? (series.length > 1 ? 48 : 42) : (series.length > 1 ? 38 : 12),
        left: 12,
        right: 56,
        bottom: 8,
        containLabel: true,
      },
      xAxis: {
        type: "value",
        axisLine: AXIS_LINE,
        splitLine: SPLIT_LINE,
        axisLabel: { ...CHART_AXIS_LABEL_STYLE, formatter: fmtNum },
      },
      yAxis: {
        type: "category",
        data: xData,
        inverse: true,
        axisLine: AXIS_LINE,
        axisTick: { show: false },
        axisLabel: {
          ...CHART_AXIS_LABEL_STYLE,
          width: 120,
          overflow: "truncate",
        },
      },
      series: series.map((item) => ({
        ...item,
        barMaxWidth: 24,
        label: series.length === 1
          ? {
              show: true,
              position: "right",
              formatter: (params: any) => fmtNum(params.value),
              ...CHART_AXIS_LABEL_STYLE,
              fontSize: 11,
            }
          : undefined,
      })),
      color: PALETTE,
    });
  }

  return withChartDefaults({
    title: showTitle ? baseTitle(title) : undefined,
    tooltip: {
      ...CHART_TOOLTIP_STYLE,
      trigger: "axis",
      axisPointer: { type: "shadow" },
      valueFormatter: (v: any) =>
        formatBusinessNumber(v, { fixed: true }),
    },
    legend: series.length > 1
      ? {
          top: 0,
          right: 0,
          type: "scroll",
          textStyle: CHART_LEGEND_TEXT_STYLE,
        }
      : undefined,
    grid: {
      top: showTitle
        ? (series.length > 1 ? 48 : 42)
        : (series.length > 1 ? 38 : 16),
      left: 12,
      right: dualAxis ? 24 : 16,
      bottom: 8,
      containLabel: true,
    },
    xAxis: {
      type: "category",
      data: xData,
      axisLine: AXIS_LINE,
      axisTick: { alignWithLabel: true },
      axisLabel: {
        ...CHART_AXIS_LABEL_STYLE,
        interval: "auto",
        rotate: xData.length > 8 ? 28 : 0,
        width: xData.length > 8 ? 100 : undefined,
        overflow: "truncate",
      },
    },
    yAxis: dualAxis
      ? [
          { type: "value", axisLine: AXIS_LINE, splitLine: SPLIT_LINE, axisLabel: { ...CHART_AXIS_LABEL_STYLE, formatter: fmtNum } },
          { type: "value", axisLine: AXIS_LINE, splitLine: { show: false }, axisLabel: { ...CHART_AXIS_LABEL_STYLE, formatter: fmtNum } },
        ]
      : { type: "value", axisLine: AXIS_LINE, splitLine: SPLIT_LINE, axisLabel: { ...CHART_AXIS_LABEL_STYLE, formatter: fmtNum } },
    series,
    color: PALETTE,
  });
}
