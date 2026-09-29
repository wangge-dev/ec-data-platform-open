// 批量 ETL 操作面板（V0.23+，从原 SummaryPage 提炼）
// 跨模块批量动作：扫描文件夹 / 清空订单汇总 / 导出 Excel
// 之所以归到分析中心：这些动作对所有模块生效，不属于单个模块
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  FolderSearch,
  FolderCog,
  Download,
  Trash2,
  Loader2,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Info,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";

type EtlReport = {
  platform: string;
  fileName?: string;
  total?: number;
  inserted?: number;
  matched?: number;
  matchRate?: number;
  error?: string;
};

type ScanResult = {
  folder: string;
  fileCount: number;
  dict: { file?: string; table?: string; rows?: number; error?: string; existing?: boolean } | null;
  platforms: EtlReport[];
  skipped: string[];
};

export function BatchEtlPanel() {
  const qc = useQueryClient();
  const token = useAuth((s) => s.token);
  const [folderInput, setFolderInput] = useState("");
  const [editingFolder, setEditingFolder] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const { data: folderData } = useQuery({
    queryKey: ["etl-folder"],
    queryFn: async () => {
      const r: any = await api.get("/etl/folder");
      return r.data as { folder: string };
    },
  });

  const saveFolderMut = useMutation({
    mutationFn: (folder: string) => api.post("/etl/folder", { folder }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["etl-folder"] });
      setEditingFolder(false);
    },
  });

  const scanMut = useMutation({
    mutationFn: async () => {
      const r: any = await api.post("/etl/scan", {}, { timeout: 600000 });
      return r.data as ScanResult;
    },
    onSuccess: (d) => {
      setScanResult(d);
      qc.invalidateQueries({ queryKey: ["etl-summary"] });
      qc.invalidateQueries({ queryKey: ["analytics-overview"] });
      qc.invalidateQueries({ queryKey: ["modules"] });
    },
  });

  const clearMut = useMutation({
    mutationFn: async () => api.delete("/etl/clear"),
    onSuccess: () => {
      setScanResult(null);
      setConfirmClear(false);
      qc.invalidateQueries({ queryKey: ["etl-summary"] });
      qc.invalidateQueries({ queryKey: ["analytics-overview"] });
    },
  });

  // 兜底：重跑所有已上传文件的 ETL（批量上传时个别文件自动 ETL 漏跑/失败，一键补齐）
  const rerunMut = useMutation({
    mutationFn: async () => {
      const r: any = await api.post("/etl/rerun-all", {}, { timeout: 600000 });
      return r.data as { total: number; ran: number; skipped: number; failed: number };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["etl-summary"] });
      qc.invalidateQueries({ queryKey: ["analytics-overview"] });
      qc.invalidateQueries({ queryKey: ["modules"] });
      qc.invalidateQueries({ queryKey: ["charts"] });
      qc.invalidateQueries({ queryKey: ["chart-render"] });
    },
  });

  async function exportExcel() {
    const res = await fetch("/api/etl/export", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "统一销售汇总.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  }

  const folder = folderData?.folder || "";
  const totalErr = scanResult?.platforms.filter((p) => p.error).length ?? 0;

  return (
    <section className="space-y-3">
      <div className="card p-3 bg-morandi-2/10 border border-morandi-2/30 flex items-start gap-2 text-xs">
        <Info size={14} className="text-morandi-3 shrink-0 mt-0.5" />
        <div className="flex-1">
          <div className="font-medium text-text-primary mb-0.5">⚠ 仅本地开发可用</div>
          <div className="text-text-secondary">
            此扫描走的是 Docker 容器内的文件路径（后端预设的 scan_folder），容器通常看不到你 Windows 桌面的文件。
            <strong>推荐改用</strong>{" "}
            <Link to="/data" className="text-morandi-3 hover:underline">数据页 → 上传文件夹</Link>{" "}
            按钮——浏览器直接读你选的文件，上传后自动跑 ETL、自动出现在模块工作台。
          </div>
        </div>
      </div>
      <h2 className="text-sm font-medium flex items-center gap-1.5">
        <FolderSearch size={14} className="text-morandi-2" />
        批量 ETL 操作
        <span className="text-xs text-text-muted font-normal">
          · 扫描文件夹 / 一键跑所有模块 / 导出
        </span>
      </h2>

      {/* 扫描文件夹设置 */}
      <div className="card p-3 flex items-center gap-2 text-sm flex-wrap">
        <FolderCog size={14} className="text-morandi-slate" />
        <span className="text-text-secondary">扫描文件夹：</span>
        {!editingFolder ? (
          <>
            <code className="text-text-primary bg-bg-subtle px-2 py-0.5 rounded text-xs">
              {folder || "（未设置）"}
            </code>
            <button
              onClick={() => {
                setFolderInput(folder);
                setEditingFolder(true);
              }}
              className="text-xs text-morandi-slate hover:underline"
            >
              修改
            </button>
          </>
        ) : (
          <>
            <input
              value={folderInput}
              onChange={(e) => setFolderInput(e.target.value)}
              placeholder="e:\订单"
              className="flex-1 px-2 py-1 border rounded text-xs font-mono min-w-[200px]"
            />
            <button
              onClick={() => saveFolderMut.mutate(folderInput.trim())}
              className="text-xs px-2 py-1 rounded bg-morandi-3 text-white"
            >
              保存
            </button>
            <button
              onClick={() => setEditingFolder(false)}
              className="text-xs px-2 py-1 rounded border"
            >
              取消
            </button>
          </>
        )}
        <div className="flex-1" />
        <button
          onClick={() => scanMut.mutate()}
          disabled={!folder || scanMut.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-morandi-2 text-white text-sm rounded-md disabled:opacity-40 hover:opacity-90 transition"
        >
          {scanMut.isPending ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <FolderSearch size={13} />
          )}
          扫描跑 ETL
        </button>
        <button
          onClick={exportExcel}
          className="flex items-center gap-1.5 px-3 py-1.5 border text-sm rounded-md hover:bg-bg-subtle transition"
          title="导出 unified_sales 表为 Excel（按平台分 sheet）"
        >
          <Download size={13} />
          导出订单 Excel
        </button>
        <button
          onClick={() => rerunMut.mutate()}
          disabled={rerunMut.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 border border-morandi-2/50 text-morandi-2 text-sm rounded-md hover:bg-morandi-2/5 disabled:opacity-40"
          title="重跑所有已上传文件的 ETL——批量上传时个别文件漏跑/失败可一键补齐"
        >
          {rerunMut.isPending ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          重跑全部文件
        </button>
        {!confirmClear ? (
          <button
            onClick={() => setConfirmClear(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-morandi-rose/40 text-morandi-rose text-sm rounded-md hover:bg-morandi-rose/5"
            title="清空 unified_sales 汇总表（不会删原始 uf_* 文件表，仅清汇总结果）"
          >
            <Trash2 size={13} />
            清空订单汇总
          </button>
        ) : (
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-morandi-rose">确认清空？</span>
            <button
              onClick={() => clearMut.mutate()}
              disabled={clearMut.isPending}
              className="px-2 py-1 rounded bg-morandi-rose text-white"
            >
              {clearMut.isPending ? <Loader2 size={11} className="animate-spin" /> : "清空"}
            </button>
            <button
              onClick={() => setConfirmClear(false)}
              className="px-2 py-1 rounded border"
            >
              取消
            </button>
          </div>
        )}
      </div>

      {/* 扫描结果 */}
      {scanResult && (
        <div className="card p-3 space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={14} className="text-green-700" />
            <span>
              扫描 <code className="bg-bg-subtle px-1 rounded text-xs">{scanResult.folder}</code>{" "}
              · {scanResult.fileCount} 个文件 · {scanResult.platforms.length} 个被识别为模块订单
              {totalErr > 0 && (
                <span className="text-morandi-rose ml-1">· {totalErr} 个失败</span>
              )}
            </span>
          </div>
          {scanResult.dict && (
            <div className="text-xs text-text-muted">
              字典：{scanResult.dict.file ?? scanResult.dict.table} ·{" "}
              {scanResult.dict.rows ?? "?"} 行
              {scanResult.dict.error && (
                <span className="text-morandi-rose ml-1">{scanResult.dict.error}</span>
              )}
            </div>
          )}
          {scanResult.skipped.length > 0 && (
            <div className="text-xs text-text-muted flex items-start gap-1">
              <AlertTriangle size={11} className="mt-0.5 text-morandi-rose shrink-0" />
              <span>
                跳过 {scanResult.skipped.length} 个未匹配任何模块的文件：
                {scanResult.skipped.slice(0, 3).join(" / ")}
                {scanResult.skipped.length > 3 && " ..."}
              </span>
            </div>
          )}
          <div className="text-xs space-y-0.5 mt-1 max-h-32 overflow-y-auto">
            {scanResult.platforms.map((p, i) => (
              <div key={i} className={p.error ? "text-morandi-rose" : "text-text-muted"}>
                {p.platform} · {p.fileName} · {p.inserted ?? 0}/{p.total ?? 0} 行 matched=
                {p.matched ?? 0}
                {p.error && <span> · {p.error}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {rerunMut.data && (
        <div className="card p-3 text-sm flex items-center gap-2">
          <CheckCircle2 size={14} className="text-green-700" />
          <span>
            重跑完成：共 {rerunMut.data.total} 个文件 · 成功入库 {rerunMut.data.ran} · 跳过（字典/未匹配）{rerunMut.data.skipped}
            {rerunMut.data.failed > 0 && (
              <span className="text-morandi-rose ml-1">· 失败 {rerunMut.data.failed}</span>
            )}
          </span>
        </div>
      )}
    </section>
  );
}
