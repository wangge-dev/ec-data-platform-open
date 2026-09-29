import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const API_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = path.resolve(API_ROOT, "../..");
const DEFAULT_RESULT = path.join(
  API_ROOT,
  "artifacts/front-profit-capacity-matrix-db-gate-20260811/capacity-matrix-result.json",
);
const EXPECTED_ROWS = [50_000, 250_000, 500_000, 1_000_000] as const;
const EXPECTED_SYNTHETIC_DB_RUNNER_ROWS = [1_000, 10_000, 50_000] as const;
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
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
const CAPACITY_FILE_ROLES = [
  ["operator", "operator-assignment"],
  ["sales", "sales-fact"],
  ["costPeriod", "cost-period"],
  ["costUsage", "cost-usage"],
  ["rebate", "rebate"],
  ["fee", "fee-fact"],
  ["promotion", "promotion-spend"],
  ["baseline", "manual-baseline"],
] as const;

type CapacityFileRole = typeof CAPACITY_FILE_ROLES[number][0];

const fileEvidenceSchema = z.object({
  name: z.string().trim().min(1),
  rows: z.number().int().nonnegative(),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(SHA256_PATTERN),
});

const matrixEntrySchema = z.object({
  salesRows: z.number().int().positive(),
  outDir: z.string().trim().min(1),
  generateSeconds: z.number().nonnegative(),
  contractSeconds: z.number().nonnegative(),
  baselineWarnings: z.number().int().nonnegative(),
  files: z.object({
    operator: fileEvidenceSchema,
    sales: fileEvidenceSchema,
    costPeriod: fileEvidenceSchema,
    costUsage: fileEvidenceSchema,
    rebate: fileEvidenceSchema,
    fee: fileEvidenceSchema,
    promotion: fileEvidenceSchema,
    baseline: fileEvidenceSchema,
  }),
});

const syntheticDbRunnerTimingSchema = z.object({
  phase: z.string().trim().min(1),
  seconds: z.number().nonnegative(),
});

const syntheticDbRunnerEntrySchema = z.object({
  salesRows: z.number().int().positive(),
  status: z.enum(["passed", "failed"]),
  thresholdStatus: z.enum(["passed", "failed"]),
  thresholds: z.record(z.number().nonnegative()),
  totalSeconds: z.number().nonnegative(),
  resultPath: z.string().trim().min(1).optional(),
  timings: z.array(syntheticDbRunnerTimingSchema).optional(),
  layerRows: z.object({
    l1Rows: z.number().int().nonnegative(),
    l3Rows: z.number().int().nonnegative(),
    l4Rows: z.number().int().nonnegative(),
    reconRows: z.number().int().nonnegative(),
    dqRows: z.number().int().nonnegative(),
  }).optional(),
  publish: z.object({
    status: z.string().trim().min(1),
    stagedRowCount: z.number().int().nonnegative(),
  }).optional(),
  shadowRecon: z.object({
    reconCount: z.number().int().nonnegative(),
    dqCount: z.number().int().nonnegative(),
    passed: z.boolean(),
  }).optional(),
  runDetail: z.object({
    stepCount: z.number().int().nonnegative(),
    dqCount: z.number().int().nonnegative(),
    reconCount: z.number().int().nonnegative(),
    l4PreviewCount: z.number().int().nonnegative(),
    publishVersionCount: z.number().int().nonnegative(),
  }).optional(),
  failureEvidence: z.object({
    exitStatus: z.number().int().nullable(),
    message: z.string().trim().min(1),
    stdoutTail: z.string(),
    stderrTail: z.string(),
  }).optional(),
});

const syntheticDbRunnerSchema = z.object({
  rows: z.array(z.number().int().positive()).min(1),
  command: z.string().trim().min(1),
  entries: z.array(syntheticDbRunnerEntrySchema).min(1),
});

const capacityMatrixSchema = z.object({
  schema: z.literal("front-profit-capacity-matrix-result/v1"),
  period: z.string().regex(PERIOD_PATTERN),
  seed: z.number().int().positive(),
  rows: z.array(z.number().int().positive()).min(1),
  outDir: z.string().trim().min(1),
  generatedAt: z.string().regex(DATE_TIME_PATTERN),
  matrix: z.array(matrixEntrySchema).min(1),
  syntheticDbRunner: syntheticDbRunnerSchema,
});

type CapacityMatrix = z.infer<typeof capacityMatrixSchema>;
type FileEvidence = z.infer<typeof fileEvidenceSchema>;
type SyntheticDbRunnerEntry = z.infer<typeof syntheticDbRunnerEntrySchema>;

