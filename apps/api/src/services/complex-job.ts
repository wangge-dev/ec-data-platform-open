const MODULE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SCOPE_KEY_PATTERN = /^[\x21-\x7E]{1,128}$/;

export const COMPLEX_JOB_LOCK_NAMESPACE = "complex-job";

export class ComplexJobContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComplexJobContractError";
  }
}

export class ComplexJobGateError extends Error {
  constructor(
    public readonly blockingEventCodes: string[],
    public readonly failedReconMetrics: string[],
  ) {
    super("complex job publish gate rejected the run");
    this.name = "ComplexJobGateError";
  }
}

export type GateDqEvent = {
  severity: "block" | "warn" | "allow" | string;
  code: string;
  resolvedAt?: unknown;
};

export type GateReconResult = {
  layer: string;
  metric: string;
  passed: boolean;
};

export type PublishGateInput = {
  dqEvents: GateDqEvent[];
  reconResults: GateReconResult[];
};

export type ComplexJobSqlExecutor = {
  unsafe(query: string, parameters?: unknown[]): PromiseLike<Array<Record<string, unknown>>>;
};

export type ComplexJobRunStatus =
  | "queued"
  | "running"
  | "recon_pending"
  | "gated"
  | "published"
  | "failed"
  | "rolled_back";

export type ComplexJobStepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export type PublishGateSummary = {
  ok: boolean;
  blockingEventCodes: string[];
  failedReconMetrics: string[];
};

export function assertModuleCode(moduleCode: string): string {
  if (!MODULE_CODE_PATTERN.test(moduleCode)) {
    throw new ComplexJobContractError("moduleCode must be a lowercase module identifier");
  }
  return moduleCode;
}

export function assertScopeKey(scopeKey: string): string {
  if (!SCOPE_KEY_PATTERN.test(scopeKey)) {
    throw new ComplexJobContractError("scopeKey must be 1-128 visible ASCII characters");
  }
  return scopeKey;
}

export function jobRunLockKey(moduleCode: string, scopeKey: string): string {
  return `${COMPLEX_JOB_LOCK_NAMESPACE}:job:${assertModuleCode(moduleCode)}:${assertScopeKey(scopeKey)}`;
}

export function publishLockKey(moduleCode: string): string {
  return `${COMPLEX_JOB_LOCK_NAMESPACE}:publish:${assertModuleCode(moduleCode)}`;
}

export function mappingLockKey(role: string): string {
  return `${COMPLEX_JOB_LOCK_NAMESPACE}:mapping:${assertModuleCode(role)}`;
}

function assertPositiveSafeId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ComplexJobContractError(`${label} must be a positive safe integer`);
  }
  return value;
}

function assertStepKey(stepKey: string): string {
  if (!MODULE_CODE_PATTERN.test(stepKey)) {
    throw new ComplexJobContractError("stepKey must be a lowercase step identifier");
  }
  return stepKey;
}

function assertRunStatus(status: string): ComplexJobRunStatus {
  if (!["queued", "running", "recon_pending", "gated", "published", "failed", "rolled_back"].includes(status)) {
    throw new ComplexJobContractError("job run status is invalid");
  }
  return status as ComplexJobRunStatus;
}

function assertStepStatus(status: string): ComplexJobStepStatus {
  if (!["pending", "running", "succeeded", "failed", "skipped"].includes(status)) {
    throw new ComplexJobContractError("job step status is invalid");
  }
  return status as ComplexJobStepStatus;
}

function assertJsonArray(value: readonly unknown[]): readonly unknown[] {
  return value;
}

export async function createComplexJobRun(
  executor: ComplexJobSqlExecutor,
  input: {
    moduleCode: string;
    scopeKey: string;
    inputBatchIds?: readonly unknown[];
    triggeredBy?: number | null;
    status?: ComplexJobRunStatus;
  },
): Promise<number> {
  const moduleCode = assertModuleCode(input.moduleCode);
  const scopeKey = assertScopeKey(input.scopeKey);
  const status = assertRunStatus(input.status ?? "running");
  const [row] = await executor.unsafe(
    `INSERT INTO public.job_run
       (module_code, scope_key, status, input_batch_ids, started_at, heartbeat_at, triggered_by)
     VALUES ($1, $2, $3::varchar, $4::jsonb, NOW(), NOW(), $5)
     RETURNING id`,
    [
      moduleCode,
      scopeKey,
      status,
      assertJsonArray(input.inputBatchIds ?? []),
      input.triggeredBy ?? null,
    ],
  );
  return assertPositiveSafeId(Number(row?.id), "runId");
}

