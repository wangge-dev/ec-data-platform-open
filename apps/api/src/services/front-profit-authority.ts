import {
  FRONT_PROFIT_CLOSE_DAY_OF_NEXT_MONTH,
  FRONT_PROFIT_MODULE_CODE,
  type FrontProfitAuthority,
  type FrontProfitAuthorityOperation,
  evaluateFrontProfitAuthorityGate,
  frontProfitScopeKey,
  isFrontProfitPeriodClosed,
} from "./front-profit-period.js";
import type { FrontProfitValidationIssue } from "./front-profit-standard.js";

export type AuthoritySqlExecutor = {
  unsafe(query: string, parameters?: unknown[]): PromiseLike<Array<Record<string, unknown>>>;
};

export type FrontProfitAuthorityState = {
  moduleCode: typeof FRONT_PROFIT_MODULE_CODE;
  scopeKey: string;
  period: string;
  authority: FrontProfitAuthority;
  closeDay: number;
  reopenedAt: unknown | null;
};

export type FrontProfitAuthorityDecision = {
  period: string;
  scopeKey: string;
  code: NonNullable<ReturnType<typeof evaluateFrontProfitAuthorityGate>["code"]>;
};

export type FrontProfitAuthorityGateOptions = {
  actorId?: number | null;
  today?: string;
};

export class FrontProfitAuthorityError extends Error {
  constructor(readonly decisions: FrontProfitAuthorityDecision[]) {
    super(`front-profit authority gate rejected ${decisions.length} period(s)`);
    this.name = "FrontProfitAuthorityError";
  }
}

