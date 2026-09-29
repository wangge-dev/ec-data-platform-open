import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const EXAMPLE_RESULT_RELATIVE_PATH = "docs/front-profit-acceptance-result.example.json";
const DEFAULT_RESULT = path.join(REPO_ROOT, EXAMPLE_RESULT_RELATIVE_PATH);
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const PRINTABLE_ASCII_PATTERN = /^[\x21-\x7E]{1,128}$/;
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
const REQUIRED_DRY_RUN_EVIDENCE_KINDS = [
  "dq_summary",
  "recon_summary",
  "diff_summary",
  "publish_smoke",
  "rollback_smoke",
] as const;

const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();

const evidenceArtifactSchema = z.object({
  kind: z.enum([
    "dq_summary",
    "recon_summary",
    "diff_summary",
    "publish_smoke",
    "rollback_smoke",
    "screenshot",
    "log",
    "other",
  ]),
  path: z.string().trim().min(1),
  sha256: z.string().regex(SHA256_PATTERN).optional(),
  containsSampleRows: z.boolean(),
  containsCredentials: z.boolean(),
});

const runResultSchema = z.object({
  period: z.string().regex(PERIOD_PATTERN),
  jobRunId: positiveInteger,
  sourceIds: z.array(positiveInteger).min(1),
  manualBaselineSourceId: positiveInteger,
  rowCounts: z.object({
    l4Rows: nonNegativeInteger,
    manualBaselineRows: positiveInteger,
    publishedRows: nonNegativeInteger,
  }),
  dq: z.object({
    unresolvedBlockCount: nonNegativeInteger,
    warningCount: nonNegativeInteger,
    quarantinedRowCount: nonNegativeInteger,
    explainedWarningCodes: z.array(z.string().trim().min(1)).default([]),
  }),
  recon: z.object({
    manualBaselineCompared: z.boolean(),
    aggregationKeyCoverage: z.number().min(0).max(1),
    failedCount: nonNegativeInteger,
    diffRowCount: nonNegativeInteger,
    maxMoneyDiff: z.number().nonnegative(),
  }),
  publish: z.object({
    authorityChangedByAdmin: z.boolean(),
    publishVersionId: positiveInteger,
    publishedRowCount: nonNegativeInteger,
    idempotencyKey: z.string().regex(PRINTABLE_ASCII_PATTERN),
    retryReturnedVersionId: positiveInteger,
    retryCreatedNewVersion: z.boolean(),
  }),
  rollback: z.object({
    rehearsed: z.boolean(),
    rolledBackVersionId: positiveInteger,
    restoredVersionId: positiveInteger,
    restoredRowCount: nonNegativeInteger,
    retryIdempotent: z.boolean(),
  }),
});

const resultManifestSchema = z.object({
  schemaVersion: z.literal("front-profit-real-sample-acceptance-result/v1"),
  mode: z.enum(["template", "dry_run"]),
  sourceManifest: z.object({
    path: z.string().trim().min(1),
    periods: z.array(z.string().regex(PERIOD_PATTERN)).min(1),
    preflightPassed: z.boolean(),
    checkFilesPassed: z.boolean(),
    readinessPassed: z.boolean(),
  }),
  dryRun: z.object({
    executedAt: z.string().regex(DATE_TIME_PATTERN),
    executor: z.string().trim().min(1),
    isolationEnvironment: z.string().trim().min(1),
    migrationPassed: z.boolean(),
    apiSmokePassed: z.boolean(),
    repoCheckPassed: z.boolean(),
  }),
  runs: z.array(runResultSchema).min(1),
  evidenceArtifacts: z.array(evidenceArtifactSchema).default([]),
  cleanup: z.object({
    temporaryDbRemoved: z.boolean(),
    temporaryUploadsRemoved: z.boolean(),
    temporaryExportsRemoved: z.boolean(),
    localCredentialsRemoved: z.boolean(),
    retainedEvidenceOnly: z.boolean(),
  }),
  acceptance: z.object({
    decision: z.enum(["pending", "pass", "fail"]),
    acceptedBy: z.string().trim().min(1),
    acceptedAt: z.string().regex(DATE_TIME_PATTERN),
    productionReleaseAuthorized: z.boolean(),
    notes: z.string().trim().optional(),
  }),
  confirmations: z.object({
    noSampleRowsInManifest: z.boolean(),
    noCredentialsInManifest: z.boolean(),
    noProductionDbTouched: z.boolean(),
    noCiDependency: z.boolean(),
  }),
});

type ResultManifest = z.infer<typeof resultManifestSchema>;

function resolveFromRepo(value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(REPO_ROOT, value);
}

