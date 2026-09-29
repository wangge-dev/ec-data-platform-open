// AI 分析 tab：跳到智能体页提示用户用'按模块'模式选当前模块
import { Link } from "react-router-dom";
import { Sparkles, ExternalLink, ChevronRight } from "lucide-react";
import type { ModuleData } from "../types";

export function AiAnalysisTab({ mod }: { mod: ModuleData }) {
  return (
    <div className="space-y-3">
      <div className="card p-5 space-y-3">
        <div className="flex items-start gap-3">
          <Sparkles size={20} className="text-morandi-3 mt-0.5" />
          <div className="flex-1">
            <div className="font-medium text-sm mb-1">基于本模块的 AI 数据分析</div>
            <div className="text-xs text-text-muted">
              对
              <code className="mx-1 font-mono">{mod.outputTable}</code>
              整表采样 → 喂给"数据分析"智能体生成洞察报告
              {(mod.joins?.length || mod.join) ? "（已 JOIN 字典字段）" : ""}
              。
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/agent"
            className="flex items-center gap-1.5 px-3.5 py-2 bg-morandi-3 text-white text-sm rounded-md hover:opacity-90 transition"
          >
            <Sparkles size={14} />
            打开智能体（选'数据分析'，scope 选'按模块 → {mod.name}'）
            <ExternalLink size={11} />
          </Link>
        </div>
      </div>

      <div className="card p-4">
        <div className="text-xs font-medium mb-2">💡 AI 会自动识别</div>
        <div className="space-y-1 text-xs text-text-secondary">
          <div className="flex items-center gap-1.5">
            <ChevronRight size={10} className="text-text-muted" />
            <span>模块描述：{mod.description}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <ChevronRight size={10} className="text-text-muted" />
            <span>{mod.columns.length} 个字段（含 hint）</span>
          </div>
          {(mod.joins?.length || mod.join) && (
            <div className="flex items-center gap-1.5">
              <ChevronRight size={10} className="text-text-muted" />
              <span>
                已 JOIN 字典：
                {(mod.joins ?? [mod.join!]).map((j) => j.label || j.dictRole).join("、")}
              </span>
            </div>
          )}
          {mod.timeKey && (
            <div className="flex items-center gap-1.5">
              <ChevronRight size={10} className="text-text-muted" />
              <span>时间字段：{mod.timeKey}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
