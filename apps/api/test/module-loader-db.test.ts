import { afterEach, describe, expect, test } from "vitest";
import {
  configureModuleLoader,
  invalidateModuleCache,
  loadModules,
} from "../src/modules/loader.js";
import {
  validateModuleConfig,
  type ModuleDef,
} from "../src/modules/schema.js";
import type { StoredModuleConfig } from "../src/services/module-config-store.js";
import type { ModuleConfigPersistenceAdapter } from "../src/services/module-config-store.js";

const clone = <T>(value: T): T => structuredClone(value);

function pinduoduoModule(): ModuleDef {
  return {
    code: "pinduoduo_sales",
    name: "拼多多销售",
    category: "shop_ops",
    description: "拼多多销售数据",
    columns: [
      {
        name: "paid_at",
        source: "支付时间",
        type: "timestamp",
        required: true,
        computed: false,
        semanticRole: "time",
      },
      {
        name: "amount",
        source: "支付金额",
        type: "numeric",
        required: true,
        computed: false,
        semanticRole: "amount",
      },
      {
        name: "status",
        source: "订单状态",
        type: "text",
        required: true,
        computed: false,
        semanticRole: "status",
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
    timeKey: "paid_at",
    inclusionRule: {
      field: "status",
      includedValues: ["已发货", "已收货"],
    },
    usages: ["summary"],
    enabled: true,
    hasTransform: false,
    isDict: false,
  };
}

function storedPinduoduoModule(): StoredModuleConfig {
  const config = pinduoduoModule();
  return {
    code: config.code,
    name: config.name,
    category: config.category ?? null,
    description: config.description,
    config,
    version: 3,
    origin: "user",
    status: "active",
    createdBy: 7,
  };
}

function moduleConfigAdapter(
  storedModules: StoredModuleConfig[],
): ModuleConfigPersistenceAdapter {
  const adapter: ModuleConfigPersistenceAdapter = {
    async transaction(work) {
      return work(adapter);
    },
    async lockModule() {},
    async listActiveRows() {
      return clone(storedModules);
    },
    async findCurrent() {
      return null;
    },
    async insertCurrent() {
      throw new Error("not used");
    },
    async updateCurrent() {
      return null;
    },
    async insertVersion() {},
    async listVersionRows() {
      return [];
    },
    async findVersion() {
      return null;
    },
    async archiveCurrent() {
      return null;
    },
    async upsertDecision() {},
  };
  return adapter;
}

afterEach(() => {
  configureModuleLoader({ listStoredModules: async () => [] });
  invalidateModuleCache();
});

describe("database-backed module loader", () => {
  test("production wiring loads stored modules through the real config store", async () => {
    const { configureRuntimeModuleLoader } = await import(
      "../src/modules/runtime-loader.js"
    );
    configureRuntimeModuleLoader(
      moduleConfigAdapter([storedPinduoduoModule()]),
    );

    const modules = await loadModules(true);

    expect(
      modules.find((module) => module.code === "pinduoduo_sales"),
    ).toMatchObject({
      origin: "user",
      version: 3,
    });
  });

  test("loads a validated database module beside built-ins", async () => {
    configureModuleLoader({
      listStoredModules: async () => [storedPinduoduoModule()],
    });

    const modules = await loadModules(true);

    expect(modules.find((module) => module.code === "orders")).toMatchObject({
      origin: "builtin",
    });
    expect(
      modules.find((module) => module.code === "pinduoduo_sales"),
    ).toMatchObject({
      origin: "user",
      version: 3,
      configurable: true,
      hasTransform: false,
      transform: undefined,
    });
  });

  test("ignores retired module configs while preserving other user modules", async () => {
    const retiredSales = storedPinduoduoModule();
    retiredSales.code = "shopee_sales";
    retiredSales.config.code = "shopee_sales";
    retiredSales.origin = "builtin_overlay";
    const retiredAds = clone(retiredSales);
    retiredAds.code = "shopee_ads";
    retiredAds.config.code = "shopee_ads";

    configureModuleLoader({
      listStoredModules: async () => [
        retiredSales,
        retiredAds,
        storedPinduoduoModule(),
      ],
    });

    const modules = await loadModules(true);

    expect(modules.some((module) => module.code === "shopee_sales")).toBe(
      false,
    );
    expect(modules.some((module) => module.code === "shopee_ads")).toBe(false);
    expect(
      modules.find((module) => module.code === "pinduoduo_sales"),
    ).toMatchObject({
      origin: "user",
      version: 3,
    });
  });

  test("a database module cannot override a built-in code", async () => {
    configureModuleLoader({
      listStoredModules: async () => [
        { ...storedPinduoduoModule(), code: "orders" },
      ],
    });

    await expect(loadModules(true)).rejects.toThrow(
      "不能覆盖内置模块 orders",
    );
  });

  test("a user module cannot declare a transform hook", async () => {
    const stored = storedPinduoduoModule();
    stored.config.hasTransform = true;
    configureModuleLoader({ listStoredModules: async () => [stored] });

    await expect(loadModules(true)).rejects.toThrow(
      "用户模块 pinduoduo_sales 不能加载 transform",
    );
  });

  test("applies a stored built-in overlay without discarding its transform", async () => {
    configureModuleLoader({ listStoredModules: async () => [] });
    const original = await loadModules(true);
    const orders = original.find((module) => module.code === "orders");
    expect(orders?.transform).toBeTypeOf("function");

    const { transform: _transform, origin: _origin, version: _version,
      configurable: _configurable, ...config } = orders!;
    const overlayConfig = clone(config);
    overlayConfig.platforms[0].filePattern = "new-order-export";
    const overlay: StoredModuleConfig = {
      code: overlayConfig.code,
      name: overlayConfig.name,
      category: overlayConfig.category ?? null,
      description: overlayConfig.description,
      config: overlayConfig,
      version: 4,
      origin: "builtin_overlay",
      status: "active",
      createdBy: 7,
    };
    configureModuleLoader({ listStoredModules: async () => [overlay] });

    const reloaded = await loadModules(true);
    const reloadedOrders = reloaded.find((module) => module.code === "orders");

    expect(reloadedOrders).toMatchObject({
      origin: "builtin",
      version: 4,
      configurable: true,
    });
    expect(reloadedOrders?.platforms[0].filePattern).toBe("new-order-export");
    expect(reloadedOrders?.transform).toBe(orders?.transform);
  });

  test("configureModuleLoader invalidates a previously populated cache", async () => {
    configureModuleLoader({ listStoredModules: async () => [] });
    expect(
      (await loadModules(true)).some(
        (module) => module.code === "pinduoduo_sales",
      ),
    ).toBe(false);

    configureModuleLoader({
      listStoredModules: async () => [storedPinduoduoModule()],
    });

    expect(
      (await loadModules()).some(
        (module) => module.code === "pinduoduo_sales",
      ),
    ).toBe(true);
  });
});

describe("module schema semantic validation", () => {
  test("validates semantic role and inclusion rule target fields", () => {
    const module = pinduoduoModule();
    module.inclusionRule!.field = "missing_status";

    expect(() => validateModuleConfig(module)).toThrow(
      "inclusionRule.field 必须引用 columns",
    );
  });

  test("validates timeKey against declared columns", () => {
    const module = pinduoduoModule();
    module.timeKey = "missing_time";

    expect(() => validateModuleConfig(module)).toThrow(
      "timeKey 必须引用 columns",
    );
  });

  test("rejects an empty timeKey when the field is present", () => {
    const module = pinduoduoModule();
    module.timeKey = "";

    expect(() => validateModuleConfig(module)).toThrow(
      "timeKey 不能为空",
    );
  });

  test("requires non-empty inclusion values", () => {
    const module = pinduoduoModule();
    module.inclusionRule!.includedValues = ["已发货", "  "];

    expect(() => validateModuleConfig(module)).toThrow(
      "inclusionRule.includedValues 不能包含空值",
    );
  });

  test("requires at least one inclusion value", () => {
    const module = pinduoduoModule();
    module.inclusionRule!.includedValues = [];

    expect(() => validateModuleConfig(module)).toThrow(
      "inclusionRule.includedValues 不能为空",
    );
  });

  test("semantic roles are unique except for dimension", () => {
    const duplicateAmount = pinduoduoModule();
    duplicateAmount.columns[2].semanticRole = "amount";
    expect(() => validateModuleConfig(duplicateAmount)).toThrow(
      "semanticRole 除 dimension 外不能重复",
    );

    const repeatedDimension = pinduoduoModule();
    repeatedDimension.columns[0].semanticRole = "dimension";
    repeatedDimension.columns[1].semanticRole = "dimension";
    expect(() => validateModuleConfig(repeatedDimension)).not.toThrow();
  });
});
