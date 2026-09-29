import {
  createComplexJobRun,
  jobRunLockKey,
  recordComplexJobDqEvent,
  recordComplexJobStep,
  updateComplexJobRunStatus,
  type ComplexJobSqlExecutor,
} from "./complex-job.js";
import {
  applyFrontProfitCostToUsageRows,
  loadFrontProfitCostSource,
  stageFrontProfitCostL1ToL3,
  type FrontProfitCostSourceRow,
  type FrontProfitCostUsageRow,
} from "./front-profit-cost-source.js";
import {
  applyFrontProfitFeeAuthorityToL1,
  loadFrontProfitFeeSource,
  stageFrontProfitFeeL1ToL3,
  type FrontProfitFeeSourceRow,
} from "./front-profit-fee-source.js";
import { aggregateFrontProfitL3ToL4, writeFrontProfitShadowReconciliation } from "./front-profit-layers.js";
import {
  loadFrontProfitOperatorAssignmentSource,
  type FrontProfitOperatorAssignmentRow,
} from "./front-profit-operator-source.js";
import {
  loadFrontProfitPromotionSource,
  stageFrontProfitPromotionL1ToL3,
  type FrontProfitPromotionSourceRow,
} from "./front-profit-promotion-source.js";
import {
  loadFrontProfitRebateSource,
  stageFrontProfitRebateL1ToL3,
  type FrontProfitRebateSourceRow,
} from "./front-profit-rebate-source.js";
import {
  loadFrontProfitSalesSource,
  stageFrontProfitSalesL1ToL3,
  type FrontProfitSalesSourceRow,
} from "./front-profit-sales-source.js";
import { FrontProfitBusinessRuleBlockError, type FrontProfitFeeKind } from "./front-profit-business-rules.js";
import {
  assertFrontProfitAutoDraftAuthority,
  FrontProfitAuthorityError,
} from "./front-profit-authority.js";
import { FRONT_PROFIT_MODULE_CODE, frontProfitScopeKey } from "./front-profit-period.js";
import {
  canUseFrontProfitSqlSideUfSourceLoad,
  FrontProfitSourceLoadError,
  loadFrontProfitCostUsageUfSourceToL1SqlSide,
  loadFrontProfitSalesUfSourceToL1SqlSide,
  normalizeFrontProfitUfSourceRows,
  readFrontProfitManualBaselineRowsFromUf,
  type FrontProfitSourceFamily,
} from "./front-profit-source-loader.js";

export const FRONT_PROFIT_DRAFT_RUNNER_VERSION = "front-profit-draft-runner/v1" as const;
export const FRONT_PROFIT_DRAFT_UNKNOWN_ERROR_CODE = "FRONT_PROFIT_DRAFT_RUN_FAILED" as const;
export const FRONT_PROFIT_DRAFT_UNKNOWN_ERROR_MESSAGE = "前台利润草稿处理失败，请稍后重试" as const;

export type FrontProfitDraftRunSources = {
  operatorAssignmentSourceIds?: number[];
  salesSourceIds?: number[];
  costPeriodSourceIds?: number[];
  costUsageSourceIds?: number[];
  rebateSourceIds?: number[];
  feeSourceIds?: number[];
  promotionSourceIds?: number[];
};

export type FrontProfitDraftRunInput = {
  period: string;
  sources: FrontProfitDraftRunSources;
  manualBaselineSourceId?: number | null;
  requiredFeeKinds?: FrontProfitFeeKind[];
  actorId?: number | null;
  today?: string;
  mappingVersionId?: number | null;
  jobVersion?: string;
};

export type FrontProfitSourceLoadSummary = {
  family: FrontProfitSourceFamily | "fee_authoritative";
  sourceId: number | null;
  rowCount: number;
  l1RowCount: number;
  loadSeconds?: number;
  loadPath?: "js_uf_normalize_to_l1" | "sql_side_uf_to_l1" | "l1_authority_apply";
  l1WritePath?: "parameter_batch" | "copy_direct" | "copy_stage_upsert" | "sql_side_insert";
  loadPhaseTimings?: Array<{ phase: string; seconds: number }>;
};

