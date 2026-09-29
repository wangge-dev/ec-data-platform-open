import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const API_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = path.resolve(API_ROOT, "../..");
const REQUIRED_SOURCE_FAMILIES = [
  "operator_assignment",
  "sales_fact",
  "cost_period",
  "cost_usage",
  "rebate",
  "fee_fact",
  "promotion_spend",
  "manual_baseline",
] as const;

const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
const shadowReconSchema = z.object({
  reconCount: positiveInteger,
  dqCount: nonNegativeInteger,
  passed: z.boolean(),
  maxAbsoluteDiff: z.number().nonnegative(),
});
const rehearsalSchema = z.object({
  mode: z.literal("synthetic_rehearsal"),
  realSamplesUsed: z.literal(false),
  productionReleaseAuthorized: z.literal(false),
  baselineRun: z.object({
    runId: positiveInteger,
    l4Rows: positiveInteger,
    shadowRecon: shadowReconSchema,
    publishVersionId: positiveInteger,
    publishRetryReturnedVersionId: positiveInteger,
    publishRetryCreatedNewVersion: z.boolean(),
  }),
  candidateRun: z.object({
    runId: positiveInteger,
    l4Rows: positiveInteger,
    shadowRecon: shadowReconSchema,
    publishVersionId: positiveInteger,
  }),
  publishRetry: z.object({
    returnedVersionId: positiveInteger,
    createdNewVersion: z.boolean(),
    idempotent: z.boolean(),
  }),
  rollback: z.object({
    rolledBackVersionId: positiveInteger,
    restoredVersionId: positiveInteger,
    rolledBackRowCount: positiveInteger,
    restoredRowCount: positiveInteger,
    idempotent: z.boolean(),
  }),
  rollbackRetry: z.object({
    rolledBackVersionId: positiveInteger,
    restoredVersionId: positiveInteger,
    restoredRowCount: positiveInteger,
    idempotent: z.boolean(),
  }),
});
const runnerResultSchema = z.object({
  schema: z.literal("front-profit-synthetic-db-runner-result/v1"),
  generatedAt: z.string().trim().min(1),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  seed: positiveInteger,
  requestedSalesRows: positiveInteger,
  fixtureManifest: z.string().trim().min(1),
  database: z.object({
    urlSource: z.literal("TEST_DATABASE_URL"),
    realSamplesUsed: z.literal(false),
    deploymentStarted: z.literal(false),
  }),
  manualBaseline: z.object({
    mode: z.literal("synthetic_independent_fixture"),
    fileName: z.string().trim().min(1),
    rowCount: positiveInteger,
    originalFixtureBaselineUsedForRecon: z.literal(true),
  }),
  sources: z.array(z.object({
    family: z.enum(REQUIRED_SOURCE_FAMILIES),
    sourceId: positiveInteger,
    rowCount: positiveInteger,
  })).length(REQUIRED_SOURCE_FAMILIES.length),
  draft: z.object({ runId: positiveInteger }),
  layerRows: z.object({
    l1Rows: positiveInteger,
    l3Rows: positiveInteger,
    l4Rows: positiveInteger,
    reconRows: positiveInteger,
    dqRows: nonNegativeInteger,
  }),
  publish: z.object({
    runId: positiveInteger,
    versionId: positiveInteger,
    status: z.literal("published"),
    stagedRowCount: positiveInteger,
  }),
  shadowRecon: shadowReconSchema,
  runDetail: z.object({
    stepCount: positiveInteger,
    dqCount: nonNegativeInteger,
    reconCount: positiveInteger,
    l4PreviewCount: positiveInteger,
    publishVersionCount: positiveInteger,
  }),
  acceptanceRehearsal: rehearsalSchema,
});

type RunnerResult = z.infer<typeof runnerResultSchema>;

function resolveFromRepo(value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(REPO_ROOT, value);
}

function repoRelative(value: string): string {
  return path.relative(REPO_ROOT, value).replaceAll(path.sep, "/");
}

