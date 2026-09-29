import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as XLSX from "xlsx";

const persistence = vi.hoisted(() => ({
  existingSources: [] as Array<{ id: number; type: string; config: unknown }>,
  insertedSourceValues: [] as unknown[],
  transactionSourceConfigs: [] as Array<Record<string, unknown>>,
  nextSourceId: 700,
  transactionSourceInsertCount: 0,
  advisoryTail: Promise.resolve() as Promise<void>,
  advisoryLockCount: 0,
  transactionQueryLog: [] as string[],
  transactionQueryParameters: [] as Array<unknown[] | undefined>,
  periodAuthorities: new Map<string, { authority: "manual" | "auto"; close_day: number; reopened_at: Date | null }>(),
  periodAuthorityEvents: [] as Array<{ action: string; scopeKey: string }>,
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(async () => persistence.existingSources),
    })),
  })),
  insert: vi.fn(() => ({
    values: vi.fn((value: unknown) => {
      persistence.insertedSourceValues.push(value);
      return { returning: vi.fn(async () => [{ id: 700 }]) };
    }),
  })),
  unsafe: vi.fn(async () => [] as Array<Record<string, unknown>>),
  begin: vi.fn(async (callback: (tx: any) => Promise<unknown>) => {
    let sourceSnapshot: typeof persistence.existingSources | null = null;
    let authoritySnapshot: typeof persistence.periodAuthorities | null = null;
    let eventSnapshot: typeof persistence.periodAuthorityEvents | null = null;
    let releaseAdvisory: (() => void) | null = null;
    const ensureSnapshot = () => {
      sourceSnapshot ??= [...persistence.existingSources];
      authoritySnapshot ??= new Map(persistence.periodAuthorities);
      eventSnapshot ??= [...persistence.periodAuthorityEvents];
    };
    const tx = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (String(strings).includes("DELETE FROM public.data_sources")) {
        ensureSnapshot();
        const id = Number(values[0]);
        persistence.existingSources = persistence.existingSources.filter((source) => source.id !== id);
      }
      return [];
    }) as any;
    tx.unsafe = vi.fn(async (query: unknown, parameters?: unknown[]) => {
      const text = String(query);
      persistence.transactionQueryLog.push(text);
      persistence.transactionQueryParameters.push(parameters);
      if (text.startsWith("SELECT pg_advisory_xact_lock")) {
        persistence.advisoryLockCount += 1;
        const previous = persistence.advisoryTail;
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
          release = resolve;
        });
        persistence.advisoryTail = previous.catch(() => undefined).then(() => current);
        await previous.catch(() => undefined);
        releaseAdvisory = release;
        return [{ pg_advisory_xact_lock: null }];
      }
      if (text.startsWith("INSERT INTO public.period_authority_event")) {
        ensureSnapshot();
        persistence.periodAuthorityEvents.push({
          action: String(parameters?.[2]),
          scopeKey: String(parameters?.[1]),
        });
        return [];
      }
      if (text.startsWith("INSERT INTO public.period_authority")) {
        ensureSnapshot();
        const key = `${parameters?.[0]}:${parameters?.[1]}`;
        if (persistence.periodAuthorities.has(key)) return [];
        persistence.periodAuthorities.set(key, {
          authority: "manual",
          close_day: Number(parameters?.[2]),
          reopened_at: null,
        });
        return [{ id: persistence.periodAuthorities.size }];
      }
      if (text.startsWith("SELECT authority, close_day, reopened_at")) {
        ensureSnapshot();
        return persistence.periodAuthorities.get(`${parameters?.[0]}:${parameters?.[1]}`)
          ? [persistence.periodAuthorities.get(`${parameters?.[0]}:${parameters?.[1]}`)!]
          : [];
      }
      if (text.startsWith("UPDATE public.period_authority") && text.includes("SET authority")) {
        ensureSnapshot();
        const key = `${parameters?.[0]}:${parameters?.[1]}`;
        const row = persistence.periodAuthorities.get(key);
        if (row) row.authority = parameters?.[2] as "manual" | "auto";
        return [];
      }
      if (text.startsWith("UPDATE public.period_authority") && text.includes("SET reopened_by")) {
        ensureSnapshot();
        const key = `${parameters?.[0]}:${parameters?.[1]}`;
        const row = persistence.periodAuthorities.get(key);
        if (row) row.reopened_at = new Date("2098-02-06T00:00:00.000Z");
        return [];
      }
      if (text.startsWith("SELECT id, config FROM public.data_sources")) {
        ensureSnapshot();
        return persistence.existingSources;
      }
      if (text.startsWith("INSERT INTO public.data_sources")) {
        ensureSnapshot();
        persistence.transactionSourceInsertCount += 1;
        const id = persistence.nextSourceId++;
        const config = JSON.parse(String(parameters?.[1] ?? "{}"));
        persistence.transactionSourceConfigs.push(config);
        persistence.existingSources.push({ id, type: "file", config });
        return [{ id }];
      }
      return persistence.unsafe(query, parameters);
    });
    try {
      return await callback(tx);
    } catch (error) {
      if (sourceSnapshot) persistence.existingSources = sourceSnapshot;
      if (authoritySnapshot) persistence.periodAuthorities = authoritySnapshot;
      if (eventSnapshot) persistence.periodAuthorityEvents = eventSnapshot;
      throw error;
    } finally {
      releaseAdvisory?.();
    }
  }),
}));

vi.mock("../src/db/client.js", () => ({
  db: {
    select: persistence.select,
    insert: persistence.insert,
  },
  sql: {
    unsafe: persistence.unsafe,
    begin: persistence.begin,
  },
}));

