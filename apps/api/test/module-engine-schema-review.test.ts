import { beforeEach, describe, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => {
  const source = {
    id: 161,
    name: "orders_export.csv",
    config: {} as Record<string, unknown>,
  };
  const module = {
    code: "pinduoduo_sales",
    name: "拼多多销售",
    description: "",
    enabled: true,
    hasTransform: false,
    isDict: false,
    origin: "user",
    version: 2,
    configurable: true,
    columns: [{
      name: "amount",
      source: "商品金额",
      label: "商品金额",
      type: "numeric",
      required: true,
      computed: false,
      semanticRole: "amount",
    }],
    platforms: [{
      code: "generic",
      name: "通用",
      filePattern: "orders_export",
      patternFlags: "i",
      enabled: true,
    }],
    usages: ["summary"],
  };
  return {
    source,
    module,
    transform: vi.fn(),
    clear: vi.fn(),
    pending: vi.fn(),
    awaiting: vi.fn(),
  };
});

vi.mock("../src/db/client.js", () => ({
  sql: {},
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [structuredClone(fake.source)],
        }),
      }),
    }),
  },
}));

vi.mock("../src/db/schema.js", () => ({ dataSources: { id: "id" } }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));
vi.mock("../src/modules/loader.js", () => ({
  getModule: vi.fn(async () => structuredClone(fake.module)),
  loadModules: vi.fn(async () => [structuredClone(fake.module)]),
  matchFileToPlatform: vi.fn(),
}));
vi.mock("../src/modules/default-transform.js", () => ({
  runDefaultTransform: fake.transform,
}));
vi.mock("../src/services/default-order-charts.js", () => ({
  ensureDefaultOrderCharts: vi.fn(),
}));
vi.mock("../src/services/module-config-store.js", () => ({
  createModuleConfigStore: () => ({
    listSchemaDecisions: vi.fn(async () => []),
  }),
}));
vi.mock("../src/services/module-source-inspector.js", () => ({
  inspectModuleSources: vi.fn(async () => ({
    sourceIds: [161],
    compatible: true,
    headers: ["商品金额"],
    samples: [{ 商品金额: "10.00" }],
    statusValues: [],
    inferredTypes: { 商品金额: "numeric" },
    differences: [],
  })),
  diffModuleSchema: vi.fn(() => ({
    added: [],
    missingRequired: [],
    missingOptional: [],
    missingRequiredFields: [],
    missingOptionalFields: [],
    aliasCandidates: [],
    typeChanges: [],
  })),
}));
vi.mock("../src/services/source-schema-review-state.js", () => ({
  clearSourceSchemaReview: fake.clear,
  markSourceSchemaReviewPending: fake.pending,
  markSourceSchemaReviewAwaitingRetry: fake.awaiting,
}));

import { runModuleEtl } from "../src/modules/engine.js";

const report = (error?: string) => ({
  platform: "通用",
  sourceId: 161,
  fileName: "orders_export.csv",
  total: 1,
  inserted: error ? 0 : 1,
  matched: 0,
  matchRate: 0,
  ...(error ? { error } : {}),
});

describe("module ETL schema review lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (fake.module as any).dataContract;
    fake.source.config = {
      originalFileName: "orders_export.csv",
      columns: [
        { raw: "商品金额(元)", name: "商品金额_元_" },
      ],
      schemaReview: {
        status: "pending",
        operationId: "11111111-1111-4111-8111-111111111111",
        sourceIds: [161],
        moduleCode: "pinduoduo_sales",
        moduleVersion: 2,
        schemaFingerprint: "a".repeat(64),
        schemaFingerprints: { "161": "a".repeat(64) },
        diff: {},
        detectedAt: "2026-07-17T00:00:00.000Z",
        stagedDecisions: [],
      },
    };
    fake.awaiting.mockResolvedValue({
      ...fake.source.config.schemaReview,
      status: "awaiting_retry",
      retryMessage: "处理失败，请重试",
    });
  });

  test("clears a durable review only after ETL succeeds", async () => {
    fake.transform.mockResolvedValue(report());

    await expect(runModuleEtl(161, {
      moduleCode: "pinduoduo_sales",
    })).resolves.toMatchObject({ inserted: 1 });

    expect(fake.clear).toHaveBeenCalledWith(161, "pinduoduo_sales");
    expect(fake.awaiting).not.toHaveBeenCalled();
  });

  test("passes stored source column metadata into the default transform", async () => {
    fake.transform.mockResolvedValue(report());

    await runModuleEtl(161, {
      moduleCode: "pinduoduo_sales",
    });

    expect(fake.transform).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: {
          sourceId: 161,
          platformName: "通用",
          sourceColumns: [
            { raw: "商品金额(元)", name: "商品金额_元_" },
          ],
        },
      }),
    );
  });

  test("logs a raw ETL report error but persists and returns only its public form", async () => {
    const rawError =
      "password=top-secret SQL relation user_data.uf_161 failed";
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.transform.mockResolvedValue(report(rawError));

    const result = await runModuleEtl(161, {
      moduleCode: "pinduoduo_sales",
    });

    expect(result).toMatchObject({
      error: "文件处理失败，请稍后重试",
      schemaReview: { status: "awaiting_retry" },
    });
    expect(JSON.stringify(result)).not.toContain("top-secret");
    expect(fake.awaiting.mock.calls[0]?.[3]).toMatchObject({
      retryMessage: "文件处理失败，请稍后重试",
    });
    expect(JSON.stringify(fake.awaiting.mock.calls[0]?.[3]))
      .not.toContain("top-secret");
    expect(errorLog).toHaveBeenCalledWith(
      "[module-engine] ETL report error",
      expect.objectContaining({ error: rawError }),
    );
    expect(fake.awaiting).toHaveBeenCalledTimes(1);
    expect(fake.clear).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  test("keeps the durable review when ETL throws", async () => {
    fake.transform.mockRejectedValue(new Error("database unavailable"));

    await expect(runModuleEtl(161, {
      moduleCode: "pinduoduo_sales",
    })).rejects.toThrow("database unavailable");

    expect(fake.awaiting).toHaveBeenCalledTimes(1);
    expect(fake.clear).not.toHaveBeenCalled();
  });

  test("ordinary processing preserves an awaiting retry operation", async () => {
    (fake.source.config.schemaReview as any).status = "awaiting_retry";

    const result = await runModuleEtl(161, {
      moduleCode: "pinduoduo_sales",
    });

    expect(result).toMatchObject({
      error: "字段设置待重试，请从字段确认入口重新处理",
      schemaReview: { status: "awaiting_retry" },
    });
    expect(fake.transform).not.toHaveBeenCalled();
    expect(fake.clear).not.toHaveBeenCalled();
    expect(fake.pending).not.toHaveBeenCalled();
  });

  test("blocks direct ETL into a profit-contract module when the source lacks validation evidence", async () => {
    (fake.module as any).dataContract = "front-profit-standard/v1";

    const result = await runModuleEtl(161, {
      moduleCode: "pinduoduo_sales",
    });

    expect(result).toMatchObject({
      inserted: 0,
      error: "前台利润模块只接受已通过标准合同校验的数据源",
    });
    expect(fake.transform).not.toHaveBeenCalled();
    expect(fake.clear).not.toHaveBeenCalled();
    expect(fake.pending).not.toHaveBeenCalled();
  });
});
