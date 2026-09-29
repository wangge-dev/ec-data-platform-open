import { afterEach, describe, expect, test } from "vitest";
import {
  configureModuleLoader,
  getModule,
  invalidateModuleCache,
  loadModules,
  type LoadedModule,
} from "../src/modules/loader.js";
import { runDefaultTransform } from "../src/modules/default-transform.js";
import type { ModuleDef } from "../src/modules/schema.js";
import {
  createAndRunUserModule,
  type IdempotencyClaim,
} from "../src/services/module-builder.js";
import {
  createModuleConfigStore,
  type ModuleConfigPersistenceAdapter,
  type StoredModuleConfig,
} from "../src/services/module-config-store.js";
import { inspectModuleSources } from "../src/services/module-source-inspector.js";
import {
  ensureDefaultModuleCharts,
  type DefaultModuleChartDeps,
} from "../src/services/default-module-charts.js";

type SourceColumn = { raw: string; name: string };
type SourceRow = Record<string, unknown>;
type SyntheticSource = {
  id: number;
  fileName: string;
  columns: SourceColumn[];
  rows: SourceRow[];
};

type StoredVersion = {
  moduleCode: string;
  version: number;
  config: ModuleDef;
  createdBy: number;
  createdAt: string;
};

type StoredDecision = {
  moduleCode: string;
  sourceField: string;
  decision: "add" | "alias" | "ignore";
  targetField?: string;
  dataType?: "text" | "int" | "numeric" | "timestamp" | "date" | "boolean";
  createdBy: number;
};

const clone = <T>(value: T): T => structuredClone(value);

