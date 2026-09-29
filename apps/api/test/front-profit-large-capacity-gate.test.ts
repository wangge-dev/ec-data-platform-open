import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const API_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = path.resolve(API_ROOT, "../..");
const TSX_CLI = path.join(API_ROOT, "node_modules/tsx/dist/cli.mjs");
const GATE_SCRIPT = path.join(API_ROOT, "scripts/front-profit-large-capacity-gate.ts");
const OBSERVE_SCRIPT = path.join(API_ROOT, "scripts/front-profit-large-capacity-observe.ts");
const SUMMARY_SCRIPT = path.join(API_ROOT, "scripts/front-profit-large-capacity-summary.ts");
const createdDirs: string[] = [];

const thresholds = {
  "500000": {
    totalSeconds: 450,
    recoveryTotalSeconds: 450,
    fixtureGenerateSeconds: 20,
    ufLoadSeconds: 80,
    draftSeconds: 360,
    recoveryDraftSeconds: 360,
    alignedBaselineLoadSeconds: 3,
    shadowReconSeconds: 2,
    publishSeconds: 8,
    runDetailQuerySeconds: 1,
    postgresPeakMemoryBytes: 4_294_967_296,
    runnerPeakWorkingSetBytes: 2_684_354_560,
    databaseBytesAfterRun: 5_368_709_120,
    volumeGrowthBytes: 8_589_934_592,
    maxDraftSpreadRatio: 1.35,
  },
  "1000000": {
    totalSeconds: 850,
    recoveryTotalSeconds: 900,
    fixtureGenerateSeconds: 30,
    ufLoadSeconds: 140,
    draftSeconds: 700,
    recoveryDraftSeconds: 780,
    alignedBaselineLoadSeconds: 3,
    shadowReconSeconds: 2,
    publishSeconds: 8,
    runDetailQuerySeconds: 1,
    postgresPeakMemoryBytes: 7_516_192_768,
    runnerPeakWorkingSetBytes: 3_221_225_472,
    databaseBytesAfterRun: 10_737_418_240,
    volumeGrowthBytes: 17_179_869_184,
    maxDraftSpreadRatio: 1.6,
  },
};

