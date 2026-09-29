import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

import postgres from "postgres";

import { assertPublishGateForRun, recordComplexJobStep } from "../src/services/complex-job.js";
import { canonicalRowsContract } from "../src/services/front-profit-canonical-rows-contract.js";
import { runFrontProfitDraftShadow } from "../src/services/front-profit-draft-runner.js";
import { setFrontProfitPeriodAuthority } from "../src/services/front-profit-authority.js";
import {
  frontProfitL4AggRowToCanonicalRow,
  selectFrontProfitL4RowsForRun,
  writeFrontProfitShadowReconciliation,
} from "../src/services/front-profit-layers.js";
import { FRONT_PROFIT_MODULE_CODE, frontProfitScopeKey } from "../src/services/front-profit-period.js";
import {
  publishFrontProfitL4Run,
  rollbackFrontProfitPublishVersion,
} from "../src/services/front-profit-publish.js";
import { FRONT_PROFIT_STANDARD_HEADERS } from "../src/services/front-profit-standard.js";

const API_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = path.resolve(API_ROOT, "../..");
const DEFAULT_ARTIFACT_ROOT = path.join(API_ROOT, "artifacts/front-profit-synthetic-db-runner");
const DEFAULT_ROWS = 50_000;
const DEFAULT_PERIOD = "2026-08";
const DEFAULT_SEED = 20260810;
const INSERT_BATCH_SIZE = 1_000;
const TSX_CLI = path.join(API_ROOT, "node_modules/tsx/dist/cli.mjs");
const FIXTURE_GENERATOR_SCRIPT = path.join(API_ROOT, "scripts/front-profit-generate-synthetic-fixtures.ts");

type SqlClient = ReturnType<typeof postgres>;

type Options = {
  period: string;
  rows: number;
  seed: number;
  outDir: string;
  keepFixtures: boolean;
  acceptanceRehearsal: boolean;
};

type FixtureManifest = {
  period: string;
  seed: number;
  requestedSalesRows: number;
  files: Array<{
    role: string;
    name: string;
    rows: number;
  }>;
};

type SourceRole =
  | "operator"
  | "sales"
  | "costPeriod"
  | "costUsage"
  | "rebate"
  | "fee"
  | "promotion"
  | "baseline";

type SourceRegistration = {
  role: SourceRole;
  family?: string;
  sourceId: number;
  tableName: string;
  fileName: string;
  csvPath: string;
  rowCount: number;
  loadSeconds: number;
  bytes: number;
  sha256: string;
};

type PhaseTiming = {
  phase: string;
  seconds: number;
};

export type SyntheticDbRunnerFailureResult = {
  schema: "front-profit-synthetic-db-runner-failure/v1";
  generatedAt: string;
  status: "failed";
  period: string;
  seed: number;
  requestedSalesRows: number;
  database: {
    urlSource: "TEST_DATABASE_URL";
    realSamplesUsed: false;
    deploymentStarted: false;
  };
  failure: {
    code: "FRONT_PROFIT_SYNTHETIC_DB_RUNNER_FAILED";
    message: "前台利润合成数据库运行失败";
    phase: string;
  };
  timings: PhaseTiming[];
  keptFixtures: boolean;
};

const SOURCE_ROLES = [
  { role: "operator", family: "operator_assignment" },
  { role: "sales", family: "sales_fact" },
  { role: "costPeriod", family: "cost_period" },
  { role: "costUsage", family: "cost_usage" },
  { role: "rebate", family: "rebate" },
  { role: "fee", family: "fee_fact" },
  { role: "promotion", family: "promotion_spend" },
] as const satisfies readonly { role: SourceRole; family: string }[];

function parseArgs(argv: string[]): Options {
  const resolveOutDir = (value: string): string =>
    path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
  const options: Options = {
    period: DEFAULT_PERIOD,
    rows: DEFAULT_ROWS,
    seed: DEFAULT_SEED,
    outDir: DEFAULT_ARTIFACT_ROOT,
    keepFixtures: true,
    acceptanceRehearsal: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (!arg.startsWith("--")) continue;
    const [key, inlineValue] = arg.slice(2).split("=", 2);
    if (key === "discard-fixtures") {
      options.keepFixtures = false;
      continue;
    }
    if (key === "acceptance-rehearsal") {
      options.acceptanceRehearsal = true;
      continue;
    }
    if (key === "help" || key === "h") {
      console.log([
        "Usage: pnpm --filter @ec/api run front-profit:synthetic-db-runner -- [options]",
        "  --period YYYY-MM    synthetic period, default 2026-08",
        "  --rows N            synthetic sales rows, default 50000",
        "  --seed N            deterministic fixture seed, default 20260810",
        "  --out <dir>         ignored artifact output directory",
        "  --acceptance-rehearsal  use the independent fixture baseline and exercise publish retry/rollback",
      ].join("\n"));
      process.exit(0);
    }
    const value = inlineValue ?? argv[index + 1] ?? "";
    if (inlineValue == null) index += 1;
    if (key === "period") options.period = value;
    else if (key === "rows") options.rows = Number(value);
    else if (key === "seed") options.seed = Number(value);
    else if (key === "out") options.outDir = resolveOutDir(value);
    else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(options.period)) {
    throw new Error("--period must use YYYY-MM");
  }
  if (!Number.isSafeInteger(options.rows) || options.rows <= 0) {
    throw new Error("--rows must be a positive integer");
  }
  if (!Number.isSafeInteger(options.seed) || options.seed <= 0) {
    throw new Error("--seed must be a positive integer");
  }
  return options;
}

