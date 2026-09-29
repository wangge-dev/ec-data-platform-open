import { dirname, join, resolve } from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const apiRoot = resolve(repoRoot, "apps/api");
const tsxCli = resolve(apiRoot, "node_modules/tsx/dist/cli.mjs");
const statusScriptPath = resolve(apiRoot, "scripts/front-profit-acceptance-status.ts");
const initScriptPath = resolve(apiRoot, "scripts/front-profit-acceptance-init.ts");
const exampleManifestPath = resolve(repoRoot, "docs/front-profit-acceptance-manifest.example.json");
const exampleResultPath = resolve(repoRoot, "docs/front-profit-acceptance-result.example.json");
const exampleReleasePath = resolve(repoRoot, "docs/front-profit-production-release.example.json");
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

type AcceptanceManifest = {
  mode: "template" | "authorized";
  authorization: {
    authorized: boolean;
    authorizer: string;
    executor: string;
    isolationEnvironment: string;
  };
  sources: Array<{
    family: string;
    sourceSystem: string;
    sensitiveFields: string[];
    sanitizedPath?: string;
    fieldMappings?: Array<{
      sourceHeader: string;
      contractField: string;
      sanitization: "none" | "stable_hash";
      owner: string;
      required: boolean;
      exceptionPolicy: string;
    }>;
  }>;
};

const ignoredAcceptanceDir = (name: string) => `front-profit-acceptance/vitest-status-${process.pid}-${name}`;
const ignoredReleaseDir = (name: string) => `front-profit-production-release/vitest-status-${process.pid}-${name}`;

function runStatus(args: string[]) {
  return spawnSync(process.execPath, [tsxCli, statusScriptPath, ...args], {
    cwd: apiRoot,
    encoding: "utf8",
  });
}

function runInit(args: string[]) {
  return spawnSync(process.execPath, [tsxCli, initScriptPath, ...args], {
    cwd: apiRoot,
    encoding: "utf8",
  });
}

