import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const DEFAULT_CAPACITY_MATRIX_RESULT = "apps/api/artifacts/front-profit-capacity-matrix-db-gate-20260811/capacity-matrix-result.json";
const IGNORED_ROOTS = [
  "front-profit-acceptance",
  "front-profit-production-release",
  "apps/api/artifacts",
] as const;

const RESIDUAL_DIR_PATTERNS = [
  /^readiness-smoke-/,
  /^production-release-smoke-/,
  /^local-release-precheck-/,
  /^vitest-/,
  /^vitest-release-/,
  /^front-profit-synthetic$/,
  /^front-profit-.*-smoke-/,
  /^front-profit-.*-tmp-/,
];

type Options = {
  strict: boolean;
  pruneSmoke: boolean;
  requireCapacityMatrix: boolean;
  capacityMatrixResult: string;
};

type ResidualDir = {
  root: string;
  name: string;
  relativePath: string;
  absolutePath: string;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    strict: false,
    pruneSmoke: false,
    requireCapacityMatrix: false,
    capacityMatrixResult: DEFAULT_CAPACITY_MATRIX_RESULT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--prune-smoke") {
      options.pruneSmoke = true;
    } else if (arg === "--require-capacity-matrix") {
      options.requireCapacityMatrix = true;
    } else if (arg === "--capacity-matrix-result") {
      const next = argv[index + 1];
      if (!next) throw new Error("--capacity-matrix-result requires a path");
      options.capacityMatrixResult = next;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: pnpm --filter @ec/api run front-profit:smoke-resource-audit -- [options]",
        "",
        "Options:",
        "  --strict                   fail when residual smoke/vitest directories remain",
        "  --prune-smoke              remove residual smoke/vitest directories before checking",
        "  --require-capacity-matrix  require the synthetic capacity matrix result to exist",
        "  --capacity-matrix-result <path>",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function resolveFromRepo(value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(REPO_ROOT, value);
}

function repoRelative(value: string): string {
  const relative = path.relative(REPO_ROOT, resolveFromRepo(value));
  return relative.replaceAll(path.sep, "/");
}

function assertInsideRepo(value: string): string {
  const resolved = resolveFromRepo(value);
  const relative = path.relative(REPO_ROOT, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path is outside the repository: ${value}`);
  }
  return resolved;
}

function isIgnoredByGit(relativePath: string): boolean {
  const result = spawnSync("git", ["check-ignore", "--quiet", "--", relativePath], {
    cwd: REPO_ROOT,
    stdio: "ignore",
    shell: false,
  });
  return result.status === 0;
}

function isIgnoredRoot(relativeRoot: string): boolean {
  return isIgnoredByGit(relativeRoot) || isIgnoredByGit(`${relativeRoot}/__front_profit_audit_probe__`);
}

function addIssue(issues: string[], message: string) {
  issues.push(`- ${message}`);
}

function isResidualDirName(name: string): boolean {
  return RESIDUAL_DIR_PATTERNS.some((pattern) => pattern.test(name));
}

function findResidualDirs(): ResidualDir[] {
  const residuals: ResidualDir[] = [];
  for (const root of IGNORED_ROOTS) {
    const rootPath = resolveFromRepo(root);
    if (!existsSync(rootPath)) continue;
    for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!isResidualDirName(entry.name)) continue;
      const absolutePath = path.join(rootPath, entry.name);
      residuals.push({
        root,
        name: entry.name,
        relativePath: repoRelative(absolutePath),
        absolutePath,
      });
    }
  }
  return residuals;
}

function pruneResidualDirs(residuals: ResidualDir[]): string[] {
  const pruned: string[] = [];
  for (const residual of residuals) {
    const absolutePath = assertInsideRepo(residual.absolutePath);
    if (!isResidualDirName(path.basename(absolutePath))) {
      throw new Error(`refusing to prune non-smoke directory: ${residual.relativePath}`);
    }
    rmSync(absolutePath, { force: true, recursive: true });
    pruned.push(residual.relativePath);
  }
  return pruned;
}

function directoryFileCount(relativeRoot: string): number {
  const rootPath = resolveFromRepo(relativeRoot);
  if (!existsSync(rootPath)) return 0;
  let count = 0;
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      if (entry.isFile()) count += 1;
    }
  }
  return count;
}

function capacityMatrixStatus(resultPath: string): { relativePath: string; status: "present" | "missing"; bytes: number } {
  const absolutePath = resolveFromRepo(resultPath);
  if (!existsSync(absolutePath)) {
    return { relativePath: repoRelative(absolutePath), status: "missing", bytes: 0 };
  }
  return {
    relativePath: repoRelative(absolutePath),
    status: "present",
    bytes: statSync(absolutePath).size,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const issues: string[] = [];
  const ignoredRoots = IGNORED_ROOTS.map((root) => ({
    root,
    exists: existsSync(resolveFromRepo(root)),
    ignored: isIgnoredRoot(root),
    files: directoryFileCount(root),
  }));

  for (const root of ignoredRoots) {
    if (root.exists && !root.ignored) {
      addIssue(issues, `${root.root} exists but is not git-ignored`);
    }
  }

  let residuals = findResidualDirs();
  let pruned: string[] = [];
  if (options.pruneSmoke && residuals.length > 0) {
    pruned = pruneResidualDirs(residuals);
    residuals = findResidualDirs();
  }
  if (options.strict && residuals.length > 0) {
    addIssue(issues, `residual smoke/vitest directories remain: ${residuals.map((item) => item.relativePath).join(", ")}`);
  }

  const capacity = capacityMatrixStatus(options.capacityMatrixResult);
  if (options.requireCapacityMatrix && capacity.status !== "present") {
    addIssue(issues, `capacity matrix result is missing: ${capacity.relativePath}`);
  }

  if (issues.length > 0) {
    console.error("FRONT_PROFIT_SMOKE_RESOURCE_AUDIT_FAILED");
    for (const issue of issues) console.error(issue);
    process.exit(1);
  }

  console.log("FRONT_PROFIT_SMOKE_RESOURCE_AUDIT_OK");
  for (const root of ignoredRoots) {
    console.log(`ignoredRoot=${root.root},exists=${root.exists},ignored=${root.ignored},files=${root.files}`);
  }
  console.log(`capacityMatrix=${capacity.status},path=${capacity.relativePath},bytes=${capacity.bytes}`);
  console.log(`residualSmokeDirs=${residuals.length}`);
  if (pruned.length > 0) console.log(`prunedSmokeDirs=${pruned.join(",")}`);
  console.log("deployment=not_started");
}

try {
  main();
} catch (error) {
  console.error("FRONT_PROFIT_SMOKE_RESOURCE_AUDIT_FAILED");
  console.error(`- ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
