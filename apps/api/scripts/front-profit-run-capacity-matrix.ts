import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { canonicalRowsContract } from "../src/services/front-profit-canonical-rows-contract.js";
import { FRONT_PROFIT_STANDARD_HEADERS } from "../src/services/front-profit-standard.js";

type Options = {
  period: string;
  seed: number;
  outDir: string;
  rows: number[];
  syntheticDbRunnerRows: number[];
  skipSyntheticDbRunner: boolean;
};

type FixtureManifest = {
  requestedSalesRows: number;
  files: Array<{
    role?: string;
    name: string;
    rows: number;
  }>;
};

type FileEvidence = {
  name: string;
  rows: number;
  bytes: number;
  sha256: string;
};

type CapacityFileRole =
  | "operator"
  | "sales"
  | "costPeriod"
  | "costUsage"
  | "rebate"
  | "fee"
  | "promotion"
  | "baseline";

type CapacityFiles = Record<CapacityFileRole, FileEvidence>;

type MatrixEvidence = {
  salesRows: number;
  outDir: string;
  generateSeconds: number;
  contractSeconds: number;
  baselineWarnings: number;
  files: CapacityFiles;
};

type SyntheticDbRunnerTiming = {
  phase: string;
  seconds: number;
};

type SyntheticDbRunnerEvidence = {
  salesRows: number;
  status: "passed" | "failed";
  thresholdStatus: "passed" | "failed";
  thresholds: Record<string, number>;
  totalSeconds: number;
  resultPath?: string;
  timings?: SyntheticDbRunnerTiming[];
  layerRows?: {
    l1Rows: number;
    l3Rows: number;
    l4Rows: number;
    reconRows: number;
    dqRows: number;
  };
  publish?: {
    status: string;
    stagedRowCount: number;
  };
  shadowRecon?: {
    reconCount: number;
    dqCount: number;
    passed: boolean;
  };
  runDetail?: {
    stepCount: number;
    dqCount: number;
    reconCount: number;
    l4PreviewCount: number;
    publishVersionCount: number;
  };
  failureEvidence?: {
    exitStatus: number | null;
    message: string;
    stdoutTail: string;
    stderrTail: string;
  };
};

type SyntheticDbRunnerMatrix = {
  rows: number[];
  command: string;
  entries: SyntheticDbRunnerEvidence[];
};

const ROOT = path.resolve(import.meta.dirname, "../../..");
const API_ROOT = path.resolve(import.meta.dirname, "..");
const TSX_CLI = path.join(API_ROOT, "node_modules/tsx/dist/cli.mjs");
const FIXTURE_GENERATOR_SCRIPT = path.join(API_ROOT, "scripts/front-profit-generate-synthetic-fixtures.ts");
const SYNTHETIC_DB_RUNNER_SCRIPT = path.join(API_ROOT, "scripts/front-profit-synthetic-db-runner.ts");
const DEFAULT_ROWS = [50_000, 250_000, 500_000, 1_000_000];
const SYNTHETIC_DB_RUNNER_ROWS = [1_000, 10_000, 50_000];
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
] as const satisfies readonly (readonly [CapacityFileRole, string])[];

const defaultOptions = (): Options => ({
  period: "2026-08",
  seed: 20260810,
  outDir: path.resolve(API_ROOT, "artifacts/front-profit-capacity-matrix-db-gate-20260811"),
  rows: DEFAULT_ROWS,
  syntheticDbRunnerRows: SYNTHETIC_DB_RUNNER_ROWS,
  skipSyntheticDbRunner: false,
});

