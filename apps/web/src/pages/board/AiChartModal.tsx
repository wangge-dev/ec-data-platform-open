import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CrispEChart } from "@/components/charts/CrispEChart";
import {
  X, Sparkles, Save, Loader2, AlertTriangle, RefreshCw, Filter,
  BarChart3, LineChart as LineIcon, AreaChart, PieChart, Radar, Combine, Table2, BadgeDollarSign, Gauge, Grid3X3, PanelsTopLeft,
} from "lucide-react";
import { api, apiLong } from "@/lib/api";
import { filterRetiredModules } from "@/pages/module/types";
import { buildOption, type ChartSpec, type ChartType } from "./chart-option";
import { cn } from "@/lib/utils";

const TYPES: { code: ChartType; label: string; icon: any }[] = [
  { code: "bar", label: "柱状", icon: BarChart3 },
  { code: "horizontal_bar", label: "横向排行", icon: BarChart3 },
  { code: "stacked_bar", label: "堆叠柱", icon: BarChart3 },
  { code: "line", label: "折线", icon: LineIcon },
  { code: "area", label: "面积", icon: AreaChart },
  { code: "pie", label: "饼图", icon: PieChart },
  { code: "radar", label: "雷达", icon: Radar },
  { code: "combo", label: "组合", icon: Combine },
  { code: "scatter", label: "散点", icon: LineIcon },
  { code: "funnel", label: "漏斗", icon: BarChart3 },
  { code: "treemap", label: "树图", icon: PanelsTopLeft },
  { code: "heatmap", label: "热力", icon: Grid3X3 },
  { code: "gauge", label: "仪表", icon: Gauge },
  { code: "kpi", label: "指标卡", icon: BadgeDollarSign },
  { code: "table", label: "明细表", icon: Table2 },
];

type AiResult = {
  spec: ChartSpec & {
    reason: string;
    seriesField?: string;
    semanticQuery: {
      modelId: string;
      modelVersion: number;
      metricIds: string[];
      dimensionIds: string[];
      filters: unknown[];
      limit: number;
    };
    semanticModelId: string;
    semanticModelVersion: number;
    metricIds: string[];
    dimensionIds: string[];
  };
  rows: any[];
  columns: string[];
  warning: string | null;
  costCny: string;
};

const SAMPLES = ["各品牌销售额对比", "各平台销售额占比", "销售额TOP10品牌", "按付款月份看销售额趋势"];

