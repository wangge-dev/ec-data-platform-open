import { beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type StoredRow = Record<string, unknown>;

const fake = vi.hoisted(() => {
  const rawTables = new Map<number, StoredRow[]>();
  const outputTables = new Map<string, StoredRow[]>();
  const existingTables = new Set<string>();
  const statements: string[] = [];
  const dataSources: Array<{ id: number; config: unknown }> = [];
  let failurePattern: RegExp | null = null;

  const tableNameFromRef = (query: string): string | undefined =>
    query.match(/"user_data"\."([^"]+)"/)?.[1]
    ?? query.match(/"public"\."([^"]+)"/)?.[1];

  const unsafe = vi.fn(async (query: string, parameters: unknown[] = []) => {
    statements.push(query);
    const normalized = query.replace(/\s+/g, " ").trim();

    if (failurePattern?.test(normalized)) {
      failurePattern = null;
      throw new Error("injected database failure");
    }

    if (normalized.startsWith("SELECT pg_advisory_xact_lock")) return [];

    if (normalized.startsWith("SELECT id, config FROM public.data_sources")) {
      return structuredClone(dataSources);
    }

    if (normalized.includes("FROM information_schema.tables")) {
      const [, tableName] = parameters as string[];
      return existingTables.has(tableName) ? [{ "?column?": 1 }] : [];
    }

    if (normalized.startsWith("CREATE TABLE IF NOT EXISTS")) {
      const tableName = tableNameFromRef(normalized);
      if (tableName) {
        existingTables.add(tableName);
        outputTables.set(tableName, outputTables.get(tableName) ?? []);
      }
      return [];
    }

    if (normalized.startsWith("ALTER TABLE")) return [];

    if (normalized.startsWith("SELECT * FROM")) {
      const tableName = tableNameFromRef(normalized);
      const sourceId = Number(tableName?.replace(/^uf_/, ""));
      return structuredClone(rawTables.get(sourceId) ?? []);
    }

    if (normalized.startsWith("DELETE FROM")) {
      const tableName = tableNameFromRef(normalized)!;
      const sourceId = parameters[0];
      outputTables.set(
        tableName,
        (outputTables.get(tableName) ?? []).filter((row) => row._source_id !== sourceId),
      );
      return [];
    }

    if (normalized.startsWith("INSERT INTO")) {
      const tableName = tableNameFromRef(normalized)!;
      const columnList = normalized.match(/INSERT INTO .*? \(([^)]+)\) VALUES/)?.[1] ?? "";
      const columns = [...columnList.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
      const rows = outputTables.get(tableName) ?? [];
      for (let offset = 0; offset < parameters.length; offset += columns.length) {
        rows.push(Object.fromEntries(
          columns.map((column, index) => [column, parameters[offset + index]]),
        ));
      }
      outputTables.set(tableName, rows);
      return { count: parameters.length / columns.length };
    }

    if (normalized.startsWith("SELECT COUNT(*)::int AS cnt")) {
      const tableName = tableNameFromRef(normalized)!;
      const sourceId = parameters[0];
      const cnt = (outputTables.get(tableName) ?? [])
        .filter((row) => row._source_id === sourceId && row._matched === true)
        .length;
      return [{ cnt }];
    }

    if (normalized.startsWith("SELECT 1 FROM") && normalized.includes("HAVING COUNT(*) > 1")) {
      const tableName = tableNameFromRef(normalized)!;
      const keyColumns = [...normalized.matchAll(/GROUP BY (.+?) HAVING/g)]
        .flatMap((match) => [...match[1].matchAll(/d\."([^"]+)"/g)].map((column) => column[1]));
      const seen = new Set<string>();
      for (const row of rawTables.get(Number(tableName.replace(/^uf_/, ""))) ?? []) {
        const values = keyColumns.map((column) => row[column]);
        if (values.some((value) => value == null)) continue;
        const key = JSON.stringify(values);
        if (seen.has(key)) return [{ "?column?": 1 }];
        seen.add(key);
      }
      return [];
    }

    throw new Error(`Unexpected SQL in fake client: ${normalized}`);
  });

  const transaction = async <T>(work: (executor: { unsafe: typeof unsafe }) => Promise<T>) => {
    const savedRaw = structuredClone([...rawTables]);
    const savedOutput = structuredClone([...outputTables]);
    const savedTables = [...existingTables];
    try {
      return await work({ unsafe });
    } catch (error) {
      rawTables.clear();
      for (const [key, value] of savedRaw) rawTables.set(key, value);
      outputTables.clear();
      for (const [key, value] of savedOutput) outputTables.set(key, value);
      existingTables.clear();
      for (const value of savedTables) existingTables.add(value);
      throw error;
    }
  };

  return {
    rawTables,
    outputTables,
    existingTables,
    statements,
    sql: { unsafe, begin: transaction },
    reset() {
      rawTables.clear();
      outputTables.clear();
      existingTables.clear();
      statements.length = 0;
      dataSources.length = 0;
      failurePattern = null;
      unsafe.mockClear();
    },
    seedSource(sourceId: number, rows: StoredRow[]) {
      rawTables.set(sourceId, structuredClone(rows));
      existingTables.add(`uf_${sourceId}`);
    },
    rowsFor(sourceId: number) {
      return (outputTables.get("unified_pinduoduo_sales") ?? [])
        .filter((row) => row._source_id === sourceId);
    },
    seedDictionary(sourceId: number, config: unknown, rows: StoredRow[]) {
      dataSources.push({ id: sourceId, config });
      rawTables.set(sourceId, structuredClone(rows));
      existingTables.add(`uf_${sourceId}`);
    },
    failOnce(pattern: RegExp) {
      failurePattern = pattern;
    },
    transaction,
  };
});

