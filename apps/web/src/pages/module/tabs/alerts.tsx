// 预警 tab：本模块的规则清单 + 历史事件 + 手动跑按钮
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Play,
  Loader2,
  CheckCircle2,
  Info,
  AlertTriangle,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Clock,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { nextCronTime, humanCron } from "@/lib/cron";
import type { ModuleData } from "../types";

type Alert = {
  id: number;
  moduleCode: string;
  ruleKey: string;
  ruleLabel: string;
  severity: "info" | "warning" | "critical";
  message: string;
  detail: Record<string, any>;
  status: "open" | "ack" | "closed";
  triggeredAt: string;
};

const SEV_COLORS: Record<string, { bar: string; bg: string; text: string; icon: any }> = {
  critical: { bar: "border-l-red-600", bg: "bg-red-50", text: "text-red-700", icon: AlertCircle },
  warning: {
    bar: "border-l-morandi-rose",
    bg: "bg-orange-50",
    text: "text-orange-700",
    icon: AlertTriangle,
  },
  info: { bar: "border-l-morandi-2", bg: "bg-blue-50", text: "text-blue-700", icon: Info },
};

export function AlertsTab({ mod }: { mod: ModuleData }) {
  const qc = useQueryClient();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<"open" | "all">("open");

  const { data: list, isLoading } = useQuery({
    queryKey: ["alerts-tab", mod.code, statusFilter],
    queryFn: async () => {
      const r: any = await api.get(
        `/alerts?module=${mod.code}&status=${statusFilter}&limit=100`,
      );
      return r.data as { rows: Alert[]; summary: any };
    },
  });

  const runMut = useMutation({
    mutationFn: async () => {
      const r: any = await api.post("/alerts/run", { module: mod.code });
      return r.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts-tab", mod.code] }),
  });

  const ackMut = useMutation({
    mutationFn: async (id: number) => api.post(`/alerts/${id}/ack`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts-tab", mod.code] }),
  });

  const closeMut = useMutation({
    mutationFn: async (id: number) => api.post(`/alerts/${id}/close`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts-tab", mod.code] }),
  });

  const rules = mod.alerts ?? [];
  if (rules.length === 0) {
    return (
      <div className="card p-10 text-center text-sm text-text-muted">
        本模块未配置预警规则。在模块 JSON 加 <code>alerts[]</code> 即可。
      </div>
    );
  }

  // V0.20：定时调度信息
  const next = mod.schedule ? nextCronTime(mod.schedule) : null;

  return (
    <div className="space-y-4">
      {/* 调度信息条（V0.20+） */}
      {mod.schedule ? (
        <div className="card p-3 flex items-center gap-3 flex-wrap text-xs bg-morandi-2/10 border border-morandi-2/30">
          <Clock size={14} className="text-morandi-3" />
          <span className="text-text-secondary">
            <strong className="text-text-primary">自动调度</strong>：{humanCron(mod.schedule)}
          </span>
          <code className="text-[10px] px-1.5 py-0.5 rounded bg-bg-subtle">{mod.schedule}</code>
          {next && (
            <>
              <span className="text-text-muted">·</span>
              <span className="text-text-secondary">
                下次跑：
                <span className="text-morandi-3 font-mono ml-1">
                  {next.toLocaleString("zh-CN", { hour12: false })}
                </span>
              </span>
            </>
          )}
        </div>
      ) : (
        <div className="card p-3 flex items-center gap-2 text-xs text-text-muted">
          <Clock size={12} />
          未配置自动调度。在模块 JSON 加 <code className="mx-1">"schedule": "0 9 * * *"</code>
          即可每天 9 点自动跑。
        </div>
      )}

      {/* 操作栏 */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => runMut.mutate()}
          disabled={runMut.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-morandi-3 text-white text-sm rounded-md hover:opacity-90 disabled:opacity-40 transition"
        >
          {runMut.isPending ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
          跑本模块的规则
        </button>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as any)}
          className="text-xs px-2 py-1.5 border rounded-md bg-bg-card"
        >
          <option value="open">未处理</option>
          <option value="all">全部状态</option>
        </select>
        <button
          onClick={() => qc.invalidateQueries({ queryKey: ["alerts-tab", mod.code] })}
          className="flex items-center gap-1 text-xs px-2 py-1.5 border rounded-md hover:bg-bg-subtle"
        >
          <RefreshCw size={11} />
          刷新
        </button>
        <span className="text-xs text-text-muted ml-auto">
          本模块共 {rules.length} 条规则
        </span>
      </div>

      {/* 规则清单 */}
      <div>
        <div className="text-xs text-text-muted mb-2">规则定义（来自模块 JSON）：</div>
        <div className="grid grid-cols-2 gap-2">
          {rules.map((r) => {
            const c = SEV_COLORS[r.severity] ?? SEV_COLORS.info;
            return (
              <div key={r.key} className={cn("card p-2.5 border-l-4", c.bar)}>
                <div className="flex items-center gap-2 mb-0.5">
                  <span className={cn("text-[10px] px-1.5 py-0.5 rounded", c.bg, c.text)}>
                    {r.severity}
                  </span>
                  <code className="text-xs text-text-secondary">{r.key}</code>
                </div>
                <div className="text-sm">{r.label}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 事件列表 */}
      <div>
        <div className="text-xs text-text-muted mb-2">
          触发的事件
          {list && (
            <span className="ml-1">
              （{list.rows.length}）
            </span>
          )}
        </div>
        {isLoading ? (
          <div className="card p-6 text-center text-sm text-text-muted">加载中…</div>
        ) : !list || list.rows.length === 0 ? (
          <div className="card p-6 text-center">
            <CheckCircle2 size={28} className="mx-auto text-green-600 mb-2" />
            <div className="text-sm text-text-secondary">没有未处理预警 🎉</div>
            <div className="text-xs text-text-muted mt-1">点上面"跑本模块规则"触发</div>
          </div>
        ) : (
          <div className="space-y-1.5">
            {list.rows.map((a) => {
              const c = SEV_COLORS[a.severity] ?? SEV_COLORS.info;
              const Icon = c.icon;
              const isExpanded = expandedId === a.id;
              return (
                <div
                  key={a.id}
                  className={cn(
                    "card p-2.5 border-l-4",
                    c.bar,
                    a.status !== "open" && "opacity-60",
                  )}
                >
                  <div className="flex items-start gap-2.5">
                    <Icon size={14} className={cn("mt-0.5 shrink-0", c.text)} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm">{a.message}</div>
                      <div className="text-xs text-text-muted mt-0.5 flex items-center gap-2 flex-wrap">
                        <code>{a.ruleKey}</code>
                        <span>·</span>
                        <span>{a.ruleLabel}</span>
                        <span>·</span>
                        <span>{new Date(a.triggeredAt).toLocaleString("zh-CN")}</span>
                        {a.status !== "open" && (
                          <>
                            <span>·</span>
                            <span className="px-1.5 py-0.5 rounded bg-bg-subtle">
                              {a.status === "ack" ? "已读" : "已关闭"}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : a.id)}
                        className="text-text-muted hover:text-text-primary p-1"
                      >
                        {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                      </button>
                      {a.status === "open" && (
                        <>
                          <button
                            onClick={() => ackMut.mutate(a.id)}
                            disabled={ackMut.isPending}
                            className="text-xs px-2 py-1 rounded border hover:bg-bg-subtle disabled:opacity-40"
                          >
                            已读
                          </button>
                          <button
                            onClick={() => closeMut.mutate(a.id)}
                            disabled={closeMut.isPending}
                            className="text-xs px-2 py-1 rounded border hover:bg-bg-subtle disabled:opacity-40"
                          >
                            关闭
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="mt-2 pt-2 border-t">
                      <pre className="text-xs font-mono bg-bg-subtle/50 p-2 rounded overflow-x-auto">
                        {JSON.stringify(a.detail, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
