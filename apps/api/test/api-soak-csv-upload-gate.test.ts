import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  API_SOAK_CSV_THRESHOLDS,
  validateApiSoakCsvEvidence,
} from "../scripts/api-soak-csv-upload-contract.js";

const API_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const TSX_CLI = path.join(API_ROOT, "node_modules/tsx/dist/cli.mjs");
const BASE = 1_800_000_000_000;

function runScript(script: string, args: string[]) {
  return spawnSync(process.execPath, [TSX_CLI, path.join(API_ROOT, "scripts", script), ...args], {
    cwd: API_ROOT,
    encoding: "utf8",
    shell: false,
    env: { ...process.env, API_ADMIN_PASSWORD: "" },
  });
}

function sha(cycle: number): string {
  return cycle.toString(16).padStart(64, "0");
}

function cycle(cycleNumber: number): any {
  const startedAtEpochMs = BASE + ((cycleNumber - 1) * 20_000);
  const sourceId = 100 + cycleNumber;
  const failureProbe = cycleNumber % 10 === 0 ? {
    duplicateConflict: { status: 409, code: "LARGE_CSV_NAME_CONFLICT", seconds: 0.02 },
    failedReplacement: { status: 400, code: "LARGE_CSV_EXPECTED_ROWS_MISMATCH", seconds: 0.2 },
    preservedSourceId: sourceId,
    preservedSha256: sha(cycleNumber),
    preservedRows: 100_000,
    preservedLastRowNo: "100000",
  } : null;
  return {
    cycle: cycleNumber,
    fileName: `api-soak-slot-${((cycleNumber - 1) % 5) + 1}.csv`,
    status: 200,
    startedAtEpochMs,
    finishedAtEpochMs: startedAtEpochMs + 1_000,
    seconds: 1,
    byteCount: 11_980_000 + cycleNumber,
    serverByteCount: 11_980_000 + cycleNumber,
    sha256: sha(cycleNumber),
    serverSha256: sha(cycleNumber),
    sourceId,
    rowCount: 100_000,
    firstRowNo: "1",
    lastRowNo: "100000",
    previewTotal: 100_000,
    failureProbe,
    deleted: true,
    sourceAbsent: true,
  };
}

function resourceSamples(multiplier: number, baseMemory: number): any[] {
  return Array.from({ length: 360 }, (_, index) => ({
    atEpochMs: BASE + (index * 5_000),
    memoryBytes: baseMemory + (index * multiplier),
    cpuPercent: 10,
  }));
}

function passingEvidence(): any {
  const cycles = Array.from({ length: 90 }, (_, index) => cycle(index + 1));
  const provenance = {
    sourceCommit: "a".repeat(40),
    runtimeImageDigest: `sha256:${"b".repeat(64)}`,
  };
  return {
    schema: "api-soak-csv-upload-evidence/v1",
    provenance,
    observationPath: "artifacts/api-soak/observation.json",
    observation: {
      schema: "api-soak-csv-upload-observation/v1",
      provenance: { ...provenance },
      environment: { sampleIntervalMs: 5_000 },
      workload: {
        schema: "api-soak-csv-upload-result/v1",
        boundary: {
          transport: "HTTP chunked raw text/csv",
          targetDurationSeconds: 1_800,
          cycleIntervalSeconds: 20,
          targetCycles: 90,
          rowsPerCycle: 100_000,
          failureEveryCycles: 10,
          rotatingFileSlots: 5,
          ordinaryUploadCovered: false,
          concurrencyCovered: false,
          longDurationCovered: true,
          realDataCovered: false,
          productionSlaCovered: false,
        },
        startedAtEpochMs: BASE,
        finishedAtEpochMs: BASE + 1_800_000,
        actualDurationSeconds: 1_800,
        cycles,
        summary: {
          successfulCycles: 90,
          unexpectedErrors: 0,
          totalRows: 9_000_000,
          totalBytes: cycles.reduce((sum, item) => sum + item.byteCount, 0),
          uniqueHashes: 90,
          rotatingFileNames: 5,
          failureProbeCycles: 9,
          minStartGapMs: 20_000,
          maxStartGapMs: 20_000,
          p50UploadSeconds: 1,
          p95UploadSeconds: 1,
          firstWindowP95Seconds: 1,
          lastWindowP95Seconds: 1,
        },
        cleanup: { completedCycles: 90, sourcesAbsent: true },
      },
      resourceSamples: {
        api: resourceSamples(1_000, 100_000_000),
        postgres: resourceSamples(2_000, 200_000_000),
        client: resourceSamples(500, 150_000_000),
      },
      observation: {
        totalSeconds: 1_802,
        apiSamples: 360,
        postgresSamples: 360,
        clientSamples: 360,
        apiPeakMemoryBytes: 100_359_000,
        postgresPeakMemoryBytes: 200_718_000,
        clientPeakWorkingSetBytes: 150_179_500,
        apiMedianGrowthBytes: 300_000,
        postgresMedianGrowthBytes: 600_000,
        clientMedianGrowthBytes: 150_000,
        databaseGrowthBytes: 10_000_000,
      },
      residue: { sources: 0, tables: 0, tempDirectories: 0 },
    },
    cleanup: { containers: 0, volumes: 0, networks: 0, imageTags: 0, portListeners: 0 },
  };
}

