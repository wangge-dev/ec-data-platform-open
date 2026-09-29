import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const API_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = path.resolve(API_ROOT, "../..");
const TSX_CLI = path.join(API_ROOT, "node_modules/tsx/dist/cli.mjs");
const RUNNER_SCRIPT = path.join(API_ROOT, "scripts/front-profit-synthetic-db-runner.ts");
const SAMPLE_INTERVAL_MS = 1_000;

type Mode = "clean_repeat" | "failure_recovery";

type Options = {
  mode: Mode;
  rows: number;
  period: string;
  seed: number;
  outDir: string;
  composeProject: string;
  postgresContainer: string;
  hostPort: number;
};

type BufferedProcess = {
  child: ChildProcessWithoutNullStreams;
  done: Promise<{ exitStatus: number; stdout: string; stderr: string; totalSeconds: number }>;
};

type ResourceObservation = {
  postgresPeakMemoryBytes: number;
  postgresPeakCpuPercent: number;
  postgresSamples: number;
  runnerProcessTreePeakWorkingSetBytes: number;
  runnerSamples: number;
};

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: front-profit-large-capacity-observe.ts --mode <clean_repeat|failure_recovery> --rows <N> --out <ignored-dir> --compose-project <name> --postgres-container <name> --host-port <port>",
        "Requires TEST_DATABASE_URL for an already migrated, loopback-only ec_large_* database.",
      ].join("\n"));
      process.exit(0);
    }
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const [key, inlineValue] = arg.slice(2).split("=", 2);
    const value = inlineValue ?? argv[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    if (inlineValue == null) index += 1;
    values.set(key, value);
  }
  const mode = values.get("mode") as Mode;
  const options: Options = {
    mode,
    rows: Number(values.get("rows")),
    period: values.get("period") ?? "2026-08",
    seed: Number(values.get("seed") ?? 20260810),
    outDir: path.resolve(REPO_ROOT, values.get("out") ?? ""),
    composeProject: values.get("compose-project") ?? "",
    postgresContainer: values.get("postgres-container") ?? "",
    hostPort: Number(values.get("host-port")),
  };
  if (mode !== "clean_repeat" && mode !== "failure_recovery") throw new Error("--mode must be clean_repeat or failure_recovery");
  if (!Number.isSafeInteger(options.rows) || options.rows <= 0) throw new Error("--rows must be a positive integer");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(options.period)) throw new Error("--period must use YYYY-MM");
  if (!Number.isSafeInteger(options.seed) || options.seed <= 0) throw new Error("--seed must be a positive integer");
  if (!/^ec-fp-large-capacity-[a-z0-9-]+$/.test(options.composeProject)) throw new Error("--compose-project must use the isolated ec-fp-large-capacity-* prefix");
  if (!/^ec-fp-large-capacity-[a-z0-9-]+-postgres$/.test(options.postgresContainer)) throw new Error("--postgres-container must use the isolated ec-fp-large-capacity-*-postgres pattern");
  if (!Number.isSafeInteger(options.hostPort) || options.hostPort < 10_000 || options.hostPort > 65_535) throw new Error("--host-port must be an isolated high port");
  const relativeOut = path.relative(REPO_ROOT, options.outDir);
  if (relativeOut.startsWith("..") || path.isAbsolute(relativeOut) || !relativeOut) throw new Error("--out must stay inside the repository");
  const ignored = spawnSync("git", ["check-ignore", "--quiet", "--", relativeOut.replaceAll(path.sep, "/")], {
    cwd: REPO_ROOT,
    stdio: "ignore",
    shell: false,
  });
  if (ignored.status !== 0) throw new Error("--out must be git-ignored");
  return options;
}

