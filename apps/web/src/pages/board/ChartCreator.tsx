import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AreaChart,
  BadgeDollarSign,
  BarChart3,
  Combine,
  LineChart as LineIcon,
  PieChart,
  Play,
  Save,
  Table2,
  X,
} from "lucide-react";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ModuleChartPrefill } from "./module-groups";
import { semanticColumnAlias } from "./module-groups";
import {
  buildChartCreatePayload,
  createChartCreatorInitialState,
} from "./chart-creator-model";

type SemanticModel = {
  id: string;
  version: number;
  moduleCode: string;
  moduleName: string;
  metrics: Array<{
    id: string;
    label: string;
    aggregation: "sum" | "average" | "count" | "min" | "max" | "ratio";
    unit: "number" | "currency" | "percent" | "quantity";
    additiveAcrossTime: boolean;
  }>;
  dimensions: Array<{
    id: string;
    label: string;
    kind: "categorical" | "time";
  }>;
};

const TYPES = [
  { code: "bar", label: "柱状图", icon: BarChart3 },
  { code: "horizontal_bar", label: "横向排行", icon: BarChart3 },
  { code: "stacked_bar", label: "堆叠柱图", icon: BarChart3 },
  { code: "line", label: "折线图", icon: LineIcon },
  { code: "area", label: "面积图", icon: AreaChart },
  { code: "pie", label: "饼图", icon: PieChart },
  { code: "combo", label: "组合图", icon: Combine },
  { code: "kpi", label: "指标卡", icon: BadgeDollarSign },
  { code: "table", label: "汇总表", icon: Table2 },
] as const;

function responseMessage(error: any, fallback: string): string {
  return error?.response?.data?.message || error?.message || fallback;
}

