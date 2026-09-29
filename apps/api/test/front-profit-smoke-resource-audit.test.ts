import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const apiRoot = resolve(repoRoot, "apps/api");
const auditScriptPath = resolve(apiRoot, "scripts/front-profit-smoke-resource-audit.ts");
const createdPaths: string[] = [];

const runAudit = (args: string[]) => spawnSync(
  process.execPath,
  ["./node_modules/tsx/dist/cli.mjs", auditScriptPath, ...args],
  { cwd: apiRoot, encoding: "utf8" },
);

function track(path: string) {
  if (!createdPaths.includes(path)) createdPaths.push(path);
}

function makeResidualDir(root: "front-profit-acceptance" | "front-profit-production-release" | "apps/api/artifacts", name: string) {
  const target = join(repoRoot, root, name);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "marker.txt"), "synthetic smoke residue\n", "utf8");
  track(target);
  return target;
}

function makeCapacityFixture(relativePath: string) {
  const target = join(repoRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "{}\n", "utf8");
  track(dirname(target));
  return relativePath;
}

afterEach(() => {
  for (const target of createdPaths.reverse()) {
    rmSync(target, { force: true, recursive: true });
  }
  createdPaths.length = 0;
});

describe("front-profit smoke resource audit", () => {
  test("audits ignored front-profit evidence without requiring capacity artifacts by default", () => {
    const result = runAudit([]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("FRONT_PROFIT_SMOKE_RESOURCE_AUDIT_OK");
    expect(result.stdout).toContain("deployment=not_started");
  });

  test("fails strict mode when a residual smoke directory remains", () => {
    makeResidualDir("front-profit-acceptance", `readiness-smoke-vitest-${process.pid}`);

    const result = runAudit(["--strict"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FRONT_PROFIT_SMOKE_RESOURCE_AUDIT_FAILED");
    expect(result.stderr).toContain("residual smoke/vitest directories remain");
    expect(result.stderr).toContain("readiness-smoke-vitest");
  });

  test("prunes only recognized residual smoke directories when explicitly requested", () => {
    const target = makeResidualDir("front-profit-production-release", `production-release-smoke-vitest-${process.pid}`);

    const result = runAudit(["--strict", "--prune-smoke"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("FRONT_PROFIT_SMOKE_RESOURCE_AUDIT_OK");
    expect(result.stdout).toContain("prunedSmokeDirs=");
    expect(existsSync(target)).toBe(false);
  });

  test("can require a concrete capacity matrix evidence file", () => {
    const missing = `front-profit-production-release/vitest-${process.pid}-missing/capacity-matrix-result.json`;

    const failed = runAudit(["--require-capacity-matrix", "--capacity-matrix-result", missing]);

    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("capacity matrix result is missing");

    const present = makeCapacityFixture(`front-profit-production-release/vitest-${process.pid}-capacity/capacity-matrix-result.json`);
    const passed = runAudit(["--require-capacity-matrix", "--capacity-matrix-result", present]);

    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain("capacityMatrix=present");
  });
});