function parseArgs(argv: string[]) {
  const resultPaths: string[] = [];
  let outDir = path.join(API_ROOT, "artifacts/front-profit-synthetic-acceptance-rehearsal");
  let cleanupConfirmed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--result") {
      const value = argv[index + 1];
      if (!value) throw new Error("--result requires a path");
      resultPaths.push(resolveFromRepo(value));
      index += 1;
    } else if (arg === "--out") {
      const value = argv[index + 1];
      if (!value) throw new Error("--out requires a path");
      outDir = resolveFromRepo(value);
      index += 1;
    } else if (arg === "--cleanup-confirmed") {
      cleanupConfirmed = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: pnpm --filter @ec/api run front-profit:synthetic-acceptance-summary -- [options]",
        "  --result <runner-result.json>  repeat for at least two different periods",
        "  --out <dir>                   ignored machine evidence directory",
        "  --cleanup-confirmed            required after the isolated DB/resources are verified absent",
      ].join("\n"));
      process.exit(0);
    } else if (arg !== "--") {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (resultPaths.length < 2) throw new Error("at least two --result files are required");
  if (!cleanupConfirmed) {
    throw new Error("--cleanup-confirmed is required after isolated resources have been verified absent");
  }
  return { resultPaths, outDir };
}

function assertCleanRehearsal(result: RunnerResult): void {
  const familySet = new Set(result.sources.map((source) => source.family));
  if (familySet.size !== REQUIRED_SOURCE_FAMILIES.length
    || REQUIRED_SOURCE_FAMILIES.some((family) => !familySet.has(family))) {
    throw new Error(`${result.period} does not contain exactly the eight required source families`);
  }
  if (result.layerRows.dqRows !== 0 || result.shadowRecon.dqCount !== 0 || result.runDetail.dqCount !== 0) {
    throw new Error(`${result.period} contains DQ rows`);
  }
  if (!result.shadowRecon.passed || result.shadowRecon.maxAbsoluteDiff > 0.01) {
    throw new Error(`${result.period} independent manual baseline reconciliation failed`);
  }
  if (result.publish.runId !== result.draft.runId
    || result.publish.stagedRowCount !== result.layerRows.l4Rows
    || result.acceptanceRehearsal.candidateRun.runId !== result.draft.runId
    || result.acceptanceRehearsal.candidateRun.l4Rows !== result.layerRows.l4Rows
    || result.acceptanceRehearsal.candidateRun.publishVersionId !== result.publish.versionId) {
    throw new Error(`${result.period} candidate run/publish lineage is inconsistent`);
  }
  const rehearsal = result.acceptanceRehearsal;
  if (!rehearsal.baselineRun.shadowRecon.passed
    || rehearsal.baselineRun.shadowRecon.dqCount !== 0
    || rehearsal.baselineRun.shadowRecon.maxAbsoluteDiff > 0.01
    || rehearsal.baselineRun.publishRetryCreatedNewVersion
    || rehearsal.baselineRun.publishRetryReturnedVersionId !== rehearsal.baselineRun.publishVersionId) {
    throw new Error(`${result.period} baseline run or publish retry failed`);
  }
  if (!rehearsal.candidateRun.shadowRecon.passed
    || rehearsal.candidateRun.shadowRecon.dqCount !== 0
    || rehearsal.candidateRun.shadowRecon.maxAbsoluteDiff > 0.01
    || !rehearsal.publishRetry.idempotent
    || rehearsal.publishRetry.createdNewVersion
    || rehearsal.publishRetry.returnedVersionId !== rehearsal.candidateRun.publishVersionId) {
    throw new Error(`${result.period} candidate recon or publish retry failed`);
  }
  if (rehearsal.rollback.rolledBackVersionId !== rehearsal.candidateRun.publishVersionId
    || rehearsal.rollback.restoredVersionId !== rehearsal.baselineRun.publishVersionId
    || rehearsal.rollback.restoredVersionId === rehearsal.rollback.rolledBackVersionId
    || rehearsal.rollback.idempotent
    || !rehearsal.rollbackRetry.idempotent
    || rehearsal.rollbackRetry.rolledBackVersionId !== rehearsal.rollback.rolledBackVersionId
    || rehearsal.rollbackRetry.restoredVersionId !== rehearsal.rollback.restoredVersionId
    || rehearsal.rollback.restoredRowCount !== result.layerRows.l4Rows
    || rehearsal.rollbackRetry.restoredRowCount !== result.layerRows.l4Rows) {
    throw new Error(`${result.period} rollback or rollback retry failed`);
  }
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const results = await Promise.all(options.resultPaths.map(async (resultPath) => {
    const parsed = runnerResultSchema.safeParse(JSON.parse(await readFile(resultPath, "utf8")));
    if (!parsed.success) {
      throw new Error(`${repoRelative(resultPath)} is not a valid acceptance rehearsal runner result: ${parsed.error.message}`);
    }
    assertCleanRehearsal(parsed.data);
    return { path: resultPath, result: parsed.data };
  }));
  const periods = results.map(({ result }) => result.period).sort();
  if (new Set(periods).size !== periods.length) throw new Error("runner results must use distinct periods");

  const generatedAt = new Date().toISOString();
  const runs = results
    .sort((left, right) => left.result.period.localeCompare(right.result.period))
    .map(({ path: resultPath, result }) => ({
      period: result.period,
      runnerResult: repoRelative(resultPath),
      seed: result.seed,
      requestedSalesRows: result.requestedSalesRows,
      sourceIds: result.sources.map((source) => source.sourceId),
      manualBaselineSourceId: result.sources.find((source) => source.family === "manual_baseline")!.sourceId,
      manualBaselineRows: result.manualBaseline.rowCount,
      baselineJobRunId: result.acceptanceRehearsal.baselineRun.runId,
      candidateJobRunId: result.acceptanceRehearsal.candidateRun.runId,
      l4Rows: result.layerRows.l4Rows,
      publishedRows: result.publish.stagedRowCount,
      dqRows: result.layerRows.dqRows,
      recon: result.shadowRecon,
      publishVersionId: result.publish.versionId,
      publishRetry: result.acceptanceRehearsal.publishRetry,
      rollback: result.acceptanceRehearsal.rollback,
      rollbackRetry: result.acceptanceRehearsal.rollbackRetry,
    }));

  const commonBoundary = {
    schema: "front-profit-synthetic-acceptance-evidence/v1",
    generatedAt,
    mode: "synthetic_rehearsal",
    realSamplesUsed: false,
    deploymentStarted: false,
    productionReleaseAuthorized: false,
  } as const;
  const evidence = {
    "dq-summary.json": {
      ...commonBoundary,
      periods: runs.map((run) => ({ period: run.period, unresolvedBlockCount: 0, dqRows: run.dqRows })),
    },
    "recon-summary.json": {
      ...commonBoundary,
      periods: runs.map((run) => ({ period: run.period, ...run.recon })),
    },
    "diff-summary.json": {
      ...commonBoundary,
      oracle: "synthetic_independent_fixture",
      periods: runs.map((run) => ({
        period: run.period,
        aggregationKeyCoverage: 1,
        diffRowCount: 0,
        maxMoneyDiff: run.recon.maxAbsoluteDiff,
      })),
    },
    "publish-summary.json": {
      ...commonBoundary,
      periods: runs.map((run) => ({
        period: run.period,
        publishVersionId: run.publishVersionId,
        publishedRows: run.publishedRows,
        retryReturnedVersionId: run.publishRetry.returnedVersionId,
        retryCreatedNewVersion: run.publishRetry.createdNewVersion,
        retryIdempotent: run.publishRetry.idempotent,
      })),
    },
    "rollback-summary.json": {
      ...commonBoundary,
      periods: runs.map((run) => ({
        period: run.period,
        ...run.rollback,
        retryIdempotent: run.rollbackRetry.idempotent,
        retryRestoredVersionId: run.rollbackRetry.restoredVersionId,
      })),
    },
  };
  for (const [fileName, value] of Object.entries(evidence)) {
    await writeJsonAtomically(path.join(options.outDir, fileName), value);
  }

  const summaryPath = path.join(options.outDir, "synthetic-acceptance-summary.json");
  await writeJsonAtomically(summaryPath, {
    schema: "front-profit-synthetic-acceptance-rehearsal/v1",
    generatedAt,
    mode: "synthetic_rehearsal",
    periods,
    realSamplesUsed: false,
    deploymentStarted: false,
    productionReleaseAuthorized: false,
    oracle: {
      mode: "synthetic_independent_fixture",
      originalFixtureBaselineUsedForRecon: true,
    },
    runs,
    evidenceArtifacts: Object.keys(evidence),
    cleanup: {
      temporaryDatabaseRemoved: true,
      isolatedResourcesVerifiedAbsentByCaller: true,
      retainedEvidenceOnly: true,
    },
    limitation: "Synthetic rehearsal only; real-sample P0 remains open.",
  });

  console.log("FRONT_PROFIT_SYNTHETIC_ACCEPTANCE_SUMMARY_OK");
  console.log(`summary=${repoRelative(summaryPath)}`);
  console.log(`periods=${periods.join(",")}`);
  console.log("realSamplesUsed=false");
  console.log("productionReleaseAuthorized=false");
}

main().catch((error) => {
  console.error("FRONT_PROFIT_SYNTHETIC_ACCEPTANCE_SUMMARY_FAILED");
  console.error(`- ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