function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is required. Refusing to run write-heavy synthetic DB runner against DATABASE_URL.",
    );
  }
  return url;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`unsafe SQL identifier: ${value}`);
  }
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function userDataTableReference(tableName: string): string {
  return `${quoteIdentifier("user_data")}.${quoteIdentifier(tableName)}`;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll("\"", "\"\"")}"` : value;
}

function csvLine(row: readonly unknown[]): string {
  return row.map((cell) => csvCell(String(cell ?? ""))).join(",") + "\n";
}

async function writeCsvRow(stream: WriteStream, row: readonly unknown[]): Promise<void> {
  if (!stream.write(csvLine(row))) {
    await once(stream, "drain");
  }
}

async function closeCsvStream(stream: WriteStream): Promise<void> {
  stream.end();
  await once(stream, "finish");
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char === "\"" && line[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === "\"") inQuotes = true;
    else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  if (inQuotes) throw new Error("CSV line ended inside a quoted cell");
  cells.push(cell);
  return cells;
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

async function timePhase<T>(phase: string, timings: PhaseTiming[], fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    timings.push({
      phase,
      seconds: Number(((performance.now() - started) / 1000).toFixed(3)),
    });
  }
}

function runFixtureGenerator(input: {
  period: string;
  rows: number;
  seed: number;
  outDir: string;
  prefix: string;
}): void {
  const args = [
    TSX_CLI,
    FIXTURE_GENERATOR_SCRIPT,
    "--period",
    input.period,
    "--rows",
    String(input.rows),
    "--seed",
    String(input.seed),
    "--out",
    input.outDir,
    "--prefix",
    input.prefix,
  ];
  const result = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error([
      "front-profit fixture generation failed",
      result.stdout,
      result.stderr,
      result.error?.message,
    ].filter(Boolean).join("\n"));
  }
}

export function buildSyntheticDbRunnerFailureResult(input: {
  generatedAt?: string;
  period: string;
  rows: number;
  seed: number;
  phase: string;
  timings: PhaseTiming[];
  keptFixtures: boolean;
  error: unknown;
}): SyntheticDbRunnerFailureResult {
  const safePhase = /^[a-z][a-z0-9_]*$/.test(input.phase) ? input.phase : "unknown";
  void input.error;
  return {
    schema: "front-profit-synthetic-db-runner-failure/v1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    status: "failed",
    period: input.period,
    seed: input.seed,
    requestedSalesRows: input.rows,
    database: {
      urlSource: "TEST_DATABASE_URL",
      realSamplesUsed: false,
      deploymentStarted: false,
    },
    failure: {
      code: "FRONT_PROFIT_SYNTHETIC_DB_RUNNER_FAILED",
      message: "前台利润合成数据库运行失败",
      phase: safePhase,
    },
    timings: input.timings.map((timing) => ({ ...timing })),
    keptFixtures: input.keptFixtures,
  };
}

