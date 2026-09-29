import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const apiRoot = resolve(repoRoot, "apps/api");
const capacityGateScriptPath = resolve(apiRoot, "scripts/front-profit-capacity-matrix-gate.ts");
const localPrecheckScriptPath = resolve(apiRoot, "scripts/front-profit-local-release-precheck.ts");
const releaseScriptPath = resolve(apiRoot, "scripts/front-profit-production-release-gate.ts");
const releaseSmokeScriptPath = resolve(apiRoot, "scripts/front-profit-production-release-smoke.ts");
const exampleResultPath = resolve(repoRoot, "docs/front-profit-acceptance-result.example.json");
const exampleReleasePath = resolve(repoRoot, "docs/front-profit-production-release.example.json");
const acceptanceRoot = join(repoRoot, "front-profit-acceptance");
const releaseRoot = join(repoRoot, "front-profit-production-release");
const createdPaths: string[] = [];
const capacityRows = [50_000, 250_000, 500_000, 1_000_000] as const;
const syntheticDbRunnerRows = [1_000, 10_000, 50_000] as const;
const capacityFileRoles = [
  ["operator", "operator-assignment", 2],
  ["sales", "sales-fact", "salesRows"],
  ["costPeriod", "cost-period", 2],
  ["costUsage", "cost-usage", "salesRows"],
  ["rebate", "rebate", 2],
  ["fee", "fee-fact", 2],
  ["promotion", "promotion-spend", 2],
  ["baseline", "manual-baseline", 2],
] as const;
const syntheticDbRunnerThresholds: Record<number, Record<string, number>> = {
  1_000: {
    total: 60,
    fixture_generate: 10,
    uf_load: 10,
    draft_l1_l3_l4: 15,
    aligned_baseline_load: 5,
    shadow_recon: 2,
    publish: 8,
    run_detail_query: 0.5,
  },
  10_000: {
    total: 180,
    fixture_generate: 15,
    uf_load: 20,
    draft_l1_l3_l4: 45,
    aligned_baseline_load: 10,
    shadow_recon: 5,
    publish: 12,
    run_detail_query: 0.75,
  },
  50_000: {
    total: 300,
    fixture_generate: 30,
    uf_load: 45,
    draft_l1_l3_l4: 120,
    aligned_baseline_load: 20,
    shadow_recon: 10,
    publish: 20,
    run_detail_query: 1,
  },
};

const runReleaseGate = (args: string[]) => spawnSync(
  process.execPath,
  ["./node_modules/tsx/dist/cli.mjs", releaseScriptPath, ...args],
  { cwd: apiRoot, encoding: "utf8" },
);

const runCapacityGate = (args: string[]) => spawnSync(
  process.execPath,
  ["./node_modules/tsx/dist/cli.mjs", capacityGateScriptPath, ...args],
  { cwd: apiRoot, encoding: "utf8" },
);

const runReleaseSmoke = () => spawnSync(
  process.execPath,
  ["./node_modules/tsx/dist/cli.mjs", releaseSmokeScriptPath],
  { cwd: apiRoot, encoding: "utf8" },
);

const runLocalPrecheck = (args: string[] = []) => spawnSync(
  process.execPath,
  ["./node_modules/tsx/dist/cli.mjs", localPrecheckScriptPath, ...args],
  { cwd: apiRoot, encoding: "utf8" },
);

