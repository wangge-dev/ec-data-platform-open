import { describe, expect, test, vi } from "vitest";
import {
  FrontProfitAuthorityError,
  assertFrontProfitAutoDraftAuthority,
  assertFrontProfitAutoPublishAuthority,
  assertFrontProfitManualImportAuthority,
  getOrCreateFrontProfitPeriodAuthority,
  reopenFrontProfitPeriod,
  setFrontProfitPeriodAuthority,
} from "../src/services/front-profit-authority.js";

type StoredAuthority = {
  authority: "manual" | "auto";
  close_day: number;
  reopened_at: Date | null;
};

function fakeAuthorityExecutor() {
  const rows = new Map<string, StoredAuthority>();
  const events: Array<{
    action: string;
    from: unknown;
    to: unknown;
    actor: unknown;
    payload: unknown;
  }> = [];
  const executor = {
    rows,
    events,
    unsafe: vi.fn(async (query: string, parameters?: unknown[]) => {
      const text = String(query);
      const key = `${parameters?.[0]}:${parameters?.[1]}`;

      if (text.startsWith("INSERT INTO public.period_authority_event")) {
        events.push({
          action: String(parameters?.[2]),
          from: parameters?.[3],
          to: parameters?.[4],
          actor: parameters?.[5],
          payload: parameters?.[7],
        });
        return [];
      }

      if (text.startsWith("INSERT INTO public.period_authority")) {
        if (rows.has(key)) return [];
        rows.set(key, {
          authority: "manual",
          close_day: Number(parameters?.[2]),
          reopened_at: null,
        });
        return [{ id: rows.size }];
      }

      if (text.startsWith("SELECT authority, close_day, reopened_at")) {
        const row = rows.get(key);
        return row ? [row] : [];
      }

      if (text.startsWith("UPDATE public.period_authority") && text.includes("SET authority")) {
        const row = rows.get(key);
        if (row) row.authority = parameters?.[2] as "manual" | "auto";
        return [];
      }

      if (text.startsWith("UPDATE public.period_authority") && text.includes("SET reopened_by")) {
        const row = rows.get(key);
        if (row) row.reopened_at = new Date("2026-09-06T00:00:00.000Z");
        return [];
      }

      throw new Error(`unexpected SQL: ${text}`);
    }),
  };
  return executor;
}

describe("front-profit persisted authority gate", () => {
  test("lazily initializes missing periods as manual exactly once", async () => {
    const executor = fakeAuthorityExecutor();

    await expect(getOrCreateFrontProfitPeriodAuthority(executor, "2026-08", {
      actorId: 7,
    })).resolves.toMatchObject({
      period: "2026-08",
      scopeKey: "front_profit:2026-08",
      authority: "manual",
      closeDay: 5,
    });
    await getOrCreateFrontProfitPeriodAuthority(executor, "2026-08", { actorId: 7 });

    expect(executor.rows.size).toBe(1);
    expect(executor.events).toEqual([
      {
        action: "initialized",
        from: null,
        to: "manual",
        actor: 7,
        payload: JSON.stringify({
          period: "2026-08",
          scopeKey: "front_profit:2026-08",
          closeDay: 5,
        }),
      },
    ]);
  });

  test("allows shadow draft under manual but blocks formal publish until authority is auto", async () => {
    const executor = fakeAuthorityExecutor();

    await expect(assertFrontProfitAutoDraftAuthority(executor, ["2026-08"], {
      today: "2026-09-01",
    })).resolves.toHaveLength(1);
    await expect(assertFrontProfitAutoPublishAuthority(executor, ["2026-08"], {
      today: "2026-09-01",
    })).rejects.toMatchObject({
      decisions: [{ code: "FRONT_PROFIT_PERIOD_AUTHORITY_MANUAL" }],
    });

    await setFrontProfitPeriodAuthority(executor, {
      period: "2026-08",
      authority: "auto",
      actorId: 9,
      reason: "synthetic cutover",
    });

    await expect(assertFrontProfitAutoPublishAuthority(executor, ["2026-08"], {
      today: "2026-09-01",
    })).resolves.toHaveLength(1);
    await expect(assertFrontProfitManualImportAuthority(executor, ["2026-08"], {
      today: "2026-09-01",
    })).rejects.toBeInstanceOf(FrontProfitAuthorityError);
  });

  test("fails closed after the close day unless the period is reopened", async () => {
    const executor = fakeAuthorityExecutor();
    await setFrontProfitPeriodAuthority(executor, {
      period: "2026-08",
      authority: "auto",
      actorId: 9,
    });

    await expect(assertFrontProfitAutoPublishAuthority(executor, ["2026-08"], {
      today: "2026-09-05",
    })).rejects.toMatchObject({
      decisions: [{ code: "FRONT_PROFIT_PERIOD_CLOSED" }],
    });

    await reopenFrontProfitPeriod(executor, {
      period: "2026-08",
      actorId: 9,
      reason: "synthetic correction",
    });

    await expect(assertFrontProfitAutoPublishAuthority(executor, ["2026-08"], {
      today: "2026-09-05",
    })).resolves.toHaveLength(1);
    expect(executor.events.map((event) => event.action)).toEqual([
      "initialized",
      "set_authority",
      "reopen_period",
    ]);
    expect(executor.events.every((event) => typeof event.payload === "string")).toBe(true);
    expect(executor.events.map((event) => JSON.parse(String(event.payload)))).toEqual([
      { period: "2026-08", scopeKey: "front_profit:2026-08", closeDay: 5 },
      { period: "2026-08" },
      { period: "2026-08" },
    ]);
  });
});
