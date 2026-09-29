import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = path.resolve(API_ROOT, "../..");
const TSX_CLI = path.join(API_ROOT, "node_modules/tsx/dist/cli.mjs");
const PREFLIGHT_SCRIPT = path.join(API_ROOT, "scripts/front-profit-acceptance-preflight.ts");
const READINESS_SCRIPT = path.join(API_ROOT, "scripts/front-profit-acceptance-readiness.ts");
const RESULT_SCRIPT = path.join(API_ROOT, "scripts/front-profit-acceptance-result.ts");
const RELEASE_SCRIPT = path.join(API_ROOT, "scripts/front-profit-production-release-gate.ts");

type Options = {
  manifestPath: string;
  resultPath: string;
  releasePath: string;
  runFileGates: boolean;
  strict: boolean;
  allowSynthetic: boolean;
};

type GateResult = {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
};

function resolveFromRepo(value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(REPO_ROOT, value);
}

function repoRelative(value: string): string {
  const resolved = resolveFromRepo(value);
  const relative = path.relative(REPO_ROOT, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return relative.replaceAll(path.sep, "/");
  }
  return resolved;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    manifestPath: "front-profit-acceptance/manifest.json",
    resultPath: "front-profit-acceptance/result.json",
    releasePath: "front-profit-production-release/release.json",
    runFileGates: false,
    strict: false,
    allowSynthetic: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") {
      const next = argv[index + 1];
      if (!next) throw new Error("--manifest requires a path");
      options.manifestPath = next;
      index += 1;
    } else if (arg === "--result") {
      const next = argv[index + 1];
      if (!next) throw new Error("--result requires a path");
      options.resultPath = next;
      index += 1;
    } else if (arg === "--release") {
      const next = argv[index + 1];
      if (!next) throw new Error("--release requires a path");
      options.releasePath = next;
      index += 1;
    } else if (arg === "--run-file-gates") {
      options.runFileGates = true;
    } else if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--allow-synthetic") {
      options.allowSynthetic = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: pnpm --filter @ec/api run front-profit:acceptance-status -- [options]",
        "",
        "Options:",
        "  --manifest <path>       default: front-profit-acceptance/manifest.json",
        "  --result <path>         default: front-profit-acceptance/result.json",
        "  --release <path>        default: front-profit-production-release/release.json",
        "  --run-file-gates        also run readiness, which checks sanitized CSV headers and row counts",
        "  --strict                exit non-zero unless the final real gate or explicit synthetic rehearsal gate has passed",
        "  --allow-synthetic       allow local synthetic smoke manifests to pass gate checks",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return {
    ...options,
    manifestPath: resolveFromRepo(options.manifestPath),
    resultPath: resolveFromRepo(options.resultPath),
    releasePath: resolveFromRepo(options.releasePath),
  };
}

function readMode(filePath: string): string | null {
  const payload = JSON.parse(readFileSync(filePath, "utf8")) as { mode?: unknown };
  return typeof payload.mode === "string" ? payload.mode : null;
}

