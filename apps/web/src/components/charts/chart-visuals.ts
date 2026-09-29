import type { EChartsReactProps } from "echarts-for-react";

export type ChartRenderer = "svg" | "canvas";
export type ChartInitOptions = NonNullable<EChartsReactProps["opts"]>;

export const CHART_FONT_FAMILY =
  '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

export const CHART_TEXT_STYLE = {
  color: "#2C2825",
  fontFamily: CHART_FONT_FAMILY,
  fontSize: 12,
} as const;

export const CHART_TITLE_TEXT_STYLE = {
  ...CHART_TEXT_STYLE,
  fontSize: 15,
  fontWeight: 600,
} as const;

export const CHART_AXIS_LABEL_STYLE = {
  color: "#6B655F",
  fontFamily: CHART_FONT_FAMILY,
  fontSize: 12,
  fontWeight: 500,
  lineHeight: 17,
  margin: 10,
  hideOverlap: true,
} as const;

export const CHART_LEGEND_TEXT_STYLE = {
  color: "#6B655F",
  fontFamily: CHART_FONT_FAMILY,
  fontSize: 12,
  fontWeight: 500,
} as const;

export const CHART_TOOLTIP_STYLE = {
  renderMode: "html" as const,
  confine: true,
  backgroundColor: "rgba(255, 255, 255, 0.98)",
  borderColor: "#E8E5DF",
  borderWidth: 1,
  padding: [10, 12],
  textStyle: {
    ...CHART_TEXT_STYLE,
    fontSize: 13,
    lineHeight: 20,
  },
  extraCssText:
    `font-family:${CHART_FONT_FAMILY};` +
    "border-radius:8px;box-shadow:0 4px 14px rgba(44,40,37,.12);",
} as const;

/** Escape untrusted labels before interpolating them into an HTML tooltip. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function normalizeDevicePixelRatio(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 1) return 1;
  return Math.min(value, 3);
}

export function buildChartInitOptions(
  renderer: ChartRenderer,
  devicePixelRatio: number | undefined,
): ChartInitOptions {
  return {
    renderer,
    devicePixelRatio: normalizeDevicePixelRatio(devicePixelRatio),
  };
}

type NumberFormatOptions = {
  compact?: boolean;
  fixed?: boolean;
};

/**
 * 经营金额统一最多保留两位小数；详情值固定两位，坐标轴可用“万/亿”紧凑显示。
 */
export function formatBusinessNumber(
  value: unknown,
  options: NumberFormatOptions = {},
): string {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return "—";

  const { compact = false, fixed = false } = options;
  const absolute = Math.abs(numberValue);
  if (compact && absolute >= 1e8) {
    return `${(numberValue / 1e8).toFixed(2)} 亿`;
  }
  if (compact && absolute >= 1e4) {
    return `${(numberValue / 1e4).toFixed(2)} 万`;
  }

  return numberValue.toLocaleString("zh-CN", {
    minimumFractionDigits: fixed ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

export function displayFieldName(
  fieldName: string | null | undefined,
  columns: Array<{ name: string; label?: string }> = [],
  fallback = "维度",
): string {
  if (!fieldName) return fallback;
  const label = columns.find((column) => column.name === fieldName)?.label?.trim();
  return label || fieldName;
}

export function withChartDefaults<T extends Record<string, any>>(option: T): T {
  return {
    ...option,
    aria: {
      enabled: true,
      ...(option.aria ?? {}),
    },
    textStyle: {
      ...CHART_TEXT_STYLE,
      ...(option.textStyle ?? {}),
    },
  };
}
