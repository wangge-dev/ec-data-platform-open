// 平台 tab：模块下的各平台 + 列覆盖
import { CheckCircle2, XCircle } from "lucide-react";
import type { ModuleData } from "../types";

function renderSource(s: string | string[]): string {
  if (Array.isArray(s)) return s.join(" / ");
  return s;
}

export function PlatformsTab({ mod }: { mod: ModuleData }) {
  return (
    <div className="space-y-3">
      <div className="text-xs text-text-muted">
        平台用 filePattern 正则匹配文件名识别。各平台叫法不同的列在 columnOverrides 里写。
      </div>
      <div className="grid grid-cols-2 gap-3">
        {mod.platforms.map((p) => (
          <div key={p.code} className="card p-4">
            <div className="flex items-start justify-between mb-2">
              <div>
                <div className="font-medium flex items-center gap-2">
                  {p.name}
                  <code className="text-xs px-1.5 py-0.5 rounded bg-bg-subtle text-text-secondary">
                    {p.code}
                  </code>
                </div>
                <div className="text-xs text-text-muted mt-0.5">
                  文件识别：
                  <code className="ml-1 font-mono">
                    /{p.filePattern}/{p.patternFlags ?? ""}
                  </code>
                </div>
              </div>
              {p.enabled ? (
                <CheckCircle2 size={14} className="text-green-700 shrink-0 mt-0.5" />
              ) : (
                <XCircle size={14} className="text-red-600 shrink-0 mt-0.5" />
              )}
            </div>
            {p.columnOverrides && Object.keys(p.columnOverrides).length > 0 && (
              <div className="mt-2 pt-2 border-t">
                <div className="text-xs text-text-muted mb-1">列覆盖：</div>
                <div className="space-y-0.5 text-xs">
                  {Object.entries(p.columnOverrides).map(([k, v]) => (
                    <div key={k} className="flex gap-1.5">
                      <code className="text-morandi-3">{k}</code>
                      <span className="text-text-muted">→</span>
                      <span className="text-text-secondary">{renderSource(v)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
