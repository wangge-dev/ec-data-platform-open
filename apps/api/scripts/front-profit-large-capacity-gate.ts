import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { LARGE_CAPACITY_ROWS, LARGE_CAPACITY_THRESHOLDS } from "./front-profit-large-capacity-contract.js";

const API_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = path.resolve(API_ROOT, "../..");
const DEFAULT_RESULT = path.join(
  REPO_ROOT,
  "artifacts/front-profit-large-capacity-20260822/large-capacity-evidence.json",
);
const EXPECTED_ROWS = LARGE_CAPACITY_ROWS;
const MIN_RESOURCE_SAMPLES = 30;
const MAX_SAMPLE_INTERVAL_MS = 2_000;

const positiveNumber = z.number().finite().positive();
const nonnegativeInteger = z.number().int().nonnegative();
const thresholdSchema = z.object({
  totalSeconds: positiveNumber,
  recoveryTotalSeconds: positiveNumber,
  fixtureGenerateSeconds: positiveNumber,
  ufLoadSeconds: positiveNumber,
  draftSeconds: positiveNumber,
  recoveryDraftSeconds: positiveNumber,
  alignedBaselineLoadSeconds: positiveNumber,
  shadowReconSeconds: positiveNumber,
  publishSeconds: positiveNumber,
  runDetailQuerySeconds: positiveNumber,
  postgresPeakMemoryBytes: z.number().int().positive(),
  runnerPeakWorkingSetBytes: z.number().int().positive(),
  databaseBytesAfterRun: z.number().int().positive(),
  volumeGrowthBytes: z.number().int().positive(),
  maxDraftSpreadRatio: positiveNumber,
}).strict();

