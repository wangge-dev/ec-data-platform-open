// 分析中心（V0.23+ 做厚版）：KPI 横条 + TOP 异常预警实体 + 未处理预警 + 一键已读 + 时间对比入口
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Compass,
  AlertTriangle,
  TrendingUp,
  Bell,
  Boxes,
  Info,
  AlertCircle,
  Check,
  Loader2,
  Layers,
  Sparkles,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";
import { cn } from "@/lib/utils";
import { filterRetiredModules } from "@/pages/module/types";
import { BatchEtlPanel } from "./BatchEtlPanel";

type Module = {
  code: string;
  name: string;
  outputTable: string;
  timeKey?: string;
  alerts?: Array<{ key: string; label: string }>;
  presets?: any[];
  totalRows?: number;
};

type AlertRow = {
  id: number;
  moduleCode: string;
  ruleKey: string;
  ruleLabel: string;
  severity: "info" | "warning" | "critical";
  message: string;
  triggeredAt: string;
};

type Overview = {
  moduleCount: number;
  latestDate: string | null;
  latestDateGmv: number;
  latestDateOrders: number;
  openTotal: number;
  bySev: Array<{ severity: string; n: number }>;
  todayAlerts: number;
  yestAlerts: number;
  asOf: string;
};

type TopAlertShop = {
  moduleCode: string;
  ruleKey: string;
  ruleLabel: string;
  n: number;
  score: number;
  topSeverity: "info" | "warning" | "critical";
  latestAt: string;
};

const SEV_COLORS: Record<string, { bar: string; bg: string; text: string; icon: any }> = {
  critical: { bar: "border-l-red-600", bg: "bg-red-50", text: "text-red-700", icon: AlertCircle },
  warning: { bar: "border-l-morandi-rose", bg: "bg-orange-50", text: "text-orange-700", icon: AlertTriangle },
  info: { bar: "border-l-morandi-2", bg: "bg-blue-50", text: "text-blue-700", icon: Info },
};

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + " 亿";
  if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(2) + " 万";
  return n.toLocaleString();
}