export function AiChartModal({
  onClose,
  onSuccess,
  initialScope,
}: {
  onClose: () => void;
  onSuccess: () => void;
  initialScope?: { kind: "all" | "module" | "group" | "multi-file"; value?: string | number };
}) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AiResult | null>(null);
  const [semanticQueryText, setSemanticQueryText] = useState("");
  // 多选展开
  const [scopeOpen, setScopeOpen] = useState(false);
  // AI 只面对已发布语义模型；原始文件必须先进入模块。
  const [scopeMode, setScopeMode] = useState<"all" | "module">(
    initialScope?.kind === "module" ? "module" : "all",
  );
  // module 模式时的模块代号
  const [selectedModule, setSelectedModule] = useState(
    initialScope?.kind === "module" ? String(initialScope.value ?? "") : "",
  );
  // V0.18：模块列表（让 AI 出图能选 unified_<code> 之一作为数据上下文）
  const { data: mods } = useQuery({
    queryKey: ["modules"],
    queryFn: async () => {
      const r: any = await api.get("/modules");
      return filterRetiredModules(
        r.data as Array<{ code: string; name: string; outputTable: string; semanticModel?: unknown }>,
      ).filter((module) => module.semanticModel);
    },
  });

  function parseScope() {
    if (scopeMode === "module" && selectedModule) return { kind: "module" as const, value: selectedModule };
    return { kind: "all" as const };
  }

  const genMut = useMutation({
    mutationFn: async () => {
      const r: any = await apiLong.post("/board/ai-chart", { question, scope: parseScope() });
      return r.data as AiResult;
    },
    onSuccess: (d) => {
      setResult(d);
      setSemanticQueryText(JSON.stringify(d.spec.semanticQuery));
    },
  });

  // 重新执行服务端校验过的语义查询，不接受物理 SQL。
  const rerunMut = useMutation({
    mutationFn: async () => {
      const r: any = await api.post("/board/datasets/preview", {
        queryType: "semantic",
        queryText: semanticQueryText,
        limit: 200,
      });
      return r.data as { rows: any[]; columns: string[] };
    },
    onSuccess: (d) => {
      if (result) setResult({ ...result, rows: d.rows, columns: d.columns });
    },
  });

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!result) return;
      await api.post("/board/chart-bundles", {
        dataset: {
          name: result.spec.title,
          queryType: "semantic",
          queryText: semanticQueryText,
        },
        chart: {
          name: result.spec.title,
          chartType: result.spec.chartType,
          config: {
            aggregationMode: "none",
            title: result.spec.title,
            xField: result.spec.xField,
            yFields: result.spec.yFields,
            seriesField: result.spec.seriesField || undefined,
            semanticModelId: result.spec.semanticModelId,
            semanticModelVersion: result.spec.semanticModelVersion,
            metricIds: result.spec.metricIds,
            dimensionIds: result.spec.dimensionIds,
          },
          // V0.27：图表归属用户选的模块（scope=module 时），看板按模块分组展示
          moduleCode: scopeMode === "module" && selectedModule ? selectedModule : undefined,
        },
      });
    },
    onSuccess,
  });

  const option = result ? buildOption(result.spec, result.rows) : null;

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <div className="bg-bg-card rounded-lg w-[820px] max-w-full shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-morandi-3" />
            <span className="font-medium">AI 出图</span>
            <span className="text-xs text-text-muted">一句话选择已发布指标和维度，不生成 SQL</span>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-5 space-y-4">
          {/* 数据范围 + 提问 */}
          <div>
            <div className="mb-3">
              <div
                className="flex items-center justify-between px-3 py-2 border rounded-md cursor-pointer hover:bg-bg-subtle transition"
                onClick={() => setScopeOpen(!scopeOpen)}
              >
                <div className="flex items-center gap-2">
                  <Filter size={13} className="text-text-muted" />
                  <span className="text-xs text-text-secondary">
                    数据范围：
                    {scopeMode === "all"
                      ? "全部已发布语义模型"
                      : selectedModule
                        ? `模块：${mods?.find((m) => m.code === selectedModule)?.name ?? selectedModule}`
                        : "请选择模块"}
                  </span>
                </div>
                <span className="text-xs text-text-muted">{scopeOpen ? "▲" : "▼"}</span>
              </div>

              {scopeOpen && (
                <div className="border border-t-0 rounded-b-md px-3 py-2 max-h-[280px] overflow-y-auto">
                  {/* 全部 */}
                  <label className="flex items-center gap-2 text-xs py-1 cursor-pointer hover:bg-bg-subtle px-1 rounded">
                    <input
                      type="radio"
                      checked={scopeMode === "all"}
                      onChange={() => setScopeMode("all")}
                      className="w-3 h-3"
                    />
                    <span>全部已发布语义模型</span>
                  </label>

                  <div className="border-t my-2" />

                  {/* 按模块（V0.18） */}
                  {mods && mods.length > 0 && (
                    <>
                      <label className="flex items-center gap-2 text-xs py-1 cursor-pointer hover:bg-bg-subtle px-1 rounded">
                        <input
                          type="radio"
                          checked={scopeMode === "module"}
                          onChange={() => setScopeMode("module")}
                          className="w-3 h-3"
                        />
                        <span>按模块语义模型</span>
                      </label>

                      {scopeMode === "module" && (
                        <div className="ml-5 space-y-1 mt-1">
                          {mods.map((m) => (
                            <label
                              key={m.code}
                              className="flex items-center gap-2 text-xs py-0.5 cursor-pointer hover:bg-bg-subtle px-1 rounded"
                            >
                              <input
                                type="radio"
                                checked={selectedModule === m.code}
                                onChange={() => setSelectedModule(m.code)}
                                className="w-3 h-3"
                              />
                              <span>
                                {m.name} <code className="text-text-muted">({m.outputTable})</code>
                              </span>
                            </label>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <input
                autoFocus
                className="flex-1 px-3 py-2 border rounded-md focus:outline-none focus:border-morandi-slate"
                placeholder="例：对比各品牌的销量"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && question.trim() && !genMut.isPending) genMut.mutate();
                }}
                disabled={genMut.isPending}
              />
              <button
                onClick={() => genMut.mutate()}
                disabled={genMut.isPending || !question.trim()}
                className="flex items-center gap-1.5 px-4 py-2 text-sm bg-morandi-3 text-white rounded-md hover:opacity-90 disabled:opacity-50 transition shrink-0"
              >
                {genMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {genMut.isPending ? "生成中…" : "生成"}
              </button>
            </div>
            {!result && !genMut.isPending && (
              <div className="flex gap-2 mt-2 flex-wrap">
                {SAMPLES.map((s) => (
                  <button
                    key={s}
                    onClick={() => setQuestion(s)}
                    className="text-xs px-2.5 py-1 bg-bg-subtle rounded-md text-text-secondary hover:text-text-primary transition"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {genMut.isError && (
              <div className="mt-2 px-3 py-2 bg-red-50 text-red-700 text-sm rounded-md">
                {(genMut.error as any)?.message || "生成失败，换个问法试试"}
              </div>
            )}
          </div>

          {/* 结果 */}
          {result && (
            <div className="space-y-3">
              {result.spec.reason && (
                <div className="text-sm text-text-secondary bg-bg-subtle rounded-md px-3 py-2">
                  💡 {result.spec.reason}
                </div>
              )}
              {result.warning && (
                <div className="flex items-start gap-2 text-sm text-amber-700 bg-amber-50 rounded-md px-3 py-2">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  {result.warning}
                </div>
              )}

              {/* 图型切换：AI 选的不满意可一键换 */}
              <div className="flex gap-1.5 flex-wrap">
                {TYPES.map((t) => (
                  <button
                    key={t.code}
                    onClick={() =>
                      setResult({ ...result, spec: { ...result.spec, chartType: t.code } })
                    }
                    className={cn(
                      "flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border transition",
                      result.spec.chartType === t.code
                        ? "bg-morandi-2 text-white border-transparent"
                        : "text-text-secondary hover:bg-bg-subtle",
                    )}
                  >
                    <t.icon size={13} />
                    {t.label}
                  </button>
                ))}
              </div>

              {/* 预览 */}
              <div className="border rounded-md p-4">
                {result.spec.chartType === "table" ? (
                  <div className="max-h-[300px] overflow-auto rounded-md border">
                    <table className="w-full min-w-[560px] text-left text-xs">
                      <thead className="sticky top-0 bg-bg-subtle text-text-muted">
                        <tr>
                          {result.columns.map((column) => (
                            <th key={column} className="whitespace-nowrap border-b px-3 py-2 font-medium">
                              {column}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {result.rows.slice(0, 100).map((row, rowIndex) => (
                          <tr key={rowIndex} className="border-b last:border-b-0">
                            {result.columns.map((column) => (
                              <td
                                key={column}
                                className="max-w-[240px] truncate px-3 py-2 text-text-secondary"
                                title={String(row[column] ?? "")}
                              >
                                {String(row[column] ?? "-")}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : option ? (
                  <CrispEChart
                    option={option}
                    style={{ height: 300 }}
                    notMerge
                    lazyUpdate
                    aria-label={`${result.spec.title}图表预览`}
                  />
                ) : (
                  <div className="h-[300px] flex items-center justify-center text-text-muted text-sm">
                    无法渲染该图表类型
                  </div>
                )}
              </div>

              {/* 服务端验证过的语义查询合同 */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-sm text-text-secondary">指标/维度合同（只读）</label>
                  <button
                    onClick={() => rerunMut.mutate()}
                    disabled={rerunMut.isPending}
                    className="flex items-center gap-1 text-xs text-morandi-slate hover:underline disabled:opacity-50"
                  >
                    {rerunMut.isPending ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                    重新验证
                  </button>
                </div>
                <textarea
                  rows={3}
                  className="w-full px-3 py-2 border rounded-md font-mono text-xs focus:outline-none focus:border-morandi-slate"
                  value={semanticQueryText}
                  readOnly
                />
                {rerunMut.isError && (
                  <div className="mt-1 text-xs text-red-600">
                    {(rerunMut.error as any)?.message || "语义查询执行失败"}
                  </div>
                )}
                <div className="text-xs text-text-muted mt-1">
                  {result.rows.length} 行 · {TYPES.find((type) => type.code === result.spec.chartType)?.label ?? "图表"}
                  {result.spec.seriesField ? ` · 按 ${result.spec.seriesField} 分组` : ""} · 成本 ¥{result.costCny}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t flex justify-between items-center shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm border rounded-md hover:bg-bg-subtle transition">
            取消
          </button>
          {result && (
            <button
              onClick={() => saveMut.mutate()}
              disabled={saveMut.isPending}
              className="flex items-center gap-1.5 px-4 py-2 text-sm bg-morandi-1 text-white rounded-md hover:opacity-90 disabled:opacity-50 transition"
            >
              <Save size={14} />
              {saveMut.isPending ? "保存中…" : "保存到看板"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
