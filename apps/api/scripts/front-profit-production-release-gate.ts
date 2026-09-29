import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const API_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = path.resolve(API_ROOT, "../..");
const TSX_CLI = path.join(API_ROOT, "node_modules/tsx/dist/cli.mjs");
const ACCEPTANCE_RESULT_SCRIPT = path.join(API_ROOT, "scripts/front-profit-acceptance-result.ts");
const CAPACITY_MATRIX_GATE_SCRIPT = path.join(API_ROOT, "scripts/front-profit-capacity-matrix-gate.ts");
const EXAMPLE_RELEASE_RELATIVE_PATH = "docs/front-profit-production-release.example.json";
const DEFAULT_RELEASE = path.join(REPO_ROOT, EXAMPLE_RELEASE_RELATIVE_PATH);
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const TEMPLATE_MARKERS = new Set(["", "TBD", "TODO", "N/A"]);
const FORBIDDEN_EVIDENCE_EXTENSIONS = new Set([
  ".csv",
  ".db",
  ".dump",
  ".sqlite",
  ".xls",
  ".xlsx",
]);

const positiveInteger = z.number().int().positive();

const resultPeriodEvidenceSchema = z.object({
  schemaVersion: z.literal("front-profit-real-sample-acceptance-result/v1"),
  mode: z.literal("dry_run"),
  sourceManifest: z.object({
    periods: z.array(z.string().regex(PERIOD_PATTERN)).min(1),
  }),
  runs: z.array(z.object({
    period: z.string().regex(PERIOD_PATTERN),
  })).min(1),
  acceptance: z.object({
    decision: z.enum(["pending", "pass", "fail"]),
    productionReleaseAuthorized: z.boolean(),
  }),
});

const releaseEvidenceSchema = z.object({
  kind: z.enum([
    "acceptance_result",
    "migration_smoke",
    "api_smoke",
    "ui_smoke",
    "backup_record",
    "release_manifest",
    "other",
  ]),
  path: z.string().trim().min(1),
  sha256: z.string().regex(SHA256_PATTERN).optional(),
  containsSampleRows: z.boolean(),
  containsCredentials: z.boolean(),
});

const dockerPackageManifestSchema = z.object({
  targetImageTag: z.string().trim().min(1),
  targetImageDigest: z.string().regex(IMAGE_DIGEST_PATTERN),
  containsSampleRows: z.boolean(),
  containsCredentials: z.boolean(),
  noAutomaticDeployment: z.boolean(),
}).passthrough();

const windowSchema = z.object({
  startsAt: z.string().regex(DATE_TIME_PATTERN),
  endsAt: z.string().regex(DATE_TIME_PATTERN),
});

