import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, FileSpreadsheet } from "lucide-react";
import { api } from "@/lib/api";

type FileItem = {
  id: number;
  name: string;
  config: { rowCount: number; columns: Array<{ raw: string; name: string }> };
};

export function BrowseTab() {
  const [activeId, setActiveId] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  // 列表
  const { data: files } = useQuery({
    queryKey: ["files-for-browse"],
    queryFn: async () => {
      const r: any = await api.get("/files");
      return r.data as FileItem[];
    },
  });

  // 监听上传 tab 的"预览"按钮事件
  useEffect(() => {
    const handler = (e: any) => setActiveId(e.detail.id);
    window.addEventListener("ec:browse-file", handler as any);
    return () => window.removeEventListener("ec:browse-file", handler as any);
  }, []);

  // 默认选第一个
  useEffect(() => {
    if (files && files.length && activeId === null) {
      setActiveId(files[0].id);
    }
  }, [files, activeId]);

  const { data: preview, isLoading } = useQuery({
    queryKey: ["preview", activeId, page],
    queryFn: async () => {
      if (!activeId) return null;
      const r: any = await api.get(
        `/files/${activeId}/preview?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
      );
      return r.data as {
        total: number;
        rows: Array<Record<string, any>>;
        columns: Array<{ raw: string; name: string }>;
      };
    },
    enabled: !!activeId,
  });

  const activeFile = files?.find((f) => f.id === activeId);
  const totalPages = preview ? Math.ceil(preview.total / PAGE_SIZE) : 0;

  return (
    <div className="flex gap-5 h-[calc(100vh-260px)]">
      <aside className="w-64 shrink-0 space-y-1 overflow-y-auto">
        <div className="text-xs text-text-muted mb-2 px-1">数据集</div>
        {!files?.length && <div className="text-sm text-text-muted px-1">暂无文件</div>}
        {files?.map((f) => (
          <button
            key={f.id}
            onClick={() => {
              setActiveId(f.id);
              setPage(0);
            }}
            className={`w-full text-left px-3 py-2 rounded-md text-sm transition flex items-center gap-2 ${
              f.id === activeId
                ? "bg-morandi-2 text-white"
                : "hover:bg-bg-subtle text-text-secondary"
            }`}
          >
            <FileSpreadsheet size={14} className="shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="truncate font-medium">{f.name}</div>
              <div
                className={`text-xs ${
                  f.id === activeId ? "text-white/80" : "text-text-muted"
                }`}
              >
                {f.config.rowCount} 行
              </div>
            </div>
          </button>
        ))}
      </aside>

      <section className="flex-1 card overflow-hidden flex flex-col p-0">
        {!activeId && (
          <div className="flex-1 flex items-center justify-center text-sm text-text-muted">
            ← 左侧选择数据集
          </div>
        )}
        {activeId && (
          <>
            <div className="px-5 py-3 border-b flex items-baseline gap-2">
              <span className="text-sm font-medium text-text-primary truncate">
                {activeFile?.name || "未命名"}
              </span>
              <span className="text-xs text-text-muted shrink-0">
                {preview?.total ?? "—"} 行 · {preview?.columns.length ?? "—"} 列
              </span>
            </div>
            <div className="flex-1 overflow-auto">
              {isLoading && <div className="p-5 text-sm text-text-muted">加载中…</div>}
              {!isLoading && preview && (
                <table className="text-sm border-collapse">
                  <thead className="sticky top-0 z-10">
                    <tr>
                      <th className="border border-border bg-bg-subtle px-3 py-2 font-medium text-text-muted text-xs text-right whitespace-nowrap">
                        #
                      </th>
                      {preview.columns.map((c) => (
                        <th
                          key={c.name}
                          title={c.name}
                          className="border border-border bg-bg-subtle px-3 py-2 font-medium text-text-secondary text-left whitespace-nowrap"
                        >
                          {c.raw}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, i) => (
                      <tr key={row.id || i} className="hover:bg-morandi-1/5">
                        <td className="border border-border px-3 py-1.5 text-text-muted text-xs text-right whitespace-nowrap bg-bg-subtle/40">
                          {page * PAGE_SIZE + i + 1}
                        </td>
                        {preview.columns.map((c) => (
                          <td
                            key={c.name}
                            className="border border-border px-3 py-1.5 text-text-primary whitespace-nowrap"
                          >
                            {row[c.name] === null ? (
                              <span className="text-text-muted/60 italic">—</span>
                            ) : (
                              String(row[c.name])
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {preview && totalPages > 1 && (
              <div className="px-5 py-3 border-t flex items-center justify-between text-sm">
                <div className="text-text-muted text-xs">
                  第 {page + 1} / {totalPages} 页
                </div>
                <div className="flex gap-1">
                  <button
                    disabled={page === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    className="px-2 py-1 border rounded-md disabled:opacity-40 hover:bg-bg-subtle"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <button
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    className="px-2 py-1 border rounded-md disabled:opacity-40 hover:bg-bg-subtle"
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
