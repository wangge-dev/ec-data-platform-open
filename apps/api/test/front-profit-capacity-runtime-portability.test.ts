import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const apiRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(apiRoot, "../..");
const tsxCli = resolve(apiRoot, "node_modules/tsx/dist/cli.mjs");
const matrixScript = resolve(apiRoot, "scripts/front-profit-run-capacity-matrix.ts");
const readApi = (path: string) => readFileSync(resolve(apiRoot, path), "utf8");

describe("front-profit capacity runtime portability", () => {
  test("generates a source-only matrix without pnpm on PATH or npm lifecycle state", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ec-front-profit-capacity-portability-"));
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "path" || key.toLowerCase() === "npm_execpath") delete env[key];
    }
    env.PATH = "";

    try {
      const result = spawnSync(
        process.execPath,
        [
          tsxCli,
          matrixScript,
          "--rows",
          "1000",
          "--skip-synthetic-db-runner",
          "--out",
          sandbox,
        ],
        {
          cwd: repoRoot,
          env,
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      expect(result.status, output).toBe(0);
      expect(output).toContain("FRONT_PROFIT_CAPACITY_MATRIX_OK");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("launches fixture and DB runner scripts through the local Node/tsx runtime", () => {
    const dbRunner = readApi("scripts/front-profit-synthetic-db-runner.ts");
    const matrixRunner = readApi("scripts/front-profit-run-capacity-matrix.ts");

    for (const source of [dbRunner, matrixRunner]) {
      expect(source).toContain('path.join(API_ROOT, "node_modules/tsx/dist/cli.mjs")');
      expect(source).toContain("spawnSync(process.execPath");
      expect(source).not.toContain("process.env.npm_execpath");
      expect(source).not.toContain('"pnpm.cmd"');
    }
    expect(dbRunner).toContain('path.join(API_ROOT, "scripts/front-profit-generate-synthetic-fixtures.ts")');
    expect(matrixRunner).toContain('path.join(API_ROOT, "scripts/front-profit-synthetic-db-runner.ts")');
  });
});
