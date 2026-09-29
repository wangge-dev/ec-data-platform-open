import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  API_CONCURRENT_CSV_THRESHOLDS,
  validateApiConcurrentCsvEvidence,
} from "../scripts/api-concurrent-csv-upload-contract.js";

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

function upload(slot: number): any {
  return {
    slot,
    fileName: `api-concurrent-${slot}.csv`,
    status: 200,
    startedAtEpochMs: 1_000 + slot,
    finishedAtEpochMs: 11_000 + slot,
    seconds: 10,
    byteCount: 55_500_000 + slot,
    serverByteCount: 55_500_000 + slot,
    sha256: String(slot).repeat(64),
    serverSha256: String(slot).repeat(64),
    sourceId: slot,
    tableName: `uf_${slot}`,
    rowCount: 500_000,
    exceededOrdinary50MbLimit: true,
    firstRowNo: "1",
    lastRowNo: "500000",
    previewTotal: 500_000,
  };
}

function passingEvidence(): any {
  const provenance = {
    sourceCommit: "a".repeat(40),
    runtimeImageDigest: `sha256:${"b".repeat(64)}`,
  };
  const uploads = [upload(1), upload(2), upload(3)];
  return {
    schema: "api-concurrent-csv-upload-evidence/v1",
    provenance,
    observationPath: "artifacts/api-concurrent/observation.json",
    observation: {
      schema: "api-concurrent-csv-upload-observation/v1",
      provenance: { ...provenance },
      environment: { sampleIntervalMs: 1_000 },
      workload: {
        schema: "api-concurrent-csv-upload-result/v1",
        boundary: {
          transport: "HTTP chunked raw text/csv",
          successConcurrency: 3,
          rowsPerSuccessUpload: 500_000,
          successTotalRows: 1_500_000,
          mixedFreshUploadRows: 100_000,
          ordinaryUploadCovered: false,
          concurrencyCovered: true,
          longDurationCovered: false,
          realDataCovered: false,
          productionSlaCovered: false,
        },
        successWave: {
          seconds: 12,
          overlapMs: 9_998,
          uploads,
        },
        mixedWave: {
          seconds: 3,
          overlapMs: 25,
          failedReplacement: {
            targetSourceId: 1,
            status: 400,
            code: "LARGE_CSV_EXPECTED_ROWS_MISMATCH",
            startedAtEpochMs: 20_000,
            finishedAtEpochMs: 21_000,
            seconds: 1,
            preservedSourceId: 1,
            preservedSha256: uploads[0].sha256,
            preservedRows: 500_000,
            preservedLastRowNo: "500000",
          },
          duplicateConflict: {
            targetSourceId: 2,
            status: 409,
            code: "LARGE_CSV_NAME_CONFLICT",
            startedAtEpochMs: 20_001,
            finishedAtEpochMs: 20_026,
            seconds: 0.025,
            preservedSourceId: 2,
            preservedSha256: uploads[1].sha256,
            preservedRows: 500_000,
            preservedLastRowNo: "500000",
          },
          freshUpload: {
            ...upload(4),
            fileName: "api-concurrent-fresh.csv",
            startedAtEpochMs: 20_000,
            finishedAtEpochMs: 23_000,
            seconds: 3,
            byteCount: 11_000_000,
            serverByteCount: 11_000_000,
            sha256: "4".repeat(64),
            serverSha256: "4".repeat(64),
            rowCount: 100_000,
            exceededOrdinary50MbLimit: false,
            lastRowNo: "100000",
            previewTotal: 100_000,
          },
        },
        cleanup: {
          deletedSourceIds: [1, 2, 3, 4],
          expectedDeletedSources: 4,
          sourceNamesAbsent: true,
        },
      },
      observation: {
        totalSeconds: 20,
        dockerSamples: 15,
        clientSamples: 15,
        apiPeakMemoryBytes: 500_000_000,
        postgresPeakMemoryBytes: 800_000_000,
        clientPeakWorkingSetBytes: 400_000_000,
        databaseGrowthBytes: 100_000_000,
      },
      residue: { sources: 0, tables: 0, tempDirectories: 0 },
    },
    cleanup: { containers: 0, volumes: 0, networks: 0, imageTags: 0, portListeners: 0 },
  };
}