function memoryConfigAdapter(): ModuleConfigPersistenceAdapter {
  let modules = new Map<string, StoredModuleConfig>();
  let versions: StoredVersion[] = [];
  let decisions = new Map<string, StoredDecision>();

  const adapter: ModuleConfigPersistenceAdapter = {
    async transaction(work) {
      const savedModules = clone(modules);
      const savedVersions = clone(versions);
      const savedDecisions = clone(decisions);
      try {
        return await work(adapter);
      } catch (error) {
        modules = savedModules;
        versions = savedVersions;
        decisions = savedDecisions;
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
      return clone(modules.get(code) ?? null);
    },
    async insertCurrent(module) {
      if (modules.has(module.code)) throw new Error(`duplicate ${module.code}`);
      modules.set(module.code, clone(module));
      return clone(module);
    },
    async updateCurrent(code, update) {
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
      versions.push({
        ...clone(version),
        createdAt: new Date(versions.length + 1).toISOString(),
      });
    },
    async listVersionRows(code) {
      return versions
        .filter((version) => version.moduleCode === code)
        .map(clone);
    },
    async findVersion(code, version) {
      return clone(
        versions.find(
          (candidate) =>
            candidate.moduleCode === code && candidate.version === version,
        ) ?? null,
      );
    },
    async archiveCurrent(code, version) {
      const current = modules.get(code);
      if (!current) return null;
      const archived = {
        ...current,
        version,
        status: "archived" as const,
      };
      modules.set(code, archived);
      return clone(archived);
    },
    async upsertDecision(decision) {
      decisions.set(
        `${decision.moduleCode}:${decision.sourceField}`,
        clone(decision),
      );
    },
    async listDecisionRows(code) {
      return [...decisions.values()]
        .filter((decision) => decision.moduleCode === code)
        .map(clone);
    },
  };
  return adapter;
}

const sourceColumns: SourceColumn[] = [
  { raw: "支付时间", name: "支付时间" },
  { raw: "商家实收金额(元)", name: "商家实收金额_元_" },
  { raw: "商品数量(件)", name: "商品数量_件_" },
  { raw: "商品id", name: "商品id" },
  { raw: "订单号", name: "订单号" },
  { raw: "订单状态", name: "订单状态" },
  { raw: "商家编码-规格维度", name: "商家编码_规格维度" },
];

function syntheticRows(): SourceRow[] {
  return Array.from({ length: 1_062 }, (_, index) => {
    const included = index < 940;
    const status = index < 496
      ? "已发货，待收货"
      : index < 940
        ? "已收货"
        : index < 1_004
          ? "未发货，退款成功"
          : index < 1_032
            ? "已发货，退款成功"
            : index < 1_059
              ? "已取消"
              : "已收货，退款成功";
    return {
      支付时间: `2026-07-${String((index % 16) + 1).padStart(2, "0")} 12:00:00`,
      商家实收金额_元_: included
        ? index === 939
          ? "2166.18"
          : "50.00"
        : "0.00",
      商品数量_件_: included && index < 6 ? "2" : "1",
      商品id: `SYNTHETIC-PRODUCT-${String(index % 10 + 1).padStart(4, "0")}`,
      订单号: `SYNTHETIC-ORDER-${String(index + 1).padStart(6, "0")}`,
      订单状态: status,
      商家编码_规格维度:
        `SYNTHETIC-SKU-${String(index % 12 + 1).padStart(4, "0")}`,
    };
  });
}

function syntheticSources(): Map<number, SyntheticSource> {
  const rows = syntheticRows();
  return new Map([
    [
      161,
      {
        id: 161,
        fileName:
          "00000000000000000000000000000000orders_export2026-07-16-13-10-47.csv",
        columns: clone(sourceColumns),
        rows: rows.slice(0, 531),
      },
    ],
    [
      162,
      {
        id: 162,
        fileName:
          "11111111111111111111111111111111orders_export2026-07-16-13-11-18.csv",
        columns: clone(sourceColumns),
        rows: rows.slice(531),
      },
    ],
  ]);
}

function sourceTableName(query: string): string | null {
  return query.match(/"(?:user_data|public)"\."(uf_\d+)"/)?.[1] ?? null;
}

function outputTableName(query: string): string | null {
  return query.match(
    /"(?:user_data|public)"\."(unified_[a-z0-9_]+)"/,
  )?.[1] ?? null;
}

function memorySql(sources: Map<number, SyntheticSource>) {
  const existingTables = new Set(
    [...sources.keys()].map((sourceId) => `uf_${sourceId}`),
  );
  const outputTables = new Map<string, SourceRow[]>();

  const unsafe = async (query: string, parameters: unknown[] = []) => {
    const normalized = query.replace(/\s+/g, " ").trim();

    if (normalized.startsWith("SELECT pg_advisory_xact_lock")) return [];

    if (normalized.includes("FROM public.data_sources")) {
      const sourceIds = parameters[0] as number[];
      return sourceIds.flatMap((sourceId) => {
        const source = sources.get(sourceId);
        return source
          ? [{
              id: source.id,
              type: "file",
              config: {
                columns: clone(source.columns),
                originalFileName: source.fileName,
                rowCount: source.rows.length,
              },
            }]
          : [];
      });
    }
    if (normalized.includes("FROM information_schema.tables")) {
      const [, tableName] = parameters as string[];
      return existingTables.has(tableName) ? [{ exists: 1 }] : [];
    }
    if (normalized.includes("GROUP BY") && normalized.includes(" AS value")) {
      const table = sourceTableName(normalized);
      const source = table
        ? sources.get(Number(table.replace("uf_", "")))
        : undefined;
      const counts = new Map<string, number>();
      for (const row of source?.rows ?? []) {
        const value = String(row.订单状态 ?? "").trim();
        if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      return [...counts.entries()]
        .map(([value, rows]) => ({ value, rows }))
        .sort((left, right) => right.rows - left.rows);
    }
    if (
      normalized.startsWith("SELECT ") &&
      normalized.includes(" ORDER BY id LIMIT 5")
    ) {
      const table = sourceTableName(normalized);
      const source = table
        ? sources.get(Number(table.replace("uf_", "")))
        : undefined;
      return clone(source?.rows.slice(0, 5) ?? []);
    }
    if (normalized.startsWith("SELECT * FROM")) {
      const table = sourceTableName(normalized);
      const source = table
        ? sources.get(Number(table.replace("uf_", "")))
        : undefined;
      return clone(source?.rows ?? []);
    }
    if (normalized.startsWith("CREATE TABLE IF NOT EXISTS")) {
      const table = outputTableName(normalized);
      if (table) {
        existingTables.add(table);
        outputTables.set(table, outputTables.get(table) ?? []);
      }
      return [];
    }
    if (normalized.startsWith("ALTER TABLE")) return [];
    if (normalized.startsWith("DELETE FROM")) {
      const table = outputTableName(normalized)!;
      outputTables.set(
        table,
        (outputTables.get(table) ?? []).filter(
          (row) => row._source_id !== parameters[0],
        ),
      );
      return [];
    }
    if (normalized.startsWith("INSERT INTO")) {
      const table = outputTableName(normalized)!;
      const columnList =
        normalized.match(/INSERT INTO .*? \(([^)]+)\) VALUES/)?.[1] ?? "";
      const columns = [...columnList.matchAll(/"([^"]+)"/g)].map(
        (match) => match[1],
      );
      const rows = outputTables.get(table) ?? [];
      for (
        let offset = 0;
        offset < parameters.length;
        offset += columns.length
      ) {
        rows.push(
          Object.fromEntries(
            columns.map((column, index) => [
              column,
              parameters[offset + index],
            ]),
          ),
        );
      }
      outputTables.set(table, rows);
      return [];
    }
    if (normalized.startsWith("SELECT COUNT(*)::int AS cnt")) {
      return [{ cnt: 0 }];
    }
    throw new Error(`Unexpected SQL in acceptance test: ${normalized}`);
  };

  return {
    unsafe,
    outputRows(table: string) {
      return clone(outputTables.get(table) ?? []);
    },
  };
}