vi.mock("../src/db/client.js", () => ({
  db: {},
  sql: fake.sql,
}));

import { runDefaultTransform } from "../src/modules/default-transform.js";

const moduleDef = {
  code: "pinduoduo_sales",
  name: "拼多多销售",
  description: "拼多多订单明细",
  enabled: true,
  hasTransform: false,
  usages: ["summary", "ai_chart", "ai_analysis"],
  columns: [
    { name: "order_id", source: "订单号", type: "text", required: true, computed: false },
    { name: "status", source: "订单状态", type: "text", required: false, computed: false },
    { name: "amount", source: "订单金额", type: "numeric", required: false, computed: false },
  ],
  platforms: [{
    code: "pinduoduo",
    name: "拼多多",
    filePattern: "orders_export",
    patternFlags: "i",
    enabled: true,
  }],
  inclusionRule: {
    field: "status",
    includedValues: ["已发货，待收货", "已收货"],
  },
  origin: "user",
  configurable: true,
} as any;

const sourceRows = (count = 4): StoredRow[] => [
  { 订单号: "A-1", 订单状态: " 已发货，待收货 ", 订单金额: "10.00" },
  { 订单号: "A-2", 订单状态: "已收货", 订单金额: "20.00" },
  { 订单号: "A-3", 订单状态: "已取消", 订单金额: "30.00" },
  { 订单号: "A-4", 订单状态: "待付款", 订单金额: "40.00" },
].slice(0, count);

const transform = (sourceId: number) =>
  runDefaultTransform({
    module: moduleDef,
    platform: "pinduoduo",
    rawFileName: `orders_export_${sourceId}.csv`,
    extra: { sourceId },
  });