const successfulRunSchema = z.object({
  kind: z.enum(["clean_repeat", "recovery_retry"]),
  resultPath: z.string().trim().min(1),
  totalSeconds: positiveNumber,
  timings: z.object({
    fixtureGenerateSeconds: nonnegativeInteger.or(positiveNumber),
    ufLoadSeconds: nonnegativeInteger.or(positiveNumber),
    draftSeconds: nonnegativeInteger.or(positiveNumber),
    alignedBaselineLoadSeconds: nonnegativeInteger.or(positiveNumber),
    shadowReconSeconds: nonnegativeInteger.or(positiveNumber),
    publishSeconds: nonnegativeInteger.or(positiveNumber),
    runDetailQuerySeconds: nonnegativeInteger.or(positiveNumber),
  }).strict(),
  layerRows: z.object({
    l1Rows: z.number().int().positive(),
    l3Rows: z.number().int().positive(),
    l4Rows: z.number().int().positive(),
    reconRows: z.number().int().positive(),
    dqRows: nonnegativeInteger,
  }).strict(),
  publish: z.object({
    status: z.literal("published"),
    stagedRowCount: z.number().int().positive(),
  }).strict(),
  shadowRecon: z.object({
    passed: z.literal(true),
    maxAbsoluteDiff: z.number().finite().nonnegative(),
  }).strict(),
  resources: z.object({
    sampleIntervalMs: z.number().int().positive(),
    sampleCount: z.number().int().positive(),
    postgresPeakMemoryBytes: z.number().int().positive(),
    postgresPeakCpuPercent: z.number().finite().nonnegative(),
    runnerProcessTreePeakWorkingSetBytes: z.number().int().positive(),
    databaseBytesAfterMigration: z.number().int().positive(),
    databaseBytesAfterRun: z.number().int().positive(),
    databaseGrowthBytes: z.number().int().nonnegative(),
    volumeBytesAfterMigration: z.number().int().positive(),
    volumeBytesAfterRun: z.number().int().positive(),
    volumeGrowthBytes: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const rollbackCountsSchema = z.object({
  jobRuns: nonnegativeInteger,
  jobSteps: nonnegativeInteger,
  l1Rows: nonnegativeInteger,
  l3Rows: nonnegativeInteger,
  l4Rows: nonnegativeInteger,
  dqEvents: nonnegativeInteger,
  reconResults: nonnegativeInteger,
  publishVersions: nonnegativeInteger,
  publishedRows: nonnegativeInteger,
}).strict();

const tierSchema = z.object({
  salesRows: z.union([z.literal(500_000), z.literal(1_000_000)]),
  successfulRuns: z.array(successfulRunSchema).min(1),
  failureRecovery: z.object({
    method: z.literal("pg_terminate_backend_on_front_profit_operator_assignment_insert"),
    failureExitStatus: z.number().int(),
    machineFailureResultPath: z.string().trim().min(1),
    machineFailureSchema: z.literal("front-profit-synthetic-db-runner-failure/v1"),
    failureCode: z.literal("FRONT_PROFIT_SYNTHETIC_DB_RUNNER_FAILED"),
    failurePhase: z.literal("draft_l1_l3_l4"),
    rollbackCounts: rollbackCountsSchema,
    externalResidue: z.object({
      registeredSources: nonnegativeInteger,
      userDataTables: nonnegativeInteger,
    }).strict(),
    recoveryResultPath: z.string().trim().min(1),
    sameSeed: z.boolean(),
    fixtureHashMismatches: nonnegativeInteger,
  }).strict(),
}).strict();

const evidenceSchema = z.object({
  schema: z.literal("front-profit-large-capacity-evidence/v1"),
  generatedAt: z.string().datetime(),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/i),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  seed: z.number().int().positive(),
  thresholds: z.object({
    "500000": thresholdSchema,
    "1000000": thresholdSchema,
  }).strict(),
  tiers: z.array(tierSchema),
  cleanup: z.object({
    composeProject: z.string().trim().min(1),
    isolatedContainers: nonnegativeInteger,
    isolatedVolumes: nonnegativeInteger,
    isolatedNetworks: nonnegativeInteger,
    portListeners: nonnegativeInteger,
  }).strict(),
  boundary: z.object({
    deterministicSyntheticOnly: z.literal(true),
    realSamplesUsed: z.literal(false),
    deploymentStarted: z.literal(false),
    productionReleaseAuthorized: z.literal(false),
    productionSlaProven: z.literal(false),
  }).strict(),
}).strict();

type Evidence = z.infer<typeof evidenceSchema>;
type SuccessfulRun = z.infer<typeof successfulRunSchema>;
type Tier = z.infer<typeof tierSchema>;

function resolveFromRepo(value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(REPO_ROOT, value);
}

function parseArgs(argv: string[]) {
  let resultPath = DEFAULT_RESULT;
  let checkFiles = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--result") {
      const value = argv[index + 1];
      if (!value) throw new Error("--result requires a path");
      resultPath = resolveFromRepo(value);
      index += 1;
    } else if (arg === "--check-files") {
      checkFiles = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: front-profit:large-capacity-gate -- --result <large-capacity-evidence.json> [--check-files]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { resultPath, checkFiles };
}

function addIssue(issues: string[], message: string): void {
  issues.push(`- ${message}`);
}

function repoRelativeIgnoredPath(issues: string[], label: string, value: string): string | null {
  const resolved = resolveFromRepo(value);
  const relative = path.relative(REPO_ROOT, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    addIssue(issues, `${label} must stay inside a git-ignored repository evidence directory`);
    return null;
  }
  const normalized = relative.replaceAll(path.sep, "/");
  const ignored = spawnSync("git", ["check-ignore", "--quiet", "--", normalized], {
    cwd: REPO_ROOT,
    stdio: "ignore",
    shell: false,
  });
  if (ignored.status !== 0) {
    addIssue(issues, `${label} is not git-ignored: ${normalized}`);
    return null;
  }
  return normalized;
}

function validateThresholdContract(issues: string[], evidence: Evidence): void {
  for (const rows of EXPECTED_ROWS) {
    const declared = evidence.thresholds[String(rows) as "500000" | "1000000"];
    const expected = LARGE_CAPACITY_THRESHOLDS[rows];
    for (const [key, value] of Object.entries(expected)) {
      if (declared[key as keyof typeof declared] !== value) {
        addIssue(issues, `rows ${rows} threshold ${key} must be ${value}; got ${declared[key as keyof typeof declared]}`);
      }
    }
  }
}

function validateSourceCommit(issues: string[], commit: string): void {
  const result = spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
    cwd: REPO_ROOT,
    stdio: "ignore",
    shell: false,
  });
  if (result.status !== 0) addIssue(issues, `sourceCommit is not present in local Git history: ${commit}`);
}

function expectedRows(rows: number) {
  return rows === 500_000
    ? { l1Rows: 1_100_000, l3Rows: 1_055_000, l4Rows: 6_048 }
    : { l1Rows: 2_180_000, l3Rows: 2_110_000, l4Rows: 6_048 };
}

function validateRun(
  issues: string[],
  rows: 500_000 | 1_000_000,
  run: SuccessfulRun,
  index: number,
): void {
  const label = `rows ${rows} ${run.kind} run ${index + 1}`;
  const threshold = LARGE_CAPACITY_THRESHOLDS[rows];
  const totalSecondsThreshold = run.kind === "recovery_retry" ? threshold.recoveryTotalSeconds : threshold.totalSeconds;
  const draftSecondsThreshold = run.kind === "recovery_retry" ? threshold.recoveryDraftSeconds : threshold.draftSeconds;
  repoRelativeIgnoredPath(issues, `${label} resultPath`, run.resultPath);
  const comparisons = [
    ["totalSeconds", run.totalSeconds, totalSecondsThreshold],
    ["fixtureGenerateSeconds", run.timings.fixtureGenerateSeconds, threshold.fixtureGenerateSeconds],
    ["ufLoadSeconds", run.timings.ufLoadSeconds, threshold.ufLoadSeconds],
    ["draftSeconds", run.timings.draftSeconds, draftSecondsThreshold],
    ["alignedBaselineLoadSeconds", run.timings.alignedBaselineLoadSeconds, threshold.alignedBaselineLoadSeconds],
    ["shadowReconSeconds", run.timings.shadowReconSeconds, threshold.shadowReconSeconds],
    ["publishSeconds", run.timings.publishSeconds, threshold.publishSeconds],
    ["runDetailQuerySeconds", run.timings.runDetailQuerySeconds, threshold.runDetailQuerySeconds],
    ["postgresPeakMemoryBytes", run.resources.postgresPeakMemoryBytes, threshold.postgresPeakMemoryBytes],
    ["runnerPeakWorkingSetBytes", run.resources.runnerProcessTreePeakWorkingSetBytes, threshold.runnerPeakWorkingSetBytes],
    ["databaseBytesAfterRun", run.resources.databaseBytesAfterRun, threshold.databaseBytesAfterRun],
    ["volumeGrowthBytes", run.resources.volumeGrowthBytes, threshold.volumeGrowthBytes],
  ] as const;
  for (const [name, actual, maximum] of comparisons) {
    if (actual > maximum) addIssue(issues, `${label} ${name} ${actual} exceeds threshold ${maximum}`);
  }

  const expected = expectedRows(rows);
  for (const [key, value] of Object.entries(expected)) {
    if (run.layerRows[key as keyof typeof run.layerRows] !== value) {
      addIssue(issues, `${label} layerRows.${key} must be ${value}`);
    }
  }
  if (run.layerRows.reconRows !== 39) addIssue(issues, `${label} layerRows.reconRows must be 39`);
  if (run.layerRows.dqRows !== 0) addIssue(issues, `${label} layerRows.dqRows must be 0`);
  if (run.publish.stagedRowCount !== expected.l4Rows) addIssue(issues, `${label} publish.stagedRowCount must be ${expected.l4Rows}`);
  if (run.shadowRecon.maxAbsoluteDiff > 0.01) addIssue(issues, `${label} shadowRecon.maxAbsoluteDiff must be <= 0.01`);
  if (run.resources.sampleCount < MIN_RESOURCE_SAMPLES) {
    addIssue(issues, `${label} resources.sampleCount must be at least ${MIN_RESOURCE_SAMPLES}`);
  }
  if (run.resources.sampleIntervalMs > MAX_SAMPLE_INTERVAL_MS) {
    addIssue(issues, `${label} resources.sampleIntervalMs must be <= ${MAX_SAMPLE_INTERVAL_MS}`);
  }
  if (run.resources.databaseGrowthBytes !== run.resources.databaseBytesAfterRun - run.resources.databaseBytesAfterMigration) {
    addIssue(issues, `${label} databaseGrowthBytes does not match before/after values`);
  }
  if (run.resources.volumeGrowthBytes !== run.resources.volumeBytesAfterRun - run.resources.volumeBytesAfterMigration) {
    addIssue(issues, `${label} volumeGrowthBytes does not match before/after values`);
  }
}

function validateFailureRecovery(issues: string[], tier: Tier): void {
  const rows = tier.salesRows;
  const label = `rows ${rows} failureRecovery`;
  const recovery = tier.failureRecovery;
  if (recovery.failureExitStatus === 0) addIssue(issues, `${label} failureExitStatus must be non-zero`);
  repoRelativeIgnoredPath(issues, `${label} machineFailureResultPath`, recovery.machineFailureResultPath);
  repoRelativeIgnoredPath(issues, `${label} recoveryResultPath`, recovery.recoveryResultPath);
  for (const [key, value] of Object.entries(recovery.rollbackCounts)) {
    if (value !== 0) addIssue(issues, `${label} rollbackCounts.${key} must be 0`);
  }
  if (recovery.externalResidue.registeredSources !== 7) {
    addIssue(issues, `${label} externalResidue.registeredSources must be 7`);
  }
  if (recovery.externalResidue.userDataTables !== 7) {
    addIssue(issues, `${label} externalResidue.userDataTables must be 7`);
  }
  if (recovery.sameSeed !== true) addIssue(issues, `${label} sameSeed must be true`);
  if (recovery.fixtureHashMismatches !== 0) addIssue(issues, `${label} fixtureHashMismatches must be 0`);
  const recoveryRun = tier.successfulRuns.find((run) => run.kind === "recovery_retry");
  if (recoveryRun && resolveFromRepo(recoveryRun.resultPath) !== resolveFromRepo(recovery.recoveryResultPath)) {
    addIssue(issues, `${label} recoveryResultPath must match the recovery_retry resultPath`);
  }
}

function validateTier(issues: string[], tier: Tier): void {
  const rows = tier.salesRows;
  const cleanRuns = tier.successfulRuns.filter((run) => run.kind === "clean_repeat");
  const recoveryRuns = tier.successfulRuns.filter((run) => run.kind === "recovery_retry");
  if (tier.successfulRuns.length !== 2 || cleanRuns.length !== 1 || recoveryRuns.length !== 1) {
    addIssue(issues, `rows ${rows} must contain exactly one clean_repeat and one recovery_retry`);
  }
  tier.successfulRuns.forEach((run, index) => validateRun(issues, rows, run, index));
  const drafts = tier.successfulRuns.map((run) => run.timings.draftSeconds);
  if (drafts.length >= 2) {
    const spread = Math.max(...drafts) / Math.max(Math.min(...drafts), Number.EPSILON);
    const threshold = LARGE_CAPACITY_THRESHOLDS[rows].maxDraftSpreadRatio;
    if (spread > threshold) {
      addIssue(issues, `rows ${rows} draft spread ratio ${spread.toFixed(3)} exceeds threshold ${threshold}`);
    }
  }
  validateFailureRecovery(issues, tier);
}

function validateEvidence(evidence: Evidence, resultPath: string): string[] {
  const issues: string[] = [];
  repoRelativeIgnoredPath(issues, "large capacity evidence", resultPath);
  validateSourceCommit(issues, evidence.sourceCommit);
  validateThresholdContract(issues, evidence);
  const rows = [...new Set(evidence.tiers.map((tier) => tier.salesRows))].sort((left, right) => left - right);
  if (JSON.stringify(rows) !== JSON.stringify(EXPECTED_ROWS)) {
    addIssue(issues, `tiers must cover exactly ${EXPECTED_ROWS.join(",")}; got ${rows.join(",")}`);
  }
  if (evidence.tiers.length !== EXPECTED_ROWS.length) addIssue(issues, `tiers must contain ${EXPECTED_ROWS.length} entries`);
  evidence.tiers.forEach((tier) => validateTier(issues, tier));
  if (evidence.cleanup.isolatedContainers !== 0) addIssue(issues, "cleanup.isolatedContainers must be 0");
  if (evidence.cleanup.isolatedVolumes !== 0) addIssue(issues, "cleanup.isolatedVolumes must be 0");
  if (evidence.cleanup.isolatedNetworks !== 0) addIssue(issues, "cleanup.isolatedNetworks must be 0");
  if (evidence.cleanup.portListeners !== 0) addIssue(issues, "cleanup.portListeners must be 0");
  return issues;
}

function loadJson(value: string): unknown {
  return JSON.parse(readFileSync(resolveFromRepo(value), "utf8"));
}

function validateResultFiles(evidence: Evidence): string[] {
  const issues: string[] = [];
  for (const tier of evidence.tiers) {
    for (const run of tier.successfulRuns) {
      const resultPath = resolveFromRepo(run.resultPath);
      if (!existsSync(resultPath)) {
        addIssue(issues, `rows ${tier.salesRows} ${run.kind} result file not found: ${run.resultPath}`);
        continue;
      }
      const result = loadJson(run.resultPath) as any;
      if (result.schema !== "front-profit-synthetic-db-runner-result/v1") addIssue(issues, `${run.resultPath} has an unexpected schema`);
      if (result.period !== evidence.period || result.seed !== evidence.seed || result.requestedSalesRows !== tier.salesRows) {
        addIssue(issues, `${run.resultPath} period/seed/rows do not match the evidence`);
      }
      if (result.database?.realSamplesUsed !== false || result.database?.deploymentStarted !== false) {
        addIssue(issues, `${run.resultPath} violates the synthetic database boundary`);
      }
      const timings = new Map((result.timings ?? []).map((item: any) => [item.phase, Number(item.seconds)]));
      const expectedTimings = {
        fixture_generate: run.timings.fixtureGenerateSeconds,
        uf_load: run.timings.ufLoadSeconds,
        draft_l1_l3_l4: run.timings.draftSeconds,
        aligned_baseline_load: run.timings.alignedBaselineLoadSeconds,
        shadow_recon: run.timings.shadowReconSeconds,
        publish: run.timings.publishSeconds,
        run_detail_query: run.timings.runDetailQuerySeconds,
      };
      for (const [phase, seconds] of Object.entries(expectedTimings)) {
        if (timings.get(phase) !== seconds) addIssue(issues, `${run.resultPath} timing ${phase} does not match the evidence`);
      }
      for (const key of ["l1Rows", "l3Rows", "l4Rows", "reconRows", "dqRows"] as const) {
        if (Number(result.layerRows?.[key]) !== run.layerRows[key]) addIssue(issues, `${run.resultPath} layerRows.${key} does not match the evidence`);
      }
      if (result.publish?.status !== run.publish.status || Number(result.publish?.stagedRowCount) !== run.publish.stagedRowCount) {
        addIssue(issues, `${run.resultPath} publish evidence does not match`);
      }
      if (result.shadowRecon?.passed !== true || Number(result.shadowRecon?.maxAbsoluteDiff) !== run.shadowRecon.maxAbsoluteDiff) {
        addIssue(issues, `${run.resultPath} shadow recon evidence does not match`);
      }
    }

    const failurePath = tier.failureRecovery.machineFailureResultPath;
    if (!existsSync(resolveFromRepo(failurePath))) {
      addIssue(issues, `rows ${tier.salesRows} machine failure result file not found: ${failurePath}`);
    } else {
      const failure = loadJson(failurePath) as any;
      if (
        failure.schema !== tier.failureRecovery.machineFailureSchema
        || failure.failure?.code !== tier.failureRecovery.failureCode
        || failure.failure?.phase !== tier.failureRecovery.failurePhase
        || failure.period !== evidence.period
        || failure.seed !== evidence.seed
        || failure.requestedSalesRows !== tier.salesRows
      ) {
        addIssue(issues, `${failurePath} does not match the declared machine failure evidence`);
      }
      if (failure.database?.realSamplesUsed !== false || failure.database?.deploymentStarted !== false) {
        addIssue(issues, `${failurePath} violates the synthetic database boundary`);
      }
    }
  }
  return issues;
}

const { resultPath, checkFiles } = parseArgs(process.argv.slice(2));

try {
  if (!existsSync(resultPath)) throw new Error(`large capacity evidence not found: ${resultPath}`);
  const parsed = evidenceSchema.safeParse(JSON.parse(readFileSync(resultPath, "utf8")));
  if (!parsed.success) {
    console.error("FRONT_PROFIT_LARGE_CAPACITY_GATE_FAILED");
    parsed.error.issues.forEach((issue) => console.error(`- ${issue.path.join(".") || "<root>"}: ${issue.message}`));
    process.exit(1);
  }
  const issues = [
    ...validateEvidence(parsed.data, resultPath),
    ...(checkFiles ? validateResultFiles(parsed.data) : []),
  ];
  if (issues.length > 0) {
    console.error("FRONT_PROFIT_LARGE_CAPACITY_GATE_FAILED");
    issues.forEach((issue) => console.error(issue));
    process.exit(1);
  }
  console.log("FRONT_PROFIT_LARGE_CAPACITY_GATE_OK");
  console.log(`result=${path.relative(REPO_ROOT, resultPath).replaceAll(path.sep, "/")}`);
  console.log(`period=${parsed.data.period}`);
  console.log(`seed=${parsed.data.seed}`);
  console.log(`rows=${EXPECTED_ROWS.join(",")}`);
  console.log("successfulRunsPerTier=2");
  console.log("failureRecoveryPerTier=passed");
  console.log(`resultFiles=${checkFiles ? "checked" : "not_checked"}`);
} catch (error) {
  console.error("FRONT_PROFIT_LARGE_CAPACITY_GATE_FAILED");
  console.error(`- ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