export async function writeSyntheticDbRunnerResultAtomically(
  resultPath: string,
  result: unknown,
): Promise<void> {
  await mkdir(path.dirname(resultPath), { recursive: true });
  const tempPath = `${resultPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, resultPath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function columnMappings(headers: readonly string[]) {
  return headers.map((raw, index) => ({
    raw,
    name: `c_${index + 1}`,
  }));
}

async function readCsvHeader(csvPath: string): Promise<string[]> {
  const stream = createReadStream(csvPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      return parseCsvLine(line);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  throw new Error(`CSV file is empty: ${csvPath}`);
}

async function insertDataSource(
  sql: SqlClient,
  input: {
    fileName: string;
    rowCount: number;
    headers: string[];
    family?: string;
    standardSummary?: Record<string, unknown>;
    period?: string;
  },
): Promise<number> {
  const config: Record<string, unknown> = {
    originalFileName: input.fileName,
    rowCount: input.rowCount,
    role: "file",
    columns: columnMappings(input.headers),
    syntheticDbRunner: true,
  };
  if (input.family) config.frontProfitSourceFamily = input.family;
  if (input.standardSummary && input.period) {
    config.frontProfitValidation = input.standardSummary;
    config.frontProfitPeriods = [input.period];
    config.frontProfitScopeKeys = [frontProfitScopeKey(input.period)];
    config.frontProfitAuthority = "manual";
  }
  const [row] = await sql.unsafe(
    `INSERT INTO public.data_sources (name, type, platform, config, status)
     VALUES ($1, 'file', 'synthetic', $2::jsonb, 'active')
     RETURNING id`,
    [input.fileName, config],
  );
  const id = Number(row?.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("failed to create data source");
  return id;
}

async function createUfTable(sql: SqlClient, tableName: string, columnCount: number): Promise<void> {
  const columns = Array.from({ length: columnCount }, (_, index) =>
    `${quoteIdentifier(`c_${index + 1}`)} text`).join(", ");
  await sql.unsafe(
    `CREATE TABLE ${userDataTableReference(tableName)} (
       id bigserial PRIMARY KEY,
       ${columns}
     )`,
  );
}

async function insertRows(
  sql: SqlClient,
  input: {
    tableName: string;
    csvPath: string;
    columnCount: number;
  },
): Promise<number> {
  const stream = createReadStream(input.csvPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const columns = Array.from({ length: input.columnCount }, (_, index) => quoteIdentifier(`c_${index + 1}`));
  const tableRef = userDataTableReference(input.tableName);
  let isHeader = true;
  let rowCount = 0;
  let batch: string[][] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const placeholders: string[] = [];
    const parameters: string[] = [];
    let paramIndex = 1;
    for (const row of batch) {
      placeholders.push(`(${columns.map(() => `$${paramIndex++}`).join(", ")})`);
      parameters.push(...row.map((cell) => cell === "" ? "" : cell));
    }
    await sql.unsafe(
      `INSERT INTO ${tableRef} (${columns.join(", ")}) VALUES ${placeholders.join(", ")}`,
      parameters,
    );
    rowCount += batch.length;
    batch = [];
  };

  try {
    for await (const line of rl) {
      if (isHeader) {
        isHeader = false;
        continue;
      }
      const row = parseCsvLine(line);
      if (row.length !== input.columnCount) {
        throw new Error(`${path.basename(input.csvPath)} row has ${row.length} cells; expected ${input.columnCount}`);
      }
      batch.push(row);
      if (batch.length >= INSERT_BATCH_SIZE) await flush();
    }
    await flush();
  } finally {
    rl.close();
    stream.destroy();
  }
  return rowCount;
}

async function readStandardSummary(csvPath: string): Promise<Record<string, unknown>> {
  const text = await readFile(csvPath, "utf8");
  const rows = text.trimEnd().split(/\r?\n/).map(parseCsvLine);
  const [headers, ...dataRows] = rows;
  const contract = canonicalRowsContract({
    headers,
    dataRows,
    firstDataRowNumber: 2,
  });
  return contract.summary;
}

async function writeAlignedManualBaselineCsv(
  csvPath: string,
  input: {
    runId: number;
    rows: Awaited<ReturnType<typeof selectFrontProfitL4RowsForRun>>;
  },
): Promise<void> {
  const stream = createWriteStream(csvPath, { encoding: "utf8" });
  await writeCsvRow(stream, FRONT_PROFIT_STANDARD_HEADERS);
  for (const row of input.rows) {
    await writeCsvRow(stream, frontProfitL4AggRowToCanonicalRow({
      ...row,
      sourceFile: path.basename(csvPath),
      sourceBatch: `aligned-auto-l4-run:${input.runId}`,
      note: "synthetic aligned manual baseline from auto L4",
      dataStatus: "synthetic_aligned",
    }));
  }
  await closeCsvStream(stream);
}

async function registerCsvSource(
  sql: SqlClient,
  input: {
    role: SourceRole;
    family?: string;
    csvPath: string;
    fileName: string;
    sourceName?: string;
    expectedRows: number;
    period: string;
  },
): Promise<SourceRegistration> {
  const started = performance.now();
  const headers = await readCsvHeader(input.csvPath);
  if (input.role === "baseline" && JSON.stringify(headers) !== JSON.stringify(FRONT_PROFIT_STANDARD_HEADERS)) {
    throw new Error("manual baseline fixture does not match front-profit standard headers");
  }
  const standardSummary = input.role === "baseline"
    ? await readStandardSummary(input.csvPath)
    : undefined;
  const sourceId = await insertDataSource(sql, {
    fileName: input.sourceName ?? input.fileName,
    rowCount: input.expectedRows,
    headers,
    family: input.family,
    standardSummary,
    period: input.period,
  });
  const tableName = `uf_${sourceId}`;
  await createUfTable(sql, tableName, headers.length);
  const rowCount = await insertRows(sql, {
    tableName,
    csvPath: input.csvPath,
    columnCount: headers.length,
  });
  if (rowCount !== input.expectedRows) {
    throw new Error(`${input.fileName} loaded ${rowCount} rows; expected ${input.expectedRows}`);
  }
  return {
    role: input.role,
    family: input.family,
    sourceId,
    tableName,
    fileName: input.fileName,
    csvPath: path.relative(REPO_ROOT, input.csvPath).replaceAll(path.sep, "/"),
    rowCount,
    loadSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
    bytes: (await stat(input.csvPath)).size,
    sha256: await sha256File(input.csvPath),
  };
}

async function ensureMigrated(sql: SqlClient): Promise<void> {
  const [row] = await sql.unsafe(
    `SELECT to_regclass('public.data_sources') IS NOT NULL AS data_sources,
            to_regclass('public.front_profit_l4_agg_row') IS NOT NULL AS front_profit_l4,
            to_regnamespace('user_data') IS NOT NULL AS user_data_schema`,
  );
  if (row?.data_sources !== true || row?.front_profit_l4 !== true || row?.user_data_schema !== true) {
    throw new Error("TEST_DATABASE_URL must point at a migrated isolated database with user_data schema");
  }
}

async function ensureSyntheticActor(sql: SqlClient): Promise<number> {
  const [row] = await sql.unsafe(
    `INSERT INTO public.users (username, password_hash, display_name, is_admin)
     VALUES ('front_profit_synthetic_db_runner', 'synthetic-not-a-login', 'Synthetic DB Runner', true)
     ON CONFLICT (username) DO UPDATE SET is_admin = true
     RETURNING id`,
  );
  const id = Number(row?.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("failed to create synthetic actor");
  return id;
}

async function queryRunDetail(sql: SqlClient, runId: number) {
  const [run, steps, dqEvents, reconResults, l4Rows, publishVersions] = await Promise.all([
    sql.unsafe(
      `SELECT id, module_code, scope_key, status, input_batch_ids, last_checkpoint_step,
              started_at, heartbeat_at, finished_at, created_at, updated_at
       FROM public.job_run
       WHERE id = $1 AND module_code = $2
       LIMIT 1`,
      [runId, FRONT_PROFIT_MODULE_CODE],
    ),
    sql.unsafe(
      `SELECT step_key, attempt, status, rows_in, rows_out, error_code, started_at, finished_at
       FROM public.job_step
       WHERE run_id = $1
       ORDER BY id`,
      [runId],
    ),
    sql.unsafe(
      `SELECT severity, code, source_id, row_no, payload, resolved_at, created_at
       FROM public.dq_event
       WHERE run_id = $1
       ORDER BY id
       LIMIT 100`,
      [runId],
    ),
    sql.unsafe(
      `SELECT layer, metric, expected, actual, tolerance, passed, evidence_ref, created_at
       FROM public.recon_result
       WHERE run_id = $1
       ORDER BY id
       LIMIT 200`,
      [runId],
    ),
    sql.unsafe(
      `SELECT id, publish_version_id, period, record_id, aggregation_key, gmv, front_profit, data_status, created_at
       FROM public.front_profit_l4_agg_row
       WHERE run_id = $1
       ORDER BY id
       LIMIT 50`,
      [runId],
    ),
    sql.unsafe(
      `SELECT id, scope_key, version_no, status, source_run_id, published_by, published_at, created_at
       FROM public.publish_version
       WHERE module_code = $1 AND source_run_id = $2
       ORDER BY id`,
      [FRONT_PROFIT_MODULE_CODE, runId],
    ),
  ]);
  return {
    run: run[0] ?? null,
    steps,
    dqEvents,
    reconResults,
    l4Rows,
    publishVersions,
  };
}

async function countLayerRows(sql: SqlClient, runId: number) {
  const [row] = await sql.unsafe(
    `SELECT
       (SELECT COUNT(*)::int FROM public.front_profit_l1_source_row WHERE run_id = $1) AS l1_rows,
       (SELECT COUNT(*)::int FROM public.front_profit_l3_calc_detail WHERE run_id = $1) AS l3_rows,
       (SELECT COUNT(*)::int FROM public.front_profit_l4_agg_row WHERE run_id = $1) AS l4_rows,
       (SELECT COUNT(*)::int FROM public.recon_result WHERE run_id = $1) AS recon_rows,
       (SELECT COUNT(*)::int FROM public.dq_event WHERE run_id = $1) AS dq_rows`,
    [runId],
  );
  return {
    l1Rows: Number(row?.l1_rows ?? 0),
    l3Rows: Number(row?.l3_rows ?? 0),
    l4Rows: Number(row?.l4_rows ?? 0),
    reconRows: Number(row?.recon_rows ?? 0),
    dqRows: Number(row?.dq_rows ?? 0),
  };
}

async function selectShadowReconSummary(sql: SqlClient, runId: number) {
  const [metrics, dqRows] = await Promise.all([
    sql.unsafe(
      `SELECT metric, expected, actual, tolerance, passed
         FROM public.recon_result
        WHERE run_id = $1 AND layer = 'SHADOW_MANUAL_AUTO'
        ORDER BY metric`,
      [runId],
    ),
    sql.unsafe(
      `SELECT COUNT(*)::int AS count
         FROM public.dq_event
        WHERE run_id = $1 AND code LIKE 'FRONT_PROFIT_SHADOW_%'`,
      [runId],
    ),
  ]);
  const normalizedMetrics = metrics.map((row) => {
    const expected = Number(row.expected ?? 0);
    const actual = Number(row.actual ?? 0);
    return {
      metric: String(row.metric ?? ""),
      expected,
      actual,
      tolerance: Number(row.tolerance ?? 0),
      passed: row.passed === true,
      absoluteDiff: Math.abs(expected - actual),
    };
  });
  return {
    reconCount: normalizedMetrics.length,
    dqCount: Number(dqRows[0]?.count ?? 0),
    passed: normalizedMetrics.length > 0 && normalizedMetrics.every((metric) => metric.passed),
    maxAbsoluteDiff: Math.max(0, ...normalizedMetrics.map((metric) => metric.absoluteDiff)),
    metrics: normalizedMetrics,
  };
}

async function selectJobStepTimings(sql: SqlClient, runId: number) {
  const rows = await sql.unsafe(
    `SELECT step_key,
            status,
            rows_in,
            rows_out,
            CASE
              WHEN started_at IS NULL OR finished_at IS NULL THEN NULL
              ELSE ROUND(EXTRACT(EPOCH FROM (finished_at - started_at))::numeric, 3)
            END AS seconds
       FROM public.job_step
      WHERE run_id = $1
      ORDER BY id`,
    [runId],
  );
  return rows.map((row) => ({
    step: String(row.step_key ?? ""),
    status: String(row.status ?? ""),
    rowsIn: row.rows_in == null ? null : Number(row.rows_in),
    rowsOut: row.rows_out == null ? null : Number(row.rows_out),
    seconds: row.seconds == null ? null : Number(row.seconds),
  }));
}

function fixtureFile(manifest: FixtureManifest, role: SourceRole): FixtureManifest["files"][number] {
  const file = manifest.files.find((item) => item.role === role);
  if (!file) throw new Error(`fixture manifest missing role ${role}`);
  return file;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runLabel = [
    "synthetic-db",
    options.period,
    String(options.rows),
    String(options.seed),
    new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14),
  ].join("-");
  const fixtureDir = path.join(options.outDir, runLabel, "fixtures");
  const prefix = "synthetic-db";
  const timings: PhaseTiming[] = [];
  const resultPath = path.join(options.outDir, runLabel, "synthetic-db-runner-result.json");
  let phase = "bootstrap";
  const runPhase = <T>(phaseName: string, fn: () => Promise<T>): Promise<T> => {
    phase = phaseName;
    return timePhase(phaseName, timings, fn);
  };
  let failureReportPromise: Promise<void> | null = null;
  const reportFailure = (error: unknown): Promise<void> => {
    failureReportPromise ??= (async () => {
      const failureResult = buildSyntheticDbRunnerFailureResult({
        period: options.period,
        rows: options.rows,
        seed: options.seed,
        phase,
        timings,
        keptFixtures: options.keepFixtures,
        error,
      });
      await writeSyntheticDbRunnerResultAtomically(resultPath, failureResult);
      console.log(`result=${path.relative(REPO_ROOT, resultPath).replaceAll(path.sep, "/")}`);
      console.error("FRONT_PROFIT_SYNTHETIC_DB_RUNNER_FAILED");
      console.error("- 前台利润合成数据库运行失败；请使用上方 result 路径读取机器结果");
    })();
    return failureReportPromise;
  };
  const terminateAfterUncaughtFailure = (error: unknown): void => {
    void reportFailure(error)
      .catch(() => undefined)
      .finally(() => process.exit(1));
  };
  process.once("uncaughtException", terminateAfterUncaughtFailure);
  process.once("unhandledRejection", terminateAfterUncaughtFailure);

  try {
    const databaseUrl = requireTestDatabaseUrl();
    await mkdir(options.outDir, { recursive: true });

  await runPhase("fixture_generate", async () => {
    await mkdir(fixtureDir, { recursive: true });
    runFixtureGenerator({
      period: options.period,
      rows: options.rows,
      seed: options.seed,
      outDir: fixtureDir,
      prefix,
    });
  });

  phase = "fixture_manifest";
  const manifestPath = path.join(fixtureDir, `${prefix}-manifest.json`);
  if (!existsSync(manifestPath)) throw new Error(`fixture manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as FixtureManifest;
  if (manifest.period !== options.period || manifest.seed !== options.seed || manifest.requestedSalesRows !== options.rows) {
    throw new Error("fixture manifest metadata does not match requested runner options");
  }

  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    phase = "migration";
    await ensureMigrated(sql);
    phase = "synthetic_actor";
    const actorId = await ensureSyntheticActor(sql);

    const registrations: SourceRegistration[] = [];
    await runPhase("uf_load", async () => {
      for (const role of SOURCE_ROLES) {
        const file = fixtureFile(manifest, role.role);
        registrations.push(await registerCsvSource(sql, {
          role: role.role,
          family: role.family,
          csvPath: path.join(fixtureDir, file.name),
          fileName: file.name,
          sourceName: `${runLabel}-${file.name}`,
          expectedRows: file.rows,
          period: options.period,
        }));
      }
      if (options.acceptanceRehearsal) {
        const baselineFile = fixtureFile(manifest, "baseline");
        registrations.push(await registerCsvSource(sql, {
          role: "baseline",
          csvPath: path.join(fixtureDir, baselineFile.name),
          fileName: baselineFile.name,
          sourceName: `${runLabel}-${baselineFile.name}`,
          expectedRows: baselineFile.rows,
          period: options.period,
        }));
      }
    });

    const sourceId = (role: SourceRole): number => {
      const found = registrations.find((item) => item.role === role);
      if (!found) throw new Error(`source registration missing role ${role}`);
      return found.sourceId;
    };

    const runDraft = (phaseName: string) => runPhase(phaseName, () =>
      sql.begin((tx) =>
        runFrontProfitDraftShadow(tx, {
          period: options.period,
          sources: {
            operatorAssignmentSourceIds: [sourceId("operator")],
            salesSourceIds: [sourceId("sales")],
            costPeriodSourceIds: [sourceId("costPeriod")],
            costUsageSourceIds: [sourceId("costUsage")],
            rebateSourceIds: [sourceId("rebate")],
            feeSourceIds: [sourceId("fee")],
            promotionSourceIds: [sourceId("promotion")],
          },
          manualBaselineSourceId: options.acceptanceRehearsal ? sourceId("baseline") : null,
          actorId,
          today: `${options.period}-01`,
          jobVersion: options.acceptanceRehearsal
            ? "front-profit-synthetic-acceptance-rehearsal/v1"
            : "front-profit-synthetic-db-runner/v1",
        })));
    const assertDraftSucceeded = (draftResult: Awaited<ReturnType<typeof runDraft>>) => {
      if (draftResult.status === "failed") {
        throw new Error(
          `draft shadow failed: ${draftResult.errorCode ?? "unknown"} ${draftResult.message ?? ""}`.trim(),
        );
      }
    };
    const publishRun = (phaseName: string, runId: number, idempotencyKey: string) =>
      runPhase(phaseName, () =>
        sql.begin((tx) =>
          publishFrontProfitL4Run(tx, {
            period: options.period,
            runId,
            publishSourceId: sourceId("sales"),
            sourceIds: registrations.map((item) => item.sourceId),
            manualBaselineSourceId: sourceId("baseline"),
            actorId,
            today: `${options.period}-01`,
            idempotencyKey,
          })));

    let draft = await runDraft(options.acceptanceRehearsal
      ? "baseline_draft_l1_l3_l4"
      : "draft_l1_l3_l4");
    assertDraftSucceeded(draft);

    phase = "l4_select";
    let l4Rows = await selectFrontProfitL4RowsForRun(sql, { runId: draft.runId, period: options.period });
    if (l4Rows.length === 0) throw new Error("synthetic draft produced no L4 rows");

    let baselineFileName = fixtureFile(manifest, "baseline").name;
    let manualBaselineMode = "synthetic_independent_fixture";
    let originalFixtureBaselineUsedForRecon = true;
    let shadowRecon = options.acceptanceRehearsal
      ? await selectShadowReconSummary(sql, draft.runId)
      : null;

    if (!options.acceptanceRehearsal) {
      baselineFileName = `${prefix}-aligned-manual-baseline.csv`;
      manualBaselineMode = "synthetic_aligned_from_auto_l4";
      originalFixtureBaselineUsedForRecon = false;
      const alignedBaselineCsvPath = path.join(fixtureDir, baselineFileName);
      await runPhase("aligned_baseline_load", async () => {
        await writeAlignedManualBaselineCsv(alignedBaselineCsvPath, {
          runId: draft.runId,
          rows: l4Rows,
        });
        registrations.push(await registerCsvSource(sql, {
          role: "baseline",
          csvPath: alignedBaselineCsvPath,
          fileName: baselineFileName,
          sourceName: `${runLabel}-${baselineFileName}`,
          expectedRows: l4Rows.length,
          period: options.period,
        }));
      });

      await runPhase("shadow_recon", async () => {
        await sql.begin(async (tx) => {
          const alignedShadow = await writeFrontProfitShadowReconciliation(tx, {
            runId: draft.runId,
            period: options.period,
            manualRows: l4Rows.map((row) => ({
              ...row,
              sourceFile: baselineFileName,
              sourceBatch: `aligned-auto-l4-run:${draft.runId}`,
              note: "synthetic aligned manual baseline from auto L4",
              dataStatus: "synthetic_aligned",
            })),
            baselineLabel: `aligned-manual-source:${sourceId("baseline")}`,
          });
          await recordComplexJobStep(tx, {
            runId: draft.runId,
            stepKey: "shadow_recon",
            status: "succeeded",
            rowsIn: l4Rows.length,
            rowsOut: alignedShadow.reconResults.length,
          });
        });
      });
      shadowRecon = await selectShadowReconSummary(sql, draft.runId);
    }

    if (!shadowRecon?.passed || shadowRecon.dqCount !== 0) {
      throw new Error("synthetic manual baseline reconciliation did not pass cleanly");
    }

    phase = "publish_gate";
    await assertPublishGateForRun(sql, draft.runId);

    phase = "authority";
    await sql.begin((tx) =>
      setFrontProfitPeriodAuthority(tx, {
        period: options.period,
        authority: "auto",
        actorId,
        reason: options.acceptanceRehearsal
          ? "synthetic acceptance rehearsal publish smoke"
          : "synthetic DB runner publish smoke",
      }));

    const firstPublishKey = `front-profit-synthetic-db:${options.period}:${draft.runId}`;
    let publish = await publishRun(options.acceptanceRehearsal ? "baseline_publish" : "publish", draft.runId, firstPublishKey);
    let acceptanceRehearsal: Record<string, unknown> | null = null;

    if (options.acceptanceRehearsal) {
      const baselineDraft = draft;
      const baselineL4Rows = l4Rows;
      const baselineShadowRecon = shadowRecon;
      const baselinePublish = publish;
      const baselinePublishRetry = await publishRun(
        "baseline_publish_retry",
        baselineDraft.runId,
        firstPublishKey,
      );
      if (!baselinePublishRetry.idempotent || baselinePublishRetry.version.id !== baselinePublish.version.id) {
        throw new Error("baseline publish retry was not idempotent");
      }

      const candidateDraft = await runDraft("candidate_draft_l1_l3_l4");
      assertDraftSucceeded(candidateDraft);
      const candidateL4Rows = await selectFrontProfitL4RowsForRun(sql, {
        runId: candidateDraft.runId,
        period: options.period,
      });
      if (candidateL4Rows.length === 0) throw new Error("synthetic candidate draft produced no L4 rows");
      const candidateShadowRecon = await selectShadowReconSummary(sql, candidateDraft.runId);
      if (!candidateShadowRecon.passed || candidateShadowRecon.dqCount !== 0) {
        throw new Error("candidate independent baseline reconciliation did not pass cleanly");
      }
      await assertPublishGateForRun(sql, candidateDraft.runId);

      const candidatePublishKey = `front-profit-synthetic-db:${options.period}:${candidateDraft.runId}`;
      const candidatePublish = await publishRun(
        "candidate_publish",
        candidateDraft.runId,
        candidatePublishKey,
      );
      if (candidatePublish.version.id === baselinePublish.version.id) {
        throw new Error("candidate publish did not create a distinct version for rollback rehearsal");
      }
      const publishRetry = await publishRun(
        "candidate_publish_retry",
        candidateDraft.runId,
        candidatePublishKey,
      );
      if (!publishRetry.idempotent || publishRetry.version.id !== candidatePublish.version.id) {
        throw new Error("candidate publish retry was not idempotent");
      }

      const rollback = await runPhase("rollback", () =>
        sql.begin((tx) => rollbackFrontProfitPublishVersion(tx, {
          period: options.period,
          versionId: candidatePublish.version.id,
          actorId,
          today: `${options.period}-01`,
          reason: "synthetic acceptance rehearsal rollback",
        })));
      if (rollback.restoredVersion.id !== baselinePublish.version.id || rollback.idempotent) {
        throw new Error("rollback did not restore the previous synthetic publish version");
      }
      const rollbackRetry = await runPhase("rollback_retry", () =>
        sql.begin((tx) => rollbackFrontProfitPublishVersion(tx, {
          period: options.period,
          versionId: candidatePublish.version.id,
          actorId,
          today: `${options.period}-01`,
          reason: "synthetic acceptance rehearsal rollback retry",
        })));
      if (!rollbackRetry.idempotent || rollbackRetry.restoredVersion.id !== baselinePublish.version.id) {
        throw new Error("rollback retry was not idempotent");
      }

      draft = candidateDraft;
      l4Rows = candidateL4Rows;
      shadowRecon = candidateShadowRecon;
      publish = candidatePublish;
      acceptanceRehearsal = {
        mode: "synthetic_rehearsal",
        realSamplesUsed: false,
        productionReleaseAuthorized: false,
        baselineRun: {
          runId: baselineDraft.runId,
          l4Rows: baselineL4Rows.length,
          shadowRecon: baselineShadowRecon,
          publishVersionId: baselinePublish.version.id,
          publishRetryReturnedVersionId: baselinePublishRetry.version.id,
          publishRetryCreatedNewVersion: !baselinePublishRetry.idempotent,
        },
        candidateRun: {
          runId: candidateDraft.runId,
          l4Rows: candidateL4Rows.length,
          shadowRecon: candidateShadowRecon,
          publishVersionId: candidatePublish.version.id,
        },
        publishRetry: {
          returnedVersionId: publishRetry.version.id,
          createdNewVersion: !publishRetry.idempotent,
          idempotent: publishRetry.idempotent,
        },
        rollback: {
          rolledBackVersionId: rollback.rolledBackVersion.id,
          restoredVersionId: rollback.restoredVersion.id,
          rolledBackRowCount: rollback.rolledBackRowCount,
          restoredRowCount: rollback.restoredRowCount,
          idempotent: rollback.idempotent,
        },
        rollbackRetry: {
          rolledBackVersionId: rollbackRetry.rolledBackVersion.id,
          restoredVersionId: rollbackRetry.restoredVersion.id,
          restoredRowCount: rollbackRetry.restoredRowCount,
          idempotent: rollbackRetry.idempotent,
        },
      };
    }

    const detail = await runPhase("run_detail_query", () => queryRunDetail(sql, draft.runId));
    phase = "result_summary";
    const layerRows = await countLayerRows(sql, draft.runId);
    const jobStepTimings = await selectJobStepTimings(sql, draft.runId);

    const result = {
      schema: "front-profit-synthetic-db-runner-result/v1",
      generatedAt: new Date().toISOString(),
      period: options.period,
      seed: options.seed,
      requestedSalesRows: options.rows,
      fixtureManifest: path.relative(REPO_ROOT, manifestPath).replaceAll(path.sep, "/"),
      database: {
        urlSource: "TEST_DATABASE_URL",
        realSamplesUsed: false,
        deploymentStarted: false,
      },
      manualBaseline: {
        mode: manualBaselineMode,
        fileName: baselineFileName,
        rowCount: registrations.find((item) => item.role === "baseline")?.rowCount ?? l4Rows.length,
        originalFixtureBaselineUsedForRecon,
      },
      timings,
      sources: registrations.map((item) => ({
        role: item.role,
        family: item.family ?? "manual_baseline",
        sourceId: item.sourceId,
        tableName: item.tableName,
        fileName: item.fileName,
        rowCount: item.rowCount,
        loadSeconds: item.loadSeconds,
        bytes: item.bytes,
        sha256: item.sha256,
      })),
      draft,
      jobStepTimings,
      layerRows,
      publish: {
        runId: publish.runId,
        versionId: publish.version.id,
        versionNo: publish.version.versionNo,
        status: publish.version.status,
        stagedRowCount: publish.stagedRowCount,
        idempotent: publish.idempotent,
      },
      shadowRecon: {
        reconCount: shadowRecon?.reconCount ?? 0,
        dqCount: shadowRecon?.dqCount ?? 0,
        passed: shadowRecon?.passed ?? false,
        maxAbsoluteDiff: shadowRecon?.maxAbsoluteDiff ?? 0,
      },
      runDetail: {
        stepCount: detail.steps.length,
        dqCount: detail.dqEvents.length,
        reconCount: detail.reconResults.length,
        l4PreviewCount: detail.l4Rows.length,
        publishVersionCount: detail.publishVersions.length,
      },
      ...(acceptanceRehearsal ? { acceptanceRehearsal } : {}),
      keptFixtures: options.keepFixtures,
    };

    phase = "result_write";
    await writeSyntheticDbRunnerResultAtomically(resultPath, result);

    console.log("FRONT_PROFIT_SYNTHETIC_DB_RUNNER_OK");
    console.log(`result=${path.relative(REPO_ROOT, resultPath).replaceAll(path.sep, "/")}`);
    console.log(`period=${options.period}`);
    console.log(`requestedSalesRows=${options.rows}`);
    console.log(`runId=${draft.runId}`);
    console.log(`l1Rows=${layerRows.l1Rows}`);
    console.log(`l3Rows=${layerRows.l3Rows}`);
    console.log(`l4Rows=${layerRows.l4Rows}`);
    console.log(`publishedRows=${publish.stagedRowCount}`);
    for (const timing of timings) console.log(`${timing.phase}Seconds=${timing.seconds}`);
    for (const timing of jobStepTimings) {
      console.log(`jobStep.${timing.step}Seconds=${timing.seconds ?? "null"}`);
    }
    console.log("realSamplesUsed=false");
    console.log("deployment=not_started");
  } finally {
    await sql.end();
  }
  } catch (error) {
    await reportFailure(error);
    process.exitCode = 1;
  } finally {
    process.off("uncaughtException", terminateAfterUncaughtFailure);
    process.off("unhandledRejection", terminateAfterUncaughtFailure);
  }
}

const invokedScript = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedScript === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    console.error("FRONT_PROFIT_SYNTHETIC_DB_RUNNER_FAILED");
    console.error("- 前台利润合成数据库运行在结果路径建立前失败");
    process.exitCode = 1;
  });
}