export type FrontProfitL3StageTiming = {
  family: "sales_fact" | "cost_applied" | "rebate" | "fee_authoritative" | "promotion_spend";
  rowCount: number;
  seconds: number;
};

export type FrontProfitDraftRunResult = {
  runId: number;
  period: string;
  status: "recon_pending" | "failed";
  sourceLoads: FrontProfitSourceLoadSummary[];
  l3StageTimings: FrontProfitL3StageTiming[];
  l3RowCount: number;
  l4RowCount: number;
  reconResultCount: number;
  dqEventCount: number;
  errorCode?: string;
  message?: string;
};

type PeriodRow = {
  period: string;
  sourceId: number;
  sourceRowNo: number;
};

function assertPeriod(period: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw new FrontProfitSourceLoadError(
      "FRONT_PROFIT_SOURCE_PERIOD_MISMATCH",
      "front-profit draft period must use YYYY-MM",
      { period },
    );
  }
  return period;
}

function uniqueSourceIds(values: readonly number[] | undefined): number[] {
  return [...new Set((values ?? []).filter((value) => Number.isSafeInteger(value) && value > 0))]
    .sort((left, right) => left - right);
}

function sourceIds(input: FrontProfitDraftRunInput): number[] {
  const grouped = [
    input.sources.operatorAssignmentSourceIds,
    input.sources.salesSourceIds,
    input.sources.costPeriodSourceIds,
    input.sources.costUsageSourceIds,
    input.sources.rebateSourceIds,
    input.sources.feeSourceIds,
    input.sources.promotionSourceIds,
    input.manualBaselineSourceId == null ? [] : [input.manualBaselineSourceId],
  ];
  return uniqueSourceIds(grouped.flatMap((group) => group ?? []));
}

function groupByPeriod<Row extends PeriodRow>(rows: Row[]): Row[][] {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    grouped.set(row.period, [...(grouped.get(row.period) ?? []), row]);
  }
  return [...grouped.values()];
}

function assertRowsBelongToPeriod(
  family: FrontProfitSourceFamily | "manual_baseline",
  rows: PeriodRow[],
  period: string,
): void {
  const mismatches = rows
    .filter((row) => row.period !== period)
    .map((row) => ({
      sourceId: row.sourceId,
      rowNumber: row.sourceRowNo,
      period: row.period,
    }));
  if (mismatches.length > 0) {
    throw new FrontProfitSourceLoadError(
      "FRONT_PROFIT_SOURCE_PERIOD_MISMATCH",
      `front-profit ${family} source has rows outside ${period}`,
      { family, expectedPeriod: period, mismatches },
    );
  }
}

function errorCode(error: unknown): string {
  if (error instanceof FrontProfitBusinessRuleBlockError) return error.code;
  if (error instanceof FrontProfitSourceLoadError) return error.code;
  if (error instanceof FrontProfitAuthorityError) {
    return error.decisions[0]?.code ?? "FRONT_PROFIT_AUTHORITY_REJECTED";
  }
  return FRONT_PROFIT_DRAFT_UNKNOWN_ERROR_CODE;
}

function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof FrontProfitBusinessRuleBlockError) {
    return { evidence: error.evidence, message: error.message };
  }
  if (error instanceof FrontProfitSourceLoadError) {
    return { ...error.payload, message: error.message };
  }
  if (error instanceof FrontProfitAuthorityError) {
    return { decisions: error.decisions, message: error.message };
  }
  return { message: FRONT_PROFIT_DRAFT_UNKNOWN_ERROR_MESSAGE };
}

function errorMessage(error: unknown): string {
  if (errorCode(error) === FRONT_PROFIT_DRAFT_UNKNOWN_ERROR_CODE) {
    return FRONT_PROFIT_DRAFT_UNKNOWN_ERROR_MESSAGE;
  }
  return error instanceof Error ? error.message : String(error);
}

function elapsedSeconds(startedAtMs: number): number {
  return Number(((Date.now() - startedAtMs) / 1000).toFixed(3));
}

