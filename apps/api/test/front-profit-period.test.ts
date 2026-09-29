import { describe, expect, test } from "vitest";
import {
  FRONT_PROFIT_CLOSE_DAY_OF_NEXT_MONTH,
  deriveFrontProfitPeriod,
  evaluateFrontProfitAuthorityGate,
  frontProfitCloseDate,
  frontProfitScopeKey,
  isFrontProfitPeriodClosed,
  parseFrontProfitScopeKey,
} from "../src/services/front-profit-period.js";

describe("front-profit period policy", () => {
  test("derives a natural-month period from the canonical date field", () => {
    expect(deriveFrontProfitPeriod("2026-08-31")).toBe("2026-08");
    expect(frontProfitScopeKey("2026-08")).toBe("front_profit:2026-08");
    expect(parseFrontProfitScopeKey("front_profit:2026-08")).toBe("2026-08");
    expect(parseFrontProfitScopeKey("orders:2026-08")).toBeNull();
  });

  test("uses the next fixed close day with year rollover", () => {
    expect(FRONT_PROFIT_CLOSE_DAY_OF_NEXT_MONTH).toBe(5);
    expect(frontProfitCloseDate("2026-08")).toBe("2026-09-05");
    expect(frontProfitCloseDate("2026-12")).toBe("2027-01-05");
    expect(isFrontProfitPeriodClosed("2026-08", "2026-09-04")).toBe(false);
    expect(isFrontProfitPeriodClosed("2026-08", "2026-09-05")).toBe(true);
  });

  test("keeps the authority gate behavior separate for shadow and formal writes", () => {
    expect(evaluateFrontProfitAuthorityGate({
      authority: "manual",
      operation: "auto_draft",
    })).toEqual({ ok: true });
    expect(evaluateFrontProfitAuthorityGate({
      authority: "manual",
      operation: "auto_publish",
    })).toEqual({ ok: false, code: "FRONT_PROFIT_PERIOD_AUTHORITY_MANUAL" });
    expect(evaluateFrontProfitAuthorityGate({
      authority: "auto",
      operation: "manual_import",
    })).toEqual({ ok: false, code: "FRONT_PROFIT_PERIOD_AUTHORITY_AUTO" });
  });

  test("fails closed after the period closes unless reopened", () => {
    expect(evaluateFrontProfitAuthorityGate({
      authority: "auto",
      operation: "auto_publish",
      periodClosed: true,
    })).toEqual({ ok: false, code: "FRONT_PROFIT_PERIOD_CLOSED" });
    expect(evaluateFrontProfitAuthorityGate({
      authority: "auto",
      operation: "auto_publish",
      periodClosed: true,
      periodReopened: true,
    })).toEqual({ ok: true });
  });
});
