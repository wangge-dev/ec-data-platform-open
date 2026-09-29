// 模块管理首页 - 卡片网格（V0.18+ 重构）
// 每张卡片显示模块概要 + 能力徽章；点击进入 /module/:code 工作台
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Boxes,
  Database,
  Link2,
  Sparkles,
  TrendingUp,
  Bell,
  Zap,
  Layers,
  FileCode,
  BookOpen,
  X,
  Upload,
  MousePointerClick,
  Compass,
  ArrowRight,
  Plus,
  ChevronDown,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { filterRetiredModules, type ModuleData } from "./types";
import { AiModuleGeneratorModal } from "./ai-generator";
import { ModuleBuilderDialog } from "./module-builder/ModuleBuilderDialog";

// 模块图标按 code 关键词映射（订单/库存/成本/广告 等）
function moduleEmoji(code: string): string {
  if (code.includes("order")) return "🛒";
  if (code.includes("inventory") || code.includes("stock")) return "📦";
  if (code.includes("cost") || code.includes("finance")) return "💰";
  if (code.includes("ad")) return "📢";
  if (code.includes("traffic") || code.includes("visit")) return "📈";
  if (code.includes("cs") || code.includes("service")) return "💬";
  return "📊";
}

export function ModulePage() {
  const [showGuide, setShowGuide] = useState(false);
  const [showAiGen, setShowAiGen] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);

  const { data: mods, isLoading, error } = useQuery({
    queryKey: ["modules"],
    queryFn: async () => {
      const r: any = await api.get("/modules");
      return filterRetiredModules(r.data as ModuleData[]);
    },
  });

  if (isLoading) return <div className="text-text-muted text-sm p-6">加载中…</div>;
  if (error) return <div className="text-red-600 text-sm p-6">加载失败：{String(error)}</div>;

  return (
    <div className="space-y-5">
      <ModuleBuilderDialog
        open={showBuilder}
        onOpenChange={setShowBuilder}
        allowSourceSelection
      />
      {showGuide && <GuideModal onClose={() => setShowGuide(false)} />}
      {showAiGen && <AiModuleGeneratorModal onClose={() => setShowAiGen(false)} />}

      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Boxes size={22} className="text-morandi-3" />
            模块管理
          </h1>
          <p className="text-text-muted text-sm mt-1">
            每类业务一个工作台；上传文件、对应字段后即可自动归入并持续更新
          </p>
        </div>
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={() => setShowBuilder(true)}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-md bg-morandi-3 px-3.5 py-2 text-sm text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40"
          >
            <Plus size={16} />
            新建模块
          </button>
          <details className="group relative">
            <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1.5 rounded-md border px-3 py-2 text-sm text-text-secondary transition hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40">
              高级帮助
              <ChevronDown size={14} className="transition group-open:rotate-180" />
            </summary>
            <div className="absolute right-0 z-20 mt-1 w-52 rounded-md border bg-bg-card p-1 shadow-lg">
              <button
                type="button"
                onClick={() => setShowAiGen(true)}
                className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm hover:bg-bg-subtle"
              >
                <Sparkles size={15} />
                AI 辅助生成
              </button>
              <button
                type="button"
                onClick={() => setShowGuide(true)}
                className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm hover:bg-bg-subtle"
              >
                <BookOpen size={15} />
                使用说明
              </button>
            </div>
          </details>
        </div>
      </header>

      {/* 5 秒上手流程卡 */}
      <QuickStartCard />

      {!mods || mods.length === 0 ? (
        <div className="card p-10 text-center">
          <Boxes size={36} className="mx-auto text-text-muted mb-3" />
          <div className="text-sm text-text-muted">还没有任何模块</div>
          <div className="text-xs text-text-muted mt-1">
            上传业务文件后即可自己创建模块
          </div>
          <button
            type="button"
            onClick={() => setShowBuilder(true)}
            className="mt-4 inline-flex min-h-10 items-center gap-1.5 rounded-md bg-morandi-3 px-3.5 py-2 text-sm text-white hover:opacity-90"
          >
            <Plus size={16} />
            新建模块
          </button>
        </div>
      ) : (
        <CategorizedGrid mods={mods} onCreate={() => setShowBuilder(true)} />
      )}
    </div>
  );
}

