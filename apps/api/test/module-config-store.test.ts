import { describe, expect, test } from "vitest";
import { getModule } from "../src/modules/loader.js";
import type { ModuleDef } from "../src/modules/schema.js";
import {
  createModuleConfigStore,
  type ModuleConfigPersistenceAdapter,
  type StoredModuleConfig,
} from "../src/services/module-config-store.js";
import {
  FRONT_PROFIT_STANDARD_HEADERS,
  FrontProfitModuleContractDowngradeError,
} from "../src/services/front-profit-standard.js";
import { buildVerticalSolutionManifest } from "../src/services/vertical-solution-manifest.js";

type VersionRecord = {
  moduleCode: string;
  version: number;
  config: ModuleDef;
  createdBy: number;
  createdAt: string;
};

type DecisionRecord = {
  moduleCode: string;
  sourceField: string;
  decision: "add" | "alias" | "ignore";
  targetField?: string;
  dataType?: "text" | "int" | "numeric" | "timestamp" | "date" | "boolean";
  label?: string;
  createdBy: number;
};

type MemoryAdapter = ModuleConfigPersistenceAdapter & {
  transactionCount: number;
  decisions: Map<string, DecisionRecord>;
  failNext(point: FailurePoint): void;
};

type FailurePoint =
  | "insertCurrent"
  | "updateCurrent"
  | "insertVersion"
  | "upsertDecision";

const clone = <T>(value: T): T => structuredClone(value);

function createMemoryModuleConfigAdapter(): MemoryAdapter {
  let modules = new Map<string, StoredModuleConfig>();
  let versions: VersionRecord[] = [];
  const decisions = new Map<string, DecisionRecord>();
  const failures = new Set<FailurePoint>();
  const maybeFail = (point: FailurePoint) => {
    if (!failures.delete(point)) return;
    throw new Error(`injected ${point} failure`);
  };

  const adapter: MemoryAdapter = {
    transactionCount: 0,
    decisions,
    failNext(point) {
      failures.add(point);
    },
    async transaction(work) {
      adapter.transactionCount += 1;
      const savedModules = clone(modules);
      const savedVersions = clone(versions);
      const savedDecisions = clone(decisions);
      try {
        return await work(adapter);
      } catch (error) {
        modules = savedModules;
        versions = savedVersions;
        decisions.clear();
        for (const [key, value] of savedDecisions) decisions.set(key, value);
        throw error;
      }
    },
    async lockModule() {},
    async listActiveRows() {
      return [...modules.values()]
        .filter((module) => module.status === "active")
        .map(clone);
    },
    async findCurrent(code) {
      const module = modules.get(code);
      return module ? clone(module) : null;
    },
    async insertCurrent(module) {
      maybeFail("insertCurrent");
      if (modules.has(module.code)) throw new Error(`duplicate module code: ${module.code}`);
      modules.set(module.code, clone(module));
      return clone(module);
    },
    async updateCurrent(code, update) {
      maybeFail("updateCurrent");
      const current = modules.get(code);
      if (!current) return null;
      const updated = { ...current, ...clone(update) };
      modules.set(code, updated);
      return clone(updated);
    },
    async updateCurrentIfVersion(code, expectedVersion, update) {
      const current = modules.get(code);
      if (!current || current.version !== expectedVersion) return null;
      const updated = { ...current, ...clone(update) };
      modules.set(code, updated);
      return clone(updated);
    },
    async insertVersion(version) {
      maybeFail("insertVersion");
      if (
        versions.some(
          (existing) =>
            existing.moduleCode === version.moduleCode &&
            existing.version === version.version,
        )
      ) {
        throw new Error(`duplicate version: ${version.moduleCode}@${version.version}`);
      }
      versions.push({
        ...clone(version),
        createdAt: new Date(versions.length + 1).toISOString(),
      });
    },
    async listVersionRows(code) {
      return versions
        .filter((version) => version.moduleCode === code)
        .sort((left, right) => left.version - right.version)
        .map(clone);
    },
    async findVersion(code, version) {
      const found = versions.find(
        (candidate) =>
          candidate.moduleCode === code && candidate.version === version,
      );
      return found ? clone(found) : null;
    },
    async archiveCurrent(code, version) {
      const current = modules.get(code);
      if (!current) return null;
      const archived = { ...current, status: "archived" as const, version };
      modules.set(code, archived);
      return clone(archived);
    },
    async upsertDecision(record) {
      maybeFail("upsertDecision");
      decisions.set(`${record.moduleCode}:${record.sourceField}`, clone(record));
    },
    async listDecisionRows(code) {
      return [...decisions.values()]
        .filter((decision) => decision.moduleCode === code)
        .map(clone);
    },
  };

  return adapter;
}

