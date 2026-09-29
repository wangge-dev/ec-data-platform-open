export const FRONT_PROFIT_BUSINESS_RULE_VERSION = "front-profit-business-rules/v1" as const;

export const FRONT_PROFIT_REBATE_KEY_POLICY = {
  keyField: "rebate_key",
  attributionDate: "rebate_event_date",
  duplicate: "block",
} as const;

export const FRONT_PROFIT_COST_MATCH_DATE_ROLE = "shipment_date" as const;

export const FRONT_PROFIT_FEE_KINDS = [
  "platform_fee",
  "tax_fee",
  "finance_cost",
  "freight",
  "commission",
  "promotion_fee",
] as const;

export const FRONT_PROFIT_FEE_AUTHORITY_PRIORITY = [
  "settlement",
  "platform_bill",
  "rate_rule",
  "manual_estimate",
] as const;

export const FRONT_PROFIT_OPERATOR_AUTHORITY_KEY_PRIORITY = [
  "sku",
  "ad_account",
  "product_owner",
  "order_owner",
  "manual_mapping",
] as const;

export type FrontProfitFeeKind = typeof FRONT_PROFIT_FEE_KINDS[number];
export type FrontProfitFeeAuthoritySource = typeof FRONT_PROFIT_FEE_AUTHORITY_PRIORITY[number];
export type FrontProfitOperatorAuthorityKeyType = typeof FRONT_PROFIT_OPERATOR_AUTHORITY_KEY_PRIORITY[number];

export type FrontProfitFeeCandidate = {
  feeKind: FrontProfitFeeKind;
  authoritySource: FrontProfitFeeAuthoritySource;
  amount: number;
  feeKey?: string;
};

export type FrontProfitOperatorAssignment = {
  shop: string;
  authorityKeyType: FrontProfitOperatorAuthorityKeyType;
  authorityKey: string;
  operator: string;
  effectiveFrom: string;
  effectiveTo: string;
};

export type FrontProfitOperatorResolutionInput = {
  shop: string;
  date: string;
  skuKey?: string | null;
  adAccountKey?: string | null;
  productOwnerKey?: string | null;
  orderOwnerKey?: string | null;
  manualMappingKey?: string | null;
};

export type FrontProfitCostPeriod = {
  skuKey: string;
  costKind?: "product_cost";
  effectiveFrom: string;
  effectiveTo: string;
  unitCost: number;
};

export type FrontProfitRebateFactIdentity = {
  rebateKey: string;
  rowNumber?: number;
};

export class FrontProfitBusinessRuleBlockError extends Error {
  constructor(
    public readonly code:
      | "REBATE_KEY_DUPLICATE"
      | "FEE_AUTHORITY_MISSING"
      | "OWNER_MISSING"
      | "OWNER_AMBIGUOUS"
      | "COST_PERIOD_MISSING"
      | "COST_PERIOD_OVERLAP",
    public readonly evidence: Record<string, unknown> = {},
  ) {
    super(`front-profit business rule blocked: ${code}`);
    this.name = "FrontProfitBusinessRuleBlockError";
  }
}

function assertIsoDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD`);
  }
  return value;
}

function normalizedText(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function includesDate(value: string, range: { effectiveFrom: string; effectiveTo: string }): boolean {
  const date = assertIsoDate(value, "date");
  const effectiveFrom = assertIsoDate(range.effectiveFrom, "effectiveFrom");
  const effectiveTo = assertIsoDate(range.effectiveTo, "effectiveTo");
  return effectiveFrom <= date && date <= effectiveTo;
}

export function assertUniqueFrontProfitRebateKeys(rows: FrontProfitRebateFactIdentity[]): void {
  const seen = new Map<string, FrontProfitRebateFactIdentity>();
  for (const row of rows) {
    const rebateKey = normalizedText(row.rebateKey);
    if (!rebateKey) {
      throw new Error("rebateKey is required");
    }
    const existing = seen.get(rebateKey);
    if (existing) {
      throw new FrontProfitBusinessRuleBlockError("REBATE_KEY_DUPLICATE", {
        rebateKey,
        firstRowNumber: existing.rowNumber,
        rowNumber: row.rowNumber,
      });
    }
    seen.set(rebateKey, row);
  }
}

export function selectAuthoritativeFrontProfitFeeSource(
  candidates: FrontProfitFeeCandidate[],
  feeKind: FrontProfitFeeKind,
): FrontProfitFeeAuthoritySource {
  const scoped = candidates.filter((candidate) => candidate.feeKind === feeKind);
  for (const authoritySource of FRONT_PROFIT_FEE_AUTHORITY_PRIORITY) {
    if (scoped.some((candidate) => candidate.authoritySource === authoritySource)) {
      return authoritySource;
    }
  }
  throw new FrontProfitBusinessRuleBlockError("FEE_AUTHORITY_MISSING", { feeKind });
}

function authorityKeyForInput(
  input: FrontProfitOperatorResolutionInput,
  keyType: FrontProfitOperatorAuthorityKeyType,
): string | null {
  const key = {
    sku: input.skuKey,
    ad_account: input.adAccountKey,
    product_owner: input.productOwnerKey,
    order_owner: input.orderOwnerKey,
    manual_mapping: input.manualMappingKey,
  }[keyType];
  const normalized = normalizedText(key);
  return normalized || null;
}

function operatorAssignmentLookupKey(input: {
  shop: string;
  authorityKeyType: FrontProfitOperatorAuthorityKeyType;
  authorityKey: string;
}): string {
  return [input.shop, input.authorityKeyType, input.authorityKey].join("\u001f");
}

export function createFrontProfitOperatorResolver(
  assignments: FrontProfitOperatorAssignment[],
): (input: FrontProfitOperatorResolutionInput) => FrontProfitOperatorAssignment {
  const grouped = new Map<string, FrontProfitOperatorAssignment[]>();
  for (const assignment of assignments) {
    const key = operatorAssignmentLookupKey(assignment);
    grouped.set(key, [...(grouped.get(key) ?? []), assignment]);
  }

  return (input) => {
    for (const authorityKeyType of FRONT_PROFIT_OPERATOR_AUTHORITY_KEY_PRIORITY) {
      const authorityKey = authorityKeyForInput(input, authorityKeyType);
      if (!authorityKey) continue;
      const key = operatorAssignmentLookupKey({
        shop: input.shop,
        authorityKeyType,
        authorityKey,
      });
      const matches = (grouped.get(key) ?? []).filter((assignment) => includesDate(input.date, assignment));
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) {
        throw new FrontProfitBusinessRuleBlockError("OWNER_AMBIGUOUS", {
          shop: input.shop,
          date: input.date,
          authorityKeyType,
          authorityKey,
          operators: [...new Set(matches.map((match) => match.operator))].sort(),
        });
      }
    }

    throw new FrontProfitBusinessRuleBlockError("OWNER_MISSING", {
      shop: input.shop,
      date: input.date,
    });
  };
}

export function resolveFrontProfitOperator(
  input: FrontProfitOperatorResolutionInput,
  assignments: FrontProfitOperatorAssignment[],
): FrontProfitOperatorAssignment {
  return createFrontProfitOperatorResolver(assignments)(input);
}

function costPeriodLookupKey(input: {
  skuKey: string;
  costKind?: "product_cost";
}): string {
  return [input.skuKey, input.costKind ?? "product_cost"].join("\u001f");
}

export function createFrontProfitCostPeriodResolver(
  periods: FrontProfitCostPeriod[],
): (input: { skuKey: string; shipmentDate: string; costKind?: "product_cost" }) => FrontProfitCostPeriod {
  const grouped = new Map<string, FrontProfitCostPeriod[]>();
  for (const period of periods) {
    const key = costPeriodLookupKey(period);
    grouped.set(key, [...(grouped.get(key) ?? []), period]);
  }

  return (input) => {
    const costKind = input.costKind ?? "product_cost";
    const matches = (grouped.get(costPeriodLookupKey({ skuKey: input.skuKey, costKind })) ?? [])
      .filter((period) => includesDate(input.shipmentDate, period));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new FrontProfitBusinessRuleBlockError("COST_PERIOD_OVERLAP", {
        skuKey: input.skuKey,
        shipmentDate: input.shipmentDate,
        costKind,
        matches: matches.map((match) => ({
          effectiveFrom: match.effectiveFrom,
          effectiveTo: match.effectiveTo,
        })),
      });
    }
    throw new FrontProfitBusinessRuleBlockError("COST_PERIOD_MISSING", {
      skuKey: input.skuKey,
      shipmentDate: input.shipmentDate,
      costKind,
    });
  };
}

export function selectFrontProfitCostPeriod(
  input: {
    skuKey: string;
    shipmentDate: string;
    costKind?: "product_cost";
  },
  periods: FrontProfitCostPeriod[],
): FrontProfitCostPeriod {
  return createFrontProfitCostPeriodResolver(periods)(input);
}