// 5 秒上手流程卡：让新人/朋友进来一眼明白怎么用
function QuickStartCard() {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    return localStorage.getItem("module-quickstart-collapsed") === "1";
  });

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem("module-quickstart-collapsed", next ? "1" : "0");
  }

  if (collapsed) {
    return (
      <button
        onClick={toggle}
        className="text-xs text-text-muted hover:text-morandi-3 inline-flex items-center gap-1"
      >
        <Compass size={12} />
        展开「5 秒上手」流程提示
      </button>
    );
  }

  const steps: Array<{ icon: any; title: string; desc: string; to?: string }> = [
    {
      icon: Upload,
      title: "1. 上传文件",
      desc: "把 Excel/CSV 上传到「数据」页，未识别的文件可直接新建模块",
      to: "/data",
    },
    {
      icon: MousePointerClick,
      title: "2. 进模块工作台",
      desc: "点本页任一卡片，查看总览、对比、预警和分析",
    },
    {
      icon: Compass,
      title: "3. 跨模块视角",
      desc: "去「分析中心」一眼看到所有未处理预警 + 各模块对比入口",
      to: "/analytics",
    },
  ];

  return (
    <div className="card p-4 bg-morandi-1/10 border-morandi-3/30">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <Compass size={16} className="text-morandi-3" />
          <span className="text-sm font-medium">5 秒上手</span>
          <span className="text-xs text-text-muted">新人进来先看这里</span>
        </div>
        <button
          onClick={toggle}
          className="text-text-muted hover:text-text-primary text-xs"
          title="收起（记住选择）"
        >
          收起 ✕
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {steps.map((s, i) => {
          const Icon = s.icon;
          const Wrap: any = s.to ? Link : "div";
          const wrapProps = s.to ? { to: s.to } : {};
          return (
            <Wrap
              key={i}
              {...wrapProps}
              className={cn(
                "rounded-md p-3 bg-bg-card border border-bg-subtle",
                s.to && "hover:border-morandi-3/50 hover:shadow-sm transition cursor-pointer block",
              )}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <Icon size={13} className="text-morandi-3" />
                <span className="text-xs font-medium">{s.title}</span>
                {s.to && <ArrowRight size={10} className="text-text-muted ml-auto" />}
              </div>
              <div className="text-xs text-text-muted leading-relaxed">{s.desc}</div>
            </Wrap>
          );
        })}
      </div>
      <div className="mt-3 text-xs text-text-muted">
        <span className="inline-flex items-center gap-1">
          <Link2 size={11} />
          关联关系
        </span>
        ：模块可借用品牌、成本等维护表补全业务字段；进入工作台可查看具体关系。
      </div>
    </div>
  );
}

// 按 category 分组渲染模块卡片
function CategorizedGrid({
  mods,
  onCreate,
}: {
  mods: ModuleData[];
  onCreate: () => void;
}) {
  // 分组：category 相同的放一起，未声明的进"未分类"
  const groups = new Map<string, { label: string; items: ModuleData[] }>();
  for (const m of mods) {
    const key = m.category ?? "_uncategorized";
    const label = m.categoryLabel ?? (m.category ? m.category : "未分类");
    const g = groups.get(key);
    if (g) {
      g.items.push(m);
    } else {
      groups.set(key, { label, items: [m] });
    }
  }
  // 排序：分类按业务相关度排（shop_ops 在前），未分类垫底
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === "_uncategorized") return 1;
    if (b === "_uncategorized") return -1;
    return 0;
  });

  return (
    <div className="space-y-6">
      {sortedKeys.map((key) => {
        const g = groups.get(key)!;
        return (
          <section key={key}>
            <h2 className="text-sm font-medium mb-3 flex items-center gap-2">
              <span className="text-text-primary">{g.label}</span>
              <span className="text-xs text-text-muted">（{g.items.length}）</span>
              <div className="flex-1 h-px bg-bg-subtle" />
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {g.items.map((m) => (
                <ModuleCard key={m.code} mod={m} />
              ))}
            </div>
          </section>
        );
      })}
      <AddModuleHint onCreate={onCreate} />
    </div>
  );
}

function AddModuleHint({ onCreate }: { onCreate: () => void }) {
  return (
    <button
      type="button"
      onClick={onCreate}
      className="card flex min-h-14 w-full items-center justify-center gap-2 border-2 border-dashed border-bg-subtle p-4 text-sm text-text-secondary transition hover:border-morandi-3/40 hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40"
    >
      <Plus size={16} className="text-morandi-3" />
      新建模块并归入业务文件
    </button>
  );
}

