import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const API_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = path.resolve(API_ROOT, "../..");
const TSX_CLI = path.join(API_ROOT, "node_modules/tsx/dist/cli.mjs");
const RUNNER = path.join(API_ROOT, "scripts/api-soak-csv-upload-runner.ts");
const SAMPLE_INTERVAL_MS = 5_000;
const CGROUP_SAMPLE_TIMEOUT_MS = 4_000;
const TREND_WINDOW_SAMPLES = 60;

type Options = {
  apiUrl: string;
  durationSeconds: number;
  outDir: string;
  composeProject: string;
  apiContainer: string;
  postgresContainer: string;
  databaseName: string;
  sourceCommit: string;
};

type ResourceSample = { atEpochMs: number; memoryBytes: number; cpuPercent: number };
type CgroupCounters = { memoryBytes: number; cpuUsageUsec: number };

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const [key, inline] = arg.slice(2).split("=", 2);
    const value = inline ?? argv[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    if (inline == null) index++;
    values.set(key, value);
  }
  const apiUrl = values.get("api-url") ?? "";
  const parsed = new URL(apiUrl);
  if (
    parsed.protocol !== "http:"
    || !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || Number(parsed.port) < 10_000
    || Number(parsed.port) > 65_535
    || parsed.pathname.replace(/\/$/, "") !== "/api"
  ) throw new Error("--api-url must use loopback, an isolated high port, and end in /api");
  const durationSeconds = Number(values.get("duration-seconds") ?? 1_800);
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 2_400) {
    throw new Error("--duration-seconds must be 1..2400");
  }
  const composeProject = values.get("compose-project") ?? "";
  if (!/^ec-api-soak-[a-z0-9-]+$/.test(composeProject)) throw new Error("--compose-project must use ec-api-soak-* prefix");
  const apiContainer = values.get("api-container") ?? "";
  const postgresContainer = values.get("postgres-container") ?? "";
  if (apiContainer !== `${composeProject}-api` || postgresContainer !== `${composeProject}-postgres`) {
    throw new Error("container names must be <compose-project>-api and <compose-project>-postgres");
  }
  const databaseName = values.get("database") ?? "";
  if (!/^ec_api_soak_[a-z0-9_]+$/.test(databaseName)) throw new Error("--database must use ec_api_soak_* prefix");
  const sourceCommit = values.get("source-commit") ?? "";
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("--source-commit must be a full lowercase Git commit SHA");
  const outDir = path.resolve(REPO_ROOT, values.get("out") ?? "");
  const relativeOut = path.relative(REPO_ROOT, outDir);
  if (!relativeOut || relativeOut.startsWith("..") || path.isAbsolute(relativeOut)) throw new Error("--out must stay in repository");
  const ignored = spawnSync("git", ["check-ignore", "--quiet", "--", relativeOut.replaceAll(path.sep, "/")], {
    cwd: REPO_ROOT,
    stdio: "ignore",
    shell: false,
  });
  if (ignored.status !== 0) throw new Error("--out must be git-ignored");
  return {
    apiUrl: apiUrl.replace(/\/$/, ""),
    durationSeconds,
    outDir,
    composeProject,
    apiContainer,
    postgresContainer,
    databaseName,
    sourceCommit,
  };
}

function docker(args: string[]): string {
  const run = spawnSync("docker", args, { cwd: REPO_ROOT, encoding: "utf8", shell: false });
  if (run.status !== 0) throw new Error(`docker ${args[0]} failed: ${(run.stderr || run.stdout).trim()}`);
  return run.stdout.trim();
}

function git(args: string[]): string {
  const run = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", shell: false });
  if (run.status !== 0) throw new Error(`git ${args[0]} failed: ${(run.stderr || run.stdout).trim()}`);
  return run.stdout.trim();
}

function verifyIsolation(options: Options): { sourceCommit: string; runtimeImageDigest: string } {
  const repositoryHead = git(["rev-parse", "HEAD"]);
  if (repositoryHead !== options.sourceCommit) throw new Error(`--source-commit must equal repository HEAD (${repositoryHead})`);
  if (git(["status", "--porcelain", "--untracked-files=all"])) throw new Error("repository must be clean before provenance observation");
  for (const container of [options.apiContainer, options.postgresContainer]) {
    const label = docker(["inspect", container, "--format", "{{index .Config.Labels \"com.docker.compose.project\"}}"]);
    if (label !== options.composeProject) throw new Error(`${container} project label mismatch`);
  }
  const runtimeImageDigest = docker(["inspect", options.apiContainer, "--format", "{{.Image}}"]);
  if (!/^sha256:[a-f0-9]{64}$/.test(runtimeImageDigest)) throw new Error("API container runtime image digest is invalid");
  const revisionFormat = "{{index .Config.Labels \"org.opencontainers.image.revision\"}}";
  const containerRevision = docker(["inspect", options.apiContainer, "--format", revisionFormat]);
  const imageRevision = docker(["image", "inspect", runtimeImageDigest, "--format", revisionFormat]);
  const inspectedImageDigest = docker(["image", "inspect", runtimeImageDigest, "--format", "{{.Id}}"]);
  if (containerRevision !== options.sourceCommit || imageRevision !== options.sourceCommit) {
    throw new Error("API runtime image revision label does not match --source-commit");
  }
  if (inspectedImageDigest !== runtimeImageDigest) throw new Error("API container and local image digests differ");
  return { sourceCommit: options.sourceCommit, runtimeImageDigest };
}

