import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  API_MILLION_CSV_THRESHOLDS,
  validateApiMillionCsvEvidence,
} from "../scripts/api-million-csv-upload-contract.js";

const API_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const TSX_CLI = path.join(API_ROOT, "node_modules/tsx/dist/cli.mjs");

function runScript(script: string, args: string[]) {
  return spawnSync(process.execPath, [TSX_CLI, path.join(API_ROOT, "scripts", script), ...args], {
    cwd: API_ROOT,
    encoding: "utf8",
    shell: false,
    env: { ...process.env, API_ADMIN_PASSWORD: "" },
  });
}

function passingEvidence(): any {
  const provenance = {
    sourceCommit: "a".repeat(40),
    runtimeImageDigest: `sha256:${"b".repeat(64)}`,
  };
  return {
    schema: "api-million-csv-upload-evidence/v2",
    provenance,
    observationPath: "artifacts/api-million/observation.json",
    observation: {
      schema: "api-million-csv-upload-observation/v2",
      provenance: { ...provenance },
      environment: { sampleIntervalMs: 1_000 },
      workload: {
        schema: "api-million-csv-upload-result/v1",
        boundary: {
          transport: "HTTP chunked raw text/csv",
          rows: 1_000_000,
          ordinaryUploadCovered: false,
          concurrencyCovered: false,
          longDurationCovered: false,
          realDataCovered: false,
        },
        upload: {
          seconds: 100,
          byteCount: 100_000_000,
          sha256: "a".repeat(64),
          rowCount: 1_000_000,
          exceededOrdinary50MbLimit: true,
          firstRowNo: "1",
          lastRowNo: "1000000",
          previewTotal: 1_000_000,
        },
        repeatConflict: { status: 409, code: "LARGE_CSV_NAME_CONFLICT", seconds: 1, preservedSha256: "a".repeat(64) },
        failedReplacementRecovery: {
          status: 400,
          code: "LARGE_CSV_EXPECTED_ROWS_MISMATCH",
          seconds: 2,
          preservedSha256: "a".repeat(64),
          preservedRows: 1_000_000,
          preservedLastRowNo: "1000000",
        },
        cleanup: { deleted: true, sourceAbsent: true },
      },
      observation: {
        totalSeconds: 110,
        dockerSamples: 40,
        clientSamples: 40,
        apiPeakMemoryBytes: 300_000_000,
        postgresPeakMemoryBytes: 500_000_000,
        clientPeakWorkingSetBytes: 200_000_000,
        databaseGrowthBytes: 100_000_000,
      },
      residue: { sources: 0, tables: 0, tempDirectories: 0 },
    },
    cleanup: { containers: 0, volumes: 0, networks: 0, portListeners: 0 },
  };
}

describe("API million-row CSV evidence gate", () => {
  test("accepts exact HTTP, integrity, repeat, rollback, resource, and cleanup proof", () => {
    expect(validateApiMillionCsvEvidence(passingEvidence())).toEqual([]);
  });

  test("rejects an extrapolated, partial, or over-threshold claim", () => {
    const evidence = passingEvidence();
    evidence.observation.workload.boundary.rows = 999_999;
    evidence.observation.workload.boundary.concurrencyCovered = true;
    evidence.observation.workload.upload.sha256 = "b".repeat(64);
    evidence.observation.observation.apiPeakMemoryBytes = API_MILLION_CSV_THRESHOLDS.apiPeakMemoryBytes + 1;
    evidence.cleanup.containers = 1;

    const issues = validateApiMillionCsvEvidence(evidence);
    expect(issues).toContain("workload must contain exactly 1000000 rows");
    expect(issues).toContain("evidence must not claim concurrency coverage");
    expect(issues).toContain("repeat/recovery hashes must equal upload hash");
    expect(issues).toContain("API peak memory exceeds threshold");
    expect(issues).toContain("isolated containers remain after cleanup");
  });

  test("rejects missing, malformed, or unbound source and runtime image provenance", () => {
    const legacy = passingEvidence();
    legacy.schema = "api-million-csv-upload-evidence/v1";
    legacy.observation.schema = "api-million-csv-upload-observation/v1";
    delete legacy.provenance;
    delete legacy.observation.provenance;
    expect(validateApiMillionCsvEvidence(legacy)).toEqual(expect.arrayContaining([
      "evidence schema is invalid",
      "observation schema is invalid",
      "sourceCommit is invalid",
      "runtime image digest is invalid",
    ]));

    const mismatch = passingEvidence();
    mismatch.observation.provenance.sourceCommit = "c".repeat(40);
    mismatch.observation.provenance.runtimeImageDigest = `sha256:${"d".repeat(64)}`;
    expect(validateApiMillionCsvEvidence(mismatch)).toEqual(expect.arrayContaining([
      "observation sourceCommit differs from final evidence",
      "observation runtime image digest differs from final evidence",
    ]));
  });

  test("accepts the standalone pnpm argument separator in observer and summary commands", () => {
    const project = "ec-api-million-parse-only";
    const observer = runScript("api-million-csv-upload-observe.ts", [
      "--",
      "--api-url", "http://127.0.0.1:26401/api",
      "--rows", "1",
      "--filename", "parse-only.csv",
      "--out", "artifacts/api-million-csv-upload-provenance-20260822",
      "--compose-project", project,
      "--api-container", `${project}-api`,
      "--postgres-container", `${project}-postgres`,
      "--database", "ec_api_million_parse_only",
      "--source-commit", "a".repeat(40),
    ]);
    expect(observer.status).toBe(1);
    expect(observer.stderr).toContain("API_ADMIN_PASSWORD is required");
    expect(observer.stderr).not.toContain("unexpected argument");

    const summary = runScript("api-million-csv-upload-summary.ts", ["--", "--cleanup-confirmed"]);
    expect(summary.status).toBe(1);
    expect(summary.stderr).toContain("--observation must stay inside repository");
    expect(summary.stderr).not.toContain("unexpected argument");
  });

  test("keeps architecture-budget thresholds independent from the DB runner gate", () => {
    expect(API_MILLION_CSV_THRESHOLDS).toEqual({
      totalSeconds: 300,
      uploadSeconds: 240,
      repeatConflictSeconds: 10,
      failedReplacementSeconds: 30,
      apiPeakMemoryBytes: 1024 ** 3,
      postgresPeakMemoryBytes: 2 * 1024 ** 3,
      clientPeakWorkingSetBytes: 512 * 1024 ** 2,
      databaseGrowthBytes: 512 * 1024 ** 2,
      minimumSamples: 5,
      maximumSampleIntervalMs: 2_000,
    });
  });
});