function memoryCharts(): DefaultModuleChartDeps & {
  charts: Array<{ moduleCode: string; chartType: string }>;
} {
  const settings = new Map<string, string>();
  const charts: Array<{ moduleCode: string; chartType: string }> = [];
  let nextDatasetId = 1;
  const deps: DefaultModuleChartDeps & {
    charts: Array<{ moduleCode: string; chartType: string }>;
  } = {
    charts,
    async transaction(work) {
      return work(deps);
    },
    async lock() {},
    async getSetting(key) {
      return settings.get(key) ?? null;
    },
    async setSetting(key, value) {
      settings.set(key, value);
    },
    async insertDataset() {
      return nextDatasetId++;
    },
    async insertChart(input) {
      charts.push({
        moduleCode: input.moduleCode,
        chartType: input.chartType,
      });
    },
  };
  return deps;
}

afterEach(() => {
  configureModuleLoader({ listStoredModules: async () => [] });
  invalidateModuleCache();
});

describe("self-service module acceptance", () => {
  test("inspects, creates, maps, processes, charts, persists and reloads a module", async () => {
    const sources = syntheticSources();
    const sql = memorySql(sources);
    const store = createModuleConfigStore(memoryConfigAdapter());
    const chartDeps = memoryCharts();
    const idempotency = new Map<string, IdempotencyClaim>();
    const assignments = new Map<number, string>();
    let defaultCharts = 0;

    configureModuleLoader({
      listStoredModules: () => store.listActive(),
    });

    const inspection = await inspectModuleSources(
      [161, 162],
      { sql },
      {
        includeStatusValues: true,
        statusSource: "订单状态",
      },
    );
    expect(inspection).toMatchObject({
      compatible: true,
      headers: [
        "支付时间",
        "商家实收金额(元)",
        "商品数量(件)",
        "商品id",
        "订单号",
        "订单状态",
        "商家编码-规格维度",
      ],
      filenamePhrase: "orders_export",
      statusValues: [
        { value: "已发货，待收货", rows: 496 },
        { value: "已收货", rows: 444 },
        { value: "未发货，退款成功", rows: 64 },
        { value: "已发货，退款成功", rows: 28 },
        { value: "已取消", rows: 27 },
        { value: "已收货，退款成功", rows: 3 },
      ],
    });

    const accepted = await createAndRunUserModule(
      {
        name: "拼多多销售",
        category: "shop_ops",
        description: "拼多多销售数据",
        sourceIds: [161, 162],
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
            source: "商家实收金额(元)",
            label: "商家实收金额",
            type: "numeric",
            required: true,
          },
          {
            semanticRole: "quantity",
            source: "商品数量(件)",
            label: "商品数量",
            type: "int",
            required: true,
          },
          {
            semanticRole: "product_id",
            source: "商品id",
            label: "商品id",
            type: "text",
            required: true,
          },
          {
            semanticRole: "order_id",
            source: "订单号",
            label: "订单号",
            type: "text",
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
            semanticRole: "sku",
            source: "商家编码-规格维度",
            label: "商家编码-规格维度",
            type: "text",
            required: false,
          },
        ],
        additionalFields: [],
        inclusion: {
          statusSource: "订单状态",
          includedValues: ["已发货，待收货", "已收货"],
        },
        idempotencyKey: "synthetic-pinduoduo-acceptance-v1", // gitleaks:allow -- deterministic test key, not a credential
      },
      7,
      {
        store,
        inspectSources: (sourceIds, options) =>
          inspectModuleSources(sourceIds, { sql }, options),
        async assignSource(sourceId, moduleCode) {
          assignments.set(sourceId, moduleCode);
        },
        async runEtl(sourceId, options) {
          const module = await getModule(options.moduleCode);
          const source = sources.get(sourceId);
          expect(module).toBeDefined();
          expect(source).toBeDefined();
          return runDefaultTransform({
            module: module as LoadedModule,
            platform: "generic",
            rawFileName: source!.fileName,
            sql,
            extra: {
              sourceId,
              platformName: "通用",
              sourceColumns: source!.columns,
            },
          });
        },
        async ensureDefaultModuleCharts(module) {
          const result = await ensureDefaultModuleCharts(module, chartDeps);
          defaultCharts += result.createdCharts;
          return result;
        },
        async insertIdempotencyClaim(key, claim) {
          if (idempotency.has(key)) return false;
          idempotency.set(key, clone(claim));
          return true;
        },
        async readIdempotencyClaim(key) {
          return clone(idempotency.get(key) ?? null);
        },
        async replaceIdempotencyClaim(key, expectedOwnerToken, claim) {
          const current = idempotency.get(key);
          if (!current || current.ownerToken !== expectedOwnerToken) {
            return false;
          }
          idempotency.set(key, clone(claim));
          return true;
        },
        async renewIdempotencyClaim(key, expectedOwnerToken, leaseDurationMs) {
          const current = idempotency.get(key);
          if (
            !current ||
            current.state !== "pending" ||
            current.ownerToken !== expectedOwnerToken
          ) {
            return null;
          }
          const renewed = {
            ...current,
            leaseExpiresAt: Date.now() + leaseDurationMs,
          };
          idempotency.set(key, renewed);
          return clone(renewed);
        },
        loadModules,
        invalidateModuleCache,
        idempotencyHeartbeatMs: 1_000_000,
      },
    );

    const output = sql.outputRows("unified_pinduoduo_sales");
    const included = output.filter((row) => row._included === true);
    const reloaded = await getModule("pinduoduo_sales");
    const result = {
      sourceRows: accepted.result.files.reduce(
        (total, file) => total + file.total,
        0,
      ),
      includedRows: included.length,
      includedAmount: included
        .reduce((total, row) => total + Number(row.amount), 0)
        .toFixed(2),
      includedQuantity: included
        .reduce((total, row) => total + Number(row.quantity), 0)
        .toFixed(0),
      moduleCode: accepted.result.moduleCode,
      defaultCharts,
    };

    expect(result.sourceRows).toBe(1_062);
    expect(result.includedRows).toBe(940);
    expect(result.includedAmount).toBe("49116.18");
    expect(result.includedQuantity).toBe("946");
    expect(result.moduleCode).toBe("pinduoduo_sales");
    expect(result.defaultCharts).toBe(2);
    expect(assignments).toEqual(
      new Map([
        [161, "pinduoduo_sales"],
        [162, "pinduoduo_sales"],
      ]),
    );
    expect(output).toHaveLength(1_062);
    expect(
      output.every(
        (row) =>
          String(row.product_id).startsWith("SYNTHETIC-PRODUCT-") &&
          String(row.order_id).startsWith("SYNTHETIC-ORDER-") &&
          String(row.sku).startsWith("SYNTHETIC-SKU-"),
      ),
    ).toBe(true);
    expect(chartDeps.charts.map((chart) => chart.chartType).sort()).toEqual([
      "bar",
      "line",
    ]);
    expect(reloaded).toMatchObject({
      code: "pinduoduo_sales",
      origin: "user",
      version: 1,
    });
    expect(await store.listVersions("pinduoduo_sales")).toHaveLength(1);
  });
});