export function ChartCreator({
  onClose,
  onSuccess,
  prefill,
}: {
  onClose: () => void;
  onSuccess: () => void;
  prefill?: ModuleChartPrefill;
}) {
  const initial = createChartCreatorInitialState(prefill);
  const [step, setStep] = useState<"semantic" | "config">("semantic");
  const [modelId, setModelId] = useState(initial.modelId);
  const [metricIds, setMetricIds] = useState<string[]>(initial.metricIds);
  const [dimensionIds, setDimensionIds] = useState<string[]>(initial.dimensionIds);
  const [previewRows, setPreviewRows] = useState<any[] | null>(null);
  const [previewCols, setPreviewCols] = useState<string[]>([]);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [datasetName, setDatasetName] = useState(initial.datasetName);
  const [chartName, setChartName] = useState(initial.chartName);
  const [chartType, setChartType] = useState(initial.chartType);

  const { data: models = [], isLoading: modelsLoading } = useQuery({
    queryKey: ["semantic-models"],
    queryFn: async () => {
      const response: any = await api.get("/semantic/models");
      return response.data.models as SemanticModel[];
    },
  });

  useEffect(() => {
    if (!modelId && models.length > 0) setModelId(models[0].id);
  }, [modelId, models]);

  const selectedModel = models.find((model) => model.id === modelId);
  const semanticQuery = useMemo(() => selectedModel
    ? {
        modelId: selectedModel.id,
        modelVersion: selectedModel.version,
        metricIds,
        dimensionIds,
        filters: [],
        limit: 200,
      }
    : null, [dimensionIds, metricIds, selectedModel]);

  const xField = dimensionIds[0]
    ? semanticColumnAlias(dimensionIds[0], "dimension", 0)
    : "";
  const seriesField = dimensionIds[1]
    ? semanticColumnAlias(dimensionIds[1], "dimension", 1)
    : "";
  const yFields = metricIds.map((id, index) => semanticColumnAlias(id, "metric", index));

  const previewMut = useMutation({
    mutationFn: async () => {
      if (!semanticQuery) throw new Error("请选择语义模型");
      const response: any = await api.post("/semantic/query", semanticQuery);
      return response.data as {
        rows: any[];
        columns: Array<{ alias: string }>;
      };
    },
    onSuccess: (data) => {
      setPreviewRows(data.rows);
      setPreviewCols(data.columns.map((column) => column.alias));
      setPreviewErr(null);
    },
    onError: (error) => {
      setPreviewErr(responseMessage(error, "指标查询失败"));
      setPreviewRows(null);
      setPreviewCols([]);
    },
  });

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!semanticQuery || !selectedModel) throw new Error("语义模型不完整");
      const chart = buildChartCreatePayload(1, {
        chartName,
        chartType,
        xField,
        yFields,
        seriesField,
        modelId: selectedModel.id,
        modelVersion: selectedModel.version,
        metricIds,
        dimensionIds,
      }, prefill);
      const { datasetId: _datasetId, ...chartWithoutDatasetId } = chart;
      await api.post("/board/chart-bundles", {
        dataset: {
          name: datasetName,
          queryType: "semantic",
          queryText: JSON.stringify(semanticQuery),
        },
        chart: {
          ...chartWithoutDatasetId,
          moduleCode: selectedModel.moduleCode,
        },
      });
    },
    onSuccess,
  });

  function chooseModel(nextId: string) {
    setModelId(nextId);
    setMetricIds([]);
    setDimensionIds([]);
    setPreviewRows(null);
    setPreviewCols([]);
  }

  function toggleMetric(id: string) {
    setMetricIds((current) => current.includes(id)
      ? current.filter((candidate) => candidate !== id)
      : [...current.slice(0, 5), id]);
    setPreviewRows(null);
  }

  function toggleDimension(id: string) {
    setDimensionIds((current) => current.includes(id)
      ? current.filter((candidate) => candidate !== id)
      : [...current.slice(0, 2), id]);
    setPreviewRows(null);
  }

  const requiresDimension = !["kpi"].includes(chartType);
  const firstDimension = selectedModel?.dimensions.find((dimension) => dimension.id === dimensionIds[0]);
  const trendDimensionValid = !["line", "area"].includes(chartType)
    || firstDimension?.kind === "time";
  const stackedShapeValid = chartType !== "stacked_bar"
    || metricIds.length >= 2
    || dimensionIds.length >= 2;
  const canPreview = !!selectedModel && metricIds.length > 0;
  const canSave = !!previewRows?.length
    && (!requiresDimension || dimensionIds.length > 0)
    && trendDimensionValid
    && stackedShapeValid
    && (chartType !== "pie" || (metricIds.length === 1 && dimensionIds.length === 1))
    && (chartType !== "combo" || metricIds.length === 2);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="chart-creator-title"
        className="flex max-h-[90vh] w-[860px] max-w-full flex-col rounded-lg bg-bg-card shadow-2xl"
      >
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <div id="chart-creator-title" className="font-medium">新建图表</div>
            <div className="mt-0.5 text-xs text-text-muted">
              步骤 {step === "semantic" ? "1" : "2"} / 2 · {step === "semantic" ? "选择指标 ID 与维度 ID" : "配置展示"}
            </div>
          </div>
          <button onClick={onClose} aria-label="关闭新建图表" className="text-text-muted hover:text-text-primary">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-auto px-6 py-5">
          {step === "semantic" && (
            <>
              <div className="rounded-md border bg-bg-subtle px-4 py-3 text-xs leading-5 text-text-muted">
                图表只保存版本化指标/维度合同。物理表、字段和聚合方式由服务端语义模型管理。
              </div>
              <Field label="语义模型">
                <select
                  value={modelId}
                  onChange={(event) => chooseModel(event.target.value)}
                  disabled={modelsLoading || !!prefill}
                  className="w-full rounded-md border px-3 py-2 focus:outline-none focus:border-morandi-slate"
                >
                  <option value="">请选择</option>
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.moduleName} · {model.id} @ v{model.version}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="指标（最多 6 个）">
                <div className="flex flex-wrap gap-2">
                  {selectedModel?.metrics.map((metric) => (
                    <button
                      key={metric.id}
                      type="button"
                      onClick={() => toggleMetric(metric.id)}
                      className={cn(
                        "rounded-md border px-3 py-1.5 text-left text-sm transition",
                        metricIds.includes(metric.id) ? "border-transparent bg-morandi-1 text-white" : "hover:bg-bg-subtle",
                      )}
                      title={`${metric.id} · ${metric.aggregation}`}
                    >
                      {metric.label} <span className="text-[10px] opacity-70">{metric.id}</span>
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="维度（最多 3 个，可不选）">
                <div className="flex flex-wrap gap-2">
                  {selectedModel?.dimensions.map((dimension) => (
                    <button
                      key={dimension.id}
                      type="button"
                      onClick={() => toggleDimension(dimension.id)}
                      className={cn(
                        "rounded-md border px-3 py-1.5 text-left text-sm transition",
                        dimensionIds.includes(dimension.id) ? "border-transparent bg-morandi-2 text-white" : "hover:bg-bg-subtle",
                      )}
                      title={`${dimension.id} · ${dimension.kind}`}
                    >
                      {dimension.label} <span className="text-[10px] opacity-70">{dimension.id}</span>
                    </button>
                  ))}
                </div>
              </Field>
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">
                  {selectedModel ? `${selectedModel.id} @ v${selectedModel.version}` : "尚未选择模型"}
                </span>
                <button
                  onClick={() => previewMut.mutate()}
                  disabled={!canPreview || previewMut.isPending}
                  className="flex items-center gap-1.5 rounded-md bg-morandi-3 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                >
                  <Play size={14} /> {previewMut.isPending ? "查询中…" : "验证并预览"}
                </button>
              </div>
              {previewErr && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{previewErr}</div>}
              {previewRows && previewRows.length > 0 && (
                <div className="max-h-72 overflow-auto rounded-md border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-bg-subtle">
                      <tr>{previewCols.map((column) => <th key={column} className="px-3 py-1.5 text-left font-medium">{column}</th>)}</tr>
                    </thead>
                    <tbody>
                      {previewRows.map((row, index) => (
                        <tr key={index} className="border-t">
                          {previewCols.map((column) => <td key={column} className="px-3 py-1.5">{String(row[column] ?? "-")}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {step === "config" && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <Field label="数据集名称"><input value={datasetName} onChange={(event) => setDatasetName(event.target.value)} className="w-full rounded-md border px-3 py-2" /></Field>
                <Field label="图表名称"><input value={chartName} onChange={(event) => setChartName(event.target.value)} className="w-full rounded-md border px-3 py-2" /></Field>
              </div>
              <Field label="图表类型">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {TYPES.map((type) => (
                    <button
                      key={type.code}
                      type="button"
                      onClick={() => setChartType(type.code)}
                      className={cn(
                        "flex min-h-10 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm",
                        chartType === type.code ? "border-transparent bg-morandi-2 text-white" : "hover:bg-bg-subtle",
                      )}
                    >
                      <type.icon size={14} /> {type.label}
                    </button>
                  ))}
                </div>
              </Field>
              <div className="rounded-md border bg-bg-subtle px-4 py-3 text-xs leading-6 text-text-muted">
                <div>模型：{selectedModel?.id} @ v{selectedModel?.version}</div>
                <div>指标：{metricIds.join("、")}</div>
                <div>维度：{dimensionIds.join("、") || "无（汇总）"}</div>
                {requiresDimension && dimensionIds.length === 0 && <div className="text-red-600">当前图表类型需要至少一个维度。</div>}
                {!trendDimensionValid && <div className="text-red-600">趋势图的第一个维度必须是时间维度。</div>}
                {!stackedShapeValid && <div className="text-red-600">堆叠柱图至少需要两个指标或两个维度。</div>}
                {chartType === "pie" && (metricIds.length !== 1 || dimensionIds.length !== 1) && <div className="text-red-600">饼图必须使用一个指标和一个维度。</div>}
                {chartType === "combo" && metricIds.length !== 2 && <div className="text-red-600">组合图需要两个指标。</div>}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-between border-t px-6 py-4">
          <button onClick={onClose} className="rounded-md border px-4 py-2 text-sm hover:bg-bg-subtle">取消</button>
          <div className="flex gap-2">
            {step === "config" && <button onClick={() => setStep("semantic")} className="rounded-md border px-4 py-2 text-sm">← 返回</button>}
            {step === "semantic" && (
              <button disabled={!previewRows?.length} onClick={() => setStep("config")} className="rounded-md bg-morandi-2 px-4 py-2 text-sm text-white disabled:opacity-50">下一步 →</button>
            )}
            {step === "config" && (
              <button disabled={!canSave || saveMut.isPending} onClick={() => saveMut.mutate()} className="flex items-center gap-1.5 rounded-md bg-morandi-1 px-4 py-2 text-sm text-white disabled:opacity-50">
                <Save size={14} /> {saveMut.isPending ? "保存中…" : "保存图表"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm text-text-secondary">{label}</label>
      {children}
    </div>
  );
}
