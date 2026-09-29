import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const API_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = path.resolve(API_ROOT, "../..");
const DEFAULT_DURATION_SECONDS = 1_800;
const DEFAULT_INTERVAL_SECONDS = 20;
const DEFAULT_ROWS = 100_000;
const DEFAULT_FAILURE_EVERY = 10;
const DEFAULT_FILE_SLOTS = 5;

type Options = {
  apiUrl: string;
  durationSeconds: number;
  intervalSeconds: number;
  rows: number;
  failureEveryCycles: number;
  fileSlots: number;
  fileNamePrefix: string;
  outFile: string;
  progressFile: string;
};

type StreamState = { byteCount: number; sha256: string | null };

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const [key, inline] = arg.slice(2).split("=", 2);
    const value = inline ?? argv[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    if (inline == null) index++;
    values.set(key, value);
  }
  const apiUrl = values.get("api-url") ?? "";
  const parsedUrl = new URL(apiUrl);
  if (
    parsedUrl.protocol !== "http:"
    || !["127.0.0.1", "localhost"].includes(parsedUrl.hostname)
    || Number(parsedUrl.port) < 10_000
    || Number(parsedUrl.port) > 65_535
    || parsedUrl.pathname.replace(/\/$/, "") !== "/api"
  ) throw new Error("--api-url must use loopback, an isolated high port, and end in /api");
  const durationSeconds = Number(values.get("duration-seconds") ?? DEFAULT_DURATION_SECONDS);
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 2_400) {
    throw new Error("--duration-seconds must be 1..2400");
  }
  const intervalSeconds = Number(values.get("interval-seconds") ?? DEFAULT_INTERVAL_SECONDS);
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 60) {
    throw new Error("--interval-seconds must be 1..60");
  }
  const rows = Number(values.get("rows") ?? DEFAULT_ROWS);
  if (!Number.isSafeInteger(rows) || rows < 1 || rows > DEFAULT_ROWS) throw new Error("--rows must be 1..100000");
  const failureEveryCycles = Number(values.get("failure-every-cycles") ?? DEFAULT_FAILURE_EVERY);
  if (!Number.isSafeInteger(failureEveryCycles) || failureEveryCycles < 1 || failureEveryCycles > 100) {
    throw new Error("--failure-every-cycles must be 1..100");
  }
  const fileSlots = Number(values.get("file-slots") ?? DEFAULT_FILE_SLOTS);
  if (!Number.isSafeInteger(fileSlots) || fileSlots < 1 || fileSlots > 20) throw new Error("--file-slots must be 1..20");
  const fileNamePrefix = values.get("filename-prefix") ?? "api-soak-capacity";
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(fileNamePrefix)) throw new Error("--filename-prefix is invalid");
  const outFile = repoPath(values.get("out") ?? "", "--out");
  const progressFile = repoPath(values.get("progress") ?? "", "--progress");
  if (outFile === progressFile) throw new Error("--out and --progress must differ");
  return {
    apiUrl: apiUrl.replace(/\/$/, ""),
    durationSeconds,
    intervalSeconds,
    rows,
    failureEveryCycles,
    fileSlots,
    fileNamePrefix,
    outFile,
    progressFile,
  };
}

function repoPath(value: string, label: string): string {
  const resolved = path.resolve(REPO_ROOT, value);
  const relative = path.relative(REPO_ROOT, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} must stay inside repository`);
  return resolved;
}

function csvLine(row: number, cycle: number): string {
  const cycleText = String(cycle).padStart(4, "0");
  const day = String((row % 28) + 1).padStart(2, "0");
  const platform = String(row % 12).padStart(2, "0");
  const shop = String(row % 400).padStart(3, "0");
  const sku = String(row % 100_000).padStart(6, "0");
  const amount = `${100 + (row % 10_000)}.${String(row % 100).padStart(2, "0")}`;
  return `${row},ORDC${cycleText}${String(row).padStart(9, "0")},2026-08-${day},platform_${platform},shop_${shop},SKU${sku},${amount},cycle-${cycleText}-note-${String(row).padStart(7, "0")}-abcdefghijklmnopqrstuvwxyz\n`;
}

function deterministicCsv(rows: number, cycle: number): { body: Readable; state: StreamState } {
  const state: StreamState = { byteCount: 0, sha256: null };
  const hash = createHash("sha256");
  const body = Readable.from((async function* () {
    const header = Buffer.from("row_no,order_no,event_date,platform,shop,sku,amount,note\n");
    state.byteCount += header.byteLength;
    hash.update(header);
    yield header;
    const lines: string[] = [];
    for (let row = 1; row <= rows; row++) {
      lines.push(csvLine(row, cycle));
      if (lines.length === 2_000 || row === rows) {
        const chunk = Buffer.from(lines.join(""));
        lines.length = 0;
        state.byteCount += chunk.byteLength;
        hash.update(chunk);
        yield chunk;
      }
    }
    state.sha256 = hash.digest("hex");
  })());
  return { body, state };
}

async function jsonResponse(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response ${response.status}: ${text.slice(0, 200)}`);
  }
}

