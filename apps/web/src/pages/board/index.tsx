import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Plus, Trash2, BarChart3, LineChart as LineIcon, PieChart, Table2, Sparkles, RefreshCw, Loader2, AlertTriangle, SlidersHorizontal, X, BadgeDollarSign, Gauge, Grid3X3, PanelsTopLeft, Database, CalendarDays } from "lucide-react";
import { CrispEChart } from "@/components/charts/CrispEChart";
import { api } from "@/lib/api";
import {
  filterRetiredModules,
  isRetiredModuleCode,
  type ModuleData,
  type ModuleFieldSuggestion,
} from "../module/types";
import { ChartCreator } from "./ChartCreator";
import { AiChartModal } from "./AiChartModal";
import { buildOption, formatChartCategoryValue } from "./chart-option";
import {
  chartRenderErrorMessage,
  chartRenderQueryKey,
  requireCompleteChartRenderData,
} from "./chart-render-state";
import { cn } from "@/lib/utils";
import {
  buildModuleFilterOptions,
  buildModuleSuggestionPrefill,
  fieldSuggestionsForSelection,
  filterModuleGroups,
  groupChartsByModule,
  moduleCodesForSelection,
  resolveDefaultModuleCode,
  resolveSelectedModuleCode,
  type BoardChart,
  type ModuleChartPrefill,
} from "./module-groups";
import {
  applyDashboardFilters,
  buildDashboardSlicers,
  chartFilterMetadata,
  filterFromChartClick,
  upsertDashboardFilter,
  type ChartFilterMetadata,
  type DashboardFilter,
} from "./dashboard-filters";
import { buildBoardLoadState, retryBoardQueries } from "./board-load-state";

const TYPE_ICONS = {
  bar: BarChart3,
  horizontal_bar: BarChart3,
  stacked_bar: BarChart3,
  line: LineIcon,
  area: LineIcon,
  pie: PieChart,
  radar: PieChart,
  combo: BarChart3,
  scatter: LineIcon,
  funnel: BarChart3,
  treemap: PanelsTopLeft,
  heatmap: Grid3X3,
  gauge: Gauge,
  kpi: BadgeDollarSign,
  table: Table2,
};

const TYPE_LABELS: Record<BoardChart["chartType"], string> = {
  bar: "柱状图",
  horizontal_bar: "横向排行",
  stacked_bar: "堆叠柱图",
  line: "折线图",
  area: "面积图",
  pie: "环形图",
  radar: "雷达图",
  combo: "组合图",
  scatter: "散点图",
  funnel: "漏斗图",
  treemap: "树图",
  heatmap: "热力图",
  gauge: "仪表图",
  kpi: "指标卡",
  table: "明细表",
};

function chartGridClass(chart: BoardChart): string {
  switch (chart.config?.displaySize) {
    case "kpi":
      return "col-span-12 min-w-0 sm:col-span-6 lg:col-span-3";
    case "wide":
      return "col-span-12 min-w-0 lg:col-span-8";
    case "compact":
      return "col-span-12 min-w-0 md:col-span-6 lg:col-span-4";
    case "half":
      return "col-span-12 min-w-0 lg:col-span-6";
    case "full":
      return "col-span-12 min-w-0";
    default:
      return chart.chartType === "kpi"
        ? "col-span-12 min-w-0 sm:col-span-6 lg:col-span-3"
        : "col-span-12 min-w-0 lg:col-span-6";
  }
}

function chartCanvasHeight(chart: BoardChart): number {
  if (chart.chartType === "kpi") return 156;
  if (["gauge", "treemap", "funnel"].includes(chart.chartType)) return 286;
  if (chart.chartType === "heatmap") return 310;
  return 320;
}