function parseArgs(argv: string[]) {
  let resultPath = DEFAULT_RESULT;
  let templateOk = false;
  let allowSynthetic = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--result") {
      const next = argv[index + 1];
      if (!next) throw new Error("--result requires a path");
      resultPath = resolveFromRepo(next);
      index += 1;
    } else if (arg === "--template-ok") {
      templateOk = true;
    } else if (arg === "--allow-synthetic") {
      allowSynthetic = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: pnpm --filter @ec/api run front-profit:acceptance-result -- --result <result.json> [--template-ok] [--allow-synthetic]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { resultPath: resolveFromRepo(resultPath), templateOk, allowSynthetic };
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

function validateResultManifest(manifest: ResultManifest, resultPath: string, templateOk: boolean, allowSynthetic: boolean): string[] {
  const issues: string[] = [];
  const isTemplate = manifest.mode === "template";
  if (isTemplate && !templateOk) {
    addIssue(issues, "result manifest is in template mode; pass --template-ok only when validating the checked-in example");
  }
  if (!isTemplate && templateOk) {
    addIssue(issues, "--template-ok cannot be used with a dry_run result manifest");
  }
  if (!isTemplate && hasTemplateMarker(manifest)) {
    addIssue(issues, "dry_run result manifest still contains template markers such as TBD/TODO/N/A");
  }
  if (!isTemplate && !allowSynthetic && hasSyntheticMarker(manifest)) {
    addIssue(issues, "dry_run result manifest contains synthetic/placeholder markers; use --allow-synthetic only for local smoke rehearsal");
  }

  validateRepoIgnoredPath(issues, "result manifest", resultPath, EXAMPLE_RESULT_RELATIVE_PATH);
  validateRepoIgnoredPath(issues, "sourceManifest.path", manifest.sourceManifest.path);

  const sourcePeriods = sortedUnique(manifest.sourceManifest.periods);
  const runPeriods = sortedUnique(manifest.runs.map((run) => run.period));
  const missingRuns = sourcePeriods.filter((period) => !runPeriods.includes(period));
  const unexpectedRuns = runPeriods.filter((period) => !sourcePeriods.includes(period));
  if (missingRuns.length > 0) {
    addIssue(issues, `sourceManifest.periods missing dry run evidence for: ${missingRuns.join(", ")}`);
  }
  if (unexpectedRuns.length > 0) {
    addIssue(issues, `runs include periods not authorized by sourceManifest.periods: ${unexpectedRuns.join(", ")}`);
  }
  const duplicateRunPeriods = manifest.runs
    .map((run) => run.period)
    .filter((period, index, periods) => periods.indexOf(period) !== index);
  for (const period of sortedUnique(duplicateRunPeriods)) {
    addIssue(issues, `duplicate dry run result for period: ${period}`);
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
    if (!isTemplate && !existsSync(resolveFromRepo(artifact.path))) {
      addIssue(issues, `${label}.path does not exist: ${artifact.path}`);
    }
  }

  if (!isTemplate) {
    const evidenceKinds = new Set(manifest.evidenceArtifacts.map((artifact) => artifact.kind));
    for (const kind of REQUIRED_DRY_RUN_EVIDENCE_KINDS) {
      if (!evidenceKinds.has(kind)) {
        addIssue(issues, `dry_run evidenceArtifacts must include ${kind}`);
      }
    }

    if (!manifest.sourceManifest.preflightPassed) addIssue(issues, "source manifest preflight must pass before result acceptance");
    if (!manifest.sourceManifest.checkFilesPassed) addIssue(issues, "source manifest --check-files must pass before result acceptance");
    if (!manifest.sourceManifest.readinessPassed) addIssue(issues, "acceptance readiness must pass before result acceptance");
    if (!manifest.dryRun.migrationPassed) addIssue(issues, "dry run migration gate must pass");
    if (!manifest.dryRun.apiSmokePassed) addIssue(issues, "dry run API smoke gate must pass");
    if (!manifest.dryRun.repoCheckPassed) addIssue(issues, "repository boundary gate must pass");

    for (const run of manifest.runs) {
      const prefix = `period ${run.period}`;
      if (run.rowCounts.l4Rows <= 0) addIssue(issues, `${prefix} must produce L4 rows`);
      if (run.rowCounts.publishedRows <= 0) addIssue(issues, `${prefix} must publish rows during isolated dry run`);
      if (run.dq.unresolvedBlockCount !== 0) addIssue(issues, `${prefix} unresolved BLOCK count must be 0`);
      if (!run.recon.manualBaselineCompared) addIssue(issues, `${prefix} must compare against manual baseline`);
      if (run.recon.aggregationKeyCoverage !== 1) addIssue(issues, `${prefix} aggregation key coverage must be 1`);
      if (run.recon.failedCount !== 0) addIssue(issues, `${prefix} recon failedCount must be 0`);
      if (run.recon.maxMoneyDiff > 0.01) addIssue(issues, `${prefix} maxMoneyDiff must be <= 0.01`);
      if (!run.publish.authorityChangedByAdmin) addIssue(issues, `${prefix} publish must be gated by an admin authority switch`);
      if (run.publish.publishedRowCount !== run.rowCounts.publishedRows) {
        addIssue(issues, `${prefix} publish.publishedRowCount must match rowCounts.publishedRows`);
      }
      if (run.publish.retryCreatedNewVersion) addIssue(issues, `${prefix} publish retry must not create a new version`);
      if (run.publish.retryReturnedVersionId !== run.publish.publishVersionId) {
        addIssue(issues, `${prefix} publish retry must return the original publishVersionId`);
      }
      if (!run.rollback.rehearsed) addIssue(issues, `${prefix} rollback must be rehearsed`);
      if (run.rollback.rolledBackVersionId !== run.publish.publishVersionId) {
        addIssue(issues, `${prefix} rollback.rolledBackVersionId must equal publish.publishVersionId`);
      }
      if (run.rollback.restoredVersionId === run.rollback.rolledBackVersionId) {
        addIssue(issues, `${prefix} rollback must restore a different previous version`);
      }
      if (!run.rollback.retryIdempotent) addIssue(issues, `${prefix} rollback retry must be idempotent`);
    }

    if (!manifest.cleanup.temporaryDbRemoved) addIssue(issues, "temporary dry-run DB must be removed or explicitly destroyed");
    if (!manifest.cleanup.temporaryUploadsRemoved) addIssue(issues, "temporary uploads must be removed");
    if (!manifest.cleanup.temporaryExportsRemoved) addIssue(issues, "temporary exports must be removed");
    if (!manifest.cleanup.localCredentialsRemoved) addIssue(issues, "local dry-run credentials must be removed");
    if (!manifest.cleanup.retainedEvidenceOnly) addIssue(issues, "retained material must be limited to approved evidence");
    if (manifest.acceptance.decision !== "pass") addIssue(issues, "acceptance.decision must be pass before production release discussion");
    if (manifest.acceptance.productionReleaseAuthorized) {
      addIssue(issues, "dry_run result manifest must not grant production release authorization");
    }
    if (!manifest.confirmations.noSampleRowsInManifest) addIssue(issues, "manifest must confirm no sample rows are stored");
    if (!manifest.confirmations.noCredentialsInManifest) addIssue(issues, "manifest must confirm no credentials are stored");
    if (!manifest.confirmations.noProductionDbTouched) addIssue(issues, "manifest must confirm production DB was not touched");
    if (!manifest.confirmations.noCiDependency) addIssue(issues, "manifest must confirm real samples are not CI dependencies");
  }

  return issues;
}

const { resultPath, templateOk, allowSynthetic } = parseArgs(process.argv.slice(2));

try {
  if (!existsSync(resultPath)) {
    throw new Error(`result manifest not found: ${resultPath}`);
  }

  const parsed = resultManifestSchema.safeParse(JSON.parse(readFileSync(resultPath, "utf8")));
  if (!parsed.success) {
    console.error("FRONT_PROFIT_ACCEPTANCE_RESULT_FAILED");
    for (const issue of parsed.error.issues) {
      console.error(`- ${issue.path.join(".") || "<root>"}: ${issue.message}`);
    }
    process.exit(1);
  }

  const issues = validateResultManifest(parsed.data, resultPath, templateOk, allowSynthetic);
  if (issues.length > 0) {
    console.error("FRONT_PROFIT_ACCEPTANCE_RESULT_FAILED");
    for (const issue of issues) console.error(issue);
    process.exit(1);
  }

  const periods = sortedUnique(parsed.data.runs.map((run) => run.period));
  const versions = parsed.data.runs.map((run) => run.publish.publishVersionId).join(",");
  console.log("FRONT_PROFIT_ACCEPTANCE_RESULT_OK");
  console.log(`result=${path.relative(REPO_ROOT, resultPath).replaceAll(path.sep, "/")}`);
  console.log(`mode=${parsed.data.mode}`);
  console.log(`periods=${periods.join(",")}`);
  console.log(`runs=${parsed.data.runs.length}`);
  console.log(`publishedVersions=${versions}`);
  console.log(`evidenceArtifacts=${parsed.data.evidenceArtifacts.length}`);
  if (allowSynthetic) console.log("syntheticRehearsal=allowed");
} catch (error) {
  console.error("FRONT_PROFIT_ACCEPTANCE_RESULT_FAILED");
  console.error(`- ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