async function login(apiUrl: string, password: string): Promise<string> {
  const response = await fetch(`${apiUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password }),
  });
  const payload = await jsonResponse(response);
  if (response.status !== 200 || payload?.ok !== true || !payload?.data?.token) {
    throw new Error(`admin login failed with status ${response.status}`);
  }
  return String(payload.data.token);
}

async function upload(options: Options, token: string, cycle: number, fileName: string): Promise<any> {
  const generated = deterministicCsv(options.rows, cycle);
  const query = new URLSearchParams({
    filename: fileName,
    name: `API soak cycle ${cycle}`,
    expectedRows: String(options.rows),
  });
  const startedAtEpochMs = Date.now();
  const started = performance.now();
  const response = await fetch(`${options.apiUrl}/files/upload-large-csv?${query}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/csv; charset=utf-8" },
    body: generated.body as any,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const payload = await jsonResponse(response);
  const finishedAtEpochMs = Date.now();
  if (!generated.state.sha256) throw new Error(`client stream did not complete at cycle ${cycle}`);
  if (response.status !== 200 || payload?.ok !== true) {
    throw new Error(`cycle ${cycle} upload failed: status=${response.status} code=${payload?.code ?? "unknown"}`);
  }
  const data = payload.data;
  if (
    Number(data?.rowCount) !== options.rows
    || Number(data?.byteCount) !== generated.state.byteCount
    || data?.sha256 !== generated.state.sha256
  ) throw new Error(`cycle ${cycle} server row/byte/hash mismatch`);
  return {
    cycle,
    fileName,
    status: response.status,
    startedAtEpochMs,
    finishedAtEpochMs,
    seconds: Number(((performance.now() - started) / 1000).toFixed(3)),
    byteCount: generated.state.byteCount,
    serverByteCount: Number(data.byteCount),
    sha256: generated.state.sha256,
    serverSha256: String(data.sha256),
    sourceId: Number(data.sourceId),
    tableName: String(data.tableName),
    rowCount: Number(data.rowCount),
  };
}

async function preview(apiUrl: string, token: string, sourceId: number, offset: number): Promise<any> {
  const response = await fetch(`${apiUrl}/files/${sourceId}/preview?limit=1&offset=${offset}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const payload = await jsonResponse(response);
  if (response.status !== 200 || payload?.ok !== true) throw new Error(`preview failed for source ${sourceId}`);
  return payload.data;
}

async function listSources(apiUrl: string, token: string): Promise<any[]> {
  const response = await fetch(`${apiUrl}/files`, { headers: { authorization: `Bearer ${token}` } });
  const payload = await jsonResponse(response);
  if (response.status !== 200 || payload?.ok !== true || !Array.isArray(payload.data)) throw new Error("file list failed");
  return payload.data;
}

async function currentSource(apiUrl: string, token: string, fileName: string): Promise<any> {
  const matches = (await listSources(apiUrl, token)).filter((source) => source?.config?.originalFileName === fileName);
  if (matches.length !== 1) throw new Error(`expected one source for ${fileName}, got ${matches.length}`);
  return matches[0];
}

async function sourceAbsent(apiUrl: string, token: string, fileName: string): Promise<boolean> {
  return !(await listSources(apiUrl, token)).some((source) => source?.config?.originalFileName === fileName);
}

async function timedProbe(url: string, init: RequestInit): Promise<any> {
  const started = performance.now();
  const response = await fetch(url, init);
  const payload = await jsonResponse(response);
  return { status: response.status, code: String(payload?.code ?? ""), seconds: Number(((performance.now() - started) / 1000).toFixed(3)) };
}

async function duplicateProbe(options: Options, token: string, fileName: string): Promise<any> {
  const query = new URLSearchParams({ filename: fileName, name: "soak duplicate probe", expectedRows: "1" });
  return timedProbe(`${options.apiUrl}/files/upload-large-csv?${query}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/csv" },
    body: "row_no,value\n1,duplicate\n",
  });
}

