import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";

import { calculateFrontProfitDerivedValues } from "../src/services/front-profit-formula.js";
import {
  FRONT_PROFIT_COST_SOURCE_HEADERS,
  FRONT_PROFIT_COST_USAGE_HEADERS,
} from "../src/services/front-profit-cost-source.js";
import { FRONT_PROFIT_FEE_SOURCE_HEADERS } from "../src/services/front-profit-fee-source.js";
import { FRONT_PROFIT_OPERATOR_ASSIGNMENT_HEADERS } from "../src/services/front-profit-operator-source.js";
import { FRONT_PROFIT_PROMOTION_SOURCE_HEADERS } from "../src/services/front-profit-promotion-source.js";
import { FRONT_PROFIT_REBATE_SOURCE_HEADERS } from "../src/services/front-profit-rebate-source.js";
import { FRONT_PROFIT_SALES_SOURCE_HEADERS } from "../src/services/front-profit-sales-source.js";
import { FRONT_PROFIT_STANDARD_HEADERS } from "../src/services/front-profit-standard.js";

type Options = {
  period: string;
  rows: number;
  seed: number;
  outDir: string;
  prefix: string;
};

type BaselineAgg = {
  date: string;
  platform: string;
  businessMode: string;
  groupName: string;
  shop: string;
  shopNormalized: string;
  operator: string;
  quantity: number;
  gmv: number;
  fillOrderAmount: number;
  fillOrderProductCost: number;
  fillOrderQuantity: number;
  productCost: number;
  shipmentValue: number;
  platformFee: number;
  taxFee: number;
  financeCost: number;
  freight: number;
  commission: number;
  promotionFee: number;
};

type SyntheticSaleDimension = Pick<
  BaselineAgg,
  "date" | "platform" | "businessMode" | "groupName" | "shop" | "shopNormalized" | "operator"
> & {
  sku: string;
  adAccount: string;
};

type FixtureFile = {
  role: string;
  name: string;
  rows: number;
};

const DEFAULTS: Options = {
  period: "2026-08",
  rows: 1000,
  seed: 20260810,
  outDir: path.resolve(process.cwd(), "artifacts/front-profit-synthetic"),
  prefix: "front-profit-synthetic",
};

function parseArgs(argv: string[]): Options {
  const next = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [key, inlineValue] = arg.slice(2).split("=", 2);
    next.set(key, inlineValue ?? argv[i + 1] ?? "");
    if (inlineValue == null) i += 1;
  }
  const options = {
    period: next.get("period") ?? DEFAULTS.period,
    rows: Number(next.get("rows") ?? DEFAULTS.rows),
    seed: Number(next.get("seed") ?? DEFAULTS.seed),
    outDir: path.resolve(next.get("out") ?? DEFAULTS.outDir),
    prefix: next.get("prefix") ?? DEFAULTS.prefix,
  };
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(options.period)) {
    throw new Error("--period must use YYYY-MM");
  }
  if (!Number.isSafeInteger(options.rows) || options.rows <= 0) {
    throw new Error("--rows must be a positive integer");
  }
  if (!Number.isSafeInteger(options.seed) || options.seed <= 0) {
    throw new Error("--seed must be a positive integer");
  }
  return options;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function money(value: number): string {
  return value.toFixed(2);
}