function sampleUserModule(): ModuleDef {
  return {
    code: "pinduoduo_sales",
    name: "拼多多销售",
    category: "shop_ops",
    description: "拼多多销售数据",
    columns: [
      {
        name: "amount",
        source: "支付金额",
        type: "numeric",
        required: true,
        computed: false,
      },
    ],
    platforms: [
      {
        code: "pinduoduo",
        name: "拼多多",
        filePattern: "订单明细",
        patternFlags: "i",
        enabled: true,
      },
    ],
    usages: ["summary"],
    enabled: true,
    hasTransform: false,
    isDict: false,
  };
}

function changedUserModule(): ModuleDef {
  const changed = sampleUserModule();
  changed.description = "拼多多销售数据（已修改）";
  changed.platforms[0].filePattern = "订单明细导出";
  return changed;
}

function solutionModule(code = "pinduoduo_sales"): ModuleDef {
  const module = sampleUserModule();
  module.code = code;
  module.name = `${code} module`;
  module.semanticModel = {
    schemaVersion: "semantic-manifest/v1",
    id: `${code}.analysis`,
    version: 1,
    dimensions: [{
      id: `${code}.platform`,
      label: "平台",
      field: "platform",
      kind: "categorical",
    }],
    metrics: [{
      id: `${code}.amount`,
      label: "金额",
      aggregation: "sum",
      field: "amount",
      unit: "currency",
      additiveAcrossTime: true,
    }],
  };
  return module;
}

function solutionManifest(version: number, modules = [solutionModule()]) {
  return buildVerticalSolutionManifest({
    id: "customer.ops",
    version,
    label: "客户经营方案",
    modules,
  });
}

function protectedProfitModule(): ModuleDef {
  const module = sampleUserModule();
  module.name = "synthetic protected profit";
  module.dataContract = "front-profit-standard/v1";
  module.columns = FRONT_PROFIT_STANDARD_HEADERS.map((source, index) => ({
    name: `field_${index + 1}`,
    source,
    type: "text",
    required: false,
    computed: false,
  }));
  return module;
}

async function builtinOrdersConfig(): Promise<ModuleDef> {
  const builtin = await getModule("orders");
  expect(builtin).toBeDefined();
  const { transform: _transform, ...config } = builtin!;
  return clone(config);
}