const releaseManifestSchema = z.object({
  schemaVersion: z.literal("front-profit-production-release/v1"),
  mode: z.enum(["template", "authorized"]),
  acceptanceResult: z.object({
    path: z.string().trim().min(1),
    periods: z.array(z.string().regex(PERIOD_PATTERN)).min(1),
    resultGatePassed: z.boolean(),
    acceptedDecision: z.enum(["pending", "pass", "fail"]),
    productionReleaseAuthorizedInResult: z.boolean(),
  }),
  authorization: z.object({
    authorized: z.boolean(),
    authorizedAt: z.string().regex(DATE_TIME_PATTERN),
    authorizer: z.string().trim().min(1),
    releaseOwner: z.string().trim().min(1),
    rollbackOwner: z.string().trim().min(1),
    observer: z.string().trim().min(1),
    purpose: z.literal("front-profit-production-release"),
    approvalRef: z.string().trim().min(1),
    confirmSeparateFromDryRun: z.boolean(),
  }),
  scope: z.object({
    rolloutMode: z.literal("initial_single_platform"),
    periods: z.array(z.string().regex(PERIOD_PATTERN)).min(1),
    platforms: z.array(z.string().trim().min(1)).min(1),
    authority: z.literal("auto"),
    observationDays: z.number().int().positive(),
    releaseWindow: windowSchema,
    observationWindow: windowSchema,
  }),
  technicalGates: z.object({
    apiTypecheckPassed: z.boolean(),
    apiVitestPassed: z.boolean(),
    webTypecheckPassed: z.boolean(),
    webBuildPassed: z.boolean(),
    repoCheckPassed: z.boolean(),
    freshMigrationPassed: z.boolean(),
    publishIdempotencySmokePassed: z.boolean(),
    rollbackSmokePassed: z.boolean(),
    capacityMatrixPassed: z.boolean(),
    acceptanceResultPassed: z.boolean(),
    adminManualReviewed: z.boolean(),
    uiSmokePassed: z.boolean(),
  }),
  releaseArtifacts: z.object({
    commitSha: z.string().regex(COMMIT_SHA_PATTERN),
    targetImageTag: z.string().trim().min(1),
    targetImageDigest: z.string().regex(IMAGE_DIGEST_PATTERN),
    dockerPackageManifest: z.string().trim().min(1).optional(),
    capacityMatrixResult: z.string().trim().min(1),
    migrationList: z.array(z.string().trim().min(1)).min(1),
    rollbackTargetVersionId: positiveInteger,
    backupReference: z.string().trim().min(1),
    currentConfigReference: z.string().trim().min(1),
  }),
  operations: z.object({
    releaseChecklistReviewed: z.boolean(),
    rollbackPlanReviewed: z.boolean(),
    monitorOwner: z.string().trim().min(1),
    incidentChannel: z.string().trim().min(1),
    fallbackDecisionAt: z.string().regex(DATE_TIME_PATTERN),
  }),
  evidenceArtifacts: z.array(releaseEvidenceSchema).default([]),
  confirmations: z.object({
    noCredentialsInManifest: z.boolean(),
    noSampleRowsInManifest: z.boolean(),
    noProductionDbCredentialsStored: z.boolean(),
    noCiRealSampleDependency: z.boolean(),
    noAutomaticDeployment: z.boolean(),
    productionReleaseIsExplicitlyAuthorized: z.boolean(),
  }),
});

type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

function resolveFromRepo(value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(REPO_ROOT, value);
}

function parseArgs(argv: string[]) {
  let releasePath = DEFAULT_RELEASE;
  let templateOk = false;
  let allowSynthetic = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--release") {
      const next = argv[index + 1];
      if (!next) throw new Error("--release requires a path");
      releasePath = resolveFromRepo(next);
      index += 1;
    } else if (arg === "--template-ok") {
      templateOk = true;
    } else if (arg === "--allow-synthetic") {
      allowSynthetic = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: pnpm --filter @ec/api run front-profit:production-release-gate -- --release <release.json> [--template-ok] [--allow-synthetic]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { releasePath: resolveFromRepo(releasePath), templateOk, allowSynthetic };
}

function relativeToRepo(value: string): string | null {
  const resolved = resolveFromRepo(value);
  const relative = path.relative(REPO_ROOT, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return relative.replaceAll(path.sep, "/");
  }
  return null;
}

function isIgnoredByGit(repoRelativePath: string): boolean {
  const result = spawnSync(
    "git",
    ["check-ignore", "--quiet", "--", repoRelativePath],
    { cwd: REPO_ROOT, stdio: "ignore", shell: false },
  );
  return result.status === 0;
}

function hasTemplateMarker(value: unknown): boolean {
  if (typeof value === "string") return TEMPLATE_MARKERS.has(value.trim());
  if (Array.isArray(value)) return value.some(hasTemplateMarker);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(hasTemplateMarker);
  }
  return false;
}

function hasSyntheticMarker(value: unknown): boolean {
  if (typeof value === "string") {
    return /\b(synthetic|placeholder|not[-_]?real|rehearsal)\b/i.test(value);
  }
  if (Array.isArray(value)) return value.some(hasSyntheticMarker);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(hasSyntheticMarker);
  }
  return false;
}

function addIssue(issues: string[], message: string) {
  issues.push(`- ${message}`);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSorted = sortedUnique(left);
  const rightSorted = sortedUnique(right);
  return leftSorted.length === rightSorted.length &&
    leftSorted.every((value, index) => value === rightSorted[index]);
}