function repoHead(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function successRun(rows: 500_000 | 1_000_000, kind: "clean_repeat" | "recovery_retry") {
  const million = rows === 1_000_000;
  const draft = million ? (kind === "clean_repeat" ? 500 : 520) : (kind === "clean_repeat" ? 260 : 275);
  const l1Rows = million ? 2_180_000 : 1_100_000;
  const l3Rows = million ? 2_110_000 : 1_055_000;
  return {
    kind,
    resultPath: `artifacts/vitest-large-capacity-evidence-${process.pid}/${rows}-${kind}-result.json`,
    totalSeconds: million ? draft + 105 : draft + 65,
    timings: {
      fixtureGenerateSeconds: million ? 16 : 10,
      ufLoadSeconds: million ? 85 : 50,
      draftSeconds: draft,
      alignedBaselineLoadSeconds: 0.8,
      shadowReconSeconds: 0.3,
      publishSeconds: 2,
      runDetailQuerySeconds: 0.03,
    },
    layerRows: { l1Rows, l3Rows, l4Rows: 6_048, reconRows: 39, dqRows: 0 },
    publish: { status: "published", stagedRowCount: 6_048 },
    shadowRecon: { passed: true, maxAbsoluteDiff: 0 },
    resources: {
      sampleIntervalMs: 1_000,
      sampleCount: 120,
      postgresPeakMemoryBytes: million ? 5_000_000_000 : 2_500_000_000,
      postgresPeakCpuPercent: 180,
      runnerProcessTreePeakWorkingSetBytes: million ? 1_500_000_000 : 900_000_000,
      databaseBytesAfterMigration: 10_000_000,
      databaseBytesAfterRun: million ? 7_000_000_000 : 3_500_000_000,
      databaseGrowthBytes: million ? 6_990_000_000 : 3_490_000_000,
      volumeBytesAfterMigration: 50_000_000,
      volumeBytesAfterRun: million ? 12_000_000_000 : 6_000_000_000,
      volumeGrowthBytes: million ? 11_950_000_000 : 5_950_000_000,
    },
  };
}

function tier(rows: 500_000 | 1_000_000) {
  const recoveryPath = `artifacts/vitest-large-capacity-evidence-${process.pid}/${rows}-recovery_retry-result.json`;
  return {
    salesRows: rows,
    successfulRuns: [successRun(rows, "clean_repeat"), successRun(rows, "recovery_retry")],
    failureRecovery: {
      method: "pg_terminate_backend_on_front_profit_operator_assignment_insert",
      failureExitStatus: 1,
      machineFailureResultPath: `artifacts/vitest-large-capacity-evidence-${process.pid}/${rows}-failure-result.json`,
      machineFailureSchema: "front-profit-synthetic-db-runner-failure/v1",
      failureCode: "FRONT_PROFIT_SYNTHETIC_DB_RUNNER_FAILED",
      failurePhase: "draft_l1_l3_l4",
      rollbackCounts: {
        jobRuns: 0,
        jobSteps: 0,
        l1Rows: 0,
        l3Rows: 0,
        l4Rows: 0,
        dqEvents: 0,
        reconResults: 0,
        publishVersions: 0,
        publishedRows: 0,
      },
      externalResidue: { registeredSources: 7, userDataTables: 7 },
      recoveryResultPath: recoveryPath,
      sameSeed: true,
      fixtureHashMismatches: 0,
    },
  };
}

function validEvidence() {
  return {
    schema: "front-profit-large-capacity-evidence/v1",
    generatedAt: "2026-08-22T12:00:00.000Z",
    sourceCommit: repoHead(),
    period: "2026-08",
    seed: 20260810,
    thresholds,
    tiers: [tier(500_000), tier(1_000_000)],
    cleanup: {
      composeProject: "ec-fp-large-capacity-test",
      isolatedContainers: 0,
      isolatedVolumes: 0,
      isolatedNetworks: 0,
      portListeners: 0,
    },
    boundary: {
      deterministicSyntheticOnly: true,
      realSamplesUsed: false,
      deploymentStarted: false,
      productionReleaseAuthorized: false,
      productionSlaProven: false,
    },
  };
}

function writeEvidence(name: string, mutate?: (evidence: any) => void): string {
  const relativeDir = `artifacts/vitest-large-capacity-evidence-${process.pid}-${name}`;
  const absoluteDir = path.join(REPO_ROOT, relativeDir);
  createdDirs.push(absoluteDir);
  mkdirSync(absoluteDir, { recursive: true });
  const evidence = validEvidence();
  mutate?.(evidence);
  const resultPath = path.join(absoluteDir, "large-capacity-evidence.json");
  writeFileSync(resultPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return resultPath;
}

function runGate(resultPath: string) {
  return spawnSync(process.execPath, [TSX_CLI, GATE_SCRIPT, "--result", resultPath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: false,
  });
}

afterEach(() => {
  for (const directory of createdDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("front-profit 500k/1M large capacity gate", () => {
  test("accepts two bounded successful runs and a clean failure recovery for each tier", () => {
    const result = runGate(writeEvidence("ok"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("FRONT_PROFIT_LARGE_CAPACITY_GATE_OK");
    expect(result.stdout).toContain("rows=500000,1000000");
  });

  test("rejects a tier without both a clean repeat and a recovery retry", () => {
    const result = runGate(writeEvidence("missing-repeat", (evidence) => {
      evidence.tiers[0].successfulRuns = [evidence.tiers[0].successfulRuns[0]];
    }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("rows 500000 must contain exactly one clean_repeat and one recovery_retry");
  });

  test("rejects performance, resource and repeat-spread threshold breaches", () => {
    const result = runGate(writeEvidence("thresholds", (evidence) => {
      evidence.tiers[1].successfulRuns[0].timings.draftSeconds = 701;
      evidence.tiers[1].successfulRuns[0].resources.postgresPeakMemoryBytes = 7_516_192_769;
      evidence.tiers[1].successfulRuns[1].totalSeconds = 901;
      evidence.tiers[1].successfulRuns[1].timings.draftSeconds = 781;
      evidence.tiers[1].successfulRuns[0].timings.draftSeconds = 400;
    }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("totalSeconds 901 exceeds threshold 900");
    expect(result.stderr).toContain("draftSeconds 781 exceeds threshold 780");
    expect(result.stderr).toContain("postgresPeakMemoryBytes 7516192769 exceeds threshold 7516192768");
    expect(result.stderr).toContain("draft spread ratio");
  });

  test("rejects a failure attempt that left transactional rows behind", () => {
    const result = runGate(writeEvidence("unsafe-recovery", (evidence) => {
      evidence.tiers[0].failureRecovery.rollbackCounts.l3Rows = 1;
      evidence.tiers[0].failureRecovery.fixtureHashMismatches = 1;
    }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("rollbackCounts.l3Rows must be 0");
    expect(result.stderr).toContain("fixtureHashMismatches must be 0");
  });

  test("observer refuses to fall back from TEST_DATABASE_URL", () => {
    const { TEST_DATABASE_URL: _testUrl, DATABASE_URL: _databaseUrl, ...safeEnv } = process.env;
    const result = spawnSync(process.execPath, [
      TSX_CLI,
      OBSERVE_SCRIPT,
      "--mode",
      "clean_repeat",
      "--rows",
      "1000",
      "--out",
      `artifacts/vitest-large-capacity-evidence-${process.pid}`,
      "--compose-project",
      "ec-fp-large-capacity-test",
      "--postgres-container",
      "ec-fp-large-capacity-test-postgres",
      "--host-port",
      "25445",
    ], { cwd: REPO_ROOT, env: safeEnv, encoding: "utf8", shell: false });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("TEST_DATABASE_URL is required");
  });

  test("observer does not echo buffered runner stderr through its public failure", () => {
    const observer = readFileSync(OBSERVE_SCRIPT, "utf8");
    expect(observer).not.toMatch(/runner failed[^\n]*processResult\.stderr/);
    expect(observer).toContain("clean runner failed with exit status");
    expect(observer).toContain("recovery runner failed with exit status");
  });

  test("summary refuses to claim cleanup without an explicit confirmation", () => {
    const placeholder = `artifacts/vitest-large-capacity-evidence-${process.pid}/fragment.json`;
    const result = spawnSync(process.execPath, [
      TSX_CLI,
      SUMMARY_SCRIPT,
      "--fragment", placeholder,
      "--fragment", placeholder,
      "--fragment", placeholder,
      "--fragment", placeholder,
      "--out", `artifacts/vitest-large-capacity-evidence-${process.pid}/summary.json`,
      "--compose-project", "ec-fp-large-capacity-test",
      "--host-port", "25445",
    ], { cwd: REPO_ROOT, encoding: "utf8", shell: false });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--cleanup-confirmed is required");
  });
});