export async function updateComplexJobRunStatus(
  executor: ComplexJobSqlExecutor,
  input: {
    runId: number;
    moduleCode: string;
    status: ComplexJobRunStatus;
    lastCheckpointStep?: string | null;
  },
): Promise<void> {
  const runId = assertPositiveSafeId(input.runId, "runId");
  const moduleCode = assertModuleCode(input.moduleCode);
  const status = assertRunStatus(input.status);
  const lastCheckpointStep = input.lastCheckpointStep == null
    ? null
    : assertStepKey(input.lastCheckpointStep);
  await executor.unsafe(
    `UPDATE public.job_run
        SET status = $3::varchar,
            last_checkpoint_step = COALESCE($4, last_checkpoint_step),
            heartbeat_at = NOW(),
            finished_at = CASE
              WHEN $3::varchar IN ('recon_pending', 'gated', 'published', 'failed', 'rolled_back') THEN NOW()
              ELSE finished_at
            END,
            updated_at = NOW()
      WHERE id = $1 AND module_code = $2`,
    [runId, moduleCode, status, lastCheckpointStep],
  );
}

export async function recordComplexJobStep(
  executor: ComplexJobSqlExecutor,
  input: {
    runId: number;
    stepKey: string;
    status: ComplexJobStepStatus;
    attempt?: number;
    rowsIn?: number | null;
    rowsOut?: number | null;
    errorCode?: string | null;
  },
): Promise<void> {
  const runId = assertPositiveSafeId(input.runId, "runId");
  const stepKey = assertStepKey(input.stepKey);
  const status = assertStepStatus(input.status);
  const attempt = input.attempt ?? 1;
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new ComplexJobContractError("attempt must be a positive safe integer");
  }
  await executor.unsafe(
    `INSERT INTO public.job_step
       (run_id, step_key, attempt, status, rows_in, rows_out, error_code, started_at, finished_at)
     VALUES ($1, $2, $3, $4::varchar, $5, $6, $7, clock_timestamp(),
             CASE WHEN $4::varchar IN ('succeeded', 'failed', 'skipped') THEN clock_timestamp() ELSE NULL END)
     ON CONFLICT (run_id, step_key, attempt) DO UPDATE SET
       status = EXCLUDED.status,
       rows_in = EXCLUDED.rows_in,
       rows_out = EXCLUDED.rows_out,
       error_code = EXCLUDED.error_code,
       started_at = COALESCE(public.job_step.started_at, EXCLUDED.started_at),
       finished_at = EXCLUDED.finished_at`,
    [
      runId,
      stepKey,
      attempt,
      status,
      input.rowsIn ?? null,
      input.rowsOut ?? null,
      input.errorCode ?? null,
    ],
  );
}

export async function recordComplexJobDqEvent(
  executor: ComplexJobSqlExecutor,
  input: {
    runId: number;
    severity: "block" | "warn" | "allow";
    code: string;
    sourceId?: number | null;
    rowNo?: number | null;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  const runId = assertPositiveSafeId(input.runId, "runId");
  await executor.unsafe(
    `INSERT INTO public.dq_event
       (run_id, severity, code, source_id, row_no, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      runId,
      input.severity,
      input.code,
      input.sourceId ?? null,
      input.rowNo ?? null,
      input.payload ?? {},
    ],
  );
}

export function summarizePublishGate(input: PublishGateInput): PublishGateSummary {
  const blockingEventCodes = input.dqEvents
    .filter((event) => event.severity === "block" && event.resolvedAt == null)
    .map((event) => event.code);
  const failedReconMetrics = input.reconResults
    .filter((result) => !result.passed)
    .map((result) => `${result.layer}:${result.metric}`);
  return {
    ok: blockingEventCodes.length === 0 && failedReconMetrics.length === 0,
    blockingEventCodes,
    failedReconMetrics,
  };
}

export function assertPublishGate(input: PublishGateInput): void {
  const summary = summarizePublishGate(input);
  if (!summary.ok) {
    throw new ComplexJobGateError(summary.blockingEventCodes, summary.failedReconMetrics);
  }
}

export async function loadPublishGateInputForRun(
  executor: ComplexJobSqlExecutor,
  runId: number,
): Promise<PublishGateInput> {
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new ComplexJobContractError("runId must be a positive safe integer");
  }
  const dqEvents = await executor.unsafe(
    `SELECT severity, code, resolved_at AS "resolvedAt"
       FROM public.dq_event
      WHERE run_id = $1`,
    [runId],
  );
  const reconResults = await executor.unsafe(
    `SELECT layer, metric, passed
       FROM public.recon_result
      WHERE run_id = $1`,
    [runId],
  );
  return {
    dqEvents: dqEvents.map((row) => ({
      severity: String(row.severity),
      code: String(row.code),
      resolvedAt: row.resolvedAt ?? row.resolved_at,
    })),
    reconResults: reconResults.map((row) => ({
      layer: String(row.layer),
      metric: String(row.metric),
      passed: row.passed === true,
    })),
  };
}

export async function assertPublishGateForRun(
  executor: ComplexJobSqlExecutor,
  runId: number,
): Promise<void> {
  assertPublishGate(await loadPublishGateInputForRun(executor, runId));
}