function spawnBuffered(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const started = performance.now();
  const child = spawn(command, args, { cwd: REPO_ROOT, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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

async function readCgroupCounters(container: string): Promise<CgroupCounters | null> {
  const run = spawnBuffered("docker", [
    "exec", container, "sh", "-c",
    "cat /sys/fs/cgroup/memory.current; sed -n 's/^usage_usec //p' /sys/fs/cgroup/cpu.stat",
  ], process.env);
  let timeout: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    run.done,
    new Promise<null>((resolve) => {
      timeout = setTimeout(() => {
        run.child.kill();
        resolve(null);
      }, CGROUP_SAMPLE_TIMEOUT_MS);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (!result || result.exitStatus !== 0) return null;
  const [memoryText, cpuText] = result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const memoryBytes = Number(memoryText);
  const cpuUsageUsec = Number(cpuText);
  return Number.isSafeInteger(memoryBytes) && memoryBytes > 0 && Number.isSafeInteger(cpuUsageUsec) && cpuUsageUsec >= 0
    ? { memoryBytes, cpuUsageUsec }
    : null;
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
    "  while ($changed) { $changed=$false; foreach ($item in $all) { if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) { $changed=$true } } }",
    "  [int64]$working=0",
    "  foreach ($id in $ids) { $proc=Get-Process -Id $id -ErrorAction SilentlyContinue; if ($proc) { $working += [int64]$proc.WorkingSet64 } }",
    "  $stamp=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "  [Console]::Out.WriteLine(\"$stamp|$working\")",
    `  Start-Sleep -Milliseconds ${SAMPLE_INTERVAL_MS}`,
    "}",
  ].join("; ");
}

function databaseBytes(options: Options): number {
  const value = Number(docker([
    "exec", options.postgresContainer, "psql", "-U", "ec", "-d", options.databaseName,
    "-Atqc", "SELECT pg_database_size(current_database())",
  ]));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid database size");
  return value;
}

function residueCounts(options: Options): { sources: number; tables: number; tempDirectories: number } {
  const sources = Number(docker([
    "exec", options.postgresContainer, "psql", "-U", "ec", "-d", options.databaseName,
    "-Atqc", "SELECT count(*) FROM public.data_sources WHERE config ? 'largeCsvUpload'",
  ]));
  const tables = Number(docker([
    "exec", options.postgresContainer, "psql", "-U", "ec", "-d", options.databaseName,
    "-Atqc", "SELECT count(*) FROM information_schema.tables WHERE table_schema='user_data' AND table_name LIKE 'uf_%'",
  ]));
  const tempDirectories = Number(docker([
    "exec", options.apiContainer, "sh", "-lc", "find /tmp -mindepth 1 -maxdepth 1 -type d -name 'ec-large-csv-*' | wc -l",
  ]));
  return { sources, tables, tempDirectories };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function peak(samples: ResourceSample[]): number {
  return Math.max(...samples.map((sample) => sample.memoryBytes));
}

function medianGrowth(samples: ResourceSample[]): number {
  return median(samples.slice(-TREND_WINDOW_SAMPLES).map((sample) => sample.memoryBytes))
    - median(samples.slice(0, TREND_WINDOW_SAMPLES).map((sample) => sample.memoryBytes));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!process.env.API_ADMIN_PASSWORD?.trim()) throw new Error("API_ADMIN_PASSWORD is required");
  const provenance = verifyIsolation(options);
  await mkdir(options.outDir, { recursive: true });
  const runnerFile = path.join(options.outDir, "runner-result.json");
  const progressFile = path.join(options.outDir, "progress.json");
  const databaseBefore = databaseBytes(options);
  const run = spawnBuffered(process.execPath, [
    TSX_CLI,
    RUNNER,
    "--api-url", options.apiUrl,
    "--duration-seconds", String(options.durationSeconds),
    "--interval-seconds", "20",
    "--rows", "100000",
    "--failure-every-cycles", "10",
    "--file-slots", "5",
    "--filename-prefix", "api-soak-capacity",
    "--out", path.relative(REPO_ROOT, runnerFile).replaceAll(path.sep, "/"),
    "--progress", path.relative(REPO_ROOT, progressFile).replaceAll(path.sep, "/"),
  ], process.env);

  const apiSamples: ResourceSample[] = [];
  const postgresSamples: ResourceSample[] = [];
  const clientSamples: ResourceSample[] = [];
  const previousCgroup = new Map<string, CgroupCounters & { atEpochMs: number }>();
  let keepSamplingDocker = true;
  const dockerSamplesDone = (async () => {
    while (keepSamplingDocker) {
      const sampleStarted = Date.now();
      await Promise.all([
        [options.apiContainer, apiSamples] as const,
        [options.postgresContainer, postgresSamples] as const,
      ].map(async ([container, samples]) => {
        const counters = await readCgroupCounters(container);
        const atEpochMs = Date.now();
        if (!counters) return;
        const previous = previousCgroup.get(container);
        const cpuPercent = previous && atEpochMs > previous.atEpochMs
          ? Math.max(0, ((counters.cpuUsageUsec - previous.cpuUsageUsec) / 1_000) / (atEpochMs - previous.atEpochMs) * 100)
          : 0;
        samples.push({ atEpochMs, memoryBytes: counters.memoryBytes, cpuPercent });
        previousCgroup.set(container, { ...counters, atEpochMs });
      }));
      const remaining = SAMPLE_INTERVAL_MS - (Date.now() - sampleStarted);
      if (keepSamplingDocker && remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
    }
  })();

  const clientSampler = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", powershellSamplerScript(run.child.pid!)], {
    cwd: REPO_ROOT,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  clientSampler.stdout.on("data", lineReader((line) => {
    const [timestampText, memoryText] = line.split("|", 2);
    const atEpochMs = Number(timestampText);
    const memoryBytes = Number(memoryText);
    if (Number.isSafeInteger(atEpochMs) && Number.isSafeInteger(memoryBytes) && memoryBytes > 0) {
      clientSamples.push({ atEpochMs, memoryBytes, cpuPercent: 0 });
    }
  }));

  const processResult = await run.done;
  keepSamplingDocker = false;
  await dockerSamplesDone;
  if (clientSampler.exitCode == null) clientSampler.kill();
  if (clientSampler.exitCode == null) {
    await Promise.race([
      new Promise<void>((resolve) => clientSampler.once("close", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  if (processResult.exitStatus !== 0) {
    throw new Error(`runner failed (${processResult.exitStatus}): ${(processResult.stderr || processResult.stdout).trim()}`);
  }
  const resultMatch = processResult.stdout.match(/^result=(.+)$/m)?.[1]?.trim();
  if (!resultMatch) throw new Error("runner did not print result path");
  const resultPath = path.resolve(REPO_ROOT, resultMatch);
  if (!existsSync(resultPath)) throw new Error("runner result missing");
  const workload = JSON.parse(await readFile(resultPath, "utf8"));
  const databaseAfter = databaseBytes(options);
  const residue = residueCounts(options);
  if (residue.sources !== 0 || residue.tables !== 0 || residue.tempDirectories !== 0) {
    throw new Error(`post-run residue detected: ${JSON.stringify(residue)}`);
  }
  if ([apiSamples, postgresSamples, clientSamples].some((samples) => samples.length < TREND_WINDOW_SAMPLES * 2)) {
    throw new Error(`insufficient raw samples for resource trend windows: api=${apiSamples.length} postgres=${postgresSamples.length} client=${clientSamples.length}`);
  }

  const fragment = {
    schema: "api-soak-csv-upload-observation/v1",
    generatedAt: new Date().toISOString(),
    provenance,
    environment: {
      composeProject: options.composeProject,
      apiContainer: options.apiContainer,
      postgresContainer: options.postgresContainer,
      apiUrl: options.apiUrl,
      databaseName: options.databaseName,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
    },
    workloadResultPath: path.relative(REPO_ROOT, resultPath).replaceAll(path.sep, "/"),
    progressPath: path.relative(REPO_ROOT, progressFile).replaceAll(path.sep, "/"),
    workload,
    resourceSamples: { api: apiSamples, postgres: postgresSamples, client: clientSamples },
    observation: {
      totalSeconds: processResult.totalSeconds,
      apiSamples: apiSamples.length,
      postgresSamples: postgresSamples.length,
      clientSamples: clientSamples.length,
      apiPeakMemoryBytes: peak(apiSamples),
      postgresPeakMemoryBytes: peak(postgresSamples),
      clientPeakWorkingSetBytes: peak(clientSamples),
      apiPeakCpuPercent: Math.max(...apiSamples.map((sample) => sample.cpuPercent)),
      postgresPeakCpuPercent: Math.max(...postgresSamples.map((sample) => sample.cpuPercent)),
      apiMedianGrowthBytes: medianGrowth(apiSamples),
      postgresMedianGrowthBytes: medianGrowth(postgresSamples),
      clientMedianGrowthBytes: medianGrowth(clientSamples),
      databaseBeforeBytes: databaseBefore,
      databaseAfterCleanupBytes: databaseAfter,
      databaseGrowthBytes: databaseAfter - databaseBefore,
    },
    residue,
  };
  const outFile = path.join(options.outDir, "observation.json");
  const temporary = `${outFile}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(fragment, null, 2)}\n`, "utf8");
  await rename(temporary, outFile);
  console.log(`observation=${path.relative(REPO_ROOT, outFile).replaceAll(path.sep, "/")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
