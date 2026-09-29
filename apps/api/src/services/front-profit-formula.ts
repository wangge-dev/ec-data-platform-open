import { validateExpression } from "../lib/sql-guard.js";

export const FRONT_PROFIT_FORMULA_VERSION = "front-profit-formula/v1" as const;

export const FRONT_PROFIT_INTEGER_FIELDS = ["单量", "补单单量"] as const;

export const FRONT_PROFIT_MONEY_INPUT_FIELDS = [
  "GMV",
  "补单金额",
  "补单产品成本",
  "产品成本",
  "出货货值",
  "平台扣点/毛保",
  "税点",
  "财务成本",
  "运费",
  "佣金",
  "推广费",
] as const;

export const FRONT_PROFIT_DERIVED_FIELDS = ["真实营业额", "前台利润", "付费占比"] as const;

export const FRONT_PROFIT_NUMERIC_FIELDS = [
  ...FRONT_PROFIT_INTEGER_FIELDS,
  ...FRONT_PROFIT_MONEY_INPUT_FIELDS,
  ...FRONT_PROFIT_DERIVED_FIELDS,
] as const;

export const FRONT_PROFIT_MONEY_TOLERANCE = 0.0100000001;
export const FRONT_PROFIT_RATIO_TOLERANCE = 0.0001000001;

export type FrontProfitIntegerField = typeof FRONT_PROFIT_INTEGER_FIELDS[number];
export type FrontProfitMoneyInputField = typeof FRONT_PROFIT_MONEY_INPUT_FIELDS[number];
export type FrontProfitFormulaInputField = FrontProfitMoneyInputField;
export type FrontProfitDerivedField = typeof FRONT_PROFIT_DERIVED_FIELDS[number];
export type FrontProfitNumericField = typeof FRONT_PROFIT_NUMERIC_FIELDS[number];
export type FrontProfitDerivedValues = Record<FrontProfitDerivedField, number>;

type FrontProfitLinearTerm = readonly [
  field: FrontProfitFormulaInputField,
  coefficient: 1 | -1,
];

type FrontProfitFormulaExpression =
  | {
    readonly kind: "linear";
    readonly terms: readonly FrontProfitLinearTerm[];
  }
  | {
    readonly kind: "zeroWhenDenominatorZero";
    readonly numerator: FrontProfitFormulaInputField;
    readonly denominator: FrontProfitFormulaInputField;
  };

export type FrontProfitFormulaDefinition = {
  readonly target: FrontProfitDerivedField;
  readonly expression: FrontProfitFormulaExpression;
};

export const FRONT_PROFIT_FORMULA_DEFINITIONS = [
  {
    target: "真实营业额",
    expression: {
      kind: "linear",
      terms: [
        ["GMV", 1],
        ["补单金额", -1],
      ],
    },
  },
  {
    target: "前台利润",
    expression: {
      kind: "linear",
      terms: [
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
      ],
    },
  },
  {
    target: "付费占比",
    expression: {
      kind: "zeroWhenDenominatorZero",
      numerator: "推广费",
      denominator: "GMV",
    },
  },
] as const satisfies readonly FrontProfitFormulaDefinition[];

function evaluateFormulaExpression(
  expression: FrontProfitFormulaExpression,
  value: (field: FrontProfitFormulaInputField) => number,
): number {
  if (expression.kind === "linear") {
    return expression.terms.reduce(
      (total, [field, coefficient]) => total + (coefficient * value(field)),
      0,
    );
  }

  const denominator = value(expression.denominator);
  return denominator === 0 ? 0 : value(expression.numerator) / denominator;
}

export function calculateFrontProfitDerivedValues(
  value: (field: FrontProfitFormulaInputField) => number,
): FrontProfitDerivedValues {
  const values = {} as FrontProfitDerivedValues;
  for (const definition of FRONT_PROFIT_FORMULA_DEFINITIONS) {
    values[definition.target] = evaluateFormulaExpression(definition.expression, value);
  }
  return values;
}

export function quoteFrontProfitFormulaColumn(field: FrontProfitFormulaInputField): string {
  if (field.includes('"')) {
    throw new Error(`front-profit formula field cannot be quoted safely: ${field}`);
  }
  return `"${field}"`;
}

type FrontProfitColumnSql = (field: FrontProfitFormulaInputField) => string;

function renderFormulaExpressionSql(
  expression: FrontProfitFormulaExpression,
  column: FrontProfitColumnSql,
): string {
  if (expression.kind === "linear") {
    const rendered = expression.terms.map(([field, coefficient], index) => {
      const term = column(field);
      if (index === 0) return coefficient < 0 ? `-${term}` : term;
      return `${coefficient < 0 ? "-" : "+"} ${term}`;
    });
    return `(${rendered.join(" ")})`;
  }

  const numerator = column(expression.numerator);
  const denominator = column(expression.denominator);
  return `(CASE WHEN ${denominator} = 0 THEN 0 ELSE ${numerator} / ${denominator} END)`;
}

export function frontProfitFormulaSqlExpressions(
  column: FrontProfitColumnSql = quoteFrontProfitFormulaColumn,
): Record<FrontProfitDerivedField, string> {
  const expressions = {} as Record<FrontProfitDerivedField, string>;
  for (const definition of FRONT_PROFIT_FORMULA_DEFINITIONS) {
    expressions[definition.target] = renderFormulaExpressionSql(definition.expression, column);
  }
  return expressions;
}

export type FrontProfitFormulaSqlValidationResult =
  | { ok: true }
  | { ok: false; field: FrontProfitDerivedField; reason: string };

export function validateFrontProfitFormulaSqlExpressions(
  expressions: Record<FrontProfitDerivedField, string> = frontProfitFormulaSqlExpressions(),
  allowedIdentifiers: Iterable<string> = FRONT_PROFIT_MONEY_INPUT_FIELDS,
): FrontProfitFormulaSqlValidationResult {
  for (const field of FRONT_PROFIT_DERIVED_FIELDS) {
    const validation = validateExpression(expressions[field], allowedIdentifiers);
    if (!validation.ok) {
      return {
        ok: false,
        field,
        reason: validation.reason ?? "front-profit formula SQL expression is invalid",
      };
    }
  }
  return { ok: true };
}
