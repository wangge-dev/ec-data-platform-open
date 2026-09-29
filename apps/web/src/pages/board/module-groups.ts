import {
  isRetiredModuleCode,
  type ModuleData,
  type ModuleFieldSuggestion,
} from "../module/types";

export type BoardChart = {
  id: number;
  datasetId: number;
  name: string;
  chartType:
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
  config: {
    title?: string;
    xField?: string;
    yFields?: string[];
    seriesField?: string;
    fieldLabels?: Record<string, string>;
    filterFields?: string[];
    dateField?: string;
    moduleName?: string;
    moduleOrder?: number;
    featured?: boolean;
    demo?: boolean;
    subtitle?: string;
    displaySize?: "kpi" | "wide" | "compact" | "half" | "full";
    dashboardOrder?: number;
    benchmarkField?: string;
    comparisonLabel?: string;
    valueMode?: "sum" | "average" | "ratio";
    aggregationMode?: "sum" | "none";
    targetValue?: number;
    valuePrefix?: string;
    valueSuffix?: string;
    valueDecimals?: number;
    valueLabel?: string;
    pointField?: string;
    sizeField?: string;
    columnOrder?: string[];
    periodFrom?: string;
    periodTo?: string;
    rowCount?: number;
  };
  moduleCode?: string | null;
  createdAt: string;
};

export type ModuleChartGroup = {
  code: string;
  name: string;
  charts: BoardChart[];
  moduleCodes: string[];
  demo?: boolean;
};

export type ModuleFilterOption = {
  code: string;
  name: string;
  count: number;
};

export type ModuleChartPrefill = {
  moduleCode: string;
  moduleName: string;
  suggestionLabel: string;
  datasetName: string;
  chartName: string;
  chartType: "bar" | "line" | "pie";
  queryText: string;
  modelId: string;
  modelVersion: number;
  metricIds: [string];
  dimensionIds: [string];
  xField: string;
  yFields: [string];
};

function boundedName(value: string): string {
  return Array.from(value).slice(0, 128).join("");
}

type BusinessGroupDefinition = {
  code: string;
  name: string;
  moduleCodes: string[];
};

function categoryGroupCode(category: string): string {
  return `category:${encodeURIComponent(category)}`;
}

function uniqueValue(
  preferred: string,
  disambiguator: string,
  used: Set<string>,
): string {
  if (!used.has(preferred)) {
    used.add(preferred);
    return preferred;
  }
  const contextual = `${preferred}（${disambiguator}）`;
  if (!used.has(contextual)) {
    used.add(contextual);
    return contextual;
  }
  let suffix = 2;
  while (used.has(`${contextual} ${suffix}`)) suffix += 1;
  const unique = `${contextual} ${suffix}`;
  used.add(unique);
  return unique;
}