function validateRepoIgnoredPath(
  issues: string[],
  label: string,
  value: string,
  allowedExample?: string,
) {
  const relative = relativeToRepo(value);
  if (!relative || relative === allowedExample) return;
  if (!isIgnoredByGit(relative)) {
    addIssue(issues, `${label} is inside the repo but is not git-ignored: ${relative}`);
  }
}

function requireTrue(issues: string[], value: boolean, message: string) {
  if (!value) addIssue(issues, message);
}

function gitCommitExists(commitSha: string): boolean {
  const result = spawnSync(
    "git",
    ["cat-file", "-e", `${commitSha}^{commit}`],
    { cwd: REPO_ROOT, stdio: "ignore", shell: false },
  );
  return result.status === 0;
}

function validateWindowOrder(issues: string[], label: string, window: { startsAt: string; endsAt: string }) {
  if (window.startsAt >= window.endsAt) {
    addIssue(issues, `${label}.startsAt must be earlier than ${label}.endsAt`);
  }
}

function validateReleaseManifest(manifest: ReleaseManifest, releasePath: string, templateOk: boolean, allowSynthetic: boolean): string[] {
  const issues: string[] = [];
  const isTemplate = manifest.mode === "template";
  if (isTemplate && !templateOk) {
    addIssue(issues, "release manifest is in template mode; pass --template-ok only when validating the checked-in example");
  }
  if (!isTemplate && templateOk) {
    addIssue(issues, "--template-ok cannot be used with an authorized release manifest");
  }
  if (!isTemplate && hasTemplateMarker(manifest)) {
    addIssue(issues, "authorized release manifest still contains template markers such as TBD/TODO/N/A");
  }
  if (!isTemplate && !allowSynthetic && hasSyntheticMarker(manifest)) {
    addIssue(issues, "authorized release manifest contains synthetic/placeholder markers; use --allow-synthetic only for local smoke rehearsal");
  }

  validateRepoIgnoredPath(issues, "release manifest", releasePath, EXAMPLE_RELEASE_RELATIVE_PATH);
  validateRepoIgnoredPath(issues, "acceptanceResult.path", manifest.acceptanceResult.path);
  if (manifest.releaseArtifacts.dockerPackageManifest) {
    validateRepoIgnoredPath(issues, "releaseArtifacts.dockerPackageManifest", manifest.releaseArtifacts.dockerPackageManifest);
  }
  validateRepoIgnoredPath(issues, "releaseArtifacts.capacityMatrixResult", manifest.releaseArtifacts.capacityMatrixResult);

  if (!isTemplate) {
    const resultRelative = relativeToRepo(manifest.acceptanceResult.path);
    if (resultRelative === "docs/front-profit-acceptance-result.example.json") {
      addIssue(issues, "authorized release must reference a real dry-run result manifest, not the checked-in example");
    }
    requireTrue(issues, manifest.acceptanceResult.resultGatePassed, "acceptance result gate must have passed");
    if (manifest.acceptanceResult.acceptedDecision !== "pass") {
      addIssue(issues, "acceptance result decision must be pass");
    }
    if (manifest.acceptanceResult.productionReleaseAuthorizedInResult) {
      addIssue(issues, "acceptance result must not be treated as production release authorization");
    }
    if (manifest.acceptanceResult.periods.length < 2) {
      addIssue(issues, "production release requires at least 2 accepted dry-run periods before the first rollout");
    }
    if (manifest.scope.periods.length !== 1) {
      addIssue(issues, "initial production rollout must target exactly 1 period");
    }
    if (manifest.scope.platforms.length !== 1) {
      addIssue(issues, "initial production rollout must target exactly 1 platform");
    }
    const acceptedPeriods = new Set(manifest.acceptanceResult.periods);
    const missingAcceptedPeriods = manifest.scope.periods.filter((period) => !acceptedPeriods.has(period));
    if (missingAcceptedPeriods.length > 0) {
      addIssue(issues, `release scope periods must be included in accepted dry-run periods: ${missingAcceptedPeriods.join(", ")}`);
    }
    requireTrue(issues, manifest.authorization.authorized, "production release authorization must be explicit");
    requireTrue(issues, manifest.authorization.confirmSeparateFromDryRun, "production release authorization must be separate from dry-run acceptance");
    if (manifest.scope.observationDays < 7) {
      addIssue(issues, "initial production rollout observationDays must be at least 7");
    }
    validateWindowOrder(issues, "scope.releaseWindow", manifest.scope.releaseWindow);
    validateWindowOrder(issues, "scope.observationWindow", manifest.scope.observationWindow);
    if (manifest.scope.releaseWindow.endsAt > manifest.scope.observationWindow.startsAt) {
      addIssue(issues, "observationWindow must start after the release window ends");
    }

    const technicalGateLabels: Array<[keyof ReleaseManifest["technicalGates"], string]> = [
      ["apiTypecheckPassed", "@ec/api typecheck must pass"],
      ["apiVitestPassed", "@ec/api vitest must pass"],
      ["webTypecheckPassed", "@ec/web typecheck must pass"],
      ["webBuildPassed", "@ec/web build must pass"],
      ["repoCheckPassed", "pnpm repo:check must pass"],
      ["freshMigrationPassed", "fresh DB migration gate must pass"],
      ["publishIdempotencySmokePassed", "publish idempotency smoke must pass"],
      ["rollbackSmokePassed", "rollback smoke must pass"],
      ["capacityMatrixPassed", "synthetic capacity matrix must pass"],
      ["acceptanceResultPassed", "front-profit:acceptance-result must pass"],
      ["adminManualReviewed", "admin manual must be reviewed"],
      ["uiSmokePassed", "front-profit UI smoke must pass"],
    ];
    for (const [key, message] of technicalGateLabels) {
      requireTrue(issues, manifest.technicalGates[key], message);
    }
    requireTrue(issues, manifest.operations.releaseChecklistReviewed, "release checklist must be reviewed");
    requireTrue(issues, manifest.operations.rollbackPlanReviewed, "rollback plan must be reviewed");
    requireTrue(issues, manifest.confirmations.noCredentialsInManifest, "release manifest must not contain credentials");
    requireTrue(issues, manifest.confirmations.noSampleRowsInManifest, "release manifest must not contain sample rows");
    requireTrue(issues, manifest.confirmations.noProductionDbCredentialsStored, "production DB credentials must not be stored in the manifest");
    requireTrue(issues, manifest.confirmations.noCiRealSampleDependency, "real samples must not become CI dependencies");
    requireTrue(issues, manifest.confirmations.noAutomaticDeployment, "release gate must not trigger automatic deployment");
    requireTrue(issues, manifest.confirmations.productionReleaseIsExplicitlyAuthorized, "production release must be explicitly authorized");
    if (!gitCommitExists(manifest.releaseArtifacts.commitSha)) {
      addIssue(issues, `releaseArtifacts.commitSha must exist in the local git history: ${manifest.releaseArtifacts.commitSha}`);
    }
    issues.push(...validateDockerPackageManifest(manifest));
  }

  for (const [index, artifact] of manifest.evidenceArtifacts.entries()) {
    const label = `evidenceArtifacts[${index}]`;
    validateRepoIgnoredPath(issues, `${label}.path`, artifact.path);
    const extension = path.extname(artifact.path.toLowerCase());
    if (FORBIDDEN_EVIDENCE_EXTENSIONS.has(extension)) {
      addIssue(issues, `${label}.path must not point at raw or tabular sample data: ${artifact.path}`);
    }
    if (artifact.containsSampleRows) {
      addIssue(issues, `${label} must not contain sample rows`);
    }
    if (artifact.containsCredentials) {
      addIssue(issues, `${label} must not contain credentials`);
    }
  }

  return issues;
}

