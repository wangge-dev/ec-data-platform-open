// 模块相关共享类型
export type Column = {
  name: string;
  source?: string | string[];
  type: string;
  maxLen?: number;
  required?: boolean;
  label?: string;
  hint?: string;
  computed?: boolean;
  expression?: string;
};

export type Platform = {
  code: string;
  name: string;
  filePattern: string;
  patternFlags?: string;
  enabled: boolean;
  columnOverrides?: Record<string, string | string[]>;
};

export type Join = {
  dictRole: string;
  on: Record<string, string>;
  enrich: Record<string, string>;
  label?: string;
};

export type Preset = {
  key: string;
  label: string;
  description?: string;
  target: "compare" | "board";
  metric?: string;
  agg?: "sum" | "avg" | "count" | "max" | "min";
  dim?: string;
  metricId?: string;
  dimensionId?: string;
  period?: "dod" | "wow" | "mom" | "yoy";
  emphasis: "warning" | "info" | "neutral";
};

export type AlertRule = {
  key: string;
  label: string;
  severity: "info" | "warning" | "critical";
  sql: string;
  message: string;
  enabled?: boolean;
};

export type ModuleFieldSuggestion = {
  key: string;
  label: string;
  chartType: "bar" | "line" | "pie";
  dimension: string;
  metric: string;
};

export type ModuleData = {
  code: string;
  name: string;
  category?: string;
  categoryLabel?: string;
  description: string;
  enabled: boolean;
  hasTransform: boolean;
  outputTable: string;
  timeKey?: string;
  schedule?: string;
  usages: string[];
  semanticModel?: {
    schemaVersion: "semantic-manifest/v1";
    id: string;
    version: number;
    dimensions: Array<{
      id: string;
      label: string;
      field: string;
      kind: "categorical" | "time";
      timeGrain?: "day" | "month";
      description?: string;
    }>;
    metrics: Array<{
      id: string;
      label: string;
      aggregation: "sum" | "average" | "count" | "min" | "max" | "ratio";
      field?: string;
      unit: "number" | "currency" | "percent" | "quantity";
      additiveAcrossTime: boolean;
      description?: string;
    }>;
  };
  columns: Column[];
  platforms: Platform[];
  join?: Join;
  joins?: Join[];
  presets?: Preset[];
  alerts?: AlertRule[];
  totalRows?: number;
  referencedBy?: string[];
  origin?: "builtin" | "user";
  fieldSuggestions?: ModuleFieldSuggestion[];
};

const RETIRED_MODULE_CODES = new Set(["shopee_ads", "shopee_sales"]);

export function isRetiredModuleCode(
  code: string | null | undefined,
): boolean {
  return typeof code === "string" && RETIRED_MODULE_CODES.has(code);
}

/**
 * Keep retired built-in modules out of every client surface even while an
 * older API process is still draining or has a persisted configuration.
 */
export function filterRetiredModules<T extends { code: string }>(
  modules: T[] | null | undefined,
): T[] {
  return (modules ?? []).filter((module) => !isRetiredModuleCode(module.code));
}

export type BuilderSource = {
  id: number;
  name: string;
  config?: {
    originalFileName?: string;
    rowCount?: number;
    columns?: unknown[];
  };
  attribution?: {
    kind: "module" | "dict" | "unmatched";
  };
};

export type ModuleSourceInspection = {
  sourceIds: number[];
  compatible: boolean;
  headers: string[];
  samples: Record<string, unknown>[];
  filenamePhrase: string | null;
  statusValues: Array<{ value: string; rows: number }>;
  inferredTypes: Record<
    string,
    "text" | "int" | "numeric" | "timestamp" | "date" | "boolean"
  >;
  differences: Array<{
    sourceId: number;
    added: string[];
    missing: string[];
  }>;
};

export type AssignAndRunResult = {
  moduleCode: string;
  files: Array<{
    sourceId: number;
    status: "success" | "failed";
    total: number;
    inserted: number;
    included: number;
    error?: string;
  }>;
  warnings?: string[];
};