function parseArgs(argv: string[]): Options {
  const options = defaultOptions();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    if (arg === "--skip-synthetic-db-runner") {
      options.skipSyntheticDbRunner = true;
      continue;
    }
    const [key, inlineValue] = arg.slice(2).split("=", 2);
    const value = inlineValue ?? argv[index + 1] ?? "";
    if (inlineValue == null) index += 1;
    if (key === "period") options.period = value;
    if (key === "seed") options.seed = Number(value);
    if (key === "out") options.outDir = path.isAbsolute(value) ? path.resolve(value) : path.resolve(ROOT, value);
    if (key === "rows") {
      options.rows = value.split(/[,\s]+/).map((part) => Number(part.trim())).filter(Boolean);
    }
    if (key === "synthetic-db-runner-rows") {
      options.syntheticDbRunnerRows = value.split(/[,\s]+/).map((part) => Number(part.trim())).filter(Boolean);
    }
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(options.period)) {
    throw new Error("--period must use YYYY-MM");
  }
  if (!Number.isSafeInteger(options.seed) || options.seed <= 0) {
    throw new Error("--seed must be a positive integer");
  }
  if (
    options.rows.length === 0
    || options.rows.some((rows) => !Number.isSafeInteger(rows) || rows <= 0)
  ) {
    throw new Error("--rows must be a comma-separated list of positive integers");
  }
  if (
    options.syntheticDbRunnerRows.length === 0
    || options.syntheticDbRunnerRows.some((rows) => !Number.isSafeInteger(rows) || rows <= 0)
  ) {
    throw new Error("--synthetic-db-runner-rows must be a comma-separated list of positive integers");
  }
  return options;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  const pushCell = () => {
    row.push(cell);
    cell = "";
  };
  const pushRow = () => {
    pushCell();
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === "\"" && text[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === "\"") {
      inQuotes = true;
    } else if (char === ",") {
      pushCell();
    } else if (char === "\n") {
      pushRow();
    } else if (char !== "\r") {
      cell += char;
    }
  }
  if (cell !== "" || row.length > 0) pushRow();
  if (inQuotes) throw new Error("CSV ended inside a quoted cell");
  return rows;
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
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error([
      `front-profit fixture generation failed for ${input.rows} rows`,
      result.stdout,
      result.stderr,
      result.error?.message,
    ].filter(Boolean).join("\n"));
  }
}

function runSyntheticDbRunner(input: {
  period: string;
  rows: number;
  seed: number;
  outDir: string;
}): { status: number | null; stdout: string; stderr: string; totalSeconds: number } {
  const args = [
    TSX_CLI,
    SYNTHETIC_DB_RUNNER_SCRIPT,
    "--period",
    input.period,
    "--rows",
    String(input.rows),
    "--seed",
    String(input.seed),
    "--out",
    input.outDir,
  ];
  const started = performance.now();
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: [result.stderr, result.error?.message].filter(Boolean).join("\n"),
    totalSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
  };
}

function tail(value: string, maxLines = 80): string {
  return value.split(/\r?\n/).slice(-maxLines).join("\n").trim();
}

function runnerResultPath(stdout: string): string | null {
  const match = stdout.match(/^result=(.+)$/m);
  if (!match?.[1]) return null;
  return path.resolve(ROOT, match[1].trim());
}

function timingMap(timings: readonly SyntheticDbRunnerTiming[] | undefined): Map<string, number> {
  return new Map((timings ?? []).map((timing) => [timing.phase, timing.seconds]));
}

function thresholdStatus(input: {
  rows: number;
  totalSeconds: number;
  timings?: SyntheticDbRunnerTiming[];
}): "passed" | "failed" {
  const thresholds = SYNTHETIC_DB_RUNNER_THRESHOLDS[input.rows];
  if (!thresholds) return "failed";
  if (input.totalSeconds > thresholds.total!) return "failed";
  const timings = timingMap(input.timings);
  for (const [phase, threshold] of Object.entries(thresholds)) {
    if (phase === "total") continue;
    const actual = timings.get(phase);
    if (actual == null || actual > threshold) return "failed";
  }
  return "passed";
}

