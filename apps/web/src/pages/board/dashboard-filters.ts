import type { BoardChart } from "./module-groups";

export type DashboardFilter = {
  moduleCode: string;
  field: string;
  fieldLabel: string;
  value: string;
};

export type ChartFilterMetadata = {
  chartId: number;
  moduleCode: string;
  fields: Array<{
    name: string;
    label: string;
    values: string[];
    order: number;
  }>;
};

export type DashboardSlicer = {
  key: string;
  moduleCode: string;
  field: string;
  label: string;
  values: string[];
  chartCount: number;
  truncated: boolean;
  order: number;
};

const SERIALIZED_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z)?$/;
const DATE_FIELD_RE = /(^|_)(date|day|week|month|year|time)($|_)|日期|月份|时间|^日$|^月$|^年$/i;

function normalizeValue(value: unknown): string {
  const text = String(value ?? "").trim();
  return text.match(/^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z$/)?.[1] ?? text;
}

function usefulSlicerField(field: string, values: string[]): boolean {
  if (!field || DATE_FIELD_RE.test(field) || values.length < 2) return false;
  if (values.every((value) => SERIALIZED_DATE_RE.test(value))) return false;
  if (values.every((value) => value !== "" && Number.isFinite(Number(value)))) return false;
  return true;
}

export function chartFilterMetadata(
  chart: BoardChart,
  rows: Record<string, unknown>[],
  fieldLabels: Record<string, string> = {},
): ChartFilterMetadata {
  const configuredFields = chart.config?.filterFields ?? [];
  const candidateFields = (configuredFields.length
    ? configuredFields
    : [chart.config?.xField, chart.config?.seriesField])
    .filter((field): field is string => Boolean(field));
  const fields = [...new Set(candidateFields)].flatMap((field, order) => {
    const values = [...new Set(
      rows
        .filter((row) => Object.prototype.hasOwnProperty.call(row, field))
        .map((row) => normalizeValue(row[field]))
        .filter(Boolean),
    )].sort((left, right) => left.localeCompare(right, "zh-CN"));
    if (!usefulSlicerField(field, values)) return [];
    return [{ name: field, label: fieldLabels[field] || field, values, order }];
  });
  return {
    chartId: chart.id,
    moduleCode: chart.moduleCode || "unclassified",
    fields,
  };
}

export function buildDashboardSlicers(
  metadata: ChartFilterMetadata[],
  selectedModuleCode: string,
  maxValues = 10,
  selectedMemberCodes: readonly string[] = [],
): DashboardSlicer[] {
  const selectedMembers = new Set(selectedMemberCodes);
  const groups = new Map<string, {
    moduleCode: string;
    field: string;
    label: string;
    chartIds: Set<number>;
    values: Set<string>;
    order: number;
  }>();

  for (const chart of metadata) {
    if (
      selectedModuleCode !== "all"
      && chart.moduleCode !== selectedModuleCode
      && !selectedMembers.has(chart.moduleCode)
    ) continue;
    for (const field of chart.fields) {
      const key = `${chart.moduleCode}:${field.name}`;
      const current = groups.get(key) ?? {
        moduleCode: chart.moduleCode,
        field: field.name,
        label: field.label,
        chartIds: new Set<number>(),
        values: new Set<string>(),
        order: field.order,
      };
      current.chartIds.add(chart.chartId);
      field.values.forEach((value) => current.values.add(value));
      current.order = Math.min(current.order, field.order);
      groups.set(key, current);
    }
  }

  return [...groups.entries()]
    .filter(([, group]) => group.chartIds.size >= 2)
    .map(([key, group]) => {
      const values = [...group.values].sort((left, right) => left.localeCompare(right, "zh-CN"));
      return {
        key,
        moduleCode: group.moduleCode,
        field: group.field,
        label: group.label,
        values: values.slice(0, maxValues),
        chartCount: group.chartIds.size,
        truncated: values.length > maxValues,
        order: group.order,
      };
    })
    .sort((left, right) => left.order - right.order || right.chartCount - left.chartCount || left.label.localeCompare(right.label, "zh-CN"));
}

export function applyDashboardFilters<T extends Record<string, unknown>>(
  rows: T[],
  moduleCode: string | null | undefined,
  filters: DashboardFilter[],
): T[] {
  const scoped = filters.filter(
    (filter) => filter.moduleCode === (moduleCode || "unclassified"),
  );
  if (!scoped.length) return rows;
  return rows.filter((row) => scoped.every((filter) =>
    !Object.prototype.hasOwnProperty.call(row, filter.field)
    || normalizeValue(row[filter.field]) === filter.value
  ));
}

export function filterFromChartClick(
  chart: BoardChart,
  params: { name?: unknown; seriesName?: unknown; treePathInfo?: Array<{ name?: unknown }> },
  fieldLabels: Record<string, string> = {},
): DashboardFilter | null {
  const moduleCode = chart.moduleCode || "unclassified";
  if (chart.chartType === "treemap" && params.treePathInfo?.length) {
    const path = params.treePathInfo
      .map((item) => normalizeValue(item.name))
      .filter(Boolean);
    const useSeries = path.length >= 2 && Boolean(chart.config?.seriesField);
    const field = useSeries ? chart.config.seriesField! : chart.config?.xField;
    const value = path.at(-1);
    if (!field || !value) return null;
    return {
      moduleCode,
      field,
      fieldLabel: fieldLabels[field] || field,
      value,
    };
  }
  if (chart.config?.seriesField && params.seriesName != null) {
    const value = normalizeValue(params.seriesName);
    if (!value) return null;
    return {
      moduleCode,
      field: chart.config.seriesField,
      fieldLabel: fieldLabels[chart.config.seriesField] || chart.config.seriesField,
      value,
    };
  }
  if (!chart.config?.xField || params.name == null) return null;
  const value = normalizeValue(params.name);
  if (!value || SERIALIZED_DATE_RE.test(value) || DATE_FIELD_RE.test(chart.config.xField)) return null;
  return {
    moduleCode,
    field: chart.config.xField,
    fieldLabel: fieldLabels[chart.config.xField] || chart.config.xField,
    value,
  };
}

export function upsertDashboardFilter(
  filters: DashboardFilter[],
  next: DashboardFilter,
): DashboardFilter[] {
  return [
    ...filters.filter(
      (filter) => filter.moduleCode !== next.moduleCode || filter.field !== next.field,
    ),
    next,
  ];
}
