import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const API_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = path.resolve(API_ROOT, "../..");
const TSX_CLI = path.join(API_ROOT, "node_modules/tsx/dist/cli.mjs");
const RUNNER = path.join(API_ROOT, "scripts/api-million-csv-upload-runner.ts");
const SAMPLE_INTERVAL_MS = 1_000;

type Options = {
  apiUrl: string;
  rows: number;
  fileName: string;
  outDir: string;
  composeProject: string;
  apiContainer: string;
  postgresContainer: string;
  databaseName: string;
  sourceCommit: string;
};

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
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsed.hostname) || Number(parsed.port) < 10_000) {
    throw new Error("--api-url must use loopback and an isolated high port");
  }
  const rows = Number(values.get("rows") ?? 1_000_000);
  if (!Number.isSafeInteger(rows) || rows < 1 || rows > 1_000_000) throw new Error("--rows must be 1..1000000");
  const composeProject = values.get("compose-project") ?? "";
  if (!/^ec-api-million-[a-z0-9-]+$/.test(composeProject)) throw new Error("--compose-project must use ec-api-million-* prefix");
  const apiContainer = values.get("api-container") ?? "";
  const postgresContainer = values.get("postgres-container") ?? "";
  if (apiContainer !== `${composeProject}-api` || postgresContainer !== `${composeProject}-postgres`) {
    throw new Error("container names must be <compose-project>-api and <compose-project>-postgres");
  }
  const databaseName = values.get("database") ?? "";
  if (!/^ec_api_million_[a-z0-9_]+$/.test(databaseName)) throw new Error("--database must use ec_api_million_* prefix");
  const sourceCommit = values.get("source-commit") ?? "";
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("--source-commit must be a full lowercase Git commit SHA");
  const outDir = path.resolve(REPO_ROOT, values.get("out") ?? "");
  const relativeOut = path.relative(REPO_ROOT, outDir);
  if (!relativeOut || relativeOut.startsWith("..") || path.isAbsolute(relativeOut)) throw new Error("--out must stay in repository");
  const ignored = spawnSync("git", ["check-ignore", "--quiet", "--", relativeOut.replaceAll(path.sep, "/")], { cwd: REPO_ROOT, stdio: "ignore", shell: false });
  if (ignored.status !== 0) throw new Error("--out must be git-ignored");
  return {
    apiUrl: apiUrl.replace(/\/$/, ""),
    rows,
    fileName: values.get("filename") ?? "api-million-capacity.csv",
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
  if (repositoryHead !== options.sourceCommit) {
    throw new Error(`--source-commit must equal repository HEAD (${repositoryHead})`);
  }
  if (git(["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("repository must be clean before provenance observation");
  }
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

function parseByteUnit(value: string): number {
  const match = value.trim().match(/^([0-9.]+)\s*(B|kB|KB|KiB|MB|MiB|GB|GiB|TB|TiB)$/i);
  if (!match) return 0;
  const units: Record<string, number> = {
    b: 1, kb: 1_000, kib: 1_024, mb: 1_000_000, mib: 1_048_576,
    gb: 1_000_000_000, gib: 1_073_741_824, tb: 1_000_000_000_000, tib: 1_099_511_627_776,
  };
  return Math.round(Number(match[1]) * units[match[2].toLowerCase()]);
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
    "  [Console]::Out.WriteLine($working)",
    `  Start-Sleep -Milliseconds ${SAMPLE_INTERVAL_MS}`,
    "}",
  ].join("; ");
}

function databaseBytes(options: Options): number {
  const value = Number(docker(["exec", options.postgresContainer, "psql", "-U", "ec", "-d", options.databaseName, "-Atqc", "SELECT pg_database_size(current_database())"]));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid database size");
  return value;
}

function residueCounts(options: Options): { sources: number; tables: number; tempDirectories: number } {
  const sources = Number(docker(["exec", options.postgresContainer, "psql", "-U", "ec", "-d", options.databaseName, "-Atqc", "SELECT count(*) FROM public.data_sources WHERE config ? 'largeCsvUpload'"]));
  const tables = Number(docker(["exec", options.postgresContainer, "psql", "-U", "ec", "-d", options.databaseName, "-Atqc", "SELECT count(*) FROM information_schema.tables WHERE table_schema='user_data' AND table_name LIKE 'uf_%'"]));
  const tempDirectories = Number(docker(["exec", options.apiContainer, "sh", "-lc", "find /tmp -mindepth 1 -maxdepth 1 -type d -name 'ec-large-csv-*' | wc -l"]));
  return { sources, tables, tempDirectories };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!process.env.API_ADMIN_PASSWORD?.trim()) throw new Error("API_ADMIN_PASSWORD is required");
  const provenance = verifyIsolation(options);
  const runnerFile = path.join(options.outDir, "runner-result.json");
  await mkdir(options.outDir, { recursive: true });
  const databaseBefore = databaseBytes(options);
  const run = spawnBuffered(process.execPath, [
    TSX_CLI,
    RUNNER,
    "--api-url", options.apiUrl,
    "--rows", String(options.rows),
    "--filename", options.fileName,
    "--out", path.relative(REPO_ROOT, runnerFile).replaceAll(path.sep, "/"),
  ], process.env);

  let apiPeakMemoryBytes = 0;
  let postgresPeakMemoryBytes = 0;
  let apiPeakCpuPercent = 0;
  let postgresPeakCpuPercent = 0;
  let apiSamples = 0;
  let postgresSamples = 0;
  let clientPeakWorkingSetBytes = 0;
  let clientSamples = 0;
  let keepSamplingDocker = true;
  const dockerStatsDone = (async () => {
    do {
      const sampleRun = spawnBuffered("docker", [
        "stats", options.apiContainer, options.postgresContainer,
        "--no-stream", "--format", "{{json .}}",
      ], process.env);
      const sample = await sampleRun.done;
      if (sample.exitStatus !== 0) continue;
      for (const line of sample.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
        try {
          const item = JSON.parse(line) as { Name?: string; MemUsage?: string; CPUPerc?: string };
          const memory = parseByteUnit(String(item.MemUsage ?? "").split("/")[0]);
          const cpu = Number(String(item.CPUPerc ?? "0").replace("%", ""));
          if (item.Name === options.apiContainer) {
            apiPeakMemoryBytes = Math.max(apiPeakMemoryBytes, memory);
            apiPeakCpuPercent = Math.max(apiPeakCpuPercent, Number.isFinite(cpu) ? cpu : 0);
            apiSamples++;
          } else if (item.Name === options.postgresContainer) {
            postgresPeakMemoryBytes = Math.max(postgresPeakMemoryBytes, memory);
            postgresPeakCpuPercent = Math.max(postgresPeakCpuPercent, Number.isFinite(cpu) ? cpu : 0);
            postgresSamples++;
          }
        } catch {
          // Minimum sample and positive-resource gates catch a broken sampler.
        }
      }
    } while (keepSamplingDocker);
  })();
  const clientSampler = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", powershellSamplerScript(run.child.pid!)], {
    cwd: REPO_ROOT, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
  });
  clientSampler.stdout.on("data", lineReader((line) => {
    const value = Number(line);
    if (Number.isSafeInteger(value) && value > 0) {
      clientPeakWorkingSetBytes = Math.max(clientPeakWorkingSetBytes, value);
      clientSamples++;
    }
  }));

  const processResult = await run.done;
  const minimumDockerSamples = 5;
  const sampleDeadline = Date.now() + 15_000;
  while (Math.min(apiSamples, postgresSamples) < minimumDockerSamples && Date.now() < sampleDeadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  keepSamplingDocker = false;
  await dockerStatsDone;
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

  const fragment = {
    schema: "api-million-csv-upload-observation/v2",
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
    workload,
    observation: {
      totalSeconds: processResult.totalSeconds,
      dockerSamples: Math.min(apiSamples, postgresSamples),
      apiSamples,
      postgresSamples,
      clientSamples,
      apiPeakMemoryBytes,
      apiPeakCpuPercent: Number(apiPeakCpuPercent.toFixed(2)),
      postgresPeakMemoryBytes,
      postgresPeakCpuPercent: Number(postgresPeakCpuPercent.toFixed(2)),
      clientPeakWorkingSetBytes,
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