function validateDockerPackageManifest(manifest: ReleaseManifest): string[] {
  const issues: string[] = [];
  const dockerPackageManifest = manifest.releaseArtifacts.dockerPackageManifest;
  if (!dockerPackageManifest) {
    addIssue(issues, "releaseArtifacts.dockerPackageManifest is required for authorized production release");
    return issues;
  }
  const manifestPath = resolveFromRepo(dockerPackageManifest);
  if (!existsSync(manifestPath)) {
    addIssue(issues, `docker package manifest not found: ${dockerPackageManifest}`);
    return issues;
  }
  const parsed = dockerPackageManifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (!parsed.success) {
    addIssue(issues, "docker package manifest could not be read");
    for (const issue of parsed.error.issues) {
      addIssue(issues, `docker package manifest ${issue.path.join(".") || "<root>"}: ${issue.message}`);
    }
    return issues;
  }
  if (parsed.data.targetImageTag !== manifest.releaseArtifacts.targetImageTag) {
    addIssue(
      issues,
      `docker package targetImageTag must match release manifest: docker=${parsed.data.targetImageTag} release=${manifest.releaseArtifacts.targetImageTag}`,
    );
  }
  if (parsed.data.targetImageDigest !== manifest.releaseArtifacts.targetImageDigest) {
    addIssue(
      issues,
      `docker package targetImageDigest must match release manifest: docker=${parsed.data.targetImageDigest} release=${manifest.releaseArtifacts.targetImageDigest}`,
    );
  }
  requireTrue(issues, !parsed.data.containsSampleRows, "docker package manifest must not contain sample rows");
  requireTrue(issues, !parsed.data.containsCredentials, "docker package manifest must not contain credentials");
  requireTrue(issues, parsed.data.noAutomaticDeployment, "docker package manifest must confirm no automatic deployment");
  return issues;
}

