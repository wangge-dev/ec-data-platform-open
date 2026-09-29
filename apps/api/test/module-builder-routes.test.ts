import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { Hono } from "hono";
import { sign } from "../src/lib/auth.js";
import type { LoadedModule } from "../src/modules/loader.js";
import { validateModuleConfig, type ModuleDef } from "../src/modules/schema.js";
import {
  createModuleBuilderRoutes,
  type ModuleBuilderRouteDeps,
} from "../src/routes/module-builder.js";
import type { SourceInspection } from "../src/services/module-source-inspector.js";
import type {
  IdempotencyClaim,
  PendingIdempotencyClaim,
} from "../src/services/module-builder.js";
import { sourceSchemaFingerprint } from "../src/services/module-schema-review.js";
import { portableModuleFingerprint } from "../src/services/vertical-solution-lifecycle.js";
import {
  SourceSchemaReviewStateError,
  type SourceSchemaReviewOperation,
} from "../src/services/source-schema-review-state.js";

vi.mock("../src/lib/current-auth-user.js", () => ({
  resolveCurrentAuthUser: vi.fn(async (payload: any) => payload),
}));

function inspection(
  overrides: Partial<SourceInspection> = {},
): SourceInspection {
  return {
    sourceIds: [161, 162],
    compatible: true,
    headers: ["支付时间", "商品金额", "订单状态", "商品名称", "备注"],
    samples: [
      {
        支付时间: "2026-07-16 12:00:00",
        商品金额: "20.50",
        订单状态: "已发货，待收货",
        商品名称: "测试商品",
        备注: "首单",
      },
    ],
    filenamePhrase: "order_export",
    statusValues: [],
    inferredTypes: {
      支付时间: "timestamp",
      商品金额: "numeric",
      订单状态: "text",
      商品名称: "text",
      备注: "text",
    },
    differences: [],
    ...overrides,
  };
}

function schemaReviewOperation(options: {
  sourceIds?: number[];
  status?: "pending" | "awaiting_retry";
  operationId?: string;
  moduleVersion?: number;
  schemaFingerprints?: Record<string, string>;
  stagedDecisions?: any[];
  mutateMember?: (
    marker: SourceSchemaReviewOperation["review"],
    sourceId: number,
  ) => SourceSchemaReviewOperation["review"];
} = {}): SourceSchemaReviewOperation {
  const sourceIds = options.sourceIds ?? [161];
  const fingerprint = sourceSchemaFingerprint(inspection());
  const schemaFingerprints = options.schemaFingerprints ??
    Object.fromEntries(sourceIds.map((sourceId) => [String(sourceId), fingerprint]));
  const review: SourceSchemaReviewOperation["review"] = {
    status: options.status ?? "pending",
    operationId:
      options.operationId ?? "11111111-1111-4111-8111-111111111111",
    sourceIds,
    moduleCode: "pinduoduo_sales",
    moduleVersion: options.moduleVersion ?? 2,
    schemaFingerprint: schemaFingerprints[String(sourceIds[0])],
    schemaFingerprints,
    diff: {
      added: ["新字段"],
      missingRequired: [],
      missingOptional: [],
      missingRequiredFields: [],
      missingOptionalFields: [],
      aliasCandidates: [],
      typeChanges: [],
    },
    detectedAt: "2026-07-17T00:00:00.000Z",
    ...(options.status === "awaiting_retry"
      ? {
          stagedDecisions: options.stagedDecisions ?? [],
          retryMessage: "文件处理失败，请稍后重试",
        }
      : {}),
  };
  return {
    review,
    sources: sourceIds.map((sourceId) => {
      const marker = {
        ...structuredClone(review),
        schemaFingerprint: schemaFingerprints[String(sourceId)],
      };
      return {
        id: sourceId,
        name: `${sourceId}.csv`,
        config: {
          moduleCode: "pinduoduo_sales",
          originalFileName: `${sourceId}.csv`,
          schemaReview: options.mutateMember
            ? options.mutateMember(marker, sourceId)
            : marker,
        },
      };
    }),
  };
}

function pinduoduoCreateRequest(idempotencyKey = "request-1") {
  return {
    name: "拼多多销售",
    category: "shop_ops",
    description: "拼多多销售数据",
    sourceIds: [161, 162],
    filenamePhrase: "order.export+(final)",
    mappings: [
      {
        semanticRole: "time",
        source: "支付时间",
        label: "支付时间",
        type: "timestamp",
        required: true,
      },
      {
        semanticRole: "amount",
        source: "商品金额",
        label: "商品金额",
        type: "numeric",
        required: true,
      },
      {
        semanticRole: "status",
        source: "订单状态",
        label: "订单状态",
        type: "text",
        required: true,
      },
      {
        semanticRole: "product_name",
        source: "商品名称",
        label: "商品名称",
        type: "text",
        required: false,
      },
    ],
    additionalFields: [
      { source: "备注", label: "备注", type: "text" },
    ],
    inclusion: {
      statusSource: "订单状态",
      includedValues: ["已发货，待收货", "已收货"],
    },
    idempotencyKey,
  };
}

function minimalCreateRequest(idempotencyKey = "minimal-request") {
  return {
    name: "Minimal Sales",
    sourceIds: [161],
    filenamePhrase: "minimal_sales",
    mappings: [
      {
        semanticRole: "amount",
        source: "商品金额",
        label: "商品金额",
        type: "numeric",
        required: true,
      },
    ],
    additionalFields: [],
    idempotencyKey,
  };
}

function fakeBuilderDeps(): ModuleBuilderRouteDeps & {
  store: ModuleBuilderRouteDeps["store"] & {
    listActive: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
    applySolution: ReturnType<typeof vi.fn>;
    rollbackSolution: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    listVersions: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
    archive: ReturnType<typeof vi.fn>;
    upsertSchemaDecisions: ReturnType<typeof vi.fn>;
    listSchemaDecisions: ReturnType<typeof vi.fn>;
    activateSchemaDecisions: ReturnType<typeof vi.fn>;
  };
  inspectSources: ReturnType<typeof vi.fn>;
  assignSource: ReturnType<typeof vi.fn>;
  runEtl: ReturnType<typeof vi.fn>;
  insertIdempotencyClaim: ReturnType<typeof vi.fn>;
  readIdempotencyClaim: ReturnType<typeof vi.fn>;
  replaceIdempotencyClaim: ReturnType<typeof vi.fn>;
  renewIdempotencyClaim: ReturnType<typeof vi.fn>;
  ensureDefaultModuleCharts: ReturnType<typeof vi.fn>;
  loadModules: ReturnType<typeof vi.fn>;
  invalidateModuleCache: ReturnType<typeof vi.fn>;
  advanceIdempotencyTime(milliseconds: number): void;
} {
  let idempotencyClaim: IdempotencyClaim | null = null;
  let idempotencyTime = Date.now();
  const clone = <T,>(value: T): T => structuredClone(value);
  const createdBy = 7;
  const stored = (config: ModuleDef, version = 1) => ({
    code: config.code,
    name: config.name,
    category: config.category ?? null,
    description: config.description,
    config,
    version,
    origin: "user" as const,
    status: "active" as const,
    createdBy,
  });
  const store = {
    listActive: vi.fn(async () => []),
    create: vi.fn(async ({ config }: { config: ModuleDef }) => stored(config)),
    createMany: vi.fn(async (inputs: Array<{ config: ModuleDef }>) =>
      inputs.map(({ config }) => stored(config))),
    applySolution: vi.fn(async ({ manifest }: { manifest: any }) => ({
      plan: {
        operation: "install" as const,
        currentSolutionVersion: null,
        expectedModuleVersions: [],
        moduleCodes: manifest.modules.map((item: any) => item.module.code),
        connectorIds: manifest.requiredConnectors.map((item: any) => item.id),
      },
      modules: manifest.modules.map((item: any) => stored({
        ...item.module,
        solutionBinding: {
          schemaVersion: "solution-binding/v1",
          solutionId: manifest.id,
          solutionVersion: manifest.version,
        },
      })),
    })),
    rollbackSolution: vi.fn(async () => []),
    update: vi.fn(async (_code: string, config: ModuleDef) => stored(config, 2)),
    listVersions: vi.fn(async () => [
      { version: 1, config: userModule(), createdAt: "2026-07-17T00:00:00.000Z" },
    ]),
    restore: vi.fn(async () => stored(userModule(), 3)),
    archive: vi.fn(async () => undefined),
    upsertSchemaDecisions: vi.fn(async () => undefined),
    listSchemaDecisions: vi.fn(async () => []),
    activateSchemaDecisions: vi.fn(async ({ config }: { config: ModuleDef }) =>
      stored(config, 3)),
  };
  const operationId = "11111111-1111-4111-8111-111111111111";
  const schemaFingerprint = sourceSchemaFingerprint(inspection());
  const operation = () => {
    const review = {
      status: "pending" as const,
      operationId,
      sourceIds: [161],
      moduleCode: "pinduoduo_sales",
      moduleVersion: 2,
      schemaFingerprint,
      schemaFingerprints: { "161": schemaFingerprint },
      diff: {
        added: ["新字段"],
        missingRequired: [],
        missingOptional: [],
        aliasCandidates: [],
        typeChanges: [],
      },
      detectedAt: "2026-07-17T00:00:00.000Z",
    };
    return {
      review,
      sources: [{
        id: 161,
        name: "161.csv",
        config: {
          moduleCode: "pinduoduo_sales",
          originalFileName: "161.csv",
          schemaReview: review,
        },
      }],
    };
  };
  const transactionExecutor = {
    unsafe: vi.fn(async (query: string) => {
      if (query.includes("FROM public.module_configs")) {
        return [{
          code: "pinduoduo_sales",
          name: "拼多多销售",
          category: "shop_ops",
          description: "拼多多销售数据",
          config: userModule(),
          version: 2,
          origin: "user",
          status: "active",
          createdBy: 7,
        }];
      }
      if (query.includes("UPDATE public.module_configs")) {
        return [{
          code: "pinduoduo_sales",
          name: "拼多多销售",
          category: "shop_ops",
          description: "拼多多销售数据",
          config: userModule(),
          version: 3,
          origin: "user",
          status: "active",
          createdBy: 7,
        }];
      }
      return [];
    }),
  };
  return {
    store,
    inspectSources: vi.fn(async () => inspection()),
    diffSchema: vi.fn((module: LoadedModule) => ({
      added: module.columns.some((column) =>
        (Array.isArray(column.source) ? column.source : [column.source])
          .includes("新字段"))
        ? []
        : ["新字段"],
      missingRequired: [],
      missingOptional: ["备注"],
      missingRequiredFields: [],
      missingOptionalFields: [{ name: "note", label: "备注", compatibleSources: [] }],
      aliasCandidates: [],
      typeChanges: [],
    })),
    readSourceSchemaReview: vi.fn(async () => null),
    readSourceSchemaReviewOperation: vi.fn(async () => operation()),
    withSchemaReviewTransaction: vi.fn(async (work: any) =>
      work(transactionExecutor)),
    inspectSourcesWithExecutor: vi.fn(async () => inspection()),
    markSourceSchemaReviewAwaitingRetry: vi.fn(async (
      _sourceId: number,
      moduleCode: string,
      diff: any,
      metadata: any,
    ) => ({
      status: "awaiting_retry" as const,
      moduleCode,
      moduleVersion: metadata.moduleVersion,
      schemaFingerprint: metadata.schemaFingerprint,
      diff,
      detectedAt: "2026-07-17T00:00:00.000Z",
      stagedDecisions: metadata.stagedDecisions,
      retryMessage: metadata.retryMessage,
    })),
    clearSourceSchemaReview: vi.fn(async () => undefined),
    assignSource: vi.fn(async () => undefined),
    runEtl: vi.fn(async (sourceId: number) => ({
      platform: "通用",
      sourceId,
      fileName: `${sourceId}.csv`,
      total: sourceId === 161 ? 736 : 326,
      inserted: sourceId === 161 ? 650 : 290,
      matched: 0,
      matchRate: 0,
    })),
    insertIdempotencyClaim: vi.fn(
      async (
        _key: string,
        claim: PendingIdempotencyClaim,
        leaseDurationMs: number,
      ) => {
        if (idempotencyClaim) return false;
        idempotencyClaim = clone({
          ...claim,
          leaseExpiresAt: idempotencyTime + leaseDurationMs,
        });
        return true;
      },
    ),
    readIdempotencyClaim: vi.fn(async () =>
      idempotencyClaim ? clone(idempotencyClaim) : null,
    ),
    replaceIdempotencyClaim: vi.fn(
      async (
        _key: string,
        expectedOwnerToken: string,
        claim: IdempotencyClaim,
        leaseDurationMs?: number,
      ) => {
        if (
          !idempotencyClaim ||
          idempotencyClaim.state !== "pending" ||
          idempotencyClaim.ownerToken !== expectedOwnerToken ||
          (leaseDurationMs !== undefined &&
            idempotencyClaim.leaseExpiresAt > idempotencyTime)
        ) {
          return false;
        }
        idempotencyClaim = clone(
          claim.state === "pending" && leaseDurationMs !== undefined
            ? {
                ...claim,
                leaseExpiresAt: idempotencyTime + leaseDurationMs,
              }
            : claim,
        );
        return true;
      },
    ),
    renewIdempotencyClaim: vi.fn(
      async (
        _key: string,
        expectedOwnerToken: string,
        leaseDurationMs: number,
      ) => {
        if (
          !idempotencyClaim ||
          idempotencyClaim.state !== "pending" ||
          idempotencyClaim.ownerToken !== expectedOwnerToken ||
          idempotencyClaim.leaseExpiresAt <= idempotencyTime
        ) {
          return null;
        }
        idempotencyClaim = {
          ...idempotencyClaim,
          leaseExpiresAt: Math.max(
            idempotencyClaim.leaseExpiresAt,
            idempotencyTime + leaseDurationMs,
          ),
        };
        return clone(idempotencyClaim);
      },
    ),
    ensureDefaultModuleCharts: vi.fn(async () => ({
      createdDatasets: 3,
      createdCharts: 3,
      skipped: false,
    })),
    idempotencyNow: () => idempotencyTime,
    idempotencyWait: async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
    advanceIdempotencyTime(milliseconds: number) {
      idempotencyTime += milliseconds;
    },
    loadModules: vi.fn(async () => []),
    invalidateModuleCache: vi.fn(),
  };
}