function requireIsolatedDatabase(options: Options): { url: string; databaseName: string } {
  const value = process.env.TEST_DATABASE_URL?.trim();
  if (!value) throw new Error("TEST_DATABASE_URL is required");
  const parsed = new URL(value);
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol)) throw new Error("TEST_DATABASE_URL must use PostgreSQL");
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") throw new Error("TEST_DATABASE_URL must use loopback");
  if (Number(parsed.port) !== options.hostPort) throw new Error("TEST_DATABASE_URL port must match --host-port");
  if (decodeURIComponent(parsed.username) !== "ec_app") throw new Error("TEST_DATABASE_URL must use the ec_app runtime role");
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/^ec_large_[a-z0-9_]+$/.test(databaseName)) throw new Error("TEST_DATABASE_URL database must use the ec_large_* prefix");
  return { url: value, databaseName };
}

function docker(args: string[], options: { allowFailure?: boolean } = {}): string {
  const result = spawnSync("docker", args, { cwd: REPO_ROOT, encoding: "utf8", shell: false });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`isolated Docker command failed: ${[result.stdout, result.stderr].filter(Boolean).join(" ").trim()}`);
  }
  return (result.stdout ?? "").trim();
}

function verifyContainerIsolation(options: Options): void {
  const project = docker(["inspect", options.postgresContainer, "--format", "{{index .Config.Labels \"com.docker.compose.project\"}}"]).trim();
  if (project !== options.composeProject) throw new Error(`container Compose project mismatch: ${project}`);
}

function databaseBytes(options: Options, databaseName: string): number {
  const output = docker([
    "exec",
    options.postgresContainer,
    "psql",
    "-U",
    "ec",
    "-d",
    databaseName,
    "-Atqc",
    "SELECT pg_database_size(current_database())",
  ]);
  const value = Number(output);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid database byte count: ${output}`);
  return value;
}

function volumeBytes(options: Options): number {
  const output = docker([
    "exec",
    options.postgresContainer,
    "sh",
    "-lc",
    "du -sb /var/lib/postgresql/data | cut -f1",
  ]);
  const value = Number(output);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid volume byte count: ${output}`);
  return value;
}

function spawnBuffered(command: string, args: string[], env: NodeJS.ProcessEnv): BufferedProcess {
  const started = performance.now();
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const done = new Promise<{ exitStatus: number; stdout: string; stderr: string; totalSeconds: number }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({
      exitStatus: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      totalSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
    }));
  });
  return { child, done };
}

function runnerArgs(options: Options, outDir: string): string[] {
  return [
    TSX_CLI,
    RUNNER_SCRIPT,
    "--period",
    options.period,
    "--rows",
    String(options.rows),
    "--seed",
    String(options.seed),
    "--out",
    outDir,
  ];
}

function parseByteUnit(value: string): number {
  const match = value.trim().match(/^([0-9.]+)\s*(B|kB|KB|KiB|MB|MiB|GB|GiB|TB|TiB)$/i);
  if (!match) return 0;
  const units: Record<string, number> = {
    b: 1,
    kb: 1_000,
    kib: 1_024,
    mb: 1_000_000,
    mib: 1_048_576,
    gb: 1_000_000_000,
    gib: 1_073_741_824,
    tb: 1_000_000_000_000,
    tib: 1_099_511_627_776,
  };
  return Math.round(Number(match[1]) * (units[match[2].toLowerCase()] ?? 0));
}

function lineReader(onLine: (line: string) => void) {
  let pending = "";
  return (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    lines.map((line) => line.trim()).filter(Boolean).forEach(onLine);
  };
}

