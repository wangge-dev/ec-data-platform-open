// 经营对比 - 控件区 + 图表区组件（拆出来保持单文件可读性）
import { CrispEChart } from "@/components/charts/CrispEChart";
import {
  formatBusinessNumber,
} from "@/components/charts/chart-visuals";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Calendar,
  Layers,
  BarChart3,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  buildCompareChartOption,
  type CompareChartRow,
} from "./compare-chart";

type ModuleData = {
  code: string;
  name: string;
  outputTable: string;
  timeKey?: string;
  columns: Array<{
    name: string;
    type: string;
    label?: string;
    computed?: boolean;
  }>;
  semanticModel?: {
    metrics: Array<{ id: string; label: string; aggregation: string }>;
    dimensions: Array<{ id: string; label: string; kind: "categorical" | "time" }>;
  };
};

type CompareRow = CompareChartRow;

type CompareData = {
  module: string;
  metricId: string;
  metricLabel: string;
  aggregation: string;
  dimensionId: string | null;
  dimensionLabel: string | null;
  period: string;
  baseDate: string;
  rows: CompareRow[];
};

export const PERIOD_LABEL: Record<string, string> = {
  dod: "日环比 DoD",
  wow: "周环比 WoW",
  mom: "月同比 MoM",
  yoy: "年同比 YoY",
};

const AGG_LABEL: Record<string, string> = {
  sum: "总和",
  average: "平均",
  count: "计数",
  max: "最大",
  min: "最小",
};

type ControlsProps = {
  mods: ModuleData[];
  currentMod: ModuleData | undefined;
  moduleCode: string;
  setModuleCode: (v: string) => void;
  metric: string;
  setMetric: (v: string) => void;
  dim: string;
  setDim: (v: string) => void;
  period: "dod" | "wow" | "mom" | "yoy";
  setPeriod: (v: "dod" | "wow" | "mom" | "yoy") => void;
  baseDate: string;
  setBaseDate: (v: string) => void;
  dates: string[];
  data: CompareData | undefined;
  isLoading: boolean;
  error: unknown;
};