async function replacementProbe(options: Options, token: string, fileName: string): Promise<any> {
  const query = new URLSearchParams({
    filename: fileName,
    name: "soak replacement failure probe",
    replaceExisting: "true",
    expectedRows: "1",
  });
  return timedProbe(`${options.apiUrl}/files/upload-large-csv?${query}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/csv" },
    body: "row_no,value\n1,valid\n2,valid-two\n",
  });
}

async function failureProbe(options: Options, token: string, item: any): Promise<any> {
  const duplicateConflict = await duplicateProbe(options, token, item.fileName);
  if (duplicateConflict.status !== 409 || duplicateConflict.code !== "LARGE_CSV_NAME_CONFLICT") {
    throw new Error(`cycle ${item.cycle} duplicate probe did not fail closed`);
  }
  const failedReplacement = await replacementProbe(options, token, item.fileName);
  if (failedReplacement.status !== 400 || failedReplacement.code !== "LARGE_CSV_EXPECTED_ROWS_MISMATCH") {
    throw new Error(`cycle ${item.cycle} replacement probe did not roll back`);
  }
  const source = await currentSource(options.apiUrl, token, item.fileName);
  const last = await preview(options.apiUrl, token, item.sourceId, options.rows - 1);
  if (
    Number(source.id) !== item.sourceId
    || source.config?.largeCsvUpload?.sha256 !== item.sha256
    || Number(last.total) !== options.rows
    || String(last.rows?.[0]?.row_no) !== String(options.rows)
  ) throw new Error(`cycle ${item.cycle} failure probes changed the committed source`);
  return {
    duplicateConflict,
    failedReplacement,
    preservedSourceId: Number(source.id),
    preservedSha256: String(source.config.largeCsvUpload.sha256),
    preservedRows: Number(last.total),
    preservedLastRowNo: String(last.rows[0].row_no),
  };
}

async function deleteSource(apiUrl: string, token: string, sourceId: number): Promise<void> {
  const response = await fetch(`${apiUrl}/files/${sourceId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  const payload = await jsonResponse(response);
  if (response.status !== 200 || payload?.ok !== true) throw new Error(`source ${sourceId} cleanup failed`);
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

async function waitUntil(epochMs: number): Promise<void> {
  while (Date.now() < epochMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(1_000, epochMs - Date.now())));
  }
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

async function writeProgress(options: Options, startedAtEpochMs: number, cycles: any[], state: string): Promise<void> {
  const last = cycles.at(-1);
  await atomicJson(options.progressFile, {
    schema: "api-soak-csv-upload-progress/v1",
    updatedAt: new Date().toISOString(),
    state,
    targetDurationSeconds: options.durationSeconds,
    targetCycles: Math.floor(options.durationSeconds / options.intervalSeconds),
    completedCycles: cycles.length,
    elapsedSeconds: Number(((Date.now() - startedAtEpochMs) / 1000).toFixed(3)),
    lastCycleSeconds: last?.seconds ?? null,
    failureProbeCycles: cycles.filter((item) => item.failureProbe != null).length,
    unexpectedErrors: state === "failed" ? 1 : 0,
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const password = process.env.API_ADMIN_PASSWORD?.trim();
  if (!password) throw new Error("API_ADMIN_PASSWORD is required");
  const token = await login(options.apiUrl, password);
  const targetCycles = Math.floor(options.durationSeconds / options.intervalSeconds);
  const startedAtEpochMs = Date.now();
  const cycles: any[] = [];
  let activeSourceId: number | null = null;
  let activeFileName: string | null = null;
  await writeProgress(options, startedAtEpochMs, cycles, "running");

  try {
    for (let cycleNumber = 1; cycleNumber <= targetCycles; cycleNumber++) {
      await waitUntil(startedAtEpochMs + ((cycleNumber - 1) * options.intervalSeconds * 1_000));
      const slot = ((cycleNumber - 1) % options.fileSlots) + 1;
      const fileName = `${options.fileNamePrefix}-slot-${slot}.csv`;
      activeFileName = fileName;
      const item = await upload(options, token, cycleNumber, fileName);
      activeSourceId = item.sourceId;
      const first = await preview(options.apiUrl, token, item.sourceId, 0);
      const last = await preview(options.apiUrl, token, item.sourceId, options.rows - 1);
      if (
        Number(first.total) !== options.rows
        || Number(last.total) !== options.rows
        || String(first.rows?.[0]?.row_no) !== "1"
        || String(last.rows?.[0]?.row_no) !== String(options.rows)
      ) throw new Error(`cycle ${cycleNumber} preview integrity mismatch`);
      item.firstRowNo = String(first.rows[0].row_no);
      item.lastRowNo = String(last.rows[0].row_no);
      item.previewTotal = Number(last.total);
      item.failureProbe = cycleNumber % options.failureEveryCycles === 0
        ? await failureProbe(options, token, item)
        : null;
      await deleteSource(options.apiUrl, token, item.sourceId);
      activeSourceId = null;
      item.deleted = true;
      item.sourceAbsent = await sourceAbsent(options.apiUrl, token, fileName);
      if (!item.sourceAbsent) throw new Error(`cycle ${cycleNumber} source remains after cleanup`);
      cycles.push(item);
      await writeProgress(options, startedAtEpochMs, cycles, "running");
    }
    await waitUntil(startedAtEpochMs + (options.durationSeconds * 1_000));
  } catch (error) {
    if (activeSourceId != null) {
      try {
        await deleteSource(options.apiUrl, token, activeSourceId);
      } catch {
        // The isolated project cleanup remains the final containment boundary.
      }
    }
    await writeProgress(options, startedAtEpochMs, cycles, "failed");
    await atomicJson(options.outFile, {
      schema: "api-soak-csv-upload-failure/v1",
      generatedAt: new Date().toISOString(),
      completedCycles: cycles.length,
      activeFileName,
      code: "API_SOAK_WORKLOAD_FAILED",
      message: "API 长期 soak 运行失败",
    });
    throw error;
  }

  const finishedAtEpochMs = Date.now();
  const latencies = cycles.map((item) => Number(item.seconds));
  const startGaps = cycles.slice(1).map((item, index) => Number(item.startedAtEpochMs) - Number(cycles[index].startedAtEpochMs));
  const latencyWindow = options.failureEveryCycles;
  const result = {
    schema: "api-soak-csv-upload-result/v1",
    generatedAt: new Date().toISOString(),
    boundary: {
      transport: "HTTP chunked raw text/csv",
      targetDurationSeconds: options.durationSeconds,
      cycleIntervalSeconds: options.intervalSeconds,
      targetCycles,
      rowsPerCycle: options.rows,
      failureEveryCycles: options.failureEveryCycles,
      rotatingFileSlots: options.fileSlots,
      ordinaryUploadCovered: false,
      concurrencyCovered: false,
      longDurationCovered: true,
      realDataCovered: false,
      productionSlaCovered: false,
    },
    startedAtEpochMs,
    finishedAtEpochMs,
    actualDurationSeconds: Number(((finishedAtEpochMs - startedAtEpochMs) / 1000).toFixed(3)),
    cycles,
    summary: {
      successfulCycles: cycles.length,
      unexpectedErrors: 0,
      totalRows: cycles.reduce((sum, item) => sum + Number(item.rowCount), 0),
      totalBytes: cycles.reduce((sum, item) => sum + Number(item.byteCount), 0),
      uniqueHashes: new Set(cycles.map((item) => item.sha256)).size,
      rotatingFileNames: new Set(cycles.map((item) => item.fileName)).size,
      failureProbeCycles: cycles.filter((item) => item.failureProbe != null).length,
      minStartGapMs: Math.min(...startGaps),
      maxStartGapMs: Math.max(...startGaps),
      p50UploadSeconds: percentile(latencies, 0.5),
      p95UploadSeconds: percentile(latencies, 0.95),
      firstWindowP95Seconds: percentile(latencies.slice(0, latencyWindow), 0.95),
      lastWindowP95Seconds: percentile(latencies.slice(-latencyWindow), 0.95),
    },
    cleanup: { completedCycles: cycles.length, sourcesAbsent: true },
  };
  await atomicJson(options.outFile, result);
  await writeProgress(options, startedAtEpochMs, cycles, "completed");
  const written = JSON.parse(await readFile(options.outFile, "utf8"));
  if (written.schema !== result.schema) throw new Error("result write verification failed");
  console.log(`result=${path.relative(REPO_ROOT, options.outFile).replaceAll(path.sep, "/")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