function runAcceptanceResultGate(resultPath: string, allowSynthetic: boolean): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [
    TSX_CLI,
    ACCEPTANCE_RESULT_SCRIPT,
    "--result",
    resultPath,
    ...(allowSynthetic ? ["--allow-synthetic"] : []),
  ], {
    cwd: API_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
}

function runCapacityMatrixGate(resultPath: string): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [
    TSX_CLI,
    CAPACITY_MATRIX_GATE_SCRIPT,
    "--result",
    resultPath,
    "--check-files",
  ], {
    cwd: API_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
}

function validateAcceptanceResultConsistency(manifest: ReleaseManifest): string[] {
  const issues: string[] = [];
  const resultPath = resolveFromRepo(manifest.acceptanceResult.path);
  if (!existsSync(resultPath)) {
    addIssue(issues, `acceptance result manifest not found for consistency check: ${manifest.acceptanceResult.path}`);
    return issues;
  }

  const parsed = resultPeriodEvidenceSchema.safeParse(JSON.parse(readFileSync(resultPath, "utf8")));
  if (!parsed.success) {
    addIssue(issues, "acceptance result manifest could not be read for release consistency");
    for (const issue of parsed.error.issues) {
      addIssue(issues, `acceptance result ${issue.path.join(".") || "<root>"}: ${issue.message}`);
    }
    return issues;
  }

  const declaredPeriods = sortedUnique(manifest.acceptanceResult.periods);
  const sourcePeriods = sortedUnique(parsed.data.sourceManifest.periods);
  const runPeriods = sortedUnique(parsed.data.runs.map((run) => run.period));
  if (!sameStringSet(declaredPeriods, sourcePeriods)) {
    addIssue(
      issues,
      `release acceptanceResult.periods must match result sourceManifest.periods: release=${declaredPeriods.join(",")} result=${sourcePeriods.join(",")}`,
    );
  }
  if (!sameStringSet(declaredPeriods, runPeriods)) {
    addIssue(
      issues,
      `release acceptanceResult.periods must match result runs.period: release=${declaredPeriods.join(",")} result=${runPeriods.join(",")}`,
    );
  }
  if (manifest.acceptanceResult.acceptedDecision !== parsed.data.acceptance.decision) {
    addIssue(
      issues,
      `release acceptedDecision must match result acceptance.decision: release=${manifest.acceptanceResult.acceptedDecision} result=${parsed.data.acceptance.decision}`,
    );
  }
  if (manifest.acceptanceResult.productionReleaseAuthorizedInResult !== parsed.data.acceptance.productionReleaseAuthorized) {
    addIssue(
      issues,
      "release productionReleaseAuthorizedInResult must match result acceptance.productionReleaseAuthorized",
    );
  }
  return issues;
}

