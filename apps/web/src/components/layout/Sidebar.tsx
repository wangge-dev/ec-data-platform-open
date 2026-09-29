import { NavLink, useNavigate } from "react-router-dom";
import {
  Database,
  BarChart3,
  Bot,
  Settings,
  LogOut,
  Boxes,
  Compass,
  Star,
  BadgeDollarSign,
  PackageCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-store";

// 侧栏按职能分组（V0.21+）：
//   业务（核心入口） → 工具（AI 探索） → 数据源（原始/全表） → 系统（运维/设置）
type NavItem = {
  to: string;
  icon: any;
  label: string;
  gradient: string;
  primary?: boolean; // 主入口（加粗 + 星标）
  hint?: string; // 小灰字提示
  desc?: string; // 鼠标悬浮提示（写清楚是干啥的、跟什么有关联）
  adminOnly?: boolean;
};

const GROUPS: Array<{ title: string; subtitle: string; items: NavItem[] }> = [
  {
    title: "业务",
    subtitle: "日常工作从这里进",
    items: [
      {
        to: "/module",
        icon: Boxes,
        label: "模块管理",
        gradient: "bg-morandi-3",
        primary: true,
        desc: "每个业务一个完整工作台：订单/库存/广告/成本，含对比/预警/AI 等所有能力",
      },
      {
        to: "/analytics",
        icon: Compass,
        label: "分析中心",
        gradient: "bg-morandi-3",
        desc: "跨模块视图：所有未处理预警 + 各模块时间对比快捷入口",
      },
      {
        to: "/front-profit",
        icon: BadgeDollarSign,
        label: "前台利润",
        gradient: "bg-morandi-2",
        desc: "按月份准备来源、生成试算、核对差异并发布前台利润结果",
      },
    ],
  },
  {
    title: "工具",
    subtitle: "AI 自由探索（不限模块）",
    items: [
      {
        to: "/board",
        icon: BarChart3,
        label: "经营驾驶舱",
        gradient: "bg-morandi-2",
        desc: "联动筛选、图表分析与智能出图",
      },
      {
        to: "/agent",
        icon: Bot,
        label: "智能体",
        gradient: "bg-morandi-3",
        desc: "AI 分析：竞品分析/详情页文案/客服话术/数据分析 4 个智能体",
      },
    ],
  },
  {
    title: "数据源",
    subtitle: "原始文件管理",
    items: [
      {
        to: "/data",
        icon: Database,
        label: "数据",
        gradient: "bg-morandi-1",
        desc: "上传 Excel/CSV，模块靠文件名正则识别归属",
      },
    ],
  },
  {
    title: "系统",
    subtitle: "设置",
    items: [
      {
        to: "/solutions",
        icon: PackageCheck,
        label: "方案交付",
        gradient: "bg-morandi-4",
        adminOnly: true,
        desc: "导出纯配置垂直方案，或在当前实例校验并原子安装方案包",
      },
      {
        to: "/setting",
        icon: Settings,
        label: "设置",
        gradient: "bg-morandi-4",
        desc: "用户/扫描文件夹/API Key 配置",
      },
    ],
  },
];

export function Sidebar() {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const nav = useNavigate();

  return (
    <aside className="w-16 shrink-0 border-r bg-bg-card flex flex-col sm:w-56">
      <div className="px-2 py-5 border-b text-center sm:px-5 sm:text-left">
        <div className="hidden text-lg font-semibold tracking-wide sm:block">ec 数据平台</div>
        <div className="text-lg font-semibold tracking-wide sm:hidden">ec</div>
        <div className="hidden text-xs text-text-muted mt-0.5 sm:block">v0.1 · 莫兰迪</div>
      </div>
      <nav className="flex-1 p-3 space-y-3 overflow-y-auto">
        {GROUPS.map((g) => (
          <div key={g.title}>
            <div className="hidden px-3 mb-1.5 sm:block">
              <div className="text-[10px] uppercase tracking-wider text-text-muted font-medium">
                {g.title}
              </div>
              <div className="text-[10px] text-text-muted/70 mt-0.5 leading-tight">
                {g.subtitle}
              </div>
            </div>
            <div className="space-y-0.5">
              {g.items.filter((n) => !n.adminOnly || user?.isAdmin).map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  title={n.desc ?? n.label}
                  className={({ isActive }) =>
                    cn(
                      "nav-item flex items-center justify-center gap-2 sm:justify-start",
                      isActive && `active ${n.gradient}`,
                      n.primary && "font-medium",
                    )
                  }
                >
                  <n.icon size={18} strokeWidth={1.8} />
                  <span className="hidden flex-1 sm:block">{n.label}</span>
                  {n.primary && <Star size={11} className="hidden text-morandi-3 fill-morandi-3/40 sm:block" />}
                  {n.hint && (
                    <span className="hidden text-[10px] text-text-muted px-1.5 py-0.5 rounded bg-bg-subtle sm:inline">
                      {n.hint}
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="px-2 py-3 border-t sm:px-3">
        <div className="flex items-center justify-center gap-2 px-0 py-1.5 sm:justify-start sm:px-2">
          <div className="w-7 h-7 rounded-full bg-morandi-3 flex items-center justify-center text-white text-xs font-medium">
            {user?.username?.[0]?.toUpperCase() || "?"}
          </div>
          <div className="hidden flex-1 min-w-0 sm:block">
            <div className="text-sm truncate">{user?.displayName || user?.username}</div>
            <div className="text-xs text-text-muted">DeepSeek V4</div>
          </div>
          <button
            onClick={() => {
              logout();
              nav("/login");
            }}
            title="退出"
            className="hidden text-text-muted hover:text-text-primary p-1 sm:block"
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>
    </aside>
  );
}
