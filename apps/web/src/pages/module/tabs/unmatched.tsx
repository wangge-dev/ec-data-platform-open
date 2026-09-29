import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Download,
  FileQuestion,
  Loader2,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";

type UnmatchedData = {
  summary: {
    totalRows: number;
    matchedRows: number;
    unmatchedRows: number;
    unmatchedAmount: number;
    matchRate: number;
  };
  byPlatform: Array<{
    platform: string;
    totalRows: number;
    unmatchedRows: number;
    unmatchedAmount: number;
    unmatchedRate: number;
  }>;
  reasons: Array<{
    code: string;
    label: string;
    description: string;
    rows: number;
    amount: number;
  }>;
  samples: Array<{
    reason: string;
    platform: string;
    productId: string;
    sourceFile: string;
    rows: number;
    amount: number;
    sampleOrderNo: string;
  }>;
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
};

const currency = (value: number) =>
  new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2,
  }).format(value);

export function UnmatchedTab() {
  const token = useAuth((state) => state.token);
  const [offset, setOffset] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const limit = 50;

  const { data, isLoading, error } = useQuery({
    queryKey: ["orders-unmatched", limit, offset],
    queryFn: async () => {
      const response: any = await api.get(
        `/etl/unmatched?module=orders&limit=${limit}&offset=${offset}`,
      );
      return response.data as UnmatchedData;
    },
  });

  async function exportCsv() {
    setIsExporting(true);
    setExportError("");
    try {
      const response = await fetch("/api/etl/unmatched/export?module=orders", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error("导出失败，请稍后重试");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "未匹配订单.csv";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (downloadError: any) {
      setExportError(downloadError?.message ?? "导出失败，请稍后重试");
    } finally {
      setIsExporting(false);
    }
  }

  if (isLoading) {
    return (
      <div className="card p-10 text-sm text-text-muted flex items-center justify-center gap-2">
        <Loader2 size={16} className="animate-spin" />
        正在统计未匹配订单…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="card p-8 text-center">
        <AlertCircle size={28} className="mx-auto text-morandi-rose mb-2" />
        <div className="text-sm text-text-primary">未匹配数据加载失败</div>
        <div className="text-xs text-text-muted mt-1">{String(error ?? "暂无返回数据")}</div>
      </div>
    );
  }

  const hasNext = offset + limit < data.pagination.total;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-medium flex items-center gap-1.5">
            <FileQuestion size={15} className="text-morandi-2" />
            品牌未匹配诊断
          </h2>
          <p className="text-xs text-text-muted mt-1">
            这里展示维护表覆盖情况，不会自动修改订单字段映射或品牌维护表。
          </p>
        </div>
        <button
          type="button"
          onClick={exportCsv}
          disabled={isExporting || data.summary.unmatchedRows === 0}
          className="px-3 py-2 rounded-md bg-morandi-3 text-white text-xs inline-flex items-center gap-1.5 transition hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40"
        >
          {isExporting ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Download size={13} />
          )}
          导出未匹配 CSV
        </button>
      </div>

      {exportError && (
        <div className="card px-3 py-2 text-xs text-morandi-rose border-morandi-rose/30">
          {exportError}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="card p-4">
          <div className="text-xs text-text-muted">未匹配行数</div>
          <div className="text-2xl font-mono font-semibold mt-1">
            {data.summary.unmatchedRows.toLocaleString()}
          </div>
          <div className="text-[10px] text-text-muted mt-1">
            共 {data.summary.totalRows.toLocaleString()} 行订单
          </div>
        </div>
        <div className="card p-4">
          <div className="text-xs text-text-muted">未匹配销售额</div>
          <div className="text-2xl font-mono font-semibold mt-1">
            {currency(data.summary.unmatchedAmount)}
          </div>
          <div className="text-[10px] text-text-muted mt-1">只读诊断，不改变销售额口径</div>
        </div>
        <div className="card p-4">
          <div className="text-xs text-text-muted">整体品牌匹配率</div>
          <div className="text-2xl font-mono font-semibold mt-1">
            {data.summary.matchRate.toFixed(2)}%
          </div>
          <div className="text-[10px] text-text-muted mt-1">
            已匹配 {data.summary.matchedRows.toLocaleString()} 行
          </div>
        </div>
      </div>

      {data.summary.unmatchedRows === 0 ? (
        <div className="card p-10 text-center text-sm text-text-muted">
          当前订单均已匹配品牌，无需处理。
        </div>
      ) : (
        <>
          <section>
            <h3 className="text-sm font-medium mb-2">按平台汇总</h3>
            <div className="card overflow-x-auto">
              <table className="w-full min-w-[680px] text-sm">
                <thead className="bg-bg-subtle text-text-muted text-xs">
                  <tr>
                    <th className="px-3 py-2 text-left">平台</th>
                    <th className="px-3 py-2 text-right">未匹配行数</th>
                    <th className="px-3 py-2 text-right">平台总行数</th>
                    <th className="px-3 py-2 text-right">未匹配率</th>
                    <th className="px-3 py-2 text-right">未匹配销售额</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byPlatform.map((item) => (
                    <tr key={item.platform} className="border-t">
                      <td className="px-3 py-2 font-medium">{item.platform}</td>
                      <td className="px-3 py-2 text-right font-mono">
                        {item.unmatchedRows.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-text-secondary">
                        {item.totalRows.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {item.unmatchedRate.toFixed(2)}%
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {currency(item.unmatchedAmount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h3 className="text-sm font-medium mb-2">原因分类</h3>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {data.reasons.map((reason) => (
                <div key={reason.code} className="card p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">{reason.label}</div>
                      <p className="text-xs text-text-muted mt-1 leading-relaxed">
                        {reason.description}
                      </p>
                    </div>
                    <span className="text-lg font-mono font-semibold whitespace-nowrap">
                      {reason.rows.toLocaleString()}
                    </span>
                  </div>
                  <div className="text-xs text-text-secondary mt-3">
                    涉及销售额 {currency(reason.amount)}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between gap-3 mb-2">
              <h3 className="text-sm font-medium">
                未匹配样例
                <span className="text-xs text-text-muted font-normal ml-1.5">
                  共 {data.pagination.total.toLocaleString()} 组
                </span>
              </h3>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setOffset(Math.max(0, offset - limit))}
                  disabled={offset === 0}
                  className="p-1.5 rounded text-text-secondary hover:bg-bg-subtle disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40"
                  aria-label="上一页"
                >
                  <ChevronLeft size={14} />
                </button>
                <span className="text-xs text-text-muted px-1">
                  {Math.floor(offset / limit) + 1} /{" "}
                  {Math.max(1, Math.ceil(data.pagination.total / limit))}
                </span>
                <button
                  type="button"
                  onClick={() => setOffset(offset + limit)}
                  disabled={!hasNext}
                  className="p-1.5 rounded text-text-secondary hover:bg-bg-subtle disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40"
                  aria-label="下一页"
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
            <div className="card overflow-x-auto">
              <table className="w-full min-w-[980px] text-sm">
                <thead className="bg-bg-subtle text-text-muted text-xs">
                  <tr>
                    <th className="px-3 py-2 text-left">平台</th>
                    <th className="px-3 py-2 text-left">商品 ID</th>
                    <th className="px-3 py-2 text-left">原因</th>
                    <th className="px-3 py-2 text-left">来源文件</th>
                    <th className="px-3 py-2 text-right">行数</th>
                    <th className="px-3 py-2 text-right">销售额</th>
                    <th className="px-3 py-2 text-left">样例订单号</th>
                  </tr>
                </thead>
                <tbody>
                  {data.samples.map((sample, index) => {
                    const reason = data.reasons.find((item) => item.code === sample.reason);
                    return (
                      <tr
                        key={`${sample.platform}-${sample.productId}-${sample.sourceFile}-${index}`}
                        className="border-t"
                      >
                        <td className="px-3 py-2">{sample.platform}</td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {sample.productId || "（空）"}
                        </td>
                        <td className="px-3 py-2 text-xs">{reason?.label ?? sample.reason}</td>
                        <td className="px-3 py-2 text-xs text-text-secondary max-w-[260px] truncate">
                          {sample.sourceFile || "（未知）"}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {sample.rows.toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {currency(sample.amount)}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {sample.sampleOrderNo || "-"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