function resolveFromRepo(value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(REPO_ROOT, value);
}

function parseArgs(argv: string[]) {
  let resultPath = DEFAULT_RESULT;
  let checkFiles = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--result") {
      const next = argv[index + 1];
      if (!next) throw new Error("--result requires a path");
      resultPath = resolveFromRepo(next);
      index += 1;
    } else if (arg === "--check-files") {
      checkFiles = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: pnpm --filter @ec/api run front-profit:capacity-matrix-gate -- [--result <capacity-matrix-result.json>] [--check-files]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { resultPath: resolveFromRepo(resultPath), checkFiles };
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

function sortedUnique(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function addIssue(issues: string[], message: string) {
  issues.push(`- ${message}`);
}

function validateRepoIgnoredPath(issues: string[], label: string, value: string) {
  const relative = relativeToRepo(value);
  if (!relative) return;
  if (!isIgnoredByGit(relative)) {
    addIssue(issues, `${label} is inside the repo but is not git-ignored: ${relative}`);
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", resolve);
  });
  return hash.digest("hex").toUpperCase();
}

function expectedFileName(rows: number, role: string): string {
  return `capacity-${rows}-${role}.csv`;
}

function validateMatrixMetadata(manifest: CapacityMatrix, resultPath: string): string[] {
  const issues: string[] = [];
  validateRepoIgnoredPath(issues, "capacity matrix result", resultPath);
  validateRepoIgnoredPath(issues, "capacity matrix outDir", manifest.outDir);

  const expectedRows = [...EXPECTED_ROWS];
  const declaredRows = sortedUnique(manifest.rows);
  const matrixRows = sortedUnique(manifest.matrix.map((entry) => entry.salesRows));
  if (JSON.stringify(declaredRows) !== JSON.stringify(expectedRows)) {
    addIssue(issues, `capacity matrix rows must be exactly ${expectedRows.join(",")}; got ${declaredRows.join(",")}`);
  }
  if (JSON.stringify(matrixRows) !== JSON.stringify(expectedRows)) {
    addIssue(issues, `capacity matrix entries must cover exactly ${expectedRows.join(",")}; got ${matrixRows.join(",")}`);
  }
  if (manifest.matrix.length !== EXPECTED_ROWS.length) {
    addIssue(issues, `capacity matrix must contain ${EXPECTED_ROWS.length} entries`);
  }

  const seen = new Set<number>();
  for (const entry of manifest.matrix) {
    const label = `rows ${entry.salesRows}`;
    if (seen.has(entry.salesRows)) addIssue(issues, `${label} appears more than once`);
    seen.add(entry.salesRows);
    validateRepoIgnoredPath(issues, `${label} outDir`, entry.outDir);
    if (entry.baselineWarnings !== 0) {
      addIssue(issues, `${label} baselineWarnings must be 0`);
    }
    if (entry.files.sales.rows !== entry.salesRows) {
      addIssue(issues, `${label} sales file rows must match salesRows`);
    }
    if (entry.files.operator.rows <= 0) {
      addIssue(issues, `${label} operator file must contain rows`);
    }
    if (entry.files.costPeriod.rows <= 0) {
      addIssue(issues, `${label} costPeriod file must contain rows`);
    }
    if (entry.files.costUsage.rows !== entry.salesRows) {
      addIssue(issues, `${label} costUsage file rows must match salesRows`);
    }
    if (entry.files.rebate.rows <= 0) {
      addIssue(issues, `${label} rebate file must contain rows`);
    }
    if (entry.files.fee.rows <= 0) {
      addIssue(issues, `${label} fee file must contain rows`);
    }
    if (entry.files.promotion.rows <= 0) {
      addIssue(issues, `${label} promotion file must contain rows`);
    }
    if (entry.files.baseline.rows <= 0) {
      addIssue(issues, `${label} baseline file must contain rows`);
    }
    for (const [key, suffix] of CAPACITY_FILE_ROLES) {
      const expectedName = expectedFileName(entry.salesRows, suffix);
      if (entry.files[key].name !== expectedName) {
        addIssue(issues, `${label} ${key} evidence name must be ${expectedName}`);
      }
    }
  }
  if (!manifest.syntheticDbRunner.command.includes("front-profit:synthetic-db-runner")) {
    addIssue(issues, "syntheticDbRunner.command must call front-profit:synthetic-db-runner");
  }
  const runnerRows = sortedUnique(manifest.syntheticDbRunner.rows);
  const runnerEntryRows = sortedUnique(manifest.syntheticDbRunner.entries.map((entry) => entry.salesRows));
  const expectedRunnerRows = [...EXPECTED_SYNTHETIC_DB_RUNNER_ROWS];
  if (JSON.stringify(runnerRows) !== JSON.stringify(expectedRunnerRows)) {
    addIssue(issues, `synthetic DB runner rows must be exactly ${expectedRunnerRows.join(",")}; got ${runnerRows.join(",")}`);
  }
  if (JSON.stringify(runnerEntryRows) !== JSON.stringify(expectedRunnerRows)) {
    addIssue(issues, `synthetic DB runner entries must cover exactly ${expectedRunnerRows.join(",")}; got ${runnerEntryRows.join(",")}`);
  }
  if (manifest.syntheticDbRunner.entries.length !== EXPECTED_SYNTHETIC_DB_RUNNER_ROWS.length) {
    addIssue(issues, `synthetic DB runner must contain ${EXPECTED_SYNTHETIC_DB_RUNNER_ROWS.length} entries`);
  }
  const seenRunnerRows = new Set<number>();
  for (const entry of manifest.syntheticDbRunner.entries) {
    validateSyntheticDbRunnerEntry(issues, entry);
    if (seenRunnerRows.has(entry.salesRows)) addIssue(issues, `synthetic DB runner rows ${entry.salesRows} appears more than once`);
    seenRunnerRows.add(entry.salesRows);
  }
  return issues;
}

function timingSeconds(entry: SyntheticDbRunnerEntry): Map<string, number> {
  return new Map((entry.timings ?? []).map((timing) => [timing.phase, timing.seconds]));
}

function validateThresholds(
  issues: string[],
  label: string,
  entry: SyntheticDbRunnerEntry,
  expected: Record<string, number>,
) {
  for (const [phase, threshold] of Object.entries(expected)) {
    if (entry.thresholds[phase] !== threshold) {
      addIssue(issues, `${label} threshold ${phase} must be ${threshold}; got ${entry.thresholds[phase] ?? "missing"}`);
    }
  }
  if (entry.totalSeconds > expected.total!) {
    addIssue(issues, `${label} totalSeconds ${entry.totalSeconds} exceeds threshold ${expected.total}`);
  }
  const timings = timingSeconds(entry);
  for (const [phase, threshold] of Object.entries(expected)) {
    if (phase === "total") continue;
    const actual = timings.get(phase);
    if (actual == null) {
      addIssue(issues, `${label} timing ${phase} is missing`);
    } else if (actual > threshold) {
      addIssue(issues, `${label} timing ${phase} ${actual} exceeds threshold ${threshold}`);
    }
  }
}

function validateSyntheticDbRunnerEntry(issues: string[], entry: SyntheticDbRunnerEntry) {
  const label = `synthetic DB runner rows ${entry.salesRows}`;
  const expected = SYNTHETIC_DB_RUNNER_THRESHOLDS[entry.salesRows];
  if (!expected) {
    addIssue(issues, `${label} is not an expected row tier`);
    return;
  }
  if (entry.resultPath) validateRepoIgnoredPath(issues, `${label} resultPath`, entry.resultPath);
  validateThresholds(issues, label, entry, expected);
  if (entry.status !== "passed") {
    addIssue(issues, `${label} status must be passed`);
  }
  if (entry.thresholdStatus !== "passed") {
    addIssue(issues, `${label} thresholdStatus must be passed`);
  }
  if (entry.status !== "passed" || entry.thresholdStatus !== "passed") {
    if (!entry.failureEvidence) addIssue(issues, `${label} failureEvidence is required for failed evidence`);
    return;
  }
  if (!entry.layerRows) addIssue(issues, `${label} layerRows is required`);
  else {
    if (entry.layerRows.l1Rows <= 0) addIssue(issues, `${label} l1Rows must be positive`);
    if (entry.layerRows.l3Rows <= 0) addIssue(issues, `${label} l3Rows must be positive`);
    if (entry.layerRows.l4Rows <= 0) addIssue(issues, `${label} l4Rows must be positive`);
    if (entry.layerRows.reconRows <= 0) addIssue(issues, `${label} reconRows must be positive`);
    if (entry.layerRows.dqRows !== 0) addIssue(issues, `${label} dqRows must be 0`);
  }
  if (!entry.publish) addIssue(issues, `${label} publish evidence is required`);
  else {
    if (entry.publish.status !== "published") addIssue(issues, `${label} publish.status must be published`);
    if (entry.layerRows && entry.publish.stagedRowCount !== entry.layerRows.l4Rows) {
      addIssue(issues, `${label} publish.stagedRowCount must match l4Rows`);
    }
  }
  if (!entry.shadowRecon) addIssue(issues, `${label} shadowRecon evidence is required`);
  else {
    if (entry.shadowRecon.passed !== true) addIssue(issues, `${label} shadowRecon.passed must be true`);
    if (entry.shadowRecon.dqCount !== 0) addIssue(issues, `${label} shadowRecon.dqCount must be 0`);
    if (entry.shadowRecon.reconCount <= 0) addIssue(issues, `${label} shadowRecon.reconCount must be positive`);
  }
  if (!entry.runDetail) addIssue(issues, `${label} runDetail evidence is required`);
  else {
    if (entry.runDetail.stepCount < 4) addIssue(issues, `${label} runDetail.stepCount must be at least 4`);
    if (entry.runDetail.dqCount !== 0) addIssue(issues, `${label} runDetail.dqCount must be 0`);
    if (entry.runDetail.reconCount <= 0) addIssue(issues, `${label} runDetail.reconCount must be positive`);
    if (entry.runDetail.l4PreviewCount <= 0) addIssue(issues, `${label} runDetail.l4PreviewCount must be positive`);
    if (entry.runDetail.publishVersionCount <= 0) addIssue(issues, `${label} runDetail.publishVersionCount must be positive`);
  }
}

async function validateFileEvidence(issues: string[], outDir: string, label: string, evidence: FileEvidence): Promise<void> {
  const filePath = path.join(resolveFromRepo(outDir), evidence.name);
  if (!existsSync(filePath)) {
    addIssue(issues, `${label} file not found: ${filePath}`);
    return;
  }
  const stat = statSync(filePath);
  if (stat.size !== evidence.bytes) {
    addIssue(issues, `${label} bytes mismatch: manifest=${evidence.bytes}, file=${stat.size}`);
  }
  const actualSha = await sha256File(filePath);
  if (actualSha !== evidence.sha256.toUpperCase()) {
    addIssue(issues, `${label} sha256 mismatch: manifest=${evidence.sha256}, file=${actualSha}`);
  }
}

async function validateMatrixFiles(manifest: CapacityMatrix): Promise<string[]> {
  const issues: string[] = [];
  for (const entry of manifest.matrix) {
    for (const [role] of CAPACITY_FILE_ROLES) {
      await validateFileEvidence(issues, entry.outDir, `rows ${entry.salesRows} ${role}`, entry.files[role]);
    }
  }
  return issues;
}

const { resultPath, checkFiles } = parseArgs(process.argv.slice(2));

try {
  if (!existsSync(resultPath)) {
    throw new Error(`capacity matrix result not found: ${resultPath}`);
  }

  const parsed = capacityMatrixSchema.safeParse(JSON.parse(readFileSync(resultPath, "utf8")));
  if (!parsed.success) {
    console.error("FRONT_PROFIT_CAPACITY_MATRIX_GATE_FAILED");
    for (const issue of parsed.error.issues) {
      console.error(`- ${issue.path.join(".") || "<root>"}: ${issue.message}`);
    }
    process.exit(1);
  }

  const issues = [
    ...validateMatrixMetadata(parsed.data, resultPath),
    ...(checkFiles ? await validateMatrixFiles(parsed.data) : []),
  ];
  if (issues.length > 0) {
    console.error("FRONT_PROFIT_CAPACITY_MATRIX_GATE_FAILED");
    for (const issue of issues) console.error(issue);
    process.exit(1);
  }

  console.log("FRONT_PROFIT_CAPACITY_MATRIX_GATE_OK");
  console.log(`result=${path.relative(REPO_ROOT, resultPath).replaceAll(path.sep, "/")}`);
  console.log(`period=${parsed.data.period}`);
  console.log(`seed=${parsed.data.seed}`);
  console.log(`rows=${sortedUnique(parsed.data.rows).join(",")}`);
  console.log(`matrixEntries=${parsed.data.matrix.length}`);
  console.log(`syntheticDbRunnerRows=${sortedUnique(parsed.data.syntheticDbRunner.rows).join(",")}`);
  console.log(`syntheticDbRunnerEntries=${parsed.data.syntheticDbRunner.entries.length}`);
  console.log(`fileEvidence=${checkFiles ? "checked" : "not_checked"}`);
} catch (error) {
  console.error("FRONT_PROFIT_CAPACITY_MATRIX_GATE_FAILED");
  console.error(`- ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