function uniqueCode(
  preferred: string,
  fallback: string,
  used: Set<string>,
): string {
  if (!used.has(preferred)) {
    used.add(preferred);
    return preferred;
  }
  let candidate = fallback;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${fallback}:${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function businessGroupDefinitions(modules: ModuleData[]): BusinessGroupDefinition[] {
  const activeModules = modules.filter((module) => module.enabled);
  const reservedCodes = new Set(activeModules.map((module) => module.code));
  const definitions = new Map<string, {
    code: string;
    baseName: string;
    hasCategoryLabel: boolean;
    moduleCodes: string[];
    disambiguator: string;
  }>();

  for (const module of activeModules) {
    const category = module.category?.trim();
    const key = category ? `category\u0000${category}` : `module\u0000${module.code}`;
    const current = definitions.get(key);
    const categoryLabel = module.categoryLabel?.trim();
    if (current) {
      if (!current.moduleCodes.includes(module.code)) current.moduleCodes.push(module.code);
      if (category && !current.hasCategoryLabel && categoryLabel) {
        current.baseName = categoryLabel;
        current.hasCategoryLabel = true;
      }
      continue;
    }

    definitions.set(key, {
      code: category
        ? uniqueCode(
            categoryGroupCode(category),
            `category:${encodeURIComponent(category)}:group`,
            reservedCodes,
          )
        : module.code,
      baseName: category ? categoryLabel || category : module.name,
      hasCategoryLabel: Boolean(category && categoryLabel),
      moduleCodes: [module.code],
      disambiguator: category || module.code,
    });
  }

  const usedNames = new Set<string>();
  return [...definitions.values()].map((definition) => ({
    code: definition.code,
    name: uniqueValue(definition.baseName, definition.disambiguator, usedNames),
    moduleCodes: definition.moduleCodes,
  }));
}

export function semanticColumnAlias(
  id: string,
  kind: "metric" | "dimension",
  index: number,
): string {
  const suffix = id.replace(/[^a-z0-9_]/g, "__").slice(-48);
  return `${kind === "metric" ? "m" : "d"}${index}__${suffix}`;
}

function suggestionSemanticIds(
  module: ModuleData,
  suggestion: ModuleFieldSuggestion,
): {
  model: NonNullable<ModuleData["semanticModel"]>;
  dimensionId: string;
  metricId: string;
} {
  const model = module.semanticModel;
  const dimension = model?.dimensions.find(
    (candidate) => candidate.field === suggestion.dimension,
  );
  const metric =
    suggestion.metric === "count"
      ? model?.metrics.find((candidate) => candidate.aggregation === "count")
      : model?.metrics.find((candidate) => candidate.field === suggestion.metric);
  const compatible =
    model !== undefined &&
    dimension !== undefined &&
    metric !== undefined &&
    (suggestion.chartType !== "line" || dimension.kind === "time") &&
    (suggestion.chartType !== "pie" || suggestion.metric === "count");

  if (!compatible) {
    throw new Error("无法创建该字段建议");
  }
  return { model, dimensionId: dimension.id, metricId: metric.id };
}

export function buildModuleSuggestionPrefill(
  module: ModuleData,
  suggestion: ModuleFieldSuggestion,
): ModuleChartPrefill {
  const { model, dimensionId, metricId } = suggestionSemanticIds(module, suggestion);
  const queryText = JSON.stringify({
    modelId: model.id,
    modelVersion: model.version,
    metricIds: [metricId],
    dimensionIds: [dimensionId],
    filters: [],
    limit: suggestion.chartType === "bar" ? 10 : 200,
  });

  const chartName = boundedName(`${module.name} · ${suggestion.label}`);
  return {
    moduleCode: module.code,
    moduleName: module.name,
    suggestionLabel: suggestion.label,
    datasetName: chartName,
    chartName,
    chartType: suggestion.chartType,
    queryText,
    modelId: model.id,
    modelVersion: model.version,
    metricIds: [metricId],
    dimensionIds: [dimensionId],
    xField: semanticColumnAlias(dimensionId, "dimension", 0),
    yFields: [semanticColumnAlias(metricId, "metric", 0)],
  };
}

export function groupChartsByModule(
  charts: BoardChart[],
  modules: ModuleData[],
): ModuleChartGroup[] {
  const activeModules = modules.filter((module) => module.enabled);
  const activeCodes = new Set(activeModules.map((module) => module.code));
  const businessGroups = businessGroupDefinitions(modules);
  const chartsByModule = new Map<string, BoardChart[]>();
  const virtualGroups = new Map<string, {
    code: string;
    name: string;
    charts: BoardChart[];
    moduleOrder: number;
    featured: boolean;
    demo: boolean;
  }>();
  const unclassified: BoardChart[] = [];

  for (const chart of charts) {
    if (isRetiredModuleCode(chart.moduleCode)) continue;
    if (chart.moduleCode && activeCodes.has(chart.moduleCode)) {
      const moduleCharts = chartsByModule.get(chart.moduleCode) ?? [];
      moduleCharts.push(chart);
      chartsByModule.set(chart.moduleCode, moduleCharts);
    } else if (chart.moduleCode && chart.config?.moduleName) {
      const current = virtualGroups.get(chart.moduleCode) ?? {
        code: chart.moduleCode,
        name: chart.config.moduleName,
        charts: [],
        moduleOrder: chart.config.moduleOrder ?? 0,
        featured: chart.config.featured === true,
        demo: chart.config.demo === true,
      };
      current.charts.push(chart);
      current.moduleOrder = Math.min(current.moduleOrder, chart.config.moduleOrder ?? 0);
      current.featured ||= chart.config.featured === true;
      current.demo ||= chart.config.demo === true;
      virtualGroups.set(chart.moduleCode, current);
    } else {
      unclassified.push(chart);
    }
  }

  const sortCharts = (items: BoardChart[]) => [...items].sort(
    (left, right) =>
      (left.config?.dashboardOrder ?? Number.MAX_SAFE_INTEGER)
      - (right.config?.dashboardOrder ?? Number.MAX_SAFE_INTEGER)
      || left.id - right.id,
  );

  const moduleGroups = businessGroups.flatMap((group) => {
    const moduleCharts = group.moduleCodes.flatMap(
      (moduleCode) => chartsByModule.get(moduleCode) ?? [],
    );
    return moduleCharts.length
      ? [{
          code: group.code,
          name: group.name,
          charts: sortCharts(moduleCharts),
          moduleCodes: group.moduleCodes,
        }]
      : [];
  });

  const usedCodes = new Set(businessGroups.map((group) => group.code));
  const usedNames = new Set(businessGroups.map((group) => group.name));
  const sortedVirtualGroups = [...virtualGroups.values()]
    .sort((left, right) =>
      Number(right.featured) - Number(left.featured)
      || left.moduleOrder - right.moduleOrder
      || left.name.localeCompare(right.name, "zh-CN"),
    )
    .map((group) => ({
      code: uniqueCode(
        group.code,
        `virtual:${encodeURIComponent(group.code)}`,
        usedCodes,
      ),
      name: uniqueValue(group.name, group.code, usedNames),
      charts: sortCharts(group.charts),
      moduleCodes: [group.code],
      demo: group.demo,
      featured: group.featured,
    }));
  const groups = [
    ...sortedVirtualGroups.filter((group) => group.featured),
    ...moduleGroups,
    ...sortedVirtualGroups.filter((group) => !group.featured),
  ];

  if (unclassified.length) {
    groups.push({
      code: "",
      name: uniqueValue("未分类", "其他", usedNames),
      charts: sortCharts(unclassified),
      moduleCodes: [
        ...new Set(
          unclassified.map((chart) => chart.moduleCode || "unclassified"),
        ),
      ],
    });
  }

  return groups;
}

export function buildModuleFilterOptions(
  groups: ModuleChartGroup[],
  modules: ModuleData[],
): ModuleFilterOption[] {
  const options = groups
    .filter((group) => group.code)
    .map((group) => ({
      code: group.code,
      name: group.name,
      count: group.charts.length,
    }));
  const visibleCodes = new Set(options.map((option) => option.code));

  for (const group of businessGroupDefinitions(modules)) {
    if (visibleCodes.has(group.code)) continue;
    options.push({ code: group.code, name: group.name, count: 0 });
  }
  return options;
}

export function moduleCodesForSelection(
  selectedCode: "all" | string,
  modules: ModuleData[],
): string[] {
  if (selectedCode === "all") return [];
  const groups = businessGroupDefinitions(modules);
  return (
    groups.find((group) => group.code === selectedCode)
    ?? groups.find((group) => group.moduleCodes.includes(selectedCode))
  )?.moduleCodes ?? [];
}

export function filterModuleGroups(
  groups: ModuleChartGroup[],
  selectedCode: "all" | string,
): ModuleChartGroup[] {
  return selectedCode === "all"
    ? groups
    : groups.filter((group) => group.code === selectedCode);
}

export function resolveDefaultModuleCode(
  groups: ModuleChartGroup[],
): "all" | string {
  const realBusinessGroup = groups.find(
    (group) => group.code && !group.demo && group.charts.length > 0,
  );
  if (realBusinessGroup) return realBusinessGroup.code;

  return groups.find(
    (group) => group.demo && group.charts.some((chart) => chart.config?.featured),
  )?.code ?? groups.find((group) => group.demo)?.code ?? "all";
}

export function resolveSelectedModuleCode(
  requestedCode: string | null | undefined,
  modules: ModuleData[],
  charts: BoardChart[] = [],
): "all" | string {
  if (!requestedCode || requestedCode === "all") return "all";
  const businessGroups = businessGroupDefinitions(modules);
  const requestedBusinessGroup = businessGroups.find(
    (group) =>
      group.code === requestedCode || group.moduleCodes.includes(requestedCode),
  );
  if (requestedBusinessGroup) return requestedBusinessGroup.code;
  return groupChartsByModule(charts, modules).some(
    (group) => group.code === requestedCode,
  )
    ? requestedCode
    : "all";
}

export function fieldSuggestionsForSelection(
  selectedCode: "all" | string,
  modules: ModuleData[],
): ModuleFieldSuggestion[] {
  const moduleCodes = moduleCodesForSelection(selectedCode, modules);
  if (moduleCodes.length !== 1) return [];
  return (
    modules.find(
      (module) => module.enabled && module.code === moduleCodes[0],
    )?.fieldSuggestions ?? []
  );
}