async function failRun(
  executor: ComplexJobSqlExecutor,
  input: {
    runId: number;
    stepKey: string;
    error: unknown;
  },
): Promise<FrontProfitDraftRunResult> {
  const code = errorCode(input.error);
  if (code === FRONT_PROFIT_DRAFT_UNKNOWN_ERROR_CODE) {
    console.error("[front-profit:draft] unexpected failure", {
      runId: input.runId,
      stepKey: input.stepKey,
      error: input.error,
    });
  }
  await recordComplexJobDqEvent(executor, {
    runId: input.runId,
    severity: "block",
    code,
    payload: errorPayload(input.error),
  });
  await recordComplexJobStep(executor, {
    runId: input.runId,
    stepKey: input.stepKey,
    status: "failed",
    errorCode: code,
  });
  await updateComplexJobRunStatus(executor, {
    runId: input.runId,
    moduleCode: FRONT_PROFIT_MODULE_CODE,
    status: "failed",
    lastCheckpointStep: input.stepKey,
  });
  return {
    runId: input.runId,
    period: "",
    status: "failed",
    sourceLoads: [],
    l3StageTimings: [],
    l3RowCount: 0,
    l4RowCount: 0,
    reconResultCount: 0,
    dqEventCount: 1,
    errorCode: code,
    message: errorMessage(input.error),
  };
}

async function normalizeSource(
  executor: ComplexJobSqlExecutor,
  input: {
    runId: number;
    family: FrontProfitSourceFamily;
    sourceId: number;
  },
) {
  return normalizeFrontProfitUfSourceRows(executor, input);
}

