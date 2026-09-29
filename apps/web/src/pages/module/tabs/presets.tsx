// 场景预设 tab：复用之前的卡片，点击跳本模块的 compare tab
import { useNavigate } from "react-router-dom";
import { Zap, AlertTriangle, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ModuleData, Preset } from "../types";

export function PresetsTab({ mod }: { mod: ModuleData }) {
  const navigate = useNavigate();

  function applyPreset(p: Preset) {
    if (p.target === "compare") {
      const params = new URLSearchParams();
      if (p.metricId) params.set("metricId", p.metricId);
      if (p.dimensionId) params.set("dimensionId", p.dimensionId);
      if (p.period) params.set("period", p.period);
      const qs = params.toString();
      navigate(`/module/${mod.code}/compare${qs ? `?${qs}` : ""}`);
    } else if (p.target === "board") {
      navigate(`/board`);
    }
  }

  if (!mod.presets || mod.presets.length === 0) {
    return <div className="text-sm text-text-muted">未配置场景预设</div>;
  }

  return (
    <div>
      <div className="text-xs text-text-muted mb-3">
        一键跳到对比 tab 并预填参数。预设在模块 JSON 的 <code>presets[]</code> 字段声明。
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {mod.presets.map((p) => {
          const isWarn = p.emphasis === "warning";
          const isInfo = p.emphasis === "info";
          const Icon = isWarn ? AlertTriangle : isInfo ? Info : Zap;
          return (
            <button
              key={p.key}
              onClick={() => applyPreset(p)}
              title={p.description ?? ""}
              className={cn(
                "card p-3 text-left hover:shadow-md transition group",
                isWarn && "border-l-4 border-l-morandi-rose",
                isInfo && "border-l-4 border-l-morandi-2",
                !isWarn && !isInfo && "border-l-4 border-l-morandi-3",
              )}
            >
              <div className="flex items-start gap-2">
                <Icon
                  size={14}
                  className={cn(
                    "mt-0.5 shrink-0",
                    isWarn && "text-morandi-rose",
                    isInfo && "text-morandi-2",
                    !isWarn && !isInfo && "text-morandi-3",
                  )}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium group-hover:text-morandi-3 transition">
                    {p.label}
                  </div>
                  {p.description && (
                    <div className="text-xs text-text-muted mt-0.5 line-clamp-2">
                      {p.description}
                    </div>
                  )}
                  <div className="text-[10px] text-text-muted mt-1 font-mono">
                    {p.target}
                    {p.metricId && ` · ${p.metricId}`}
                    {p.dimensionId && ` × ${p.dimensionId}`}
                    {p.period && ` · ${p.period}`}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
