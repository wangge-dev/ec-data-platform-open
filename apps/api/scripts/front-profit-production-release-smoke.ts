import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = path.resolve(API_ROOT, "../..");
const TSX_CLI = path.join(API_ROOT, "node_modules/tsx/dist/cli.mjs");
const RELEASE_GATE_SCRIPT = path.join(API_ROOT, "scripts/front-profit-production-release-gate.ts");
const EXAMPLE_RESULT = path.join(REPO_ROOT, "docs/front-profit-acceptance-result.example.json");
const EXAMPLE_RELEASE = path.join(REPO_ROOT, "docs/front-profit-production-release.example.json");
const ACCEPTANCE_ROOT = path.join(REPO_ROOT, "front-profit-acceptance");
const RELEASE_ROOT = path.join(REPO_ROOT, "front-profit-production-release");
const CAPACITY_ROWS = [50_000, 250_000, 500_000, 1_000_000] as const;
const SYNTHETIC_DB_RUNNER_ROWS = [1_000, 10_000, 50_000] as const;
const CAPACITY_FILE_ROLES = [
  ["operator", "operator-assignment", 2],
  ["sales", "sales-fact", "salesRows"],
  ["costPeriod", "cost-period", 2],
  ["costUsage", "cost-usage", "salesRows"],
  ["rebate", "rebate", 2],
  ["fee", "fee-fact", 2],
  ["promotion", "promotion-spend", 2],
  ["baseline", "manual-baseline", 2],
] as const;
const SYNTHETIC_DB_RUNNER_THRESHOLDS: Record<number, Record<string, number>> = {
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

function currentCommitSha(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`could not read current git commit: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

function writeCapacityEvidenceFile(relativeDir: string, name: string, rows: number, role: string) {
  const content = `${role},${rows},synthetic-production-release-smoke\n`;
  writeFileSync(path.join(REPO_ROOT, relativeDir, name), content, "utf8");
  return {
    name,
    rows,
    bytes: Buffer.byteLength(content),
    sha256: sha256Text(content),
  };
}

function syntheticDbRunnerEntry(relativeCapacityDir: string, rows: number) {
  const thresholds = SYNTHETIC_DB_RUNNER_THRESHOLDS[rows]!;
  const l4Rows = Math.max(1, Math.floor(rows / 10));
  return {
    salesRows: rows,
    status: "passed",
    thresholdStatus: "passed",
    thresholds,
    totalSeconds: Math.min(5, thresholds.total - 1),
    resultPath: `${relativeCapacityDir}/synthetic-db-runner-${rows}/synthetic-db-runner-result.json`,
    timings: Object.entries(thresholds)
      .filter(([phase]) => phase !== "total")
      .map(([phase, seconds]) => ({ phase, seconds: Math.min(0.1, seconds) })),
    layerRows: {
      l1Rows: rows * 2,
      l3Rows: rows * 2,
      l4Rows,
      reconRows: 39,
      dqRows: 0,
    },
    publish: {
      status: "published",
      stagedRowCount: l4Rows,
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
}

function makeRun(period: string, jobRunId: number, publishVersionId: number, restoredVersionId: number) {
  return {
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
  };
}

function buildResultManifest(relativeRunDir: string) {
  const result = JSON.parse(readFileSync(EXAMPLE_RESULT, "utf8"));
  result.mode = "dry_run";
  result.sourceManifest.path = `${relativeRunDir}/source-manifest.json`;
  result.sourceManifest.periods = ["2026-07", "2026-08"];
  result.sourceManifest.preflightPassed = true;
  result.sourceManifest.checkFilesPassed = true;
  result.sourceManifest.readinessPassed = true;
  result.dryRun.executor = "synthetic-production-release-smoke";
  result.dryRun.isolationEnvironment = "synthetic-production-release-smoke";
  result.dryRun.migrationPassed = true;
  result.dryRun.apiSmokePassed = true;
  result.dryRun.repoCheckPassed = true;
  result.runs = [
    makeRun("2026-07", 101, 201, 200),
    makeRun("2026-08", 102, 202, 201),
  ];
  result.evidenceArtifacts = [
    { kind: "dq_summary", path: `${relativeRunDir}/dq-summary.json`, containsSampleRows: false, containsCredentials: false },
    { kind: "recon_summary", path: `${relativeRunDir}/recon-summary.json`, containsSampleRows: false, containsCredentials: false },
    { kind: "diff_summary", path: `${relativeRunDir}/diff-summary.json`, containsSampleRows: false, containsCredentials: false },
    { kind: "publish_smoke", path: `${relativeRunDir}/publish-summary.json`, containsSampleRows: false, containsCredentials: false },
    { kind: "rollback_smoke", path: `${relativeRunDir}/rollback-summary.json`, containsSampleRows: false, containsCredentials: false },
  ];
  result.cleanup.temporaryDbRemoved = true;
  result.cleanup.temporaryUploadsRemoved = true;
  result.cleanup.temporaryExportsRemoved = true;
  result.cleanup.localCredentialsRemoved = true;
  result.cleanup.retainedEvidenceOnly = true;
  result.acceptance.decision = "pass";
  result.acceptance.acceptedBy = "synthetic-production-release-smoke";
  result.acceptance.productionReleaseAuthorized = false;
  result.acceptance.notes = "synthetic release gate smoke only";
  result.confirmations.noSampleRowsInManifest = true;
  result.confirmations.noCredentialsInManifest = true;
  result.confirmations.noProductionDbTouched = true;
  result.confirmations.noCiDependency = true;
  return result;
}

function writeResultEvidenceFiles(relativeRunDir: string) {
  for (const name of [
    "dq-summary.json",
    "recon-summary.json",
    "diff-summary.json",
    "publish-summary.json",
    "rollback-summary.json",
  ]) {
    writeFileSync(
      path.join(REPO_ROOT, relativeRunDir, name),
      `${JSON.stringify({
        mode: "synthetic-production-release-smoke",
        artifact: name,
        containsSampleRows: false,
        containsCredentials: false,
      }, null, 2)}\n`,
      "utf8",
    );
  }
}

function buildCapacityMatrix(relativeReleaseDir: string): string {
  const relativeCapacityDir = `${relativeReleaseDir}/capacity-matrix`;
  mkdirSync(path.join(REPO_ROOT, relativeCapacityDir), { recursive: true });
  const matrix = CAPACITY_ROWS.map((rows) => ({
    salesRows: rows,
    outDir: relativeCapacityDir,
    generateSeconds: 0.001,
    contractSeconds: 0.001,
    baselineWarnings: 0,
    files: Object.fromEntries(CAPACITY_FILE_ROLES.map(([role, suffix, evidenceRows]) => [
      role,
      writeCapacityEvidenceFile(
        relativeCapacityDir,
        `capacity-${rows}-${suffix}.csv`,
        evidenceRows === "salesRows" ? rows : evidenceRows,
        role,
      ),
    ])),
  }));
  const relativeCapacityResult = `${relativeCapacityDir}/capacity-matrix-result.json`;
  writeFileSync(
    path.join(REPO_ROOT, relativeCapacityResult),
    `${JSON.stringify({
      schema: "front-profit-capacity-matrix-result/v1",
      period: "2026-08",
      seed: 20260810,
      rows: [...CAPACITY_ROWS],
      outDir: relativeCapacityDir,
      generatedAt: "2026-08-11T00:00:00.000Z",
      matrix,
      syntheticDbRunner: {
        rows: [...SYNTHETIC_DB_RUNNER_ROWS],
        command: "pnpm --filter @ec/api run front-profit:synthetic-db-runner",
        entries: SYNTHETIC_DB_RUNNER_ROWS.map((rows) => syntheticDbRunnerEntry(relativeCapacityDir, rows)),
      },
    }, null, 2)}\n`,
    "utf8",
  );
  return relativeCapacityResult;
}

function buildReleaseManifest(relativeResultPath: string, relativeReleaseDir: string, relativeCapacityResult: string) {
  const release = JSON.parse(readFileSync(EXAMPLE_RELEASE, "utf8"));
  release.mode = "authorized";
  release.acceptanceResult.path = relativeResultPath;
  release.acceptanceResult.periods = ["2026-07", "2026-08"];
  release.acceptanceResult.resultGatePassed = true;
  release.acceptanceResult.acceptedDecision = "pass";
  release.acceptanceResult.productionReleaseAuthorizedInResult = false;
  release.authorization.authorized = true;
  release.authorization.authorizer = "synthetic-production-release-smoke";
  release.authorization.releaseOwner = "synthetic-production-release-smoke";
  release.authorization.rollbackOwner = "synthetic-production-release-smoke";
  release.authorization.observer = "synthetic-production-release-smoke";
  release.authorization.approvalRef = "SYNTHETIC-PRODUCTION-RELEASE-SMOKE";
  release.authorization.confirmSeparateFromDryRun = true;
  release.scope.platforms = ["synthetic-platform"];
  release.technicalGates = Object.fromEntries(
    Object.keys(release.technicalGates).map((key) => [key, true]),
  );
  release.releaseArtifacts.commitSha = currentCommitSha();
  release.releaseArtifacts.targetImageTag = "synthetic-production-release-smoke";
  release.releaseArtifacts.targetImageDigest = `sha256:${"a".repeat(64)}`;
  release.releaseArtifacts.dockerPackageManifest = `${relativeReleaseDir}/docker-package-manifest.json`;
  release.releaseArtifacts.capacityMatrixResult = relativeCapacityResult;
  release.releaseArtifacts.rollbackTargetVersionId = 201;
  release.releaseArtifacts.backupReference = "synthetic-production-release-smoke-backup";
  release.releaseArtifacts.currentConfigReference = "synthetic-production-release-smoke-config";
  release.operations.releaseChecklistReviewed = true;
  release.operations.rollbackPlanReviewed = true;
  release.operations.monitorOwner = "synthetic-production-release-smoke";
  release.operations.incidentChannel = "synthetic-production-release-smoke";
  release.evidenceArtifacts = [
    { kind: "acceptance_result", path: relativeResultPath, containsSampleRows: false, containsCredentials: false },
    { kind: "backup_record", path: `${relativeReleaseDir}/backup-record.json`, containsSampleRows: false, containsCredentials: false },
  ];
  release.confirmations.noCredentialsInManifest = true;
  release.confirmations.noSampleRowsInManifest = true;
  release.confirmations.noProductionDbCredentialsStored = true;
  release.confirmations.noCiRealSampleDependency = true;
  release.confirmations.noAutomaticDeployment = true;
  release.confirmations.productionReleaseIsExplicitlyAuthorized = true;
  return release;
}

function removeRootIfEmpty(root: string) {
  try {
    if (readdirSync(root).length === 0) {
      rmSync(root, { force: true });
    }
  } catch {
    // Nothing to clean.
  }
}

const runId = `production-release-smoke-${process.pid}-${Date.now()}`;
const relativeAcceptanceDir = `front-profit-acceptance/${runId}`;
const relativeReleaseDir = `front-profit-production-release/${runId}`;
const acceptanceDir = path.join(REPO_ROOT, relativeAcceptanceDir);
const releaseDir = path.join(REPO_ROOT, relativeReleaseDir);
const resultRelativePath = `${relativeAcceptanceDir}/result.json`;
const releaseRelativePath = `${relativeReleaseDir}/release.json`;

try {
  mkdirSync(acceptanceDir, { recursive: true });
  mkdirSync(releaseDir, { recursive: true });
  writeResultEvidenceFiles(relativeAcceptanceDir);
  writeFileSync(
    path.join(REPO_ROOT, resultRelativePath),
    `${JSON.stringify(buildResultManifest(relativeAcceptanceDir), null, 2)}\n`,
    "utf8",
  );
  const capacityResultRelativePath = buildCapacityMatrix(relativeReleaseDir);
  writeFileSync(
    path.join(REPO_ROOT, relativeReleaseDir, "docker-package-manifest.json"),
    `${JSON.stringify({
      mode: "synthetic-production-release-smoke",
      targetImageTag: "synthetic-production-release-smoke",
      targetImageDigest: `sha256:${"a".repeat(64)}`,
      containsSampleRows: false,
      containsCredentials: false,
      noAutomaticDeployment: true,
    }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(REPO_ROOT, releaseRelativePath),
    `${JSON.stringify(buildReleaseManifest(resultRelativePath, relativeReleaseDir, capacityResultRelativePath), null, 2)}\n`,
    "utf8",
  );

  const result = spawnSync(process.execPath, [
    TSX_CLI,
    RELEASE_GATE_SCRIPT,
    "--release",
    releaseRelativePath,
    "--allow-synthetic",
  ], {
    cwd: API_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });

  if (result.status !== 0) {
    console.error("FRONT_PROFIT_PRODUCTION_RELEASE_SMOKE_FAILED");
    console.error(`exitStatus=${result.status ?? "unknown"}`);
    if (result.stdout.trim()) console.error(result.stdout.trimEnd());
    if (result.stderr.trim()) console.error(result.stderr.trimEnd());
    process.exit(1);
  }

  console.log("FRONT_PROFIT_PRODUCTION_RELEASE_SMOKE_OK");
  console.log("acceptedPeriods=2026-07,2026-08");
  console.log("releasePeriods=2026-08");
  console.log("releasePlatforms=synthetic-platform");
  console.log("syntheticRehearsal=allowed");
} finally {
  rmSync(acceptanceDir, { force: true, recursive: true });
  rmSync(releaseDir, { force: true, recursive: true });
  removeRootIfEmpty(ACCEPTANCE_ROOT);
  removeRootIfEmpty(RELEASE_ROOT);
}