export function BoardPage() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showCreator, setShowCreator] = useState(false);
  const [creatorPrefill, setCreatorPrefill] =
    useState<ModuleChartPrefill | null>(null);
  const [suggestionError, setSuggestionError] = useState("");
  const [showAi, setShowAi] = useState(false);
  const [chartMetadataById, setChartMetadataById] = useState<Record<number, ChartFilterMetadata>>({});
  const [dashboardFilters, setDashboardFilters] = useState<DashboardFilter[]>([]);
  // V0.27：全局日期范围筛选（只对有日期 xField 的折线/面积图生效）
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const chartsQuery = useQuery({
    queryKey: ["charts"],
    queryFn: async () => {
      const r: any = await api.get("/board/charts");
      return (r.data as BoardChart[]).filter(
        (chart) => !isRetiredModuleCode(chart.moduleCode),
      );
    },
    retry: false,
  });
  const { data: charts } = chartsQuery;

  // V0.27：拉模块列表，按模块分组展示图表（不同模块的图不混在一起）
  const modulesQuery = useQuery({
    queryKey: ["modules"],
    queryFn: async () => {
      const r: any = await api.get("/modules");
      return filterRetiredModules(r.data as ModuleData[]);
    },
    retry: false,
  });
  const { data: modules } = modulesQuery;

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/board/charts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["charts"] }),
  });

  const groups = useMemo(
    () => groupChartsByModule(charts ?? [], modules ?? []),
    [charts, modules],
  );
  const activeModules = (modules ?? []).filter((module) => module.enabled);
  const requestedModuleCode = searchParams.get("module");
  const selectedModuleCode = requestedModuleCode == null
    ? resolveDefaultModuleCode(groups)
    : resolveSelectedModuleCode(
        requestedModuleCode,
        modules ?? [],
        charts ?? [],
      );
  const visibleGroups = filterModuleGroups(groups, selectedModuleCode);
  const moduleFilterOptions = buildModuleFilterOptions(groups, modules ?? []);
  const selectedMemberCodes = useMemo(
    () => selectedModuleCode === "all"
      ? []
      : groups.find((group) => group.code === selectedModuleCode)?.moduleCodes
        ?? moduleCodesForSelection(selectedModuleCode, modules ?? []),
    [groups, modules, selectedModuleCode],
  );
  const selectedModule =
    selectedMemberCodes.length !== 1
      ? undefined
      : activeModules.find((module) => module.code === selectedMemberCodes[0]);
  const selectedSuggestions = fieldSuggestionsForSelection(
    selectedModuleCode,
    modules ?? [],
  );
  const dashboardSlicers = useMemo(
    () => buildDashboardSlicers(
      Object.values(chartMetadataById),
      selectedModuleCode,
      10,
      selectedMemberCodes,
    ),
    [chartMetadataById, selectedMemberCodes, selectedModuleCode],
  );
  const boardLoadState = buildBoardLoadState({
    chartsPending: chartsQuery.isPending,
    modulesPending: modulesQuery.isPending,
    chartsError: chartsQuery.error,
    modulesError: modulesQuery.error,
  });

  useEffect(() => {
    const chartIds = new Set((charts ?? []).map((chart) => chart.id));
    setChartMetadataById((current) => Object.fromEntries(
      Object.entries(current).filter(([chartId]) => chartIds.has(Number(chartId))),
    ));
  }, [charts]);

  useEffect(() => {
    setDashboardFilters((current) => current.filter((filter) =>
      dashboardSlicers.some(
        (slicer) => slicer.moduleCode === filter.moduleCode && slicer.field === filter.field,
      ),
    ));
  }, [dashboardSlicers]);

  const recordChartMetadata = useCallback((metadata: ChartFilterMetadata) => {
    setChartMetadataById((current) => {
      const previous = current[metadata.chartId];
      if (JSON.stringify(previous) === JSON.stringify(metadata)) return current;
      return { ...current, [metadata.chartId]: metadata };
    });
  }, []);

  const selectDashboardFilter = useCallback((filter: DashboardFilter) => {
    const shared = dashboardSlicers.some(
      (slicer) => slicer.moduleCode === filter.moduleCode && slicer.field === filter.field,
    );
    if (!shared) return;
    setDashboardFilters((current) => upsertDashboardFilter(current, filter));
  }, [dashboardSlicers]);

  function selectModule(code: "all" | string) {
    const next = new URLSearchParams(searchParams);
    next.set("module", code);
    setSearchParams(next, { replace: true });
    setSuggestionError("");
    setDashboardFilters([]);
  }

  function openManualCreator() {
    setCreatorPrefill(null);
    setShowCreator(true);
  }

  function openSuggestionCreator(
    module: ModuleData,
    suggestion: ModuleFieldSuggestion,
  ) {
    try {
      setCreatorPrefill(buildModuleSuggestionPrefill(module, suggestion));
      setSuggestionError("");
      setShowCreator(true);
    } catch {
      setSuggestionError("该字段建议暂时无法创建，请刷新模块配置后重试。");
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col items-start justify-between gap-3 sm:flex-row">
        <div>
          <h1 className="text-2xl font-semibold">经营驾驶舱</h1>
          <p className="text-text-muted text-sm mt-1">
            按业务模块集中查看核心指标，筛选条件会联动共享同一维度的图表
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => qc.invalidateQueries({ queryKey: ["chart-render"] })}
            className="flex items-center gap-1.5 px-3 py-2 border text-sm rounded-md hover:bg-bg-subtle transition"
            title="重新读取全部图表数据"
          >
            <RefreshCw size={14} />
            刷新全部
          </button>
          <button
            onClick={() => setShowAi(true)}
            className="flex items-center gap-2 px-3.5 py-2 bg-morandi-3 text-white text-sm rounded-md hover:opacity-90 transition"
          >
            <Sparkles size={16} />
            AI 出图
          </button>
          <button
            onClick={openManualCreator}
            className="flex items-center gap-2 px-3.5 py-2 bg-morandi-2 text-white text-sm rounded-md hover:opacity-90 transition"
          >
            <Plus size={16} />
            新建图表
          </button>
        </div>
      </header>

      {boardLoadState.status === "loading" && (
        <div className="text-text-muted text-sm" role="status">正在加载看板…</div>
      )}

      {boardLoadState.status === "error" && (
        <div className="card flex flex-col items-start gap-3 border-morandi-rose/30 bg-morandi-rose/5 p-4" role="alert">
          <div className="flex items-start gap-2 text-sm text-text-secondary">
            <AlertTriangle size={17} className="mt-0.5 shrink-0 text-morandi-rose" />
            <span>{boardLoadState.message}</span>
          </div>
          <button
            type="button"
            onClick={() => void retryBoardQueries(chartsQuery.refetch, modulesQuery.refetch)}
            disabled={chartsQuery.isFetching || modulesQuery.isFetching}
            className="inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw size={15} className={cn((chartsQuery.isFetching || modulesQuery.isFetching) && "animate-spin")} />
            {chartsQuery.isFetching || modulesQuery.isFetching ? "正在重试…" : "重新加载"}
          </button>
        </div>
      )}

      {boardLoadState.status === "ready" && modules && (
        <section className="card space-y-4 p-4" aria-labelledby="dashboard-filter-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <SlidersHorizontal size={16} className="text-morandi-3" />
              <h2 id="dashboard-filter-title" className="text-sm font-medium">联动筛选</h2>
            </div>
            {(dashboardFilters.length > 0 || dateFrom || dateTo) && (
              <button
                type="button"
                onClick={() => {
                  setDashboardFilters([]);
                  setDateFrom("");
                  setDateTo("");
                }}
                className="inline-flex min-h-9 items-center gap-1 rounded-md px-2.5 text-xs text-text-secondary hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40"
              >
                <X size={13} />
                清除全部
              </button>
            )}
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-text-muted">业务模块</div>
            <div role="group" aria-label="按业务模块筛选图表" className="flex max-w-full flex-wrap gap-2">
              <ModuleFilterChip
                label="全部模块"
                count={charts?.length ?? 0}
                selected={selectedModuleCode === "all"}
                onSelect={() => selectModule("all")}
              />
              {moduleFilterOptions.map((module) => {
                return (
                  <ModuleFilterChip
                    key={module.code}
                    label={module.name}
                    count={module.count}
                    selected={selectedModuleCode === module.code}
                    onSelect={() => selectModule(module.code)}
                  />
                );
              })}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
            <div className="grid gap-4 md:grid-cols-2">
              {dashboardSlicers.map((slicer) => {
                const active = dashboardFilters.find(
                  (filter) => filter.moduleCode === slicer.moduleCode && filter.field === slicer.field,
                );
                const moduleName = groups.find(
                  (group) => group.moduleCodes.includes(slicer.moduleCode),
                )?.name;
                return (
                  <div key={slicer.key} className="space-y-2">
                    <div className="flex items-center gap-2 text-xs text-text-muted">
                      <span className="font-medium text-text-secondary">
                        {selectedModuleCode === "all" && moduleName ? `${moduleName} · ` : ""}{slicer.label}
                      </span>
                      <span>联动 {slicer.chartCount} 张图</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5" role="group" aria-label={`${slicer.label}切片器`}>
                      <button
                        type="button"
                        aria-pressed={!active}
                        onClick={() => setDashboardFilters((current) => current.filter(
                          (filter) => filter.moduleCode !== slicer.moduleCode || filter.field !== slicer.field,
                        ))}
                        className={cn(
                          "min-h-9 rounded-md border px-3 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40",
                          !active ? "border-transparent bg-morandi-3 text-white" : "bg-bg-card text-text-secondary hover:bg-bg-subtle",
                        )}
                      >
                        全部
                      </button>
                      {slicer.values.map((value) => (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={active?.value === value}
                          onClick={() => selectDashboardFilter({
                            moduleCode: slicer.moduleCode,
                            field: slicer.field,
                            fieldLabel: slicer.label,
                            value,
                          })}
                          className={cn(
                            "min-h-9 max-w-[180px] truncate rounded-md border px-3 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40",
                            active?.value === value
                              ? "border-transparent bg-morandi-2 text-white"
                              : "bg-bg-card text-text-secondary hover:bg-bg-subtle",
                          )}
                          title={value}
                        >
                          {value}
                        </button>
                      ))}
                      {slicer.truncated && <span className="self-center text-xs text-text-muted">仅显示前 10 项</span>}
                    </div>
                  </div>
                );
              })}
              {dashboardSlicers.length === 0 && charts && charts.length > 0 && (
                <div className="text-xs text-text-muted">当前图表尚无可共享的分类维度</div>
              )}
            </div>

            {charts && charts.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-text-muted">日期范围</div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="date"
                    aria-label="开始日期"
                    value={dateFrom}
                    onChange={(event) => setDateFrom(event.target.value)}
                    className="min-h-9 rounded-md border bg-bg-card px-2 text-sm outline-none focus:border-morandi-slate"
                  />
                  <span className="text-xs text-text-muted">至</span>
                  <input
                    type="date"
                    aria-label="结束日期"
                    value={dateTo}
                    onChange={(event) => setDateTo(event.target.value)}
                    className="min-h-9 rounded-md border bg-bg-card px-2 text-sm outline-none focus:border-morandi-slate"
                  />
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {boardLoadState.status === "ready" && selectedModule && (
        <ModuleFieldSuggestions
          module={selectedModule}
          suggestions={selectedSuggestions}
          onCreate={(suggestion) =>
            openSuggestionCreator(selectedModule, suggestion)
          }
          error={suggestionError}
        />
      )}

      {boardLoadState.status === "ready" && charts && charts.length === 0 && (
        <div className="card border-dashed text-center py-16">
          <BarChart3 size={32} className="mx-auto text-text-muted mb-2" />
          <div className="text-sm text-text-muted">还没有图表</div>
          <button
            onClick={openManualCreator}
            className="mt-3 rounded text-sm text-morandi-slate hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40"
          >
            点击新建第一张
          </button>
        </div>
      )}

      {boardLoadState.status === "ready" && charts && charts.length > 0 && (
        visibleGroups.length > 0 ? (
          <div className="space-y-6">
            {visibleGroups.map((group) => (
              <section key={group.code || "unclassified"}>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <div className="h-4 w-1 rounded bg-morandi-slate" />
                    <h2 className="text-sm font-medium text-text-secondary">{group.name}</h2>
                    <span className="text-xs text-text-muted">{group.charts.length} 张</span>
                  </div>
                  {group.demo && (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
                      <span className="inline-flex items-center gap-1.5 font-medium text-text-secondary">
                        <Database size={13} />
                        合成演示数据
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <CalendarDays size={13} />
                        {group.charts[0]?.config.periodFrom} 至 {group.charts[0]?.config.periodTo}
                      </span>
                      <span>{(group.charts[0]?.config.rowCount ?? 0).toLocaleString("zh-CN")} 条经营记录</span>
                    </div>
                  )}
                </div>
                <div className="grid min-w-0 grid-cols-12 gap-4">
                  {group.charts.map((chart) => (
                    <div key={chart.id} className={chartGridClass(chart)}>
                      <ChartCard
                        chart={chart}
                        module={activeModules.find(
                          (module) => module.code === chart.moduleCode,
                        )}
                        onDelete={() => deleteMut.mutate(chart.id)}
                        dateFrom={dateFrom}
                        dateTo={dateTo}
                        dashboardFilters={dashboardFilters}
                        onFilterSelect={selectDashboardFilter}
                        onMetadata={recordChartMetadata}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="card border-dashed py-10 text-center text-sm text-text-muted">
            该模块还没有图表，可从上方字段建议创建。
          </div>
        )
      )}

      {showCreator && (
        <ChartCreator
          prefill={creatorPrefill ?? undefined}
          onClose={() => {
            setShowCreator(false);
            setCreatorPrefill(null);
          }}
          onSuccess={() => {
            setShowCreator(false);
            setCreatorPrefill(null);
            qc.invalidateQueries({ queryKey: ["charts"] });
          }}
        />
      )}

      {showAi && (
        <AiChartModal
          onClose={() => setShowAi(false)}
          onSuccess={() => {
            setShowAi(false);
            qc.invalidateQueries({ queryKey: ["charts"] });
          }}
        />
      )}
    </div>
  );
}

function ModuleFilterChip({
  label,
  count,
  selected,
  onSelect,
}: {
  label: string;
  count: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "inline-flex min-h-10 max-w-full items-center gap-2 rounded-md border px-3.5 py-2 text-sm transition",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40",
        selected
          ? "border-transparent bg-morandi-3 text-white"
          : "bg-bg-card text-text-secondary hover:bg-bg-subtle",
      )}
    >
      <span className="truncate">{label}</span>
      <span
        aria-label={`${count} 张图表`}
        className={cn(
          "min-w-5 rounded-full px-1.5 py-0.5 text-center text-xs",
          selected ? "bg-white/20 text-white" : "bg-bg-subtle text-text-muted",
        )}
      >
        {count}
      </span>
    </button>
  );
}

function ModuleFieldSuggestions({
  module,
  suggestions,
  onCreate,
  error,
}: {
  module: ModuleData;
  suggestions: ModuleFieldSuggestion[];
  onCreate: (suggestion: ModuleFieldSuggestion) => void;
  error: string;
}) {
  if (!suggestions.length && !error) return null;

  const fieldLabel = (fieldName: string) =>
    fieldName === "count"
      ? "记录数"
      : module.columns.find((column) => column.name === fieldName)?.label ??
        fieldName;

  return (
    <section
      aria-labelledby="module-field-suggestions-title"
      className="card space-y-3 p-4"
    >
      <div>
        <h2
          id="module-field-suggestions-title"
          className="text-sm font-medium text-text-primary"
        >
          {module.name} · 字段分析建议
        </h2>
        <p className="mt-1 text-xs text-text-muted">
          新增字段可用于分析。系统只提供建议，确认后才会创建图表。
        </p>
      </div>
      {error && (
        <div
          role="alert"
          className="rounded-md border border-morandi-rose/30 bg-morandi-rose/5 px-3 py-2 text-xs text-morandi-rose"
        >
          {error}
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {suggestions.map((suggestion) => (
            <div
              key={suggestion.key}
              className="flex flex-col gap-3 rounded-md border px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-text-primary">
                  {suggestion.label}
                </div>
                <div className="mt-1 text-xs text-text-muted">
                  维度：{fieldLabel(suggestion.dimension)} · 指标：
                  {fieldLabel(suggestion.metric)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onCreate(suggestion)}
                className="inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-md bg-morandi-3 px-3 py-1.5 text-xs text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40"
              >
                <Plus size={13} />
                创建图表
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ChartCard({
  chart,
  module,
  onDelete,
  dateFrom,
  dateTo,
  dashboardFilters,
  onFilterSelect,
  onMetadata,
}: {
  chart: BoardChart;
  module?: ModuleData;
  onDelete: () => void;
  dateFrom?: string;
  dateTo?: string;
  dashboardFilters: DashboardFilter[];
  onFilterSelect: (filter: DashboardFilter) => void;
  onMetadata: (metadata: ChartFilterMetadata) => void;
}) {
  const Icon = TYPE_ICONS[chart.chartType];
  const qc = useQueryClient();
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: chartRenderQueryKey({
      chartId: chart.id,
      datasetId: chart.datasetId,
      dateField: chart.config?.dateField ?? chart.config?.xField ?? "",
      dateFrom,
      dateTo,
    }),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (dateFrom) params.set("from", dateFrom);
      if (dateTo) params.set("to", dateTo);
      const qs = params.toString();
      const r: any = await api.get(`/board/charts/${chart.id}/render${qs ? `?${qs}` : ""}`);
      return requireCompleteChartRenderData(r.data);
    },
    retry: false,
  });

  function refresh() {
    qc.invalidateQueries({ queryKey: ["chart-render", chart.id] });
  }

  const fieldLabels = useMemo(
    () => ({
      ...Object.fromEntries(
        (module?.columns ?? [])
          .filter((column) => column.label)
          .map((column) => [column.name, column.label!]),
      ),
      ...(chart.config?.fieldLabels ?? {}),
    }),
    [chart.config?.fieldLabels, module?.columns],
  );

  useEffect(() => {
    if (!data) return;
    onMetadata(chartFilterMetadata(chart, data.rows, fieldLabels));
  }, [chart, data, fieldLabels, onMetadata]);

  const filteredRows = useMemo(
    () => applyDashboardFilters(data?.rows ?? [], chart.moduleCode, dashboardFilters),
    [chart.moduleCode, dashboardFilters, data?.rows],
  );

  const linked = dashboardFilters.some((filter) =>
    filter.moduleCode === (chart.moduleCode || "unclassified")
    && data?.rows.some((row) => Object.prototype.hasOwnProperty.call(row, filter.field)),
  );

  const option = data
    ? buildOption(
        {
          chartType: chart.chartType,
          title: chart.config?.title || chart.name,
          xField: chart.config?.xField,
          yFields: chart.config?.yFields,
          seriesField: chart.config?.seriesField,
          fieldLabels,
          showTitle: false,
          benchmarkField: chart.config?.benchmarkField,
          comparisonLabel: chart.config?.comparisonLabel,
          valueMode: chart.config?.valueMode,
          targetValue: chart.config?.targetValue,
          valuePrefix: chart.config?.valuePrefix,
          valueSuffix: chart.config?.valueSuffix,
          valueDecimals: chart.config?.valueDecimals,
          valueLabel: chart.config?.valueLabel,
          pointField: chart.config?.pointField,
          sizeField: chart.config?.sizeField,
        },
        filteredRows,
      )
    : null;

  return (
    <div className="card group h-full min-w-0 overflow-hidden p-0 transition hover:shadow-md">
      <div className="px-5 py-3.5 border-b flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-morandi-slate text-white">
            <Icon size={14} />
          </div>
          <div className="min-w-0">
            <div className="truncate font-medium text-sm" title={chart.name}>{chart.name}</div>
            <div className="truncate text-xs text-text-muted" title={chart.config?.subtitle}>
              {chart.config?.subtitle || `${TYPE_LABELS[chart.chartType]} · 数据集 ${chart.datasetId}`}
              {linked && <span className="ml-2 text-morandi-slate">已联动</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            onClick={refresh}
            disabled={isFetching}
            title="刷新图表数据"
            className="rounded p-1.5 text-text-muted transition hover:text-morandi-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40 disabled:opacity-40"
          >
            {isFetching ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
          </button>
          <button
            onClick={() => {
              if (confirm(`删除「${chart.name}」？`)) onDelete();
            }}
            title="删除"
            className="rounded p-1.5 text-text-muted transition hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <div className="p-4">
        {isLoading && <div style={{ height: chartCanvasHeight(chart) }} className="flex items-center justify-center text-sm text-text-muted">加载中…</div>}
        {!isLoading && error && (
          <div style={{ height: chartCanvasHeight(chart) }} className="flex flex-col items-center justify-center gap-3 px-8 text-center" role="alert">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-amber-50 text-amber-700">
              <AlertTriangle size={19} />
            </span>
            <div>
              <div className="text-sm font-medium text-text-primary">这张图表暂时无法显示</div>
              <div className="mt-1 max-w-md text-xs leading-6 text-text-muted">
                {chartRenderErrorMessage(error)}
              </div>
            </div>
            <button
              type="button"
              onClick={refresh}
              disabled={isFetching}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs text-text-secondary transition hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40 disabled:opacity-50"
            >
              {isFetching ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              重新加载
            </button>
          </div>
        )}
        {!isLoading && !error && chart.chartType === "table" && filteredRows.length > 0 && (
          <div className="max-h-96 overflow-auto rounded-md border">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead className="sticky top-0 bg-bg-subtle text-text-muted">
                <tr>
                  {(chart.config?.columnOrder ?? Object.keys(filteredRows[0]))
                    .filter((column) => Object.prototype.hasOwnProperty.call(filteredRows[0], column))
                    .map((column) => (
                    <th key={column} className="whitespace-nowrap border-b px-3 py-2 font-medium">
                      {fieldLabels[column] || column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.slice(0, 100).map((row, rowIndex) => (
                  <tr key={rowIndex} className="border-b last:border-b-0">
                    {(chart.config?.columnOrder ?? Object.keys(filteredRows[0]))
                      .filter((column) => Object.prototype.hasOwnProperty.call(filteredRows[0], column))
                      .map((column) => (
                      <td key={column} className="max-w-[240px] truncate px-3 py-2 text-text-secondary" title={formatChartCategoryValue(row[column] ?? "")}>
                        {formatChartCategoryValue(row[column] ?? "-")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!isLoading && option && (
          <CrispEChart
            option={option}
            style={{ height: chartCanvasHeight(chart) }}
            notMerge
            lazyUpdate
            aria-label={`${chart.name}图表`}
            onEvents={{
              click: (params: any) => {
                const next = filterFromChartClick(chart, params, fieldLabels);
                if (next) onFilterSelect(next);
              },
            }}
          />
        )}
        {!isLoading && data && filteredRows.length === 0 && !error && (
          <div style={{ height: chartCanvasHeight(chart) }} className="flex items-center justify-center text-sm text-text-muted">
            当前联动条件下没有数据
          </div>
        )}
      </div>
    </div>
  );
}