import {
  FRONT_PROFIT_STANDARD_HEADERS,
  FRONT_PROFIT_STANDARD_SCHEMA_VERSION,
  FrontProfitValidationError,
  isFrontProfitStandardSheet,
  moduleRequiresFrontProfitStandard,
  validateFrontProfitStandardSheet,
} from "../src/services/front-profit-standard.js";
import { frontProfitCloseDate, frontProfitScopeKey } from "../src/services/front-profit-period.js";
import {
  FileSourceDeleteBlockedError,
  importExcel,
} from "../src/services/import-excel.js";

type Scenario = {
  name: string;
  recordId: string;
  date: string;
  mode: string;
  shop: string;
  operator: string;
  inputs: Record<string, number>;
  expected: Record<string, number>;
};

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures/front-profit-golden.v1.json"), "utf8"),
) as {
  schemaVersion: string;
  containsRealBusinessData: boolean;
  scenarios: Scenario[];
};

const scenarioRecord = (scenario: Scenario): Record<string, unknown> => ({
  日期: scenario.date,
  平台: "合成平台",
  业务模式: scenario.mode,
  组: "合成组",
  店铺: scenario.shop,
  店铺2: "合成归一店铺",
  运营: scenario.operator,
  ...scenario.inputs,
  来源文件: "synthetic-front-profit-golden.json",
  来源批次: "GOLDEN-V1",
  备注: scenario.name,
  ...scenario.expected,
  record_id: scenario.recordId,
  数据状态: "合成金标",
});

const rowFromRecord = (record: Record<string, unknown>): unknown[] =>
  FRONT_PROFIT_STANDARD_HEADERS.map((header) => record[header]);