function runScript(scriptPath: string, args: string[]): GateResult {
  const result = spawnSync(process.execPath, [TSX_CLI, scriptPath, ...args], {
    cwd: API_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function firstFailureLine(result: GateResult): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("FRONT_PROFIT_"));
  return lines[0] ?? `gate exited with status ${result.status ?? "unknown"}`;
}

function emit(input: {
  stage: string;
  next: string;
  options: Options;
  fileGates: "not_requested" | "passed" | "failed";
  gate?: string;
  gateResult?: GateResult;
}) {
  console.log("FRONT_PROFIT_ACCEPTANCE_STATUS");
  console.log(`stage=${input.stage}`);
  console.log(`manifest=${repoRelative(input.options.manifestPath)}`);
  console.log(`result=${repoRelative(input.options.resultPath)}`);
  console.log(`release=${repoRelative(input.options.releasePath)}`);
  console.log(`fileGates=${input.fileGates}`);
  console.log(`syntheticRehearsal=${input.options.allowSynthetic ? "allowed" : "blocked"}`);
  if (input.gate) console.log(`gate=${input.gate}`);
  if (input.gateResult && !input.gateResult.ok) {
    console.log(`gateExitStatus=${input.gateResult.status ?? "unknown"}`);
    console.log(`failure=${firstFailureLine(input.gateResult)}`);
  }
  console.log("realSamples=not_read");
  console.log("deployment=not_started");
  console.log(`next=${input.next}`);
  const strictPassed = input.stage === "production_release_gate_passed" ||
    (input.options.allowSynthetic && input.stage === "synthetic_rehearsal_gate_passed");
  if (input.options.strict && !strictPassed) {
    process.exitCode = 1;
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(options.manifestPath)) {
    emit({
      stage: "not_initialized",
      next: "pnpm --filter @ec/api run front-profit:acceptance-init",
      options,
      fileGates: "not_requested",
    });
    return;
  }

  let manifestMode: string | null;
  try {
    manifestMode = readMode(options.manifestPath);
  } catch (error) {
    emit({
      stage: "manifest_invalid_json",
      next: "fix manifest JSON, then run front-profit:acceptance-preflight",
      options,
      fileGates: "not_requested",
      gate: "manifest_json",
      gateResult: { ok: false, status: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) },
    });
    return;
  }
  if (manifestMode !== "authorized") {
    emit({
      stage: "manifest_template_or_unauthorized",
      next: "fill authorized manifest.json, then run front-profit:acceptance-preflight",
      options,
      fileGates: "not_requested",
    });
    return;
  }

  const preflight = runScript(PREFLIGHT_SCRIPT, [
    "--manifest",
    options.manifestPath,
    ...(options.allowSynthetic ? ["--allow-synthetic"] : []),
  ]);
  if (!preflight.ok) {
    emit({
      stage: "manifest_preflight_failed",
      next: "fix manifest authorization, inventory, sanitization, and git-ignore issues",
      options,
      fileGates: "not_requested",
      gate: "acceptance_preflight",
      gateResult: preflight,
    });
    return;
  }

  let fileGates: "not_requested" | "passed" | "failed" = "not_requested";
  if (options.runFileGates) {
    const readiness = runScript(READINESS_SCRIPT, [
      "--manifest",
      options.manifestPath,
      ...(options.allowSynthetic ? ["--allow-synthetic"] : []),
    ]);
    if (!readiness.ok) {
      emit({
        stage: "file_readiness_failed",
        next: "fix sanitized CSV headers/row counts or repository boundary issues",
        options,
        fileGates: "failed",
        gate: "acceptance_readiness",
        gateResult: readiness,
      });
      return;
    }
    fileGates = "passed";
  }

  if (!existsSync(options.resultPath)) {
    emit({
      stage: "dry_run_result_missing",
      next: "run isolated dry run, fill result.json, then run front-profit:acceptance-result",
      options,
      fileGates,
    });
    return;
  }

  let resultMode: string | null;
  try {
    resultMode = readMode(options.resultPath);
  } catch (error) {
    emit({
      stage: "dry_run_result_invalid_json",
      next: "fix result JSON, then run front-profit:acceptance-result",
      options,
      fileGates,
      gate: "result_json",
      gateResult: { ok: false, status: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) },
    });
    return;
  }
  if (resultMode !== "dry_run") {
    emit({
      stage: "dry_run_result_template_or_missing",
      next: "fill dry-run result.json after isolated dry run",
      options,
      fileGates,
    });
    return;
  }

  const resultGate = runScript(RESULT_SCRIPT, [
    "--result",
    options.resultPath,
    ...(options.allowSynthetic ? ["--allow-synthetic"] : []),
  ]);
  if (!resultGate.ok) {
    emit({
      stage: "dry_run_result_gate_failed",
      next: "fix dry-run DQ/recon/publish/rollback/cleanup evidence",
      options,
      fileGates,
      gate: "acceptance_result",
      gateResult: resultGate,
    });
    return;
  }

  if (!existsSync(options.releasePath)) {
    emit({
      stage: "production_release_manifest_missing",
      next: "fill production release manifest, then run front-profit:production-release-gate",
      options,
      fileGates,
    });
    return;
  }

  let releaseMode: string | null;
  try {
    releaseMode = readMode(options.releasePath);
  } catch (error) {
    emit({
      stage: "production_release_manifest_invalid_json",
      next: "fix release JSON, then run front-profit:production-release-gate",
      options,
      fileGates,
      gate: "release_json",
      gateResult: { ok: false, status: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) },
    });
    return;
  }
  if (releaseMode !== "authorized") {
    emit({
      stage: "production_release_template_or_unauthorized",
      next: "fill authorized production release manifest",
      options,
      fileGates,
    });
    return;
  }

  const releaseGate = runScript(RELEASE_SCRIPT, [
    "--release",
    options.releasePath,
    ...(options.allowSynthetic ? ["--allow-synthetic"] : []),
  ]);
  if (!releaseGate.ok) {
    emit({
      stage: "production_release_gate_failed",
      next: "fix production release authorization, rollout scope, artifacts, and technical gates",
      options,
      fileGates,
      gate: "production_release_gate",
      gateResult: releaseGate,
    });
    return;
  }

  emit({
    stage: options.allowSynthetic ? "synthetic_rehearsal_gate_passed" : "production_release_gate_passed",
    next: options.allowSynthetic
      ? "replace synthetic rehearsal evidence with authorized real manifests, then rerun without --allow-synthetic"
      : "wait for explicit user deployment command; this status check does not deploy",
    options,
    fileGates,
  });
}

try {
  main();
} catch (error) {
  console.error("FRONT_PROFIT_ACCEPTANCE_STATUS_FAILED");
  console.error(`- ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
