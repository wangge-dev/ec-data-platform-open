import { useQuery } from "@tanstack/react-query";
import { Database, Server, Brain, FileSpreadsheet, BarChart3, Bot, Activity, DollarSign } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";
import { UserManagement } from "./UserManagement";

export function SettingPage() {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);

  const { data, isLoading } = useQuery({
    queryKey: ["system-info"],
    queryFn: async () => {
      const r: any = await api.get("/system/system-info");
      return r.data as {
        stats: any;
        recentDays: any[];
        services: { api: any; db: any; llm: any };
        version: string;
      };
    },
    refetchInterval: 5000,
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">设置</h1>
        <p className="text-text-muted text-sm mt-1">用户信息 · 系统状态 · DeepSeek V4 用量</p>
      </header>

      {/* 用户信息 */}
      <section className="card">
        <h2 className="font-medium mb-4 flex items-center gap-2">
          <div className="w-1 h-4 bg-morandi-1 rounded" />
          当前用户
        </h2>
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-morandi-3 flex items-center justify-center text-white text-xl font-medium">
            {user?.username?.[0]?.toUpperCase() || "?"}
          </div>
          <div className="flex-1">
            <div className="font-medium">{user?.displayName || user?.username}</div>
            <div className="text-sm text-text-muted">@{user?.username} · UID {user?.id}</div>
          </div>
          <button
            onClick={logout}
            className="px-3 py-1.5 text-sm border rounded-md hover:bg-bg-subtle transition"
          >
            退出登录
          </button>
        </div>
      </section>

      {/* 用户管理 */}
      <UserManagement />

      {/* 系统连通 */}
      <section className="card">
        <h2 className="font-medium mb-4 flex items-center gap-2">
          <div className="w-1 h-4 bg-morandi-2 rounded" />
          系统状态
        </h2>
        {isLoading && <div className="text-sm text-text-muted">加载中…</div>}
        {data && (
          <div className="grid grid-cols-3 gap-3">
            <ServiceCard
              icon={Server}
              label="API"
              status={data.services.api.status === "up" ? "ok" : "error"}
              detail={`v${data.version}`}
            />
            <ServiceCard
              icon={Database}
              label="数据库"
              status={data.services.db.status === "up" ? "ok" : "error"}
              detail={data.services.db.type}
            />
            <ServiceCard
              icon={Brain}
              label="LLM"
              status="ok"
              detail={data.services.llm.provider}
            />
          </div>
        )}
      </section>

      {/* 数据统计 */}
      {data && (
        <section className="card">
          <h2 className="font-medium mb-4 flex items-center gap-2">
            <div className="w-1 h-4 bg-morandi-3 rounded" />
            数据统计
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Stat icon={Database} label="数据源" value={data.stats.data_sources} sub={`${data.stats.shop_accounts} 店铺 / ${data.stats.files} 文件`} />
            <Stat icon={FileSpreadsheet} label="数据集" value={data.stats.datasets} />
            <Stat icon={BarChart3} label="图表" value={data.stats.charts} />
            <Stat icon={Bot} label="智能体" value={data.stats.agents} />
          </div>
        </section>
      )}

      {/* DeepSeek 用量 */}
      {data && (
        <section className="card">
          <h2 className="font-medium mb-4 flex items-center gap-2">
            <div className="w-1 h-4 bg-morandi-4 rounded" />
            DeepSeek V4 用量
          </h2>
          <div className="grid grid-cols-3 gap-4 mb-4">
            <Stat icon={Activity} label="总调用" value={data.stats.agent_runs} sub={`${data.stats.agent_runs_ok} 成功`} />
            <Stat icon={DollarSign} label="累计成本" value={`¥${data.stats.total_cost_cny || 0}`} />
            <Stat icon={Bot} label="智能体数" value={data.stats.agents} />
          </div>

          {data.recentDays && data.recentDays.length > 0 && (
            <div>
              <div className="text-xs text-text-muted mb-2">近 7 天调用</div>
              <div className="space-y-1.5">
                {data.recentDays.map((d) => (
                  <div key={d.d} className="flex items-center gap-3 text-sm">
                    <div className="w-20 text-text-muted text-xs">{d.d}</div>
                    <div className="flex-1 bg-bg-subtle rounded-full h-2 overflow-hidden">
                      <div
                        className="h-full bg-morandi-3"
                        style={{ width: `${Math.min(100, (d.runs / 10) * 100)}%` }}
                      />
                    </div>
                    <div className="w-16 text-right text-xs">{d.runs} 次</div>
                    <div className="w-20 text-right text-xs text-text-muted">¥{d.cost}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* 关于 */}
      <section className="card text-xs text-text-muted leading-relaxed">
        <h3 className="font-medium text-text-secondary mb-2">关于</h3>
        <p>
          ec 数据平台 v0.1 · 自研 · 莫兰迪渐变 · DeepSeek V4 驱动
        </p>
        <p className="mt-1">
          技术栈：Vite 5 + React 18 + Tailwind 3 · Hono + Drizzle ORM · PostgreSQL 16
        </p>
        <p className="mt-1">
          数据卷由 Docker Desktop 管理，实际位置可在 Docker 设置中查看
        </p>
      </section>
    </div>
  );
}

function ServiceCard({
  icon: Icon,
  label,
  status,
  detail,
}: {
  icon: any;
  label: string;
  status: "ok" | "error";
  detail: string;
}) {
  return (
    <div className="border rounded-md p-3 flex items-center gap-3">
      <div className={`w-9 h-9 rounded-md flex items-center justify-center text-white ${status === "ok" ? "bg-morandi-sage" : "bg-red-400"}`}>
        <Icon size={16} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-text-muted truncate">{detail}</div>
      </div>
      <div
        className={`w-2 h-2 rounded-full ${status === "ok" ? "bg-green-500" : "bg-red-500"} animate-pulse`}
      />
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: any;
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="border rounded-md p-3">
      <div className="flex items-center gap-2 text-text-muted text-xs mb-1.5">
        <Icon size={12} />
        {label}
      </div>
      <div className="text-2xl font-semibold tracking-tight">{value}</div>
      {sub && <div className="text-xs text-text-muted mt-1">{sub}</div>}
    </div>
  );
}