const workbookBytes = (records: Record<string, unknown>[]): Buffer => {
  const sheet = XLSX.utils.aoa_to_sheet([
    [...FRONT_PROFIT_STANDARD_HEADERS],
    ...records.map(rowFromRecord),
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "前台利润标准数据");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
};

const validRecords = (): Record<string, unknown>[] => fixture.scenarios.map(scenarioRecord);

const periodForRecord = (record: Record<string, unknown>): string =>
  String(record[FRONT_PROFIT_STANDARD_HEADERS[0]]).slice(0, 7);

const persistedAuthorityKey = (period: string): string => `front_profit:front_profit:${period}`;

const captureValidationError = (rows: unknown[][]): FrontProfitValidationError => {
  try {
    validateFrontProfitStandardSheet(FRONT_PROFIT_STANDARD_HEADERS, rows);
  } catch (error) {
    expect(error).toBeInstanceOf(FrontProfitValidationError);
    return error as FrontProfitValidationError;
  }
  throw new Error("Expected front-profit validation to fail");
};

const expectIssue = (rows: unknown[][], code: string): FrontProfitValidationError => {
  const error = captureValidationError(rows);
  expect(error.issues.map((issue) => issue.code)).toContain(code);
  return error;
};

const zeroRecord = (): Record<string, unknown> => scenarioRecord({
  name: "synthetic-isolated-sign-case",
  recordId: "SYNTHETIC_SIGN_CASE",
  date: "2098-02-01",
  mode: "其他",
  shop: "合成店铺-符号测试",
  operator: "合成运营-符号测试",
  inputs: {
    单量: 0,
    GMV: 0,
    补单金额: 0,
    补单产品成本: 0,
    补单单量: 0,
    产品成本: 0,
    出货货值: 0,
    "平台扣点/毛保": 0,
    税点: 0,
    财务成本: 0,
    运费: 0,
    佣金: 0,
    推广费: 0,
  },
  expected: {
    真实营业额: 0,
    前台利润: 0,
    付费占比: 0,
  },
});

describe("front-profit synthetic golden contract", () => {
  beforeEach(() => {
    persistence.existingSources = [];
    persistence.insertedSourceValues.length = 0;
    persistence.transactionSourceConfigs.length = 0;
    persistence.nextSourceId = 700;
    persistence.transactionSourceInsertCount = 0;
    persistence.advisoryTail = Promise.resolve();
    persistence.advisoryLockCount = 0;
    persistence.transactionQueryLog.length = 0;
    persistence.transactionQueryParameters.length = 0;
    persistence.periodAuthorities.clear();
    persistence.periodAuthorityEvents.length = 0;
    persistence.select.mockClear();
    persistence.insert.mockClear();
    persistence.unsafe.mockReset();
    persistence.unsafe.mockResolvedValue([]);
    persistence.begin.mockClear();
  });

  test("accepts the versioned synthetic self-operated, POP, promotion-orphan, negative, and precision cases", () => {
    expect(fixture.schemaVersion).toBe("front-profit-golden/v1");
    expect(fixture.containsRealBusinessData).toBe(false);
    const records = validRecords();
    const longId = records.at(-1)!.record_id;

    const result = validateFrontProfitStandardSheet(
      FRONT_PROFIT_STANDARD_HEADERS,
      records.map(rowFromRecord),
    );

    expect(result).toMatchObject({ businessRowCount: 5 });
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["PROMOTION_ORPHAN", "NEGATIVE_QUANTITY", "NEGATIVE_VALUE"]),
    );
    expect(records.at(-1)!.record_id).toBe(longId);
    expect(longId).toBe("000000000000000000000123456789");
  });

  test.each([
    ["出货货值", 1],
    ["产品成本", -1],
    ["运费", -1],
    ["补单金额", -1],
    ["平台扣点/毛保", -1],
    ["税点", -1],
    ["财务成本", -1],
    ["佣金", -1],
    ["推广费", -1],
    ["补单产品成本", 1],
  ])("locks the profit sign for %s", (field, expectedProfit) => {
    const record = zeroRecord();
    record[field] = 1;
    record.前台利润 = expectedProfit;
    if (field === "补单金额") record.真实营业额 = -1;

    expect(() => validateFrontProfitStandardSheet(
      FRONT_PROFIT_STANDARD_HEADERS,
      [rowFromRecord(record)],
    )).not.toThrow();
  });

  test("locks real revenue and paid-ratio formulas including GMV zero", () => {
    const revenue = zeroRecord();
    revenue.GMV = 1;
    revenue.补单金额 = 0.25;
    revenue.真实营业额 = 0.75;
    revenue.前台利润 = -0.25;

    const ratio = zeroRecord();
    ratio.record_id = "SYNTHETIC_RATIO_CASE";
    ratio.日期 = "2098-02-02";
    ratio.GMV = 4;
    ratio.推广费 = 1;
    ratio.真实营业额 = 4;
    ratio.前台利润 = -1;
    ratio.付费占比 = 0.25;

    const zeroGmv = zeroRecord();
    zeroGmv.record_id = "SYNTHETIC_ZERO_GMV_CASE";
    zeroGmv.日期 = "2098-02-03";
    zeroGmv.推广费 = 1;
    zeroGmv.前台利润 = -1;
    zeroGmv.付费占比 = 0;

    expect(() => validateFrontProfitStandardSheet(
      FRONT_PROFIT_STANDARD_HEADERS,
      [revenue, ratio, zeroGmv].map(rowFromRecord),
    )).not.toThrow();
  });

  test.each([
    ["invalid calendar date", (row: Record<string, unknown>) => { row.日期 = "2098-02-30"; }, "INVALID_DATE"],
    ["slash date", (row: Record<string, unknown>) => { row.日期 = "2098/01/01"; }, "INVALID_DATE"],
    ["partial number", (row: Record<string, unknown>) => { row.GMV = "12x"; }, "INVALID_NUMBER"],
    ["infinite number", (row: Record<string, unknown>) => { row.GMV = Number.POSITIVE_INFINITY; }, "INVALID_NUMBER"],
    ["blank amount", (row: Record<string, unknown>) => { row.GMV = ""; }, "INVALID_NUMBER"],
    ["fractional quantity", (row: Record<string, unknown>) => { row.单量 = 1.5; }, "INVALID_INTEGER"],
    ["numeric record id", (row: Record<string, unknown>) => { row.record_id = 123456789012345; }, "INVALID_RECORD_ID"],
    ["scientific record id", (row: Record<string, unknown>) => { row.record_id = "1.2345E+14"; }, "INVALID_RECORD_ID"],
    ["missing operator", (row: Record<string, unknown>) => { row.运营 = ""; }, "REQUIRED_TEXT"],
    ["unsupported mode", (row: Record<string, unknown>) => { row.业务模式 = "自动分摊"; }, "INVALID_BUSINESS_MODE"],
  ])("rejects %s before persistence", (_name, mutate, code) => {
    const record = validRecords()[0]!;
    mutate(record);
    const error = expectIssue([rowFromRecord(record)], code);
    expect(error.message).not.toContain("合成店铺-A");
    expect(error.message).not.toContain(String(record.record_id));
  });

  test.each([
    ["真实营业额", "REAL_REVENUE_MISMATCH"],
    ["前台利润", "FRONT_PROFIT_MISMATCH"],
    ["付费占比", "PAID_RATIO_MISMATCH"],
  ])("rejects a changed derived result in %s", (field, code) => {
    const record = validRecords()[0]!;
    record[field] = Number(record[field]) + 0.02;
    expectIssue([rowFromRecord(record)], code);
  });

  test("locks both money and ratio tolerance boundaries", () => {
    const moneyAtBoundary = validRecords()[0]!;
    moneyAtBoundary.前台利润 = Number(moneyAtBoundary.前台利润) + 0.01;
    expect(() => validateFrontProfitStandardSheet(
      FRONT_PROFIT_STANDARD_HEADERS,
      [rowFromRecord(moneyAtBoundary)],
    )).not.toThrow();

    const moneyOutside = validRecords()[0]!;
    moneyOutside.前台利润 = Number(moneyOutside.前台利润) + 0.0101;
    expectIssue([rowFromRecord(moneyOutside)], "FRONT_PROFIT_MISMATCH");

    const ratioAtBoundary = validRecords()[0]!;
    ratioAtBoundary.付费占比 = Number(ratioAtBoundary.付费占比) + 0.0001;
    expect(() => validateFrontProfitStandardSheet(
      FRONT_PROFIT_STANDARD_HEADERS,
      [rowFromRecord(ratioAtBoundary)],
    )).not.toThrow();

    const ratioOutside = validRecords()[0]!;
    ratioOutside.付费占比 = Number(ratioOutside.付费占比) + 0.00011;
    expectIssue([rowFromRecord(ratioOutside)], "PAID_RATIO_MISMATCH");
  });

  test("rejects duplicate record IDs and duplicate five-dimension aggregation keys independently", () => {
    const first = validRecords()[0]!;
    const duplicateId = validRecords()[2]!;
    duplicateId.record_id = first.record_id;
    expectIssue([first, duplicateId].map(rowFromRecord), "DUPLICATE_RECORD_ID");

    const duplicateKey = structuredClone(first);
    duplicateKey.record_id = "SYNTHETIC_DIFFERENT_RECORD_ID";
    expectIssue([first, duplicateKey].map(rowFromRecord), "DUPLICATE_AGGREGATION_KEY");
  });

  test("rejects the untouched release template sample before any formula bypass or persistence", () => {
    const sample = Object.fromEntries(FRONT_PROFIT_STANDARD_HEADERS.map((header) => [header, null]));
    sample.record_id = "TEMPLATE_EXAMPLE_20991231";
    sample.数据状态 = "示例行（不纳入经营分析）";

    expectIssue([rowFromRecord(sample)], "TEMPLATE_EXAMPLE_NOT_REMOVED");
    sample.前台利润 = 999999;
    expectIssue([rowFromRecord(sample)], "TEMPLATE_EXAMPLE_NOT_REMOVED");
    sample.数据状态 = "正常";
    expectIssue([rowFromRecord(sample)], "TEMPLATE_EXAMPLE_NOT_REMOVED");
    sample.record_id = " TEMPLATE_EXAMPLE_20991231 ";
    expectIssue([rowFromRecord(sample)], "TEMPLATE_EXAMPLE_NOT_REMOVED");
    sample.record_id = "SYNTHETIC_RENAMED_EXAMPLE";
    sample.数据状态 = "示例行（不纳入经营分析）";
    expectIssue([rowFromRecord(sample)], "TEMPLATE_EXAMPLE_NOT_REMOVED");
    expectIssue([rowFromRecord(sample), rowFromRecord(validRecords()[0]!)], "TEMPLATE_EXAMPLE_NOT_REMOVED");
  });

  test("recognizes renamed standard sheets by their contract markers and fails closed on header drift", () => {
    expect(isFrontProfitStandardSheet(FRONT_PROFIT_STANDARD_HEADERS, "renamed.xlsx")).toBe(true);
    expect(isFrontProfitStandardSheet(["日期", "金额", "店铺"], "generic.xlsx")).toBe(false);
    expect(isFrontProfitStandardSheet(["日期", "GMV"], "拼多多京东前台利润7月06.xlsx")).toBe(false);
    const driftedHeaders = FRONT_PROFIT_STANDARD_HEADERS.filter((header) => header !== "推广费");
    expect(() => validateFrontProfitStandardSheet(
      driftedHeaders,
      [driftedHeaders.map((header) => validRecords()[0]![header])],
    )).toThrow(FrontProfitValidationError);
    try {
      validateFrontProfitStandardSheet(
        driftedHeaders,
        [driftedHeaders.map((header) => validRecords()[0]![header])],
      );
    } catch (error) {
      expect((error as FrontProfitValidationError).issues.map((issue) => issue.code)).toContain("HEADER_CONTRACT");
    }

    const extraHeaders = [...FRONT_PROFIT_STANDARD_HEADERS, "额外字段"];
    expect(() => validateFrontProfitStandardSheet(
      extraHeaders,
      [[...rowFromRecord(validRecords()[0]!), "unexpected"]],
    )).toThrow(FrontProfitValidationError);

    const duplicateHeaders = [...FRONT_PROFIT_STANDARD_HEADERS];
    duplicateHeaders[duplicateHeaders.length - 1] = "日期";
    expect(() => validateFrontProfitStandardSheet(
      duplicateHeaders,
      [duplicateHeaders.map((header) => validRecords()[0]![header])],
    )).toThrow(FrontProfitValidationError);

    const reorderedHeaders = [...FRONT_PROFIT_STANDARD_HEADERS].reverse();
    expect(() => validateFrontProfitStandardSheet(
      reorderedHeaders,
      [reorderedHeaders.map((header) => validRecords()[0]![header])],
    )).not.toThrow();

    const paddedHeaders = [...FRONT_PROFIT_STANDARD_HEADERS];
    paddedHeaders[0] = " 日期 ";
    expect(() => validateFrontProfitStandardSheet(
      paddedHeaders,
      [paddedHeaders.map((header) => validRecords()[0]![header.trim()])],
    )).toThrow(FrontProfitValidationError);
  });

  test("binds the front-profit module to the complete 28-column source contract, independent of its name", () => {
    const columns = FRONT_PROFIT_STANDARD_HEADERS.map((source, index) => ({
      name: `field_${index + 1}`,
      source,
      type: "text" as const,
      required: false,
      computed: false,
    }));
    expect(moduleRequiresFrontProfitStandard({ columns })).toBe(true);
    expect(moduleRequiresFrontProfitStandard({
      columns: columns.slice(0, -1),
    })).toBe(false);
    expect(moduleRequiresFrontProfitStandard({
      dataContract: FRONT_PROFIT_STANDARD_SCHEMA_VERSION,
      columns: columns.slice(0, 1),
    })).toBe(true);
  });

  test("rejects a narrow generic workbook when the selected target module requires the profit contract", async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ["日期", "店铺", "运营", "GMV", "单量", "前台利润"],
      ["2098-01-01", "合成店铺", "合成运营", 100, 1, 10],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "generic");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    await expect(importExcel(
      bytes,
      "generic-six-column.xlsx",
      "generic six-column",
      "file",
      false,
      null,
      "renamed_profit_module",
      FRONT_PROFIT_STANDARD_SCHEMA_VERSION,
    )).rejects.toMatchObject({
      issues: [{ code: "FRONT_PROFIT_CONTRACT_REQUIRED" }],
    });
    expect(persistence.insert).not.toHaveBeenCalled();
    expect(persistence.begin).not.toHaveBeenCalled();
    expect(persistence.unsafe).not.toHaveBeenCalled();
  });

  test("does not impose the profit contract on an ordinary module import", async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ["日期", "店铺", "运营", "GMV", "单量", "利润"],
      ["2098-01-01", "合成店铺", "合成运营", 100, 1, 10],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "generic");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const result = await importExcel(
      bytes,
      "ordinary-module.xlsx",
      "ordinary module",
      "file",
      false,
      null,
      "ordinary_module",
    );
    expect(result.frontProfitValidation).toBeUndefined();
    expect(persistence.insert).not.toHaveBeenCalled();
    expect(persistence.begin).toHaveBeenCalledTimes(1);
    expect(persistence.transactionQueryLog[0]).toBe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    );
    expect(persistence.transactionQueryParameters[0]).toEqual([
      "ec-data-platform:file-import:ordinary-module.xlsx",
    ]);
    expect(persistence.transactionQueryLog[1]).toContain(
      "config->>'originalFileName' = $1",
    );
    expect(persistence.transactionQueryParameters[1]).toEqual(["ordinary-module.xlsx"]);
  });

  test("rolls back an atomic same-name generic replacement when the second data batch fails", async () => {
    const originalSource = {
      id: 98,
      type: "file",
      config: { originalFileName: "atomic-generic.xlsx", role: "file" },
    };
    persistence.existingSources = [originalSource];
    const rows = Array.from({ length: 201 }, (_, index) => [
      `2098-01-${String((index % 28) + 1).padStart(2, "0")}`,
      `SYNTHETIC_SKU_${String(index).padStart(3, "0")}`,
      index,
    ]);
    const sheet = XLSX.utils.aoa_to_sheet([
      ["日期", "SKU", "金额"],
      ...rows,
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "generic");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    let batch = 0;
    persistence.unsafe.mockImplementation(async (query: unknown) => {
      if (String(query).startsWith('INSERT INTO "user_data"."uf_700"')) {
        batch += 1;
        if (batch === 2) throw new Error("synthetic generic second batch failure");
      }
      return [];
    });

    await expect(importExcel(
      bytes,
      "folder\\atomic-generic.xlsx",
      "atomic generic replacement",
      "file",
      true,
    )).rejects.toThrow("synthetic generic second batch failure");

    expect(batch).toBe(2);
    expect(persistence.begin).toHaveBeenCalledTimes(1);
    expect(persistence.transactionQueryLog[0]).toBe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    );
    expect(persistence.transactionQueryParameters[0]).toEqual([
      "ec-data-platform:file-import:atomic-generic.xlsx",
    ]);
    expect(persistence.transactionQueryLog[1]).toContain(
      "config->>'originalFileName' = $1",
    );
    expect(persistence.transactionQueryParameters[1]).toEqual(["atomic-generic.xlsx"]);
    expect(persistence.existingSources).toEqual([originalSource]);
  });

  test("runs the front-profit gate before any import database write", async () => {
    const invalid = validRecords()[0]!;
    invalid.前台利润 = Number(invalid.前台利润) + 1;
    const sheet = XLSX.utils.aoa_to_sheet([
      [...FRONT_PROFIT_STANDARD_HEADERS],
      rowFromRecord(invalid),
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "前台利润标准数据");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    await expect(importExcel(
      bytes,
      "synthetic-front-profit-standard.xlsx",
      "Synthetic front-profit standard",
    )).rejects.toBeInstanceOf(FrontProfitValidationError);
    expect(persistence.insert).not.toHaveBeenCalled();
    expect(persistence.unsafe).not.toHaveBeenCalled();
  });

  test("rejects manual front-profit upload when the period authority is auto", async () => {
    const record = validRecords()[0]!;
    const period = periodForRecord(record);
    persistence.periodAuthorities.set(persistedAuthorityKey(period), {
      authority: "auto",
      close_day: 5,
      reopened_at: null,
    });

    await expect(importExcel(
      workbookBytes([record]),
      "manual-after-cutover-front-profit-standard.xlsx",
      "manual after cutover",
    )).rejects.toMatchObject({
      issues: [{ code: "FRONT_PROFIT_PERIOD_AUTHORITY_AUTO", field: period }],
    });

    expect(persistence.transactionQueryLog).not.toContain(
      "SELECT id, config FROM public.data_sources WHERE type = 'file' ORDER BY id",
    );
    expect(persistence.transactionSourceInsertCount).toBe(0);
  });

  test("rejects closed-period manual upload unless the period is reopened", async () => {
    const record = validRecords()[0]!;
    const period = periodForRecord(record);

    await expect(importExcel(
      workbookBytes([record]),
      "closed-front-profit-standard.xlsx",
      "closed period",
      "file",
      false,
      null,
      null,
      null,
      { today: frontProfitCloseDate(period) },
    )).rejects.toMatchObject({
      issues: [{ code: "FRONT_PROFIT_PERIOD_CLOSED", field: period }],
    });
    expect(persistence.transactionSourceInsertCount).toBe(0);

    persistence.periodAuthorities.set(persistedAuthorityKey(period), {
      authority: "manual",
      close_day: 5,
      reopened_at: new Date("2098-02-06T00:00:00.000Z"),
    });
    await expect(importExcel(
      workbookBytes([record]),
      "reopened-front-profit-standard.xlsx",
      "reopened period",
      "file",
      false,
      null,
      null,
      null,
      { today: frontProfitCloseDate(period) },
    )).resolves.toMatchObject({ sourceId: 700 });
  });

  test("preserves a leading-zero long record ID through XLSX parsing and SQL parameters", async () => {
    const record = validRecords().at(-1)!;
    const sheet = XLSX.utils.aoa_to_sheet([
      [...FRONT_PROFIT_STANDARD_HEADERS],
      rowFromRecord(record),
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "前台利润标准数据");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const result = await importExcel(
      bytes,
      "synthetic-front-profit-standard.xlsx",
      "Synthetic front-profit standard",
    );

    expect(result.frontProfitValidation).toMatchObject({
      schemaVersion: "front-profit-standard/v1",
      businessRowCount: 1,
      warningCount: 0,
    });
    const insertCall = persistence.unsafe.mock.calls.find(([query]) =>
      String(query).startsWith('INSERT INTO "user_data"."uf_700"'),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall?.[1]).toContain("000000000000000000000123456789");
  });

  test("surfaces promotion-orphan and negative warnings in the imported status and sanitized summary", async () => {
    const promotionOrphan = validRecords()[2]!;
    const negative = validRecords()[3]!;
    promotionOrphan.数据状态 = "原状态A";
    negative.数据状态 = "原状态B";
    const sheet = XLSX.utils.aoa_to_sheet([
      [...FRONT_PROFIT_STANDARD_HEADERS],
      rowFromRecord(promotionOrphan),
      rowFromRecord(negative),
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "前台利润标准数据");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const result = await importExcel(bytes, "front-profit-standard-warning.xlsx", "warning case");
    expect(result.frontProfitValidation?.warningCodes).toEqual(
      expect.arrayContaining(["PROMOTION_ORPHAN", "NEGATIVE_QUANTITY", "NEGATIVE_VALUE"]),
    );
    const insertCall = persistence.unsafe.mock.calls.find(([query]) =>
      String(query).startsWith('INSERT INTO "user_data"."uf_700"'),
    );
    const params = insertCall?.[1] as unknown[];
    const statusIndex = FRONT_PROFIT_STANDARD_HEADERS.indexOf("数据状态");
    expect(params[statusIndex]).toBe("原状态A；推广孤儿（保留）");
    expect(params[FRONT_PROFIT_STANDARD_HEADERS.length + statusIndex]).toBe("原状态B；负数待复核");
    expect(persistence.transactionSourceConfigs).toHaveLength(1);
    const storedConfig = persistence.transactionSourceConfigs[0]!;
    expect(storedConfig.frontProfitValidation).toEqual({
      schemaVersion: "front-profit-standard/v1",
      businessRowCount: 2,
      warningCount: 12,
      warningCodes: ["NEGATIVE_QUANTITY", "NEGATIVE_VALUE", "PROMOTION_ORPHAN"],
    });
    const summaryJson = JSON.stringify(storedConfig.frontProfitValidation);
    expect(summaryJson).not.toMatch(/SYNTHETIC_AD_ORPHAN|合成店铺|合成运营|amount|record_id|shop|operator/);
  });

  test("rejects a renamed cross-file duplicate before creating a new source", async () => {
    const record = validRecords()[0]!;
    persistence.existingSources = [{
      id: 99,
      type: "file",
      config: {
        originalFileName: "previous-name.xlsx",
        frontProfitValidation: { schemaVersion: "front-profit-standard/v1" },
        columns: FRONT_PROFIT_STANDARD_HEADERS.map((raw) => ({ raw, name: raw.replaceAll("/", "_") })),
      },
    }];
    persistence.unsafe.mockImplementation(async (query: unknown) => {
      if (String(query).includes("information_schema.tables")) return [{ exists: 1 }];
      if (String(query).startsWith("SELECT")) {
        return [{
          record_id: record.record_id,
          date: record.日期,
          platform: record.平台,
          business_mode: record.业务模式,
          shop: record.店铺,
          operator: record.运营,
        }];
      }
      return [];
    });
    const sheet = XLSX.utils.aoa_to_sheet([
      [...FRONT_PROFIT_STANDARD_HEADERS],
      rowFromRecord(record),
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "前台利润标准数据");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    await expect(importExcel(bytes, "renamed-standard.xlsx", "duplicate"))
      .rejects.toBeInstanceOf(FrontProfitValidationError);
    expect(persistence.insert).not.toHaveBeenCalled();
    expect(persistence.unsafe.mock.calls.some(([query]) => String(query).startsWith("CREATE TABLE")))
      .toBe(false);
  });

  test.each([
    ["record ID", "DUPLICATE_RECORD_ID_EXISTING", (record: Record<string, unknown>) => ({
      record_id: record.record_id,
      date: record.日期,
      platform: record.平台,
      business_mode: record.业务模式,
      shop: record.店铺,
      operator: "合成运营-不同键",
    })],
    ["aggregation key", "DUPLICATE_AGGREGATION_KEY_EXISTING", (record: Record<string, unknown>) => ({
      record_id: "SYNTHETIC_DIFFERENT_EXISTING_ID",
      date: record.日期,
      platform: record.平台,
      business_mode: record.业务模式,
      shop: record.店铺,
      operator: record.运营,
    })],
  ])("rejects an existing cross-file %s collision independently", async (_name, code, storedRow) => {
    const record = validRecords()[0]!;
    persistence.existingSources = [{
      id: 99,
      type: "file",
      config: {
        originalFileName: "previous-name.xlsx",
        frontProfitValidation: { schemaVersion: "front-profit-standard/v1" },
        columns: FRONT_PROFIT_STANDARD_HEADERS.map((raw) => ({ raw, name: raw.replaceAll("/", "_") })),
      },
    }];
    persistence.unsafe.mockImplementation(async (query: unknown) => {
      if (String(query).includes("information_schema.tables")) return [{ exists: 1 }];
      if (String(query).startsWith("SELECT")) return [storedRow(record)];
      return [];
    });

    let failure: unknown;
    try {
      await importExcel(workbookBytes([record]), `renamed-${String(_name)}.xlsx`, "independent collision");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(FrontProfitValidationError);
    const codes = (failure as FrontProfitValidationError).issues.map((issue) => issue.code);
    expect(codes).toContain(code);
    expect(codes).not.toContain(
      code === "DUPLICATE_RECORD_ID_EXISTING"
        ? "DUPLICATE_AGGREGATION_KEY_EXISTING"
        : "DUPLICATE_RECORD_ID_EXISTING",
    );
  });

  test("skips existing front-profit sources only when period metadata proves they are outside scope", async () => {
    const record = validRecords()[0]!;
    persistence.existingSources = [{
      id: 99,
      type: "file",
      config: {
        originalFileName: "other-period-front-profit-standard.xlsx",
        frontProfitValidation: { schemaVersion: "front-profit-standard/v1" },
        frontProfitScopeKeys: ["front_profit:2098-02"],
        columns: FRONT_PROFIT_STANDARD_HEADERS.map((raw) => ({ raw, name: raw.replaceAll("/", "_") })),
      },
    }];
    persistence.unsafe.mockImplementation(async (query: unknown) => {
      if (String(query).includes("information_schema.tables")) {
        throw new Error("out-of-scope source should not be scanned");
      }
      return [];
    });

    await expect(importExcel(
      workbookBytes([record]),
      "scoped-front-profit-standard.xlsx",
      "scoped import",
    )).resolves.toMatchObject({ sourceId: 700 });
  });

  test("ignores auto publish source identities unless the matching version is published", async () => {
    const record = validRecords()[0]!;
    persistence.existingSources = [{
      id: 99,
      type: "file",
      config: {
        originalFileName: "superseded-auto-front-profit-standard.xlsx",
        frontProfitValidation: { schemaVersion: "front-profit-standard/v1" },
        frontProfitAuthority: "auto",
        frontProfitScopeKeys: [frontProfitScopeKey(periodForRecord(record))],
        columns: FRONT_PROFIT_STANDARD_HEADERS.map((raw) => ({ raw, name: raw.replaceAll("/", "_") })),
      },
    }];
    persistence.unsafe.mockImplementation(async (query: unknown) => {
      const text = String(query);
      if (text.includes("publish_version_source")) {
        return [{
          source_id: 99,
          scope_key: frontProfitScopeKey(periodForRecord(record)),
          status: "superseded",
        }];
      }
      if (text.includes("information_schema.tables")) {
        throw new Error("superseded auto publish source should not be scanned");
      }
      return [];
    });

    await expect(importExcel(
      workbookBytes([record]),
      "after-superseded-auto-front-profit-standard.xlsx",
      "after superseded auto",
    )).resolves.toMatchObject({ sourceId: 700 });
  });

  test("keeps published auto publish source identities in the duplicate boundary", async () => {
    const record = validRecords()[0]!;
    persistence.existingSources = [{
      id: 99,
      type: "file",
      config: {
        originalFileName: "published-auto-front-profit-standard.xlsx",
        frontProfitValidation: { schemaVersion: "front-profit-standard/v1" },
        frontProfitAuthority: "auto",
        frontProfitScopeKeys: [frontProfitScopeKey(periodForRecord(record))],
        columns: FRONT_PROFIT_STANDARD_HEADERS.map((raw) => ({ raw, name: raw.replaceAll("/", "_") })),
      },
    }];
    persistence.unsafe.mockImplementation(async (query: unknown) => {
      const text = String(query);
      if (text.includes("publish_version_source")) {
        return [{
          source_id: 99,
          scope_key: frontProfitScopeKey(periodForRecord(record)),
          status: "published",
        }];
      }
      if (text.includes("information_schema.tables")) return [{ exists: 1 }];
      if (text.startsWith("SELECT")) {
        return [{
          record_id: record.record_id,
          date: record.日期,
          platform: record.平台,
          business_mode: record.业务模式,
          shop: record.店铺,
          operator: record.运营,
        }];
      }
      return [];
    });

    await expect(importExcel(
      workbookBytes([record]),
      "after-published-auto-front-profit-standard.xlsx",
      "after published auto",
    )).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "DUPLICATE_RECORD_ID_EXISTING" }),
      ]),
    });
  });

  test("blocks same-name replacement when the old source is referenced by a published version", async () => {
    const record = validRecords()[0]!;
    const originalSource = {
      id: 99,
      type: "file",
      config: {
        originalFileName: "published-front-profit-standard.xlsx",
        frontProfitValidation: { schemaVersion: "front-profit-standard/v1" },
        columns: FRONT_PROFIT_STANDARD_HEADERS.map((raw) => ({ raw, name: raw.replaceAll("/", "_") })),
      },
    };
    persistence.existingSources = [originalSource];
    persistence.unsafe.mockImplementation(async (query: unknown) => {
      const text = String(query);
      if (text.includes("publish_version_source")) {
        return [{
          publish_version_id: 3,
          module_code: "front_profit",
          scope_key: "front_profit:2098-01",
          version_no: 1,
        }];
      }
      return [];
    });

    await expect(importExcel(
      workbookBytes([record]),
      "published-front-profit-standard.xlsx",
      "published replacement",
      "file",
      true,
    )).rejects.toBeInstanceOf(FileSourceDeleteBlockedError);
    expect(persistence.existingSources).toEqual([originalSource]);
    expect(persistence.transactionSourceInsertCount).toBe(0);
  });

  test("allows an atomic same-name replacement while excluding the source being replaced", async () => {
    const record = validRecords()[0]!;
    persistence.existingSources = [{
      id: 99,
      type: "file",
      config: {
        originalFileName: "same-front-profit-standard.xlsx",
        frontProfitValidation: { schemaVersion: "front-profit-standard/v1" },
        columns: FRONT_PROFIT_STANDARD_HEADERS.map((raw) => ({ raw, name: raw.replaceAll("/", "_") })),
      },
    }];

    const result = await importExcel(
      workbookBytes([record]),
      "same-front-profit-standard.xlsx",
      "same-name replacement",
      "file",
      true,
    );

    expect(result.sourceId).toBe(700);
    expect(persistence.existingSources.map((source) => source.id)).toEqual([700]);
    expect(persistence.begin).toHaveBeenCalledTimes(1);
    expect(persistence.transactionQueryLog[0]).toBe(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
    );
    expect(persistence.transactionQueryLog).toContain(
      "SELECT id, config FROM public.data_sources WHERE type = 'file' ORDER BY id",
    );
    expect(persistence.transactionQueryLog.findIndex((query) =>
      query.startsWith("SELECT authority, close_day, reopened_at"),
    )).toBeLessThan(
      persistence.transactionQueryLog.indexOf(
        "SELECT id, config FROM public.data_sources WHERE type = 'file' ORDER BY id",
      ),
    );
  });

  test("canonicalizes an XLSX date-time before SQL persistence and cross-file key comparison", async () => {
    const first = validRecords()[0]!;
    first.日期 = new Date(2098, 0, 1, 15, 30, 45);
    let firstInsertParams: unknown[] | undefined;
    persistence.unsafe.mockImplementation(async (query: unknown, parameters?: unknown[]) => {
      if (String(query).startsWith('INSERT INTO "user_data"."uf_700"')) {
        firstInsertParams = parameters;
      }
      return [];
    });
    await importExcel(workbookBytes([first]), "date-time-front-profit-standard.xlsx", "date-time");
    const dateIndex = FRONT_PROFIT_STANDARD_HEADERS.indexOf("日期");
    expect(firstInsertParams?.[dateIndex]).toBe("2098-01-01");

    const second = validRecords()[0]!;
    second.record_id = "SYNTHETIC_SECOND_FILE_DIFFERENT_ID";
    second.日期 = "2098-01-01";
    persistence.unsafe.mockImplementation(async (query: unknown) => {
      const text = String(query);
      if (text.includes("information_schema.tables")) return [{ exists: 1 }];
      if (text.startsWith("SELECT")) {
        return [{
          record_id: first.record_id,
          date: firstInsertParams?.[dateIndex],
          platform: first.平台,
          business_mode: first.业务模式,
          shop: first.店铺,
          operator: first.运营,
        }];
      }
      return [];
    });
    await expect(importExcel(
      workbookBytes([second]),
      "date-string-renamed-front-profit-standard.xlsx",
      "date string",
    )).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "DUPLICATE_AGGREGATION_KEY_EXISTING" }),
      ]),
    });
  });

  test("rolls back an atomic replacement when a later front-profit batch fails", async () => {
    const records = Array.from({ length: 201 }, (_, index) => {
      const record = validRecords()[0]!;
      record.record_id = `SYNTHETIC_BATCH_${String(index).padStart(3, "0")}`;
      record.店铺 = `合成批次店铺-${index}`;
      return record;
    });
    const originalSource = {
      id: 99,
      type: "file",
      config: {
        originalFileName: "atomic-front-profit-standard.xlsx",
        frontProfitValidation: { schemaVersion: "front-profit-standard/v1" },
        columns: FRONT_PROFIT_STANDARD_HEADERS.map((raw) => ({ raw, name: raw.replaceAll("/", "_") })),
      },
    };
    persistence.existingSources = [originalSource];
    let batch = 0;
    persistence.unsafe.mockImplementation(async (query: unknown) => {
      if (String(query).startsWith('INSERT INTO "user_data"."uf_700"')) {
        batch += 1;
        if (batch === 2) throw new Error("synthetic second batch failure");
      }
      return [];
    });

    await expect(importExcel(
      workbookBytes(records),
      "atomic-front-profit-standard.xlsx",
      "atomic replacement",
      "file",
      true,
    )).rejects.toThrow("synthetic second batch failure");
    expect(batch).toBe(2);
    expect(persistence.existingSources).toEqual([originalSource]);
  });

  test("serializes concurrent differently named standard uploads so only one duplicate can persist", async () => {
    const record = validRecords()[0]!;
    const sheet = XLSX.utils.aoa_to_sheet([
      [...FRONT_PROFIT_STANDARD_HEADERS],
      rowFromRecord(record),
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "前台利润标准数据");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    persistence.unsafe.mockImplementation(async (query: unknown) => {
      const text = String(query);
      if (text.includes("information_schema.tables")) return [{ exists: 1 }];
      if (text.startsWith("SELECT") && text.includes('"uf_700"')) {
        return [{
          record_id: record.record_id,
          date: record.日期,
          platform: record.平台,
          business_mode: record.业务模式,
          shop: record.店铺,
          operator: record.运营,
        }];
      }
      return [];
    });

    const settled = await Promise.allSettled([
      importExcel(bytes, "concurrent-a-front-profit-standard.xlsx", "concurrent A"),
      importExcel(bytes, "concurrent-b-front-profit-standard.xlsx", "concurrent B"),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(FrontProfitValidationError);
    expect(persistence.transactionSourceInsertCount).toBe(1);
    expect(persistence.advisoryLockCount).toBe(2);
  });

  test("blocks the 02 preparation workbook instead of silently importing its instruction sheet", async () => {
    const sheet = XLSX.utils.aoa_to_sheet([["字段", "说明", "示例"], ["SKU", "文本", "0001"]]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "说明");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    await expect(importExcel(
      bytes,
      "02-电商前台利润数据准备与映射模板.xlsx",
      "preparation workbook",
    )).rejects.toBeInstanceOf(FrontProfitValidationError);
    expect(persistence.insert).not.toHaveBeenCalled();
  });
});