function powershellSamplerScript(rootPid: number): string {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$rootPidValue=${rootPid}`,
    "while ($true) {",
    "  $all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)",
    "  if (-not ($all | Where-Object { [int]$_.ProcessId -eq $rootPidValue })) { break }",
    "  $ids=[Collections.Generic.HashSet[int]]::new()",
    "  [void]$ids.Add($rootPidValue)",
    "  $changed=$true",
    "  while ($changed) {",
    "    $changed=$false",
    "    foreach ($item in $all) {",
    "      if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) { $changed=$true }",
    "    }",
    "  }",
    "  [int64]$working=0",
    "  foreach ($id in $ids) { $proc=Get-Process -Id $id -ErrorAction SilentlyContinue; if ($proc) { $working += [int64]$proc.WorkingSet64 } }",
    "  [Console]::Out.WriteLine($working)",
    `  Start-Sleep -Milliseconds ${SAMPLE_INTERVAL_MS}`,
    "}",
  ].join("; ");
}

async function observeResources(
  options: Options,
  processRun: BufferedProcess,
): Promise<{ processResult: Awaited<BufferedProcess["done"]>; resources: ResourceObservation }> {
  let postgresPeakMemoryBytes = 0;
  let postgresPeakCpuPercent = 0;
  let postgresSamples = 0;
  let runnerProcessTreePeakWorkingSetBytes = 0;
  let runnerSamples = 0;

  let keepSamplingDocker = true;
  const dockerStatsDone = (async () => {
    do {
      const sampleRun = spawnBuffered(
        "docker",
        ["stats", options.postgresContainer, "--no-stream", "--format", "{{json .}}"],
        process.env,
      );
      const sampleResult = await sampleRun.done;
      if (sampleResult.exitStatus !== 0) continue;
      for (const line of sampleResult.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
        try {
          const sample = JSON.parse(line) as { MemUsage?: string; CPUPerc?: string };
          const memory = parseByteUnit(String(sample.MemUsage ?? "").split("/")[0] ?? "");
          const cpu = Number(String(sample.CPUPerc ?? "0").replace("%", ""));
          postgresPeakMemoryBytes = Math.max(postgresPeakMemoryBytes, memory);
          postgresPeakCpuPercent = Math.max(postgresPeakCpuPercent, Number.isFinite(cpu) ? cpu : 0);
          postgresSamples += 1;
        } catch {
          // Ignore an incomplete sample; the minimum sample gate catches a broken sampler.
        }
      }
    } while (keepSamplingDocker);
  })();

  const memorySampler = spawn("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    powershellSamplerScript(processRun.child.pid!),
  ], {
    cwd: REPO_ROOT,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  memorySampler.stdout.on("data", lineReader((line) => {
    const value = Number(line);
    if (Number.isSafeInteger(value) && value > 0) {
      runnerProcessTreePeakWorkingSetBytes = Math.max(runnerProcessTreePeakWorkingSetBytes, value);
      runnerSamples += 1;
    }
  }));

  const processResult = await processRun.done;
  keepSamplingDocker = false;
  await dockerStatsDone;
  if (memorySampler.exitCode == null) {
    await Promise.race([
      new Promise<void>((resolve) => memorySampler.once("close", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS * 2)),
    ]);
  }
  if (memorySampler.exitCode == null) memorySampler.kill();
  return {
    processResult,
    resources: {
      postgresPeakMemoryBytes,
      postgresPeakCpuPercent: Number(postgresPeakCpuPercent.toFixed(2)),
      postgresSamples,
      runnerProcessTreePeakWorkingSetBytes,
      runnerSamples,
    },
  };
}

function resultPath(stdout: string): string {
  const value = stdout.match(/^result=(.+)$/m)?.[1]?.trim();
  if (!value) throw new Error("runner did not print a result path");
  const resolved = path.resolve(REPO_ROOT, value);
  if (!existsSync(resolved)) throw new Error(`runner result does not exist: ${value}`);
  return resolved;
}

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function repoRelative(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).replaceAll(path.sep, "/");
}

function phaseSeconds(result: any, phase: string): number {
  const timing = (result.timings ?? []).find((item: any) => item.phase === phase);
  if (!timing || !Number.isFinite(Number(timing.seconds))) throw new Error(`runner result missing timing ${phase}`);
  return Number(timing.seconds);
}

function successfulRunEvidence(input: {
  kind: "clean_repeat" | "recovery_retry";
  resultPath: string;
  result: any;
  totalSeconds: number;
  resources: ResourceObservation;
  databaseBefore: number;
  databaseAfter: number;
  volumeBefore: number;
  volumeAfter: number;
}) {
  if (input.result.schema !== "front-profit-synthetic-db-runner-result/v1") throw new Error("runner did not produce a success result");
  if (!input.result.shadowRecon?.passed || input.result.layerRows?.dqRows !== 0 || input.result.publish?.status !== "published") {
    throw new Error("runner semantic result did not pass");
  }
  return {
    kind: input.kind,
    resultPath: repoRelative(input.resultPath),
    totalSeconds: input.totalSeconds,
    timings: {
      fixtureGenerateSeconds: phaseSeconds(input.result, "fixture_generate"),
      ufLoadSeconds: phaseSeconds(input.result, "uf_load"),
      draftSeconds: phaseSeconds(input.result, "draft_l1_l3_l4"),
      alignedBaselineLoadSeconds: phaseSeconds(input.result, "aligned_baseline_load"),
      shadowReconSeconds: phaseSeconds(input.result, "shadow_recon"),
      publishSeconds: phaseSeconds(input.result, "publish"),
      runDetailQuerySeconds: phaseSeconds(input.result, "run_detail_query"),
    },
    layerRows: input.result.layerRows,
    publish: {
      status: input.result.publish.status,
      stagedRowCount: input.result.publish.stagedRowCount,
    },
    shadowRecon: {
      passed: input.result.shadowRecon.passed,
      maxAbsoluteDiff: input.result.shadowRecon.maxAbsoluteDiff,
    },
    resources: {
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      sampleCount: Math.min(input.resources.postgresSamples, input.resources.runnerSamples),
      postgresPeakMemoryBytes: input.resources.postgresPeakMemoryBytes,
      postgresPeakCpuPercent: input.resources.postgresPeakCpuPercent,
      runnerProcessTreePeakWorkingSetBytes: input.resources.runnerProcessTreePeakWorkingSetBytes,
      databaseBytesAfterMigration: input.databaseBefore,
      databaseBytesAfterRun: input.databaseAfter,
      databaseGrowthBytes: input.databaseAfter - input.databaseBefore,
      volumeBytesAfterMigration: input.volumeBefore,
      volumeBytesAfterRun: input.volumeAfter,
      volumeGrowthBytes: input.volumeAfter - input.volumeBefore,
    },
  };
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", resolve);
  });
  return hash.digest("hex");
}

async function fixtureHashes(runResultPath: string): Promise<Map<string, string>> {
  const fixtureDir = path.join(path.dirname(runResultPath), "fixtures");
  const manifest = await readJson(path.join(fixtureDir, "synthetic-db-manifest.json"));
  const hashes = new Map<string, string>();
  for (const file of manifest.files ?? []) {
    hashes.set(String(file.role), await sha256File(path.join(fixtureDir, String(file.name))));
  }
  return hashes;
}

async function fixtureHashMismatches(leftPath: string, rightPath: string): Promise<number> {
  const [left, right] = await Promise.all([fixtureHashes(leftPath), fixtureHashes(rightPath)]);
  const roles = new Set([...left.keys(), ...right.keys()]);
  return [...roles].filter((role) => left.get(role) !== right.get(role)).length;
}

function queryCounts(options: Options, databaseName: string) {
  const exactTableCount = (qualifiedTable: string): number => {
    if (!/^(public|user_data)\.[a-z0-9_]+$/.test(qualifiedTable)) throw new Error(`unsafe rollback table name: ${qualifiedTable}`);
    const exists = docker([
      "exec", options.postgresContainer, "psql", "-U", "ec", "-d", databaseName, "-Atqc",
      `SELECT to_regclass('${qualifiedTable}') IS NOT NULL`,
    ]);
    if (exists === "f") return 0;
    if (exists !== "t") throw new Error(`invalid rollback table existence output for ${qualifiedTable}: ${exists}`);
    const output = docker([
      "exec", options.postgresContainer, "psql", "-U", "ec", "-d", databaseName, "-Atqc",
      `SELECT count(*) FROM ${qualifiedTable}`,
    ]);
    const value = Number(output);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid rollback count output for ${qualifiedTable}: ${output}`);
    return value;
  };
  const userDataTablesOutput = docker([
    "exec", options.postgresContainer, "psql", "-U", "ec", "-d", databaseName, "-Atqc",
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='user_data' AND table_name LIKE 'uf_%'",
  ]);
  const userDataTables = Number(userDataTablesOutput);
  if (!Number.isSafeInteger(userDataTables) || userDataTables < 0) {
    throw new Error(`invalid user_data rollback table count: ${userDataTablesOutput}`);
  }
  return {
    externalResidue: {
      registeredSources: exactTableCount("public.data_sources"),
      userDataTables,
    },
    rollbackCounts: {
      jobRuns: exactTableCount("public.job_run"),
      jobSteps: exactTableCount("public.job_step"),
      l1Rows: exactTableCount("public.front_profit_l1_source_row"),
      l3Rows: exactTableCount("public.front_profit_l3_calc_detail"),
      l4Rows: exactTableCount("public.front_profit_l4_agg"),
      dqEvents: exactTableCount("public.dq_event"),
      reconResults: exactTableCount("public.recon_result"),
      publishVersions: exactTableCount("public.publish_version"),
      publishedRows: exactTableCount("public.front_profit_published_row"),
    },
  };
}

