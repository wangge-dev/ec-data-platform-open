import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { validateExpression } from "../src/lib/sql-guard.js";
import {
  calculateFrontProfitDerivedValues,
  FRONT_PROFIT_DERIVED_FIELDS,
  FRONT_PROFIT_FORMULA_DEFINITIONS,
  FRONT_PROFIT_FORMULA_VERSION,
  FRONT_PROFIT_MONEY_INPUT_FIELDS,
  FRONT_PROFIT_MONEY_TOLERANCE,
  FRONT_PROFIT_RATIO_TOLERANCE,
  frontProfitFormulaSqlExpressions,
  validateFrontProfitFormulaSqlExpressions,
  type FrontProfitFormulaInputField,
} from "../src/services/front-profit-formula.js";

const apiSrc = resolve(import.meta.dirname, "../src");
const formulaSource = "services/front-profit-formula.ts";

function sourceFiles(dir = apiSrc): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

function sourceLocationsContaining(needle: string): string[] {
  return sourceFiles().flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return text
      .split(/\r?\n/)
      .flatMap((line, index) =>
        line.includes(needle) ? [`${relative(apiSrc, path).replaceAll("\\", "/")}:${index + 1}`] : [],
      );
  });
}

describe("front-profit formula single source", () => {
  test("evaluates the accepted v1 formula definitions", () => {
    const input: Record<FrontProfitFormulaInputField, number> = {
      GMV: 1000,
      补单金额: 120,
      补单产品成本: 30,
      产品成本: 200,
      出货货值: 900,
      "平台扣点/毛保": 50,
      税点: 20,
      财务成本: 10,
      运费: 30,
      佣金: 15,
      推广费: 200,
    };

    expect(FRONT_PROFIT_FORMULA_VERSION).toBe("front-profit-formula/v1");
    expect(calculateFrontProfitDerivedValues((field) => input[field])).toEqual({
      真实营业额: 880,
      前台利润: 285,
      付费占比: 0.2,
    });
  });

  test("keeps paid ratio at zero when GMV is zero", () => {
    const input = Object.fromEntries(
      FRONT_PROFIT_MONEY_INPUT_FIELDS.map((field) => [field, 0]),
    ) as Record<FrontProfitFormulaInputField, number>;
    input.推广费 = 99;

    expect(calculateFrontProfitDerivedValues((field) => input[field]).付费占比).toBe(0);
  });

  test("generates SQL expressions accepted by the shared expression guard", () => {
    const expressions = frontProfitFormulaSqlExpressions();

    expect(validateFrontProfitFormulaSqlExpressions(expressions)).toEqual({ ok: true });
    for (const field of FRONT_PROFIT_DERIVED_FIELDS) {
      expect(validateExpression(expressions[field], FRONT_PROFIT_MONEY_INPUT_FIELDS).ok)
        .toBe(true);
    }
    expect(expressions.付费占比).toContain("CASE WHEN");
  });

  test("keeps tolerance literals in the formula source", () => {
    expect(String(FRONT_PROFIT_MONEY_TOLERANCE)).toBe("0.0100000001");
    expect(String(FRONT_PROFIT_RATIO_TOLERANCE)).toBe("0.0001000001");
    expect(sourceLocationsContaining("0.0100000001").map((location) => location.split(":")[0]))
      .toEqual([formulaSource]);
    expect(sourceLocationsContaining("0.0001000001").map((location) => location.split(":")[0]))
      .toEqual([formulaSource]);
  });

  test("keeps the accounting formula definitions in one source file", () => {
    const definitionFiles = sourceLocationsContaining("FRONT_PROFIT_FORMULA_DEFINITIONS")
      .map((location) => location.split(":")[0]);
    expect([...new Set(definitionFiles)]).toEqual([formulaSource]);

    const standardValidator = readFileSync(
      resolve(apiSrc, "services/front-profit-standard.ts"),
      "utf8",
    );
    expect(standardValidator).not.toMatch(/value\("出货货值"\)[\s\S]{0,240}-\s*value\("产品成本"\)/);
    expect(FRONT_PROFIT_FORMULA_DEFINITIONS.map((definition) => definition.target))
      .toEqual([...FRONT_PROFIT_DERIVED_FIELDS]);
  });
});
