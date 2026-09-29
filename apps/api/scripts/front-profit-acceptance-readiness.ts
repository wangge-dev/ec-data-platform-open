import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = path.resolve(API_ROOT, "../..");
const TSX_CLI = path.join(API_ROOT, "node_modules/tsx/dist/cli.mjs");
const PREFLIGHT_SCRIPT = path.join(API_ROOT, "scripts/front-profit-acceptance-preflight.ts");
const REPO_BOUNDARY_SCRIPT = path.join(REPO_ROOT, "scripts/check-repository-boundaries.mjs");

function parseArgs(argv: string[]) {
  let manifestPath: string | null = null;
  let allowSynthetic = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") {
      const next = argv[index + 1];
      if (!next) throw new Error("--manifest requires a path");
      manifestPath = next;
      index += 1;
    } else if (arg === "--allow-synthetic") {
      allowSynthetic = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: pnpm --filter @ec/api run front-profit:acceptance-readiness -- --manifest <manifest.json> [--allow-synthetic]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!manifestPath) throw new Error("--manifest is required");
  return { manifestPath, allowSynthetic };
}

function repoRelative(value: string): string {
  const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(REPO_ROOT, value);
  return path.relative(REPO_ROOT, absolute).replaceAll(path.sep, "/");
}

function printCaptured(label: string, value: string) {
  const trimmed = value.trimEnd();
  if (!trimmed) return;
  console.error(`${label}:`);
  console.error(trimmed);
}

function runGate(name: string, command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
  if (result.status !== 0) {
    console.error("FRONT_PROFIT_ACCEPTANCE_READINESS_FAILED");
    console.error(`gate=${name}`);
    console.error(`exitStatus=${result.status ?? "unknown"}`);
    printCaptured("stdout", result.stdout ?? "");
    printCaptured("stderr", result.stderr ?? "");
    process.exit(1);
  }
  return result;
}

const { manifestPath, allowSynthetic } = parseArgs(process.argv.slice(2));

if (!existsSync(TSX_CLI)) {
  throw new Error(`tsx CLI not found: ${TSX_CLI}`);
}

runGate("preflight_check_files", process.execPath, [
  TSX_CLI,
  PREFLIGHT_SCRIPT,
  "--manifest",
  manifestPath,
  "--check-files",
  ...(allowSynthetic ? ["--allow-synthetic"] : []),
], API_ROOT);

const repoCheck = runGate("repo_check", process.execPath, [
  REPO_BOUNDARY_SCRIPT,
  "--mode=private",
], REPO_ROOT);

console.log("FRONT_PROFIT_ACCEPTANCE_READINESS_OK");
console.log(`manifest=${repoRelative(manifestPath)}`);
console.log("gates=preflight_check_files,repo_check");
if ((repoCheck.stderr ?? "").trim()) console.log("repoCheckWarnings=present");