export function ControlsAndChart(p: ControlsProps) {
  const metrics = p.currentMod?.semanticModel?.metrics ?? [];
  const dimensions = (p.currentMod?.semanticModel?.dimensions ?? []).filter(
    (dimension) => dimension.kind === "categorical",
  );

  return (
    <>
      <div className="card p-4 grid grid-cols-2 lg:grid-cols-6 gap-3 items-end">
        <div>
          <label className="text-xs text-text-muted mb-1 flex items-center gap-1">
            <Layers size={11} />
            模块
          </label>
          <select
            value={p.moduleCode}
            onChange={(e) => p.setModuleCode(e.target.value)}
            className="w-full text-sm px-2 py-1.5 border rounded-md bg-bg-card focus:outline-none focus:ring-2 focus:ring-morandi-3/30"
          >
            {p.mods.map((m) => (
              <option key={m.code} value={m.code}>{m.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs text-text-muted mb-1 block">指标</label>
          <select
            value={p.metric}
            onChange={(e) => p.setMetric(e.target.value)}
            className="w-full text-sm px-2 py-1.5 border rounded-md bg-bg-card focus:outline-none focus:ring-2 focus:ring-morandi-3/30"
          >
            {metrics.map((metric) => (
              <option key={metric.id} value={metric.id}>
                {metric.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs text-text-muted mb-1 block">聚合</label>
          <div className="w-full text-sm px-2 py-1.5 border rounded-md bg-bg-subtle text-text-muted">
            {AGG_LABEL[metrics.find((metric) => metric.id === p.metric)?.aggregation ?? ""] ?? "由指标定义"}
          </div>
        </div>

        <div>
          <label className="text-xs text-text-muted mb-1 block">维度</label>
          <select
            value={p.dim}
            onChange={(e) => p.setDim(e.target.value)}
            className="w-full text-sm px-2 py-1.5 border rounded-md bg-bg-card focus:outline-none focus:ring-2 focus:ring-morandi-3/30"
          >
            <option value="">（总计）</option>
            {dimensions.map((dimension) => (
              <option key={dimension.id} value={dimension.id}>{dimension.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs text-text-muted mb-1 block">周期</label>
          <select
            value={p.period}
            onChange={(e) => p.setPeriod(e.target.value as any)}
            className="w-full text-sm px-2 py-1.5 border rounded-md bg-bg-card focus:outline-none focus:ring-2 focus:ring-morandi-3/30"
          >
            {Object.entries(PERIOD_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs text-text-muted mb-1 flex items-center gap-1">
            <Calendar size={11} />
            基准日
          </label>
          <select
            value={p.baseDate}
            onChange={(e) => p.setBaseDate(e.target.value)}
            className="w-full text-sm px-2 py-1.5 border rounded-md bg-bg-card focus:outline-none focus:ring-2 focus:ring-morandi-3/30"
          >
            {p.dates.slice(0, 50).map((d) => {
              const ds = String(d).slice(0, 10);
              return <option key={ds} value={ds}>{ds}</option>;
            })}
          </select>
        </div>
      </div>

      {p.isLoading ? (
        <div className="card p-10 text-center text-sm text-text-muted">加载中…</div>
      ) : p.error ? (
        <div className="card p-10 text-center text-red-600 text-sm">加载失败：{String(p.error)}</div>
      ) : !p.data ? (
        <div className="card p-10 text-center text-sm text-text-muted">请选择基准日</div>
      ) : p.data.rows.length === 0 ? (
        <div className="card p-10 text-center text-sm text-text-muted">
          基准日 {p.baseDate} 没有数据
        </div>
      ) : (
        <CompareResult data={p.data} module={p.currentMod} />
      )}
    </>
  );
}

function CompareResult({
  data,
  module,
}: {
  data: CompareData;
  module: ModuleData | undefined;
}) {
  const option = buildCompareChartOption(data.rows);
  const metricLabel = data.metricLabel;
  const dimensionLabel = data.dimensionLabel ?? "总计";

  const totalCur = data.rows.reduce((s, r) => s + Number(r.current || 0), 0);
  const totalPrev = data.rows.reduce((s, r) => s + Number(r.previous || 0), 0);
  const totalDelta = totalCur - totalPrev;
  const totalRate = totalPrev === 0 ? null : (totalDelta / totalPrev) * 100;
  const upCount = data.rows.filter((r) => r.delta > 0).length;
  const downCount = data.rows.filter((r) => r.delta < 0).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3">
        <KpiCard label="本期合计" value={fmt(totalCur)} />
        <KpiCard label="上期合计" value={fmt(totalPrev)} />
        <KpiCard label="变化" value={(totalDelta >= 0 ? "+" : "") + fmt(totalDelta)} accent />
        <KpiCard
          label={PERIOD_LABEL[data.period]}
          value={totalRate === null ? "—" : (totalRate >= 0 ? "+" : "") + totalRate.toFixed(2) + "%"}
          trend={totalRate}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-3 card p-4">
          <div className="text-sm font-medium mb-3 flex items-center gap-1.5">
            <BarChart3 size={14} className="text-morandi-3" />
            {AGG_LABEL[data.aggregation] ?? data.aggregation}（{metricLabel}）· 按{dimensionLabel}对比
          </div>
          <CrispEChart
            option={option}
            style={{ height: 380 }}
            notMerge
            lazyUpdate
            aria-label={`${metricLabel}按${dimensionLabel}经营对比图`}
          />
          <div className="text-xs text-text-muted mt-2">
            基准日 {data.baseDate} · 上升 {upCount} · 下降 {downCount}
          </div>
        </div>

        <div className="lg:col-span-2 card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg-subtle text-text-muted text-xs">
              <tr>
                <th className="px-3 py-2 text-left">{dimensionLabel}</th>
                <th className="px-3 py-2 text-right">本期</th>
                <th className="px-3 py-2 text-right">上期</th>
                <th className="px-3 py-2 text-right">{PERIOD_LABEL[data.period]}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.slice(0, 30).map((r, i) => (
                <tr key={i} className="border-t hover:bg-bg-subtle/50">
                  <td className="px-3 py-1.5">{r.dim || "(空)"}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{fmt(r.current)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-text-muted">{fmt(r.previous)}</td>
                  <td
                    className={cn(
                      "px-3 py-1.5 text-right font-mono",
                      r.delta > 0 && "text-green-700",
                      r.delta < 0 && "text-red-600",
                    )}
                  >
                    {r.rate === null ? "—" : (
                      <span className="inline-flex items-center justify-end gap-1">
                        {r.delta > 0 ? <TrendingUp size={11} /> : r.delta < 0 ? <TrendingDown size={11} /> : <Minus size={11} />}
                        {(r.rate >= 0 ? "+" : "") + r.rate.toFixed(1) + "%"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  accent,
  trend,
}: {
  label: string;
  value: string;
  accent?: boolean;
  trend?: number | null;
}) {
  return (
    <div className="card p-4">
      <div className="text-xs text-text-muted mb-1">{label}</div>
      <div
        className={cn(
          "text-lg font-mono font-semibold",
          accent && "text-morandi-3",
          trend !== undefined && trend !== null && trend > 0 && "text-green-700",
          trend !== undefined && trend !== null && trend < 0 && "text-red-600",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function fmt(n: number): string {
  return formatBusinessNumber(n, { compact: true });
}
