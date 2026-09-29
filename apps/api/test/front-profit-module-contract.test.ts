import { describe, expect, test, vi } from "vitest";
import type { ModuleDef } from "../src/modules/schema.js";
import {
  assertFrontProfitModuleContractValid,
  FRONT_PROFIT_STANDARD_HEADERS,
  FRONT_PROFIT_STANDARD_SCHEMA_VERSION,
  isFrontProfitModuleContractValid,
  isValidatedFrontProfitSourceConfig,
  moduleRequiresFrontProfitStandard,
} from "../src/services/front-profit-standard.js";
import {
  buildModuleDef,
  ModuleBuilderInputError,
  assignAndRunSources,
} from "../src/services/module-builder.js";

function profitModule(): ModuleDef {
  return {
    code: "renamed_profit_module",
    name: "任意重命名模块",
    description: "synthetic contract test",
    columns: FRONT_PROFIT_STANDARD_HEADERS.map((source, index) => ({
      name: `field_${index + 1}`,
      source,
      type: "text" as const,
      required: false,
      computed: false,
    })),
    platforms: [{
      code: "generic",
      name: "通用",
      filePattern: "profit",
      patternFlags: "i",
      enabled: true,
    }],
    usages: ["summary"],
    enabled: true,
    hasTransform: false,
    isDict: false,
  };
}

function inspection(dataContract: typeof FRONT_PROFIT_STANDARD_SCHEMA_VERSION | null) {
  return {
    sourceIds: [701],
    compatible: true,
    headers: [...FRONT_PROFIT_STANDARD_HEADERS],
    samples: [],
    filenamePhrase: "profit",
    dataContract,
    statusValues: [],
    inferredTypes: {},
    differences: [],
  };
}

describe("front-profit module source contract", () => {
  test("requires the explicit contract flag to retain the exact 28 source mappings", () => {
    const missing = profitModule();
    missing.dataContract = FRONT_PROFIT_STANDARD_SCHEMA_VERSION;
    missing.columns = missing.columns.slice(0, -1);
    expect(moduleRequiresFrontProfitStandard(missing)).toBe(true);
    expect(isFrontProfitModuleContractValid(missing)).toBe(false);
    expect(() => assertFrontProfitModuleContractValid(missing)).toThrow(/28/);

    const duplicate = profitModule();
    duplicate.dataContract = FRONT_PROFIT_STANDARD_SCHEMA_VERSION;
    duplicate.columns[27].source = FRONT_PROFIT_STANDARD_HEADERS[0];
    expect(isFrontProfitModuleContractValid(duplicate)).toBe(false);

    const changed = profitModule();
    changed.dataContract = FRONT_PROFIT_STANDARD_SCHEMA_VERSION;
    changed.columns[27].source = "伪造来源列";
    expect(isFrontProfitModuleContractValid(changed)).toBe(false);

    const ordinary = profitModule();
    ordinary.columns = ordinary.columns.slice(0, 3);
    expect(moduleRequiresFrontProfitStandard(ordinary)).toBe(false);
    expect(isFrontProfitModuleContractValid(ordinary)).toBe(true);
  });

  test("rejects initial module creation when a validated source is mapped to only three columns", () => {
    expect(() => buildModuleDef({
      name: "synthetic incomplete profit",
      sourceIds: [701],
      filenamePhrase: "profit",
      mappings: [
        { semanticRole: "time", source: "日期", label: "日期", type: "date", required: true },
        { semanticRole: "amount", source: "GMV", label: "GMV", type: "numeric", required: true },
        { semanticRole: "quantity", source: "单量", label: "单量", type: "int", required: true },
      ],
      additionalFields: [],
      idempotencyKey: "synthetic-incomplete-profit",
    }, inspection(FRONT_PROFIT_STANDARD_SCHEMA_VERSION))).toThrow(ModuleBuilderInputError);
  });

  test("accepts only a complete server summary tied to the exact stored 28-column source", () => {
    const config = {
      rowCount: 1,
      columns: FRONT_PROFIT_STANDARD_HEADERS.map((raw, index) => ({
        raw,
        name: `field_${index + 1}`,
      })),
      frontProfitValidation: {
        schemaVersion: FRONT_PROFIT_STANDARD_SCHEMA_VERSION,
        businessRowCount: 1,
        warningCount: 0,
        warningCodes: [],
      },
    };
    expect(isValidatedFrontProfitSourceConfig(config)).toBe(true);
    expect(isValidatedFrontProfitSourceConfig({
      frontProfitValidation: { schemaVersion: FRONT_PROFIT_STANDARD_SCHEMA_VERSION },
    })).toBe(false);
    expect(isValidatedFrontProfitSourceConfig({
      ...config,
      rowCount: 2,
    })).toBe(false);
    expect(isValidatedFrontProfitSourceConfig({
      ...config,
      frontProfitValidation: {
        ...config.frontProfitValidation,
        record_id: "forged",
      },
    })).toBe(false);
  });

  test("rejects assignment before mutation when a source lacks the validated contract", async () => {
    const assignSource = vi.fn();
    const runEtl = vi.fn();
    await expect(assignAndRunSources(
      "renamed_profit_module",
      [701],
      {
        assignSource,
        runEtl,
        inspectSources: vi.fn(async () => inspection(null)),
      },
      { module: profitModule() },
    )).rejects.toBeInstanceOf(ModuleBuilderInputError);
    expect(assignSource).not.toHaveBeenCalled();
    expect(runEtl).not.toHaveBeenCalled();
  });

  test("allows a validated source and preserves the ordinary assignment path", async () => {
    const assignSource = vi.fn(async () => undefined);
    const runEtl = vi.fn(async (sourceId: number) => ({
      platform: "通用",
      sourceId,
      fileName: "synthetic.xlsx",
      total: 1,
      inserted: 1,
      matched: 1,
      matchRate: 1,
    }));
    const result = await assignAndRunSources(
      "renamed_profit_module",
      [701],
      {
        assignSource,
        runEtl,
        inspectSources: vi.fn(async () => inspection(FRONT_PROFIT_STANDARD_SCHEMA_VERSION)),
      },
      { module: profitModule() },
    );
    expect(assignSource).toHaveBeenCalledWith(701, "renamed_profit_module");
    expect(runEtl).toHaveBeenCalledWith(701, { moduleCode: "renamed_profit_module" });
    expect(result.files).toEqual([
      expect.objectContaining({ sourceId: 701, status: "success", inserted: 1 }),
    ]);
  });

  test("does not require inspection for an unrelated ordinary module", async () => {
    const module = profitModule();
    module.columns = module.columns.slice(0, 1);
    const assignSource = vi.fn(async () => undefined);
    const runEtl = vi.fn(async (sourceId: number) => ({
      platform: "通用",
      sourceId,
      fileName: "ordinary.xlsx",
      total: 1,
      inserted: 1,
      matched: 1,
      matchRate: 1,
    }));
    await expect(assignAndRunSources(
      module.code,
      [701],
      { assignSource, runEtl },
      { module },
    )).resolves.toMatchObject({ moduleCode: module.code });
  });
});
