import { beforeEach, describe, expect, test, vi } from "vitest";
import { Hono } from "hono";
import { sign } from "../src/lib/auth.js";

const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  executeWithMetadata: vi.fn(),
}));

vi.mock("../src/lib/current-auth-user.js", () => ({
  resolveCurrentAuthUser: vi.fn(async (payload: any) => payload),
}));
vi.mock("../src/db/client", () => ({ db: {}, sql: {} }));
vi.mock("../src/db/table-scope", () => ({
  runtimeTableReference: vi.fn(() => '"public"."unified_sales"'),
  resolveExistingRuntimeTableReferenceFromSql: vi.fn(),
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
      dimensions: [{ id: "orders.platform", label: "平台", field: "platform", kind: "categorical" }],
      metrics: [{ id: "orders.sales_amount", label: "销售额", aggregation: "sum", field: "amount", unit: "currency", additiveAcrossTime: true }],
    },
  }]),
}));
vi.mock("../src/services/llm", () => ({ chat: mocks.chat }));
vi.mock("../src/lib/local-readonly-sql", () => ({
  executeLocalReadOnlyQueryWithMetadata: mocks.executeWithMetadata,
  LOCAL_SQL_MAX_ROWS: 5000,
  LOCAL_SQL_MAX_CONCURRENCY: 4,
  LOCAL_SQL_STATEMENT_TIMEOUT_MS: 5000,
}));

import boardRoutes from "../src/routes/board.js";

const token = sign({ uid: 1, username: "admin", isAdmin: true, tokenVersion: 0 });

function request() {
  const app = new Hono();
  app.route("/board", boardRoutes);
  return app.request("/board/ai-chart", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      question: "各平台销售额对比",
      scope: { kind: "module", value: "orders" },
    }),
  });
}

describe("semantic AI chart route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chat.mockResolvedValue({
      content: JSON.stringify({
        modelId: "orders.analysis",
        metricIds: ["orders.sales_amount"],
        dimensionIds: ["orders.platform"],
        chartType: "bar",
        title: "各平台销售额",
        reason: "类别对比",
      }),
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });
    mocks.executeWithMetadata.mockResolvedValue({
      rows: [{ d0__orders__platform: "淘宝", m0__orders__sales_amount: "100" }],
      truncated: false,
      rowLimit: 200,
    });
  });

  test("sends only catalog IDs/labels to the model and compiles IDs on the server", async () => {
    const response = await request();
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    const messages = mocks.chat.mock.calls[0][0] as Array<{ content: string }>;
    const modelInput = messages.map((message) => message.content).join("\n");
    expect(modelInput).toContain("orders.sales_amount");
    expect(modelInput).not.toContain("unified_sales");
    expect(modelInput).not.toContain('"field":"amount"');
    expect(mocks.executeWithMetadata.mock.calls[0][0]).toContain('SUM("amount")');
    expect(body.data.spec).toMatchObject({
      semanticModelId: "orders.analysis",
      semanticModelVersion: 1,
      metricIds: ["orders.sales_amount"],
      dimensionIds: ["orders.platform"],
    });
    expect(body.data.spec).not.toHaveProperty("sql");
    expect(body.data.lineage).toMatchObject({
      schemaVersion: "semantic-lineage/v1",
      modelId: "orders.analysis",
    });
  });

  test("fails closed when the model invents an undeclared metric ID", async () => {
    mocks.chat.mockResolvedValueOnce({
      content: JSON.stringify({
        modelId: "orders.analysis",
        metricIds: ["orders.guessed_profit"],
        dimensionIds: ["orders.platform"],
        chartType: "bar",
        title: "错误指标",
        reason: "测试",
      }),
      usage: {},
    });

    const response = await request();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "SEMANTIC_METRIC_NOT_FOUND" });
    expect(mocks.executeWithMetadata).not.toHaveBeenCalled();
  });
});
