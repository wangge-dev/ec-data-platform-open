// JSON tab：读 /modules/:code/raw 显示完整 JSON + 复制/下载
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileJson, Copy, Download, Check } from "lucide-react";
import { api } from "@/lib/api";
import type { ModuleData } from "../types";

export function JsonTab({ mod }: { mod: ModuleData }) {
  const [copied, setCopied] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["module-raw", mod.code],
    queryFn: async () => {
      const r: any = await api.get(`/modules/${mod.code}/raw`);
      return r.data as { code: string; fileName: string; content: string };
    },
  });

  async function copyToClipboard() {
    if (!data?.content) return;
    try {
      await navigator.clipboard.writeText(data.content);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = data.content;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function downloadFile() {
    if (!data?.content) return;
    const blob = new Blob([data.content], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = data.fileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-2.5 border-b bg-bg-subtle/40 flex items-center gap-2 flex-wrap">
        <FileJson size={14} className="text-morandi-3" />
        <code className="text-xs px-1.5 py-0.5 rounded bg-bg-card text-text-secondary">
          {data?.fileName ?? `${mod.code}.json`}
        </code>
        <div className="flex-1" />
        <button
          onClick={copyToClipboard}
          disabled={!data}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border bg-bg-card hover:bg-bg-subtle disabled:opacity-40 transition"
        >
          {copied ? (
            <>
              <Check size={13} className="text-green-700" />
              <span className="text-green-700">已复制</span>
            </>
          ) : (
            <>
              <Copy size={13} />
              复制全部
            </>
          )}
        </button>
        <button
          onClick={downloadFile}
          disabled={!data}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border bg-bg-card hover:bg-bg-subtle disabled:opacity-40 transition"
        >
          <Download size={13} />
          下载文件
        </button>
      </div>
      <div className="overflow-auto max-h-[600px]">
        {isLoading ? (
          <div className="p-10 text-center text-sm text-text-muted">加载中…</div>
        ) : error ? (
          <div className="p-10 text-center text-sm text-red-600">加载失败：{String(error)}</div>
        ) : (
          <pre className="p-5 text-xs font-mono leading-relaxed whitespace-pre overflow-x-auto bg-bg-card">
            {data?.content}
          </pre>
        )}
      </div>
      <div className="px-4 py-3 border-t bg-bg-subtle/40 text-xs text-text-muted">
        📋 用法：复制 JSON + <code>docs/HOW_TO_ADD_MODULE.md</code> 一起发给 AI，
        让 AI 改完丢回 <code>apps/api/src/modules/</code> → restart api 生效。
      </div>
    </div>
  );
}