export function AnalyticsHubPage() {
  const qc = useQueryClient();
  const isAdmin = useAuth((state) => state.user?.isAdmin === true);
  const [ackConfirm, setAckConfirm] = useState(false);
  // V0.27：GMV 日期范围选择（默认空=最新一天，选了范围则按范围合计）
  const [gmvFrom, setGmvFrom] = useState("");
  const [gmvTo, setGmvTo] = useState("");

  const { data: mods } = useQuery({
    queryKey: ["modules"],
    queryFn: async () => {
      const r: any = await api.get("/modules");
      return filterRetiredModules(r.data as Module[]);
    },
  });

  const { data: overview } = useQuery({
    queryKey: ["analytics-overview", gmvFrom, gmvTo],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (gmvFrom) params.set("from", gmvFrom);
      if (gmvTo) params.set("to", gmvTo);
      const qs = params.toString();
      const r: any = await api.get(`/analytics/overview${qs ? `?${qs}` : ""}`);
      return r.data as Overview;
    },
    refetchInterval: 60_000, // 每分钟刷新
  });

  const { data: alerts } = useQuery({
    queryKey: ["alerts", "open", "hub"],
    queryFn: async () => {
      const r: any = await api.get("/alerts?status=open&limit=10");
      return r.data as { rows: AlertRow[]; summary: any };
    },
  });

  const { data: topShops } = useQuery({
    queryKey: ["analytics-top-shops"],
    queryFn: async () => {
      const r: any = await api.get("/analytics/top-alert-shops?limit=8");
      return r.data as TopAlertShop[];
    },
  });

  const ackAllMut = useMutation({
    mutationFn: async () => {
      const r: any = await api.post("/analytics/ack-all", {});
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alerts"] });
      qc.invalidateQueries({ queryKey: ["analytics-overview"] });
      qc.invalidateQueries({ queryKey: ["analytics-top-shops"] });
      setAckConfirm(false);
    },
  });

  const timeKeyMods = (mods ?? []).filter((m) => m.timeKey);
  const alertDelta = overview ? overview.todayAlerts - overview.yestAlerts : 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Compass size={22} className="text-morandi-3" />
          分析中心
        </h1>
        <p className="text-text-muted text-sm mt-1">
          跨模块视图 · 想看单模块细节请进各自的模块工作台
        </p>
      </header>

      {/* ========== 第一层：经营概览（核心指标 + 日期范围） ========== */}
      <div className="flex items-center gap-2 pt-2">
        <div className="w-1 h-5 rounded bg-morandi-3" />
        <h2 className="text-sm font-semibold text-text-secondary">经营概览</h2>
        <span className="text-xs text-text-muted">核心指标一目了然</span>
      </div>

      {/* KPI 横条：只留 GMV/订单数/未处理预警 3 个核心经营指标 */}
      <section className="grid grid-cols-3 gap-3">
        <KpiCard
          icon={TrendingUp}
          label={
            overview?.latestDate
              ? `${overview.latestDate} GMV`
              : "最新可用日 GMV"
          }
          value={overview ? `¥${fmtNum(overview.latestDateGmv)}` : "—"}
          hint={
            overview
              ? overview.latestDate
                ? "销售金额合计"
                : "暂无可用数据"
              : ""
          }
          color="info"
        />
        <KpiCard
          icon={Layers}
          label={overview?.latestDate ? `${overview.latestDate} 订单数` : "订单数"}
          value={overview ? (overview.latestDateOrders ?? 0).toLocaleString() : "—"}
          hint="有效订单行数（已过滤取消/退款）"
        />
        <KpiCard
          icon={Bell}
          label="未处理预警"
          value={overview ? String(overview.openTotal) : "—"}
          hint={
            overview
              ? overview.bySev
                  .map((s) => `${s.severity}:${s.n}`)
                  .join(" / ") || "全部清空"
              : ""
          }
          color={overview && overview.openTotal > 0 ? "warning" : "info"}
        />
      </section>

      {/* V0.27：GMV 日期范围选择器（默认最新一天，选范围按范围合计各模块 amount） */}
      <section className="flex items-center gap-2 text-xs text-text-secondary flex-wrap mb-2">
        <span className="shrink-0">GMV 日期范围：</span>
        <input
          type="date"
          value={gmvFrom}
          onChange={(e) => setGmvFrom(e.target.value)}
          className="px-2 py-1 border border-morandi-slate/40 rounded-md text-sm bg-bg focus:outline-none focus:border-morandi-slate"
        />
        <span>~</span>
        <input
          type="date"
          value={gmvTo}
          onChange={(e) => setGmvTo(e.target.value)}
          className="px-2 py-1 border border-morandi-slate/40 rounded-md text-sm bg-bg focus:outline-none focus:border-morandi-slate"
        />
        {(gmvFrom || gmvTo) && (
          <button
            onClick={() => {
              setGmvFrom("");
              setGmvTo("");
            }}
            className="text-xs text-text-muted hover:text-morandi-rose"
            title="清除，回到最新一天"
          >
            ✕ 清除（回到最新一天）
          </button>
        )}
        <span className="text-text-muted">
          {gmvFrom && gmvTo ? "按范围合计各订单模块金额" : !gmvFrom && !gmvTo ? "默认最新有数据日" : "请选齐起止日期"}
        </span>
      </section>

      {/* ========== 第二层：待处理事项（预警 + 异常 + AI 诊断） ========== */}
      <div className="flex items-center gap-2 pt-2">
        <div className="w-1 h-5 rounded bg-morandi-rose" />
        <h2 className="text-sm font-semibold text-text-secondary">待处理事项</h2>
        <span className="text-xs text-text-muted">异常预警优先处理</span>
      </div>

      {/* 未处理预警 + TOP 实体（双栏） */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 未处理预警列表 */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-medium flex items-center gap-1.5">
              <Bell size={14} className="text-morandi-rose" />
              未处理预警
              {alerts && alerts.rows.length > 0 && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-morandi-rose/15 text-morandi-rose">
                  {alerts.summary?.openTotal ?? alerts.rows.length}
                </span>
              )}
            </h2>
            {alerts && alerts.rows.length > 0 && (
              <div>
                {!ackConfirm ? (
                  <button
                    onClick={() => setAckConfirm(true)}
                    className="text-xs px-2 py-1 rounded border hover:bg-bg-subtle text-text-secondary"
                  >
                    一键已读
                  </button>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-text-muted">确认全部已读？</span>
                    <button
                      onClick={() => ackAllMut.mutate()}
                      disabled={ackAllMut.isPending}
                      className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-morandi-3 text-white"
                    >
                      {ackAllMut.isPending ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <Check size={11} />
                      )}
                      确认
                    </button>
                    <button
                      onClick={() => setAckConfirm(false)}
                      className="text-xs px-2 py-1 rounded border hover:bg-bg-subtle"
                    >
                      取消
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {!alerts ? (
            <div className="card p-6 text-center text-sm text-text-muted">加载中…</div>
          ) : alerts.rows.length === 0 ? (
            <div className="card p-6 text-center text-sm text-text-muted">
              🎉 当前没有未处理预警
            </div>
          ) : (
            <div className="space-y-1.5">
              {alerts.rows.map((a) => {
                const c = SEV_COLORS[a.severity] ?? SEV_COLORS.info;
                const Icon = c.icon;
                return (
                  <Link
                    key={a.id}
                    to={`/module/${a.moduleCode}/alerts`}
                    className={cn(
                      "card p-2.5 flex items-center gap-2.5 border-l-4 hover:shadow-md transition",
                      c.bar,
                    )}
                  >
                    <Icon size={13} className={c.text} />
                    <span className="text-sm flex-1 min-w-0 truncate">{a.message}</span>
                    <code className="text-[10px] text-text-muted shrink-0">
                      {a.moduleCode}.{a.ruleKey}
                    </code>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        {/* TOP 触发规则 */}
        <section>
          <h2 className="text-sm font-medium mb-2 flex items-center gap-1.5">
            <AlertCircle size={14} className="text-morandi-rose" />
            TOP 高频预警规则
            <span className="text-xs text-text-muted font-normal">
              按严重度加权排序
            </span>
          </h2>
          {!topShops ? (
            <div className="card p-6 text-center text-sm text-text-muted">加载中…</div>
          ) : topShops.length === 0 ? (
            <div className="card p-6 text-center text-sm text-text-muted">
              当前没有任何触发的规则
            </div>
          ) : (
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-bg-subtle text-text-muted text-xs">
                  <tr>
                    <th className="px-3 py-2 text-left">规则</th>
                    <th className="px-3 py-2 text-right">触发数</th>
                    <th className="px-3 py-2 text-right">加权分</th>
                  </tr>
                </thead>
                <tbody>
                  {topShops.map((s, i) => {
                    const c = SEV_COLORS[s.topSeverity] ?? SEV_COLORS.info;
                    return (
                      <tr key={i} className="border-t hover:bg-bg-subtle/50">
                        <td className="px-3 py-2">
                          <Link
                            to={`/module/${s.moduleCode}/alerts`}
                            className="flex items-center gap-1.5 hover:text-morandi-3 transition"
                          >
                            <span
                              className={cn(
                                "text-[10px] px-1.5 py-0.5 rounded",
                                c.bg,
                                c.text,
                              )}
                            >
                              {s.topSeverity}
                            </span>
                            <span className="text-text-secondary">{s.moduleCode}</span>
                            <span className="text-text-muted">·</span>
                            <span>{s.ruleLabel}</span>
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{s.n}</td>
                        <td className="px-3 py-2 text-right font-mono text-morandi-3">
                          {s.score}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* AI 经营诊断入口（指向智能体页）—— 归待处理事项区 */}
      <section>
        <h2 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Sparkles size={14} className="text-morandi-3" />
          AI 经营诊断
        </h2>
        <div className="card p-4 bg-gradient-to-br from-morandi-1/10 to-morandi-3/5">
          <div className="flex items-start gap-3">
            <Sparkles size={20} className="text-morandi-3 mt-0.5" />
            <div className="flex-1">
              <div className="font-medium text-sm mb-1">让 AI 给经营写一份诊断报告</div>
              <div className="text-xs text-text-muted mb-2">
                选某个模块的统一表 → AI 看 80 行采样 + 字段元信息 → 输出洞察+建议
              </div>
              <div className="flex gap-2 flex-wrap">
                {timeKeyMods.slice(0, 4).map((m) => (
                  <Link
                    key={m.code}
                    to={`/agent`}
                    className="text-xs px-2.5 py-1 rounded border bg-bg-card hover:border-morandi-3/50 transition"
                  >
                    分析 {m.name}
                  </Link>
                ))}
                <Link
                  to="/agent"
                  className="text-xs px-2.5 py-1 rounded bg-morandi-3 text-white hover:opacity-90 transition"
                >
                  → 打开智能体页
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ========== 第三层：模块入口与工具（时间对比 / 模块概览 / 批量 ETL） ========== */}
      <div className="flex items-center gap-2 pt-2">
        <div className="w-1 h-5 rounded bg-morandi-slate" />
        <h2 className="text-sm font-semibold text-text-secondary">模块入口与工具</h2>
        <span className="text-xs text-text-muted">进模块看细节 / 批处理</span>
      </div>

      {/* 时间对比入口 */}
      <section>
        <h2 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <TrendingUp size={14} className="text-morandi-2" />
          时间对比快捷入口（支持 DoD/MoM/YoY 的模块）
        </h2>
        {timeKeyMods.length === 0 ? (
          <div className="card p-6 text-center text-sm text-text-muted">
            还没有声明 timeKey 的模块。在模块 JSON 加 <code>"timeKey": "字段名"</code> 即可。
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {timeKeyMods.map((m) => (
              <Link
                key={m.code}
                to={`/module/${m.code}/compare`}
                className="card p-3 hover:shadow-md transition group"
              >
                <div className="flex items-center gap-2 mb-1">
                  <Boxes size={14} className="text-morandi-3 group-hover:text-morandi-rose transition" />
                  <span className="font-medium text-sm">{m.name}</span>
                  <code className="text-[10px] text-text-muted">{m.code}</code>
                </div>
                <div className="text-xs text-text-muted">
                  时间字段 <code>{m.timeKey}</code> · {m.totalRows ?? 0} 行
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>


      {/* 批量 ETL 操作：运维工具，默认折叠（Codex 建议：不压在经营分析主页面） */}
      {isAdmin && (
        <details className="group">
          <summary className="text-sm font-medium cursor-pointer flex items-center gap-1.5 py-2 text-text-secondary hover:text-morandi-3 select-none">
            <Layers size={14} />
            批量 ETL（管理员运维工具，点击展开）
          </summary>
          <div className="mt-1">
            <BatchEtlPanel />
          </div>
        </details>
      )}

      {/* 所有模块概览（紧凑版，留个跳转入口） */}
      <section>
        <h2 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Boxes size={14} className="text-morandi-3" />
          所有模块（{mods?.length ?? 0}）
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {(mods ?? []).map((m) => (
            <Link
              key={m.code}
              to={`/module/${m.code}`}
              className="card p-3 hover:shadow-md transition group"
            >
              <div className="font-medium text-sm group-hover:text-morandi-3 transition">
                {m.name}
              </div>
              <div className="text-xs text-text-muted mt-0.5">
                {(m.totalRows ?? 0).toLocaleString()} 行
                {m.timeKey && " · 可对比"}
                {(m.alerts?.length ?? 0) > 0 && ` · ${m.alerts!.length} 预警规则`}
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
  hint,
  color,
}: {
  icon: any;
  label: string;
  value: string;
  hint?: string;
  color?: "info" | "warning";
}) {
  return (
    <div
      className={cn(
        "card p-4",
        color === "warning" && "border-l-4 border-l-morandi-rose",
        color === "info" && "border-l-4 border-l-morandi-2",
      )}
    >
      <div className="flex items-center gap-1.5 text-xs text-text-muted mb-1">
        <Icon size={12} />
        {label}
      </div>
      <div
        className={cn(
          "text-2xl font-mono font-semibold",
          color === "warning" && "text-morandi-rose",
          color === "info" && "text-morandi-3",
        )}
      >
        {value}
      </div>
      {hint && <div className="text-[10px] text-text-muted mt-0.5 truncate">{hint}</div>}
    </div>
  );
}