async function verifySyntheticDbRunner(input: {
  period: string;
  seed: number;
  outDir: string;
  rows: number;
}): Promise<SyntheticDbRunnerEvidence> {
  const thresholds = SYNTHETIC_DB_RUNNER_THRESHOLDS[input.rows] ?? {};
  const run = runSyntheticDbRunner(input);
  const resultPath = runnerResultPath(run.stdout);
  if (run.status !== 0 || !resultPath) {
    return {
      salesRows: input.rows,
      status: "failed",
      thresholdStatus: "failed",
      thresholds,
      totalSeconds: run.totalSeconds,
      ...(resultPath ? { resultPath: path.relative(ROOT, resultPath).replaceAll(path.sep, "/") } : {}),
      failureEvidence: {
        exitStatus: run.status,
        message: resultPath ? "synthetic DB runner failed" : "synthetic DB runner did not print a result path",
        stdoutTail: tail(run.stdout),
        stderrTail: tail(run.stderr),
      },
    };
  }

  const result = JSON.parse(await readFile(resultPath, "utf8")) as {
    requestedSalesRows: number;
    timings: SyntheticDbRunnerTiming[];
    layerRows: SyntheticDbRunnerEvidence["layerRows"];
    publish: SyntheticDbRunnerEvidence["publish"];
    shadowRecon: SyntheticDbRunnerEvidence["shadowRecon"];
    runDetail: SyntheticDbRunnerEvidence["runDetail"];
  };
  const status = result.requestedSalesRows === input.rows
    && result.layerRows != null
    && result.layerRows.dqRows === 0
    && result.publish?.status === "published"
    && result.shadowRecon?.passed === true
    && result.runDetail != null
    ? "passed"
    : "failed";
  const checkedThresholdStatus = thresholdStatus({
    rows: input.rows,
    totalSeconds: run.totalSeconds,
    timings: result.timings,
  });
  return {
    salesRows: input.rows,
    status,
    thresholdStatus: status === "passed" ? checkedThresholdStatus : "failed",
    thresholds,
    totalSeconds: run.totalSeconds,
    resultPath: path.relative(ROOT, resultPath).replaceAll(path.sep, "/"),
    timings: result.timings,
    layerRows: result.layerRows,
    publish: result.publish,
    shadowRecon: result.shadowRecon,
    runDetail: result.runDetail,
    ...(status === "passed" && checkedThresholdStatus === "passed"
      ? {}
      : {
          failureEvidence: {
            exitStatus: run.status,
            message: status === "passed" ? "synthetic DB runner exceeded a capacity threshold" : "synthetic DB runner result failed semantic checks",
            stdoutTail: tail(run.stdout),
            stderrTail: tail(run.stderr),
          },
        }),
  };
}

async function verifySyntheticDbRunnerMatrix(options: Options): Promise<SyntheticDbRunnerMatrix | null> {
  if (options.skipSyntheticDbRunner) return null;
  const outDir = path.join(options.outDir, "synthetic-db-runner");
  await mkdir(outDir, { recursive: true });
  const entries: SyntheticDbRunnerEvidence[] = [];
  for (const rows of options.syntheticDbRunnerRows) {
    entries.push(await verifySyntheticDbRunner({
      period: options.period,
      seed: options.seed,
      outDir,
      rows,
    }));
  }
  return {
    rows: options.syntheticDbRunnerRows,
    command: "pnpm --filter @ec/api run front-profit:synthetic-db-runner",
    entries,
  };
}

async function readEvidenceFile(filePath: string, name: string, rows: number): Promise<FileEvidence> {
  const bytes = (await readFile(filePath)).length;
  return {
    name,
    rows,
    bytes,
    sha256: await sha256File(filePath),
  };
}

