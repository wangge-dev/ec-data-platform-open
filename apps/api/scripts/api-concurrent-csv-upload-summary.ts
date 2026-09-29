import { spawnSync } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  API_CONCURRENT_CSV_THRESHOLDS,
  validateApiConcurrentCsvEvidence,
} from "./api-concurrent-csv-upload-contract.js";

const API_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = path.resolve(API_ROOT, "../..");

function values(argv: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--cleanup-confirmed") {
      result.set("cleanup-confirmed", "true");
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const [key, inline] = arg.slice(2).split("=", 2);
    const value = inline ?? argv[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    if (inline == null) index++;
    result.set(key, value);
  }
  return result;
}

function ignoredRepoPath(value: string, label: string): string {
  const resolved = path.resolve(REPO_ROOT, value);
  const relative = path.relative(REPO_ROOT, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} must stay inside repository`);
  const ignored = spawnSync("git", ["check-ignore", "--quiet", "--", relative.replaceAll(path.sep, "/")], {
    cwd: REPO_ROOT,
    stdio: "ignore",
    shell: false,
  });
  if (ignored.status !== 0) throw new Error(`${label} must be git-ignored`);
  return resolved;
}

function dockerCount(args: string[]): number {
  const run = spawnSync("docker", args, { cwd: REPO_ROOT, encoding: "utf8", shell: false });
  if (run.status !== 0) throw new Error(`docker cleanup probe failed: ${(run.stderr || run.stdout).trim()}`);
  return run.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
}

function imageTagCount(imageTag: string): number {
  const run = spawnSync("docker", ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: false,
  });
  if (run.status !== 0) throw new Error(`docker image cleanup probe failed: ${(run.stderr || run.stdout).trim()}`);
  return run.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line === imageTag).length;
}

async function portListeners(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(1);
      else reject(error);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolve(0));
    });
  });
}

async function main(): Promise<void> {
  const args = values(process.argv.slice(2));
  if (args.get("cleanup-confirmed") !== "true") throw new Error("--cleanup-confirmed is required after exact isolated-resource cleanup");
  const observationFile = ignoredRepoPath(args.get("observation") ?? "", "--observation");
  const outFile = ignoredRepoPath(args.get("out") ?? "", "--out");
  const composeProject = args.get("compose-project") ?? "";
  if (!/^ec-api-concurrent-[a-z0-9-]+$/.test(composeProject)) {
    throw new Error("--compose-project must use ec-api-concurrent-* prefix");
  }
  const imageTag = args.get("image-tag") ?? "";
  if (!/^ec-data-platform-api:api-concurrent-[a-f0-9]{7,40}$/.test(imageTag)) {
    throw new Error("--image-tag must be the unique api-concurrent source tag");
  }
  const apiPort = Number(args.get("api-port"));
  if (!Number.isSafeInteger(apiPort) || apiPort < 10_000 || apiPort > 65_535) {
    throw new Error("--api-port must be an isolated high port");
  }
  const postgresPort = Number(args.get("postgres-port"));
  if (!Number.isSafeInteger(postgresPort) || postgresPort < 10_000 || postgresPort > 65_535 || postgresPort === apiPort) {
    throw new Error("--postgres-port must be a distinct isolated high port");
  }
  const observation = JSON.parse(await readFile(observationFile, "utf8"));
  if (observation?.environment?.composeProject !== composeProject) throw new Error("observation compose project mismatch");
  if (Number(new URL(observation.environment.apiUrl).port) !== apiPort) throw new Error("observation API port mismatch");

  const apiPortListeners = await portListeners(apiPort);
  const postgresPortListeners = await portListeners(postgresPort);
  const cleanup = {
    containers: dockerCount(["ps", "-a", "--filter", `label=com.docker.compose.project=${composeProject}`, "--format", "{{.ID}}"]),
    volumes: dockerCount(["volume", "ls", "--filter", `label=com.docker.compose.project=${composeProject}`, "--format", "{{.Name}}"]),
    networks: dockerCount(["network", "ls", "--filter", `label=com.docker.compose.project=${composeProject}`, "--format", "{{.Name}}"]),
    imageTags: imageTagCount(imageTag),
    apiPortListeners,
    postgresPortListeners,
    portListeners: apiPortListeners + postgresPortListeners,
  };
  if (Object.values(cleanup).some((count) => count !== 0)) throw new Error(`isolated cleanup is incomplete: ${JSON.stringify(cleanup)}`);
  const evidence = {
    schema: "api-concurrent-csv-upload-evidence/v1",
    generatedAt: new Date().toISOString(),
    provenance: observation.provenance,
    thresholds: API_CONCURRENT_CSV_THRESHOLDS,
    observationPath: path.relative(REPO_ROOT, observationFile).replaceAll(path.sep, "/"),
    observation,
    cleanup,
  };
  const temporary = `${outFile}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await rename(temporary, outFile);
  const issues = validateApiConcurrentCsvEvidence(evidence);
  console.log(`evidence=${path.relative(REPO_ROOT, outFile).replaceAll(path.sep, "/")}`);
  if (issues.length) {
    issues.forEach((issue) => console.error(`FAIL ${issue}`));
    process.exit(1);
  }
  console.log("PASS API concurrent CSV upload evidence");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
