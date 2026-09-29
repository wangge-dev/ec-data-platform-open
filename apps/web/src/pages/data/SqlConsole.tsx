import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X, Play, Loader2, Table2, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ExternalSource } from "./ExternalSqlTab";

type TableInfo = { schema: string; name: string };
type QueryResult = { rows: Record<string, any>[]; columns: string[] };

export function SqlConsole({
  source,
  onClose,
}: {
  source: ExternalSource;
  onClose: () => void;
}) {
  const [sql, setSql] = useState("SELECT 1");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const {
    data: tables,
    isLoading: tablesLoading,
    refetch: refetchTables,
    error: tablesError,
  } = useQuery({
    queryKey: ["external-sql", source.id, "tables"],
    queryFn: async () => {
      const r: any = await api.get(`/external-sql/${source.id}/tables`);
      return r.data as TableInfo[];
    },
  });

  function quote(t: TableInfo) {
    // pg 区分 schema；mysql 库内单层
    return source.config.dialect === "pg" && t.schema && t.schema !== "public"
      ? `"${t.schema}"."${t.name}"`
      : `${t.name}`;
  }

  async function runQuery() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const r: any = await api.post(`/external-sql/${source.id}/query`, { sql, limit: 200 });
      setResult(r.data as QueryResult);
    } catch (e: any) {
      setError(e?.message ?? "查询失败");
    } finally {
      setRunning(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (!running) runQuery();
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-bg-card rounded-lg w-[1080px] max-w-full h-[78vh] shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-6 py-3.5 border-b shrink-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{source.name}</span>
            <span className="text-xs text-text-muted font-mono">
              {source.config.dialect} · {source.config.host}:{source.config.port}/
              {source.config.database}
            </span>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary">
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* 表清单 */}
          <aside className="w-56 border-r flex flex-col shrink-0">
            <div className="flex items-center justify-between px-3 py-2 border-b text-xs text-text-muted">
              <span>表清单</span>
              <button
                onClick={() => refetchTables()}
                className="hover:text-text-primary"
                title="刷新"
              >
                <RefreshCw size={12} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto py-1">
              {tablesLoading && (
                <div className="px-3 py-2 text-xs text-text-muted">加载中…</div>
              )}
              {tablesError && (
                <div className="px-3 py-2 text-xs text-red-600">
                  {(tablesError as any)?.message ?? "无法获取表清单"}
                </div>
              )}
              {tables?.map((t) => (
                <button
                  key={`${t.schema}.${t.name}`}
                  onClick={() => setSql(`SELECT * FROM ${quote(t)}`)}
                  className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left text-xs hover:bg-bg-subtle transition truncate"
                  title={`${t.schema}.${t.name}`}
                >
                  <Table2 size={12} className="text-morandi-slate shrink-0" />
                  <span className="truncate">{t.name}</span>
                </button>
              ))}
              {tables && tables.length === 0 && (
                <div className="px-3 py-2 text-xs text-text-muted">无表</div>
              )}
            </div>
          </aside>

          {/* SQL 编辑 + 结果 */}
          <main className="flex-1 flex flex-col min-w-0">
            <div className="p-3 border-b shrink-0">
              <textarea
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={4}
                spellCheck={false}
                className="w-full px-3 py-2 border rounded-md focus:outline-none focus:border-morandi-slate font-mono text-sm resize-none"
                placeholder="只读 SELECT，自动追加 LIMIT 200"
              />
              <div className="flex items-center justify-between mt-2">
                <span className="text-xs text-text-muted">
                  仅 SELECT · Ctrl/⌘ + Enter 执行
                </span>
                <button
                  onClick={runQuery}
                  disabled={running}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 text-sm bg-morandi-1 text-white rounded-md hover:opacity-90 disabled:opacity-50 transition"
                >
                  {running ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Play size={14} />
                  )}
                  执行
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto p-3">
              {error && (
                <div className="text-sm bg-red-50 text-red-600 rounded-md px-3 py-2 font-mono">
                  {error}
                </div>
              )}
              {!error && result && (
                <ResultTable result={result} />
              )}
              {!error && !result && !running && (
                <div className="text-text-muted text-sm text-center pt-12">
                  执行查询后在此显示结果
                </div>
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

function ResultTable({ result }: { result: QueryResult }) {
  if (result.columns.length === 0) {
    return <div className="text-text-muted text-sm">查询无返回列</div>;
  }
  return (
    <div className="space-y-2">
      <div className="text-xs text-text-muted">{result.rows.length} 行</div>
      <div className="overflow-auto border rounded-md">
        <table className="w-full text-xs">
          <thead className="bg-bg-subtle sticky top-0">
            <tr>
              {result.columns.map((c) => (
                <th
                  key={c}
                  className="px-3 py-2 text-left font-medium text-text-secondary whitespace-nowrap border-b"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={i} className={cn(i % 2 === 1 && "bg-bg-subtle/40")}>
                {result.columns.map((c) => (
                  <td
                    key={c}
                    className="px-3 py-1.5 whitespace-nowrap border-b border-bg-subtle font-mono text-text-secondary"
                  >
                    {formatCell(row[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatCell(v: any): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