export async function runFrontProfitDraftShadow(
  executor: ComplexJobSqlExecutor,
  input: FrontProfitDraftRunInput,
): Promise<FrontProfitDraftRunResult> {
  const period = assertPeriod(input.period);
  const scopeKey = frontProfitScopeKey(period);
  const allSourceIds = sourceIds(input);

  await executor.unsafe(
    "SELECT pg_advisory_xact_lock(hashtext($1))",
    [jobRunLockKey(FRONT_PROFIT_MODULE_CODE, scopeKey)],
  );
  await assertFrontProfitAutoDraftAuthority(executor, [period], {
    actorId: input.actorId,
    today: input.today,
  });

  const runId = await createComplexJobRun(executor, {
    moduleCode: FRONT_PROFIT_MODULE_CODE,
    scopeKey,
    inputBatchIds: allSourceIds.map((sourceId) => `source:${sourceId}`),
    triggeredBy: input.actorId ?? null,
    status: "running",
  });

  let currentStep = "source_load";
  const sourceLoads: FrontProfitSourceLoadSummary[] = [];
  const l3StageTimings: FrontProfitL3StageTiming[] = [];
  let l3RowCount = 0;
  let l4RowCount = 0;
  let reconResultCount = 0;
  let dqEventCount = 0;

  const enterStep = async (stepKey: string) => {
    currentStep = stepKey;
    await recordComplexJobStep(executor, {
      runId,
      stepKey,
      status: "running",
    });
  };

  try {
    await enterStep("source_load");
    for (const sourceId of uniqueSourceIds(input.sources.operatorAssignmentSourceIds)) {
      const loadStartedAt = Date.now();
      const normalized = await normalizeSource(executor, { runId, family: "operator_assignment", sourceId });
      let l1RowCount = 0;
      for (const rows of groupByPeriod(normalized.rows as FrontProfitOperatorAssignmentRow[])) {
        const loaded = await loadFrontProfitOperatorAssignmentSource(executor, { rows });
        l1RowCount += loaded.l1RowCount;
        reconResultCount += loaded.reconResults.length;
      }
      sourceLoads.push({
        family: "operator_assignment",
        sourceId,
        rowCount: normalized.rows.length,
        l1RowCount,
        loadSeconds: elapsedSeconds(loadStartedAt),
        loadPath: "js_uf_normalize_to_l1",
      });
    }

    for (const sourceId of uniqueSourceIds(input.sources.costPeriodSourceIds)) {
      const loadStartedAt = Date.now();
      const normalized = await normalizeSource(executor, { runId, family: "cost_period", sourceId });
      let l1RowCount = 0;
      for (const rows of groupByPeriod(normalized.rows as FrontProfitCostSourceRow[])) {
        const loaded = await loadFrontProfitCostSource(executor, { rows });
        l1RowCount += loaded.l1RowCount;
        reconResultCount += loaded.reconResults.length;
      }
      sourceLoads.push({
        family: "cost_period",
        sourceId,
        rowCount: normalized.rows.length,
        l1RowCount,
        loadSeconds: elapsedSeconds(loadStartedAt),
        loadPath: "js_uf_normalize_to_l1",
      });
    }

    for (const sourceId of uniqueSourceIds(input.sources.salesSourceIds)) {
      const loadStartedAt = Date.now();
      const useSqlSideLoad = canUseFrontProfitSqlSideUfSourceLoad(executor, "sales_fact");
      const loaded = useSqlSideLoad
        ? await loadFrontProfitSalesUfSourceToL1SqlSide(executor, { runId, period, sourceId })
        : await (async () => {
          const normalized = await normalizeSource(executor, { runId, family: "sales_fact", sourceId });
          const rows = normalized.rows as FrontProfitSalesSourceRow[];
          assertRowsBelongToPeriod("sales_fact", rows, period);
          const result = await loadFrontProfitSalesSource(executor, {
            rows,
            insertOnlyIfEmpty: true,
          });
          return {
            rowCount: rows.length,
            l1RowCount: result.l1RowCount,
            reconResultCount: result.reconResults.length,
            phaseTimings: result.l1WritePhaseTimings,
            l1WritePath: result.l1WritePath,
          };
        })();
      sourceLoads.push({
        family: "sales_fact",
        sourceId,
        rowCount: loaded.rowCount,
        l1RowCount: loaded.l1RowCount,
        loadSeconds: elapsedSeconds(loadStartedAt),
        loadPath: useSqlSideLoad ? "sql_side_uf_to_l1" : "js_uf_normalize_to_l1",
        l1WritePath: useSqlSideLoad ? "sql_side_insert" : loaded.l1WritePath,
        loadPhaseTimings: loaded.phaseTimings,
      });
      reconResultCount += loaded.reconResultCount;
    }

    for (const sourceId of uniqueSourceIds(input.sources.costUsageSourceIds)) {
      const loadStartedAt = Date.now();
      const useSqlSideLoad = canUseFrontProfitSqlSideUfSourceLoad(executor, "cost_usage");
      const loaded = useSqlSideLoad
        ? await loadFrontProfitCostUsageUfSourceToL1SqlSide(executor, { runId, period, sourceId })
        : await (async () => {
          const normalized = await normalizeSource(executor, { runId, family: "cost_usage", sourceId });
          const rows = normalized.rows as FrontProfitCostUsageRow[];
          assertRowsBelongToPeriod("cost_usage", rows, period);
          const result = await applyFrontProfitCostToUsageRows(executor, {
            rows,
            insertOnlyIfEmpty: true,
          });
          return {
            rowCount: rows.length,
            l1RowCount: result.l1RowCount,
            reconResultCount: result.reconResults.length,
            phaseTimings: result.l1WritePhaseTimings,
            l1WritePath: result.l1WritePath,
          };
        })();
      sourceLoads.push({
        family: "cost_usage",
        sourceId,
        rowCount: loaded.rowCount,
        l1RowCount: loaded.l1RowCount,
        loadSeconds: elapsedSeconds(loadStartedAt),
        loadPath: useSqlSideLoad ? "sql_side_uf_to_l1" : "js_uf_normalize_to_l1",
        l1WritePath: useSqlSideLoad ? "sql_side_insert" : loaded.l1WritePath,
        loadPhaseTimings: loaded.phaseTimings,
      });
      reconResultCount += loaded.reconResultCount;
    }

    for (const sourceId of uniqueSourceIds(input.sources.rebateSourceIds)) {
      const loadStartedAt = Date.now();
      const normalized = await normalizeSource(executor, { runId, family: "rebate", sourceId });
      const rows = normalized.rows as FrontProfitRebateSourceRow[];
      assertRowsBelongToPeriod("rebate", rows, period);
      const loaded = await loadFrontProfitRebateSource(executor, { rows });
      sourceLoads.push({
        family: "rebate",
        sourceId,
        rowCount: rows.length,
        l1RowCount: loaded.l1RowCount,
        loadSeconds: elapsedSeconds(loadStartedAt),
        loadPath: "js_uf_normalize_to_l1",
      });
      reconResultCount += loaded.reconResults.length;
    }

    for (const sourceId of uniqueSourceIds(input.sources.feeSourceIds)) {
      const loadStartedAt = Date.now();
      const normalized = await normalizeSource(executor, { runId, family: "fee_fact", sourceId });
      const rows = normalized.rows as FrontProfitFeeSourceRow[];
      assertRowsBelongToPeriod("fee_fact", rows, period);
      const loaded = await loadFrontProfitFeeSource(executor, { rows });
      sourceLoads.push({
        family: "fee_fact",
        sourceId,
        rowCount: rows.length,
        l1RowCount: loaded.l1RowCount,
        loadSeconds: elapsedSeconds(loadStartedAt),
        loadPath: "js_uf_normalize_to_l1",
      });
      reconResultCount += loaded.reconResults.length;
    }

    if (
      uniqueSourceIds(input.sources.feeSourceIds).length > 0 ||
      (input.requiredFeeKinds?.length ?? 0) > 0
    ) {
      const loadStartedAt = Date.now();
      const loaded = await applyFrontProfitFeeAuthorityToL1(executor, {
        runId,
        period,
        requiredFeeKinds: input.requiredFeeKinds,
      });
      sourceLoads.push({
        family: "fee_authoritative",
        sourceId: null,
        rowCount: loaded.authoritativeRows.length,
        l1RowCount: loaded.l1RowCount,
        loadSeconds: elapsedSeconds(loadStartedAt),
        loadPath: "l1_authority_apply",
      });
      reconResultCount += loaded.reconResults.length;
    }

    for (const sourceId of uniqueSourceIds(input.sources.promotionSourceIds)) {
      const loadStartedAt = Date.now();
      const normalized = await normalizeSource(executor, { runId, family: "promotion_spend", sourceId });
      const rows = normalized.rows as FrontProfitPromotionSourceRow[];
      assertRowsBelongToPeriod("promotion_spend", rows, period);
      const loaded = await loadFrontProfitPromotionSource(executor, { rows });
      sourceLoads.push({
        family: "promotion_spend",
        sourceId,
        rowCount: rows.length,
        l1RowCount: loaded.l1RowCount,
        loadSeconds: elapsedSeconds(loadStartedAt),
        loadPath: "js_uf_normalize_to_l1",
      });
      reconResultCount += loaded.reconResults.length;
    }

    await recordComplexJobStep(executor, {
      runId,
      stepKey: currentStep,
      status: "succeeded",
      rowsIn: allSourceIds.length,
      rowsOut: sourceLoads.reduce((total, item) => total + item.l1RowCount, 0),
    });

    await enterStep("l3_stage");
    const stageL3 = async (
      family: FrontProfitL3StageTiming["family"],
      stage: () => Promise<{ rowCount: number }>,
    ) => {
      const startedAt = Date.now();
      const result = await stage();
      l3StageTimings.push({
        family,
        rowCount: result.rowCount,
        seconds: elapsedSeconds(startedAt),
      });
      l3RowCount += result.rowCount;
    };
    if (uniqueSourceIds(input.sources.salesSourceIds).length > 0) {
      await stageL3("sales_fact", () => stageFrontProfitSalesL1ToL3(executor, {
        runId,
        period,
        mappingVersionId: input.mappingVersionId,
        jobVersion: input.jobVersion ?? FRONT_PROFIT_DRAFT_RUNNER_VERSION,
      }));
    }
    if (uniqueSourceIds(input.sources.costUsageSourceIds).length > 0) {
      await stageL3("cost_applied", () => stageFrontProfitCostL1ToL3(executor, {
        runId,
        period,
        mappingVersionId: input.mappingVersionId,
        jobVersion: input.jobVersion ?? FRONT_PROFIT_DRAFT_RUNNER_VERSION,
      }));
    }
    if (uniqueSourceIds(input.sources.rebateSourceIds).length > 0) {
      await stageL3("rebate", () => stageFrontProfitRebateL1ToL3(executor, {
        runId,
        period,
        mappingVersionId: input.mappingVersionId,
        jobVersion: input.jobVersion ?? FRONT_PROFIT_DRAFT_RUNNER_VERSION,
      }));
    }
    if (uniqueSourceIds(input.sources.feeSourceIds).length > 0 || (input.requiredFeeKinds?.length ?? 0) > 0) {
      await stageL3("fee_authoritative", () => stageFrontProfitFeeL1ToL3(executor, {
        runId,
        period,
        mappingVersionId: input.mappingVersionId,
        jobVersion: input.jobVersion ?? FRONT_PROFIT_DRAFT_RUNNER_VERSION,
      }));
    }
    if (uniqueSourceIds(input.sources.promotionSourceIds).length > 0) {
      await stageL3("promotion_spend", () => stageFrontProfitPromotionL1ToL3(executor, {
        runId,
        period,
        mappingVersionId: input.mappingVersionId,
        jobVersion: input.jobVersion ?? FRONT_PROFIT_DRAFT_RUNNER_VERSION,
      }));
    }
    await recordComplexJobStep(executor, {
      runId,
      stepKey: currentStep,
      status: "succeeded",
      rowsOut: l3RowCount,
    });

    await enterStep("l4_aggregate");
    const aggregate = await aggregateFrontProfitL3ToL4(executor, { runId, period });
    l4RowCount = aggregate.rowCount;
    reconResultCount += aggregate.reconResults.length;
    await recordComplexJobStep(executor, {
      runId,
      stepKey: currentStep,
      status: "succeeded",
      rowsIn: l3RowCount,
      rowsOut: l4RowCount,
    });

    await enterStep("shadow_recon");
    if (input.manualBaselineSourceId != null) {
      const manualRows = await readFrontProfitManualBaselineRowsFromUf(executor, {
        sourceId: input.manualBaselineSourceId,
      });
      assertRowsBelongToPeriod("manual_baseline", manualRows.map((row, index) => ({
        period: String(row.date).slice(0, 7),
        sourceId: input.manualBaselineSourceId!,
        sourceRowNo: index + 2,
      })), period);
      const shadow = await writeFrontProfitShadowReconciliation(executor, {
        runId,
        period,
        manualRows,
        baselineLabel: `manual-source:${input.manualBaselineSourceId}`,
      });
      dqEventCount += shadow.dqEventCount;
      reconResultCount += shadow.reconResults.length;
      await recordComplexJobStep(executor, {
        runId,
        stepKey: currentStep,
        status: "succeeded",
        rowsIn: manualRows.length,
        rowsOut: shadow.reconResults.length,
      });
    } else {
      await recordComplexJobStep(executor, {
        runId,
        stepKey: currentStep,
        status: "skipped",
      });
    }

    await updateComplexJobRunStatus(executor, {
      runId,
      moduleCode: FRONT_PROFIT_MODULE_CODE,
      status: "recon_pending",
      lastCheckpointStep: currentStep,
    });
    return {
      runId,
      period,
      status: "recon_pending",
      sourceLoads,
      l3StageTimings,
      l3RowCount,
      l4RowCount,
      reconResultCount,
      dqEventCount,
    };
  } catch (error) {
    const failed = await failRun(executor, { runId, stepKey: currentStep, error });
    return {
      ...failed,
      period,
      sourceLoads,
      l3StageTimings,
      l3RowCount,
      l4RowCount,
      reconResultCount,
      dqEventCount: dqEventCount + failed.dqEventCount,
    };
  }
}
