import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import {
  buildSyntheticDbRunnerFailureResult,
  writeSyntheticDbRunnerResultAtomically,
} from "../scripts/front-profit-synthetic-db-runner.js";

const tempRoots: string[] = [];
const apiRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tsxCli = join(apiRoot, "node_modules/tsx/dist/cli.mjs");
const runnerScript = join(apiRoot, "scripts/front-profit-synthetic-db-runner.ts");

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("front-profit synthetic DB runner failure result", () => {
  test("builds a stable machine-readable failure contract without raw exception detail", () => {
    const sensitiveError = new Error([
      "password=top-secret",
      "postgres://ec_app:top-secret@127.0.0.1:5432/ec_data",
      "SELECT * FROM user_data.uf_8299",
      "C:\\private\\front-profit\\source.csv",
    ].join(" "));

    const result = buildSyntheticDbRunnerFailureResult({
      generatedAt: "2026-08-21T12:00:00.000Z",
      period: "2026-08",
      rows: 250_000,
      seed: 20260821,
      phase: "draft_l1_l3_l4",
      timings: [{ phase: "draft_l1_l3_l4", seconds: 12.345 }],
      keptFixtures: true,
      error: sensitiveError,
    });

    expect(result).toEqual({
      schema: "front-profit-synthetic-db-runner-failure/v1",
      generatedAt: "2026-08-21T12:00:00.000Z",
      status: "failed",
      period: "2026-08",
      seed: 20260821,
      requestedSalesRows: 250_000,
      database: {
        urlSource: "TEST_DATABASE_URL",
        realSamplesUsed: false,
        deploymentStarted: false,
      },
      failure: {
        code: "FRONT_PROFIT_SYNTHETIC_DB_RUNNER_FAILED",
        message: "前台利润合成数据库运行失败",
        phase: "draft_l1_l3_l4",
      },
      timings: [{ phase: "draft_l1_l3_l4", seconds: 12.345 }],
      keptFixtures: true,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(sensitiveError.message);
    expect(serialized).not.toContain("top-secret");
    expect(serialized).not.toContain("postgres://");
    expect(serialized).not.toContain("user_data");
    expect(serialized).not.toContain("source.csv");
  });

  test("publishes the result with an atomic temp-file replacement", async () => {
    const root = mkdtempSync(join(tmpdir(), "front-profit-runner-result-"));
    tempRoots.push(root);
    const resultPath = join(root, "nested", "synthetic-db-runner-result.json");
    const result = buildSyntheticDbRunnerFailureResult({
      generatedAt: "2026-08-21T12:00:00.000Z",
      period: "2026-08",
      rows: 1_000,
      seed: 20260821,
      phase: "uf_load",
      timings: [{ phase: "fixture_generate", seconds: 0.25 }],
      keptFixtures: false,
      error: new Error("socket closed"),
    });

    await writeSyntheticDbRunnerResultAtomically(resultPath, result);

    expect(existsSync(resultPath)).toBe(true);
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual(result);
    expect(readdirSync(join(root, "nested"))).toEqual(["synthetic-db-runner-result.json"]);
  });

  test("emits a failure result path and non-zero exit from the real CLI entrypoint", () => {
    const root = mkdtempSync(join(tmpdir(), "front-profit-runner-cli-"));
    tempRoots.push(root);
    const testPassword = "runner-test-password";
    const run = spawnSync(process.execPath, [
      tsxCli,
      runnerScript,
      "--period",
      "2026-08",
      "--rows",
      "1",
      "--seed",
      "20260821",
      "--out",
      root,
    ], {
      cwd: apiRoot,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        TEST_DATABASE_URL: `postgres://ec_app:${testPassword}@127.0.0.1:1/ec_data`,
      },
    });

    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain("result=");
    expect(run.stderr).toContain("FRONT_PROFIT_SYNTHETIC_DB_RUNNER_FAILED");
    expect(`${run.stdout}\n${run.stderr}`).not.toContain(testPassword);

    const runDirectories = readdirSync(root);
    expect(runDirectories).toHaveLength(1);
    const resultPath = join(root, runDirectories[0]!, "synthetic-db-runner-result.json");
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    expect(result).toMatchObject({
      schema: "front-profit-synthetic-db-runner-failure/v1",
      status: "failed",
      requestedSalesRows: 1,
      failure: {
        code: "FRONT_PROFIT_SYNTHETIC_DB_RUNNER_FAILED",
        message: "前台利润合成数据库运行失败",
        phase: "migration",
      },
      database: {
        urlSource: "TEST_DATABASE_URL",
        realSamplesUsed: false,
        deploymentStarted: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain(testPassword);
  }, 25_000);
});
