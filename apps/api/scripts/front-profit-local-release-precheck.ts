import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = path.resolve(API_ROOT, "../..");
const TSX_CLI = path.join(API_ROOT, "node_modules/tsx/dist/cli.mjs");
const READINESS_SMOKE_SCRIPT = path.join(API_ROOT, "scripts/front-profit-acceptance-readiness-smoke.ts");
const RELEASE_SMOKE_SCRIPT = path.join(API_ROOT, "scripts/front-profit-production-release-smoke.ts");
const SMOKE_RESOURCE_AUDIT_SCRIPT = path.join(API_ROOT, "scripts/front-profit-smoke-resource-audit.ts");
const REPO_BOUNDARY_SCRIPT = path.join(REPO_ROOT, "scripts/check-repository-boundaries.mjs");

type Gate = {
  name: string;
  command: string;
  args: string[];
  cwd: string;
};

type Options = {
  requireCapacityMatrix: boolean;
  pruneSmoke: boolean;
  capacityMatrixResult?: string;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    requireCapacityMatrix: false,
    pruneSmoke: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: pnpm --filter @ec/api run front-profit:local-release-precheck -- [options]",
        "",
        "Options:",
        "  --require-capacity-matrix  require the synthetic capacity matrix result during smoke resource audit",
        "  --capacity-matrix-result <path>",
        "  --prune-smoke              remove whitelisted residual smoke/vitest directories during audit",
      ].join("\n"));
      process.exit(0);
    }
    if (arg === "--require-capacity-matrix") {
      options.requireCapacityMatrix = true;
      continue;
    }
    if (arg === "--capacity-matrix-result") {
      const next = argv[index + 1];
      if (!next) throw new Error("--capacity-matrix-result requires a path");
      options.capacityMatrixResult = next;
      index += 1;
      continue;
    }
    if (arg === "--prune-smoke") {
      options.pruneSmoke = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function printCaptured(label: string, value: string) {
  const trimmed = value.trimEnd();
  if (!trimmed) return;
  console.error(`${label}:`);
  console.error(trimmed);
}

function runGate(gate: Gate) {
  const result = spawnSync(gate.command, gate.args, {
    cwd: gate.cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
  if (result.status !== 0) {
    console.error("FRONT_PROFIT_LOCAL_RELEASE_PRECHECK_FAILED");
    console.error(`gate=${gate.name}`);
    console.error(`exitStatus=${result.status ?? "unknown"}`);
    printCaptured("stdout", result.stdout ?? "");
    printCaptured("stderr", result.stderr ?? "");
    process.exit(1);
  }
  return result;
}

const options = parseArgs(process.argv.slice(2));

if (!existsSync(TSX_CLI)) {
  throw new Error(`tsx CLI not found: ${TSX_CLI}`);
}

const auditArgs = [TSX_CLI, SMOKE_RESOURCE_AUDIT_SCRIPT, "--strict"];
if (options.requireCapacityMatrix) auditArgs.push("--require-capacity-matrix");
if (options.capacityMatrixResult) auditArgs.push("--capacity-matrix-result", options.capacityMatrixResult);
if (options.pruneSmoke) auditArgs.push("--prune-smoke");

const gates: Gate[] = [
  {
    name: "acceptance_readiness_smoke",
    command: process.execPath,
    args: [TSX_CLI, READINESS_SMOKE_SCRIPT],
    cwd: API_ROOT,
  },
  {
    name: "production_release_smoke",
    command: process.execPath,
    args: [TSX_CLI, RELEASE_SMOKE_SCRIPT],
    cwd: API_ROOT,
  },
  {
    name: "smoke_resource_audit",
    command: process.execPath,
    args: auditArgs,
    cwd: API_ROOT,
  },
  {
    name: "repo_check",
    command: process.execPath,
    args: [REPO_BOUNDARY_SCRIPT, "--mode=private"],
    cwd: REPO_ROOT,
  },
];

for (const gate of gates) {
  runGate(gate);
}

console.log("FRONT_PROFIT_LOCAL_RELEASE_PRECHECK_OK");
console.log("gates=acceptance_readiness_smoke,production_release_smoke,smoke_resource_audit,repo_check");
console.log(`capacityMatrixRequired=${options.requireCapacityMatrix}`);
console.log("syntheticRehearsal=allowed");
console.log("realSamples=not_used");
console.log("deployment=not_started");