const currentCommitSha = () => {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`could not read current git commit: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
};

const ignoredAcceptanceDir = (name: string) => `front-profit-acceptance/vitest-release-${process.pid}-${name}`;
const ignoredReleaseDir = (name: string) => `front-profit-production-release/vitest-${process.pid}-${name}`;

const trackedTempPath = (name: string) => {
  const target = join(apiRoot, `front-profit-production-release-${process.pid}-${name}.json`);
  createdPaths.push(target);
  return target;
};

const writeJson = (repoRelativePath: string, payload: unknown) => {
  const filePath = join(repoRoot, repoRelativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const topDir = repoRelativePath.split("/").slice(0, 2).join("/");
  const cleanupPath = join(repoRoot, topDir);
  if (!createdPaths.includes(cleanupPath)) createdPaths.push(cleanupPath);
  return repoRelativePath;
};

const sha256Text = (value: string) =>
  createHash("sha256").update(value).digest("hex").toUpperCase();

const writeTextFixture = (repoRelativePath: string, content: string) => {
  const filePath = join(repoRoot, repoRelativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
  const topDir = repoRelativePath.split("/").slice(0, 2).join("/");
  const cleanupPath = join(repoRoot, topDir);
  if (!createdPaths.includes(cleanupPath)) createdPaths.push(cleanupPath);
  return {
    bytes: Buffer.byteLength(content),
    sha256: sha256Text(content),
  };
};

const writeCapacityFile = (relativeDir: string, rows: number, suffix: string, evidenceRows: number | "salesRows") => {
  const name = `capacity-${rows}-${suffix}.csv`;
  const actualRows = evidenceRows === "salesRows" ? rows : evidenceRows;
  const content = `${suffix},${rows},vitest\n`;
  const evidence = writeTextFixture(`${relativeDir}/${name}`, content);
  return {
    name,
    rows: actualRows,
    bytes: evidence.bytes,
    sha256: evidence.sha256,
  };
};

const syntheticDbRunnerEntry = (rows: number) => {
  const thresholds = syntheticDbRunnerThresholds[rows]!;
  return {
    salesRows: rows,
    status: "passed",
    thresholdStatus: "passed",
    thresholds,
    totalSeconds: Math.min(5, thresholds.total - 1),
    resultPath: `${ignoredReleaseDir(`capacity-db-${rows}`)}/synthetic-db-runner-result.json`,
    timings: Object.entries(thresholds)
      .filter(([phase]) => phase !== "total")
      .map(([phase, seconds]) => ({ phase, seconds: Math.min(0.1, seconds) })),
    layerRows: {
      l1Rows: rows * 2,
      l3Rows: rows * 2,
      l4Rows: Math.max(1, Math.floor(rows / 10)),
      reconRows: 39,
      dqRows: 0,
    },
    publish: {
      status: "published",
      stagedRowCount: Math.max(1, Math.floor(rows / 10)),
    },
    shadowRecon: {
      reconCount: 4,
      dqCount: 0,
      passed: true,
    },
    runDetail: {
      stepCount: 4,
      dqCount: 0,
      reconCount: 39,
      l4PreviewCount: 50,
      publishVersionCount: 1,
    },
  };
};

const writeCapacityMatrix = (name: string, mutate?: (payload: any) => void) => {
  const relativeDir = `${ignoredReleaseDir(name)}/capacity-matrix`;
  const matrix = capacityRows.map((rows) => ({
    salesRows: rows,
    outDir: relativeDir,
    generateSeconds: 0.001,
    contractSeconds: 0.001,
    baselineWarnings: 0,
    files: Object.fromEntries(capacityFileRoles.map(([role, suffix, evidenceRows]) => [
      role,
      writeCapacityFile(relativeDir, rows, suffix, evidenceRows),
    ])),
  }));
  const payload = {
    schema: "front-profit-capacity-matrix-result/v1",
    period: "2026-08",
    seed: 20260810,
    rows: [...capacityRows],
    outDir: relativeDir,
    generatedAt: "2026-08-11T00:00:00.000Z",
    matrix,
    syntheticDbRunner: {
      rows: [...syntheticDbRunnerRows],
      command: "pnpm --filter @ec/api run front-profit:synthetic-db-runner",
      entries: syntheticDbRunnerRows.map((rows) => syntheticDbRunnerEntry(rows)),
    },
  };
  mutate?.(payload);
  return writeJson(`${relativeDir}/capacity-matrix-result.json`, payload);
};

const writeResultEvidenceFiles = (relativeDir: string) => {
  for (const name of [
    "dq-summary.json",
    "recon-summary.json",
    "diff-summary.json",
    "publish-summary.json",
    "rollback-summary.json",
  ]) {
    writeTextFixture(`${relativeDir}/${name}`, `${JSON.stringify({
      artifact: name,
      containsSampleRows: false,
      containsCredentials: false,
    }, null, 2)}\n`);
  }
};

const writeDockerPackageManifest = (
  name: string,
  targetImageTag: string,
  targetImageDigest: string,
  mutate?: (payload: any) => void,
) => {
  const payload = {
    mode: "vitest-release-package",
    targetImageTag,
    targetImageDigest,
    containsSampleRows: false,
    containsCredentials: false,
    noAutomaticDeployment: true,
  };
  mutate?.(payload);
  return writeJson(`${ignoredReleaseDir(name)}/docker-package-manifest.json`, payload);
};

const makeRun = (period: string, jobRunId: number, publishVersionId: number, restoredVersionId: number) => ({
  period,
  jobRunId,
  sourceIds: [11, 12, 13, 14, 15, 16, 17, 18],
  manualBaselineSourceId: 18,
  rowCounts: {
    l4Rows: 100,
    manualBaselineRows: 100,
    publishedRows: 100,
  },
  dq: {
    unresolvedBlockCount: 0,
    warningCount: 1,
    quarantinedRowCount: 0,
    explainedWarningCodes: ["PROMOTION_ORPHAN_ALLOWED"],
  },
  recon: {
    manualBaselineCompared: true,
    aggregationKeyCoverage: 1,
    failedCount: 0,
    diffRowCount: 0,
    maxMoneyDiff: 0.01,
  },
  publish: {
    authorityChangedByAdmin: true,
    publishVersionId,
    publishedRowCount: 100,
    idempotencyKey: `front-profit:${period}:run:${jobRunId}`,
    retryReturnedVersionId: publishVersionId,
    retryCreatedNewVersion: false,
  },
  rollback: {
    rehearsed: true,
    rolledBackVersionId: publishVersionId,
    restoredVersionId,
    restoredRowCount: 100,
    retryIdempotent: true,
  },
});

const acceptedResultManifest = (name: string) => {
  const result = JSON.parse(readFileSync(exampleResultPath, "utf8"));
  const relativeDir = ignoredAcceptanceDir(name);
  result.mode = "dry_run";
  result.sourceManifest.path = `${relativeDir}/source-manifest.json`;
  result.sourceManifest.periods = ["2026-07", "2026-08"];
  result.sourceManifest.preflightPassed = true;
  result.sourceManifest.checkFilesPassed = true;
  result.sourceManifest.readinessPassed = true;
  result.dryRun.executor = "Codex";
  result.dryRun.isolationEnvironment = "isolated dry-run database";
  result.dryRun.migrationPassed = true;
  result.dryRun.apiSmokePassed = true;
  result.dryRun.repoCheckPassed = true;
  result.runs = [
    makeRun("2026-07", 101, 201, 200),
    makeRun("2026-08", 102, 202, 201),
  ];
  result.evidenceArtifacts = [
    { kind: "dq_summary", path: `${relativeDir}/dq-summary.json`, containsSampleRows: false, containsCredentials: false },
    { kind: "recon_summary", path: `${relativeDir}/recon-summary.json`, containsSampleRows: false, containsCredentials: false },
    { kind: "diff_summary", path: `${relativeDir}/diff-summary.json`, containsSampleRows: false, containsCredentials: false },
    { kind: "publish_smoke", path: `${relativeDir}/publish-summary.json`, containsSampleRows: false, containsCredentials: false },
    { kind: "rollback_smoke", path: `${relativeDir}/rollback-summary.json`, containsSampleRows: false, containsCredentials: false },
  ];
  writeResultEvidenceFiles(relativeDir);
  result.cleanup.temporaryDbRemoved = true;
  result.cleanup.temporaryUploadsRemoved = true;
  result.cleanup.temporaryExportsRemoved = true;
  result.cleanup.localCredentialsRemoved = true;
  result.cleanup.retainedEvidenceOnly = true;
  result.acceptance.decision = "pass";
  result.acceptance.acceptedBy = "Data Owner";
  result.acceptance.productionReleaseAuthorized = false;
  result.acceptance.notes = "accepted isolated dry run";
  result.confirmations.noSampleRowsInManifest = true;
  result.confirmations.noCredentialsInManifest = true;
  result.confirmations.noProductionDbTouched = true;
  result.confirmations.noCiDependency = true;
  return result;
};

const authorizedReleaseManifest = (resultPath: string) => {
  const release = JSON.parse(readFileSync(exampleReleasePath, "utf8"));
  release.mode = "authorized";
  release.acceptanceResult.path = resultPath;
  release.acceptanceResult.periods = ["2026-07", "2026-08"];
  release.acceptanceResult.resultGatePassed = true;
  release.acceptanceResult.acceptedDecision = "pass";
  release.authorization.authorized = true;
  release.authorization.authorizer = "Release Approver";
  release.authorization.releaseOwner = "Release Owner";
  release.authorization.rollbackOwner = "Rollback Owner";
  release.authorization.observer = "Observer";
  release.authorization.approvalRef = "APPROVAL-2026-08-FRONT-PROFIT";
  release.authorization.confirmSeparateFromDryRun = true;
  release.scope.platforms = ["tmall"];
  release.technicalGates = Object.fromEntries(
    Object.keys(release.technicalGates).map((key) => [key, true]),
  );
  release.releaseArtifacts.commitSha = currentCommitSha();
  release.releaseArtifacts.targetImageTag = "front-profit-20260810";
  release.releaseArtifacts.targetImageDigest = `sha256:${"a".repeat(64)}`;
  release.releaseArtifacts.dockerPackageManifest = writeDockerPackageManifest(
    "release-docker-package",
    release.releaseArtifacts.targetImageTag,
    release.releaseArtifacts.targetImageDigest,
  );
  release.releaseArtifacts.capacityMatrixResult = writeCapacityMatrix("release-capacity");
  release.releaseArtifacts.rollbackTargetVersionId = 201;
  release.releaseArtifacts.backupReference = "backup-ref-20260810";
  release.releaseArtifacts.currentConfigReference = "config-ref-20260810";
  release.operations.releaseChecklistReviewed = true;
  release.operations.rollbackPlanReviewed = true;
  release.operations.monitorOwner = "Monitor Owner";
  release.operations.incidentChannel = "ops-channel";
  release.evidenceArtifacts = [
    { kind: "acceptance_result", path: resultPath, containsSampleRows: false, containsCredentials: false },
    { kind: "backup_record", path: "front-profit-production-release/backup-record.json", containsSampleRows: false, containsCredentials: false },
  ];
  release.confirmations.productionReleaseIsExplicitlyAuthorized = true;
  return release;
};

afterEach(() => {
  for (const target of createdPaths.splice(0)) {
    rmSync(target, { force: true, recursive: true });
  }
});

describe("front-profit production release gate", () => {
  test("validates capacity matrix metadata and file hashes", () => {
    const capacityPath = writeCapacityMatrix("capacity-direct-ok");

    const result = runCapacityGate(["--result", capacityPath, "--check-files"]);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("FRONT_PROFIT_CAPACITY_MATRIX_GATE_OK");
    expect(result.stdout).toContain("rows=50000,250000,500000,1000000");
    expect(result.stdout).toContain("syntheticDbRunnerRows=1000,10000,50000");
    expect(result.stdout).toContain("fileEvidence=checked");
  }, 30000);

  test("rejects a capacity matrix missing a required row tier", () => {
    const capacityPath = writeCapacityMatrix("capacity-missing-tier", (payload) => {
      payload.rows = [50_000, 250_000, 500_000];
      payload.matrix = payload.matrix.filter((entry: { salesRows: number }) => entry.salesRows !== 1_000_000);
    });

    const result = runCapacityGate(["--result", capacityPath, "--check-files"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FRONT_PROFIT_CAPACITY_MATRIX_GATE_FAILED");
    expect(result.stderr).toContain("capacity matrix rows must be exactly 50000,250000,500000,1000000");
    expect(result.stderr).toContain("capacity matrix entries must cover exactly 50000,250000,500000,1000000");
  }, 30000);

  test("rejects synthetic DB runner evidence that exceeds a phase threshold", () => {
    const capacityPath = writeCapacityMatrix("capacity-db-threshold", (payload) => {
      payload.syntheticDbRunner.entries[2].timings.find(
        (timing: { phase: string }) => timing.phase === "draft_l1_l3_l4",
      ).seconds = 121;
      payload.syntheticDbRunner.entries[2].thresholdStatus = "failed";
      payload.syntheticDbRunner.entries[2].failureEvidence = {
        exitStatus: 0,
        message: "synthetic DB runner exceeded a capacity threshold",
        stdoutTail: "draft_l1_l3_l4Seconds=121",
        stderrTail: "",
      };
    });

    const result = runCapacityGate(["--result", capacityPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FRONT_PROFIT_CAPACITY_MATRIX_GATE_FAILED");
    expect(result.stderr).toContain("synthetic DB runner rows 50000 timing draft_l1_l3_l4 121 exceeds threshold 120");
    expect(result.stderr).toContain("synthetic DB runner rows 50000 thresholdStatus must be passed");
  });

  test("allows the checked-in release example only when template mode is explicit", () => {
    const result = runReleaseGate(["--template-ok"]);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("FRONT_PROFIT_PRODUCTION_RELEASE_GATE_OK");
    expect(result.stdout).toContain("mode=template");
  });

  test("fails closed for the checked-in release example without template mode", () => {
    const result = runReleaseGate(["--release", "docs/front-profit-production-release.example.json"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FRONT_PROFIT_PRODUCTION_RELEASE_GATE_FAILED");
    expect(result.stderr).toContain("release manifest is in template mode");
  });

  test("accepts an authorized release only after the dry-run result gate passes", () => {
    const resultPath = writeJson(`${ignoredAcceptanceDir("ok")}/result.json`, acceptedResultManifest("ok"));
    const releasePath = writeJson(`${ignoredReleaseDir("ok")}/release.json`, authorizedReleaseManifest(resultPath));

    const result = runReleaseGate(["--release", releasePath]);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("FRONT_PROFIT_PRODUCTION_RELEASE_GATE_OK");
    expect(result.stdout).toContain("mode=authorized");
    expect(result.stdout).toContain("releasePeriods=2026-08");
    expect(result.stdout).toContain("releasePlatforms=tmall");
    expect(result.stdout).toContain("acceptedPeriods=2026-07,2026-08");
  });

  test("rejects a release whose declared accepted periods do not match the referenced result", () => {
    const resultPath = writeJson(`${ignoredAcceptanceDir("period-mismatch")}/result.json`, acceptedResultManifest("period-mismatch"));
    const release = authorizedReleaseManifest(resultPath);
    release.acceptanceResult.periods = ["2026-07", "2026-09"];
    release.scope.periods = ["2026-09"];
    const releasePath = writeJson(`${ignoredReleaseDir("period-mismatch")}/release.json`, release);

    const result = runReleaseGate(["--release", releasePath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("gate=acceptance_result_consistency");
    expect(result.stderr).toContain("release acceptanceResult.periods must match result sourceManifest.periods");
    expect(result.stderr).toContain("release acceptanceResult.periods must match result runs.period");
  });

  test("rejects a release whose Docker package manifest does not match the release artifacts", () => {
    const resultPath = writeJson(`${ignoredAcceptanceDir("docker-mismatch")}/result.json`, acceptedResultManifest("docker-mismatch"));
    const release = authorizedReleaseManifest(resultPath);
    release.releaseArtifacts.dockerPackageManifest = writeDockerPackageManifest(
      "docker-mismatch",
      release.releaseArtifacts.targetImageTag,
      `sha256:${"b".repeat(64)}`,
    );
    const releasePath = writeJson(`${ignoredReleaseDir("docker-mismatch")}/release.json`, release);

    const result = runReleaseGate(["--release", releasePath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docker package targetImageDigest must match release manifest");
  });

  test("rejects a release whose commitSha is not present in local git history", () => {
    const resultPath = writeJson(`${ignoredAcceptanceDir("missing-commit")}/result.json`, acceptedResultManifest("missing-commit"));
    const release = authorizedReleaseManifest(resultPath);
    release.releaseArtifacts.commitSha = "ffffffffffffffffffffffffffffffffffffffff";
    const releasePath = writeJson(`${ignoredReleaseDir("missing-commit")}/release.json`, release);

    const result = runReleaseGate(["--release", releasePath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("releaseArtifacts.commitSha must exist in the local git history");
  });

  test("rejects synthetic release placeholders unless explicitly allowed for smoke rehearsal", () => {
    const resultPath = writeJson(`${ignoredAcceptanceDir("synthetic-guard")}/result.json`, acceptedResultManifest("synthetic-guard"));
    const release = authorizedReleaseManifest(resultPath);
    release.authorization.authorizer = "synthetic-release-authorizer";
    release.scope.platforms = ["synthetic-platform"];
    release.releaseArtifacts.targetImageTag = "synthetic-release-image";
    release.releaseArtifacts.dockerPackageManifest = writeDockerPackageManifest(
      "synthetic-guard-docker-package",
      release.releaseArtifacts.targetImageTag,
      release.releaseArtifacts.targetImageDigest,
    );
    const releasePath = writeJson(`${ignoredReleaseDir("synthetic-guard")}/release.json`, release);

    const blocked = runReleaseGate(["--release", releasePath]);
    const allowed = runReleaseGate(["--release", releasePath, "--allow-synthetic"]);

    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("contains synthetic/placeholder markers");
    expect(allowed.status, `${allowed.stdout}${allowed.stderr}`).toBe(0);
    expect(allowed.stdout).toContain("FRONT_PROFIT_PRODUCTION_RELEASE_GATE_OK");
    expect(allowed.stdout).toContain("releasePlatforms=synthetic-platform");
    expect(allowed.stdout).toContain("syntheticRehearsal=allowed");
  });

  test("runs the synthetic production release smoke and cleans generated manifests", () => {
    const result = runReleaseSmoke();

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("FRONT_PROFIT_PRODUCTION_RELEASE_SMOKE_OK");
    expect(result.stdout).toContain("acceptedPeriods=2026-07,2026-08");
    expect(result.stdout).toContain("releasePlatforms=synthetic-platform");
    expect(result.stdout).toContain("syntheticRehearsal=allowed");
    if (existsSync(acceptanceRoot)) {
      expect(readdirSync(acceptanceRoot).filter((entry) => entry.startsWith("production-release-smoke-"))).toEqual([]);
    }
    if (existsSync(releaseRoot)) {
      expect(readdirSync(releaseRoot).filter((entry) => entry.startsWith("production-release-smoke-"))).toEqual([]);
    }
  }, 30000);

  test("runs the local synthetic release precheck without real samples or deployment", () => {
    const result = runLocalPrecheck();

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("FRONT_PROFIT_LOCAL_RELEASE_PRECHECK_OK");
    expect(result.stdout).toContain("gates=acceptance_readiness_smoke,production_release_smoke,smoke_resource_audit,repo_check");
    expect(result.stdout).toContain("capacityMatrixRequired=false");
    expect(result.stdout).toContain("syntheticRehearsal=allowed");
    expect(result.stdout).toContain("realSamples=not_used");
    expect(result.stdout).toContain("deployment=not_started");
    if (existsSync(acceptanceRoot)) {
      expect(readdirSync(acceptanceRoot).filter((entry) =>
        entry.startsWith("readiness-smoke-") || entry.startsWith("production-release-smoke-"),
      )).toEqual([]);
    }
    if (existsSync(releaseRoot)) {
      expect(readdirSync(releaseRoot).filter((entry) => entry.startsWith("production-release-smoke-"))).toEqual([]);
    }
  }, 30000);

  test("can require capacity matrix evidence during the local synthetic release precheck", () => {
    const capacityResult = writeJson(
      `front-profit-production-release/capacity-evidence-${process.pid}-precheck/capacity-matrix-result.json`,
      {},
    );
    const result = runLocalPrecheck([
      "--require-capacity-matrix",
      "--capacity-matrix-result",
      capacityResult,
    ]);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("FRONT_PROFIT_LOCAL_RELEASE_PRECHECK_OK");
    expect(result.stdout).toContain("capacityMatrixRequired=true");
    expect(result.stdout).toContain("gates=acceptance_readiness_smoke,production_release_smoke,smoke_resource_audit,repo_check");
  }, 30000);

  test("rejects an authorized release when the referenced result gate fails", () => {
    const failingResult = acceptedResultManifest("failing-result");
    failingResult.runs[0].dq.unresolvedBlockCount = 1;
    const resultPath = writeJson(`${ignoredAcceptanceDir("failing-result")}/result.json`, failingResult);
    const releasePath = writeJson(`${ignoredReleaseDir("failing-result")}/release.json`, authorizedReleaseManifest(resultPath));

    const result = runReleaseGate(["--release", releasePath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("gate=acceptance_result");
    expect(result.stderr).toContain("period 2026-07 unresolved BLOCK count must be 0");
  });

  test("rejects an authorized release manifest inside the repo when it is not git-ignored", () => {
    const resultPath = writeJson(`${ignoredAcceptanceDir("tracked-release")}/result.json`, acceptedResultManifest("tracked-release"));
    const releasePath = trackedTempPath("tracked");
    writeFileSync(releasePath, `${JSON.stringify(authorizedReleaseManifest(resultPath), null, 2)}\n`, "utf8");

    const result = runReleaseGate(["--release", releasePath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("release manifest is inside the repo but is not git-ignored");
  });

  test("rejects unsafe production rollout gates before checking the dry-run result", () => {
    const resultPath = writeJson(`${ignoredAcceptanceDir("unsafe-release")}/result.json`, acceptedResultManifest("unsafe-release"));
    const release = authorizedReleaseManifest(resultPath);
    release.acceptanceResult.periods = ["2026-08"];
    release.acceptanceResult.acceptedDecision = "pending";
    release.acceptanceResult.productionReleaseAuthorizedInResult = true;
    release.authorization.confirmSeparateFromDryRun = false;
    release.scope.periods = ["2026-08", "2026-09"];
    release.scope.platforms = ["tmall", "jd"];
    release.scope.observationDays = 3;
    release.technicalGates.apiVitestPassed = false;
    release.confirmations.productionReleaseIsExplicitlyAuthorized = false;
    const releasePath = writeJson(`${ignoredReleaseDir("unsafe-release")}/release.json`, release);

    const result = runReleaseGate(["--release", releasePath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("acceptance result decision must be pass");
    expect(result.stderr).toContain("production release requires at least 2 accepted dry-run periods");
    expect(result.stderr).toContain("initial production rollout must target exactly 1 period");
    expect(result.stderr).toContain("initial production rollout must target exactly 1 platform");
    expect(result.stderr).toContain("@ec/api vitest must pass");
    expect(result.stderr).toContain("production release must be explicitly authorized");
  });

  test("rejects production release evidence that points at sample-like artifacts", () => {
    const resultPath = writeJson(`${ignoredAcceptanceDir("artifact-leak")}/result.json`, acceptedResultManifest("artifact-leak"));
    const release = authorizedReleaseManifest(resultPath);
    release.evidenceArtifacts[0].containsCredentials = true;
    release.evidenceArtifacts[1].path = "apps/api/release-evidence.csv";
    const releasePath = writeJson(`${ignoredReleaseDir("artifact-leak")}/release.json`, release);

    const result = runReleaseGate(["--release", releasePath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("evidenceArtifacts[0] must not contain credentials");
    expect(result.stderr).toContain("evidenceArtifacts[1].path must not point at raw or tabular sample data");
    expect(result.stderr).toContain("evidenceArtifacts[1].path is inside the repo but is not git-ignored");
  });
});