async function verifyOne(input: {
  period: string;
  seed: number;
  outDir: string;
  rows: number;
  suffix?: string;
}): Promise<MatrixEvidence> {
  const rowDirName = `rows-${input.rows}${input.suffix ?? ""}`;
  const outDir = path.join(input.outDir, rowDirName);
  const prefix = `capacity-${input.rows}`;
  await mkdir(outDir, { recursive: true });

  const generateStarted = performance.now();
  runFixtureGenerator({
    period: input.period,
    rows: input.rows,
    seed: input.seed,
    outDir,
    prefix,
  });
  const generateSeconds = (performance.now() - generateStarted) / 1000;

  const manifestPath = path.join(outDir, `${prefix}-manifest.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as FixtureManifest;
  if (manifest.requestedSalesRows !== input.rows) {
    throw new Error(`${manifestPath} requestedSalesRows does not match ${input.rows}`);
  }

  const fileRows = new Map(manifest.files.map((file) => [file.name, file.rows]));
  const roleFiles = new Map<CapacityFileRole, { name: string; rows: number }>();
  for (const [role, suffix] of CAPACITY_FILE_ROLES) {
    const expectedName = `${prefix}-${suffix}.csv`;
    const matched = manifest.files.find((file) => file.role === role || file.name === expectedName);
    if (!matched) {
      throw new Error(`${manifestPath} is missing ${role} fixture file ${expectedName}`);
    }
    roleFiles.set(role, matched);
  }

  const salesName = roleFiles.get("sales")?.name ?? `${prefix}-sales-fact.csv`;
  const baselineName = roleFiles.get("baseline")?.name ?? `${prefix}-manual-baseline.csv`;
  if (fileRows.get(salesName) !== input.rows) {
    throw new Error(`${manifestPath} sales row count does not match ${input.rows}`);
  }

  const baselineText = await readFile(path.join(outDir, baselineName), "utf8");
  const baselineCsv = parseCsv(baselineText);
  const [headers, ...dataRows] = baselineCsv;
  if (JSON.stringify(headers) !== JSON.stringify(FRONT_PROFIT_STANDARD_HEADERS)) {
    throw new Error(`${baselineName} does not use the front-profit standard header contract`);
  }

  const contractStarted = performance.now();
  const contract = canonicalRowsContract({ headers, dataRows });
  const contractSeconds = (performance.now() - contractStarted) / 1000;
  const baselineRows = fileRows.get(baselineName);
  if (baselineRows !== contract.summary.businessRowCount) {
    throw new Error(`${baselineName} manifest row count does not match canonicalRowsContract`);
  }
  if (contract.summary.warningCount !== 0) {
    throw new Error(`${baselineName} produced ${contract.summary.warningCount} canonical warnings`);
  }

  const files = Object.fromEntries(
    await Promise.all(CAPACITY_FILE_ROLES.map(async ([role]) => {
      const file = roleFiles.get(role);
      if (!file) throw new Error(`${manifestPath} is missing ${role} fixture evidence`);
      return [
        role,
        await readEvidenceFile(path.join(outDir, file.name), file.name, file.rows),
      ] as const;
    })),
  ) as CapacityFiles;

  return {
    salesRows: input.rows,
    outDir,
    generateSeconds: Number(generateSeconds.toFixed(3)),
    contractSeconds: Number(contractSeconds.toFixed(3)),
    baselineWarnings: contract.summary.warningCount,
    files,
  };
}

function assertRepeatMatches(first: MatrixEvidence, repeat: MatrixEvidence): void {
  for (const file of ["operator", "sales", "baseline"] as const) {
    if (first.files[file].sha256 !== repeat.files[file].sha256) {
      throw new Error(`50k repeat SHA-256 mismatch for ${file}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.outDir, { recursive: true });
  const matrix: MatrixEvidence[] = [];
  for (const rows of options.rows) {
    matrix.push(await verifyOne({ ...options, rows }));
  }
  if (options.rows.includes(50_000)) {
    const first = matrix.find((entry) => entry.salesRows === 50_000);
    if (!first) throw new Error("50k evidence was not generated");
    const repeat = await verifyOne({ ...options, rows: 50_000, suffix: "-repeat" });
    assertRepeatMatches(first, repeat);
  }
  const syntheticDbRunner = await verifySyntheticDbRunnerMatrix(options);

  const result = {
    schema: "front-profit-capacity-matrix-result/v1",
    period: options.period,
    seed: options.seed,
    rows: options.rows,
    outDir: options.outDir,
    generatedAt: new Date().toISOString(),
    matrix,
    syntheticDbRunner,
  };
  await writeFile(
    path.join(options.outDir, "capacity-matrix-result.json"),
    JSON.stringify(result, null, 2) + "\n",
    "utf8",
  );
  console.log(JSON.stringify(result, null, 2));
  if (syntheticDbRunner?.entries.some((entry) => entry.status !== "passed" || entry.thresholdStatus !== "passed")) {
    throw new Error("synthetic DB runner capacity matrix failed; see syntheticDbRunner entries for failureEvidence");
  }
  console.log("FRONT_PROFIT_CAPACITY_MATRIX_OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