function ratio(value: number): string {
  return value.toFixed(8);
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvLine(row: readonly unknown[]): string {
  return row.map(csvCell).join(",") + "\n";
}

async function writeCsvRow(stream: WriteStream, row: readonly unknown[]): Promise<void> {
  if (!stream.write(csvLine(row))) {
    await once(stream, "drain");
  }
}

async function closeCsvStream(stream: WriteStream): Promise<void> {
  stream.end();
  await once(stream, "finish");
}

function monthDate(period: string, index: number): string {
  return `${period}-${String((index % 28) + 1).padStart(2, "0")}`;
}

function baselineKey(row: Pick<BaselineAgg, "date" | "platform" | "businessMode" | "shop" | "operator">): string {
  return [row.date, row.platform, row.businessMode, row.shop, row.operator].join("\u001f");
}

function ensureBaselineAggregate(
  aggregates: Map<string, BaselineAgg>,
  dimensions: Pick<BaselineAgg, "date" | "platform" | "businessMode" | "groupName" | "shop" | "shopNormalized" | "operator">,
): BaselineAgg {
  const key = baselineKey(dimensions);
  const existing = aggregates.get(key);
  if (existing) {
    if (dimensions.groupName.localeCompare(existing.groupName) > 0) existing.groupName = dimensions.groupName;
    if (dimensions.shopNormalized.localeCompare(existing.shopNormalized) > 0) {
      existing.shopNormalized = dimensions.shopNormalized;
    }
    return existing;
  }
  const created: BaselineAgg = {
    ...dimensions,
    quantity: 0,
    gmv: 0,
    fillOrderAmount: 0,
    fillOrderProductCost: 0,
    fillOrderQuantity: 0,
    productCost: 0,
    shipmentValue: 0,
    platformFee: 0,
    taxFee: 0,
    financeCost: 0,
    freight: 0,
    commission: 0,
    promotionFee: 0,
  };
  aggregates.set(key, created);
  return created;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const random = mulberry32(options.seed);
  const shopCount = Math.min(24, Math.max(4, Math.ceil(Math.sqrt(options.rows) / 3)));
  const skuCount = Math.min(800, Math.max(16, Math.ceil(Math.sqrt(options.rows) * 2)));
  const operatorCount = Math.min(36, Math.max(4, Math.ceil(shopCount * 1.5)));
  const platforms = ["Shopee", "Lazada", "TikTok", "Amazon"];
  const businessModes = ["自营", "POP", "其他"];
  const groups = ["Kitchen", "Beauty", "Outdoor", "Digital"];

  await mkdir(options.outDir, { recursive: true });

  const operatorFileName = `${options.prefix}-operator-assignment.csv`;
  const salesFileName = `${options.prefix}-sales-fact.csv`;
  const costPeriodFileName = `${options.prefix}-cost-period.csv`;
  const costUsageFileName = `${options.prefix}-cost-usage.csv`;
  const rebateFileName = `${options.prefix}-rebate.csv`;
  const feeFileName = `${options.prefix}-fee-fact.csv`;
  const promotionFileName = `${options.prefix}-promotion-spend.csv`;
  const baselineFileName = `${options.prefix}-manual-baseline.csv`;

  let operatorRowCount = 0;
  const operatorStream = createWriteStream(path.join(options.outDir, operatorFileName), { encoding: "utf8" });
  await writeCsvRow(operatorStream, FRONT_PROFIT_OPERATOR_ASSIGNMENT_HEADERS);
  for (let shopIndex = 0; shopIndex < shopCount; shopIndex += 1) {
    for (let skuIndex = 0; skuIndex < skuCount; skuIndex += 1) {
      await writeCsvRow(operatorStream, [
        `Shop-${String(shopIndex + 1).padStart(2, "0")}`,
        "sku",
        `SKU-${String(skuIndex + 1).padStart(4, "0")}`,
        `Operator-${String(((shopIndex + skuIndex) % operatorCount) + 1).padStart(2, "0")}`,
        `${options.period}-01`,
        `${options.period}-28`,
        `OP-${options.period}`,
        "synthetic",
      ]);
      operatorRowCount += 1;
    }
  }
  await closeCsvStream(operatorStream);

  let costPeriodRowCount = 0;
  const unitCosts: number[] = [];
  const costPeriodStream = createWriteStream(path.join(options.outDir, costPeriodFileName), { encoding: "utf8" });
  await writeCsvRow(costPeriodStream, FRONT_PROFIT_COST_SOURCE_HEADERS);
  for (let skuIndex = 0; skuIndex < skuCount; skuIndex += 1) {
    const unitCost = 12 + (((skuIndex * 17) + options.seed) % 9000) / 100;
    unitCosts.push(unitCost);
    await writeCsvRow(costPeriodStream, [
      `SKU-${String(skuIndex + 1).padStart(4, "0")}`,
      "product_cost",
      `${options.period}-01`,
      `${options.period}-28`,
      money(unitCost),
      "CNY",
      `COST-${options.period}`,
      "synthetic",
    ]);
    costPeriodRowCount += 1;
  }
  await closeCsvStream(costPeriodStream);

  const aggregates = new Map<string, BaselineAgg>();
  const salesDimensions: SyntheticSaleDimension[] = [];
  const salesStream = createWriteStream(path.join(options.outDir, salesFileName), { encoding: "utf8" });
  const costUsageStream = createWriteStream(path.join(options.outDir, costUsageFileName), { encoding: "utf8" });
  await writeCsvRow(salesStream, FRONT_PROFIT_SALES_SOURCE_HEADERS);
  await writeCsvRow(costUsageStream, FRONT_PROFIT_COST_USAGE_HEADERS);
  let costUsageRowCount = 0;
  for (let index = 0; index < options.rows; index += 1) {
    const shopIndex = index % shopCount;
    const skuIndex = Math.floor(random() * skuCount);
    const platform = platforms[index % platforms.length];
    const businessMode = businessModes[index % businessModes.length];
    const groupName = groups[(shopIndex + index) % groups.length];
    const shop = `Shop-${String(shopIndex + 1).padStart(2, "0")}`;
    const shopNormalized = shop;
    const sku = `SKU-${String(skuIndex + 1).padStart(4, "0")}`;
    const operator = `Operator-${String(((shopIndex + skuIndex) % operatorCount) + 1).padStart(2, "0")}`;
    const date = monthDate(options.period, index);
    const adAccount = `AD-${String((index % 20) + 1).padStart(2, "0")}`;
    const quantity = 1 + (index % 5);
    const unitPrice = 38 + Math.floor(random() * 180);
    const gmv = quantity * unitPrice;
    const shipmentValue = gmv * (0.68 + random() * 0.16);
    const storedShipmentValue = Number(money(shipmentValue));

    await writeCsvRow(salesStream, [
      `SALE-${options.period}-${String(index + 1).padStart(8, "0")}`,
      date,
      platform,
      businessMode,
      groupName,
      shop,
      shopNormalized,
      sku,
      adAccount,
      "",
      "",
      "",
      quantity,
      money(gmv),
      money(storedShipmentValue),
      `SALES-${options.period}`,
      "synthetic",
    ]);

    await writeCsvRow(costUsageStream, [
      `SHIP-${options.period}-${String(index + 1).padStart(8, "0")}`,
      date,
      platform,
      businessMode,
      groupName,
      shop,
      shopNormalized,
      operator,
      sku,
      quantity,
      money(storedShipmentValue),
      `SHIP-${options.period}`,
      "synthetic",
    ]);
    costUsageRowCount += 1;

    const current = ensureBaselineAggregate(aggregates, {
      date,
      platform,
      businessMode,
      groupName,
      shop,
      shopNormalized,
      operator,
    });
    current.quantity += quantity;
    current.gmv += gmv;
    current.productCost += quantity * unitCosts[skuIndex]!;
    current.shipmentValue += storedShipmentValue;
    salesDimensions.push({
      date,
      platform,
      businessMode,
      groupName,
      shop,
      shopNormalized,
      operator,
      sku,
      adAccount,
    });
  }
  await closeCsvStream(salesStream);
  await closeCsvStream(costUsageStream);

  const eventRowCount = Math.max(1, Math.ceil(options.rows / 20));
  const rebateRowCountTarget = Math.max(1, Math.ceil(options.rows / 50));
  const promotionRowCountTarget = Math.max(1, Math.ceil(options.rows / 25));

  let rebateRowCount = 0;
  const rebateStream = createWriteStream(path.join(options.outDir, rebateFileName), { encoding: "utf8" });
  await writeCsvRow(rebateStream, FRONT_PROFIT_REBATE_SOURCE_HEADERS);
  for (let index = 0; index < rebateRowCountTarget; index += 1) {
    const dimension = salesDimensions[index % salesDimensions.length]!;
    const { date, platform, businessMode, groupName, shop, shopNormalized, operator, sku } = dimension;
    const fillOrderAmount = 8 + (index % 17);
    const fillOrderProductCost = 3 + (index % 9);
    const fillOrderQuantity = 1 + (index % 2);
    await writeCsvRow(rebateStream, [
      `REBATE-${options.period}-${String(index + 1).padStart(8, "0")}`,
      date,
      platform,
      businessMode,
      groupName,
      shop,
      shopNormalized,
      operator,
      sku,
      `ORDER-${options.period}-${String((index % options.rows) + 1).padStart(8, "0")}`,
      money(fillOrderAmount),
      money(fillOrderProductCost),
      fillOrderQuantity,
      `REBATE-${options.period}`,
      "synthetic",
    ]);
    const aggregate = ensureBaselineAggregate(aggregates, {
      date,
      platform,
      businessMode,
      groupName,
      shop,
      shopNormalized,
      operator,
    });
    aggregate.fillOrderAmount += fillOrderAmount;
    aggregate.fillOrderProductCost += fillOrderProductCost;
    aggregate.fillOrderQuantity += fillOrderQuantity;
    rebateRowCount += 1;
  }
  await closeCsvStream(rebateStream);

  let feeRowCount = 0;
  const feeKinds = ["platform_fee", "tax_fee", "finance_cost", "freight", "commission", "promotion_fee"];
  const authoritySources = ["settlement", "platform_bill", "rate_rule", "manual_estimate"];
  const feeStream = createWriteStream(path.join(options.outDir, feeFileName), { encoding: "utf8" });
  await writeCsvRow(feeStream, FRONT_PROFIT_FEE_SOURCE_HEADERS);
  for (let index = 0; index < eventRowCount; index += 1) {
    const dimension = salesDimensions[index % salesDimensions.length]!;
    const { date, platform, businessMode, groupName, shop, shopNormalized, operator, sku, adAccount } = dimension;
    const feeKind = feeKinds[index % feeKinds.length]!;
    const amount = Number(money(1 + (index % 31) * 0.37));
    await writeCsvRow(feeStream, [
      `FEE-${options.period}-${String(index + 1).padStart(8, "0")}`,
      date,
      feeKind,
      authoritySources[index % authoritySources.length],
      platform,
      businessMode,
      groupName,
      shop,
      shopNormalized,
      operator,
      sku,
      adAccount,
      money(amount),
      "CNY",
      `FEE-${options.period}`,
      "synthetic",
    ]);
    const aggregate = ensureBaselineAggregate(aggregates, {
      date,
      platform,
      businessMode,
      groupName,
      shop,
      shopNormalized,
      operator,
    });
    if (feeKind === "platform_fee") aggregate.platformFee += amount;
    else if (feeKind === "tax_fee") aggregate.taxFee += amount;
    else if (feeKind === "finance_cost") aggregate.financeCost += amount;
    else if (feeKind === "freight") aggregate.freight += amount;
    else if (feeKind === "commission") aggregate.commission += amount;
    else aggregate.promotionFee += amount;
    feeRowCount += 1;
  }
  await closeCsvStream(feeStream);

  let promotionRowCount = 0;
  const promotionStream = createWriteStream(path.join(options.outDir, promotionFileName), { encoding: "utf8" });
  await writeCsvRow(promotionStream, FRONT_PROFIT_PROMOTION_SOURCE_HEADERS);
  for (let index = 0; index < promotionRowCountTarget; index += 1) {
    const dimension = salesDimensions[index % salesDimensions.length]!;
    const { date, platform, businessMode, groupName, shop, shopNormalized, operator, sku, adAccount } = dimension;
    const promotionFee = Number(money(5 + (index % 23) * 0.83));
    await writeCsvRow(promotionStream, [
      `PROMO-${options.period}-${String(index + 1).padStart(8, "0")}`,
      date,
      platform,
      businessMode,
      groupName,
      shop,
      shopNormalized,
      adAccount,
      sku,
      `ProductOwner-${String((index % operatorCount) + 1).padStart(2, "0")}`,
      `OrderOwner-${String(((index + 3) % operatorCount) + 1).padStart(2, "0")}`,
      "",
      money(promotionFee),
      `PROMO-${options.period}`,
      "synthetic",
    ]);
    const aggregate = ensureBaselineAggregate(aggregates, {
      date,
      platform,
      businessMode,
      groupName,
      shop,
      shopNormalized,
      operator,
    });
    aggregate.promotionFee += promotionFee;
    promotionRowCount += 1;
  }
  await closeCsvStream(promotionStream);

  let baselineRowCount = 0;
  const baselineStream = createWriteStream(path.join(options.outDir, baselineFileName), { encoding: "utf8" });
  await writeCsvRow(baselineStream, FRONT_PROFIT_STANDARD_HEADERS);
  const baselineAggregates = [...aggregates.values()]
    .sort((left, right) => baselineKey(left).localeCompare(baselineKey(right)));
  for (const [index, row] of baselineAggregates.entries()) {
      const inputs = {
        GMV: row.gmv,
        补单金额: row.fillOrderAmount,
        补单产品成本: row.fillOrderProductCost,
        产品成本: row.productCost,
        出货货值: row.shipmentValue,
        "平台扣点/毛保": row.platformFee,
        税点: row.taxFee,
        财务成本: row.financeCost,
        运费: row.freight,
        佣金: row.commission,
        推广费: row.promotionFee,
      };
      const derived = calculateFrontProfitDerivedValues((field) => inputs[field]);
      await writeCsvRow(baselineStream, [
        row.date,
        row.platform,
        row.businessMode,
        row.groupName,
        row.shop,
        row.shopNormalized,
        row.operator,
        row.quantity,
        money(row.gmv),
        money(row.fillOrderAmount),
        money(row.fillOrderProductCost),
        row.fillOrderQuantity,
        money(row.productCost),
        money(row.shipmentValue),
        money(row.platformFee),
        money(row.taxFee),
        money(row.financeCost),
        money(row.freight),
        money(row.commission),
        money(row.promotionFee),
        `${options.prefix}-manual-baseline.csv`,
        `BASELINE-${options.period}`,
        "synthetic",
        money(derived["真实营业额"]),
        money(derived["前台利润"]),
        ratio(derived["付费占比"]),
        `SYNTHETIC-FP-${options.period}-${String(index + 1).padStart(8, "0")}`,
        "synthetic",
      ]);
      baselineRowCount += 1;
  }
  await closeCsvStream(baselineStream);

  const files: FixtureFile[] = [
    {
      role: "operator",
      name: operatorFileName,
      rows: operatorRowCount,
    },
    {
      role: "sales",
      name: salesFileName,
      rows: options.rows,
    },
    {
      role: "costPeriod",
      name: costPeriodFileName,
      rows: costPeriodRowCount,
    },
    {
      role: "costUsage",
      name: costUsageFileName,
      rows: costUsageRowCount,
    },
    {
      role: "rebate",
      name: rebateFileName,
      rows: rebateRowCount,
    },
    {
      role: "fee",
      name: feeFileName,
      rows: feeRowCount,
    },
    {
      role: "promotion",
      name: promotionFileName,
      rows: promotionRowCount,
    },
    {
      role: "baseline",
      name: baselineFileName,
      rows: baselineRowCount,
    },
  ];

  await writeFile(
    path.join(options.outDir, `${options.prefix}-manifest.json`),
    JSON.stringify({
      schema: "front-profit-synthetic-fixtures/v1",
      period: options.period,
      seed: options.seed,
      requestedSalesRows: options.rows,
      generatedAt: new Date(0).toISOString(),
      files: files.map((file) => ({ role: file.role, name: file.name, rows: file.rows })),
    }, null, 2) + "\n",
    "utf8",
  );

  console.log(JSON.stringify({
    ok: true,
    outDir: options.outDir,
    period: options.period,
    seed: options.seed,
    files: files.map((file) => ({ role: file.role, name: file.name, rows: file.rows })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