function printCaptured(label: string, value: string) {
  const trimmed = value.trimEnd();
  if (!trimmed) return;
  console.error(`${label}:`);
  console.error(trimmed);
}

const { releasePath, templateOk, allowSynthetic } = parseArgs(process.argv.slice(2));

try {
  if (!existsSync(releasePath)) {
    throw new Error(`release manifest not found: ${releasePath}`);
  }

  const parsed = releaseManifestSchema.safeParse(JSON.parse(readFileSync(releasePath, "utf8")));
  if (!parsed.success) {
    console.error("FRONT_PROFIT_PRODUCTION_RELEASE_GATE_FAILED");
    for (const issue of parsed.error.issues) {
      console.error(`- ${issue.path.join(".") || "<root>"}: ${issue.message}`);
    }
    process.exit(1);
  }

  const issues = validateReleaseManifest(parsed.data, releasePath, templateOk, allowSynthetic);
  if (issues.length > 0) {
    console.error("FRONT_PROFIT_PRODUCTION_RELEASE_GATE_FAILED");
    for (const issue of issues) console.error(issue);
    process.exit(1);
  }

  if (parsed.data.mode === "authorized") {
    if (!existsSync(TSX_CLI)) {
      throw new Error(`tsx CLI not found: ${TSX_CLI}`);
    }
    const resultGate = runAcceptanceResultGate(parsed.data.acceptanceResult.path, allowSynthetic);
    if (resultGate.status !== 0) {
      console.error("FRONT_PROFIT_PRODUCTION_RELEASE_GATE_FAILED");
      console.error("gate=acceptance_result");
      console.error(`exitStatus=${resultGate.status ?? "unknown"}`);
      printCaptured("stdout", resultGate.stdout ?? "");
      printCaptured("stderr", resultGate.stderr ?? "");
      process.exit(1);
    }
    const consistencyIssues = validateAcceptanceResultConsistency(parsed.data);
    if (consistencyIssues.length > 0) {
      console.error("FRONT_PROFIT_PRODUCTION_RELEASE_GATE_FAILED");
      console.error("gate=acceptance_result_consistency");
      for (const issue of consistencyIssues) console.error(issue);
      process.exit(1);
    }
    const capacityGate = runCapacityMatrixGate(parsed.data.releaseArtifacts.capacityMatrixResult);
    if (capacityGate.status !== 0) {
      console.error("FRONT_PROFIT_PRODUCTION_RELEASE_GATE_FAILED");
      console.error("gate=capacity_matrix");
      console.error(`exitStatus=${capacityGate.status ?? "unknown"}`);
      printCaptured("stdout", capacityGate.stdout ?? "");
      printCaptured("stderr", capacityGate.stderr ?? "");
      process.exit(1);
    }
  }

  console.log("FRONT_PROFIT_PRODUCTION_RELEASE_GATE_OK");
  console.log(`release=${path.relative(REPO_ROOT, releasePath).replaceAll(path.sep, "/")}`);
  console.log(`mode=${parsed.data.mode}`);
  console.log(`releasePeriods=${sortedUnique(parsed.data.scope.periods).join(",")}`);
  console.log(`releasePlatforms=${sortedUnique(parsed.data.scope.platforms).join(",")}`);
  console.log(`acceptedPeriods=${sortedUnique(parsed.data.acceptanceResult.periods).join(",")}`);
  console.log(`targetImageTag=${parsed.data.releaseArtifacts.targetImageTag}`);
  console.log(`rollbackTargetVersionId=${parsed.data.releaseArtifacts.rollbackTargetVersionId}`);
  if (allowSynthetic) console.log("syntheticRehearsal=allowed");
} catch (error) {
  console.error("FRONT_PROFIT_PRODUCTION_RELEASE_GATE_FAILED");
  console.error(`- ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