function userModule(): ModuleDef {
  return {
    code: "pinduoduo_sales",
    name: "拼多多销售",
    category: "shop_ops",
    description: "拼多多销售数据",
    columns: [
      {
        name: "time",
        source: "支付时间",
        label: "支付时间",
        type: "timestamp",
        required: true,
        computed: false,
        semanticRole: "time",
      },
      {
        name: "amount",
        source: "商品金额",
        label: "商品金额",
        type: "numeric",
        required: true,
        computed: false,
        semanticRole: "amount",
      },
    ],
    platforms: [
      {
        code: "generic",
        name: "通用",
        filePattern: "order_export",
        patternFlags: "i",
        enabled: true,
      },
    ],
    timeKey: "time",
    usages: ["summary", "ai_chart", "ai_analysis"],
    enabled: true,
    hasTransform: false,
    isDict: false,
  };
}

async function requestAsUser(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
) {
  return requestAsActor(
    app,
    { uid: 7, username: "operator", isAdmin: false },
    method,
    path,
    body,
  );
}

async function requestAsActor(
  app: Hono,
  user: { uid: number; username: string; isAdmin: boolean },
  method: string,
  path: string,
  body?: unknown,
) {
  return app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${sign({ ...user, tokenVersion: 0 })}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("self-service module builder routes", () => {
  test("an admin validates and installs a data-only versioned module manifest", async () => {
    const deps = fakeBuilderDeps();
    const app = createModuleBuilderRoutes(deps);
    const module = {
      ...userModule(),
      code: "manifest_sales",
      name: "清单销售",
      semanticModel: {
        schemaVersion: "semantic-manifest/v1" as const,
        id: "manifest_sales.analysis",
        version: 1,
        dimensions: [{
          id: "manifest_sales.date",
          label: "日期",
          field: "time",
          kind: "time" as const,
        }],
        metrics: [{
          id: "manifest_sales.amount",
          label: "销售额",
          aggregation: "sum" as const,
          field: "amount",
          unit: "currency" as const,
          additiveAcrossTime: true,
        }],
      },
    };
    const body = { schemaVersion: "module-manifest/v1", module };

    const validation = await requestAsActor(
      app,
      { uid: 1, username: "admin", isAdmin: true },
      "POST",
      "/manifests/validate",
      body,
    );
    expect(validation.status).toBe(200);

    const installation = await requestAsActor(
      app,
      { uid: 1, username: "admin", isAdmin: true },
      "POST",
      "/manifests/install",
      body,
    );
    expect(installation.status).toBe(201);
    expect(await installation.json()).toMatchObject({
      ok: true,
      data: {
        schemaVersion: "module-manifest/v1",
        moduleCode: "manifest_sales",
        moduleVersion: 1,
        semanticModelId: "manifest_sales.analysis",
        semanticModelVersion: 1,
      },
    });
    expect(deps.store.create).toHaveBeenCalledWith({
      config: expect.objectContaining({ code: "manifest_sales", hasTransform: false }),
      actorId: 1,
      origin: "user",
    });
  });

  test("an admin exports, validates, and atomically installs a vertical solution", async () => {
    const deps = fakeBuilderDeps();
    const first = {
      ...userModule(),
      code: "solution_sales",
      name: "方案销售",
      semanticModel: {
        schemaVersion: "semantic-manifest/v1" as const,
        id: "solution_sales.analysis",
        version: 1,
        dimensions: [{
          id: "solution_sales.date",
          label: "日期",
          field: "time",
          kind: "time" as const,
        }],
        metrics: [{
          id: "solution_sales.amount",
          label: "销售额",
          aggregation: "sum" as const,
          field: "amount",
          unit: "currency" as const,
          additiveAcrossTime: true,
        }],
      },
    };
    const second = {
      ...structuredClone(first),
      code: "solution_refund",
      name: "方案退款",
      semanticModel: {
        ...structuredClone(first.semanticModel),
        id: "solution_refund.analysis",
        dimensions: [{
          ...structuredClone(first.semanticModel.dimensions[0]),
          id: "solution_refund.date",
        }],
        metrics: [{
          ...structuredClone(first.semanticModel.metrics[0]),
          id: "solution_refund.amount",
        }],
      },
    };
    deps.store.listActive.mockResolvedValue([
      {
        code: first.code,
        name: first.name,
        category: first.category ?? null,
        description: first.description,
        config: first,
        version: 2,
        origin: "user",
        status: "active",
        createdBy: 1,
      },
      {
        code: second.code,
        name: second.name,
        category: second.category ?? null,
        description: second.description,
        config: second,
        version: 4,
        origin: "user",
        status: "active",
        createdBy: 1,
      },
    ]);
    const app = createModuleBuilderRoutes(deps);
    const actor = { uid: 1, username: "admin", isAdmin: true };

    const exportedResponse = await requestAsActor(
      app,
      actor,
      "POST",
      "/solutions/export",
      {
        id: "customer.ops",
        version: 2,
        label: "客户经营方案",
        moduleCodes: [first.code, second.code],
        connectorIds: ["postgres.readonly"],
      },
    );
    expect(exportedResponse.status).toBe(200);
    const exportedBody: any = await exportedResponse.json();
    expect(exportedBody.data).toMatchObject({
      schemaVersion: "vertical-solution/v1",
      id: "customer.ops",
      version: 2,
      dataPolicy: {
        containsBusinessData: false,
        containsSecrets: false,
      },
      requiredConnectors: [{ id: "postgres.readonly", version: 1 }],
    });
    expect(exportedBody.data.modules).toHaveLength(2);

    // The next calls represent a clean target instance rather than the source
    // instance that produced the export above.
    deps.store.listActive.mockResolvedValue([]);

    const validation = await requestAsActor(
      app,
      actor,
      "POST",
      "/solutions/validate",
      exportedBody.data,
    );
    expect(validation.status).toBe(200);
    expect(await validation.json()).toMatchObject({
      ok: true,
      data: {
        readiness: {
          installable: true,
          moduleCodes: [first.code, second.code],
          connectorIds: ["postgres.readonly"],
        },
      },
    });

    const installation = await requestAsActor(
      app,
      actor,
      "POST",
      "/solutions/install",
      exportedBody.data,
    );
    expect(installation.status).toBe(201);
    expect(deps.store.applySolution).toHaveBeenCalledTimes(1);
    expect(deps.store.applySolution).toHaveBeenCalledWith({
      manifest: expect.objectContaining({ id: "customer.ops", version: 2 }),
      actorId: 1,
      expectedModuleVersions: [],
    });
    expect(deps.invalidateModuleCache).toHaveBeenCalledTimes(1);
    expect(deps.loadModules).not.toHaveBeenCalled();
    expect(await installation.json()).toMatchObject({
      ok: true,
      data: {
        solutionId: "customer.ops",
        solutionVersion: 2,
        modules: [
          { code: first.code, version: 1, semanticModelId: "solution_sales.analysis" },
          { code: second.code, version: 1, semanticModelId: "solution_refund.analysis" },
        ],
      },
    });
  });

  test("solution installation rejects connector version drift before persistence", async () => {
    const deps = fakeBuilderDeps();
    const app = createModuleBuilderRoutes(deps);
    const raw = JSON.parse(readFileSync(
      resolve(process.cwd(), "extensions/solutions/ecommerce-starter.solution.json"),
      "utf8",
    ));
    raw.requiredConnectors = [{ id: "postgres.readonly", version: 999 }];

    const response = await requestAsActor(
      app,
      { uid: 1, username: "admin", isAdmin: true },
      "POST",
      "/solutions/install",
      raw,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "SOLUTION_CONNECTOR_REQUIREMENT_UNMET",
    });
    expect(deps.store.applySolution).not.toHaveBeenCalled();
  });

  test("solution validation reports target module conflicts before installation", async () => {
    const deps = fakeBuilderDeps();
    deps.store.listActive.mockResolvedValue([{
      code: "example_sales",
      name: "现场销售",
      category: null,
      description: "existing",
      config: {
        ...userModule(),
        code: "example_sales",
        name: "现场销售",
      },
      version: 3,
      origin: "user",
      status: "active",
      createdBy: 1,
    }]);
    const app = createModuleBuilderRoutes(deps);
    const raw = JSON.parse(readFileSync(
      resolve(process.cwd(), "extensions/solutions/ecommerce-starter.solution.json"),
      "utf8",
    ));
    raw.requiredConnectors = [{ id: "postgres.readonly", version: 1 }];

    const response = await requestAsActor(
      app,
      { uid: 1, username: "admin", isAdmin: true },
      "POST",
      "/solutions/validate",
      raw,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "SOLUTION_MODULE_CONFLICT",
      details: { moduleCodes: ["example_sales"] },
    });
    expect(deps.store.applySolution).not.toHaveBeenCalled();
  });

  test("a validated solution upgrade returns an atomic rollback receipt", async () => {
    const deps = fakeBuilderDeps();
    const raw = JSON.parse(readFileSync(
      resolve(process.cwd(), "extensions/solutions/ecommerce-starter.solution.json"),
      "utf8",
    ));
    raw.version = 2;
    raw.requiredConnectors = [{ id: "postgres.readonly", version: 1 }];
    const localVersions = [3, 5];
    const current = raw.modules.map((item: any, index: number) => {
      const config = validateModuleConfig(item.module);
      return {
        code: config.code,
        name: config.name,
        category: config.category ?? null,
        description: config.description,
        config: {
          ...structuredClone(config),
          solutionBinding: {
            schemaVersion: "solution-binding/v1",
            solutionId: raw.id,
            solutionVersion: 1,
            moduleFingerprint: portableModuleFingerprint(config),
          },
        },
        version: localVersions[index],
        origin: "user" as const,
        status: "active" as const,
        createdBy: 1,
      };
    });
    deps.store.listActive.mockResolvedValue(current);
    const expectedModuleVersions = current.map((module) => ({
      code: module.code,
      version: module.version,
    }));
    const upgraded = current.map((module) => ({
      ...module,
      version: module.version + 1,
      config: {
        ...module.config,
        solutionBinding: {
          ...module.config.solutionBinding,
          solutionVersion: 2,
        },
      },
    }));
    deps.store.applySolution.mockResolvedValue({
      plan: {
        operation: "upgrade",
        currentSolutionVersion: 1,
        expectedModuleVersions,
        moduleCodes: current.map((module) => module.code),
        connectorIds: ["postgres.readonly"],
      },
      modules: upgraded,
    });
    const app = createModuleBuilderRoutes(deps);
    const actor = { uid: 1, username: "admin", isAdmin: true };

    const validation = await requestAsActor(
      app,
      actor,
      "POST",
      "/solutions/validate",
      raw,
    );
    expect(validation.status).toBe(200);
    expect(await validation.json()).toMatchObject({
      ok: true,
      data: {
        readiness: {
          operation: "upgrade",
          currentSolutionVersion: 1,
          expectedModuleVersions,
        },
      },
    });

    const apply = await requestAsActor(
      app,
      actor,
      "POST",
      "/solutions/apply",
      { manifest: raw, expectedModuleVersions },
    );
    expect(apply.status).toBe(200);
    const applyBody: any = await apply.json();
    expect(applyBody).toMatchObject({
      ok: true,
      data: {
        operation: "upgrade",
        solutionVersion: 2,
        rollback: {
          schemaVersion: "solution-rollback/v1",
          fromSolutionVersion: 2,
          toSolutionVersion: 1,
          modules: [
            { code: current[0].code, expectedVersion: 4, restoreVersion: 3 },
            { code: current[1].code, expectedVersion: 6, restoreVersion: 5 },
          ],
        },
      },
    });

    const rolledBack = upgraded.map((module) => ({
      ...module,
      version: module.version + 1,
      config: {
        ...module.config,
        solutionBinding: {
          ...module.config.solutionBinding,
          solutionVersion: 1,
        },
      },
    }));
    deps.store.rollbackSolution.mockResolvedValue(rolledBack);
    const rollback = await requestAsActor(
      app,
      actor,
      "POST",
      "/solutions/rollback",
      applyBody.data.rollback,
    );
    expect(rollback.status).toBe(200);
    expect(deps.store.rollbackSolution).toHaveBeenCalledWith({
      solutionId: raw.id,
      fromSolutionVersion: 2,
      toSolutionVersion: 1,
      modules: applyBody.data.rollback.modules,
      actorId: 1,
    });
    expect(await rollback.json()).toMatchObject({
      ok: true,
      data: { solutionId: raw.id, solutionVersion: 1 },
    });
  });

  test("solution validation rejects oversized packages before manifest parsing", async () => {
    const deps = fakeBuilderDeps();
    const app = createModuleBuilderRoutes(deps);
    const response = await requestAsActor(
      app,
      { uid: 1, username: "admin", isAdmin: true },
      "POST",
      "/solutions/validate",
      {
        schemaVersion: "vertical-solution/v1",
        padding: "x".repeat(2 * 1024 * 1024),
      },
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "SOLUTION_PACKAGE_TOO_LARGE",
    });
    expect(deps.store.listActive).not.toHaveBeenCalled();
    expect(deps.store.applySolution).not.toHaveBeenCalled();
  });

  test("a non-admin user creates a validated module and processes selected sources", async () => {
    const deps = fakeBuilderDeps();
    const app = createModuleBuilderRoutes(deps);

    const res = await requestAsUser(
      app,
      "POST",
      "/",
      pinduoduoCreateRequest(),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      ok: true,
      data: {
        moduleCode: "pinduoduo_sales",
        files: [
          { sourceId: 161, status: "success", total: 736, included: 650 },
          { sourceId: 162, status: "success", total: 326, included: 290 },
        ],
      },
    });
    expect(deps.store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 7,
        origin: "user",
        config: expect.objectContaining({
          code: "pinduoduo_sales",
          timeKey: "time",
          hasTransform: false,
          semanticModel: expect.objectContaining({
            schemaVersion: "semantic-manifest/v1",
            id: "pinduoduo_sales.analysis",
            version: 1,
            metrics: expect.arrayContaining([
              expect.objectContaining({ id: "pinduoduo_sales.metric_amount", aggregation: "sum" }),
            ]),
            dimensions: expect.arrayContaining([
              expect.objectContaining({ id: "pinduoduo_sales.dim_time", kind: "time" }),
            ]),
          }),
          inclusionRule: {
            field: "status",
            includedValues: ["已发货，待收货", "已收货"],
          },
          platforms: [
            expect.objectContaining({
              code: "generic",
              filePattern: "order\\.export\\+\\(final\\)",
            }),
          ],
        }),
      }),
    );
    expect(deps.inspectSources).toHaveBeenCalledWith(
      [161, 162],
      { includeStatusValues: false },
    );
    expect(
      deps.insertIdempotencyClaim.mock.invocationCallOrder[0],
    ).toBeLessThan(deps.inspectSources.mock.invocationCallOrder[0]);
    expect(deps.inspectSources.mock.invocationCallOrder[0]).toBeLessThan(
      deps.store.create.mock.invocationCallOrder[0],
    );
    expect(deps.assignSource.mock.calls).toEqual([
      [161, "pinduoduo_sales"],
      [162, "pinduoduo_sales"],
    ]);
    expect(deps.runEtl.mock.calls).toEqual([
      [161, { moduleCode: "pinduoduo_sales" }],
      [162, { moduleCode: "pinduoduo_sales" }],
    ]);
    expect(deps.ensureDefaultModuleCharts).toHaveBeenCalledWith(
      expect.objectContaining({ code: "pinduoduo_sales" }),
    );
    expect(
      deps.runEtl.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(
      deps.ensureDefaultModuleCharts.mock.invocationCallOrder[0],
    );
  });

  test("creates validated computed columns and ratio metrics without accepting SQL", async () => {
    const deps = fakeBuilderDeps();
    deps.inspectSources.mockResolvedValue(inspection({
      headers: ["支付时间", "商品金额", "商品成本", "订单状态", "商品名称", "备注"],
      inferredTypes: {
        支付时间: "timestamp",
        商品金额: "numeric",
        商品成本: "numeric",
        订单状态: "text",
        商品名称: "text",
        备注: "text",
      },
    }));
    const app = createModuleBuilderRoutes(deps);
    const request: any = pinduoduoCreateRequest("calculated-fields");
    request.additionalFields.push({ source: "商品成本", label: "商品成本", type: "numeric" });
    request.calculatedFields = [{
      label: "毛利",
      operation: "subtract",
      leftSource: "商品金额",
      rightSource: "商品成本",
      unit: "currency",
    }, {
      label: "成本率",
      operation: "ratio",
      leftSource: "商品成本",
      rightSource: "商品金额",
      unit: "percent",
    }];

    const response = await requestAsUser(app, "POST", "/", request);

    expect(response.status).toBe(201);
    const saved = deps.store.create.mock.calls[0][0].config as ModuleDef;
    expect(saved.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "毛利",
        computed: true,
        expression: '"amount" - "field_6"',
      }),
      expect.objectContaining({
        label: "成本率",
        computed: true,
        expression: '"field_6" / NULLIF("amount", 0)',
      }),
    ]));
    expect(saved.semanticModel?.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "毛利",
        aggregation: "sum",
        unit: "currency",
      }),
      expect.objectContaining({
        label: "成本率",
        aggregation: "ratio",
        numeratorField: "field_6",
        denominatorField: "amount",
        unit: "percent",
        additiveAcrossTime: false,
      }),
    ]));
  });

  test("records initially unselected source fields as ignored before the first ETL", async () => {
    const deps = fakeBuilderDeps();
    const app = createModuleBuilderRoutes(deps);

    const response = await requestAsUser(
      app,
      "POST",
      "/",
      minimalCreateRequest("initial-schema-baseline"),
    );

    expect(response.status).toBe(201);
    expect(deps.store.upsertSchemaDecisions).toHaveBeenCalledWith(
      "minimal_sales",
      [
        { sourceField: "支付时间", decision: "ignore" },
        { sourceField: "订单状态", decision: "ignore" },
        { sourceField: "商品名称", decision: "ignore" },
        { sourceField: "备注", decision: "ignore" },
      ],
      7,
    );
    expect(deps.runEtl).toHaveBeenCalled();
  });

  test("repeating an idempotency key returns the original response without duplicates", async () => {
    const deps = fakeBuilderDeps();
    const app = createModuleBuilderRoutes(deps);

    await requestAsUser(app, "POST", "/", pinduoduoCreateRequest("same-key"));
    const second = await requestAsUser(
      app,
      "POST",
      "/",
      pinduoduoCreateRequest("same-key"),
    );

    expect(second.status).toBe(200);
    expect(deps.store.create).toHaveBeenCalledTimes(1);
    expect(deps.assignSource).toHaveBeenCalledTimes(2);
    expect(deps.runEtl).toHaveBeenCalledTimes(2);
    expect(deps.ensureDefaultModuleCharts).toHaveBeenCalledTimes(1);
  });

  test("two concurrent creates with one fingerprint wait for and replay one durable operation", async () => {
    const deps = fakeBuilderDeps();
    let signalInspectionStarted!: () => void;
    const inspectionStarted = new Promise<void>((resolve) => {
      signalInspectionStarted = resolve;
    });
    let releaseInspection!: () => void;
    const inspectionRelease = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    deps.inspectSources.mockImplementationOnce(async () => {
      signalInspectionStarted();
      await inspectionRelease;
      return inspection();
    });
    const app = createModuleBuilderRoutes(deps);
    const request = pinduoduoCreateRequest("concurrent-key");

    const firstRequest = requestAsUser(app, "POST", "/", request);
    await inspectionStarted;
    const secondRequest = requestAsUser(app, "POST", "/", request);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(deps.readIdempotencyClaim).toHaveBeenCalled();
    releaseInspection();
    const [first, second] = await Promise.all([firstRequest, secondRequest]);
    const [firstBody, secondBody] = await Promise.all([
      first.json(),
      second.json(),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect(firstBody.data).toEqual(secondBody.data);
    expect(firstBody.data.moduleCode).toBe("pinduoduo_sales");
    expect(deps.store.create).toHaveBeenCalledTimes(1);
    expect(deps.assignSource).toHaveBeenCalledTimes(2);
    expect(deps.runEtl).toHaveBeenCalledTimes(2);
  });

  test("heartbeat renewals are single-flight and stop after completion", async () => {
    const deps = fakeBuilderDeps();
    deps.idempotencyHeartbeatMs = 1;
    const renew = deps.renewIdempotencyClaim.getMockImplementation()!;
    let activeRenewals = 0;
    let maximumActiveRenewals = 0;
    deps.renewIdempotencyClaim.mockImplementation(
      async (key: string, ownerToken: string, leaseDurationMs: number) => {
        activeRenewals += 1;
        maximumActiveRenewals = Math.max(
          maximumActiveRenewals,
          activeRenewals,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 3));
        try {
          return await renew(key, ownerToken, leaseDurationMs);
        } finally {
          activeRenewals -= 1;
        }
      },
    );
    const app = createModuleBuilderRoutes(deps);

    const response = await requestAsUser(
      app,
      "POST",
      "/",
      pinduoduoCreateRequest("heartbeat-key"),
    );
    const callsAtCompletion =
      deps.renewIdempotencyClaim.mock.calls.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(response.status).toBe(201);
    expect(maximumActiveRenewals).toBe(1);
    expect(deps.renewIdempotencyClaim).toHaveBeenCalled();
    expect(deps.renewIdempotencyClaim).toHaveBeenCalledTimes(
      callsAtCompletion,
    );
  });

  test("a superseded owner stops before side effects and replays the takeover result", async () => {
    const deps = fakeBuilderDeps();
    let signalOriginalPaused!: () => void;
    const originalPaused = new Promise<void>((resolve) => {
      signalOriginalPaused = resolve;
    });
    let resumeOriginal!: () => void;
    const originalResume = new Promise<void>((resolve) => {
      resumeOriginal = resolve;
    });
    deps.inspectSources.mockImplementationOnce(async () => {
      signalOriginalPaused();
      await originalResume;
      return inspection();
    });
    const app = createModuleBuilderRoutes(deps);
    const request = pinduoduoCreateRequest("fenced-key");

    const original = requestAsUser(app, "POST", "/", request);
    await originalPaused;
    deps.advanceIdempotencyTime(61_000);
    const takeover = await requestAsUser(app, "POST", "/", request);
    resumeOriginal();
    const originalResponse = await original;
    const [takeoverBody, originalBody] = await Promise.all([
      takeover.json(),
      originalResponse.json(),
    ]);

    expect([takeover.status, originalResponse.status].sort()).toEqual([
      200,
      201,
    ]);
    expect(originalBody.data).toEqual(takeoverBody.data);
    expect(deps.store.create).toHaveBeenCalledTimes(1);
    expect(deps.assignSource).toHaveBeenCalledTimes(2);
    expect(deps.runEtl).toHaveBeenCalledTimes(2);
  });

  test("cleanup ownership loss overrides a delayed create error and replays takeover", async () => {
    const deps = fakeBuilderDeps();
    deps.idempotencyHeartbeatMs = 1;
    let signalOriginalCreateStarted!: () => void;
    const originalCreateStarted = new Promise<void>((resolve) => {
      signalOriginalCreateStarted = resolve;
    });
    let releaseOriginalCreate!: () => void;
    const originalCreateRelease = new Promise<void>((resolve) => {
      releaseOriginalCreate = resolve;
    });
    let createCalls = 0;
    let successfulCreates = 0;
    deps.store.create.mockImplementation(
      async ({ config }: { config: ModuleDef }) => {
        createCalls += 1;
        if (createCalls === 1) {
          signalOriginalCreateStarted();
          await originalCreateRelease;
          throw new Error("duplicate key after lease takeover");
        }
        successfulCreates += 1;
        return {
          code: config.code,
          name: config.name,
          category: config.category ?? null,
          description: config.description,
          config,
          version: 1,
          origin: "user",
          status: "active",
          createdBy: 7,
        };
      },
    );
    const app = createModuleBuilderRoutes(deps);
    const request = pinduoduoCreateRequest("cleanup-fenced-key");

    const original = requestAsUser(app, "POST", "/", request);
    await originalCreateStarted;
    deps.advanceIdempotencyTime(61_000);
    const takeover = await requestAsUser(app, "POST", "/", request);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    releaseOriginalCreate();
    const originalResponse = await original;
    const [takeoverBody, originalBody] = await Promise.all([
      takeover.json(),
      originalResponse.json(),
    ]);

    expect([takeover.status, originalResponse.status].sort()).toEqual([
      200,
      201,
    ]);
    expect(originalBody.data).toEqual(takeoverBody.data);
    expect(successfulCreates).toBe(1);
    expect(deps.assignSource).toHaveBeenCalledTimes(2);
    expect(deps.runEtl).toHaveBeenCalledTimes(2);
  });

  test("an interrupted post-save request resumes its claimed module code", async () => {
    const deps = fakeBuilderDeps();
    let savedModule: LoadedModule | null = null;
    let savedStored: Awaited<
      ReturnType<ModuleBuilderRouteDeps["store"]["create"]>
    > | null = null;
    deps.store.create.mockImplementationOnce(async ({ config }: { config: ModuleDef }) => {
      savedModule = {
        ...config,
        origin: "user",
        version: 1,
        configurable: true,
      } as LoadedModule;
      savedStored = {
        code: config.code,
        name: config.name,
        category: config.category ?? null,
        description: config.description,
        config,
        version: 1,
        origin: "user",
        status: "active",
        createdBy: 7,
      };
      return savedStored;
    });
    deps.store.listActive.mockImplementation(async () =>
      savedStored ? [savedStored] : [],
    );
    let forceReloads = 0;
    deps.loadModules.mockImplementation(async (force?: boolean) => {
      if (force && forceReloads++ === 0) {
        throw new Error("simulated process interruption");
      }
      return savedModule ? [savedModule] : [];
    });
    const app = createModuleBuilderRoutes(deps);
    const request = pinduoduoCreateRequest("recovery-key");

    const interrupted = await requestAsUser(app, "POST", "/", request);
    const recovered = await requestAsUser(app, "POST", "/", request);
    const recoveredBody = await recovered.json();

    expect(interrupted.status).toBe(500);
    expect(recovered.status).toBe(201);
    expect(recoveredBody.data.moduleCode).toBe("pinduoduo_sales");
    expect(deps.store.create).toHaveBeenCalledTimes(1);
  });

  test("post-save recovery compares the canonical JSONB form of a minimal config", async () => {
    const deps = fakeBuilderDeps();
    let savedModule: LoadedModule | null = null;
    let savedStored: Awaited<
      ReturnType<ModuleBuilderRouteDeps["store"]["create"]>
    > | null = null;
    deps.store.create.mockImplementationOnce(
      async ({ config }: { config: ModuleDef }) => {
        const persistedConfig = JSON.parse(
          JSON.stringify(config),
        ) as ModuleDef;
        savedModule = {
          ...persistedConfig,
          origin: "user",
          version: 1,
          configurable: true,
        } as LoadedModule;
        savedStored = {
          code: persistedConfig.code,
          name: persistedConfig.name,
          category: persistedConfig.category ?? null,
          description: persistedConfig.description,
          config: persistedConfig,
          version: 1,
          origin: "user",
          status: "active",
          createdBy: 7,
        };
        return savedStored;
      },
    );
    deps.store.listActive.mockImplementation(async () =>
      savedStored ? [savedStored] : [],
    );
    let forceReloads = 0;
    deps.loadModules.mockImplementation(async (force?: boolean) => {
      if (force && forceReloads++ === 0) {
        throw new Error("simulated post-save interruption");
      }
      return savedModule ? [savedModule] : [];
    });
    const app = createModuleBuilderRoutes(deps);
    const request = minimalCreateRequest();

    const interrupted = await requestAsUser(app, "POST", "/", request);
    const recovered = await requestAsUser(app, "POST", "/", request);
    const body = await recovered.json();

    expect(interrupted.status).toBe(500);
    expect(recovered.status).toBe(201);
    expect(body.data.moduleCode).toBe("minimal_sales");
    expect(deps.store.create).toHaveBeenCalledTimes(1);
  });

  test("a stale pre-save claim is taken over with its original module code", async () => {
    const deps = fakeBuilderDeps();
    deps.inspectSources.mockRejectedValueOnce(
      new Error("simulated pre-save interruption"),
    );
    const app = createModuleBuilderRoutes(deps);
    const request = pinduoduoCreateRequest("pre-save-recovery-key");

    const interrupted = await requestAsUser(app, "POST", "/", request);
    const recovered = await requestAsUser(app, "POST", "/", request);
    const recoveredBody = await recovered.json();

    expect(interrupted.status).toBe(500);
    expect(recovered.status).toBe(201);
    expect(recoveredBody.data.moduleCode).toBe("pinduoduo_sales");
    expect(deps.store.create).toHaveBeenCalledTimes(1);
    expect(deps.insertIdempotencyClaim).toHaveBeenCalledTimes(2);
  });

  test.each(["actor", "request"] as const)(
    "the same key with a different %s returns a deterministic conflict",
    async (mismatch) => {
      const deps = fakeBuilderDeps();
      const app = createModuleBuilderRoutes(deps);
      const original = pinduoduoCreateRequest("bound-key");
      await requestAsUser(app, "POST", "/", original);

      const second =
        mismatch === "actor"
          ? await requestAsActor(
              app,
              { uid: 8, username: "other", isAdmin: false },
              "POST",
              "/",
              original,
            )
          : await requestAsUser(app, "POST", "/", {
              ...original,
              description: "different request",
            });

      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({
        ok: false,
        message: "Idempotency key is already bound to another request",
      });
      expect(deps.store.create).toHaveBeenCalledTimes(1);
    },
  );

  test("does not assign a source when saving the configuration fails", async () => {
    const deps = fakeBuilderDeps();
    deps.store.create.mockRejectedValueOnce(new Error("database unavailable"));
    const app = createModuleBuilderRoutes(deps);

    const res = await requestAsUser(
      app,
      "POST",
      "/",
      pinduoduoCreateRequest(),
    );

    expect(res.status).toBe(500);
    expect(deps.assignSource).not.toHaveBeenCalled();
    expect(deps.runEtl).not.toHaveBeenCalled();
  });

  test("keeps saved configuration and assignments when one ETL fails", async () => {
    const deps = fakeBuilderDeps();
    deps.runEtl
      .mockResolvedValueOnce({
        sourceId: 161,
        total: 736,
        inserted: 650,
        error: "password=top-secret SQL relation user_data.uf_161 failed",
      })
      .mockResolvedValueOnce({
        sourceId: 162,
        total: 326,
        inserted: 290,
      });
    const app = createModuleBuilderRoutes(deps);

    const res = await requestAsUser(
      app,
      "POST",
      "/",
      pinduoduoCreateRequest(),
    );

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toMatchObject({
      data: {
        files: [
          {
            sourceId: 161,
            status: "failed",
            error: "文件处理失败，请稍后重试",
          },
          { sourceId: 162, status: "success" },
        ],
      },
    });
    expect(JSON.stringify(json)).not.toContain("top-secret");
    expect(JSON.stringify(json)).not.toContain("user_data.uf_161");
    expect(deps.store.create).toHaveBeenCalledTimes(1);
    expect(deps.assignSource).toHaveBeenCalledTimes(2);
    const responseBody = JSON.stringify(await deps.readIdempotencyClaim("request-1"));
    expect(responseBody).not.toContain("top-secret");
    expect(responseBody).not.toContain("user_data.uf_161");
    const completed = JSON.parse(responseBody);
    expect(completed).toMatchObject({
      state: "completed",
      actorId: 7,
      moduleCode: "pinduoduo_sales",
      result: {
        files: [
          { sourceId: 161, error: "文件处理失败，请稍后重试" },
          { sourceId: 162, status: "success" },
        ],
      },
    });
    expect(deps.ensureDefaultModuleCharts).toHaveBeenCalledTimes(1);
  });

  test("preserves a known actionable ETL error without exposing internals", async () => {
    const deps = fakeBuilderDeps();
    deps.runEtl
      .mockResolvedValueOnce({
        sourceId: 161,
        total: 0,
        inserted: 0,
        error: "未导入维护表(品牌字典)，请先导入",
      })
      .mockResolvedValueOnce({
        sourceId: 162,
        total: 326,
        inserted: 290,
      });
    const app = createModuleBuilderRoutes(deps);

    const res = await requestAsUser(
      app,
      "POST",
      "/",
      pinduoduoCreateRequest("actionable-etl-error"),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      data: {
        files: [
          {
            sourceId: 161,
            status: "failed",
            error: "未导入品牌维护表，请先导入",
          },
          { sourceId: 162, status: "success" },
        ],
      },
    });
  });

  test("keeps successful ETL when default chart initialization fails", async () => {
    const deps = fakeBuilderDeps();
    deps.ensureDefaultModuleCharts.mockRejectedValueOnce(
      new Error("charts unavailable"),
    );
    const app = createModuleBuilderRoutes(deps);

    const request = pinduoduoCreateRequest("chart-warning");
    const res = await requestAsUser(
      app,
      "POST",
      "/",
      request,
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      data: {
        files: [
          { sourceId: 161, status: "success" },
          { sourceId: 162, status: "success" },
        ],
        warnings: [
          "数据已处理，但基础看板初始化失败，可稍后重试",
        ],
      },
    });
    expect(deps.ensureDefaultModuleCharts).toHaveBeenCalledTimes(1);

    const replay = await requestAsUser(app, "POST", "/", request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      data: {
        warnings: [
          "数据已处理，但基础看板初始化失败，可稍后重试",
        ],
      },
    });
    expect(deps.ensureDefaultModuleCharts).toHaveBeenCalledTimes(1);
  });

  test("does not initialize charts when every ETL file fails", async () => {
    const deps = fakeBuilderDeps();
    deps.runEtl.mockRejectedValue(new Error("ETL failed"));
    const app = createModuleBuilderRoutes(deps);

    const res = await requestAsUser(
      app,
      "POST",
      "/",
      pinduoduoCreateRequest("all-etl-failed"),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      data: {
        files: [
          { sourceId: 161, status: "failed" },
          { sourceId: 162, status: "failed" },
        ],
      },
    });
    expect(deps.ensureDefaultModuleCharts).not.toHaveBeenCalled();
  });

  test("inspects selected sources and only opts into status queries when requested", async () => {
    const deps = fakeBuilderDeps();
    const app = createModuleBuilderRoutes(deps);

    const res = await requestAsUser(app, "POST", "/inspect-sources", {
      sourceIds: [161, 162],
      includeStatusValues: true,
      statusSource: "售后状态",
    });
    const orderStatusRes = await requestAsUser(
      app,
      "POST",
      "/inspect-sources",
      {
        sourceIds: [161, 162],
        includeStatusValues: true,
        statusSource: "订单状态",
      },
    );

    expect(res.status).toBe(200);
    expect(orderStatusRes.status).toBe(200);
    expect(deps.inspectSources).toHaveBeenNthCalledWith(
      1,
      [161, 162],
      { includeStatusValues: true, statusSource: "售后状态" },
    );
    expect(deps.inspectSources).toHaveBeenNthCalledWith(
      2,
      [161, 162],
      { includeStatusValues: true, statusSource: "订单状态" },
    );
    expect(await res.json()).toMatchObject({
      ok: true,
      data: { compatible: true, sourceIds: [161, 162] },
    });
  });

  test("returns a structured incompatible inspection instead of a server error", async () => {
    const deps = fakeBuilderDeps();
    deps.inspectSources.mockResolvedValueOnce(
      inspection({
        compatible: false,
        differences: [
          { sourceId: 162, added: ["新字段"], missing: ["商品金额"] },
        ],
      }),
    );
    const app = createModuleBuilderRoutes(deps);

    const res = await requestAsUser(app, "POST", "/inspect-sources", {
      sourceIds: [161, 162],
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        compatible: false,
        differences: [
          { sourceId: 162, added: ["新字段"], missing: ["商品金额"] },
        ],
      },
    });
    expect(deps.inspectSources).toHaveBeenCalledWith(
      [161, 162],
      { includeStatusValues: true },
    );
  });

  test("serves schema diff, decisions, versions, restore, and archive routes", async () => {
    const deps = fakeBuilderDeps();
    deps.loadModules.mockResolvedValue([
      {
        ...userModule(),
        origin: "user",
        version: 2,
        configurable: true,
      } as LoadedModule,
    ]);
    const app = createModuleBuilderRoutes(deps);

    const diff = await requestAsUser(
      app,
      "GET",
      "/pinduoduo_sales/schema-diff?sourceId=161",
    );
    const decisions = await requestAsUser(
      app,
      "POST",
      "/pinduoduo_sales/schema-decisions",
      {
        decisions: [
          {
            sourceField: "新字段",
            decision: "alias",
            targetField: "amount",
          },
        ],
        sourceIds: [161],
        expectedVersion: 2,
        operationId: "11111111-1111-4111-8111-111111111111",
        schemaFingerprints: { "161": sourceSchemaFingerprint(inspection()) },
      },
    );
    const versions = await requestAsUser(
      app,
      "GET",
      "/pinduoduo_sales/versions",
    );
    const restore = await requestAsActor(
      app,
      { uid: 7, username: "operator", isAdmin: true },
      "POST",
      "/pinduoduo_sales/versions/1/restore",
    );
    const archive = await requestAsActor(
      app,
      { uid: 7, username: "operator", isAdmin: true },
      "POST",
      "/pinduoduo_sales/archive",
    );

    expect(diff.status).toBe(200);
    expect(await diff.json()).toMatchObject({
      data: { added: ["新字段"], missingOptional: ["备注"] },
    });
    expect(deps.inspectSources).toHaveBeenCalledWith(
      [161],
      { includeStatusValues: false },
    );
    expect(decisions.status).toBe(200);
    expect(deps.withSchemaReviewTransaction).toHaveBeenCalledTimes(1);
    expect(deps.runEtl).toHaveBeenCalledWith(161, {
      moduleCode: "pinduoduo_sales",
      moduleOverride: expect.objectContaining({ code: "pinduoduo_sales" }),
      manageSchemaReviewState: false,
      executor: expect.objectContaining({ unsafe: expect.any(Function) }),
    });
    expect(versions.status).toBe(200);
    expect(restore.status).toBe(200);
    expect(deps.store.restore).toHaveBeenCalledWith(
      "pinduoduo_sales",
      1,
      7,
    );
    expect(archive.status).toBe(200);
    expect(deps.store.archive).toHaveBeenCalledWith("pinduoduo_sales", 7);
    expect(deps.invalidateModuleCache).toHaveBeenCalledTimes(3);
  });

  test("does not persist schema decisions while a required field is unresolved", async () => {
    const deps = fakeBuilderDeps();
    deps.loadModules.mockResolvedValue([
      {
        ...userModule(),
        origin: "user",
        version: 2,
        configurable: true,
      } as LoadedModule,
    ]);
    deps.diffSchema.mockReturnValue({
      added: ["下单时间"],
      missingRequired: ["支付时间"],
      missingOptional: [],
      missingRequiredFields: [{ name: "time", label: "支付时间" }],
      missingOptionalFields: [],
      aliasCandidates: [
        { source: "下单时间", target: "time", score: 0.9 },
      ],
      typeChanges: [],
    });
    const app = createModuleBuilderRoutes(deps);

    const response = await requestAsUser(
      app,
      "POST",
      "/pinduoduo_sales/schema-decisions",
      {
        sourceIds: [161],
        decisions: [
          { sourceField: "下单时间", decision: "ignore" },
        ],
        expectedVersion: 2,
        operationId: "11111111-1111-4111-8111-111111111111",
        schemaFingerprints: { "161": sourceSchemaFingerprint(inspection()) },
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: "仍有必要字段尚未对应",
    });
    expect(deps.store.activateSchemaDecisions).not.toHaveBeenCalled();
    expect(deps.runEtl).not.toHaveBeenCalled();
  });

  test.each([
    ["unassigned source", "该文件没有待确认的字段变化", 400],
    ["different module", "该文件没有待确认的字段变化", 400],
    ["no pending marker", "该文件没有待确认的字段变化", 400],
  ])("rejects %s before schema ETL", async (_case, message, status) => {
    const deps = fakeBuilderDeps();
    deps.loadModules.mockResolvedValue([{
      ...userModule(),
      origin: "user",
      version: 2,
      configurable: true,
    } as LoadedModule]);
    deps.readSourceSchemaReviewOperation.mockRejectedValueOnce(
      new SourceSchemaReviewStateError(message),
    );
    const app = createModuleBuilderRoutes(deps);

    const response = await requestAsUser(
      app,
      "POST",
      "/pinduoduo_sales/schema-decisions",
      {
        sourceIds: [161],
        decisions: [{ sourceField: "新字段", decision: "ignore" }],
        expectedVersion: 2,
        operationId: "11111111-1111-4111-8111-111111111111",
        schemaFingerprints: { "161": sourceSchemaFingerprint(inspection()) },
      },
    );

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ message });
    expect(deps.withSchemaReviewTransaction).not.toHaveBeenCalled();
    expect(deps.runEtl).not.toHaveBeenCalled();
  });

  test.each([
    ["stale fingerprint", {
      sourceIds: [161],
      schemaFingerprints: { "161": "b".repeat(64) },
    }],
    ["mixed operation group", {
      sourceIds: [161, 162],
      schemaFingerprints: {
        "161": sourceSchemaFingerprint(inspection()),
        "162": sourceSchemaFingerprint(inspection()),
      },
    }],
  ])("rejects %s before schema ETL", async (_case, override) => {
    const deps = fakeBuilderDeps();
    deps.loadModules.mockResolvedValue([{
      ...userModule(),
      origin: "user",
      version: 2,
      configurable: true,
    } as LoadedModule]);
    const app = createModuleBuilderRoutes(deps);
    const response = await requestAsUser(
      app,
      "POST",
      "/pinduoduo_sales/schema-decisions",
      {
        sourceIds: [161],
        decisions: [{ sourceField: "新字段", decision: "ignore" }],
        expectedVersion: 2,
        operationId: "11111111-1111-4111-8111-111111111111",
        schemaFingerprints: { "161": sourceSchemaFingerprint(inspection()) },
        ...override,
      },
    );

    expect(response.status).toBe(409);
    expect(deps.withSchemaReviewTransaction).not.toHaveBeenCalled();
    expect(deps.runEtl).not.toHaveBeenCalled();
  });

  test("rejects an operation marker changed between preflight and transaction", async () => {
    const deps = fakeBuilderDeps();
    deps.loadModules.mockResolvedValue([{
      ...userModule(),
      origin: "user",
      version: 2,
      configurable: true,
    } as LoadedModule]);
    const preflight = schemaReviewOperation();
    const changed = schemaReviewOperation({
      operationId: "22222222-2222-4222-8222-222222222222",
    });
    deps.readSourceSchemaReviewOperation
      .mockResolvedValueOnce(preflight)
      .mockResolvedValueOnce(changed);
    const app = createModuleBuilderRoutes(deps);

    const response = await requestAsUser(
      app,
      "POST",
      "/pinduoduo_sales/schema-decisions",
      {
        sourceIds: [161],
        decisions: [{
          sourceField: "新字段",
          decision: "alias",
          targetField: "amount",
        }],
        expectedVersion: 2,
        operationId: preflight.review.operationId,
        schemaFingerprints: preflight.review.schemaFingerprints,
      },
    );

    expect(response.status).toBe(409);
    expect(deps.withSchemaReviewTransaction).toHaveBeenCalledTimes(1);
    expect(deps.runEtl).not.toHaveBeenCalled();
  });

  test.each([
    ["status", () => {
      const preflight = schemaReviewOperation({ sourceIds: [161, 162] });
      return {
        preflight,
        transaction: schemaReviewOperation({
          sourceIds: [161, 162],
          mutateMember: (marker, sourceId) =>
            sourceId === 162
              ? { ...marker, status: "awaiting_retry", stagedDecisions: [] }
              : marker,
        }),
      };
    }],
    ["version", () => {
      const preflight = schemaReviewOperation({ sourceIds: [161, 162] });
      return {
        preflight,
        transaction: schemaReviewOperation({
          sourceIds: [161, 162],
          mutateMember: (marker, sourceId) =>
            sourceId === 162 ? { ...marker, moduleVersion: 3 } : marker,
        }),
      };
    }],
    ["fingerprint", () => {
      const preflight = schemaReviewOperation({ sourceIds: [161, 162] });
      return {
        preflight,
        transaction: schemaReviewOperation({
          sourceIds: [161, 162],
          mutateMember: (marker, sourceId) =>
            sourceId === 162
              ? { ...marker, schemaFingerprint: "c".repeat(64) }
              : marker,
        }),
      };
    }],
    ["staged decisions", () => {
      const decisions = [{
        sourceField: "新字段",
        decision: "alias",
        targetField: "amount",
      }];
      const preflight = schemaReviewOperation({
        sourceIds: [161, 162],
        status: "awaiting_retry",
        stagedDecisions: decisions,
      });
      return {
        preflight,
        transaction: schemaReviewOperation({
          sourceIds: [161, 162],
          status: "awaiting_retry",
          stagedDecisions: decisions,
          mutateMember: (marker, sourceId) =>
            sourceId === 162
              ? {
                  ...marker,
                  stagedDecisions: [{
                    sourceField: "other",
                    decision: "ignore",
                  }],
                }
              : marker,
        }),
      };
    }],
  ])("rejects mixed %s marker state inside the transaction", async (_case, build) => {
    const deps = fakeBuilderDeps();
    deps.loadModules.mockResolvedValue([{
      ...userModule(),
      origin: "user",
      version: 2,
      configurable: true,
    } as LoadedModule]);
    const { preflight, transaction } = build();
    deps.readSourceSchemaReviewOperation
      .mockResolvedValueOnce(preflight)
      .mockResolvedValueOnce(transaction);
    const app = createModuleBuilderRoutes(deps);

    const response = await requestAsUser(
      app,
      "POST",
      "/pinduoduo_sales/schema-decisions",
      {
        sourceIds: preflight.review.sourceIds,
        decisions: [{
          sourceField: "新字段",
          decision: "alias",
          targetField: "amount",
        }],
        expectedVersion: 2,
        operationId: preflight.review.operationId,
        schemaFingerprints: preflight.review.schemaFingerprints,
      },
    );

    expect(response.status).toBe(409);
    expect(deps.withSchemaReviewTransaction).toHaveBeenCalledTimes(1);
    expect(deps.runEtl).not.toHaveBeenCalled();
  });

  test("keeps candidate decisions staged when trial ETL fails", async () => {
    const deps = fakeBuilderDeps();
    deps.loadModules.mockResolvedValue([{
      ...userModule(),
      origin: "user",
      version: 2,
      configurable: true,
    } as LoadedModule]);
    deps.runEtl.mockResolvedValueOnce({
      platform: "通用",
      sourceId: 161,
      fileName: "161.csv",
      total: 10,
      inserted: 0,
      matched: 0,
      matchRate: 0,
      error: "必要字段存在无法读取的值，请修正源文件后重新上传",
    });
    const app = createModuleBuilderRoutes(deps);

    const response = await requestAsUser(
      app,
      "POST",
      "/pinduoduo_sales/schema-decisions",
      {
        sourceIds: [161],
        decisions: [{
          sourceField: "新字段",
          decision: "alias",
          targetField: "amount",
        }],
        expectedVersion: 2,
        operationId: "11111111-1111-4111-8111-111111111111",
        schemaFingerprints: { "161": sourceSchemaFingerprint(inspection()) },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        awaitingRetry: true,
        files: [{ sourceId: 161, status: "failed" }],
      },
    });
    expect(deps.store.activateSchemaDecisions).not.toHaveBeenCalled();
    expect(deps.markSourceSchemaReviewAwaitingRetry).toHaveBeenCalledWith(
      161,
      "pinduoduo_sales",
      expect.any(Object),
      expect.objectContaining({
        moduleVersion: 2,
        stagedDecisions: [
          {
            sourceField: "新字段",
            decision: "alias",
            targetField: "amount",
          },
        ],
      }),
      expect.objectContaining({ unsafe: expect.any(Function) }),
    );
  });

  test("does not resurrect retry markers when a later success clears the group", async () => {
    const deps = fakeBuilderDeps();
    deps.loadModules.mockResolvedValue([{
      ...userModule(),
      origin: "user",
      version: 2,
      configurable: true,
    } as LoadedModule]);
    const operation = schemaReviewOperation();
    deps.readSourceSchemaReviewOperation
      .mockResolvedValueOnce(operation)
      .mockResolvedValueOnce(operation)
      .mockRejectedValueOnce(
        new SourceSchemaReviewStateError(
          "该文件没有待确认的字段变化",
          409,
        ),
      );
    deps.runEtl.mockResolvedValue({
      platform: "通用",
      sourceId: 161,
      fileName: "161.csv",
      total: 1,
      inserted: 0,
      matched: 0,
      matchRate: 0,
      error: "password=stale-secret SQL failed",
    });
    const app = createModuleBuilderRoutes(deps);

    const response = await requestAsUser(
      app,
      "POST",
      "/pinduoduo_sales/schema-decisions",
      {
        sourceIds: [161],
        decisions: [{
          sourceField: "新字段",
          decision: "alias",
          targetField: "amount",
        }],
        expectedVersion: 2,
        operationId: operation.review.operationId,
        schemaFingerprints: operation.review.schemaFingerprints,
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ data: { awaitingRetry: false } });
    expect(JSON.stringify(body)).not.toContain("stale-secret");
    expect(deps.withSchemaReviewTransaction).toHaveBeenCalledTimes(2);
    expect(deps.markSourceSchemaReviewAwaitingRetry).not.toHaveBeenCalled();
  });

  test("does not resurrect retry markers when the failed group is reassigned", async () => {
    const deps = fakeBuilderDeps();
    deps.loadModules.mockResolvedValue([{
      ...userModule(),
      origin: "user",
      version: 2,
      configurable: true,
    } as LoadedModule]);
    const operation = schemaReviewOperation();
    const reassigned = structuredClone(operation);
    reassigned.sources[0].config = { moduleCode: "orders" };
    deps.readSourceSchemaReviewOperation
      .mockResolvedValueOnce(operation)
      .mockResolvedValueOnce(operation)
      .mockResolvedValueOnce(reassigned);
    deps.runEtl.mockResolvedValue({
      platform: "通用",
      sourceId: 161,
      fileName: "161.csv",
      total: 1,
      inserted: 0,
      matched: 0,
      matchRate: 0,
      error: "failed",
    });
    const app = createModuleBuilderRoutes(deps);

    const response = await requestAsUser(
      app,
      "POST",
      "/pinduoduo_sales/schema-decisions",
      {
        sourceIds: [161],
        decisions: [{
          sourceField: "新字段",
          decision: "alias",
          targetField: "amount",
        }],
        expectedVersion: 2,
        operationId: operation.review.operationId,
        schemaFingerprints: operation.review.schemaFingerprints,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { awaitingRetry: false },
    });
    expect(deps.withSchemaReviewTransaction).toHaveBeenCalledTimes(2);
    expect(deps.markSourceSchemaReviewAwaitingRetry).not.toHaveBeenCalled();
  });

  test.each(["update", "restore"])(
    "does not persist stale retry markers after a concurrent module %s",
    async () => {
      const deps = fakeBuilderDeps();
      deps.loadModules.mockResolvedValue([{
        ...userModule(),
        origin: "user",
        version: 2,
        configurable: true,
      } as LoadedModule]);
      const operation = schemaReviewOperation();
      deps.readSourceSchemaReviewOperation.mockResolvedValue(operation);
      let transactionNumber = 0;
      deps.withSchemaReviewTransaction.mockImplementation(async (work: any) => {
        transactionNumber += 1;
        const version = transactionNumber === 1 ? 2 : 3;
        return work({
          unsafe: vi.fn(async (query: string) => {
            if (query.includes("FROM public.module_configs")) {
              return [{
                code: "pinduoduo_sales",
                name: "拼多多销售",
                category: "shop_ops",
                description: "拼多多销售数据",
                config: userModule(),
                version,
                origin: "user",
                status: "active",
                createdBy: 7,
              }];
            }
            return [];
          }),
        });
      });
      deps.runEtl.mockResolvedValue({
        platform: "通用",
        sourceId: 161,
        fileName: "161.csv",
        total: 1,
        inserted: 0,
        matched: 0,
        matchRate: 0,
        error: "candidate failed",
      });
      const app = createModuleBuilderRoutes(deps);

      const response = await requestAsUser(
        app,
        "POST",
        "/pinduoduo_sales/schema-decisions",
        {
          sourceIds: [161],
          decisions: [{
            sourceField: "新字段",
            decision: "alias",
            targetField: "amount",
          }],
          expectedVersion: 2,
          operationId: operation.review.operationId,
          schemaFingerprints: operation.review.schemaFingerprints,
        },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { awaitingRetry: false },
      });
      expect(transactionNumber).toBe(2);
      expect(deps.readSourceSchemaReviewOperation).toHaveBeenCalledTimes(2);
      expect(deps.markSourceSchemaReviewAwaitingRetry).not.toHaveBeenCalled();
    },
  );

  test("concurrent failures lock module before sorted sources in every transaction", async () => {
    const deps = fakeBuilderDeps();
    deps.loadModules.mockResolvedValue([{
      ...userModule(),
      origin: "user",
      version: 2,
      configurable: true,
    } as LoadedModule]);
    const operation = schemaReviewOperation({ sourceIds: [161, 162] });
    const events: string[] = [];
    let transactionNumber = 0;
    let queue = Promise.resolve();
    deps.withSchemaReviewTransaction.mockImplementation((work: any) => {
      const current = queue.then(async () => {
        const label = `tx${++transactionNumber}`;
        const executor = {
          label,
          unsafe: vi.fn(async (query: string) => {
            if (query.includes("pg_advisory_xact_lock")) {
              events.push(`${label}:module`);
            }
            if (query.includes("FROM public.module_configs")) {
              events.push(`${label}:config`);
              return [{
                code: "pinduoduo_sales",
                name: "拼多多销售",
                category: "shop_ops",
                description: "拼多多销售数据",
                config: userModule(),
                version: 2,
                origin: "user",
                status: "active",
                createdBy: 7,
              }];
            }
            return [];
          }),
        };
        return work(executor);
      });
      queue = current.then(() => undefined, () => undefined);
      return current;
    });
    deps.readSourceSchemaReviewOperation.mockImplementation(
      async (_sourceId, _code, executor: any, options) => {
        if (executor) {
          events.push(
            `${executor.label}:sources:${options?.expectedSourceIds?.join(",")}`,
          );
        }
        return operation;
      },
    );
    deps.runEtl.mockResolvedValue({
      platform: "通用",
      sourceId: 161,
      fileName: "161.csv",
      total: 1,
      inserted: 0,
      matched: 0,
      matchRate: 0,
      error: "candidate failed",
    });
    const app = createModuleBuilderRoutes(deps);
    const body = {
      sourceIds: [162, 161],
      decisions: [{
        sourceField: "新字段",
        decision: "alias",
        targetField: "amount",
      }],
      expectedVersion: 2,
      operationId: operation.review.operationId,
      schemaFingerprints: operation.review.schemaFingerprints,
    };

    const responses = await Promise.all([
      requestAsUser(app, "POST", "/pinduoduo_sales/schema-decisions", body),
      requestAsUser(app, "POST", "/pinduoduo_sales/schema-decisions", body),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(transactionNumber).toBe(4);
    for (let index = 1; index <= transactionNumber; index += 1) {
      expect(events.filter((event) => event.startsWith(`tx${index}:`)))
        .toEqual([
          `tx${index}:module`,
          `tx${index}:config`,
          `tx${index}:sources:161,162`,
        ]);
    }
  });

  test("rolls back source one output and all activation state when source two fails", async () => {
    const deps = fakeBuilderDeps();
    const fingerprint = sourceSchemaFingerprint(inspection());
    const review = {
      status: "pending" as const,
      operationId: "11111111-1111-4111-8111-111111111111",
      sourceIds: [161, 162],
      moduleCode: "pinduoduo_sales",
      moduleVersion: 2,
      schemaFingerprint: fingerprint,
      schemaFingerprints: { "161": fingerprint, "162": fingerprint },
      diff: {
        added: ["新字段"],
        missingRequired: [],
        missingOptional: [],
        aliasCandidates: [],
        typeChanges: [],
      },
      detectedAt: "2026-07-17T00:00:00.000Z",
    };
    deps.readSourceSchemaReviewOperation.mockResolvedValue({
      review,
      sources: [161, 162].map((id) => ({
        id,
        name: `${id}.csv`,
        config: { moduleCode: "pinduoduo_sales", schemaReview: review },
      })),
    });
    deps.loadModules.mockResolvedValue([{
      ...userModule(),
      origin: "user",
      version: 2,
      configurable: true,
    } as LoadedModule]);
    const state = {
      version: 2,
      outputs: new Map<number, string>([[161, "old-161"], [162, "old-162"]]),
      decisions: [] as unknown[],
      cleared: [] as number[],
    };
    const executor = {
      unsafe: vi.fn(async (query: string) => {
        if (query.includes("FROM public.module_configs")) {
          return [{
            code: "pinduoduo_sales",
            name: "拼多多销售",
            category: "shop_ops",
            description: "拼多多销售数据",
            config: userModule(),
            version: state.version,
            origin: "user",
            status: "active",
            createdBy: 7,
          }];
        }
        return [];
      }),
    };
    deps.withSchemaReviewTransaction.mockImplementation(async (work: any) => {
      const saved = structuredClone({
        version: state.version,
        outputs: [...state.outputs],
        decisions: state.decisions,
        cleared: state.cleared,
      });
      try {
        return await work(executor);
      } catch (error) {
        state.version = saved.version;
        state.outputs = new Map(saved.outputs);
        state.decisions = saved.decisions;
        state.cleared = saved.cleared;
        throw error;
      }
    });
    deps.runEtl.mockImplementation(async (sourceId) => {
      state.outputs.set(sourceId, `candidate-${sourceId}`);
      return {
        platform: "通用",
        sourceId,
        fileName: `${sourceId}.csv`,
        total: 1,
        inserted: sourceId === 161 ? 1 : 0,
        matched: 0,
        matchRate: 0,
        ...(sourceId === 162
          ? { error: "password=raw-secret SQL failed" }
          : {}),
      };
    });
    const app = createModuleBuilderRoutes(deps);

    const response = await requestAsUser(
      app,
      "POST",
      "/pinduoduo_sales/schema-decisions",
      {
        sourceIds: [161, 162],
        decisions: [{
          sourceField: "新字段",
          decision: "alias",
          targetField: "amount",
        }],
        expectedVersion: 2,
        operationId: review.operationId,
        schemaFingerprints: review.schemaFingerprints,
      },
    );

    expect(response.status).toBe(200);
    expect(state).toMatchObject({
      version: 2,
      decisions: [],
      cleared: [],
    });
    expect([...state.outputs]).toEqual([[161, "old-161"], [162, "old-162"]]);
    expect(deps.markSourceSchemaReviewAwaitingRetry).toHaveBeenCalledTimes(2);
    for (const call of deps.markSourceSchemaReviewAwaitingRetry.mock.calls) {
      expect(call[3]).toMatchObject({
        operationId: review.operationId,
        sourceIds: [161, 162],
        retryMessage: "文件处理失败，请稍后重试",
      });
      expect(JSON.stringify(call[3])).not.toContain("raw-secret");
    }
  });

  test("fences concurrent schema confirmations with one atomic activation", async () => {
    const deps = fakeBuilderDeps();
    deps.loadModules.mockResolvedValue([{
      ...userModule(),
      origin: "user",
      version: 2,
      configurable: true,
    } as LoadedModule]);
    let version = 2;
    let committedOutput = "";
    let queue = Promise.resolve();
    const executor = {
      unsafe: vi.fn(async (query: string, parameters: unknown[] = []) => {
        if (query.includes("FROM public.module_configs")) {
          return [{
            code: "pinduoduo_sales",
            name: "拼多多销售",
            category: "shop_ops",
            description: "拼多多销售数据",
            config: userModule(),
            version,
            origin: "user",
            status: "active",
            createdBy: 7,
          }];
        }
        if (query.includes("UPDATE public.module_configs")) {
          version = Number(parameters[4]);
          return [{
            code: "pinduoduo_sales",
            name: "拼多多销售",
            category: "shop_ops",
            description: "拼多多销售数据",
            config: JSON.parse(String(parameters[3])),
            version,
            origin: "user",
            status: "active",
            createdBy: 7,
          }];
        }
        return [];
      }),
    };
    deps.withSchemaReviewTransaction.mockImplementation((work: any) => {
      const current = queue.then(() => work(executor));
      queue = current.then(() => undefined, () => undefined);
      return current;
    });
    deps.runEtl.mockImplementation(async (_sourceId, options) => {
      committedOutput =
        options.moduleOverride.columns.find((column: any) =>
          (Array.isArray(column.source) ? column.source : [column.source])
            .includes("新字段"))?.name ?? "";
      return {
        platform: "通用",
        sourceId: 161,
        fileName: "161.csv",
        total: 1,
        inserted: 1,
        matched: 0,
        matchRate: 0,
      };
    });
    const app = createModuleBuilderRoutes(deps);
    const body = {
      sourceIds: [161],
      decisions: [{
        sourceField: "新字段",
        decision: "alias",
        targetField: "amount",
      }],
      expectedVersion: 2,
      operationId: "11111111-1111-4111-8111-111111111111",
      schemaFingerprints: { "161": sourceSchemaFingerprint(inspection()) },
    };

    const responses = await Promise.all([
      requestAsUser(app, "POST", "/pinduoduo_sales/schema-decisions", body),
      requestAsUser(app, "POST", "/pinduoduo_sales/schema-decisions", body),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(deps.withSchemaReviewTransaction).toHaveBeenCalledTimes(2);
    expect(deps.runEtl).toHaveBeenCalledTimes(1);
    expect(version).toBe(3);
    expect(committedOutput).toBe("amount");
  });

  test("seeds defaults after a successful user-module assign-and-run", async () => {
    const deps = fakeBuilderDeps();
    const module = {
      ...userModule(),
      origin: "user",
      version: 2,
      configurable: true,
    } as LoadedModule;
    deps.loadModules.mockResolvedValue([module]);
    const app = createModuleBuilderRoutes(deps);

    const res = await requestAsUser(
      app,
      "POST",
      "/pinduoduo_sales/assign-and-run",
      { sourceIds: [161] },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        files: [{ sourceId: 161, status: "success" }],
      },
    });
    expect(deps.ensureDefaultModuleCharts).toHaveBeenCalledTimes(1);
    expect(deps.ensureDefaultModuleCharts).toHaveBeenCalledWith(module);
  });

  test("keeps assign-and-run successful and emits one warning when seeding fails", async () => {
    const deps = fakeBuilderDeps();
    const module = {
      ...userModule(),
      origin: "user",
      version: 2,
      configurable: true,
    } as LoadedModule;
    deps.loadModules.mockResolvedValue([module]);
    deps.ensureDefaultModuleCharts.mockRejectedValue(
      new Error("charts unavailable"),
    );
    const app = createModuleBuilderRoutes(deps);

    const res = await requestAsUser(
      app,
      "POST",
      "/pinduoduo_sales/assign-and-run",
      { sourceIds: [161, 162] },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        files: [
          { sourceId: 161, status: "success" },
          { sourceId: 162, status: "success" },
        ],
        warnings: [
          "数据已处理，但基础看板初始化失败，可稍后重试",
        ],
      },
    });
    expect(deps.ensureDefaultModuleCharts).toHaveBeenCalledTimes(1);
  });

  test("seeds defaults after successful schema decisions rerun ETL", async () => {
    const deps = fakeBuilderDeps();
    const module = {
      ...userModule(),
      origin: "user",
      version: 2,
      configurable: true,
    } as LoadedModule;
    deps.loadModules.mockResolvedValue([module]);
    const app = createModuleBuilderRoutes(deps);

    const res = await requestAsUser(
      app,
      "POST",
      "/pinduoduo_sales/schema-decisions",
      {
        decisions: [
          {
            sourceField: "新字段",
            decision: "alias",
            targetField: "amount",
          },
        ],
        sourceIds: [161],
        expectedVersion: 2,
        operationId: "11111111-1111-4111-8111-111111111111",
        schemaFingerprints: { "161": sourceSchemaFingerprint(inspection()) },
      },
    );

    expect(res.status).toBe(200);
    expect(deps.withSchemaReviewTransaction).toHaveBeenCalledTimes(1);
    expect(deps.ensureDefaultModuleCharts).toHaveBeenCalledTimes(1);
    expect(deps.ensureDefaultModuleCharts).toHaveBeenCalledWith(module);
  });

  test("passes built-in overlays through persistence protection and rejects unsafe edits", async () => {
    const deps = fakeBuilderDeps();
    const builtIn = {
      ...userModule(),
      code: "orders",
      name: "销售订单",
      origin: "builtin",
      configurable: true,
    } as LoadedModule;
    deps.loadModules.mockResolvedValue([builtIn]);
    deps.store.create.mockRejectedValueOnce(
      new Error('Invalid built-in overlay: top-level key "hasTransform" cannot change'),
    );
    const app = createModuleBuilderRoutes(deps);

    const res = await requestAsActor(
      app,
      { uid: 7, username: "operator", isAdmin: true },
      "PATCH",
      "/orders",
      {
        ...builtIn,
        hasTransform: true,
      },
    );

    expect(res.status).toBe(400);
    expect(deps.store.create).toHaveBeenCalledWith({
      config: expect.objectContaining({ code: "orders", hasTransform: true }),
      actorId: 7,
      origin: "builtin_overlay",
    });
  });

  test("does not seed user-module defaults while rerunning a built-in module", async () => {
    const deps = fakeBuilderDeps();
    const builtIn = {
      ...userModule(),
      code: "orders",
      name: "销售订单",
      origin: "builtin",
      configurable: true,
    } as LoadedModule;
    deps.loadModules.mockResolvedValue([builtIn]);
    const app = createModuleBuilderRoutes(deps);

    const res = await requestAsUser(
      app,
      "POST",
      "/orders/assign-and-run",
      { sourceIds: [161] },
    );

    expect(res.status).toBe(200);
    expect(deps.runEtl).toHaveBeenCalledWith(161, {
      moduleCode: "orders",
    });
    expect(deps.ensureDefaultModuleCharts).not.toHaveBeenCalled();
  });

  test("requires authentication but not administrator privileges", async () => {
    const app = createModuleBuilderRoutes(fakeBuilderDeps());
    const res = await app.request("/inspect-sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceIds: [161] }),
    });

    expect(res.status).toBe(401);
  });

  test("requires administrator privileges for shared module mutations", async () => {
    const deps = fakeBuilderDeps();
    const app = createModuleBuilderRoutes(deps);

    const responses = await Promise.all([
      requestAsUser(app, "PATCH", "/pinduoduo_sales", {}),
      requestAsUser(app, "POST", "/pinduoduo_sales/versions/1/restore"),
      requestAsUser(app, "POST", "/pinduoduo_sales/archive"),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403]);
    expect(deps.store.update).not.toHaveBeenCalled();
    expect(deps.store.restore).not.toHaveBeenCalled();
    expect(deps.store.archive).not.toHaveBeenCalled();
  });
});