describe("default module transform inclusion", () => {
  beforeEach(() => fake.reset());

  test("keeps excluded rows and marks inclusion instead of dropping them", async () => {
    fake.seedSource(161, sourceRows());

    const result = await transform(161);
    const rows = fake.rowsFor(161);

    expect(result).toMatchObject({
      total: 4,
      inserted: 4,
      included: 2,
      excluded: 2,
    });
    expect(rows.map((row) => row._included)).toEqual([true, true, false, false]);
    expect(rows.map((row) => row._excluded_reason)).toEqual([
      null,
      null,
      "状态「已取消」未计入有效数据",
      "状态「待付款」未计入有效数据",
    ]);
    expect(fake.statements).toContainEqual(
      expect.stringContaining('ADD COLUMN IF NOT EXISTS "_included" BOOLEAN NOT NULL DEFAULT true'),
    );
    expect(fake.statements).toContainEqual(
      expect.stringContaining('ADD COLUMN IF NOT EXISTS "amount" NUMERIC(18,4)'),
    );
    expect(fake.statements.some((statement) => /\bDROP\s+COLUMN\b/i.test(statement))).toBe(false);
  });

  test("rerun replaces rows for one source without duplicating another source", async () => {
    fake.seedSource(161, sourceRows());
    fake.seedSource(162, sourceRows(3));

    await transform(161);
    await transform(162);
    await transform(161);

    expect(fake.rowsFor(161)).toHaveLength(4);
    expect(fake.rowsFor(162)).toHaveLength(3);
    expect(fake.statements).toContainEqual(
      expect.stringContaining("pg_advisory_xact_lock"),
    );
  });

  test("rolls back a rerun when a database batch fails after the delete", async () => {
    fake.seedSource(161, sourceRows(2));
    await transform(161);
    const previous = structuredClone(fake.rowsFor(161));

    fake.seedSource(161, sourceRows(4));
    fake.failOnce(/^INSERT INTO/);
    await expect(transform(161)).rejects.toThrow("injected database failure");

    expect(fake.rowsFor(161)).toEqual(previous);
  });

  test("fails closed when a declared dictionary is unavailable", async () => {
    const joinedModule = {
      ...structuredClone(moduleDef),
      join: {
        dictRole: "brand_dict",
        on: { order_id: "id" },
        enrich: { brand: "品牌" },
      },
    };
    fake.seedSource(161, sourceRows(2));

    await expect(runDefaultTransform({
      module: joinedModule,
      platform: "pinduoduo",
      rawFileName: "orders_export_161.csv",
      extra: { sourceId: 161 },
    })).rejects.toThrow("缺少可用字典来源");
    expect(fake.rowsFor(161)).toEqual([]);
  });

  test("rejects duplicate dictionary keys and never interpolates raw manifest text", async () => {
    const joinedModule = {
      ...structuredClone(moduleDef),
      join: {
        dictRole: "brand_dict",
        on: { order_id: "订单编号" },
        enrich: { brand: "品牌" },
      },
    };
    fake.seedSource(161, sourceRows(2));
    fake.seedDictionary(901, {
      role: "brand_dict",
      columns: [
        { raw: "订单编号", name: "order_key" },
        { raw: "品牌", name: "brand_name" },
      ],
      brandDict: {},
    }, [
      { order_key: "A-1", brand_name: "甲" },
      { order_key: "A-1", brand_name: "乙" },
    ]);

    await expect(runDefaultTransform({
      module: joinedModule,
      platform: "pinduoduo",
      rawFileName: "orders_export_161.csv",
      extra: { sourceId: 161 },
    })).rejects.toThrow("关联键不唯一");
    expect(fake.rowsFor(161)).toEqual([]);

    joinedModule.join.on.order_id = 'id" OR 1=1 --';
    await expect(runDefaultTransform({
      module: joinedModule,
      platform: "pinduoduo",
      rawFileName: "orders_export_161.csv",
      extra: { sourceId: 161 },
    })).rejects.toThrow("找不到关联列");
    expect(fake.statements.some((statement) => statement.includes('id" OR 1=1 --'))).toBe(false);
  });

  test("fails closed and rolls back when a computed expression is rejected", async () => {
    const computedModule = structuredClone(moduleDef);
    computedModule.columns.push({
      name: "unsafe_total",
      type: "numeric",
      required: false,
      computed: true,
      expression: "amount; DROP TABLE public.users",
    });
    fake.seedSource(161, sourceRows(2));

    await expect(runDefaultTransform({
      module: computedModule,
      platform: "pinduoduo",
      rawFileName: "orders_export_161.csv",
      extra: { sourceId: 161 },
    })).rejects.toThrow("表达式无效");
    expect(fake.rowsFor(161)).toEqual([]);
  });

  test("fails the whole run instead of silently dropping rows with invalid required values", async () => {
    const strictModule = structuredClone(moduleDef);
    strictModule.columns.find((column: any) => column.name === "amount").required = true;
    fake.seedSource(163, [
      ...sourceRows(2),
      { 订单号: "A-3", 订单状态: "已收货", 订单金额: "not-a-number" },
    ]);

    const result = await runDefaultTransform({
      module: strictModule,
      platform: "pinduoduo",
      rawFileName: "orders_export_163.csv",
      extra: { sourceId: 163 },
    });

    expect(result).toMatchObject({
      total: 3,
      inserted: 0,
      error: "必要字段存在无法读取的值，请修正源文件后重新上传",
    });
    expect(fake.rowsFor(163)).toEqual([]);
    expect(
      fake.statements.some((statement) => statement.startsWith("DELETE FROM")),
    ).toBe(false);
  });

  test("preserves excluded rows even when a required metric is blank or invalid", async () => {
    const strictModule = structuredClone(moduleDef);
    strictModule.columns.find((column: any) => column.name === "amount").required = true;
    fake.seedSource(164, [
      { 订单号: "A-1", 订单状态: "已收货", 订单金额: "20.00" },
      { 订单号: "A-2", 订单状态: "已取消", 订单金额: "" },
      { 订单号: "A-3", 订单状态: "已发货，退款成功", 订单金额: "not-a-number" },
    ]);

    const result = await runDefaultTransform({
      module: strictModule,
      platform: "pinduoduo",
      rawFileName: "orders_export_164.csv",
      extra: { sourceId: 164 },
    });

    expect(result).toMatchObject({
      total: 3,
      inserted: 3,
      included: 1,
      excluded: 2,
    });
    expect(fake.rowsFor(164)).toEqual([
      expect.objectContaining({ amount: 20, _included: true }),
      expect.objectContaining({ amount: null, _included: false }),
      expect.objectContaining({ amount: null, _included: false }),
    ]);
  });

  test("one transaction rolls back output from every source when a later source fails", async () => {
    const strictModule = structuredClone(moduleDef);
    strictModule.columns.find((column: any) => column.name === "amount").required = true;
    fake.seedSource(171, sourceRows(2));
    fake.seedSource(172, [
      { 订单号: "B-1", 订单状态: "已收货", 订单金额: "not-a-number" },
    ]);

    await expect(fake.transaction(async (executor) => {
      const first = await runDefaultTransform({
        module: strictModule,
        platform: "pinduoduo",
        rawFileName: "orders_export_171.csv",
        sql: executor,
        extra: { sourceId: 171 },
      });
      if (first.error) throw new Error(first.error);
      const second = await runDefaultTransform({
        module: strictModule,
        platform: "pinduoduo",
        rawFileName: "orders_export_172.csv",
        sql: executor,
        extra: { sourceId: 172 },
      });
      if (second.error) throw new Error(second.error);
    })).rejects.toThrow("必要字段存在无法读取的值");

    expect(fake.rowsFor(171)).toEqual([]);
    expect(fake.rowsFor(172)).toEqual([]);
  });
});

