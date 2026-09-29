import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

const apiRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = path.resolve(apiRoot, "../..");
const tsxCli = path.join(apiRoot, "node_modules/tsx/dist/cli.mjs");
const generatorScript = path.join(apiRoot, "scripts/front-profit-generate-synthetic-fixtures.ts");
const runnerScript = path.join(apiRoot, "scripts/front-profit-synthetic-db-runner.ts");
const summaryScript = path.join(apiRoot, "scripts/front-profit-synthetic-acceptance-summary.ts");

const temporaryDirectories: string[] = [];

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell);
  return cells;
}

function readCsv(filePath: string): Array<Record<string, string>> {
  const [headerLine, ...rowLines] = readFileSync(filePath, "utf8").trimEnd().split(/\r?\n/);
  const headers = parseCsvLine(headerLine ?? "");
  return rowLines.map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
}

function sum(rows: Array<Record<string, string>>, field: string): number {
  return rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);
}

function writeSyntheticRunnerResult(filePath: string, period: string, idOffset: number): void {
  const sourceFamilies = [
    "operator_assignment",
    "sales_fact",
    "cost_period",
    "cost_usage",
    "rebate",
    "fee_fact",
    "promotion_spend",
    "manual_baseline",
  ];
  writeFileSync(filePath, JSON.stringify({
    schema: "front-profit-synthetic-db-runner-result/v1",
    generatedAt: "2026-08-22T00:00:00.000Z",
    period,
    seed: 20260822 + idOffset,
    requestedSalesRows: 1_000,
    fixtureManifest: `apps/api/artifacts/rehearsal/${period}/fixtures/synthetic-db-manifest.json`,
    database: { urlSource: "TEST_DATABASE_URL", realSamplesUsed: false, deploymentStarted: false },
    manualBaseline: {
      mode: "synthetic_independent_fixture",
      fileName: "synthetic-db-manual-baseline.csv",
      rowCount: 500,
      originalFixtureBaselineUsedForRecon: true,
    },
    sources: sourceFamilies.map((family, index) => ({
      role: family === "manual_baseline" ? "baseline" : family,
      family,
      sourceId: idOffset + index + 1,
      rowCount: family === "manual_baseline" ? 500 : 1_000,
      sha256: String(index).repeat(64).slice(0, 64),
    })),
    draft: { runId: idOffset + 20, status: "recon_pending" },
    layerRows: { l1Rows: 2_000, l3Rows: 1_500, l4Rows: 500, reconRows: 39, dqRows: 0 },
    publish: {
      runId: idOffset + 20,
      versionId: idOffset + 40,
      versionNo: 2,
      status: "published",
      stagedRowCount: 500,
      idempotent: false,
    },
    shadowRecon: { reconCount: 4, dqCount: 0, passed: true, maxAbsoluteDiff: 0 },
    runDetail: { stepCount: 4, dqCount: 0, reconCount: 39, l4PreviewCount: 50, publishVersionCount: 1 },
    acceptanceRehearsal: {
      mode: "synthetic_rehearsal",
      realSamplesUsed: false,
      productionReleaseAuthorized: false,
      baselineRun: {
        runId: idOffset + 19,
        l4Rows: 500,
        shadowRecon: { reconCount: 4, dqCount: 0, passed: true, maxAbsoluteDiff: 0 },
        publishVersionId: idOffset + 39,
        publishRetryReturnedVersionId: idOffset + 39,
        publishRetryCreatedNewVersion: false,
      },
      candidateRun: {
        runId: idOffset + 20,
        l4Rows: 500,
        shadowRecon: { reconCount: 4, dqCount: 0, passed: true, maxAbsoluteDiff: 0 },
        publishVersionId: idOffset + 40,
      },
      publishRetry: { returnedVersionId: idOffset + 40, createdNewVersion: false, idempotent: true },
      rollback: {
        rolledBackVersionId: idOffset + 40,
        restoredVersionId: idOffset + 39,
        rolledBackRowCount: 500,
        restoredRowCount: 500,
        idempotent: false,
      },
      rollbackRetry: {
        rolledBackVersionId: idOffset + 40,
        restoredVersionId: idOffset + 39,
        restoredRowCount: 500,
        idempotent: true,
      },
    },
  }, null, 2));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("front-profit synthetic acceptance rehearsal", () => {
  test("manual baseline independently accounts for every monetary input family", () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "front-profit-golden-baseline-"));
    temporaryDirectories.push(outDir);
    const result = spawnSync(process.execPath, [
      tsxCli,
      generatorScript,
      "--period",
      "2026-07",
      "--rows",
      "240",
      "--seed",
      "20260822",
      "--out",
      outDir,
      "--prefix",
      "golden",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
    });

    expect(result.status, result.stderr).toBe(0);

    const baseline = readCsv(path.join(outDir, "golden-manual-baseline.csv"));
    const sales = readCsv(path.join(outDir, "golden-sales-fact.csv"));
    const costs = readCsv(path.join(outDir, "golden-cost-period.csv"));
    const usages = readCsv(path.join(outDir, "golden-cost-usage.csv"));
    const rebates = readCsv(path.join(outDir, "golden-rebate.csv"));
    const fees = readCsv(path.join(outDir, "golden-fee-fact.csv"));
    const promotions = readCsv(path.join(outDir, "golden-promotion-spend.csv"));
    const unitCosts = new Map(costs.map((row) => [row.SKU, Number(row["单位成本"])]));
    const expectedProductCost = usages.reduce(
      (total, row) => total + Number(row["出货数量"]) * (unitCosts.get(row.SKU) ?? 0),
      0,
    );
    const feeFieldByKind: Record<string, string> = {
      platform_fee: "平台扣点/毛保",
      tax_fee: "税点",
      finance_cost: "财务成本",
      freight: "运费",
      commission: "佣金",
      promotion_fee: "推广费",
    };

    expect(sum(baseline, "GMV")).toBeCloseTo(sum(sales, "GMV"), 2);
    expect(sum(baseline, "产品成本")).toBeCloseTo(expectedProductCost, 2);
    expect(sum(baseline, "补单金额")).toBeCloseTo(sum(rebates, "补单金额"), 2);
    expect(sum(baseline, "补单产品成本")).toBeCloseTo(sum(rebates, "补单产品成本"), 2);
    expect(sum(baseline, "补单单量")).toBeCloseTo(sum(rebates, "补单单量"), 6);

    for (const [kind, field] of Object.entries(feeFieldByKind)) {
      const feeTotal = fees
        .filter((row) => row["费用项"] === kind)
        .reduce((total, row) => total + Number(row["金额"]), 0);
      const promotionTotal = kind === "promotion_fee" ? sum(promotions, "推广费") : 0;
      expect(sum(baseline, field)).toBeCloseTo(feeTotal + promotionTotal, 2);
      expect(sum(baseline, field)).toBeGreaterThan(0);
    }
  });

  test("runner exposes a fail-closed acceptance rehearsal mode", () => {
    const result = spawnSync(process.execPath, [tsxCli, runnerScript, "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("--acceptance-rehearsal");

    const runnerSource = readFileSync(runnerScript, "utf8");
    expect(runnerSource).toContain("synthetic_independent_fixture");
    expect(runnerSource).toContain("originalFixtureBaselineUsedForRecon = true");
    expect(runnerSource).toContain("publishRetry");
    expect(runnerSource).toContain("rollbackRetry");
    expect(runnerSource).toContain("rollbackFrontProfitPublishVersion");
  });

  test("summarizes at least two clean periods only after isolated cleanup is confirmed", () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "front-profit-rehearsal-summary-"));
    temporaryDirectories.push(workDir);
    const julyResult = path.join(workDir, "july.json");
    const augustResult = path.join(workDir, "august.json");
    const outDir = path.join(workDir, "evidence");
    writeSyntheticRunnerResult(julyResult, "2026-07", 100);
    writeSyntheticRunnerResult(augustResult, "2026-08", 200);

    const missingCleanup = spawnSync(process.execPath, [
      tsxCli,
      summaryScript,
      "--result",
      julyResult,
      "--result",
      augustResult,
      "--out",
      outDir,
    ], { cwd: repoRoot, encoding: "utf8", shell: false });
    expect(missingCleanup.status).not.toBe(0);

    const result = spawnSync(process.execPath, [
      tsxCli,
      summaryScript,
      "--result",
      julyResult,
      "--result",
      augustResult,
      "--out",
      outDir,
      "--cleanup-confirmed",
    ], { cwd: repoRoot, encoding: "utf8", shell: false });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("FRONT_PROFIT_SYNTHETIC_ACCEPTANCE_SUMMARY_OK");
    const summary = JSON.parse(readFileSync(path.join(outDir, "synthetic-acceptance-summary.json"), "utf8"));
    expect(summary.schema).toBe("front-profit-synthetic-acceptance-rehearsal/v1");
    expect(summary.periods).toEqual(["2026-07", "2026-08"]);
    expect(summary.realSamplesUsed).toBe(false);
    expect(summary.productionReleaseAuthorized).toBe(false);
    expect(summary.cleanup.temporaryDatabaseRemoved).toBe(true);
    for (const fileName of [
      "dq-summary.json",
      "recon-summary.json",
      "diff-summary.json",
      "publish-summary.json",
      "rollback-summary.json",
    ]) {
      expect(existsSync(path.join(outDir, fileName))).toBe(true);
    }
  });
});
