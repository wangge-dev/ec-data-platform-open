import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  buildSchemaDecisionRequest,
  validateSchemaDecisions,
  type ColumnType,
  type SchemaDecision,
  type SchemaDiff,
} from "./model";

type ModuleColumn = {
  name: string;
  label?: string;
  computed?: boolean;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  moduleCode: string;
  sourceId: number;
  fileName?: string;
  moduleColumns: ModuleColumn[];
};

const COLUMN_TYPES: Array<{ value: ColumnType; label: string }> = [
  { value: "text", label: "文本" },
  { value: "int", label: "整数" },
  { value: "numeric", label: "金额或小数" },
  { value: "timestamp", label: "日期时间" },
  { value: "date", label: "日期" },
  { value: "boolean", label: "是 / 否" },
];

export function SchemaChangeDialog({
  open,
  onOpenChange,
  moduleCode,
  sourceId,
  fileName,
  moduleColumns,
}: Props) {
  const queryClient = useQueryClient();
  const [decisions, setDecisions] = useState<Record<string, SchemaDecision>>({});
  const [visibleErrors, setVisibleErrors] = useState<string[]>([]);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);

  const diffQuery = useQuery({
    queryKey: ["schema-diff", moduleCode, sourceId],
    enabled: open && Boolean(moduleCode) && sourceId > 0,
    retry: false,
    queryFn: async () => {
      const response: any = await api.get(
        `/modules/${encodeURIComponent(moduleCode)}/schema-diff`,
        { params: { sourceId } },
      );
      return response.data as SchemaDiff;
    },
  });

  useEffect(() => {
    if (!open) return;
    setDecisions({});
    setVisibleErrors([]);
    setSubmitMessage(null);
  }, [moduleCode, open, sourceId]);

  const diff = diffQuery.data;
  useEffect(() => {
    if (!open || !diff?.stagedDecisions?.length) return;
    setDecisions(Object.fromEntries(
      diff.stagedDecisions.map((decision) => {
        if (decision.decision === "add") {
          return [decision.sourceField, {
            source: decision.sourceField,
            action: "add",
            label: decision.label ?? decision.sourceField,
            type: decision.dataType ?? "text",
          } satisfies SchemaDecision];
        }
        if (decision.decision === "alias") {
          return [decision.sourceField, {
            source: decision.sourceField,
            action: "alias",
            target: decision.targetField ?? "",
          } satisfies SchemaDecision];
        }
        return [decision.sourceField, {
          source: decision.sourceField,
          action: "ignore",
        } satisfies SchemaDecision];
      }),
    ));
    setSubmitMessage(diff.retryMessage ?? "上次处理未完成，可直接重新处理。");
  }, [diff?.retryMessage, diff?.stagedDecisions, open]);
  const decisionList = useMemo(
    () => (diff?.added ?? []).flatMap((source) => decisions[source] ? [decisions[source]] : []),
    [decisions, diff?.added],
  );
  const targetColumns = moduleColumns.filter((column) => !column.computed);
  const isResolved =
    Boolean(diff) &&
    diff!.added.length === 0 &&
    diff!.missingRequired.length === 0 &&
    !diff!.typeChanges.some((change) => change.blocking) &&
    diff!.reviewStatus !== "awaiting_retry";

  const retryMutation = useMutation({
    mutationFn: async () => {
      if (!diff) throw new Error("字段变化信息尚未加载");
      const errors = validateSchemaDecisions(diff, decisionList);
      if (errors.length > 0) {
        setVisibleErrors(errors);
        throw new DecisionValidationError();
      }
      const response: any = await api.post(
        `/modules/${encodeURIComponent(moduleCode)}/schema-decisions`,
        buildSchemaDecisionRequest(diff, decisionList),
      );
      return response.data as {
        files?: Array<{ sourceId: number; status: "success" | "failed"; error?: string }>;
      };
    },
    onSuccess: async (result) => {
      invalidateAfterSchemaRetry(queryClient, moduleCode, sourceId);
      const failed = result.files?.filter((file) => file.status === "failed") ?? [];
      if (failed.length > 0) {
        setSubmitMessage("文件尚未处理完成，设置未生效，可直接再次处理。");
        await diffQuery.refetch();
        return;
      }
      onOpenChange(false);
    },
    onError: async (error) => {
      if (error instanceof DecisionValidationError) return;
      setSubmitMessage(publicSchemaError(error));
      invalidateAfterSchemaRetry(queryClient, moduleCode, sourceId);
      await diffQuery.refetch();
    },
  });

  function choose(source: string, action: SchemaDecision["action"]) {
    setVisibleErrors([]);
    setSubmitMessage(null);
    setDecisions((current) => {
      if (action === "add") {
        return {
          ...current,
          [source]: { source, action, label: source, type: "text" },
        };
      }
      if (action === "alias") {
        const suggested = diff?.aliasCandidates.find(
          (candidate) => candidate.source === source,
        )?.target;
        return {
          ...current,
          [source]: {
            source,
            action,
            target: suggested ?? targetColumns[0]?.name ?? "",
          },
        };
      }
      return { ...current, [source]: { source, action } };
    });
  }

  function chooseReplacement(source: string, target: string) {
    setVisibleErrors([]);
    setSubmitMessage(null);
    if (!source) return;
    setDecisions((current) => ({
      ...current,
      [source]: { source, action: "alias", target },
    }));
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!retryMutation.isPending) onOpenChange(nextOpen);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/35" />
        <Dialog.Content
          aria-describedby="schema-change-description"
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] w-[min(760px,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border bg-bg-card shadow-xl focus:outline-none"
        >
          <div className="flex items-start justify-between gap-3 border-b px-4 py-4 sm:px-5">
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-semibold">确认字段变化</Dialog.Title>
              <Dialog.Description
                id="schema-change-description"
                className="mt-1 break-words text-xs text-text-muted"
              >
                {fileName ? `文件「${fileName}」` : "这个文件"}
                {diff?.files && diff.files.length > 1
                  ? `等 ${diff.files.length} 个文件`
                  : ""}
                的字段和模块原设置不同。确认后系统会整组重新处理。
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="关闭字段确认"
              disabled={retryMutation.isPending}
              className="rounded p-2 text-text-muted transition hover:bg-bg-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40 disabled:opacity-40"
            >
              <X size={18} />
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
            {diffQuery.isPending ? (
              <div role="status" className="flex min-h-40 items-center justify-center gap-2 text-sm text-text-muted">
                <Loader2 size={16} className="animate-spin" />
                正在检查字段变化…
              </div>
            ) : diffQuery.isError ? (
              <div role="alert" className="rounded-md border border-morandi-rose/30 bg-morandi-rose/5 p-4 text-sm text-morandi-rose">
                <div className="font-medium">暂时无法读取字段变化</div>
                <div className="mt-1 text-xs">文件或模块可能已变化，请刷新后再试。</div>
                <button
                  type="button"
                  onClick={() => diffQuery.refetch()}
                  className="mt-3 inline-flex min-h-10 items-center gap-1.5 rounded-md border border-morandi-rose/30 px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40"
                >
                  <RefreshCw size={14} />
                  重新检查
                </button>
              </div>
            ) : isResolved ? (
              <div className="flex min-h-40 flex-col items-center justify-center text-center">
                <CheckCircle2 size={30} className="text-green-700" />
                <div className="mt-3 text-sm font-medium">字段变化已经处理</div>
                <div className="mt-1 text-xs text-text-muted">关闭窗口即可继续查看数据。</div>
              </div>
            ) : diff ? (
              <div className="space-y-5">
                {(diff.files?.length ?? 0) > 1 && (
                  <section className="rounded-md border bg-bg-subtle/50 p-3 text-xs text-text-secondary">
                    <div className="font-medium">
                      本次将一起处理 {diff.files!.length} 个文件
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {diff.files!.slice(0, 3).map((file) => (
                        <span
                          key={file.sourceId}
                          className="max-w-full truncate rounded border bg-bg-card px-2 py-1"
                        >
                          {file.fileName}
                        </span>
                      ))}
                      {diff.files!.length > 3 && (
                        <span className="px-2 py-1 text-text-muted">
                          +{diff.files!.length - 3} 个文件
                        </span>
                      )}
                    </div>
                  </section>
                )}
                {diff.missingRequired.length > 0 && (
                  <section
                    aria-labelledby="missing-required-heading"
                    className="rounded-md border border-morandi-rose/30 bg-morandi-rose/5 p-3"
                  >
                    <h3 id="missing-required-heading" className="flex items-center gap-2 text-sm font-medium text-morandi-rose">
                      <AlertCircle size={15} />
                      必要字段尚未对应
                    </h3>
                    <div className="mt-3 space-y-3">
                      {(diff.missingRequiredFields ?? diff.missingRequired.map((label) => ({
                        name: label,
                        label,
                        compatibleSources: [],
                      }))).map((field) => {
                        const compatible = field.compatibleSources ?? [];
                        const selected = decisionList.find(
                          (decision) =>
                            decision.action === "alias" &&
                            decision.target === field.name,
                        );
                        return compatible.length > 0 ? (
                          <label key={field.name} className="block text-xs text-text-secondary">
                            {field.label}
                            <select
                              value={selected?.source ?? ""}
                              onChange={(event) =>
                                chooseReplacement(event.target.value, field.name)}
                              className="mt-1 min-h-11 w-full rounded-md border bg-bg-card px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40"
                            >
                              <option value="">请选择本次文件中的字段</option>
                              {compatible.map((source) => (
                                <option key={source} value={source}>{source}</option>
                              ))}
                            </select>
                          </label>
                        ) : (
                          <div key={field.name} className="text-xs text-text-secondary">
                            「{field.label}」没有可安全替代的字段，请修正源文件后重新上传。
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}

                {diff.added.map((source) => {
                  const decision = decisions[source];
                  return (
                    <fieldset key={source} className="rounded-md border p-3 sm:p-4">
                      <legend className="max-w-full break-words px-1 text-sm font-medium">
                        新增字段：{source}
                      </legend>
                      <div className="mt-2 grid gap-2 sm:grid-cols-3">
                        {([
                          ["add", "添加为分析字段"],
                          ["alias", "映射到已有字段"],
                          ["ignore", "以后忽略"],
                        ] as const).map(([action, label]) => (
                          <label
                            key={action}
                            className={cn(
                              "flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition",
                              decision?.action === action
                                ? "border-morandi-3 bg-morandi-1/15"
                                : "hover:bg-bg-subtle",
                            )}
                          >
                            <input
                              type="radio"
                              name={`decision-${source}`}
                              checked={decision?.action === action}
                              onChange={() => choose(source, action)}
                              className="accent-morandi-3"
                            />
                            {label}
                          </label>
                        ))}
                      </div>

                      {decision?.action === "add" && (
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          <label className="text-xs text-text-secondary">
                            显示名称
                            <input
                              value={decision.label}
                              onChange={(event) =>
                                setDecisions((current) => ({
                                  ...current,
                                  [source]: { ...decision, label: event.target.value },
                                }))
                              }
                              className="mt-1 min-h-11 w-full rounded-md border bg-bg-card px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40"
                            />
                          </label>
                          <label className="text-xs text-text-secondary">
                            字段类型
                            <select
                              value={decision.type}
                              onChange={(event) =>
                                setDecisions((current) => ({
                                  ...current,
                                  [source]: {
                                    ...decision,
                                    type: event.target.value as ColumnType,
                                  },
                                }))
                              }
                              className="mt-1 min-h-11 w-full rounded-md border bg-bg-card px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40"
                            >
                              {COLUMN_TYPES.map((type) => (
                                <option key={type.value} value={type.value}>{type.label}</option>
                              ))}
                            </select>
                          </label>
                        </div>
                      )}

                      {decision?.action === "alias" && (
                        <label className="mt-3 block text-xs text-text-secondary">
                          对应到
                          <select
                            value={decision.target}
                            onChange={(event) =>
                              setDecisions((current) => ({
                                ...current,
                                [source]: { ...decision, target: event.target.value },
                              }))
                            }
                            className="mt-1 min-h-11 w-full rounded-md border bg-bg-card px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40"
                          >
                            <option value="">请选择已有字段</option>
                            {targetColumns.map((column) => (
                              <option key={column.name} value={column.name}>
                                {column.label || column.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </fieldset>
                  );
                })}

                {diff.missingOptional.length > 0 && (
                  <section className="rounded-md border bg-bg-subtle/50 p-3 text-xs text-text-muted">
                    本次未提供的可选字段：{diff.missingOptional.join("、")}。这些字段会保留为空，不影响处理。
                  </section>
                )}

                {diff.typeChanges.length > 0 && (
                  <section aria-labelledby="conversion-heading">
                    <h3 id="conversion-heading" className="text-sm font-medium">格式转换提醒</h3>
                    <div className="mt-2 space-y-2">
                      {diff.typeChanges.map((change) => (
                        <div key={`${change.source}-${change.expected}`} className="rounded-md border p-3 text-xs">
                          <div className="break-words text-text-secondary">
                            「{change.source}」有 {change.failures.toLocaleString()} 个样例无法按当前类型读取
                          </div>
                          {change.samples.length > 0 && (
                            <ul className="mt-2 space-y-1 text-text-muted">
                              {change.samples.slice(0, 5).map((sample, index) => (
                                <li key={`${index}-${sample}`} className="whitespace-pre-wrap break-words rounded bg-bg-subtle px-2 py-1">
                                  {sample}
                                </li>
                              ))}
                            </ul>
                          )}
                          {change.blocking && (change.compatibleSources?.length ?? 0) > 0 && (
                            <label className="mt-3 block text-text-secondary">
                              改用本次文件中的字段
                              <select
                                value={
                                  decisionList.find(
                                    (decision) =>
                                      decision.action === "alias" &&
                                      decision.target === (change.target ?? change.source),
                                  )?.source ?? ""
                                }
                                onChange={(event) =>
                                  chooseReplacement(
                                    event.target.value,
                                    change.target ?? change.source,
                                  )}
                                className="mt-1 min-h-11 w-full rounded-md border bg-bg-card px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40"
                              >
                                <option value="">请选择兼容字段</option>
                                {change.compatibleSources?.map((source) => (
                                  <option key={source} value={source}>{source}</option>
                                ))}
                              </select>
                            </label>
                          )}
                          {change.blocking && (change.compatibleSources?.length ?? 0) === 0 && (
                            <div className="mt-2 text-morandi-rose">
                              没有可安全替代的字段，请修正源文件后重新上传。
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {(visibleErrors.length > 0 || submitMessage) && (
                  <div role="alert" className="rounded-md border border-morandi-rose/30 bg-morandi-rose/5 p-3 text-sm text-morandi-rose">
                    {visibleErrors.length > 0 && (
                      <ul className="list-disc space-y-1 pl-5">
                        {visibleErrors.map((error) => <li key={error}>{error}</li>)}
                      </ul>
                    )}
                    {submitMessage && <div className="break-words">{submitMessage}</div>}
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2 border-t bg-bg-card px-4 py-3 sm:px-5">
            <Dialog.Close
              disabled={retryMutation.isPending}
              className="min-h-11 rounded-md border px-4 py-2 text-sm transition hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40 disabled:opacity-40"
            >
              {isResolved ? "关闭" : "暂不处理"}
            </Dialog.Close>
            {!isResolved && diff && (
              <button
                type="button"
                onClick={() => retryMutation.mutate()}
                disabled={retryMutation.isPending || diffQuery.isFetching}
                className="inline-flex min-h-11 items-center gap-2 rounded-md bg-morandi-3 px-4 py-2 text-sm text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40 disabled:opacity-50"
              >
                {retryMutation.isPending && <Loader2 size={16} className="animate-spin" />}
                {retryMutation.isPending
                  ? "正在重新处理…"
                  : diff.reviewStatus === "awaiting_retry"
                    ? "再次处理"
                    : "重新处理"}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

class DecisionValidationError extends Error {}

function publicSchemaError(error: unknown): string {
  const responseMessage =
    error &&
    typeof error === "object" &&
    "response" in error &&
    error.response &&
    typeof error.response === "object" &&
    "data" in error.response &&
    error.response.data &&
    typeof error.response.data === "object" &&
    "message" in error.response.data
      ? String(error.response.data.message)
      : "";
  const message = responseMessage || (
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : ""
  );
  const safe = [
    "仍有必要字段尚未对应",
    "字段变化已处理，请刷新后重试",
    "仅自建模块支持确认字段变化",
    "模块不存在",
    "模块配置已更新，请刷新后重试",
  ];
  return safe.includes(message)
    ? message
    : "重新处理未完成，请稍后再试。";
}

function invalidateAfterSchemaRetry(
  queryClient: ReturnType<typeof useQueryClient>,
  moduleCode: string,
  sourceId: number,
) {
  [
    ["files"],
    ["modules"],
    ["module-stats"],
    ["analytics-overview"],
    ["etl-summary"],
    ["metrics-compare"],
    ["metrics-dates"],
    ["charts"],
    ["chart-render"],
    ["board"],
    ["schema-diff"],
    ["module-schema-review"],
  ].forEach((queryKey) => queryClient.invalidateQueries({ queryKey }));
  queryClient.invalidateQueries({
    queryKey: ["schema-diff", moduleCode, sourceId],
  });
}