async function injectBackendTermination(
  options: Options,
  databaseName: string,
  runner: BufferedProcess,
): Promise<number> {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    if (runner.child.exitCode != null) throw new Error("failure runner exited before the injection query was observed");
    const pidText = docker([
      "exec",
      options.postgresContainer,
      "psql",
      "-U",
      "ec",
      "-d",
      databaseName,
      "-Atqc",
      "SELECT pid FROM pg_stat_activity WHERE usename='ec_app' AND state='active' AND query ILIKE '%front_profit_operator_assignment%' ORDER BY query_start DESC LIMIT 1",
    ], { allowFailure: true });
    const pid = Number(pidText);
    if (Number.isSafeInteger(pid) && pid > 0) {
      const terminated = docker([
        "exec",
        options.postgresContainer,
        "psql",
        "-U",
        "ec",
        "-d",
        databaseName,
        "-Atqc",
        `SELECT pg_terminate_backend(${pid})`,
      ]);
      if (terminated !== "t") throw new Error(`pg_terminate_backend did not return true for pid ${pid}`);
      return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for front_profit_operator_assignment insert");
}

async function runClean(options: Options, databaseName: string, databaseUrl: string) {
  const databaseBefore = databaseBytes(options, databaseName);
  const volumeBefore = volumeBytes(options);
  const runDir = path.join(options.outDir, `${options.rows}-clean-repeat`);
  const processRun = spawnBuffered(process.execPath, runnerArgs(options, runDir), {
    ...process.env,
    TEST_DATABASE_URL: databaseUrl,
  });
  const observed = await observeResources(options, processRun);
  if (observed.processResult.exitStatus !== 0) {
    throw new Error(`clean runner failed with exit status ${observed.processResult.exitStatus}`);
  }
  const resultFile = resultPath(observed.processResult.stdout);
  const result = await readJson(resultFile);
  const databaseAfter = databaseBytes(options, databaseName);
  const volumeAfter = volumeBytes(options);
  return successfulRunEvidence({
    kind: "clean_repeat",
    resultPath: resultFile,
    result,
    totalSeconds: observed.processResult.totalSeconds,
    resources: observed.resources,
    databaseBefore,
    databaseAfter,
    volumeBefore,
    volumeAfter,
  });
}

async function runFailureRecovery(options: Options, databaseName: string, databaseUrl: string) {
  const databaseBefore = databaseBytes(options, databaseName);
  const volumeBefore = volumeBytes(options);
  const failureDir = path.join(options.outDir, `${options.rows}-failure-attempt`);
  const failureRun = spawnBuffered(process.execPath, runnerArgs(options, failureDir), {
    ...process.env,
    TEST_DATABASE_URL: databaseUrl,
  });
  await injectBackendTermination(options, databaseName, failureRun);
  const failed = await failureRun.done;
  if (failed.exitStatus === 0) throw new Error("failure runner unexpectedly succeeded after backend termination");
  const failureResultFile = resultPath(failed.stdout);
  const failureResult = await readJson(failureResultFile);
  if (
    failureResult.schema !== "front-profit-synthetic-db-runner-failure/v1"
    || failureResult.failure?.code !== "FRONT_PROFIT_SYNTHETIC_DB_RUNNER_FAILED"
    || failureResult.failure?.phase !== "draft_l1_l3_l4"
  ) {
    throw new Error("failure runner did not write the expected draft failure result");
  }
  const postFailureCounts = queryCounts(options, databaseName);

  const recoveryDir = path.join(options.outDir, `${options.rows}-recovery-retry`);
  const recoveryRun = spawnBuffered(process.execPath, runnerArgs(options, recoveryDir), {
    ...process.env,
    TEST_DATABASE_URL: databaseUrl,
  });
  const observed = await observeResources(options, recoveryRun);
  if (observed.processResult.exitStatus !== 0) {
    throw new Error(`recovery runner failed with exit status ${observed.processResult.exitStatus}`);
  }
  const recoveryResultFile = resultPath(observed.processResult.stdout);
  const recoveryResult = await readJson(recoveryResultFile);
  const databaseAfter = databaseBytes(options, databaseName);
  const volumeAfter = volumeBytes(options);
  const successfulRun = successfulRunEvidence({
    kind: "recovery_retry",
    resultPath: recoveryResultFile,
    result: recoveryResult,
    totalSeconds: observed.processResult.totalSeconds,
    resources: observed.resources,
    databaseBefore,
    databaseAfter,
    volumeBefore,
    volumeAfter,
  });
  return {
    successfulRun,
    failureRecovery: {
      method: "pg_terminate_backend_on_front_profit_operator_assignment_insert",
      failureExitStatus: failed.exitStatus,
      machineFailureResultPath: repoRelative(failureResultFile),
      machineFailureSchema: failureResult.schema,
      failureCode: failureResult.failure.code,
      failurePhase: failureResult.failure.phase,
      rollbackCounts: postFailureCounts.rollbackCounts,
      externalResidue: postFailureCounts.externalResidue,
      recoveryResultPath: repoRelative(recoveryResultFile),
      sameSeed: failureResult.seed === recoveryResult.seed && recoveryResult.seed === options.seed,
      fixtureHashMismatches: await fixtureHashMismatches(failureResultFile, recoveryResultFile),
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const database = requireIsolatedDatabase(options);
  verifyContainerIsolation(options);
  await mkdir(options.outDir, { recursive: true });
  const fragment = options.mode === "clean_repeat"
    ? {
        schema: "front-profit-large-capacity-observation-fragment/v1",
        salesRows: options.rows,
        mode: options.mode,
        successfulRun: await runClean(options, database.databaseName, database.url),
      }
    : {
        schema: "front-profit-large-capacity-observation-fragment/v1",
        salesRows: options.rows,
        mode: options.mode,
        ...(await runFailureRecovery(options, database.databaseName, database.url)),
      };
  const fragmentPath = path.join(options.outDir, `${options.rows}-${options.mode}-fragment.json`);
  await writeJsonAtomically(fragmentPath, fragment);
  console.log("FRONT_PROFIT_LARGE_CAPACITY_OBSERVATION_OK");
  console.log(`fragment=${repoRelative(fragmentPath)}`);
}

main().catch((error) => {
  console.error("FRONT_PROFIT_LARGE_CAPACITY_OBSERVATION_FAILED");
  console.error(`- ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