function ModuleCard({ mod }: { mod: ModuleData }) {
  const allJoins = mod.joins ?? (mod.join ? [mod.join] : []);
  const computedCount = mod.columns.filter((c) => c.computed).length;

  return (
    <Link
      to={`/module/${mod.code}`}
      className={cn(
        "card p-5 hover:shadow-lg transition group block",
        !mod.enabled && "opacity-50",
      )}
    >
      {/* 头 */}
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-2xl leading-none">{moduleEmoji(mod.code)}</span>
          <div>
            <div className="font-semibold text-base group-hover:text-morandi-3 transition">
              {mod.name}
            </div>
            <code className="text-[10px] text-text-muted">{mod.code}</code>
          </div>
        </div>
        <div className="text-right text-xs text-text-muted shrink-0">
          <div className="font-mono text-sm text-text-primary">
            {(mod.totalRows ?? 0).toLocaleString()}
          </div>
          <div>行</div>
        </div>
      </div>

      {/* 描述 */}
      <div className="text-xs text-text-muted line-clamp-2 mb-3 min-h-[2.4em]">
        {mod.description}
      </div>

      {/* 元信息 */}
      <div className="flex items-center gap-1.5 mb-3 text-[11px] text-text-muted flex-wrap">
        <span className="inline-flex items-center gap-0.5">
          <Layers size={10} />
          {mod.platforms.length} 平台
        </span>
        <span>·</span>
        <span className="inline-flex items-center gap-0.5">
          <Database size={10} />
          {mod.columns.length} 列
        </span>
        {mod.hasTransform && (
          <>
            <span>·</span>
            <span className="inline-flex items-center gap-0.5">
              <FileCode size={10} />
              钩子
            </span>
          </>
        )}
      </div>

      {/* 能力徽章 */}
      <div className="flex flex-wrap gap-1.5">
        {mod.timeKey && (
          <Badge icon={TrendingUp} text="可对比" color="info" />
        )}
        {(mod.alerts?.length ?? 0) > 0 && (
          <Badge
            icon={Bell}
            text={`${mod.alerts!.length} 预警`}
            color="warning"
          />
        )}
        {(mod.presets?.length ?? 0) > 0 && (
          <Badge
            icon={Zap}
            text={`${mod.presets!.length} 预设`}
            color="neutral"
          />
        )}
        {allJoins.length > 0 && (
          <Badge icon={Link2} text={`关联 ${allJoins.length}`} color="neutral" />
        )}
        {computedCount > 0 && (
          <Badge icon={Sparkles} text={`${computedCount} 计算列`} color="neutral" />
        )}
        {(mod.referencedBy?.length ?? 0) > 0 && (
          <Badge
            icon={Link2}
            text={`被借 ${mod.referencedBy!.length}`}
            color="info"
          />
        )}
      </div>
    </Link>
  );
}

function Badge({
  icon: Icon,
  text,
  color,
}: {
  icon: any;
  text: string;
  color: "warning" | "info" | "neutral";
}) {
  return (
    <span
      className={cn(
        "text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-0.5",
        color === "warning" && "bg-morandi-rose/15 text-morandi-rose",
        color === "info" && "bg-morandi-2/20 text-morandi-3",
        color === "neutral" && "bg-bg-subtle text-text-secondary",
      )}
    >
      <Icon size={9} />
      {text}
    </span>
  );
}

function GuideModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="module-guide-heading"
    >
      <div className="card max-h-[80vh] w-full max-w-lg overflow-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 id="module-guide-heading" className="text-lg font-semibold flex items-center gap-2">
            <BookOpen size={18} className="text-morandi-3" />
            新建模块使用说明
          </h2>
          <button
            type="button"
            aria-label="关闭使用说明"
            onClick={onClose}
            className="rounded p-2 text-text-muted hover:bg-bg-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40"
          >
            <X size={18} />
          </button>
        </div>
        <div className="text-sm space-y-4 text-text-secondary">
          <div>
            <h3 className="font-medium text-text-primary mb-2">什么是模块</h3>
            <p>
              一个模块对应一类业务数据，例如拼多多销售、库存或广告花费。完成创建后，
              系统会生成工作台和默认图表。
            </p>
          </div>
          <div>
            <h3 className="font-medium text-text-primary mb-2">四步完成</h3>
            <ol className="list-decimal space-y-1 pl-5">
              <li>选择同一类未归入文件并填写模块名称。</li>
              <li>逐项选择日期、金额、数量、商品等业务字段。</li>
              <li>如有状态字段，选择哪些状态计入统计。</li>
              <li>确认后保存，文件会自动归入并立即处理。</li>
            </ol>
          </div>
          <div className="border-t pt-3 text-xs text-text-muted">
            文件字段有变化时，系统会提示新增、对应或忽略，原有数据不会因此被删除。
          </div>
        </div>
      </div>
    </div>
  );
}
