import { beforeEach, describe, expect, test, vi } from "vitest";
import { sign } from "../src/lib/auth.js";

const mocks = vi.hoisted(() => {
  const rows = new Map<string, { authority: "manual" | "auto"; close_day: number; reopened_at: Date | null }>();
  const events: string[] = [];
  const unsafe = vi.fn(async (query: string, parameters?: unknown[]) => {
    const text = String(query);
    const key = `${parameters?.[0]}:${parameters?.[1]}`;

    if (text.startsWith("INSERT INTO public.period_authority_event")) {
      events.push(String(parameters?.[2]));
      return [];
    }
    if (text.startsWith("INSERT INTO public.period_authority")) {
      if (!rows.has(key)) {
        rows.set(key, {
          authority: "manual",
          close_day: Number(parameters?.[2]),
          reopened_at: null,
        });
        return [{ id: rows.size }];
      }
      return [];
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
  });
  return {
    rows,
    events,
    unsafe,
    begin: vi.fn(async (callback: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) =>
      callback({ unsafe })),
  };
});

vi.mock("../src/lib/current-auth-user.js", () => ({
  resolveCurrentAuthUser: vi.fn(async (payload: any) => payload),
}));

vi.mock("../src/db/client", () => ({
  sql: {
    unsafe: mocks.unsafe,
    begin: mocks.begin,
  },
}));

import frontProfitRoutes from "../src/routes/front-profit.js";

const adminToken = sign({ uid: 1, username: "admin", isAdmin: true, tokenVersion: 0 });
const userToken = sign({ uid: 2, username: "operator", isAdmin: false, tokenVersion: 0 });

describe("front-profit authority routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows.clear();
    mocks.events.length = 0;
  });

  test("requires an administrator for authority changes", async () => {
    const response = await frontProfitRoutes.request("/authority/2026-08", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${userToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ authority: "auto" }),
    });

    expect(response.status).toBe(403);
    expect(mocks.unsafe).not.toHaveBeenCalled();
  });

  test("updates authority and records the reopen event", async () => {
    const response = await frontProfitRoutes.request("/authority/2026-08", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ authority: "auto", reopen: true, reason: "synthetic cutover" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      period: "2026-08",
      scopeKey: "front_profit:2026-08",
      authority: "auto",
      reopened: true,
    });
    expect(mocks.events).toEqual(["initialized", "set_authority", "reopen_period"]);
  });
});
