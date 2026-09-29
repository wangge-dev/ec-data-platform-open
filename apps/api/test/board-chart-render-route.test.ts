import { beforeEach, describe, expect, test, vi } from "vitest";
import { Hono } from "hono";
import { sign } from "../src/lib/auth.js";

const mocks = vi.hoisted(() => ({
  limit: vi.fn(),
  executeWithMetadata: vi.fn(),
}));

vi.mock("../src/lib/current-auth-user.js", () => ({
  resolveCurrentAuthUser: vi.fn(async (payload: any) => payload),
}));

vi.mock("../src/db/client", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: mocks.limit })),
      })),
    })),
  },
  sql: {},
}));

vi.mock("../src/db/table-scope", () => ({
  resolveExistingRuntimeTableReferenceFromSql: vi.fn(),
}));

vi.mock("../src/lib/local-readonly-sql", () => ({
  executeLocalReadOnlyQuery: vi.fn(),
  executeLocalReadOnlyQueryWithMetadata: mocks.executeWithMetadata,
  LOCAL_SQL_MAX_ROWS: 5000,
}));

import boardRoutes from "../src/routes/board.js";

const token = sign({ uid: 1, username: "admin", isAdmin: true, tokenVersion: 0 });

function prepareChart(
  dateField: unknown = "event_date",
  chart: { chartType?: string; config?: Record<string, unknown> } = {},
) {
  mocks.limit
    .mockResolvedValueOnce([{
      id: 7,
      datasetId: 9,
      chartType: chart.chartType ?? "kpi",
      config: { dateField, ...(chart.config ?? {}) },
    }])
    .mockResolvedValueOnce([{
      id: 9,
      queryType: "sql",
      queryText: "SELECT event_date, gmv FROM user_data.uf_1",
    }]);
}