function currentLocalDate(): string {
  const now = new Date();
  return [
    String(now.getFullYear()).padStart(4, "0"),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

function uniqueSortedPeriods(periods: Iterable<string>): string[] {
  return [...new Set(periods)].sort();
}

function isAuthority(value: unknown): value is FrontProfitAuthority {
  return value === "manual" || value === "auto";
}

function parseStateRow(period: string, row: Record<string, unknown> | undefined): FrontProfitAuthorityState {
  const authority = row?.authority;
  const closeDay = Number(row?.close_day);
  if (!isAuthority(authority) || !Number.isInteger(closeDay) || closeDay < 1 || closeDay > 28) {
    throw new FrontProfitAuthorityError([{
      period,
      scopeKey: frontProfitScopeKey(period),
      code: "FRONT_PROFIT_PERIOD_AUTHORITY_MANUAL",
    }]);
  }
  return {
    moduleCode: FRONT_PROFIT_MODULE_CODE,
    scopeKey: frontProfitScopeKey(period),
    period,
    authority,
    closeDay,
    reopenedAt: row?.reopened_at ?? null,
  };
}

async function recordAuthorityEvent(
  executor: AuthoritySqlExecutor,
  input: {
    period: string;
    action: "initialized" | "set_authority" | "reopen_period";
    fromAuthority?: FrontProfitAuthority | null;
    toAuthority?: FrontProfitAuthority | null;
    actorId?: number | null;
    reason?: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await executor.unsafe(
    `INSERT INTO public.period_authority_event
       (module_code, scope_key, action, from_authority, to_authority, actor_id, reason, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      FRONT_PROFIT_MODULE_CODE,
      frontProfitScopeKey(input.period),
      input.action,
      input.fromAuthority ?? null,
      input.toAuthority ?? null,
      input.actorId ?? null,
      input.reason ?? null,
      JSON.stringify(input.payload ?? { period: input.period }),
    ],
  );
}

export async function getOrCreateFrontProfitPeriodAuthority(
  executor: AuthoritySqlExecutor,
  period: string,
  options: { actorId?: number | null; closeDay?: number } = {},
): Promise<FrontProfitAuthorityState> {
  const scopeKey = frontProfitScopeKey(period);
  const closeDay = options.closeDay ?? FRONT_PROFIT_CLOSE_DAY_OF_NEXT_MONTH;
  const inserted = await executor.unsafe(
    `INSERT INTO public.period_authority
       (module_code, scope_key, authority, close_day, created_by, updated_by, created_at, updated_at)
     VALUES ($1, $2, 'manual', $3, $4, $4, NOW(), NOW())
     ON CONFLICT (module_code, scope_key) DO NOTHING
     RETURNING id`,
    [FRONT_PROFIT_MODULE_CODE, scopeKey, closeDay, options.actorId ?? null],
  );

  if (inserted.length > 0) {
    await recordAuthorityEvent(executor, {
      period,
      action: "initialized",
      toAuthority: "manual",
      actorId: options.actorId,
      reason: "lazy default for missing period authority",
      payload: { period, scopeKey, closeDay },
    });
  }

  const rows = await executor.unsafe(
    `SELECT authority, close_day, reopened_at
     FROM public.period_authority
     WHERE module_code = $1 AND scope_key = $2
     LIMIT 1`,
    [FRONT_PROFIT_MODULE_CODE, scopeKey],
  );
  return parseStateRow(period, rows[0]);
}

export async function setFrontProfitPeriodAuthority(
  executor: AuthoritySqlExecutor,
  input: {
    period: string;
    authority: FrontProfitAuthority;
    actorId: number;
    reason?: string | null;
  },
): Promise<FrontProfitAuthorityState> {
  const current = await getOrCreateFrontProfitPeriodAuthority(executor, input.period, {
    actorId: input.actorId,
  });
  if (current.authority === input.authority) return current;

  await executor.unsafe(
    `UPDATE public.period_authority
     SET authority = $3, updated_by = $4, updated_at = NOW()
     WHERE module_code = $1 AND scope_key = $2`,
    [FRONT_PROFIT_MODULE_CODE, current.scopeKey, input.authority, input.actorId],
  );
  await recordAuthorityEvent(executor, {
    period: input.period,
    action: "set_authority",
    fromAuthority: current.authority,
    toAuthority: input.authority,
    actorId: input.actorId,
    reason: input.reason,
  });
  return getOrCreateFrontProfitPeriodAuthority(executor, input.period, { actorId: input.actorId });
}

export async function reopenFrontProfitPeriod(
  executor: AuthoritySqlExecutor,
  input: {
    period: string;
    actorId: number;
    reason?: string | null;
  },
): Promise<FrontProfitAuthorityState> {
  const current = await getOrCreateFrontProfitPeriodAuthority(executor, input.period, {
    actorId: input.actorId,
  });
  if (current.reopenedAt != null) return current;

  await executor.unsafe(
    `UPDATE public.period_authority
     SET reopened_by = $3, reopened_at = NOW(), updated_by = $3, updated_at = NOW()
     WHERE module_code = $1 AND scope_key = $2`,
    [FRONT_PROFIT_MODULE_CODE, current.scopeKey, input.actorId],
  );
  await recordAuthorityEvent(executor, {
    period: input.period,
    action: "reopen_period",
    fromAuthority: current.authority,
    toAuthority: current.authority,
    actorId: input.actorId,
    reason: input.reason,
  });
  return getOrCreateFrontProfitPeriodAuthority(executor, input.period, { actorId: input.actorId });
}

export async function assertFrontProfitAuthorityForPeriods(
  executor: AuthoritySqlExecutor,
  input: {
    periods: Iterable<string>;
    operation: FrontProfitAuthorityOperation;
  } & FrontProfitAuthorityGateOptions,
): Promise<FrontProfitAuthorityState[]> {
  const today = input.today ?? currentLocalDate();
  const states: FrontProfitAuthorityState[] = [];
  const decisions: FrontProfitAuthorityDecision[] = [];

  for (const period of uniqueSortedPeriods(input.periods)) {
    const state = await getOrCreateFrontProfitPeriodAuthority(executor, period, {
      actorId: input.actorId,
    });
    states.push(state);
    const decision = evaluateFrontProfitAuthorityGate({
      authority: state.authority,
      operation: input.operation,
      periodClosed: isFrontProfitPeriodClosed(period, today, state.closeDay),
      periodReopened: state.reopenedAt != null,
    });
    if (!decision.ok) {
      decisions.push({ period, scopeKey: state.scopeKey, code: decision.code! });
    }
  }

  if (decisions.length > 0) throw new FrontProfitAuthorityError(decisions);
  return states;
}

export function frontProfitAuthorityIssues(
  error: FrontProfitAuthorityError,
): FrontProfitValidationIssue[] {
  return error.decisions.map((decision) => ({
    code: decision.code,
    field: decision.period,
  }));
}

export function assertFrontProfitManualImportAuthority(
  executor: AuthoritySqlExecutor,
  periods: Iterable<string>,
  options: FrontProfitAuthorityGateOptions = {},
): Promise<FrontProfitAuthorityState[]> {
  return assertFrontProfitAuthorityForPeriods(executor, {
    ...options,
    periods,
    operation: "manual_import",
  });
}

export function assertFrontProfitAutoDraftAuthority(
  executor: AuthoritySqlExecutor,
  periods: Iterable<string>,
  options: FrontProfitAuthorityGateOptions = {},
): Promise<FrontProfitAuthorityState[]> {
  return assertFrontProfitAuthorityForPeriods(executor, {
    ...options,
    periods,
    operation: "auto_draft",
  });
}

export function assertFrontProfitAutoPublishAuthority(
  executor: AuthoritySqlExecutor,
  periods: Iterable<string>,
  options: FrontProfitAuthorityGateOptions = {},
): Promise<FrontProfitAuthorityState[]> {
  return assertFrontProfitAuthorityForPeriods(executor, {
    ...options,
    periods,
    operation: "auto_publish",
  });
}
