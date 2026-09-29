// AI 出图 tab：调用 /board/ai-chart 但锁定 scope=module
// 为避免重写 AiChartModal 这种 700+ 行的大组件，
// 直接复用 board 页的入口，开 modal 并预设 scope
import { useState } from "react";
import { Link } from "react-router-dom";
import { BarChart3, ExternalLink, ChevronRight } from "lucide-react";
import type { ModuleData } from "../types";
import { AiChartModal } from "@/pages/board/AiChartModal";

export function AiChartTab({ mod }: { mod: ModuleData }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-3">
      <div className="card p-5 space-y-3">
        <div className="flex items-start gap-3">
          <BarChart3 size={20} className="text-morandi-3 mt-0.5" />
          <div className="flex-1">
            <div className="font-medium text-sm mb-1">基于本模块的 AI 出图</div>
            <div className="text-xs text-text-muted">
              用自然语言提问 → AI 写 SQL 查
              <code className="mx-1 font-mono">{mod.outputTable}</code>
              → 自动选图型出图。生成的图可以保存到看板。
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setOpen(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-morandi-3 text-white text-sm rounded-md hover:opacity-90 transition"
          >
            <BarChart3 size={14} />
            开始提问
          </button>
          <Link
            to="/board"
            className="text-xs text-text-muted hover:text-morandi-3 inline-flex items-center gap-1"
          >
            <ExternalLink size={11} />
            去看板查看历史图
          </Link>
        </div>
      </div>

      <div className="card p-4">
        <div className="text-xs font-medium mb-2">💡 适合本模块的提问示例</div>
        <div className="space-y-1 text-xs text-text-secondary">
          {mod.timeKey && (
            <div className="flex items-center gap-1.5">
              <ChevronRight size={10} className="text-text-muted" />
              <span>按 {mod.timeKey} 看每日趋势</span>
            </div>
          )}
          {mod.platforms.length > 1 && (
            <div className="flex items-center gap-1.5">
              <ChevronRight size={10} className="text-text-muted" />
              <span>各平台对比</span>
            </div>
          )}
          {mod.columns.find((c) => c.computed) && (
            <div className="flex items-center gap-1.5">
              <ChevronRight size={10} className="text-text-muted" />
              <span>
                看 {mod.columns.filter((c) => c.computed).map((c) => c.label || c.name).join("/")} 计算字段
              </span>
            </div>
          )}
        </div>
      </div>

      {open && (
        <AiChartModal
          onClose={() => setOpen(false)}
          onSuccess={() => setOpen(false)}
          initialScope={{ kind: "module", value: mod.code }}
        />
      )}
    </div>
  );
}