describe("module config store", () => {
  test("create stores version one and an immutable snapshot", async () => {
    const adapter = createMemoryModuleConfigAdapter();
    const store = createModuleConfigStore(adapter);
    const input = sampleUserModule();
    const saved = await store.create({
      config: input,
      actorId: 7,
      origin: "user",
    });

    input.description = "mutated after save";

    expect(saved.version).toBe(1);
    expect(adapter.transactionCount).toBe(1);
    expect(await store.listVersions(saved.code)).toMatchObject([
      { version: 1, config: sampleUserModule() },
    ]);
  });

  test("createMany installs a solution atomically in one transaction", async () => {
    const adapter = createMemoryModuleConfigAdapter();
    const store = createModuleConfigStore(adapter);
    const second = sampleUserModule();
    second.code = "channel_sales";
    second.name = "渠道销售";

    const saved = await store.createMany([
      { config: sampleUserModule(), actorId: 7, origin: "user" },
      { config: second, actorId: 7, origin: "user" },
    ]);

    expect(adapter.transactionCount).toBe(1);
    expect(saved.map((module) => module.code)).toEqual([
      "pinduoduo_sales",
      "channel_sales",
    ]);
    expect(await store.listVersions("pinduoduo_sales")).toHaveLength(1);
    expect(await store.listVersions("channel_sales")).toHaveLength(1);
  });

  test("solution apply records ownership, upgrades atomically, and rolls back as a new version", async () => {
    const adapter = createMemoryModuleConfigAdapter();
    const store = createModuleConfigStore(adapter);
    const installed = await store.applySolution({
      manifest: solutionManifest(1),
      actorId: 7,
      expectedModuleVersions: [],
    });

    expect(installed.plan.operation).toBe("install");
    expect(installed.modules[0]).toMatchObject({
      version: 1,
      config: {
        solutionBinding: {
          schemaVersion: "solution-binding/v1",
          solutionId: "customer.ops",
          solutionVersion: 1,
        },
      },
    });

    const changed = solutionModule();
    changed.description = "第二版只调整非语义配置";
    const upgraded = await store.applySolution({
      manifest: solutionManifest(2, [changed]),
      actorId: 8,
      expectedModuleVersions: [{ code: changed.code, version: 1 }],
    });
    expect(upgraded.plan).toMatchObject({
      operation: "upgrade",
      currentSolutionVersion: 1,
    });
    expect(upgraded.modules[0]).toMatchObject({
      version: 2,
      config: { solutionBinding: { solutionVersion: 2 } },
    });

    const rolledBack = await store.rollbackSolution({
      solutionId: "customer.ops",
      fromSolutionVersion: 2,
      toSolutionVersion: 1,
      modules: [{
        code: changed.code,
        expectedVersion: 2,
        restoreVersion: 1,
      }],
      actorId: 9,
    });
    expect(rolledBack[0]).toMatchObject({
      version: 3,
      config: { solutionBinding: { solutionVersion: 1 } },
    });
    expect((await store.listVersions(changed.code)).map((item) => item.version))
      .toEqual([1, 2, 3]);
  });

  test("solution upgrade rolls every module back when persistence fails", async () => {
    const adapter = createMemoryModuleConfigAdapter();
    const store = createModuleConfigStore(adapter);
    const first = solutionModule("solution_sales");
    const second = solutionModule("solution_refunds");
    await store.applySolution({
      manifest: solutionManifest(1, [first, second]),
      actorId: 7,
      expectedModuleVersions: [],
    });
    const changedFirst = { ...structuredClone(first), description: "v2 sales" };
    const changedSecond = { ...structuredClone(second), description: "v2 refunds" };
    adapter.failNext("insertVersion");

    await expect(store.applySolution({
      manifest: solutionManifest(2, [changedFirst, changedSecond]),
      actorId: 8,
      expectedModuleVersions: [
        { code: first.code, version: 1 },
        { code: second.code, version: 1 },
      ],
    })).rejects.toThrow("injected insertVersion failure");

    expect(await store.listActive()).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: first.code, version: 1 }),
      expect.objectContaining({ code: second.code, version: 1 }),
    ]));
  });

  test("solution upgrade rejects a stale validation version without changing modules", async () => {
    const adapter = createMemoryModuleConfigAdapter();
    const store = createModuleConfigStore(adapter);
    const module = solutionModule();
    await store.applySolution({
      manifest: solutionManifest(1, [module]),
      actorId: 7,
      expectedModuleVersions: [],
    });
    const changed = { ...structuredClone(module), description: "v2" };

    await expect(store.applySolution({
      manifest: solutionManifest(2, [changed]),
      actorId: 8,
      expectedModuleVersions: [{ code: module.code, version: 99 }],
    })).rejects.toThrow("重新校验");
    expect(await store.listActive()).toEqual([
      expect.objectContaining({ code: module.code, version: 1 }),
    ]);
  });

  test("manual edits preserve the installed fingerprint so later package upgrades detect drift", async () => {
    const adapter = createMemoryModuleConfigAdapter();
    const store = createModuleConfigStore(adapter);
    const module = solutionModule();
    await store.applySolution({
      manifest: solutionManifest(1, [module]),
      actorId: 7,
      expectedModuleVersions: [],
    });
    const customized = { ...structuredClone(module), description: "客户现场定制" };
    const updated = await store.update(module.code, customized, 8);
    expect(updated.config.solutionBinding).toMatchObject({
      solutionVersion: 1,
      moduleFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    await expect(store.applySolution({
      manifest: solutionManifest(2, [customized]),
      actorId: 9,
      expectedModuleVersions: [{ code: module.code, version: 2 }],
    })).rejects.toThrow("本地定制");
    expect((await store.listActive())[0]).toMatchObject({
      version: 2,
      description: "客户现场定制",
    });
  });

  test("createMany leaves no partial module when any code already exists", async () => {
    const adapter = createMemoryModuleConfigAdapter();
    const store = createModuleConfigStore(adapter);
    const existing = sampleUserModule();
    existing.code = "existing_sales";
    await store.create({ config: existing, actorId: 7, origin: "user" });

    await expect(store.createMany([
      { config: sampleUserModule(), actorId: 8, origin: "user" },
      { config: existing, actorId: 8, origin: "user" },
    ])).rejects.toThrow("Module config already exists: existing_sales");

    expect(await adapter.findCurrent("pinduoduo_sales")).toBeNull();
    expect(await adapter.findCurrent("existing_sales")).toMatchObject({ version: 1 });
  });

  test("update advances the active config and keeps prior versions immutable", async () => {
    const store = createModuleConfigStore(createMemoryModuleConfigAdapter());
    await store.create({ config: sampleUserModule(), actorId: 7, origin: "user" });

    const updated = await store.update("pinduoduo_sales", changedUserModule(), 8);

    expect(updated.version).toBe(2);
    expect(updated.description).toContain("已修改");
    expect(await store.listVersions("pinduoduo_sales")).toMatchObject([
      { version: 1, config: sampleUserModule() },
      { version: 2, config: changedUserModule() },
    ]);
  });

  test("restore creates a new version instead of mutating history", async () => {
    const store = createModuleConfigStore(createMemoryModuleConfigAdapter());
    await store.create({ config: sampleUserModule(), actorId: 7, origin: "user" });
    await store.update("pinduoduo_sales", changedUserModule(), 8);

    const restored = await store.restore("pinduoduo_sales", 1, 9);

    expect(restored.version).toBe(3);
    expect(restored.config).toEqual(sampleUserModule());
    expect((await store.listVersions("pinduoduo_sales")).map(({ version }) => version)).toEqual([
      1, 2, 3,
    ]);
  });

  test("rejects a side-effect computed function before persisting a user update", async () => {
    const adapter = createMemoryModuleConfigAdapter();
    const store = createModuleConfigStore(adapter);
    await store.create({ config: sampleUserModule(), actorId: 7, origin: "user" });
    const unsafe = sampleUserModule();
    unsafe.columns[0] = {
      ...unsafe.columns[0],
      computed: true,
      expression: "pg_advisory_lock(1)",
    };
    delete unsafe.columns[0].source;

    await expect(store.update("pinduoduo_sales", unsafe, 8))
      .rejects.toThrow(/表达式不安全|模块配置错误/);
    expect(await adapter.findCurrent("pinduoduo_sales")).toMatchObject({ version: 1 });
  });

  test("rejects an update that removes an established front-profit contract", async () => {
    const adapter = createMemoryModuleConfigAdapter();
    const store = createModuleConfigStore(adapter);
    await store.create({ config: protectedProfitModule(), actorId: 7, origin: "user" });

    await expect(store.update("pinduoduo_sales", sampleUserModule(), 8))
      .rejects.toBeInstanceOf(FrontProfitModuleContractDowngradeError);
    expect(await adapter.findCurrent("pinduoduo_sales")).toMatchObject({
      version: 1,
      config: protectedProfitModule(),
    });
  });

  test("rejects initial persistence of a flagged but incomplete front-profit module", async () => {
    const adapter = createMemoryModuleConfigAdapter();
    const store = createModuleConfigStore(adapter);
    const invalid = protectedProfitModule();
    invalid.columns = invalid.columns.slice(0, -1);

    await expect(store.create({ config: invalid, actorId: 7, origin: "user" }))
      .rejects.toThrow(/28/);
    expect(await adapter.findCurrent("pinduoduo_sales")).toBeNull();
  });

  test("rejects keeping the contract flag while deleting or duplicating a source column", async () => {
    const adapter = createMemoryModuleConfigAdapter();
    const store = createModuleConfigStore(adapter);
    await store.create({ config: protectedProfitModule(), actorId: 7, origin: "user" });

    const missing = protectedProfitModule();
    missing.columns = missing.columns.slice(0, -1);
    await expect(store.update("pinduoduo_sales", missing, 8)).rejects.toThrow(/28/);

    const duplicate = protectedProfitModule();
    duplicate.columns[27].source = FRONT_PROFIT_STANDARD_HEADERS[0];
    await expect(store.update("pinduoduo_sales", duplicate, 8)).rejects.toThrow(/28/);
    expect(await adapter.findCurrent("pinduoduo_sales")).toMatchObject({ version: 1 });
  });

  test("rejects restoring an older version that predates the front-profit contract", async () => {
    const adapter = createMemoryModuleConfigAdapter();
    const store = createModuleConfigStore(adapter);
    await store.create({ config: sampleUserModule(), actorId: 7, origin: "user" });
    await store.update("pinduoduo_sales", protectedProfitModule(), 8);

    await expect(store.restore("pinduoduo_sales", 1, 9))
      .rejects.toBeInstanceOf(FrontProfitModuleContractDowngradeError);
    expect(await adapter.findCurrent("pinduoduo_sales")).toMatchObject({
      version: 2,
      config: protectedProfitModule(),
    });
  });

  test("rejects schema-decision activation that would remove the front-profit contract", async () => {
    const adapter = createMemoryModuleConfigAdapter();
    const store = createModuleConfigStore(adapter);
    await store.create({ config: protectedProfitModule(), actorId: 7, origin: "user" });

    await expect(store.activateSchemaDecisions({
      code: "pinduoduo_sales",
      config: sampleUserModule(),
      decisions: [],
      actorId: 8,
      expectedVersion: 1,
    })).rejects.toBeInstanceOf(FrontProfitModuleContractDowngradeError);
    expect(await adapter.findCurrent("pinduoduo_sales")).toMatchObject({
      version: 1,
      config: protectedProfitModule(),
    });
  });

  test("archive removes a module from the active list", async () => {
    const store = createModuleConfigStore(createMemoryModuleConfigAdapter());
    await store.create({ config: sampleUserModule(), actorId: 7, origin: "user" });

    await store.archive("pinduoduo_sales", 8);

    expect(await store.listActive()).toEqual([]);
  });

  test("archive records the actor as a new immutable version", async () => {
    const adapter = createMemoryModuleConfigAdapter();
    const store = createModuleConfigStore(adapter);
    await store.create({ config: sampleUserModule(), actorId: 7, origin: "user" });

    await store.archive("pinduoduo_sales", 8);

    expect(await adapter.findCurrent("pinduoduo_sales")).toMatchObject({
      status: "archived",
      version: 2,
    });
    expect(await adapter.listVersionRows("pinduoduo_sales")).toMatchObject([
      { version: 1, createdBy: 7 },
      { version: 2, createdBy: 8, config: sampleUserModule() },
    ]);
  });

  test.each<FailurePoint>(["insertCurrent", "insertVersion"])(
    "create rolls back both records when %s fails",
    async (failurePoint) => {
      const adapter = createMemoryModuleConfigAdapter();
      const store = createModuleConfigStore(adapter);
      adapter.failNext(failurePoint);

      await expect(
        store.create({ config: sampleUserModule(), actorId: 7, origin: "user" }),
      ).rejects.toThrow(/injected/);

      expect(await adapter.findCurrent("pinduoduo_sales")).toBeNull();
      expect(await adapter.listVersionRows("pinduoduo_sales")).toEqual([]);
    },
  );

  test.each<FailurePoint>(["updateCurrent", "insertVersion"])(
    "update retains the previous current row and history when %s fails",
    async (failurePoint) => {
      const adapter = createMemoryModuleConfigAdapter();
      const store = createModuleConfigStore(adapter);
      await store.create({ config: sampleUserModule(), actorId: 7, origin: "user" });
      adapter.failNext(failurePoint);

      await expect(
        store.update("pinduoduo_sales", changedUserModule(), 8),
      ).rejects.toThrow(/injected/);

      expect(await adapter.findCurrent("pinduoduo_sales")).toMatchObject({
        version: 1,
        config: sampleUserModule(),
      });
      expect(await adapter.listVersionRows("pinduoduo_sales")).toMatchObject([
        { version: 1, config: sampleUserModule() },
      ]);
    },
  );

  test.each<FailurePoint>(["updateCurrent", "insertVersion"])(
    "restore retains the previous current row and history when %s fails",
    async (failurePoint) => {
      const adapter = createMemoryModuleConfigAdapter();
      const store = createModuleConfigStore(adapter);
      await store.create({ config: sampleUserModule(), actorId: 7, origin: "user" });
      await store.update("pinduoduo_sales", changedUserModule(), 8);
      adapter.failNext(failurePoint);

      await expect(
        store.restore("pinduoduo_sales", 1, 9),
      ).rejects.toThrow(/injected/);

      expect(await adapter.findCurrent("pinduoduo_sales")).toMatchObject({
        version: 2,
        config: changedUserModule(),
      });
      expect(await adapter.listVersionRows("pinduoduo_sales")).toMatchObject([
        { version: 1, config: sampleUserModule() },
        { version: 2, config: changedUserModule() },
      ]);
    },
  );

  test("upserts durable schema decisions by module and source field", async () => {
    const adapter = createMemoryModuleConfigAdapter();
    const store = createModuleConfigStore(adapter);

    await store.upsertSchemaDecisions(
      "pinduoduo_sales",
      [
        {
          sourceField: "商品金额",
          decision: "alias",
          targetField: "amount",
          dataType: "numeric",
        },
      ],
      7,
    );

    expect(adapter.decisions.get("pinduoduo_sales:商品金额")).toMatchObject({
      decision: "alias",
      targetField: "amount",
      dataType: "numeric",
      createdBy: 7,
    });
    expect(await store.listSchemaDecisions("pinduoduo_sales")).toEqual([
      expect.objectContaining({
        sourceField: "商品金额",
        decision: "alias",
        targetField: "amount",
      }),
    ]);
  });

  test("atomically activates candidate config and decisions with an expected version", async () => {
    const adapter = createMemoryModuleConfigAdapter();
    const store = createModuleConfigStore(adapter);
    await store.create({
      config: sampleUserModule(),
      actorId: 7,
      origin: "user",
    });

    const activated = await store.activateSchemaDecisions({
      code: "pinduoduo_sales",
      config: changedUserModule(),
      decisions: [
        {
          sourceField: "商品总额",
          decision: "alias",
          targetField: "amount",
        },
      ],
      actorId: 7,
      expectedVersion: 1,
    });

    expect(activated.version).toBe(2);
    expect(
      adapter.decisions.get("pinduoduo_sales:商品总额"),
    ).toMatchObject({ decision: "alias", targetField: "amount" });
    await expect(
      store.activateSchemaDecisions({
        code: "pinduoduo_sales",
        config: sampleUserModule(),
        decisions: [],
        actorId: 8,
        expectedVersion: 1,
      }),
    ).rejects.toThrow("模块配置已更新");
    expect((await store.listActive())[0].version).toBe(2);
  });

  test("rolls back candidate activation when decision persistence fails", async () => {
    const adapter = createMemoryModuleConfigAdapter();
    const store = createModuleConfigStore(adapter);
    await store.create({
      config: sampleUserModule(),
      actorId: 7,
      origin: "user",
    });
    adapter.failNext("upsertDecision");

    await expect(
      store.activateSchemaDecisions({
        code: "pinduoduo_sales",
        config: changedUserModule(),
        decisions: [
          { sourceField: "商品总额", decision: "ignore" },
        ],
        actorId: 7,
        expectedVersion: 1,
      }),
    ).rejects.toThrow("injected upsertDecision failure");

    expect((await store.listActive())[0]).toMatchObject({ version: 1 });
    expect(adapter.decisions.size).toBe(0);
    expect(await store.listVersions("pinduoduo_sales")).toHaveLength(1);
  });

  test("allows only file matching fields in a built-in overlay", async () => {
    const allowed = await builtinOrdersConfig();
    allowed.platforms[0].filePattern = "new-order-export";
    allowed.platforms[0].patternFlags = "iu";
    allowed.platforms[0].columnOverrides = { amount: "新金额列" };

    const store = createModuleConfigStore(createMemoryModuleConfigAdapter());
    const saved = await store.create({
      config: allowed,
      actorId: 7,
      origin: "builtin_overlay",
    });

    expect(saved.origin).toBe("builtin_overlay");
  });

  test("rejects a built-in module code submitted as a user module", async () => {
    const builtin = await builtinOrdersConfig();
    const store = createModuleConfigStore(createMemoryModuleConfigAdapter());

    await expect(
      store.create({ config: builtin, actorId: 7, origin: "user" }),
    ).rejects.toThrow(/built-in.*origin|collision/i);
  });

  test("rejects duplicate and omitted platform codes in a built-in overlay", async () => {
    const duplicate = await builtinOrdersConfig();
    duplicate.platforms[duplicate.platforms.length - 1] = clone(duplicate.platforms[0]);
    const store = createModuleConfigStore(createMemoryModuleConfigAdapter());

    await expect(
      store.create({ config: duplicate, actorId: 7, origin: "builtin_overlay" }),
    ).rejects.toThrow(/built-in overlay.*platform|duplicate/i);
  });

  test.each([
    ["columns", (module: ModuleDef) => { module.columns[0].source = "危险改列"; }],
    ["hasTransform", (module: ModuleDef) => { module.hasTransform = false; }],
    ["outputTable", (module: ModuleDef) => { module.outputTable = "unsafe_table"; }],
    ["joins", (module: ModuleDef) => { module.joins = []; }],
    ["alerts", (module: ModuleDef) => { module.alerts = []; }],
    ["schedule", (module: ModuleDef) => { module.schedule = "0 0 * * *"; }],
    ["expression", (module: ModuleDef) => {
      module.columns[0].computed = true;
      module.columns[0].expression = "DROP TABLE public.users";
      delete module.columns[0].source;
    }],
    ["platform status filter", (module: ModuleDef) => {
      module.platforms[0].statusFilter = {
        statusColumn: "状态",
        excludeStatus: ["有效"],
        refundExclude: [],
      };
    }],
  ])("rejects %s changes in a built-in overlay", async (_field, mutate) => {
    const unsafe = await builtinOrdersConfig();
    mutate(unsafe);
    const store = createModuleConfigStore(createMemoryModuleConfigAdapter());

    await expect(
      store.create({ config: unsafe, actorId: 7, origin: "builtin_overlay" }),
    ).rejects.toThrow(/built-in overlay|模块配置错误/i);
  });
});
