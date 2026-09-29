import { describe, expect, test } from "vitest";
import type { ModuleDef } from "../src/modules/schema.js";
import { FRONT_PROFIT_STANDARD_HEADERS } from "../src/services/front-profit-standard.js";
import {
  deriveFilenamePhrase,
  diffModuleSchema,
  inspectModuleSources,
  type InspectorDeps,
  type SourceInspection,
} from "../src/services/module-source-inspector.js";

function samplePinduoduoModule(): ModuleDef {
  return {
    code: "pinduoduo_sales",
    name: "拼多多销售",
    description: "拼多多订单导出",
    columns: [
      {
        name: "pay_time",
        source: "支付时间",
        type: "timestamp",
        required: true,
        computed: false,
      },
      {
        name: "amount",
        source: "支付金额",
        type: "numeric",
        required: true,
        computed: false,
      },
      {
        name: "status",
        source: "订单状态",
        type: "text",
        required: true,
        computed: false,
      },
      {
        name: "note",
        source: "备注",
        type: "text",
        required: false,
        computed: false,
      },
    ],
    platforms: [
      {
        code: "pinduoduo",
        name: "拼多多",
        filePattern: "orders_export",
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

function inspectionWithChangedHeaders(): SourceInspection {
  return {
    sourceIds: [41],
    compatible: true,
    headers: ["付款时间", "支付金额", "订单状态", "店铺名称"],
    samples: [
      {
        付款时间: "2026-07-16 13:10:47",
        支付金额: "无法解析",
        订单状态: "已发货",
        店铺名称: "测试店铺",
      },
    ],
    filenamePhrase: "orders_export",
    statusValues: [{ value: "已发货", rows: 1 }],
    inferredTypes: {
      付款时间: "timestamp",
      支付金额: "text",
      订单状态: "text",
      店铺名称: "text",
    },
    differences: [],
  };
}

describe("filename phrase derivation", () => {
  test("derives orders_export from hashed dated Pinduoduo filenames", () => {
    expect(
      deriveFilenamePhrase([
        "8d35b750da112d441c52d6146da242acorders_export2026-07-16-13-10-47.csv",
        "fca7f3d08db9c01d50adc566cb0f4c69orders_export2026-07-16-13-11-18.csv",
      ]),
    ).toBe("orders_export");
  });

  test("returns null when filenames share no stable alphabetic phrase", () => {
    expect(
      deriveFilenamePhrase([
        "8d35b750da112d441c52d6146da242acorders2026-07-16.csv",
        "fca7f3d08db9c01d50adc566cb0f4c69refunds2026-07-16.csv",
      ]),
    ).toBeNull();
  });

  test("keeps the longest phrase shared by three files when pairwise candidates tie", () => {
    expect(
      deriveFilenamePhrase([
        "alpha_beta_gamma2026.csv",
        "alpha_beta_delta_beta_gamma2026.csv",
        "beta_gamma2026.csv",
      ]),
    ).toBe("beta_gamma");
  });
});

describe("exact status source inspection", () => {
  test("derives the profit data contract only when every selected source was validated", async () => {
    const validatedConfig = {
      rowCount: 1,
      columns: FRONT_PROFIT_STANDARD_HEADERS.map((raw, index) => ({
        raw,
        name: `field_${index + 1}`,
      })),
      frontProfitValidation: {
        schemaVersion: "front-profit-standard/v1",
        businessRowCount: 1,
        warningCount: 0,
        warningCodes: [],
      },
    };
    const sourceConfigs = new Map<number, Record<string, unknown>>([
      [21, validatedConfig],
      [22, { rowCount: 1, columns: validatedConfig.columns }],
    ]);
    const deps: InspectorDeps = {
      sql: {
        async unsafe(query, parameters) {
          if (query.includes("public.data_sources")) {
            return (parameters?.[0] as number[]).map((id) => ({
              id,
              type: "file",
              config: sourceConfigs.get(id),
            }));
          }
          return [{ date: "2098-01-01" }];
        },
      },
      async resolveTableReference(tableName) {
        return `"user_data"."${tableName}"`;
      },
    };

    await expect(inspectModuleSources([21], deps)).resolves.toMatchObject({
      dataContract: "front-profit-standard/v1",
    });
    await expect(inspectModuleSources([21, 22], deps)).resolves.toMatchObject({
      dataContract: null,
    });
  });

  test("groups only the explicitly selected status header", async () => {
    const queries: string[] = [];
    const deps: InspectorDeps = {
      sql: {
        async unsafe(query) {
          queries.push(query);
          if (query.includes("public.data_sources")) {
            return [{
              id: 17,
              type: "file",
              config: {
                columns: [
                  { raw: "订单状态", name: "order_status" },
                  { raw: "售后状态", name: "after_sale_status" },
                ],
              },
            }];
          }
          if (query.includes("GROUP BY")) {
            return [{ value: "退款完成", rows: 3 }];
          }
          return [{ order_status: "已发货", after_sale_status: "退款完成" }];
        },
      },
      async resolveTableReference() {
        return '"user_data"."uf_17"';
      },
    };

    const result = await inspectModuleSources([17], deps, {
      includeStatusValues: true,
      statusSource: "售后状态",
    });
    const grouped = queries.find((query) => query.includes("GROUP BY"));

    expect(grouped).toContain('"after_sale_status"');
    expect(grouped).not.toContain('"order_status"');
    expect(result.statusValues).toEqual([{ value: "退款完成", rows: 3 }]);
  });

  test("rejects an exact status source that is not a returned header", async () => {
    let grouped = false;
    const deps: InspectorDeps = {
      sql: {
        async unsafe(query) {
          if (query.includes("public.data_sources")) {
            return [{
              id: 18,
              type: "file",
              config: {
                columns: [
                  { raw: "订单状态", name: "order_status" },
                  { raw: "售后状态", name: "after_sale_status" },
                ],
              },
            }];
          }
          if (query.includes("GROUP BY")) grouped = true;
          return [{ order_status: "已发货", after_sale_status: "无售后" }];
        },
      },
      async resolveTableReference() {
        return '"user_data"."uf_18"';
      },
    };

    await expect(
      inspectModuleSources([18], deps, {
        includeStatusValues: true,
        statusSource: "不存在的状态",
      }),
    ).rejects.toThrow("statusSource must match a returned header");
    expect(grouped).toBe(false);
  });
});

describe("module schema differences", () => {
  test("reports added renamed missing and type-changing fields", () => {
    const diff = diffModuleSchema(
      samplePinduoduoModule(),
      inspectionWithChangedHeaders(),
    );

    expect(diff.added).toEqual(
      expect.arrayContaining(["付款时间", "店铺名称"]),
    );
    expect(diff.missingRequired).toContain("支付时间");
    expect(diff.missingOptional).toContain("备注");
    expect(diff.aliasCandidates).toContainEqual(
      expect.objectContaining({
        source: "付款时间",
        target: "pay_time",
      }),
    );
    expect(diff.typeChanges).toContainEqual({
      source: "支付金额",
      target: "amount",
      label: "支付金额",
      expected: "numeric",
      required: true,
      blocking: true,
      compatibleSources: [],
      failures: 1,
      samples: ["无法解析"],
    });
  });

  test("offers only compatible added headers as replacements for blocking fields", () => {
    const inspection = inspectionWithChangedHeaders();
    inspection.headers.push("实付金额", "是否赠品");
    inspection.inferredTypes["实付金额"] = "numeric";
    inspection.inferredTypes["是否赠品"] = "boolean";
    inspection.samples[0]["实付金额"] = "29.90";
    inspection.samples[0]["是否赠品"] = "否";

    const diff = diffModuleSchema(samplePinduoduoModule(), inspection);

    expect(
      diff.missingRequiredFields?.find((field) => field.name === "pay_time"),
    ).toMatchObject({
      compatibleSources: ["付款时间"],
    });
    expect(
      diff.typeChanges.find((change) => change.target === "amount"),
    ).toMatchObject({
      blocking: true,
      compatibleSources: ["实付金额"],
    });
  });

  test("does not report a boolean type change when binary integers all convert", () => {
    const module = samplePinduoduoModule();
    module.columns = [
      {
        name: "enabled",
        source: "Enabled",
        type: "boolean",
        required: true,
        computed: false,
      },
    ];
    const inspection: SourceInspection = {
      sourceIds: [1],
      compatible: true,
      headers: ["Enabled"],
      samples: [{ Enabled: "0" }, { Enabled: "1" }],
      filenamePhrase: null,
      statusValues: [],
      inferredTypes: { Enabled: "int" },
      differences: [],
    };

    expect(diffModuleSchema(module, inspection).typeChanges).toEqual([]);
  });

  test("skips alias similarity work when the comparison budget is exceeded", () => {
    const module = samplePinduoduoModule();
    module.columns = Array.from({ length: 2 }, (_, index) => ({
      name: `target_${index}`,
      source: Array.from(
        { length: 16 },
        (_unused, alias) => `near_${index}_${alias}_official`,
      ),
      type: "text" as const,
      required: true,
      computed: false,
    }));
    const inspection: SourceInspection = {
      sourceIds: [1],
      compatible: true,
      // Every header is deliberately a high-similarity near-match. Without the
      // global comparison budget this input produces alias candidates, so an
      // empty result proves the expensive branch was skipped.
      headers: Array.from({ length: 17 }, (_, index) => `near_0_${index}_officia1`),
      samples: [],
      filenamePhrase: null,
      statusValues: [],
      inferredTypes: {},
      differences: [],
    };

    expect(diffModuleSchema(module, inspection).aliasCandidates).toEqual([]);
  });
});

describe("database-backed source inspection", () => {
  test("uses safely resolved tables, bounded samples, and structured header differences", async () => {
    const queries: Array<{ query: string; parameters?: unknown[] }> = [];
    const resolved: string[] = [];
    const sourceRows = [
      {
        id: 41,
        type: "file",
        config: {
          originalFileName:
            "8d35b750da112d441c52d6146da242acorders_export2026-07-16-13-10-47.csv",
          columns: [
            { raw: "支付时间", name: "pay_time" },
            { raw: "订单状态", name: "status" },
            { raw: "支付金额", name: "amount" },
          ],
        },
      },
      {
        id: 42,
        type: "file",
        config: {
          originalFileName:
            "fca7f3d08db9c01d50adc566cb0f4c69orders_export2026-07-16-13-11-18.csv",
          columns: [
            { raw: "付款时间", name: "paid_time" },
            { raw: "订单状态", name: "status" },
            { raw: "支付金额", name: "amount" },
            { raw: "店铺名称", name: "shop_name" },
          ],
        },
      },
    ];

    const deps: InspectorDeps = {
      sql: {
        async unsafe(query, parameters) {
          queries.push({ query, parameters });
          if (query.includes("public.data_sources")) return sourceRows;
          if (query.includes("GROUP BY") && query.includes('"uf_41"')) {
            return [{ value: "已发货", rows: 3 }];
          }
          if (query.includes("GROUP BY") && query.includes('"uf_42"')) {
            return [
              { value: "已发货", rows: 2 },
              { value: "已取消", rows: 1 },
            ];
          }
          if (query.includes('"uf_41"')) {
            return [
              {
                pay_time: "2026-07-16 13:10:47",
                status: "已发货",
                amount: "19.90",
              },
            ];
          }
          if (query.includes('"uf_42"')) {
            return [
              {
                paid_time: "2026-07-16 13:11:18",
                status: "已取消",
                amount: "20",
                shop_name: "测试店铺",
              },
            ];
          }
          throw new Error(`Unexpected query: ${query}`);
        },
      },
      async resolveTableReference(tableName) {
        resolved.push(tableName);
        return `"user_data"."${tableName}"`;
      },
    };

    const result = await inspectModuleSources([42, 41], deps, {
      includeStatusValues: true,
    });

    expect(result).toMatchObject({
      sourceIds: [42, 41],
      compatible: false,
      filenamePhrase: "orders_export",
      statusValues: [
        { value: "已发货", rows: 5 },
        { value: "已取消", rows: 1 },
      ],
    });
    expect(result.headers).toEqual(["付款时间", "订单状态", "支付金额", "店铺名称"]);
    expect(result.samples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          付款时间: "2026-07-16 13:11:18",
          店铺名称: "测试店铺",
        }),
        expect.objectContaining({ 支付时间: "2026-07-16 13:10:47" }),
      ]),
    );
    expect(result.inferredTypes).toMatchObject({
      付款时间: "timestamp",
      支付金额: "numeric",
      店铺名称: "text",
    });
    expect(result.differences).toEqual([
      {
        sourceId: 41,
        added: ["支付时间"],
        missing: ["付款时间", "店铺名称"],
      },
    ]);
    expect(resolved).toEqual(["uf_42", "uf_41"]);

    const sampleQueries = queries.filter(
      ({ query }) =>
        query.includes('"uf_') && !query.includes("GROUP BY"),
    );
    expect(sampleQueries).toHaveLength(2);
    expect(sampleQueries.every(({ query }) => /\bLIMIT\s+5\b/i.test(query))).toBe(true);
    expect(
      queries.every(({ query }) => /^\s*SELECT\b/i.test(query)),
    ).toBe(true);
  });

  test("rejects non-file sources before resolving or reading physical tables", async () => {
    let resolved = false;
    const deps: InspectorDeps = {
      sql: {
        async unsafe() {
          return [{ id: 9, type: "external_sql", config: {} }];
        },
      },
      async resolveTableReference() {
        resolved = true;
        return '"user_data"."uf_9"';
      },
    };

    await expect(inspectModuleSources([9], deps)).rejects.toThrow(
      "source 9 is not a file source",
    );
    expect(resolved).toBe(false);
  });

  test("caps grouped status SQL and returned status values", async () => {
    const queries: string[] = [];
    const deps: InspectorDeps = {
      sql: {
        async unsafe(query) {
          queries.push(query);
          if (query.includes("public.data_sources")) {
            return [{
              id: 15,
              type: "file",
              config: {
                columns: [{ raw: "Status", name: "status" }],
              },
            }];
          }
          if (query.includes("GROUP BY")) {
            return Array.from({ length: 25 }, (_, index) => ({
              value: `status-${index}`,
              rows: 25 - index,
            }));
          }
          return [{ status: "status-0" }];
        },
      },
      async resolveTableReference() {
        return '"user_data"."uf_15"';
      },
    };

    const result = await inspectModuleSources([15], deps, {
      includeStatusValues: true,
    });
    const statusQuery = queries.find((query) => query.includes("GROUP BY"));

    expect(statusQuery).toMatch(/\bLIMIT\s+20\b/i);
    expect(result.statusValues).toHaveLength(20);
  });

  test("does not query grouped status values unless explicitly requested", async () => {
    let groupedQueries = 0;
    const deps: InspectorDeps = {
      sql: {
        async unsafe(query) {
          if (query.includes("public.data_sources")) {
            return [{
              id: 16,
              type: "file",
              config: {
                columns: [{ raw: "Status", name: "status" }],
              },
            }];
          }
          if (query.includes("GROUP BY")) {
            groupedQueries += 1;
            return [{ value: "ready", rows: 1 }];
          }
          return [{ status: "ready" }];
        },
      },
      async resolveTableReference() {
        return '"user_data"."uf_16"';
      },
    };

    const result = await inspectModuleSources([16], deps);

    expect(groupedQueries).toBe(0);
    expect(result.statusValues).toEqual([]);
  });

  test("infers numeric at exactly 95 percent and ignores values after the first 100", async () => {
    const values = [
      ...Array.from({ length: 95 }, (_, index) => `${index + 0.5}`),
      ...Array.from({ length: 10 }, () => "not-a-number"),
    ];
    const sourceIds = Array.from({ length: 21 }, (_, index) => index + 1);
    const rowsBySource = new Map(
      sourceIds.map((sourceId, index) => [
        sourceId,
        values.slice(index * 5, index * 5 + 5),
      ]),
    );
    const deps: InspectorDeps = {
      sql: {
        async unsafe(query) {
          if (query.includes("public.data_sources")) {
            return sourceIds.map((id) => ({
              id,
              type: "file",
              config: {
                columns: [{ raw: "Value", name: "value" }],
              },
            }));
          }
          const sourceId = Number(query.match(/uf_(\d+)/)?.[1]);
          return (rowsBySource.get(sourceId) ?? []).map((value) => ({ value }));
        },
      },
      async resolveTableReference(tableName) {
        return `"user_data"."${tableName}"`;
      },
    };

    const result = await inspectModuleSources(sourceIds, deps);

    expect(result.samples).toHaveLength(105);
    expect(result.inferredTypes.Value).toBe("numeric");
  });

  test("falls back to text below the 95 percent inference threshold", async () => {
    const values = [
      ...Array.from({ length: 94 }, (_, index) => `${index + 0.5}`),
      ...Array.from({ length: 6 }, () => "not-a-number"),
    ];
    const sourceIds = Array.from({ length: 20 }, (_, index) => index + 1);
    const deps: InspectorDeps = {
      sql: {
        async unsafe(query) {
          if (query.includes("public.data_sources")) {
            return sourceIds.map((id) => ({
              id,
              type: "file",
              config: {
                columns: [{ raw: "Value", name: "value" }],
              },
            }));
          }
          const sourceId = Number(query.match(/uf_(\d+)/)?.[1]);
          return values
            .slice((sourceId - 1) * 5, sourceId * 5)
            .map((value) => ({ value }));
        },
      },
      async resolveTableReference(tableName) {
        return `"user_data"."${tableName}"`;
      },
    };

    const result = await inspectModuleSources(sourceIds, deps);

    expect(result.inferredTypes.Value).toBe("text");
  });

  test("rejects a requested source ID missing from data_sources before table access", async () => {
    let resolved = false;
    const deps: InspectorDeps = {
      sql: {
        async unsafe() {
          return [{
            id: 1,
            type: "file",
            config: {
              columns: [{ raw: "Value", name: "value" }],
            },
          }];
        },
      },
      async resolveTableReference() {
        resolved = true;
        return '"user_data"."uf_1"';
      },
    };

    await expect(inspectModuleSources([1, 2], deps)).rejects.toThrow(
      "file source 2 does not exist",
    );
    expect(resolved).toBe(false);
  });

  test("rejects a missing physical source table", async () => {
    const deps: InspectorDeps = {
      sql: {
        async unsafe() {
          return [{
            id: 7,
            type: "file",
            config: {
              columns: [{ raw: "Value", name: "value" }],
            },
          }];
        },
      },
      async resolveTableReference() {
        return null;
      },
    };

    await expect(inspectModuleSources([7], deps)).rejects.toThrow(
      "source table uf_7 does not exist",
    );
  });

  test.each([
    ["missing", undefined],
    ["empty", []],
    ["malformed", [{ raw: "Value" }]],
  ])("rejects %s columns metadata", async (_case, columns) => {
    const deps: InspectorDeps = {
      sql: {
        async unsafe() {
          return [{ id: 8, type: "file", config: { columns } }];
        },
      },
      async resolveTableReference() {
        return '"user_data"."uf_8"';
      },
    };

    await expect(inspectModuleSources([8], deps)).rejects.toThrow(
      /column metadata/,
    );
  });

  test("rejects overlong stored headers before schema similarity analysis", async () => {
    const deps: InspectorDeps = {
      sql: {
        async unsafe() {
          return [{
            id: 8,
            type: "file",
            config: {
              columns: [{ raw: "x".repeat(257), name: "field_1" }],
            },
          }];
        },
      },
      async resolveTableReference() {
        return '"user_data"."uf_8"';
      },
    };

    await expect(inspectModuleSources([8], deps)).rejects.toThrow(
      /overlong column metadata/,
    );
  });

  test("does not infer a calendar-invalid date", async () => {
    const deps: InspectorDeps = {
      sql: {
        async unsafe(query) {
          if (query.includes("public.data_sources")) {
            return [{
              id: 12,
              type: "file",
              config: {
                columns: [{ raw: "Event Date", name: "event_date" }],
              },
            }];
          }
          return Array.from({ length: 5 }, () => ({
            event_date: "2026-02-30",
          }));
        },
      },
      async resolveTableReference() {
        return '"user_data"."uf_12"';
      },
    };

    const result = await inspectModuleSources([12], deps);

    expect(result.inferredTypes["Event Date"]).toBe("text");
  });

  test("does not infer a timestamp with a calendar-invalid date", async () => {
    const deps: InspectorDeps = {
      sql: {
        async unsafe(query) {
          if (query.includes("public.data_sources")) {
            return [{
              id: 13,
              type: "file",
              config: {
                columns: [{ raw: "Event Time", name: "event_time" }],
              },
            }];
          }
          return Array.from({ length: 5 }, () => ({
            event_time: "2026-02-30 12:00",
          }));
        },
      },
      async resolveTableReference() {
        return '"user_data"."uf_13"';
      },
    };

    const result = await inspectModuleSources([13], deps);

    expect(result.inferredTypes["Event Time"]).toBe("text");
  });

  test("infers JavaScript Date strings from uploaded spreadsheet cells as timestamps", async () => {
    const deps: InspectorDeps = {
      sql: {
        async unsafe(query) {
          if (query.includes("public.data_sources")) {
            return [{
              id: 14,
              type: "file",
              config: {
                columns: [{ raw: "支付时间", name: "支付时间" }],
              },
            }];
          }
          return Array.from({ length: 5 }, () => ({
            支付时间:
              "Wed Jul 15 2026 22:42:25 GMT+0000 (Coordinated Universal Time)",
          }));
        },
      },
      async resolveTableReference() {
        return '"user_data"."uf_14"';
      },
    };

    const result = await inspectModuleSources([14], deps);

    expect(result.inferredTypes["支付时间"]).toBe("timestamp");
  });

  test("does not normalize an impossible JavaScript Date string into a timestamp", async () => {
    const deps: InspectorDeps = {
      sql: {
        async unsafe(query) {
          if (query.includes("public.data_sources")) {
            return [{
              id: 15,
              type: "file",
              config: {
                columns: [{ raw: "支付时间", name: "支付时间" }],
              },
            }];
          }
          return Array.from({ length: 5 }, () => ({
            支付时间:
              "Mon Feb 30 2026 12:00:00 GMT+0000 (Coordinated Universal Time)",
          }));
        },
      },
      async resolveTableReference() {
        return '"user_data"."uf_15"';
      },
    };

    const result = await inspectModuleSources([15], deps);

    expect(result.inferredTypes["支付时间"]).toBe("text");
  });
});