describe("API long-duration CSV soak evidence gate", () => {
  test("accepts a 30-minute zero-error cadence with recurring recovery and bounded resource trends", () => {
    expect(validateApiSoakCsvEvidence(passingEvidence())).toEqual([]);
  });

  test("rejects a short, sparse, repeated-content, or latency-regressing workload", () => {
    const evidence = passingEvidence();
    evidence.observation.workload.actualDurationSeconds = 1_799;
    evidence.observation.workload.finishedAtEpochMs -= 1_000;
    evidence.observation.workload.cycles[1].startedAtEpochMs = evidence.observation.workload.cycles[0].startedAtEpochMs + 10_000;
    evidence.observation.workload.cycles[1].finishedAtEpochMs = evidence.observation.workload.cycles[1].startedAtEpochMs + 1_000;
    evidence.observation.workload.cycles[2].sha256 = evidence.observation.workload.cycles[1].sha256;
    evidence.observation.workload.cycles[2].serverSha256 = evidence.observation.workload.cycles[1].sha256;
    for (const item of evidence.observation.workload.cycles.slice(-10)) item.seconds = 6;

    expect(validateApiSoakCsvEvidence(evidence)).toEqual(expect.arrayContaining([
      "soak duration is below threshold",
      "cycle cadence is outside threshold",
      "every soak cycle must use distinct deterministic content",
      "last-window upload latency regressed beyond threshold",
    ]));
  });

  test("rejects a missing recovery probe, non-zero error budget, resource leak trend, sample gap, or residue", () => {
    const evidence = passingEvidence();
    evidence.observation.workload.cycles[9].failureProbe = null;
    evidence.observation.workload.summary.unexpectedErrors = 1;
    for (const sample of evidence.observation.resourceSamples.api.slice(-60)) {
      sample.memoryBytes += 300 * 1024 ** 2;
    }
    evidence.observation.resourceSamples.api[120].atEpochMs += 8_000;
    evidence.observation.residue.tempDirectories = 1;
    evidence.cleanup.imageTags = 1;

    expect(validateApiSoakCsvEvidence(evidence)).toEqual(expect.arrayContaining([
      "recurring failure recovery coverage is incomplete",
      "soak error budget must remain zero",
      "API median memory growth exceeds threshold",
      "resource sample cadence exceeds threshold",
      "large CSV temporary directory residue remains",
      "isolated image tag remains after cleanup",
    ]));
  });

  test("rejects missing or unbound source and runtime image provenance", () => {
    const evidence = passingEvidence();
    delete evidence.provenance;
    evidence.observation.provenance.sourceCommit = "c".repeat(40);
    evidence.observation.provenance.runtimeImageDigest = `sha256:${"d".repeat(64)}`;
    expect(validateApiSoakCsvEvidence(evidence)).toEqual(expect.arrayContaining([
      "sourceCommit is invalid",
      "runtime image digest is invalid",
      "observation sourceCommit differs from final evidence",
      "observation runtime image digest differs from final evidence",
    ]));
  });

  test("accepts the standalone pnpm argument separator in observer and summary commands", () => {
    const project = "ec-api-soak-parse-only";
    const observer = runScript("api-soak-csv-upload-observe.ts", [
      "--",
      "--api-url", "http://127.0.0.1:26403/api",
      "--duration-seconds", "1",
      "--out", "artifacts/api-soak-csv-upload-20260822",
      "--compose-project", project,
      "--api-container", `${project}-api`,
      "--postgres-container", `${project}-postgres`,
      "--database", "ec_api_soak_parse_only",
      "--source-commit", "a".repeat(40),
    ]);
    expect(observer.status).toBe(1);
    expect(observer.stderr).toContain("API_ADMIN_PASSWORD is required");
    expect(observer.stderr).not.toContain("unexpected argument");

    const summary = runScript("api-soak-csv-upload-summary.ts", ["--", "--cleanup-confirmed"]);
    expect(summary.status).toBe(1);
    expect(summary.stderr).toContain("--observation must stay inside repository");
    expect(summary.stderr).not.toContain("unexpected argument");
  });

  test("keeps soak thresholds independent from burst-concurrency and DB runner gates", () => {
    expect(API_SOAK_CSV_THRESHOLDS).toEqual({
      minimumDurationSeconds: 1_800,
      maximumTotalSeconds: 2_400,
      cycleIntervalSeconds: 20,
      expectedCycles: 90,
      rowsPerCycle: 100_000,
      failureEveryCycles: 10,
      expectedFailureProbeCycles: 9,
      rotatingFileSlots: 5,
      minimumTotalRows: 9_000_000,
      minimumTotalBytes: 1_000_000_000,
      minimumCycleGapMs: 18_000,
      maximumCycleGapMs: 30_000,
      perUploadSeconds: 30,
      p95UploadSeconds: 10,
      latencyTrendMultiplier: 2,
      latencyTrendFloorSeconds: 5,
      sampleIntervalMs: 5_000,
      maximumSampleIntervalMs: 7_500,
      minimumResourceSamples: 300,
      trendWindowSamples: 60,
      apiPeakMemoryBytes: 1024 ** 3,
      postgresPeakMemoryBytes: 2 * 1024 ** 3,
      clientPeakWorkingSetBytes: 512 * 1024 ** 2,
      apiMedianGrowthBytes: 256 * 1024 ** 2,
      postgresMedianGrowthBytes: 512 * 1024 ** 2,
      clientMedianGrowthBytes: 256 * 1024 ** 2,
      databaseGrowthBytes: 256 * 1024 ** 2,
    });
  });

  test("samples exact cgroup counters without depending on Docker stats terminal streaming", () => {
    const observer = readFileSync(path.join(API_ROOT, "scripts/api-soak-csv-upload-observe.ts"), "utf8");
    expect(observer).toContain("cat /sys/fs/cgroup/memory.current");
    expect(observer).toContain("/sys/fs/cgroup/cpu.stat");
    expect(observer).toContain("CGROUP_SAMPLE_TIMEOUT_MS = 4_000");
    expect(observer).not.toContain('"stats", options.apiContainer');
  });
});