function currentCommitSha() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`could not read current git commit: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function writeJson(repoRelativePath: string, payload: unknown) {
  const filePath = join(repoRoot, repoRelativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const topDir = repoRelativePath.split("/").slice(0, 2).join("/");
  const cleanupPath = join(repoRoot, topDir);
  if (!createdPaths.includes(cleanupPath)) createdPaths.push(cleanupPath);
  return repoRelativePath;
}

const sha256Text = (value: string) =>
  createHash("sha256").update(value).digest("hex").toUpperCase();

function writeTextFixture(repoRelativePath: string, content: string) {
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
}

function writeCapacityFile(relativeDir: string, rows: number, suffix: string, evidenceRows: number | "salesRows") {
  const name = `capacity-${rows}-${suffix}.csv`;
  const actualRows = evidenceRows === "salesRows" ? rows : evidenceRows;
  const content = `${suffix},${rows},vitest-status\n`;
  const evidence = writeTextFixture(`${relativeDir}/${name}`, content);
  return {
    name,
    rows: actualRows,
    bytes: evidence.bytes,
    sha256: evidence.sha256,
  };
}

function syntheticDbRunnerEntry(rows: number) {
  const thresholds = syntheticDbRunnerThresholds[rows]!;
  const l4Rows = Math.max(1, Math.floor(rows / 10));
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

function writeCapacityMatrix(name: string) {
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
  return writeJson(`${relativeDir}/capacity-matrix-result.json`, {
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
  });
}

function writeResultEvidenceFiles(relativeDir: string) {
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
}

function writeDockerPackageManifest(name: string, targetImageTag: string, targetImageDigest: string) {
  return writeJson(`${ignoredReleaseDir(name)}/docker-package-manifest.json`, {
    mode: "vitest-status-release-package",
    targetImageTag,
    targetImageDigest,
    containsSampleRows: false,
    containsCredentials: false,
    noAutomaticDeployment: true,
  });
}

function authorizedManifest(relativeDir: string): AcceptanceManifest {
  const manifest = JSON.parse(readFileSync(exampleManifestPath, "utf8")) as AcceptanceManifest;
  manifest.mode = "authorized";
  manifest.authorization.authorized = true;
  manifest.authorization.authorizer = "Data Owner";
  manifest.authorization.executor = "Codex";
  manifest.authorization.isolationEnvironment = "isolated dry-run database";
  for (const source of manifest.sources) {
    source.sourceSystem = "authorized sanitized fixture";
    source.sanitizedPath = `${relativeDir}/${source.family}.csv`;
    source.fieldMappings = source.sensitiveFields.length > 0
      ? source.sensitiveFields.map((field) => ({
        sourceHeader: field,
        contractField: `${source.family}.${field}`,
        sanitization: "stable_hash",
        owner: "Data Owner",
        required: true,
        exceptionPolicy: "BLOCK when missing",
      }))
      : [{
        sourceHeader: `${source.family}_id`,
        contractField: `${source.family}.id`,
        sanitization: "none",
        owner: "Data Owner",
        required: true,
        exceptionPolicy: "BLOCK when missing",
      }];
  }
  return manifest;
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

function acceptedResultManifest(relativeDir: string) {
  const result = JSON.parse(readFileSync(exampleResultPath, "utf8"));
  result.mode = "dry_run";
  result.sourceManifest.path = `${relativeDir}/manifest.json`;
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
}

function authorizedReleaseManifest(resultPath: string) {
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
}

afterEach(() => {
  for (const target of createdPaths.splice(0)) {
    rmSync(target, { force: true, recursive: true });
  }
});

describe("front-profit acceptance status", () => {
  test("reports the init command when acceptance files are missing", () => {
    const result = runStatus([
      "--manifest",
      `${ignoredAcceptanceDir("missing")}/manifest.json`,
      "--result",
      `${ignoredAcceptanceDir("missing")}/result.json`,
      "--release",
      `${ignoredReleaseDir("missing")}/release.json`,
      "--strict",
    ]);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    expect(result.status, output).toBe(1);
    expect(output).toContain("FRONT_PROFIT_ACCEPTANCE_STATUS");
    expect(output).toContain("stage=not_initialized");
    expect(output).toContain("syntheticRehearsal=blocked");
    expect(output).toContain("front-profit:acceptance-init");
    expect(output).toContain("realSamples=not_read");
    expect(output).toContain("deployment=not_started");
  });

  test("recognizes initialized template manifests as not yet authorized", () => {
    const acceptanceDir = ignoredAcceptanceDir("template");
    const releaseDir = ignoredReleaseDir("template");
    createdPaths.push(join(repoRoot, acceptanceDir), join(repoRoot, releaseDir));
    const init = runInit(["--acceptance-dir", acceptanceDir, "--release-dir", releaseDir]);
    expect(init.status, `${init.stdout}${init.stderr}`).toBe(0);

    const result = runStatus([
      "--manifest",
      `${acceptanceDir}/manifest.json`,
      "--result",
      `${acceptanceDir}/result.json`,
      "--release",
      `${releaseDir}/release.json`,
    ]);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("stage=manifest_template_or_unauthorized");
    expect(output).toContain("fileGates=not_requested");
    expect(output).toContain("syntheticRehearsal=blocked");
    expect(output).toContain("next=fill authorized manifest.json");
  });

  test("reaches the production release gate passed status from authorized JSON evidence", () => {
    const acceptanceDir = ignoredAcceptanceDir("ready");
    const releaseDir = ignoredReleaseDir("ready");
    const manifestPath = writeJson(`${acceptanceDir}/manifest.json`, authorizedManifest(acceptanceDir));
    const resultPath = writeJson(`${acceptanceDir}/result.json`, acceptedResultManifest(acceptanceDir));
    const releasePath = writeJson(`${releaseDir}/release.json`, authorizedReleaseManifest(resultPath));

    const result = runStatus([
      "--manifest",
      manifestPath,
      "--result",
      resultPath,
      "--release",
      releasePath,
      "--strict",
    ]);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("stage=production_release_gate_passed");
    expect(output).toContain("fileGates=not_requested");
    expect(output).toContain("syntheticRehearsal=blocked");
    expect(output).toContain("realSamples=not_read");
    expect(output).toContain("deployment=not_started");
    expect(output).toContain("next=wait for explicit user deployment command");
  }, 20_000);

  test("blocks synthetic placeholders by default and allows them only for explicit rehearsal", () => {
    const acceptanceDir = ignoredAcceptanceDir("synthetic-guard");
    const releaseDir = ignoredReleaseDir("synthetic-guard");
    const manifest = authorizedManifest(acceptanceDir);
    manifest.authorization.authorizer = "synthetic-data-owner";
    manifest.authorization.executor = "synthetic-codex";
    manifest.authorization.isolationEnvironment = "synthetic-isolated-db";
    const resultManifest = acceptedResultManifest(acceptanceDir);
    resultManifest.dryRun.executor = "synthetic-result-executor";
    resultManifest.dryRun.isolationEnvironment = "synthetic-result-db";
    resultManifest.acceptance.acceptedBy = "synthetic-reviewer";
    const manifestPath = writeJson(`${acceptanceDir}/manifest.json`, manifest);
    const resultPath = writeJson(`${acceptanceDir}/result.json`, resultManifest);
    const release = authorizedReleaseManifest(resultPath);
    release.authorization.authorizer = "synthetic-release-authorizer";
    release.scope.platforms = ["synthetic-platform"];
    release.releaseArtifacts.targetImageTag = "synthetic-release-image";
    release.releaseArtifacts.dockerPackageManifest = writeDockerPackageManifest(
      "synthetic-guard-docker-package",
      release.releaseArtifacts.targetImageTag,
      release.releaseArtifacts.targetImageDigest,
    );
    const releasePath = writeJson(`${releaseDir}/release.json`, release);

    const blocked = runStatus([
      "--manifest",
      manifestPath,
      "--result",
      resultPath,
      "--release",
      releasePath,
      "--strict",
    ]);
    const allowed = runStatus([
      "--manifest",
      manifestPath,
      "--result",
      resultPath,
      "--release",
      releasePath,
      "--strict",
      "--allow-synthetic",
    ]);
    const blockedOutput = `${blocked.stdout ?? ""}${blocked.stderr ?? ""}`;
    const allowedOutput = `${allowed.stdout ?? ""}${allowed.stderr ?? ""}`;

    expect(blocked.status, blockedOutput).toBe(1);
    expect(blockedOutput).toContain("stage=manifest_preflight_failed");
    expect(blockedOutput).toContain("syntheticRehearsal=blocked");
    expect(blockedOutput).toContain("contains synthetic/placeholder markers");
    expect(allowed.status, allowedOutput).toBe(0);
    expect(allowedOutput).toContain("stage=synthetic_rehearsal_gate_passed");
    expect(allowedOutput).toContain("syntheticRehearsal=allowed");
    expect(allowedOutput).toContain("realSamples=not_read");
    expect(allowedOutput).toContain("deployment=not_started");
    expect(allowedOutput).toContain("replace synthetic rehearsal evidence with authorized real manifests");
  }, 20_000);

  test("runs sanitized CSV file gates only when explicitly requested", () => {
    const acceptanceDir = ignoredAcceptanceDir("file-gates");
    const releaseDir = ignoredReleaseDir("file-gates");
    const manifestPath = writeJson(`${acceptanceDir}/manifest.json`, authorizedManifest(acceptanceDir));
    const resultPath = writeJson(`${acceptanceDir}/result.json`, acceptedResultManifest(acceptanceDir));
    const releasePath = writeJson(`${releaseDir}/release.json`, authorizedReleaseManifest(resultPath));

    const result = runStatus([
      "--manifest",
      manifestPath,
      "--result",
      resultPath,
      "--release",
      releasePath,
      "--run-file-gates",
      "--strict",
    ]);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    expect(result.status, output).toBe(1);
    expect(output).toContain("stage=file_readiness_failed");
    expect(output).toContain("fileGates=failed");
    expect(output).toContain("syntheticRehearsal=blocked");
    expect(output).toContain("gate=acceptance_readiness");
    expect(output).toContain("realSamples=not_read");
    expect(output).toContain("deployment=not_started");
  }, 20_000);
});
