import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = path.resolve(API_ROOT, "../..");
const TSX_CLI = path.join(API_ROOT, "node_modules/tsx/dist/cli.mjs");
const READINESS_SCRIPT = path.join(API_ROOT, "scripts/front-profit-acceptance-readiness.ts");
const ACCEPTANCE_ROOT = path.join(REPO_ROOT, "front-profit-acceptance");

const SOURCE_FAMILIES = [
  "operator_assignment",
  "sales_fact",
  "cost_period",
  "cost_usage",
  "rebate",
  "fee_fact",
  "promotion_spend",
  "manual_baseline",
] as const;

type SourceFamily = typeof SOURCE_FAMILIES[number];

const sourceConfig: Record<SourceFamily, { alias: string; dateField: string; keyField: string }> = {
  operator_assignment: { alias: "operator-assignment-smoke", dateField: "effective_from", keyField: "authority_key" },
  sales_fact: { alias: "sales-fact-smoke", dateField: "sale_date", keyField: "sale_key" },
  cost_period: { alias: "cost-period-smoke", dateField: "effective_from", keyField: "sku_key" },
  cost_usage: { alias: "cost-usage-smoke", dateField: "shipment_date", keyField: "sale_key" },
  rebate: { alias: "rebate-smoke", dateField: "rebate_event_date", keyField: "rebate_key" },
  fee_fact: { alias: "fee-fact-smoke", dateField: "fee_date", keyField: "fee_key" },
  promotion_spend: { alias: "promotion-spend-smoke", dateField: "promotion_date", keyField: "promotion_key" },
  manual_baseline: { alias: "manual-01-baseline-smoke", dateField: "date", keyField: "record_id" },
};

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll("\"", "\"\"")}"` : value;
}

function writeCsv(filePath: string, headers: string[], family: SourceFamily) {
  const rows = [1, 2].map((index) =>
    headers.map((header) => csvCell(`${family}-${header}-${index}`)).join(","),
  );
  writeFileSync(filePath, `${headers.map(csvCell).join(",")}\n${rows.join("\n")}\n`, "utf8");
}

function buildManifest(relativeRunDir: string) {
  return {
    schemaVersion: "front-profit-real-sample-acceptance/v1",
    mode: "authorized",
    authorization: {
      authorized: true,
      authorizationDate: "2026-08-10",
      authorizer: "synthetic-readiness-smoke",
      executor: "synthetic-readiness-smoke",
      allowedPurpose: "front-profit-isolated-dry-run",
      allowedPeriods: ["2026-08"],
      retentionDays: 1,
      isolationEnvironment: "synthetic-readiness-smoke",
      confirmNoGit: true,
      confirmNoCi: true,
      confirmNoProductionDb: true,
      confirmSanitizedOnly: true,
      confirmCleanupRequired: true,
    },
    sources: SOURCE_FAMILIES.map((family) => {
      const config = sourceConfig[family];
      return {
        family,
        participating: true,
        alias: config.alias,
        rowCount: 2,
        dateField: config.dateField,
        dateRange: { from: "2026-08-01", to: "2026-08-31" },
        sourceSystem: "synthetic-readiness-smoke",
        sensitiveFields: [config.keyField],
        sanitizedPath: `${relativeRunDir}/${family}.csv`,
        fieldMappings: [{
          sourceHeader: config.keyField,
          contractField: `${family}.${config.keyField}`,
          sanitization: "stable_hash",
          owner: "synthetic-readiness-smoke",
          required: true,
          exceptionPolicy: "BLOCK when missing",
        }],
      };
    }),
    businessRules: {
      periodBasis: "calendar_month",
      closeDayOfNextMonth: 5,
      rebateKey: "rebate_key",
      rebateDate: "rebate_event_date",
      feeAuthorityPriority: ["settlement", "platform_bill", "rate_rule", "manual_estimate"],
      operatorAuthorityPriority: ["sku", "ad_account", "product_owner", "order_owner", "manual_mapping"],
      costMatchDate: "shipment_date",
      promotionOrphanPolicy: "keep_and_allow_negative_profit",
    },
    dryRunGates: {
      aggregationKeyCoverage: 1,
      maxMoneyDiff: 0.01,
      unresolvedBlockCount: 0,
      publishRetryMustBeIdempotent: true,
      rollbackMustRestorePreviousVersion: true,
    },
  };
}

function removeAcceptanceRootIfEmpty() {
  try {
    if (readdirSync(ACCEPTANCE_ROOT).length === 0) {
      rmSync(ACCEPTANCE_ROOT, { force: true });
    }
  } catch {
    // Nothing to clean.
  }
}

const runId = `readiness-smoke-${process.pid}-${Date.now()}`;
const relativeRunDir = `front-profit-acceptance/${runId}`;
const runDir = path.join(REPO_ROOT, relativeRunDir);
const manifestRelativePath = `${relativeRunDir}/manifest.json`;

try {
  mkdirSync(runDir, { recursive: true });
  const manifest = buildManifest(relativeRunDir);
  for (const source of manifest.sources) {
    writeCsv(
      path.join(REPO_ROOT, source.sanitizedPath),
      [source.dateField, source.fieldMappings[0].sourceHeader],
      source.family,
    );
  }
  writeFileSync(
    path.join(REPO_ROOT, manifestRelativePath),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  const result = spawnSync(process.execPath, [
    TSX_CLI,
    READINESS_SCRIPT,
    "--manifest",
    manifestRelativePath,
    "--allow-synthetic",
  ], {
    cwd: API_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });

  if (result.status !== 0) {
    console.error("FRONT_PROFIT_ACCEPTANCE_READINESS_SMOKE_FAILED");
    console.error(`exitStatus=${result.status ?? "unknown"}`);
    if (result.stdout.trim()) console.error(result.stdout.trimEnd());
    if (result.stderr.trim()) console.error(result.stderr.trimEnd());
    process.exit(1);
  }

  console.log("FRONT_PROFIT_ACCEPTANCE_READINESS_SMOKE_OK");
  console.log(`families=${SOURCE_FAMILIES.length}`);
  console.log("rowsPerFamily=2");
  console.log("syntheticRehearsal=allowed");
} finally {
  rmSync(runDir, { force: true, recursive: true });
  removeAcceptanceRootIfEmpty();
}