describe("user-module derived query inclusion", () => {
  const routeSource = (file: string) =>
    readFileSync(resolve(import.meta.dirname, "../src/routes", file), "utf8");
  const serviceSource = (file: string) =>
    readFileSync(resolve(import.meta.dirname, "../src/services", file), "utf8");

  test.each(["etl.ts", "agents.ts"])(
    "%s limits user-module summaries and samples to included rows",
    (file) => {
      const contents = routeSource(file);
      expect(contents).toContain('mod.origin === "user"');
      expect(contents).toContain('COALESCE("_included", true) = true');
    },
  );

  test.each(["metrics.ts", "board.ts"])(
    "%s routes semantic queries through the shared compiler",
    (file) => {
      const contents = routeSource(file);
      expect(contents).toContain("compileSemanticQuery");
      expect(contents).toContain("loadSemanticModels");
    },
  );

  test("semantic compiler applies the user-module inclusion rule", () => {
    const contents = serviceSource("semantic-model.ts");
    expect(contents).toContain('module.origin === "user"');
    expect(contents).toContain('COALESCE("_included", true) = true');
  });

  test("legacy raw dataset rendering stays unfiltered while new previews are semantic-only", () => {
    const contents = routeSource("board.ts");
    expect(contents).toContain("return { sqlText: `SELECT * FROM ${tableRef}`, parameters: [] };");
    expect(contents).not.toContain("return { sqlText: `SELECT * FROM ${tableRef} WHERE");
    expect(contents).toContain('queryType: z.literal("semantic")');
  });
});
