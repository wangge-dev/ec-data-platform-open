// 模块工作台（V0.18+ 重构）
// 路由：/module/:code  或  /module/:code/:tab
// 顶部 tab 动态按模块声明显示：总览/对比/预警/AI出图/AI分析/场景预设/平台/JSON
import { useMemo, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  Boxes,
  Database,
  Layers,
  TrendingUp,
  Bell,
  BarChart3,
  Sparkles,
  Zap,
  FileJson,
  CheckCircle2,
  XCircle,
  Link2,
  ArrowRight,
  CircleAlert,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { filterRetiredModules, type ModuleData } from "./types";
import { OverviewTab } from "./tabs/overview";
import { CompareTab } from "./tabs/compare";
import { AlertsTab } from "./tabs/alerts";
import { AiChartTab } from "./tabs/ai-chart";
import { AiAnalysisTab } from "./tabs/ai-analysis";
import { PresetsTab } from "./tabs/presets";
import { PlatformsTab } from "./tabs/platforms";
import { JsonTab } from "./tabs/json";
import { UnmatchedTab } from "./tabs/unmatched";
import { SchemaChangeDialog } from "./module-builder/SchemaChangeDialog";
import { summarizePendingSchemaFiles } from "./module-builder/model";

type TabDef = {
  key: string;
  label: string;
  icon: any;
  visible: (m: ModuleData) => boolean;
  badge?: (m: ModuleData) => number | string | undefined;
};

const TABS: TabDef[] = [
  { key: "overview", label: "总览", icon: Database, visible: () => true },
  {
    key: "compare",
    label: "对比",
    icon: TrendingUp,
    visible: (m) => !!m.timeKey,
  },
  {
    key: "alerts",
    label: "预警",
    icon: Bell,
    visible: (m) => (m.alerts?.length ?? 0) > 0,
    badge: (m) => m.alerts?.length,
  },
  {
    key: "ai-chart",
    label: "AI 出图",
    icon: BarChart3,
    visible: (m) => (m.usages ?? []).includes("ai_chart"),
  },
  {
    key: "ai-analysis",
    label: "AI 分析",
    icon: Sparkles,
    visible: (m) => (m.usages ?? []).includes("ai_analysis"),
  },
  {
    key: "presets",
    label: "场景预设",
    icon: Zap,
    visible: (m) => (m.presets?.length ?? 0) > 0,
    badge: (m) => m.presets?.length,
  },
  {
    key: "platforms",
    label: "平台",
    icon: Layers,
    visible: () => true,
    badge: (m) => m.platforms?.length,
  },
  {
    key: "unmatched",
    label: "未匹配",
    icon: CircleAlert,
    visible: (m) => m.code === "orders",
  },
  { key: "json", label: "JSON", icon: FileJson, visible: () => true },
];

export function ModuleWorkbench() {
  const { code, tab } = useParams<{ code: string; tab?: string }>();
  const navigate = useNavigate();
  const [activeSchemaSourceId, setActiveSchemaSourceId] = useState<number | null>(null);

  const { data: mods, isLoading, error } = useQuery({
    queryKey: ["modules"],
    queryFn: async () => {
      const r: any = await api.get("/modules");
      return filterRetiredModules(r.data as ModuleData[]);
    },
  });
  const { data: moduleFiles } = useQuery({
    queryKey: ["files"],
    queryFn: async () => {
      const response: any = await api.get("/files");
      return response.data as Array<{
        id: number;
        name: string;
        config?: {
          originalFileName?: string;
          schemaReview?: {
            status: "pending" | "awaiting_retry";
            moduleCode: string;
          };
        };
        attribution?: {
          kind: "module" | "dict" | "unmatched";
          moduleCode?: string;
        };
      }>;
    },
  });

  const mod = useMemo(() => mods?.find((m) => m.code === code), [mods, code]);
  const pendingSchemaFiles = useMemo(
    () =>
      (moduleFiles ?? []).filter(
        (file) =>
          (file.config?.schemaReview?.status === "pending" ||
            file.config?.schemaReview?.status === "awaiting_retry") &&
          file.config.schemaReview.moduleCode === code,
      ),
    [code, moduleFiles],
  );
  const activeSchemaFile = pendingSchemaFiles.find(
    (file) => file.id === activeSchemaSourceId,
  );
  const pendingSchemaSummary = summarizePendingSchemaFiles(pendingSchemaFiles);

  if (isLoading) return <div className="text-sm text-text-muted p-6">加载中…</div>;
  if (error) return <div className="text-sm text-red-600 p-6">加载失败：{String(error)}</div>;
  if (!mod) {
    return (
      <div className="card p-10 text-center">
        <Boxes size={36} className="mx-auto text-text-muted mb-3" />
        <div className="text-sm text-text-muted">模块 {code} 不存在</div>
        <Link to="/module" className="text-xs text-morandi-3 hover:underline mt-2 inline-block">
          ← 返回模块列表
        </Link>
      </div>
    );
  }

  const visibleTabs = TABS.filter((t) => t.visible(mod));
  const activeTab = tab && visibleTabs.find((t) => t.key === tab) ? tab : "overview";

  function switchTab(k: string) {
    if (k === "overview") navigate(`/module/${code}`);
    else navigate(`/module/${code}/${k}`);
  }

  // 关联可视化数据
  const allJoins = mod.joins ?? (mod.join ? [mod.join] : []);
  const refBy = mod.referencedBy ?? [];

  return (
    <div className="space-y-4">
      {activeSchemaFile && (
        <SchemaChangeDialog
          open
          onOpenChange={(open) => {
            if (!open) setActiveSchemaSourceId(null);
          }}
          moduleCode={mod.code}
          sourceId={activeSchemaFile.id}
          fileName={activeSchemaFile.config?.originalFileName || activeSchemaFile.name}
          moduleColumns={mod.columns}
        />
      )}
      {/* 顶部面包屑 + 模块头 */}
      <header>
        <Link
          to="/module"
          className="text-xs text-text-muted hover:text-text-primary inline-flex items-center gap-1 mb-2"
        >
          <ChevronLeft size={12} />
          返回模块列表
        </Link>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Boxes size={22} className="text-morandi-3" />
            {mod.name}
          </h1>
          <code className="text-xs px-1.5 py-0.5 rounded bg-bg-subtle text-text-secondary">
            {mod.code}
          </code>
          {mod.enabled ? (
            <span className="text-xs text-green-700 flex items-center gap-0.5">
              <CheckCircle2 size={12} />
              启用
            </span>
          ) : (
            <span className="text-xs text-red-600 flex items-center gap-0.5">
              <XCircle size={12} />
              禁用
            </span>
          )}
          <span className="text-xs text-text-muted">·</span>
          <span className="text-xs text-text-muted">
            <code className="font-mono">{mod.outputTable}</code> ·{" "}
            {(mod.totalRows ?? 0).toLocaleString()} 行
          </span>
        </div>
        <p className="text-text-muted text-sm mt-1">{mod.description}</p>
      </header>

      {pendingSchemaFiles.length > 0 && (
        <section
          aria-labelledby="pending-schema-heading"
          className="card flex flex-col gap-3 border-morandi-rose/30 bg-morandi-rose/5 p-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 items-start gap-2">
            <CircleAlert size={16} className="mt-0.5 shrink-0 text-morandi-rose" />
            <div className="min-w-0">
              <h2 id="pending-schema-heading" className="text-sm font-medium">
                字段待确认
              </h2>
              <p className="mt-0.5 break-words text-xs text-text-muted">
                {pendingSchemaFiles.length} 个文件的字段有变化，确认后才会重新处理并更新本模块数据。
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {pendingSchemaSummary.visible.map((file) => (
              <button
                key={file.id}
                type="button"
                onClick={() => setActiveSchemaSourceId(file.id)}
                className="min-h-10 max-w-full truncate rounded-md border border-morandi-rose/30 bg-bg-card px-3 py-2 text-xs text-morandi-rose transition hover:bg-morandi-rose/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40"
              >
                确认 {file.config?.originalFileName || file.name}
              </button>
            ))}
            {pendingSchemaSummary.remaining > 0 && (
              <span className="inline-flex min-h-10 items-center px-2 text-xs text-text-muted">
                +{pendingSchemaSummary.remaining} 个待确认
              </span>
            )}
          </div>
        </section>
      )}

      {/* 关联关系条 */}
      {(allJoins.length > 0 || refBy.length > 0) && (
        <div className="card p-3 flex items-center gap-4 flex-wrap text-xs">
          <Link2 size={13} className="text-morandi-3" />
          {allJoins.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-text-muted">借用：</span>
              {allJoins.map((j, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-morandi-1/20 text-morandi-3"
                >
                  <code>{j.dictRole}</code>
                  <span className="text-text-muted">→</span>
                  <span>{Object.keys(j.enrich).join(", ")}</span>
                </span>
              ))}
            </div>
          )}
          {refBy.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-text-muted">被借用：</span>
              {refBy.map((c) => (
                <Link
                  key={c}
                  to={`/module/${c}`}
                  className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded bg-morandi-2/20 text-morandi-3 hover:underline"
                >
                  {c}
                  <ArrowRight size={10} />
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {/* tab 导航 */}
      <div className="border-b flex items-center gap-1 overflow-x-auto">
        {visibleTabs.map((t) => {
          const Icon = t.icon;
          const badge = t.badge?.(mod);
          const isActive = activeTab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => switchTab(t.key)}
              className={cn(
                "px-3.5 py-2 text-sm border-b-2 -mb-px transition flex items-center gap-1.5 whitespace-nowrap",
                isActive
                  ? "border-morandi-3 text-morandi-3 font-medium"
                  : "border-transparent text-text-secondary hover:text-text-primary",
              )}
            >
              <Icon size={13} />
              {t.label}
              {badge !== undefined && (
                <span
                  className={cn(
                    "text-[10px] px-1.5 py-0.5 rounded-full",
                    isActive ? "bg-morandi-3/20 text-morandi-3" : "bg-bg-subtle text-text-muted",
                  )}
                >
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* tab 内容 */}
      <div>
        {activeTab === "overview" && <OverviewTab mod={mod} />}
        {activeTab === "compare" && <CompareTab mod={mod} />}
        {activeTab === "alerts" && <AlertsTab mod={mod} />}
        {activeTab === "ai-chart" && <AiChartTab mod={mod} />}
        {activeTab === "ai-analysis" && <AiAnalysisTab mod={mod} />}
        {activeTab === "presets" && <PresetsTab mod={mod} />}
        {activeTab === "platforms" && <PlatformsTab mod={mod} />}
        {activeTab === "unmatched" && <UnmatchedTab />}
        {activeTab === "json" && <JsonTab mod={mod} />}
      </div>
    </div>
  );
}
