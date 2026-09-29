import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  BadgeDollarSign,
  CalendarDays,
  CheckCircle2,
  Database,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Tags,
  UploadCloud,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type ApiEnvelope<T> = { ok: boolean; data: T; message?: string };

type RunSummary = {
  id: number;
  status: string;
  scope_key: string;
  input_batch_ids: unknown[];
  last_checkpoint_step: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  step_count: number;
  dq_count: number;
  unresolved_block_count: number;
  recon_count: number;
  failed_recon_count: number;
  l4_count: number;
  publish_versions: Array<{ id: number; versionNo: number; status: string; publishedAt: string | null }>;
};

type RunDetail = {
  run: RunSummary;
  steps: Array<{
    step_key: string;
    attempt: number;
    status: string;
    rows_in: number | null;
    rows_out: number | null;
    error_code: string | null;
  }>;
  dqEvents: Array<{
    severity: string;
    code: string;
    source_id: number | null;
    row_no: number | null;
    payload: unknown;
    resolved_at: string | null;
  }>;
  reconResults: Array<{
    layer: string;
    metric: string;
    expected: string | null;
    actual: string | null;
    tolerance: string | null;
    passed: boolean;
  }>;
  l4Rows: Array<{
    id: number;
    publish_version_id: number | null;
    period: string;
    record_id: string;
    aggregation_key: string;
    gmv: string | null;
    front_profit: string | null;
    data_status: string;
  }>;
  publishVersions: Array<{
    id: number;
    version_no: number;
    status: string;
    source_run_id: number | null;
    published_at: string | null;
  }>;
};

type PublishRunResult = {
  version: {
    id: number;
    versionNo: number;
    status: string;
  };
  stagedRowCount: number;
  sourceIds: number[];
  idempotent: boolean;
};

type RollbackPublishResult = {
  rolledBackVersion: {
    id: number;
    versionNo: number;
    status: string;
  };
  restoredVersion: {
    id: number;
    versionNo: number;
    status: string;
  };
  rolledBackRowCount: number;
  restoredRowCount: number;
  idempotent: boolean;
};

type SourceFile = {
  id: number;
  name: string;
  config?: {
    frontProfitSourceFamily?: string;
    frontProfitValidation?: { schemaVersion?: string };
    originalFileName?: string;
    rowCount?: number;
  } | null;
};

const SOURCE_FAMILIES = [
  { value: "operator_assignment", label: "运营归属" },
  { value: "sales_fact", label: "销售事实" },
  { value: "cost_period", label: "成本期间" },
  { value: "cost_usage", label: "成本用量" },
  { value: "rebate", label: "返点" },
  { value: "fee_fact", label: "费用事实" },
  { value: "promotion_spend", label: "推广花费" },
] as const;

const SOURCE_INPUTS = [
  { key: "operatorAssignments", family: "operator_assignment", label: "运营归属", hint: "店铺、运营与生效时间" },
  { key: "sales", family: "sales_fact", label: "销售事实", hint: "订单、销售额与平台明细" },
  { key: "costPeriods", family: "cost_period", label: "成本期间", hint: "SKU 成本及生效区间" },
  { key: "costUsages", family: "cost_usage", label: "成本用量", hint: "出货或销量对应的成本用量" },
  { key: "rebates", family: "rebate", label: "返点", hint: "平台或供应商返点" },
  { key: "fees", family: "fee_fact", label: "费用事实", hint: "佣金、运费、税费等" },
  { key: "promotions", family: "promotion_spend", label: "推广花费", hint: "广告与投放消耗" },
] as const;

type SourceInputKey = (typeof SOURCE_INPUTS)[number]["key"];

const STATUS_LABELS: Record<string, string> = {
  manual: "人工结果为准",
  auto: "自动归集为准",
  queued: "等待运行",
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  skipped: "已跳过",
  recon_pending: "待确认对账",
  gated: "已通过发布门禁",
  draft: "草稿",
  validated: "已校验",
  published: "已发布",
  superseded: "已被新版本替代",
  rolled_back: "已回滚",
  passed: "通过",
  block: "阻断",
  warn: "提醒",
  allow: "正常",
  pending: "待处理",
};

const STEP_LABELS: Record<string, string> = {
  source_load: "读取并标准化来源",
  l3_stage: "计算利润明细",
  shadow_recon: "与人工结果影子对账",
  publish: "发布权威结果",
};

const RECON_LAYER_LABELS: Record<string, string> = {
  SALES_SOURCE_L1: "销售来源装载",
  OPERATOR_ASSIGNMENT_L1: "运营归属装载",
  OPERATOR_APPLIED_L1: "运营归属匹配",
  COST_SOURCE_L1: "成本期间装载",
  COST_APPLIED_L1: "商品成本匹配",
  REBATE_SOURCE_L1: "返点来源装载",
  FEE_SOURCE_L1: "费用来源装载",
  FEE_AUTHORITY_L1: "费用权威口径",
  PROMOTION_SOURCE_L1: "推广来源装载",
  L3_L4: "利润明细与汇总",
  L4_CONTRACT: "28 字段发布合同",
  SHADOW_MANUAL_AUTO: "人工与自动结果对账",
};

