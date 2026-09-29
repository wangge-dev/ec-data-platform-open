import { beforeEach, describe, expect, test, vi } from "vitest";
import { Hono } from "hono";
import { sign } from "../src/lib/auth.js";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("../src/lib/current-auth-user.js", () => ({
  resolveCurrentAuthUser: vi.fn(async (payload: any) => payload),
}));

vi.mock("../src/db/client", () => ({
  db: {
    transaction: mocks.transaction,
  },
  sql: {},
}));

vi.mock("../src/db/table-scope", () => ({
  resolveExistingRuntimeTableReferenceFromSql: vi.fn(),
  runtimeTableReference: vi.fn(() => '"public"."unified_sales"'),
}));

vi.mock("../src/modules/loader", () => ({
  moduleTableName: vi.fn(() => "unified_sales"),
  loadModules: vi.fn(async () => [{
    code: "orders",
    name: "销售订单",
    origin: "builtin",
    semanticModel: {
      schemaVersion: "semantic-manifest/v1",
      id: "orders.analysis",
      version: 1,
      dimensions: [{ id: "orders.pay_date", label: "付款日期", field: "pay_time", kind: "time" }],
      metrics: [{ id: "orders.sales_amount", label: "销售额", aggregation: "sum", field: "amount", unit: "currency", additiveAcrossTime: true }],
    },
  }]),
}));

import boardRoutes from "../src/routes/board.js";

const token = sign({ uid: 1, username: "admin", isAdmin: true, tokenVersion: 0 });

async function createBundle() {
  const app = new Hono();
  app.route("/board", boardRoutes);
  return app.request("/board/chart-bundles", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      dataset: {
        name: "销售数据",
        queryType: "semantic",
        queryText: JSON.stringify({
          modelId: "orders.analysis",
          modelVersion: 1,
          metricIds: ["orders.sales_amount"],
          dimensionIds: ["orders.pay_date"],
          filters: [],
          limit: 200,
        }),
      },
      chart: {
        name: "销售趋势",
        chartType: "line",
        config: {
          aggregationMode: "none",
          xField: "d0__orders__pay_date",
          yFields: ["m0__orders__sales_amount"],
          semanticModelId: "orders.analysis",
          semanticModelVersion: 1,
          metricIds: ["orders.sales_amount"],
          dimensionIds: ["orders.pay_date"],
        },
        moduleCode: "orders",
      },
    }),
  });
}

describe("board chart bundle route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("creates dataset and chart in one database transaction", async () => {
    const tx = { insert: mocks.insert };
    mocks.transaction.mockImplementation(async (callback: (transaction: typeof tx) => unknown) => callback(tx));
    mocks.insert
      .mockReturnValueOnce({
        values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 41, name: "销售数据" }]) })),
      })
      .mockReturnValueOnce({
        values: vi.fn((value) => ({
          returning: vi.fn(async () => [{ id: 81, ...value }]),
        })),
      });

    const response = await createBundle();
    const body = await response.json() as any;

    expect(response.status).toBe(201);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.insert).toHaveBeenCalledTimes(2);
    expect(body.data.dataset.id).toBe(41);
    expect(body.data.chart).toMatchObject({ id: 81, datasetId: 41 });
  });

  test("does not expose a partially created bundle when chart insertion fails", async () => {
    const tx = { insert: mocks.insert };
    mocks.transaction.mockImplementation(async (callback: (transaction: typeof tx) => unknown) => {
      try {
        return await callback(tx);
      } catch {
        throw new Error("transaction rolled back");
      }
    });
    mocks.insert
      .mockReturnValueOnce({
        values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 41 }]) })),
      })
      .mockReturnValueOnce({
        values: vi.fn(() => ({ returning: vi.fn(async () => { throw new Error("chart failed"); }) })),
      });

    const response = await createBundle();
    expect(response.status).toBe(500);
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });
});
