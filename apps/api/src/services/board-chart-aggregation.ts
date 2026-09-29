type ChartAggregationConfig = {
  filterFields?: unknown;
  xField?: unknown;
  yFields?: unknown;
  seriesField?: unknown;
  benchmarkField?: unknown;
  pointField?: unknown;
  sizeField?: unknown;
  valueMode?: unknown;
  aggregationMode?: unknown;
};

export type ChartServerAggregationSql = {
  queryText: string;
  groupFields: string[];
  sumFields: string[];
};

const SAFE_FIELD_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_FIELDS_PER_ROLE = 16;
const SUPPORTED_CHART_TYPES = new Set([
  "area",
  "bar",
  "combo",
  "funnel",
  "gauge",
  "heatmap",
  "horizontal_bar",
  "kpi",
  "line",
  "pie",
  "scatter",
  "stacked_bar",
  "treemap",
]);

function field(value: unknown): string | null {
  return typeof value === "string" && SAFE_FIELD_RE.test(value) ? value : null;
}

function fields(value: unknown): string[] | null {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_FIELDS_PER_ROLE) return null;
  const parsed = value.map(field);
  return parsed.every((item): item is string => item !== null) ? parsed : null;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function quoteIdentifier(value: string): string {
  return `"${value}"`;
}

export function buildChartServerAggregationSql(input: {
  sqlText: string;
  chartType: unknown;
  config: ChartAggregationConfig;
}): ChartServerAggregationSql | null {
  if (typeof input.chartType !== "string" || !SUPPORTED_CHART_TYPES.has(input.chartType)) return null;
  if (input.config.aggregationMode !== "sum") return null;
  if (input.chartType === "kpi" && input.config.valueMode === "average") return null;

  const filterFields = fields(input.config.filterFields);
  const yFields = fields(input.config.yFields);
  if (!filterFields || !yFields) return null;

  const xField = field(input.config.xField);
  const seriesField = field(input.config.seriesField);
  const benchmarkField = field(input.config.benchmarkField);
  const pointField = field(input.config.pointField);
  const sizeField = field(input.config.sizeField);

  if (
    (input.config.xField != null && !xField)
    || (input.config.seriesField != null && !seriesField)
    || (input.config.benchmarkField != null && !benchmarkField)
    || (input.config.pointField != null && !pointField)
    || (input.config.sizeField != null && !sizeField)
  ) {
    return null;
  }

  let groupFields: string[];
  let sumFields: string[];
  if (input.chartType === "scatter") {
    if (!xField || !pointField || yFields.length === 0) return null;
    groupFields = unique([
      ...filterFields,
      ...(seriesField ? [seriesField] : []),
      pointField,
    ]);
    sumFields = unique([
      xField,
      ...yFields,
      ...(sizeField ? [sizeField] : []),
    ]);
  } else {
    groupFields = unique([
      ...filterFields,
      ...(xField ? [xField] : []),
      ...(seriesField ? [seriesField] : []),
    ]);
    sumFields = unique([
      ...yFields,
      ...(benchmarkField ? [benchmarkField] : []),
    ]);
  }

  if (
    sumFields.length === 0
    || groupFields.length > MAX_FIELDS_PER_ROLE
    || sumFields.length > MAX_FIELDS_PER_ROLE
    || sumFields.some((item) => groupFields.includes(item))
  ) {
    return null;
  }

  const selectExpressions = [
    ...groupFields.map((item) => `sub.${quoteIdentifier(item)} AS ${quoteIdentifier(item)}`),
    ...sumFields.map((item) =>
      `SUM(COALESCE((sub.${quoteIdentifier(item)})::numeric, 0)) AS ${quoteIdentifier(item)}`),
  ];
  const sourceSql = input.sqlText.replace(/;\s*$/, "");
  const groupBy = groupFields.length
    ? `\nGROUP BY ${groupFields.map((item) => `sub.${quoteIdentifier(item)}`).join(", ")}`
    : "";
  const orderBy = groupFields.length
    ? `\nORDER BY ${groupFields.map(quoteIdentifier).join(", ")}`
    : "";
  return {
    queryText: `SELECT ${selectExpressions.join(",\n       ")}\nFROM (${sourceSql}) sub${groupBy}${orderBy}`,
    groupFields,
    sumFields,
  };
}