const METRIC_LABELS: Record<string, string> = {
  row_count: "记录数",
  quantity_sum: "数量合计",
  gmv_sum: "销售额合计",
  shipment_value_sum: "发货金额合计",
  product_cost_sum: "商品成本合计",
  unit_cost_sum: "单位成本合计",
  fill_order_amount_sum: "补单金额合计",
  fill_order_product_cost_sum: "补单商品成本合计",
  fill_order_quantity_sum: "补单数量合计",
  promotion_fee_sum: "推广费合计",
  amount_sum: "金额合计",
  aggregation_key_count: "业务聚合键数量",
  canonical_rows_contract: "发布字段合同",
  aggregation_key_set: "业务聚合键集合",
  front_profit_sum: "前台利润合计",
  row_mismatch_count: "明细不一致数量",
};

const TECHNICAL_CODE_LABELS: Record<string, string> = {
  FRONT_PROFIT_SHADOW_MISSING_AUTO: "人工结果存在，但自动结果缺失",
  FRONT_PROFIT_SHADOW_EXTRA_AUTO: "自动结果存在，但人工结果缺失",
  FRONT_PROFIT_SHADOW_AMOUNT_MISMATCH: "人工与自动金额不一致",
  FRONT_PROFIT_SOURCE_NOT_FOUND: "找不到所选来源",
  FRONT_PROFIT_SOURCE_NOT_FILE: "所选来源不是文件",
  FRONT_PROFIT_SOURCE_FAMILY_MISMATCH: "来源类型与文件归类不一致",
  FRONT_PROFIT_SOURCE_TABLE_MISSING: "来源数据表不存在",
  FRONT_PROFIT_SOURCE_HEADER_MISSING: "来源缺少必需字段",
  FRONT_PROFIT_SOURCE_PERIOD_MISMATCH: "来源数据不属于所选月份",
  FRONT_PROFIT_MANUAL_BASELINE_UNVALIDATED: "人工标准结果未通过 28 字段校验",
  REBATE_KEY_DUPLICATE: "补单业务键重复",
  FEE_AUTHORITY_MISSING: "费用缺少权威来源",
  OWNER_MISSING: "缺少运营归属",
  OWNER_AMBIGUOUS: "运营归属不唯一",
  COST_PERIOD_MISSING: "找不到有效成本",
  COST_PERIOD_OVERLAP: "成本生效期重叠",
};

function statusLabel(status: string) {
  return STATUS_LABELS[status] ?? status;
}

function stepLabel(step: string) {
  return STEP_LABELS[step] ?? step;
}

function reconMetricLabel(metric: string) {
  const sourceMatch = /^source_(\d+)_(.+)$/.exec(metric);
  if (sourceMatch) {
    return `来源 ${sourceMatch[1]} · ${METRIC_LABELS[sourceMatch[2]] ?? "核对指标"}`;
  }
  const periodMatch = /^period_(\d{4}-\d{2})_(.+)$/.exec(metric);
  if (periodMatch) {
    return `${periodMatch[1]} · ${METRIC_LABELS[periodMatch[2]] ?? "核对指标"}`;
  }
  return METRIC_LABELS[metric] ?? "核对指标";
}

function technicalCodeLabel(code: string | null | undefined) {
  if (!code) return "-";
  return TECHNICAL_CODE_LABELS[code] ?? "处理异常，请查看运行日志";
}

function setSourceIdSelected(value: string, sourceId: number, selected: boolean): string {
  const next = new Set(parseIds(value));
  if (selected) next.add(sourceId);
  else next.delete(sourceId);
  return [...next].sort((left, right) => left - right).join(",");
}

function currentPeriod() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function parseIds(value: string): number[] {
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map(Number)
    .filter((item) => Number.isSafeInteger(item) && item > 0);
}

function parseOptionalId(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function idsFromBatch(input: unknown): number[] {
  const items = Array.isArray(input) ? input : [];
  return [...new Set(items
    .map((item) => /^source:(\d+)$/.exec(String(item ?? "").trim())?.[1])
    .filter(Boolean)
    .map(Number))].sort((left, right) => left - right);
}

function dateText(value: string | null | undefined) {
  return value ? value.replace("T", " ").slice(0, 19) : "-";
}

function errorText(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? error);
  }
  return String(error);
}

function statusTone(status: string) {
  if (status === "published" || status === "succeeded") return "bg-green-50 text-green-700 border-green-200";
  if (status === "failed" || status === "rolled_back") return "bg-red-50 text-red-700 border-red-200";
  if (status === "recon_pending" || status === "validated" || status === "gated") {
    return "bg-blue-50 text-blue-700 border-blue-200";
  }
  return "bg-bg-subtle text-text-secondary border-border";
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={cn("inline-flex items-center rounded border px-2 py-0.5 text-xs", statusTone(status))}>
      {statusLabel(status)}
    </span>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <label className="text-xs font-medium text-text-secondary">{children}</label>;
}