async function requestRender(query = "") {
  const app = new Hono();
  app.route("/board", boardRoutes);
  return app.request(`/board/charts/7/render${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("board chart render route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test.each([
    {
      query: "?from=2026-08-01",
      condition: 'sub."event_date"::text)::date >= $1::date',
      parameters: ["2026-08-01"],
    },
    {
      query: "?to=2026-08-20",
      condition: 'sub."event_date"::text)::date <= $1::date',
      parameters: ["2026-08-20"],
    },
    {
      query: "?from=2026-08-01&to=2026-08-20",
      condition: 'sub."event_date"::text)::date BETWEEN $1::date AND $2::date',
      parameters: ["2026-08-01", "2026-08-20"],
    },
  ])("applies the requested date boundary: $query", async ({ query, condition, parameters }) => {
    prepareChart();
    mocks.executeWithMetadata.mockResolvedValue({ rows: [{ gmv: 1 }], truncated: false, rowLimit: 5000 });

    const response = await requestRender(query);
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(mocks.executeWithMetadata).toHaveBeenCalledOnce();
    expect(mocks.executeWithMetadata.mock.calls[0][0]).toContain(condition);
    expect(mocks.executeWithMetadata.mock.calls[0][1]).toEqual(parameters);
    expect(body.data).toMatchObject({ complete: true, truncated: false, filterApplied: true });
  });

  test.each(["2026-02-30", "08/01/2026", "2026-8-01"])(
    "rejects an invalid date boundary without querying: %s",
    async (from) => {
      prepareChart();

      const response = await requestRender(`?from=${encodeURIComponent(from)}`);
      const body = await response.json() as any;

      expect(response.status).toBe(400);
      expect(body.code).toBe("CHART_DATE_FILTER_INVALID");
      expect(mocks.executeWithMetadata).not.toHaveBeenCalled();
    },
  );

  test("rejects an inverted date range without querying", async () => {
    prepareChart();

    const response = await requestRender("?from=2026-08-20&to=2026-08-01");
    const body = await response.json() as any;

    expect(response.status).toBe(400);
    expect(body.code).toBe("CHART_DATE_FILTER_INVALID");
    expect(mocks.executeWithMetadata).not.toHaveBeenCalled();
  });

  test("fails visibly when the configured date field cannot be converted, without an unfiltered retry", async () => {
    prepareChart();
    mocks.executeWithMetadata.mockRejectedValue(new Error("invalid input syntax for type date: secret-value"));

    const response = await requestRender("?from=2026-08-01");
    const body = await response.json() as any;

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ ok: false, code: "CHART_DATE_FILTER_FAILED" });
    expect(body.message).not.toContain("secret-value");
    expect(mocks.executeWithMetadata).toHaveBeenCalledOnce();
  });

  test("redacts an unexpected database error from an unfiltered render", async () => {
    prepareChart();
    mocks.executeWithMetadata.mockRejectedValue(
      new Error("password=top-secret relation user_data.uf_1 failed"),
    );

    const response = await requestRender();
    const body = await response.json() as any;

    expect(response.status).toBe(400);
    expect(body).toEqual({
      ok: false,
      code: "CHART_QUERY_FAILED",
      message: "图表数据查询失败，请检查数据集或图表配置。",
    });
    expect(JSON.stringify(body)).not.toContain("top-secret");
    expect(JSON.stringify(body)).not.toContain("user_data");
  });

  test("rejects a missing or unsafe date field when a boundary was requested", async () => {
    prepareChart("event_date::date");

    const response = await requestRender("?to=2026-08-20");
    const body = await response.json() as any;

    expect(response.status).toBe(400);
    expect(body.code).toBe("CHART_DATE_FILTER_INVALID");
    expect(mocks.executeWithMetadata).not.toHaveBeenCalled();
  });

  test.each([
    { returnedRows: 4999, truncated: false, expectedStatus: 200 },
    { returnedRows: 5000, truncated: false, expectedStatus: 200 },
    { returnedRows: 5000, truncated: true, expectedStatus: 422 },
  ])(
    "keeps chart aggregation closed for the $returnedRows/$truncated result state",
    async ({ returnedRows, truncated, expectedStatus }) => {
      prepareChart();
      const rows = Array.from({ length: returnedRows }, (_, index) => ({ id: index + 1 }));
      mocks.executeWithMetadata.mockResolvedValue({ rows, truncated, rowLimit: 5000 });

      const response = await requestRender();
      const body = await response.json() as any;

      expect(response.status).toBe(expectedStatus);
      if (truncated) {
        expect(body).toMatchObject({ ok: false, code: "CHART_DATA_INCOMPLETE" });
        expect(body.data).toEqual({ complete: false, truncated: true, rowLimit: 5000 });
        expect(body.data.rows).toBeUndefined();
      } else {
        expect(body.data).toMatchObject({
          complete: true,
          truncated: false,
          rowLimit: 5000,
          filterApplied: false,
        });
        expect(body.data.rows).toHaveLength(returnedRows);
      }
    },
  );

  test("falls back to a complete server aggregation for a supported large chart", async () => {
    prepareChart("event_date", {
      chartType: "stacked_bar",
      config: {
        aggregationMode: "sum",
        filterFields: ["platform", "region"],
        xField: "category",
        seriesField: "platform",
        yFields: ["gmv"],
      },
    });
    mocks.executeWithMetadata
      .mockResolvedValueOnce({ rows: Array.from({ length: 5000 }), truncated: true, rowLimit: 5000 })
      .mockResolvedValueOnce({
        rows: [{ platform: "天猫", region: "华东", category: "家居", gmv: 123 }],
        truncated: false,
        rowLimit: 5000,
      });

    const response = await requestRender();
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(mocks.executeWithMetadata).toHaveBeenCalledTimes(2);
    expect(mocks.executeWithMetadata.mock.calls[1][0]).toContain("GROUP BY");
    expect(body.data).toMatchObject({
      complete: true,
      truncated: false,
      aggregation: {
        mode: "server",
        groupFields: ["platform", "region", "category"],
        sumFields: ["gmv"],
        sourceRowLimit: 5000,
      },
    });
    expect(body.data.rows).toHaveLength(1);
  });

  test("still fails closed when the aggregated result exceeds the row budget", async () => {
    prepareChart("event_date", {
      chartType: "bar",
      config: { aggregationMode: "sum", xField: "category", yFields: ["gmv"] },
    });
    mocks.executeWithMetadata
      .mockResolvedValueOnce({ rows: Array.from({ length: 5000 }), truncated: true, rowLimit: 5000 })
      .mockResolvedValueOnce({ rows: Array.from({ length: 5000 }), truncated: true, rowLimit: 5000 });

    const response = await requestRender();
    const body = await response.json() as any;

    expect(response.status).toBe(422);
    expect(body).toMatchObject({ ok: false, code: "CHART_DATA_INCOMPLETE" });
    expect(body.data.rows).toBeUndefined();
  });

  test("does not aggregate a large detail table", async () => {
    prepareChart("event_date", {
      chartType: "table",
      config: { aggregationMode: "sum", xField: "category", yFields: ["gmv"] },
    });
    mocks.executeWithMetadata.mockResolvedValue({
      rows: Array.from({ length: 5000 }),
      truncated: true,
      rowLimit: 5000,
    });

    const response = await requestRender();
    const body = await response.json() as any;

    expect(response.status).toBe(422);
    expect(body.code).toBe("CHART_DATA_INCOMPLETE");
    expect(mocks.executeWithMetadata).toHaveBeenCalledOnce();
  });
});
