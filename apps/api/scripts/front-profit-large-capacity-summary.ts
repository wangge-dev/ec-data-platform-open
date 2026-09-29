import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LARGE_CAPACITY_ROWS, LARGE_CAPACITY_THRESHOLDS } from "./front-profit-large-capacity-contract.js";

const API_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = path.resolve(API_ROOT, "../..");

type Options = {
  fragmentPaths: string[];
  outPath: string;
  period: string;
  seed: number;
  composeProject: string;
  hostPort: number;
  cleanupConfirmed: boolean;
};

function resolveRepo(value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(REPO_ROOT, value);
}

function parseArgs(argv: string[]): Options {
  const fragmentPaths: string[] = [];
  let outPath = "";
  let period = "2026-08";
  let seed = 20260810;
  let composeProject = "";
  let hostPort = 0;
  let cleanupConfirmed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cleanup-confirmed") {
      cleanupConfirmed = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    index += 1;
    if (arg === "--fragment") fragmentPaths.push(resolveRepo(value));
    else if (arg === "--out") outPath = resolveRepo(value);
    else if (arg === "--period") period = value;
    else if (arg === "--seed") seed = Number(value);
    else if (arg === "--compose-project") composeProject = value;
    else if (arg === "--host-port") hostPort = Number(value);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (fragmentPaths.length !== 4) throw new Error("exactly four --fragment paths are required");
  if (!outPath) throw new Error("--out is required");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error("--period must use YYYY-MM");
  if (!Number.isSafeInteger(seed) || seed <= 0) throw new Error("--seed must be a positive integer");
  if (!/^ec-fp-large-capacity-[a-z0-9-]+$/.test(composeProject)) throw new Error("--compose-project must use the isolated prefix");
  if (!Number.isSafeInteger(hostPort) || hostPort < 10_000 || hostPort > 65_535) throw new Error("--host-port must be an isolated high port");
  if (!cleanupConfirmed) throw new Error("--cleanup-confirmed is required");
  for (const filePath of [...fragmentPaths, outPath]) {
    const relative = path.relative(REPO_ROOT, filePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("all evidence paths must stay inside the repository");
    const ignored = spawnSync("git", ["check-ignore", "--quiet", "--", relative.replaceAll(path.sep, "/")], {
      cwd: REPO_ROOT,
      stdio: "ignore",
      shell: false,
    });
    if (ignored.status !== 0) throw new Error(`evidence path must be git-ignored: ${relative}`);
  }
  return { fragmentPaths, outPath, period, seed, composeProject, hostPort, cleanupConfirmed };
}

function dockerResourceCount(kind: "container" | "volume" | "network", project: string): number {
  const args = kind === "container"
    ? ["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}"]
    : [kind, "ls", "--filter", `label=com.docker.compose.project=${project}`, "--format", kind === "volume" ? "{{.Name}}" : "{{.ID}}"];
  const result = spawnSync("docker", args, { cwd: REPO_ROOT, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(`could not audit isolated ${kind} cleanup`);
  return result.stdout.split(/\r?\n/).filter(Boolean).length;
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function loadFragment(filePath: string): Promise<any> {
  if (!existsSync(filePath)) throw new Error(`fragment not found: ${filePath}`);
  const fragment = JSON.parse(await readFile(filePath, "utf8"));
  if (fragment.schema !== "front-profit-large-capacity-observation-fragment/v1") throw new Error(`unexpected fragment schema: ${filePath}`);
  if (!LARGE_CAPACITY_ROWS.includes(fragment.salesRows)) throw new Error(`unexpected fragment rows: ${fragment.salesRows}`);
  if (fragment.mode !== "clean_repeat" && fragment.mode !== "failure_recovery") throw new Error(`unexpected fragment mode: ${fragment.mode}`);
  return fragment;
}

async function gitHead(): Promise<string> {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error("could not resolve source commit");
  return result.stdout.trim();
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fragments = await Promise.all(options.fragmentPaths.map(loadFragment));
  const tiers = LARGE_CAPACITY_ROWS.map((rows) => {
    const clean = fragments.filter((fragment) => fragment.salesRows === rows && fragment.mode === "clean_repeat");
    const recovery = fragments.filter((fragment) => fragment.salesRows === rows && fragment.mode === "failure_recovery");
    if (clean.length !== 1 || recovery.length !== 1) throw new Error(`rows ${rows} requires one clean and one failure-recovery fragment`);
    if (!clean[0].successfulRun || !recovery[0].successfulRun || !recovery[0].failureRecovery) throw new Error(`rows ${rows} fragment is incomplete`);
    return {
      salesRows: rows,
      successfulRuns: [clean[0].successfulRun, recovery[0].successfulRun],
      failureRecovery: recovery[0].failureRecovery,
    };
  });

  const cleanup = {
    composeProject: options.composeProject,
    isolatedContainers: dockerResourceCount("container", options.composeProject),
    isolatedVolumes: dockerResourceCount("volume", options.composeProject),
    isolatedNetworks: dockerResourceCount("network", options.composeProject),
    portListeners: await portIsFree(options.hostPort) ? 0 : 1,
  };
  if (Object.values(cleanup).some((value) => typeof value === "number" && value !== 0)) throw new Error("isolated cleanup is not complete");

  const evidence = {
    schema: "front-profit-large-capacity-evidence/v1",
    generatedAt: new Date().toISOString(),
    sourceCommit: await gitHead(),
    period: options.period,
    seed: options.seed,
    thresholds: {
      "500000": LARGE_CAPACITY_THRESHOLDS[500_000],
      "1000000": LARGE_CAPACITY_THRESHOLDS[1_000_000],
    },
    tiers,
    cleanup,
    boundary: {
      deterministicSyntheticOnly: true,
      realSamplesUsed: false,
      deploymentStarted: false,
      productionReleaseAuthorized: false,
      productionSlaProven: false,
    },
  };
  await writeJsonAtomically(options.outPath, evidence);
  console.log("FRONT_PROFIT_LARGE_CAPACITY_SUMMARY_OK");
  console.log(`result=${path.relative(REPO_ROOT, options.outPath).replaceAll(path.sep, "/")}`);
}

main().catch((error) => {
  console.error("FRONT_PROFIT_LARGE_CAPACITY_SUMMARY_FAILED");
  console.error(`- ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