export function FrontProfitPage() {
  const qc = useQueryClient();
  const [period, setPeriod] = useState(currentPeriod());
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [familySourceId, setFamilySourceId] = useState("");
  const [family, setFamily] = useState<(typeof SOURCE_FAMILIES)[number]["value"]>("sales_fact");
  const [manualBaselineSourceId, setManualBaselineSourceId] = useState("");
  const [publishSourceId, setPublishSourceId] = useState("");
  const [publishSourceIds, setPublishSourceIds] = useState("");
  const [publishIdempotencyKey, setPublishIdempotencyKey] = useState("");
  const [rollbackReason, setRollbackReason] = useState("恢复上一版已验收结果");
  const [sourceValues, setSourceValues] = useState<Record<string, string>>({
    operatorAssignments: "",
    sales: "",
    costPeriods: "",
    costUsages: "",
    rebates: "",
    fees: "",
    promotions: "",
  });

  const authorityQuery = useQuery({
    queryKey: ["front-profit-authority", period],
    queryFn: async () => {
      const r = await api.get(`/front-profit/authority/${period}`) as ApiEnvelope<{
        authority: "manual" | "auto";
        closeDay: number;
        reopened: boolean;
      }>;
      return r.data;
    },
  });

  const filesQuery = useQuery({
    queryKey: ["files"],
    queryFn: async () => {
      const r = await api.get("/files") as ApiEnvelope<SourceFile[]>;
      return r.data;
    },
  });

  const sourceFilesByFamily = useMemo(() => {
    const grouped = new Map<string, SourceFile[]>();
    for (const file of filesQuery.data ?? []) {
      const sourceFamily = file.config?.frontProfitSourceFamily;
      if (!sourceFamily) continue;
      const familyFiles = grouped.get(sourceFamily) ?? [];
      familyFiles.push(file);
      grouped.set(sourceFamily, familyFiles);
    }
    return grouped;
  }, [filesQuery.data]);

  const baselineFiles = useMemo(
    () => (filesQuery.data ?? []).filter(
      (file) => file.config?.frontProfitValidation?.schemaVersion === "front-profit-standard/v1",
    ),
    [filesQuery.data],
  );

  const runsQuery = useQuery({
    queryKey: ["front-profit-runs", period],
    queryFn: async () => {
      const r = await api.get(`/front-profit/runs?period=${encodeURIComponent(period)}`) as ApiEnvelope<{
        rows: RunSummary[];
      }>;
      return r.data.rows;
    },
  });

  useEffect(() => {
    if (!selectedRunId && runsQuery.data?.length) {
      setSelectedRunId(runsQuery.data[0].id);
    }
  }, [runsQuery.data, selectedRunId]);

  const selectedRun = useMemo(
    () => runsQuery.data?.find((run) => run.id === selectedRunId) ?? null,
    [runsQuery.data, selectedRunId],
  );
  const selectedRunSourceIds = selectedRun ? idsFromBatch(selectedRun.input_batch_ids) : [];
  const selectedRunSourceKey = `${selectedRun?.id ?? ""}:${selectedRunSourceIds.join(",")}`;

  useEffect(() => {
    setPublishSourceIds(selectedRunSourceIds.join(","));
    setPublishSourceId(selectedRunSourceIds.length ? String(selectedRunSourceIds[0]) : "");
  }, [selectedRunSourceKey]);

  useEffect(() => {
    if (!selectedRun) {
      setPublishIdempotencyKey("");
      return;
    }
    setPublishIdempotencyKey(`front-profit:${selectedRun.scope_key}:run:${selectedRun.id}`);
  }, [selectedRun?.id, selectedRun?.scope_key]);

  const detailQuery = useQuery({
    queryKey: ["front-profit-run-detail", selectedRunId],
    enabled: selectedRunId != null,
    queryFn: async () => {
      const r = await api.get(`/front-profit/runs/${selectedRunId}`) as ApiEnvelope<RunDetail>;
      return r.data;
    },
  });

  const selectedPublishedVersion = useMemo(
    () => detailQuery.data?.publishVersions.find((version) => version.status === "published") ?? null,
    [detailQuery.data?.publishVersions],
  );

  const setAuthority = useMutation({
    mutationFn: async (authority: "manual" | "auto") => {
      const r = await api.put(`/front-profit/authority/${period}`, {
        authority,
        reason: "前台利润页面切换权威来源",
      }) as ApiEnvelope<unknown>;
      return r.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["front-profit-authority", period] }),
  });

  const markFamily = useMutation({
    mutationFn: async () => {
      const sourceId = parseOptionalId(familySourceId);
      if (!sourceId) throw new Error("请选择需要归类的文件");
      const r = await api.put(`/front-profit/source-family/${sourceId}`, { family }) as ApiEnvelope<unknown>;
      return r.data;
    },
    onSuccess: () => {
      const sourceId = parseOptionalId(familySourceId);
      const target = SOURCE_INPUTS.find((input) => input.family === family);
      if (sourceId && target) {
        setSourceValues((current) => ({
          ...current,
          [target.key]: setSourceIdSelected(current[target.key], sourceId, true),
        }));
      }
      qc.invalidateQueries({ queryKey: ["files"] });
    },
  });

  const draftRun = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        period,
        sources: Object.fromEntries(SOURCE_INPUTS.map((item) => [item.key, parseIds(sourceValues[item.key])])),
        manualBaselineSourceId: parseOptionalId(manualBaselineSourceId),
      };
      const r = await api.post("/front-profit/draft-runs", payload) as ApiEnvelope<{
        runId: number;
      }>;
      return r.data;
    },
    onSuccess: (data) => {
      setSelectedRunId(data.runId);
      qc.invalidateQueries({ queryKey: ["front-profit-runs", period] });
    },
  });

  const publishRun = useMutation({
    mutationFn: async () => {
      const runId = selectedRunId;
      const sourceId = parseOptionalId(publishSourceId);
      if (!runId) throw new Error("请选择一条试算记录");
      if (!sourceId) throw new Error("当前记录缺少结果归档来源，请重新生成试算");
      const payload: Record<string, unknown> = {
        period,
        runId,
        publishSourceId: sourceId,
        sourceIds: parseIds(publishSourceIds),
        manualBaselineSourceId: parseOptionalId(manualBaselineSourceId),
      };
      const idempotencyKey = publishIdempotencyKey.trim();
      if (idempotencyKey) payload.idempotencyKey = idempotencyKey;
      const r = await api.post("/front-profit/publish-runs", payload) as ApiEnvelope<PublishRunResult>;
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["front-profit-runs", period] });
      qc.invalidateQueries({ queryKey: ["front-profit-run-detail", selectedRunId] });
    },
  });

  const rollbackPublish = useMutation({
    mutationFn: async () => {
      const versionId = selectedPublishedVersion?.id;
      if (!versionId) throw new Error("当前试算记录没有可恢复的已发布版本");
      const payload: Record<string, unknown> = {
        period,
      };
      const reason = rollbackReason.trim();
      if (reason) payload.reason = reason;
      const r = await api.post(
        `/front-profit/publish-versions/${versionId}/rollback`,
        payload,
      ) as ApiEnvelope<RollbackPublishResult>;
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["front-profit-runs", period] });
      qc.invalidateQueries({ queryKey: ["front-profit-run-detail", selectedRunId] });
    },
  });

  const failedRecon = (detailQuery.data?.reconResults ?? []).filter((row) => !row.passed);
  const selectedSourceCount = SOURCE_INPUTS.reduce(
    (total, input) => total + parseIds(sourceValues[input.key]).length,
    0,
  );
  const classifiedSourceCount = (filesQuery.data ?? []).filter(
    (file) => file.config?.frontProfitSourceFamily,
  ).length;

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <BadgeDollarSign size={22} className="text-morandi-3" />
            前台利润
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            汇集销售、成本和费用，先试算对账，确认无误后再发布权威利润结果
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            runsQuery.refetch();
            if (selectedRunId) detailQuery.refetch();
          }}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-md border px-3 py-2 text-sm text-text-secondary transition hover:bg-bg-subtle"
        >
          <RefreshCw size={15} />
          刷新
        </button>
      </header>

      <section className="grid gap-3 rounded-lg border bg-bg-card p-4 md:grid-cols-3" aria-label="前台利润操作流程">
        {[
          { step: "1", title: "准备来源", text: `已上传 ${filesQuery.data?.length ?? 0} 个文件，已归类 ${classifiedSourceCount} 个` },
          { step: "2", title: "生成试算", text: "系统生成利润明细，并自动执行数据质量检查和影子对账" },
          { step: "3", title: "确认发布", text: "只有检查通过且权威来源切为自动归集时，结果才会正式生效" },
        ].map((item) => (
          <div key={item.step} className="flex min-w-0 gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-morandi-3 text-xs font-semibold text-white">
              {item.step}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-text-primary">{item.title}</div>
              <div className="mt-0.5 text-xs leading-5 text-text-muted">{item.text}</div>
            </div>
          </div>
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
        <div className="space-y-4">
          <div className="card space-y-4 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <CalendarDays size={16} className="text-morandi-3" />
              期间
            </div>
            <div>
              <div className="space-y-1.5">
                <FieldLabel>归集月份</FieldLabel>
                <input
                  type="month"
                  value={period}
                  onChange={(event) => {
                    setPeriod(event.target.value);
                    setSelectedRunId(null);
                  }}
                  placeholder="2026-08"
                  className="w-full rounded-md border bg-bg-card px-3 py-2 text-sm outline-none focus:border-morandi-slate"
                />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border bg-bg-subtle/50 px-3 py-2">
              <div>
                <div className="text-xs text-text-muted">本月权威来源</div>
                <div className="mt-0.5 flex items-center gap-2">
                  {authorityQuery.isError ? (
                    <button
                      type="button"
                      onClick={() => authorityQuery.refetch()}
                      className="text-xs text-red-600 hover:underline"
                    >
                      加载失败，点击重试
                    </button>
                  ) : authorityQuery.data ? (
                    <>
                      <StatusPill status={authorityQuery.data.authority} />
                      <span className="text-xs text-text-muted">
                        次月 {authorityQuery.data.closeDay} 日关账
                        {authorityQuery.data.reopened ? " · 已重开" : ""}
                      </span>
                    </>
                  ) : (
                    <span className="text-xs text-text-muted">-</span>
                  )}
                </div>
              </div>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setAuthority.mutate("manual")}
                  disabled={setAuthority.isPending}
                  className="rounded-md border bg-bg-card px-2.5 py-1.5 text-xs hover:bg-bg-subtle disabled:opacity-50"
                >
                  人工结果
                </button>
                <button
                  type="button"
                  onClick={() => setAuthority.mutate("auto")}
                  disabled={setAuthority.isPending}
                  className="rounded-md bg-morandi-3 px-2.5 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-50"
                >
                  自动归集
                </button>
              </div>
            </div>
            {setAuthority.error && <div className="text-xs text-red-600">{errorText(setAuthority.error)}</div>}
          </div>

          <div className="card space-y-4 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Tags size={16} className="text-morandi-3" />
              给上传文件归类
            </div>
            <p className="text-xs leading-5 text-text-muted">
              先告诉系统每个文件属于哪类业务数据。归类只记录用途，不会修改文件内容。
            </p>
            {filesQuery.isError ? (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-3 text-xs text-red-700" role="alert">
                文件列表加载失败。
                <button type="button" onClick={() => filesQuery.refetch()} className="ml-1 font-medium hover:underline">
                  重新加载
                </button>
              </div>
            ) : (filesQuery.data?.length ?? 0) > 0 ? (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <FieldLabel>已上传文件</FieldLabel>
                  <select
                    value={familySourceId}
                    onChange={(event) => {
                      const value = event.target.value;
                      setFamilySourceId(value);
                      const selected = filesQuery.data?.find((file) => file.id === Number(value));
                      const existingFamily = selected?.config?.frontProfitSourceFamily;
                      if (existingFamily && SOURCE_FAMILIES.some((item) => item.value === existingFamily)) {
                        setFamily(existingFamily as typeof family);
                      }
                    }}
                    className="w-full rounded-md border bg-bg-card px-3 py-2 text-sm outline-none focus:border-morandi-slate"
                  >
                    <option value="">请选择文件</option>
                    {(filesQuery.data ?? []).map((file) => {
                      const currentFamily = SOURCE_FAMILIES.find(
                        (item) => item.value === file.config?.frontProfitSourceFamily,
                      );
                      return (
                        <option key={file.id} value={file.id}>
                          {file.name}{currentFamily ? `（已归类：${currentFamily.label}）` : "（未归类）"}
                        </option>
                      );
                    })}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <FieldLabel>业务类型</FieldLabel>
                  <select
                    value={family}
                    onChange={(event) => setFamily(event.target.value as typeof family)}
                    className="w-full rounded-md border bg-bg-card px-3 py-2 text-sm outline-none focus:border-morandi-slate"
                  >
                    {SOURCE_FAMILIES.map((item) => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-dashed px-3 py-4 text-sm text-text-muted">
                还没有可用文件。请先到 <Link to="/data" className="font-medium text-morandi-slate hover:underline">数据页面上传 Excel 或 CSV</Link>。
              </div>
            )}
            <button
              type="button"
              onClick={() => markFamily.mutate()}
              disabled={markFamily.isPending || !familySourceId}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-bg-subtle disabled:opacity-50"
            >
              {markFamily.isPending ? <Loader2 size={14} className="animate-spin" /> : <Database size={14} />}
              保存归类
            </button>
            {markFamily.isSuccess && <div className="text-xs text-green-700">归类已保存，试算来源已同步更新</div>}
            {markFamily.error && <div className="text-xs text-red-600">{errorText(markFamily.error)}</div>}
          </div>

          <div className="card space-y-4 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Play size={16} className="text-morandi-3" />
                选择本月试算来源
              </div>
              <span className="text-xs text-text-muted">已选 {selectedSourceCount} 个</span>
            </div>
            <div className="space-y-3">
              {SOURCE_INPUTS.map((item) => {
                const candidates = sourceFilesByFamily.get(item.family) ?? [];
                const selectedIds = new Set(parseIds(sourceValues[item.key]));
                return (
                  <div key={item.key} className="rounded-md border px-3 py-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-text-primary">{item.label}</div>
                        <div className="mt-0.5 text-xs text-text-muted">{item.hint}</div>
                      </div>
                      <span className="shrink-0 text-xs text-text-muted">{selectedIds.size}/{candidates.length}</span>
                    </div>
                    {candidates.length > 0 ? (
                      <div className="mt-2 space-y-1.5">
                        {candidates.map((file) => (
                          <label key={file.id} className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-1.5 text-xs hover:bg-bg-subtle">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(file.id)}
                              onChange={(event) => setSourceValues((current) => ({
                                ...current,
                                [item.key]: setSourceIdSelected(current[item.key], file.id, event.target.checked),
                              }))}
                              className="h-4 w-4 accent-morandi-3"
                            />
                            <span className="min-w-0 flex-1 truncate">{file.name}</span>
                            {file.config?.rowCount != null && (
                              <span className="shrink-0 text-text-muted">{file.config.rowCount} 行</span>
                            )}
                          </label>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-2 text-xs text-amber-700">尚未归类此类文件，可先跳过或在上方完成归类</div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="space-y-1.5">
              <FieldLabel>人工标准结果（可选，用于影子对账）</FieldLabel>
              <select
                value={manualBaselineSourceId}
                onChange={(event) => setManualBaselineSourceId(event.target.value)}
                className="w-full rounded-md border bg-bg-card px-3 py-2 text-sm outline-none focus:border-morandi-slate"
              >
                <option value="">本次不与人工标准结果对账</option>
                {baselineFiles.map((file) => (
                  <option key={file.id} value={file.id}>{file.name}</option>
                ))}
              </select>
              {!baselineFiles.length && (
                <div className="text-xs leading-5 text-text-muted">未发现通过 28 字段合同校验的人工结果文件，因此本次只能查看自动试算和质量检查。</div>
              )}
            </div>
            <button
              type="button"
              onClick={() => draftRun.mutate()}
              disabled={draftRun.isPending || selectedSourceCount === 0}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-md bg-morandi-3 px-3.5 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
            >
              {draftRun.isPending ? <Loader2 size={15} className="animate-spin" /> : <UploadCloud size={15} />}
              生成试算结果
            </button>
            {selectedSourceCount === 0 && (
              <div className="text-xs text-amber-700">至少选择一个已归类来源后才能试算。</div>
            )}
            {draftRun.error && <div className="text-xs text-red-600">{errorText(draftRun.error)}</div>}
          </div>
        </div>

        <div className="space-y-4">
          <div className="card space-y-3 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheck size={16} className="text-morandi-3" />
                试算与发布记录
              </div>
              {runsQuery.isFetching && <Loader2 size={14} className="animate-spin text-text-muted" />}
            </div>
            <div className="overflow-auto">
              <table className="w-full min-w-[780px] text-left text-sm">
                <thead className="text-xs text-text-muted">
                  <tr className="border-b">
                    <th className="px-2 py-2 font-medium">批次</th>
                    <th className="px-2 py-2 font-medium">运行状态</th>
                    <th className="px-2 py-2 font-medium">处理步骤</th>
                    <th className="px-2 py-2 font-medium">质量问题</th>
                    <th className="px-2 py-2 font-medium">对账项</th>
                    <th className="px-2 py-2 font-medium">利润结果</th>
                    <th className="px-2 py-2 font-medium">发布状态</th>
                    <th className="px-2 py-2 font-medium">完成时间</th>
                  </tr>
                </thead>
                <tbody>
                  {(runsQuery.data ?? []).map((run) => (
                    <tr
                      key={run.id}
                      onClick={() => setSelectedRunId(run.id)}
                      className={cn(
                        "cursor-pointer border-b last:border-b-0 hover:bg-bg-subtle/60",
                        selectedRunId === run.id && "bg-morandi-1/10",
                      )}
                    >
                      <td className="px-2 py-2 font-medium">{run.id}</td>
                      <td className="px-2 py-2"><StatusPill status={run.status} /></td>
                      <td className="px-2 py-2 text-text-secondary">{run.step_count}</td>
                      <td className="px-2 py-2 text-text-secondary">
                        {run.dq_count}
                        {run.unresolved_block_count > 0 && (
                          <span className="ml-1 text-red-600">/{run.unresolved_block_count}</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-text-secondary">
                        {run.recon_count}
                        {run.failed_recon_count > 0 && (
                          <span className="ml-1 text-red-600">/{run.failed_recon_count}</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-text-secondary">{run.l4_count}</td>
                      <td className="px-2 py-2">
                        {run.publish_versions?.length ? (
                          <StatusPill status={run.publish_versions[run.publish_versions.length - 1].status} />
                        ) : (
                          <span className="text-xs text-text-muted">-</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-xs text-text-muted">{dateText(run.finished_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {runsQuery.isError ? (
                <div className="py-8 text-center" role="alert">
                  <div className="text-sm font-medium text-red-700">试算记录加载失败</div>
                  <button
                    type="button"
                    onClick={() => runsQuery.refetch()}
                    className="mt-2 text-xs font-medium text-morandi-slate hover:underline"
                  >
                    重新加载
                  </button>
                </div>
              ) : !runsQuery.data?.length && (
                <div className="py-8 text-center">
                  <div className="text-sm font-medium text-text-secondary">本月还没有试算记录</div>
                  <div className="mt-1 text-xs text-text-muted">在左侧选择已归类来源并生成试算后，这里会显示处理进度、质量检查、对账和利润结果。</div>
                </div>
              )}
            </div>
          </div>

          <div className="card space-y-4 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <CheckCircle2 size={16} className="text-morandi-3" />
                  确认并发布
                </div>
                <div className="mt-1 text-xs text-text-muted">
                  {selectedRun
                    ? `当前选择：批次 ${selectedRun.id} · ${statusLabel(selectedRun.status)}`
                    : "请先从上方选择一条试算记录"}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => publishRun.mutate()}
                  disabled={publishRun.isPending || !selectedRunId || !publishSourceId}
                  className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-md bg-morandi-3 px-3.5 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
                >
                  {publishRun.isPending ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
                  发布为本月权威结果
                </button>
                <button
                  type="button"
                  onClick={() => rollbackPublish.mutate()}
                  disabled={rollbackPublish.isPending || !selectedPublishedVersion}
                  className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-md border bg-bg-card px-3.5 py-2 text-sm text-text-secondary hover:bg-bg-subtle disabled:opacity-50"
                >
                  {rollbackPublish.isPending ? <Loader2 size={15} className="animate-spin" /> : <RotateCcw size={15} />}
                  恢复上一版本
                </button>
              </div>
            </div>
            {selectedRun && authorityQuery.data?.authority !== "auto" && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                当前仍以人工结果为准，可以继续试算和对账，但不能正式发布。确认切换后，请在左侧把本月权威来源改为“自动归集”。
              </div>
            )}
            <details className="rounded-md border bg-bg-subtle/40 px-3 py-2">
              <summary className="cursor-pointer text-xs text-text-secondary">发布高级信息（通常无需修改）</summary>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <FieldLabel>结果归档来源编号</FieldLabel>
                  <input
                    value={publishSourceId}
                    onChange={(event) => setPublishSourceId(event.target.value)}
                    className="w-full rounded-md border bg-bg-card px-3 py-2 text-sm outline-none focus:border-morandi-slate"
                  />
                </div>
                <div className="space-y-1.5">
                  <FieldLabel>本批次全部来源编号</FieldLabel>
                  <input
                    value={publishSourceIds}
                    onChange={(event) => setPublishSourceIds(event.target.value)}
                    className="w-full rounded-md border bg-bg-card px-3 py-2 text-sm outline-none focus:border-morandi-slate"
                  />
                </div>
                <div className="space-y-1.5">
                  <FieldLabel>防重复发布标识</FieldLabel>
                  <input
                    value={publishIdempotencyKey}
                    onChange={(event) => setPublishIdempotencyKey(event.target.value)}
                    className="w-full rounded-md border bg-bg-card px-3 py-2 font-mono text-xs outline-none focus:border-morandi-slate"
                  />
                </div>
                <div className="space-y-1.5">
                  <FieldLabel>恢复原因</FieldLabel>
                  <input
                    value={rollbackReason}
                    onChange={(event) => setRollbackReason(event.target.value)}
                    className="w-full rounded-md border bg-bg-card px-3 py-2 text-sm outline-none focus:border-morandi-slate"
                  />
                </div>
              </div>
            </details>
            {publishRun.data && (
              <div className="text-xs text-green-700">
                版本 {publishRun.data.version.versionNo} {publishRun.data.idempotent ? "已存在，无需重复发布" : "已发布"} · 共 {publishRun.data.stagedRowCount} 条结果
              </div>
            )}
            {rollbackPublish.data && (
              <div className="text-xs text-green-700">
                已从版本 {rollbackPublish.data.rolledBackVersion.versionNo} 恢复到版本 {rollbackPublish.data.restoredVersion.versionNo}
                {" "}· 结果数 {rollbackPublish.data.rolledBackRowCount} → {rollbackPublish.data.restoredRowCount}
                {rollbackPublish.data.idempotent ? " · 此操作此前已完成" : ""}
              </div>
            )}
            {publishRun.error && <div className="text-xs text-red-600">{errorText(publishRun.error)}</div>}
            {rollbackPublish.error && <div className="text-xs text-red-600">{errorText(rollbackPublish.error)}</div>}
          </div>

          <div className="grid gap-4 2xl:grid-cols-2">
            <section className="card space-y-3 p-4">
              <div className="text-sm font-medium">处理步骤</div>
              <div className="overflow-auto">
                <table className="w-full min-w-[520px] text-left text-sm">
                  <thead className="text-xs text-text-muted">
                    <tr className="border-b">
                      <th className="px-2 py-2 font-medium">步骤</th>
                      <th className="px-2 py-2 font-medium">状态</th>
                      <th className="px-2 py-2 font-medium">输入行</th>
                      <th className="px-2 py-2 font-medium">输出行</th>
                      <th className="px-2 py-2 font-medium">错误码</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detailQuery.data?.steps ?? []).map((step) => (
                      <tr key={`${step.step_key}-${step.attempt}`} className="border-b last:border-b-0">
                        <td className="px-2 py-2 font-medium">{stepLabel(step.step_key)}</td>
                        <td className="px-2 py-2"><StatusPill status={step.status} /></td>
                        <td className="px-2 py-2 text-text-secondary">{step.rows_in ?? "-"}</td>
                        <td className="px-2 py-2 text-text-secondary">{step.rows_out ?? "-"}</td>
                        <td className="px-2 py-2 text-xs text-red-600" title={step.error_code ?? undefined}>
                          {technicalCodeLabel(step.error_code)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!detailQuery.data?.steps?.length && (
                  <div className="py-6 text-sm text-text-muted">选择试算记录后显示各处理步骤</div>
                )}
              </div>
            </section>

            <section className="card space-y-3 p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">对账结果</div>
                <div className="text-xs text-text-muted">
                  未通过 {failedRecon.length} / {detailQuery.data?.reconResults.length ?? 0}
                </div>
              </div>
              <div className="max-h-64 overflow-auto">
                {(failedRecon.length ? failedRecon : detailQuery.data?.reconResults.slice(0, 12) ?? []).map((row) => (
                  <div key={`${row.layer}-${row.metric}`} className="flex items-center gap-2 border-b py-2 last:border-b-0">
                    <StatusPill status={row.passed ? "passed" : "failed"} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium" title={`${row.layer}:${row.metric}`}>
                        {RECON_LAYER_LABELS[row.layer] ?? "数据对账"} · {reconMetricLabel(row.metric)}
                      </div>
                      <div className="truncate text-xs text-text-muted">
                        期望 {row.expected ?? "-"} · 实际 {row.actual ?? "-"}
                      </div>
                    </div>
                  </div>
                ))}
                {!detailQuery.data?.reconResults?.length && (
                  <div className="py-6 text-sm text-text-muted">
                    {manualBaselineSourceId ? "试算完成后显示自动结果与人工标准结果的差异" : "未选择人工标准结果，本次不会产生影子对账差异"}
                  </div>
                )}
              </div>
            </section>
          </div>

          <section className="card space-y-3 p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">质量检查与利润结果预览</div>
              {detailQuery.isFetching && <Loader2 size={14} className="animate-spin text-text-muted" />}
            </div>
            <div className="grid gap-4 2xl:grid-cols-2">
              <div className="max-h-72 overflow-auto rounded-md border">
                {(detailQuery.data?.dqEvents ?? []).map((event, index) => (
                  <div key={`${event.code}-${index}`} className="border-b px-3 py-2 last:border-b-0">
                    <div className="flex items-center gap-2">
                      <StatusPill status={event.severity} />
                      <span className="text-sm font-medium" title={event.code}>{technicalCodeLabel(event.code)}</span>
                    </div>
                    <div className="mt-1 text-xs text-text-muted">
                       来源 {event.source_id ?? "-"} · 第 {event.row_no ?? "-"} 行
                    </div>
                  </div>
                ))}
                {!detailQuery.data?.dqEvents?.length && (
                  <div className="p-4 text-sm text-text-muted">暂无质量问题；试算完成后，这里会列出提醒或阻断项</div>
                )}
              </div>
              <div className="overflow-auto rounded-md border">
                <table className="w-full min-w-[560px] text-left text-sm">
                  <thead className="text-xs text-text-muted">
                    <tr className="border-b">
                      <th className="px-2 py-2 font-medium">结果标识</th>
                      <th className="px-2 py-2 font-medium">发布版本</th>
                      <th className="px-2 py-2 font-medium">销售额</th>
                      <th className="px-2 py-2 font-medium">前台利润</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detailQuery.data?.l4Rows ?? []).map((row) => (
                      <tr key={row.id} className="border-b last:border-b-0">
                        <td className="max-w-[260px] truncate px-2 py-2 font-mono text-xs">{row.record_id}</td>
                        <td className="px-2 py-2 text-text-secondary">{row.publish_version_id ?? "-"}</td>
                        <td className="px-2 py-2 text-text-secondary">{row.gmv ?? "-"}</td>
                        <td className="px-2 py-2 text-text-secondary">{row.front_profit ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!detailQuery.data?.l4Rows?.length && (
                  <div className="p-4 text-sm text-text-muted">暂无利润结果；生成试算后将显示按业务键汇总的销售额和前台利润</div>
                )}
              </div>
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}
