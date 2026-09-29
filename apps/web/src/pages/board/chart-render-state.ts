function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const candidate = error as {
      message?: unknown;
      error?: unknown;
      response?: { data?: { message?: unknown; error?: unknown } };
    };
    const value =
      candidate.message ??
      candidate.error ??
      candidate.response?.data?.message ??
      candidate.response?.data?.error;
    if (typeof value === "string") return value;
  }
  return "";
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const candidate = error as {
    code?: unknown;
    response?: { data?: { code?: unknown } };
  };
  const code = candidate.code ?? candidate.response?.data?.code;
  return typeof code === "string" ? code : "";
}

export type CompleteChartRenderData = {
  rows: any[];
  complete: true;
  truncated: false;
  rowLimit: number;
  filterApplied?: boolean;
  aggregation?: {
    mode: "server";
    groupFields: string[];
    sumFields: string[];
    sourceRowLimit: number;
  };
};

export function chartRenderQueryKey(input: {
  chartId: number;
  datasetId: number;
  dateField: string;
  dateFrom?: string;
  dateTo?: string;
}) {
  return [
    "chart-render",
    input.chartId,
    input.datasetId,
    input.dateField,
    input.dateFrom ?? "",
    input.dateTo ?? "",
  ] as const;
}

export function requireCompleteChartRenderData(input: unknown): CompleteChartRenderData {
  const candidate = input as Partial<CompleteChartRenderData> | null;
  const aggregation = candidate?.aggregation;
  const validAggregation = aggregation == null || (
    aggregation.mode === "server"
    && Array.isArray(aggregation.groupFields)
    && aggregation.groupFields.every((item) => typeof item === "string")
    && Array.isArray(aggregation.sumFields)
    && aggregation.sumFields.every((item) => typeof item === "string")
    && Number.isSafeInteger(aggregation.sourceRowLimit)
    && aggregation.sourceRowLimit > 0
  );
  if (
    !candidate
    || candidate.complete !== true
    || candidate.truncated !== false
    || !Array.isArray(candidate.rows)
    || !Number.isSafeInteger(candidate.rowLimit)
    || Number(candidate.rowLimit) <= 0
    || !validAggregation
  ) {
    throw new Error("CHART_DATA_INCOMPLETE");
  }
  return candidate as CompleteChartRenderData;
}

export function chartRenderErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code === "CHART_DATA_INCOMPLETE" || errorText(error) === "CHART_DATA_INCOMPLETE") {
    return "这张图表的数据不完整，为避免错误聚合不会展示。请缩小日期范围，或让管理员改用服务端聚合图表。";
  }
  if (code === "CHART_DATE_FILTER_INVALID" || code === "CHART_DATE_FILTER_FAILED") {
    return "日期筛选没有成功应用，因此不会展示未过滤数据。请检查日期边界和图表日期字段。";
  }
  if (code === "CHART_SERVER_AGGREGATION_FAILED") {
    return "服务端没有成功汇总这张大数据图表。请检查指标字段是否可计算，或缩小日期范围。";
  }
  const detail = errorText(error).toLowerCase();
  if (detail.includes("permission denied")) {
    return "这张旧图表的数据表还没有完成读取权限迁移。安装修复版并重新启动平台后再试。";
  }
  if (detail.includes("relation") && detail.includes("does not exist")) {
    return "这张图表引用的数据表已经不存在，请删除后重新创建图表。";
  }
  if (detail.includes("column") && detail.includes("does not exist")) {
    return "这张图表引用的字段已经变化，请按当前字段重新创建图表。";
  }
  return "暂时无法读取这张图表。请先重新加载；仍失败时，到对应模块检查数据和字段。";
}
