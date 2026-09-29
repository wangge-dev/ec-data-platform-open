// 总览 tab：模块基础信息卡片 + mini KPI（V0.23+）+ 列定义表
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Database,
  FileCode,
  BarChart3,
  Sparkles,
  PieChart,
  Layers,
  CheckCircle2,
  TrendingUp,
  Bell,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ModuleData } from "../types";

const USAGE_LABEL: Record<string, { label: string; icon: any }> = {
  summary: { label: "汇总页", icon: Layers },
  ai_chart: { label: "AI 出图", icon: BarChart3 },
  ai_analysis: { label: "AI 分析", icon: Sparkles },
};

type Stats = {
  totalRows: number;
  trend: Array<{ date: string; n: number }>;
  openAlerts: number;
  timeKey: string | null;
};

function renderSource(s: string | string[] | undefined): string {
  if (!s) return "-";
  if (Array.isArray(s)) return s.join(" / ");
  return s;
}

export function OverviewTab({ mod }: { mod: ModuleData }) {
  const { data: stats } = useQuery({
    queryKey: ["module-stats", mod.code],
    queryFn: async () => {
      const r: any = await api.get(`/modules/${mod.code}/stats`);
      return r.data as Stats;
    },
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-5">
      {/* mini KPI 横条 */}
      <MiniKpis mod={mod} stats={stats} />

      <div className="card p-5">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <div className="text-xs text-text-muted mb-1 flex items-center gap-1">
              <Database size={11} />
              输出表
            </div>
            <code className="text-sm font-mono">{mod.outputTable}</code>
            <div className="text-xs text-text-muted mt-0.5">
              {(stats?.totalRows ?? mod.totalRows ?? 0).toLocaleString()} 行
            </div>
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">用途</div>
            <div className="flex gap-1.5 flex-wrap">
              {(mod.usages ?? []).map((u) => {
                const info = USAGE_LABEL[u];
                if (!info) return null;
                const Icon = info.icon;
                return (
                  <span
                    key={u}
                    className="text-xs px-2 py-0.5 rounded bg-morandi-1/20 text-morandi-3 inline-flex items-center gap-1"
                  >
                    <Icon size={11} />
                    {info.label}
                  </span>
                );
              })}
            </div>
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1 flex items-center gap-1">
              <FileCode size={11} />
              Transform 钩子
            </div>
            {mod.hasTransform ? (
              <code className="text-xs">{mod.code}.transform.ts</code>
            ) : (
              <span className="text-sm text-text-muted">默认行映射</span>
            )}
          </div>
          {mod.timeKey && (
            <div>
              <div className="text-xs text-text-muted mb-1 flex items-center gap-1">
                <PieChart size={11} />
                时间字段
              </div>
              <code className="text-xs">{mod.timeKey}</code>
              <div className="text-xs text-text-muted mt-0.5">支持 DoD/MoM/YoY</div>
            </div>
          )}
        </div>
      </div>

      {/* 列定义 */}
      <div>
        <h2 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Database size={14} className="text-morandi-2" />
          通用列定义（{mod.columns.length}）
        </h2>
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg-subtle text-text-muted text-xs">
              <tr>
                <th className="px-3 py-2 text-left">字段名</th>
                <th className="px-3 py-2 text-left">默认源列</th>
                <th className="px-3 py-2 text-left">类型</th>
                <th className="px-3 py-2 text-left">必填</th>
                <th className="px-3 py-2 text-left">说明</th>
              </tr>
            </thead>
            <tbody>
              {mod.columns.map((c) => (
                <tr key={c.name} className="border-t">
                  <td className="px-3 py-2">
                    <code className="font-mono">{c.name}</code>
                    {c.label && <span className="text-xs text-text-muted ml-1.5">({c.label})</span>}
                  </td>
                  <td className="px-3 py-2 text-text-secondary">
                    {c.computed ? (
                      <span className="text-xs inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-morandi-2/20 text-morandi-3">
                        <Sparkles size={10} />
                        计算字段
                      </span>
                    ) : (
                      renderSource(c.source)
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <code className="text-xs px-1.5 py-0.5 rounded bg-bg-subtle">{c.type}</code>
                  </td>
                  <td className="px-3 py-2">
                    {c.required ? (
                      <CheckCircle2 size={13} className="text-morandi-3" />
                    ) : (
                      <span className="text-text-muted text-xs">否</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-text-muted text-xs">
                    {c.computed && c.expression && (
                      <div className="font-mono text-[10px] bg-bg-subtle px-1.5 py-0.5 rounded mb-0.5 text-morandi-3">
                        = {c.expression}
                      </div>
                    )}
                    {c.hint ?? "-"}
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

// mini KPI 横条：行数 / 最近 7 天趋势 / 未读预警
function MiniKpis({ mod, stats }: { mod: ModuleData; stats: Stats | undefined }) {
  const totalRows = stats?.totalRows ?? mod.totalRows ?? 0;
  const trend = stats?.trend ?? [];
  const openAlerts = stats?.openAlerts ?? 0;

  // 7 天迷你折线（简单 SVG sparkline）
  const sparkline = (() => {
    if (trend.length < 2) return null;
    const max = Math.max(...trend.map((t) => t.n), 1);
    const w = 100;
    const h = 30;
    const pts = trend.map((t, i) => {
      const x = (i / (trend.length - 1)) * w;
      const y = h - (t.n / max) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return (
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-7" preserveAspectRatio="none">
        <polyline
          points={pts.join(" ")}
          fill="none"
          stroke="rgb(157 139 123)"
          strokeWidth="1.5"
        />
      </svg>
    );
  })();

  const trendTotal = trend.reduce((s, t) => s + t.n, 0);

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      <div className="card p-3">
        <div className="text-xs text-text-muted mb-1 flex items-center gap-1">
          <Database size={11} />
          数据量
        </div>
        <div className="text-2xl font-mono font-semibold">
          {totalRows.toLocaleString()}
        </div>
        <div className="text-[10px] text-text-muted mt-0.5">行</div>
      </div>

      <div className="card p-3">
        <div className="text-xs text-text-muted mb-1 flex items-center gap-1">
          <TrendingUp size={11} />
          近 7 天
        </div>
        {!mod.timeKey ? (
          <div className="text-sm text-text-muted mt-1">未声明 timeKey</div>
        ) : trend.length === 0 ? (
          <div className="text-sm text-text-muted mt-1">近 7 天无数据</div>
        ) : (
          <>
            <div className="text-2xl font-mono font-semibold">
              {trendTotal.toLocaleString()}
            </div>
            <div className="mt-0.5">{sparkline}</div>
          </>
        )}
      </div>

      <Link
        to={`/module/${mod.code}/alerts`}
        className={cn(
          "card p-3 block hover:shadow-md transition",
          openAlerts > 0 && "border-l-4 border-l-morandi-rose",
        )}
      >
        <div className="text-xs text-text-muted mb-1 flex items-center gap-1">
          <Bell size={11} />
          未处理预警
        </div>
        <div
          className={cn(
            "text-2xl font-mono font-semibold",
            openAlerts > 0 ? "text-morandi-rose" : "text-text-muted",
          )}
        >
          {openAlerts}
        </div>
        <div className="text-[10px] text-text-muted mt-0.5">
          {(mod.alerts?.length ?? 0)} 条规则 · 点击查看
        </div>
      </Link>
    </div>
  );
}