describe("API concurrent CSV evidence gate", () => {
  test("accepts exact three-way overlap, integrity, mixed-failure isolation, resources, and cleanup", () => {
    expect(validateApiConcurrentCsvEvidence(passingEvidence())).toEqual([]);
  });

  test("rejects serialized, partial, small, or extrapolated success uploads", () => {
    const evidence = passingEvidence();
    evidence.observation.workload.boundary.successConcurrency = 2;
    evidence.observation.workload.boundary.longDurationCovered = true;
    evidence.observation.workload.successWave.uploads[0].finishedAtEpochMs = 2_000;
    evidence.observation.workload.successWave.overlapMs = API_CONCURRENT_CSV_THRESHOLDS.minimumSuccessOverlapMs - 3;
    evidence.observation.workload.successWave.uploads[0].byteCount = 50 * 1024 * 1024;
    evidence.observation.workload.successWave.uploads[1].rowCount = 499_999;
    evidence.observation.workload.successWave.uploads[2].sha256 = evidence.observation.workload.successWave.uploads[1].sha256;

    expect(validateApiConcurrentCsvEvidence(evidence)).toEqual(expect.arrayContaining([
      "success concurrency must equal 3",
      "evidence must not claim long-duration coverage",
      "success upload overlap is below threshold",
      "every success fixture must exceed the ordinary 50MB limit",
      "every success upload must preserve exact row identity",
      "success upload hashes must be distinct",
    ]));
  });

  test("rejects mixed-wave contamination, missing overlap, resource excess, or residue", () => {
    const evidence = passingEvidence();
    evidence.observation.workload.mixedWave.overlapMs = 0;
    evidence.observation.workload.mixedWave.duplicateConflict.finishedAtEpochMs = 20_001;
    evidence.observation.workload.mixedWave.failedReplacement.status = 500;
    evidence.observation.workload.mixedWave.duplicateConflict.preservedSha256 = "f".repeat(64);
    evidence.observation.workload.mixedWave.freshUpload.previewTotal = 99_999;
    evidence.observation.observation.postgresPeakMemoryBytes = API_CONCURRENT_CSV_THRESHOLDS.postgresPeakMemoryBytes + 1;
    evidence.observation.residue.tables = 1;
    evidence.cleanup.volumes = 1;
    evidence.cleanup.imageTags = 1;

    expect(validateApiConcurrentCsvEvidence(evidence)).toEqual(expect.arrayContaining([
      "mixed operation overlap is missing",
      "failed replacement evidence is invalid",
      "mixed failures did not preserve their target uploads",
      "fresh mixed-wave upload integrity is invalid",
      "PostgreSQL peak memory exceeds threshold",
      "large CSV table residue remains",
      "isolated volumes remain after cleanup",
      "isolated image tag remains after cleanup",
    ]));
  });

  test("rejects missing or unbound source and runtime image provenance", () => {
    const evidence = passingEvidence();
    delete evidence.provenance;
    evidence.observation.provenance.sourceCommit = "c".repeat(40);
    evidence.observation.provenance.runtimeImageDigest = `sha256:${"d".repeat(64)}`;
    expect(validateApiConcurrentCsvEvidence(evidence)).toEqual(expect.arrayContaining([
      "sourceCommit is invalid",
      "runtime image digest is invalid",
      "observation sourceCommit differs from final evidence",
      "observation runtime image digest differs from final evidence",
    ]));
  });

  test("accepts the standalone pnpm argument separator in observer and summary commands", () => {
    const project = "ec-api-concurrent-parse-only";
    const observer = runScript("api-concurrent-csv-upload-observe.ts", [
      "--",
      "--api-url", "http://127.0.0.1:26402/api",
      "--rows", "1",
      "--filename-prefix", "parse-only",
      "--out", "artifacts/api-concurrent-csv-upload-20260822",
      "--compose-project", project,
      "--api-container", `${project}-api`,
      "--postgres-container", `${project}-postgres`,
      "--database", "ec_api_concurrent_parse_only",
      "--source-commit", "a".repeat(40),
    ]);
    expect(observer.status).toBe(1);
    expect(observer.stderr).toContain("API_ADMIN_PASSWORD is required");
    expect(observer.stderr).not.toContain("unexpected argument");

    const summary = runScript("api-concurrent-csv-upload-summary.ts", ["--", "--cleanup-confirmed"]);
    expect(summary.status).toBe(1);
    expect(summary.stderr).toContain("--observation must stay inside repository");
    expect(summary.stderr).not.toContain("unexpected argument");
  });

  test("keeps concurrent thresholds independent from single-request and DB runner gates", () => {
    expect(API_CONCURRENT_CSV_THRESHOLDS).toEqual({
      totalSeconds: 300,
      successWaveSeconds: 180,
      perSuccessUploadSeconds: 180,
      mixedWaveSeconds: 60,
      successConcurrency: 3,
      rowsPerSuccessUpload: 500_000,
      mixedFreshUploadRows: 100_000,
      minimumSuccessOverlapMs: 1_000,
      minimumMixedOverlapMs: 1,
      apiPeakMemoryBytes: 2 * 1024 ** 3,
      postgresPeakMemoryBytes: 4 * 1024 ** 3,
      clientPeakWorkingSetBytes: 1024 ** 3,
      databaseGrowthBytes: 512 * 1024 ** 2,
      minimumSamples: 5,
      maximumSampleIntervalMs: 2_000,
    });
  });
});
