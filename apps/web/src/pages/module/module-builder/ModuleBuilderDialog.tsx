import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  X,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  AssignAndRunResult,
  BuilderSource,
  ModuleSourceInspection,
} from "../types";
import { BasicStep } from "./BasicStep";
import { MappingStep } from "./MappingStep";
import {
  buildCreateModuleRequest,
  builderFailureMessage,
  createInitialBuilderState,
  applyInspectedFilenamePhrase,
  validateBuilderStep,
  type BuilderStep,
  type ModuleBuilderState,
  type SemanticRole,
} from "./model";
import { ReviewStep } from "./ReviewStep";
import { StatusStep } from "./StatusStep";

const STEPS: Array<{ key: Exclude<BuilderStep, "result">; label: string }> = [
  { key: "basic", label: "基本信息" },
  { key: "mapping", label: "字段对应" },
  { key: "status", label: "有效状态" },
  { key: "review", label: "确认执行" },
];

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSourceIds?: number[];
  sourceOptions?: BuilderSource[];
  allowSourceSelection?: boolean;
  onSuccess?: (result: AssignAndRunResult) => void;
};

export function ModuleBuilderDialog({
  open,
  onOpenChange,
  initialSourceIds = [],
  sourceOptions,
  allowSourceSelection = false,
  onSuccess,
}: Props) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const wasOpen = useRef(false);
  const [state, setState] = useState<ModuleBuilderState>(() =>
    createInitialBuilderState([], crypto.randomUUID()),
  );
  const [visibleErrors, setVisibleErrors] = useState<string[]>([]);
  const [result, setResult] = useState<AssignAndRunResult | null>(null);

  const fileQuery = useQuery({
    queryKey: ["files"],
    enabled: open && !sourceOptions,
    queryFn: async () => {
      const response: any = await api.get("/files");
      return response.data as BuilderSource[];
    },
  });
  const unmatchedSources = useMemo(
    () =>
      (sourceOptions ?? fileQuery.data ?? []).filter(
        (source) => source.attribution?.kind === "unmatched",
      ),
    [fileQuery.data, sourceOptions],
  );

  useEffect(() => {
    if (open && !wasOpen.current) {
      setState(
        createInitialBuilderState(initialSourceIds, crypto.randomUUID()),
      );
      setVisibleErrors([]);
      setResult(null);
    }
    wasOpen.current = open;
  }, [initialSourceIds, open]);

  const orderedSourceIds = useMemo(
    () => [...state.sourceIds].sort((left, right) => left - right),
    [state.sourceIds],
  );
  const statusSource = state.mappings.status?.source ?? null;
  const inspectionQuery = useQuery({
    queryKey: ["module-source-inspection", orderedSourceIds],
    enabled: open && orderedSourceIds.length > 0,
    retry: false,
    queryFn: async () => {
      const response: any = await api.post("/modules/inspect-sources", {
        sourceIds: orderedSourceIds,
        includeStatusValues: false,
      });
      return response.data as ModuleSourceInspection;
    },
  });
  const statusInspectionQuery = useQuery({
    queryKey: ["module-status-inspection", orderedSourceIds, statusSource],
    enabled:
      open && orderedSourceIds.length > 0 && typeof statusSource === "string",
    retry: false,
    queryFn: async () => {
      const response: any = await api.post("/modules/inspect-sources", {
        sourceIds: orderedSourceIds,
        includeStatusValues: true,
        statusSource,
      });
      return response.data as ModuleSourceInspection;
    },
  });

  useEffect(() => {
    const inspection = inspectionQuery.data;
    if (!inspection || !inspection.compatible) return;
    setState((current) => {
      if (
        current.sourceIds.length !== inspection.sourceIds.length ||
        !current.sourceIds.every((id) => inspection.sourceIds.includes(id))
      ) {
        return current;
      }
      const mappings =
        current.headers.length === 0
          ? suggestMappings(inspection)
          : current.mappings;
      return applyInspectedFilenamePhrase(
        {
          ...current,
          headers: inspection.headers,
          samples: inspection.samples,
          mappings,
        },
        inspection.filenamePhrase,
      );
    });
  }, [inspectionQuery.data]);

  const createMutation = useMutation({
    mutationFn: async () => {
      const response: any = await api.post(
        "/modules",
        buildCreateModuleRequest(state),
      );
      return response.data as AssignAndRunResult;
    },
    onSuccess: (created) => {
      setResult(created);
      setState((current) => ({ ...current, step: "result" }));
      invalidateAfterModuleRun(queryClient);
      onSuccess?.(created);
    },
  });

  const inspection = inspectionQuery.data;
  const stepIndex = STEPS.findIndex((step) => step.key === state.step);
  const isPartial =
    result?.files.some((file) => file.status === "failed") ?? false;

  function change(patch: Partial<ModuleBuilderState>) {
    setState((current) => ({ ...current, ...patch }));
    setVisibleErrors([]);
  }

  function next() {
    const errors = validateBuilderStep(state).filter(
      (error) =>
        !(
          state.step === "mapping" &&
          error === "请选择至少一个计入有效数据的状态"
        ),
    );
    if (errors.length > 0) {
      setVisibleErrors(errors);
      return;
    }
    if (state.step === "basic") {
      if (inspectionQuery.isPending || inspectionQuery.isFetching) return;
      if (!inspection?.compatible) return;
      change({ step: "mapping" });
      return;
    }
    if (state.step === "mapping") {
      change({ step: "status" });
      return;
    }
    if (state.step === "status") {
      change({ step: "review" });
    }
  }

  function previous() {
    if (stepIndex <= 0) return;
    change({ step: STEPS[stepIndex - 1].key });
  }

  function close() {
    if (!createMutation.isPending) onOpenChange(false);
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onOpenChange(true);
        else close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/35" />
        <Dialog.Content
          aria-describedby="module-builder-description"
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] w-[min(760px,calc(100vw-1rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border bg-bg-card shadow-2xl focus:outline-none"
        >
          <div className="flex items-start justify-between border-b px-4 py-3 sm:px-5">
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-semibold">
                新建模块
              </Dialog.Title>
              <Dialog.Description
                id="module-builder-description"
                className="mt-0.5 text-xs text-text-muted"
              >
                选择文件、对应字段、确认有效状态，然后自动归入并执行。
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="关闭新建模块"
                disabled={createMutation.isPending}
                className="ml-3 rounded p-2 text-text-muted transition hover:bg-bg-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40 disabled:opacity-40"
              >
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>

          {state.step !== "result" && (
            <ol
              aria-label="新建模块步骤"
              className="grid grid-cols-4 border-b bg-bg-subtle/40 px-2 sm:px-5"
            >
              {STEPS.map((step, index) => {
                const active = step.key === state.step;
                const complete = index < stepIndex;
                return (
                  <li
                    key={step.key}
                    aria-current={active ? "step" : undefined}
                    className={cn(
                      "border-b-2 px-1 py-2 text-center text-[11px] sm:text-xs",
                      active
                        ? "border-morandi-3 font-medium text-text-primary"
                        : "border-transparent text-text-muted",
                      complete && "text-morandi-3",
                    )}
                  >
                    <span className="mr-1 hidden sm:inline">{index + 1}.</span>
                    {step.label}
                  </li>
                );
              })}
            </ol>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
            {state.step === "basic" && (
              <>
                <BasicStep
                  state={state}
                  sources={unmatchedSources}
                  allowSourceSelection={allowSourceSelection}
                  sourceLoading={allowSourceSelection && fileQuery.isPending}
                  sourceError={
                    allowSourceSelection && fileQuery.isError
                      ? "文件加载失败，请稍后重试"
                      : null
                  }
                  onChange={change}
                />
                {state.sourceIds.length > 0 && (
                  <InspectionState
                    loading={inspectionQuery.isPending || inspectionQuery.isFetching}
                    error={inspectionQuery.error}
                    inspection={inspection}
                    sources={unmatchedSources}
                  />
                )}
              </>
            )}
            {state.step === "mapping" && inspection && (
              <MappingStep
                state={state}
                inspection={inspection}
                onChange={change}
              />
            )}
            {state.step === "status" && inspection && (
              statusSource ? (
                statusInspectionQuery.isPending ||
                statusInspectionQuery.isFetching ? (
                  <div role="status" className="flex items-center gap-2 rounded-md bg-bg-subtle px-3 py-5 text-sm text-text-secondary">
                    <Loader2 size={16} className="animate-spin" />
                    正在读取所选状态字段…
                  </div>
                ) : statusInspectionQuery.isError ? (
                  <div role="alert" className="break-words [overflow-wrap:anywhere] rounded-md border border-morandi-rose/30 bg-morandi-rose/5 px-3 py-3 text-sm text-morandi-rose">
                    状态值读取失败，请稍后重试
                  </div>
                ) : statusInspectionQuery.data ? (
                  <StatusStep
                    state={state}
                    inspection={statusInspectionQuery.data}
                    onChange={change}
                  />
                ) : null
              ) : (
                <StatusStep
                  state={state}
                  inspection={inspection}
                  onChange={change}
                />
              )
            )}
            {state.step === "review" && (
              <ReviewStep state={state} sources={unmatchedSources} />
            )}
            {state.step === "result" && result && (
              <ResultState result={result} partial={isPartial} />
            )}

            {visibleErrors.length > 0 && (
              <div
                role="alert"
                className="mt-4 flex items-start gap-2 rounded-md border border-morandi-rose/30 bg-morandi-rose/5 px-3 py-2 text-sm text-morandi-rose"
              >
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <ul className="list-disc space-y-0.5 pl-4">
                  {visibleErrors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </div>
            )}

            {createMutation.isError && (
              <div
                role="alert"
                className="mt-4 flex items-start gap-2 rounded-md border border-morandi-rose/30 bg-morandi-rose/5 px-3 py-2 text-sm text-morandi-rose"
              >
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <div>
                  <div className="font-medium">保存或处理未完成</div>
                  <div className="mt-0.5 text-xs">
                    保存或处理未完成，请稍后重试
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-bg-card px-4 py-3 sm:px-5">
            {state.step === "result" && result ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    navigate(`/module/${result.moduleCode}`);
                  }}
                  className="min-h-11 rounded-md bg-morandi-3 px-4 py-2 text-sm text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40"
                >
                  进入模块工作台
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    navigate(`/board?module=${encodeURIComponent(result.moduleCode)}`);
                  }}
                  className="min-h-11 rounded-md border px-4 py-2 text-sm transition hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40"
                >
                  查看看板
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={previous}
                  disabled={stepIndex <= 0 || createMutation.isPending}
                  className="inline-flex min-h-11 items-center gap-1 rounded-md border px-3 py-2 text-sm transition hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40 disabled:opacity-40"
                >
                  <ChevronLeft size={15} />
                  上一步
                </button>
                {state.step === "review" ? (
                  <button
                    type="button"
                    onClick={() => createMutation.mutate()}
                    disabled={createMutation.isPending}
                    className="inline-flex min-h-11 items-center gap-2 rounded-md bg-morandi-3 px-4 py-2 text-sm text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40 disabled:opacity-50"
                  >
                    {createMutation.isPending && (
                      <Loader2 size={16} className="animate-spin" />
                    )}
                    {createMutation.isPending ? "正在归入并处理…" : "确认并执行"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={next}
                    disabled={
                      (state.step === "basic" &&
                        (inspectionQuery.isPending ||
                          inspectionQuery.isFetching ||
                          !inspection?.compatible)) ||
                      (state.step === "status" &&
                        !!state.mappings.status &&
                        (statusInspectionQuery.isPending ||
                          statusInspectionQuery.isFetching ||
                          statusInspectionQuery.isError ||
                          !statusInspectionQuery.data ||
                          statusInspectionQuery.data.statusValues.length === 0))
                    }
                    className="inline-flex min-h-11 items-center gap-1 rounded-md bg-morandi-3 px-4 py-2 text-sm text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    下一步
                    <ChevronRight size={15} />
                  </button>
                )}
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function InspectionState({
  loading,
  error,
  inspection,
  sources,
}: {
  loading: boolean;
  error: unknown;
  inspection?: ModuleSourceInspection;
  sources: BuilderSource[];
}) {
  if (loading) {
    return (
      <div
        role="status"
        className="mt-4 flex items-center gap-2 rounded-md bg-bg-subtle px-3 py-2 text-xs text-text-secondary"
      >
        <Loader2 size={15} className="animate-spin" />
        正在检查文件字段…
      </div>
    );
  }
  if (error) {
    return (
      <div role="alert" className="mt-4 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
        文件检查失败，请稍后重试
      </div>
    );
  }
  if (!inspection) return null;
  if (inspection.compatible) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-md bg-morandi-2/10 px-3 py-2 text-xs text-text-secondary">
        <CheckCircle2 size={15} className="text-morandi-3" />
        已检查 {inspection.sourceIds.length} 个文件，共 {inspection.headers.length} 个字段。
      </div>
    );
  }
  return (
    <div role="alert" className="mt-4 break-words [overflow-wrap:anywhere] rounded-md border border-morandi-rose/30 bg-morandi-rose/5 px-3 py-2 text-xs">
      <div className="font-medium text-morandi-rose">
        所选文件的字段结构不一致，请先分开创建模块。
      </div>
      <ul className="mt-2 space-y-1 text-text-secondary">
        {inspection.differences.map((difference) => {
          const source = sources.find((item) => item.id === difference.sourceId);
          return (
            <li key={difference.sourceId}>
              {source?.config?.originalFileName || source?.name || `文件 ${difference.sourceId}`}
              ：
              {difference.added.length > 0 && ` 多出 ${difference.added.join("、")}`}
              {difference.added.length > 0 && difference.missing.length > 0 && "；"}
              {difference.missing.length > 0 && ` 缺少 ${difference.missing.join("、")}`}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ResultState({
  result,
  partial,
}: {
  result: AssignAndRunResult;
  partial: boolean;
}) {
  const successFiles = result.files.filter((file) => file.status === "success");
  const total = successFiles.reduce((sum, file) => sum + file.total, 0);
  const included = successFiles.reduce((sum, file) => sum + file.included, 0);

  return (
    <section aria-labelledby="module-builder-result-heading" className="py-4 text-center">
      {partial ? (
        <AlertCircle size={38} className="mx-auto text-morandi-rose" />
      ) : (
        <CheckCircle2 size={38} className="mx-auto text-morandi-3" />
      )}
      <h3 id="module-builder-result-heading" className="mt-3 text-lg font-semibold">
        {partial ? "模块已创建，部分文件处理失败" : "模块已创建并完成处理"}
      </h3>
      <p className="mt-1 text-sm text-text-muted">
        成功 {successFiles.length}/{result.files.length} 个文件，保留 {total.toLocaleString()} 行，
        其中 {included.toLocaleString()} 行计入统计。
      </p>
      {partial && (
        <ul className="mx-auto mt-4 max-w-lg space-y-1 text-left text-xs text-morandi-rose">
          {result.files
            .filter((file) => file.status === "failed")
            .map((file) => (
              <li key={file.sourceId}>
                文件 {file.sourceId}：{builderFailureMessage(file.error)}
              </li>
            ))}
        </ul>
      )}
      {(result.warnings?.length ?? 0) > 0 && (
        <ul className="mx-auto mt-4 max-w-lg space-y-1 text-left text-xs text-text-muted">
          {result.warnings!.map((_, index) => (
            <li key={index}>部分辅助功能暂未完成，可稍后重试</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function suggestMappings(
  inspection: ModuleSourceInspection,
): ModuleBuilderState["mappings"] {
  const patterns: Array<[SemanticRole, RegExp]> = [
    ["time", /(支付|下单|创建|成交|日期|时间|date|time)/i],
    ["amount", /(金额|实付|销售额|收入|合计|amount|price|gmv)/i],
    ["quantity", /(数量|件数|销量|quantity|qty)/i],
    ["product_id", /(商品.*(编码|id)|product.?id)/i],
    ["product_name", /(商品.*(名称|标题)|品名|product.?name)/i],
    ["order_id", /(订单.*(编号|号|id)|order.?id)/i],
    ["status", /(订单)?状态|status/i],
    ["sku", /(sku|规格.*(编码|id))/i],
    ["shop", /(店铺|门店|shop|store)/i],
  ];
  const mappings = createInitialBuilderState([], "").mappings;
  const used = new Set<string>();
  for (const [role, pattern] of patterns) {
    const source = inspection.headers.find(
      (header) => !used.has(header) && pattern.test(header),
    );
    if (!source) continue;
    used.add(source);
    mappings[role] = {
      source,
      label: source,
      type: inspection.inferredTypes[source] ?? "text",
      required: ["time", "amount", "quantity"].includes(role),
    };
  }
  return mappings;
}

function invalidateAfterModuleRun(
  queryClient: ReturnType<typeof useQueryClient>,
) {
  [
    ["files"],
    ["modules"],
    ["module-stats"],
    ["analytics-overview"],
    ["etl-summary"],
    ["charts"],
    ["chart-render"],
    ["board"],
  ].forEach((queryKey) => queryClient.invalidateQueries({ queryKey }));
}
