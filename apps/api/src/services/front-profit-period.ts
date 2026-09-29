import { normalizeFrontProfitDate } from "./front-profit-standard.js";

export const FRONT_PROFIT_MODULE_CODE = "front_profit";
export const FRONT_PROFIT_CLOSE_DAY_OF_NEXT_MONTH = 5;

export type FrontProfitAuthority = "manual" | "auto";
export type FrontProfitAuthorityOperation = "manual_import" | "auto_draft" | "auto_publish";

export type FrontProfitAuthorityGateInput = {
  authority?: FrontProfitAuthority | null;
  operation: FrontProfitAuthorityOperation;
  periodClosed?: boolean;
  periodReopened?: boolean;
};

export type FrontProfitAuthorityGateDecision = {
  ok: boolean;
  code?: "FRONT_PROFIT_PERIOD_AUTHORITY_MANUAL"
    | "FRONT_PROFIT_PERIOD_AUTHORITY_AUTO"
    | "FRONT_PROFIT_PERIOD_CLOSED";
};

export class FrontProfitPeriodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontProfitPeriodError";
  }
}

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const SCOPE_PATTERN = /^front_profit:(\d{4}-(?:0[1-9]|1[0-2]))$/;

function assertPeriod(period: string): string {
  if (!PERIOD_PATTERN.test(period)) {
    throw new FrontProfitPeriodError("front-profit period must be YYYY-MM");
  }
  return period;
}

function assertCloseDay(closeDay: number): number {
  if (!Number.isInteger(closeDay) || closeDay < 1 || closeDay > 28) {
    throw new FrontProfitPeriodError("front-profit close day must be an integer between 1 and 28");
  }
  return closeDay;
}

export function deriveFrontProfitPeriod(dateValue: unknown): string {
  const normalized = normalizeFrontProfitDate(dateValue);
  if (!normalized) {
    throw new FrontProfitPeriodError("front-profit date cannot derive a period");
  }
  return normalized.slice(0, 7);
}

export function frontProfitScopeKey(period: string): string {
  return `${FRONT_PROFIT_MODULE_CODE}:${assertPeriod(period)}`;
}

export function parseFrontProfitScopeKey(scopeKey: string): string | null {
  return SCOPE_PATTERN.exec(scopeKey)?.[1] ?? null;
}

export function frontProfitCloseDate(
  period: string,
  closeDay = FRONT_PROFIT_CLOSE_DAY_OF_NEXT_MONTH,
): string {
  assertPeriod(period);
  assertCloseDay(closeDay);
  const [yearText, monthText] = period.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const closeYear = month === 12 ? year + 1 : year;
  const closeMonth = month === 12 ? 1 : month + 1;
  return `${closeYear}-${String(closeMonth).padStart(2, "0")}-${String(closeDay).padStart(2, "0")}`;
}

export function isFrontProfitPeriodClosed(
  period: string,
  today: string,
  closeDay = FRONT_PROFIT_CLOSE_DAY_OF_NEXT_MONTH,
): boolean {
  const normalizedToday = normalizeFrontProfitDate(today);
  if (!normalizedToday) {
    throw new FrontProfitPeriodError("today must be a valid date");
  }
  return normalizedToday >= frontProfitCloseDate(period, closeDay);
}

export function evaluateFrontProfitAuthorityGate(
  input: FrontProfitAuthorityGateInput,
): FrontProfitAuthorityGateDecision {
  const authority = input.authority ?? "manual";
  if (input.periodClosed && !input.periodReopened) {
    return { ok: false, code: "FRONT_PROFIT_PERIOD_CLOSED" };
  }
  if (input.operation === "manual_import" && authority === "auto") {
    return { ok: false, code: "FRONT_PROFIT_PERIOD_AUTHORITY_AUTO" };
  }
  if (input.operation === "auto_publish" && authority === "manual") {
    return { ok: false, code: "FRONT_PROFIT_PERIOD_AUTHORITY_MANUAL" };
  }
  return { ok: true };
}
