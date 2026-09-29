import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const API_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = path.resolve(API_ROOT, "../..");
const SUCCESS_CONCURRENCY = 3;
const DEFAULT_ROWS = 500_000;
const FRESH_ROWS = 100_000;
const GLOBAL_BODY_LIMIT_BYTES = 50 * 1024 * 1024;

type Options = {
  apiUrl: string;
  rows: number;
  fileNamePrefix: string;
  outFile: string;
};

type StreamState = {
  byteCount: number;
  sha256: string | null;
};

type TimedResponse = {
  status: number;
  payload: any;
  startedAtEpochMs: number;
  finishedAtEpochMs: number;
  seconds: number;
};

type RawUpload = TimedResponse & {
  fileName: string;
  rows: number;
  slot: number;
  byteCount: number;
  sha256: string;
};

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: api-concurrent-csv-upload-runner.ts --api-url http://127.0.0.1:<high-port>/api --out <ignored-json> [--rows 500000] [--filename-prefix api-concurrent]");
      process.exit(0);
    }
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const [key, inline] = arg.slice(2).split("=", 2);
    const value = inline ?? argv[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    if (inline == null) index++;
    values.set(key, value);
  }
  const apiUrl = values.get("api-url") ?? "";
  const parsed = new URL(apiUrl);
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error("--api-url must be loopback HTTP");
  }
  if (Number(parsed.port) < 10_000 || Number(parsed.port) > 65_535 || parsed.pathname.replace(/\/$/, "") !== "/api") {
    throw new Error("--api-url must use an isolated high port and end in /api");
  }
  const rows = Number(values.get("rows") ?? DEFAULT_ROWS);
  if (!Number.isSafeInteger(rows) || rows < 1 || rows > DEFAULT_ROWS) {
    throw new Error("--rows must be an integer between 1 and 500000");
  }
  const fileNamePrefix = values.get("filename-prefix") ?? "api-concurrent";
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(fileNamePrefix)) {
    throw new Error("--filename-prefix must be a simple ASCII name prefix");
  }
  const outFile = path.resolve(REPO_ROOT, values.get("out") ?? "");
  const relativeOut = path.relative(REPO_ROOT, outFile);
  if (!relativeOut || relativeOut.startsWith("..") || path.isAbsolute(relativeOut)) {
    throw new Error("--out must stay inside the repository");
  }
  return { apiUrl: apiUrl.replace(/\/$/, ""), rows, fileNamePrefix, outFile };
}

function csvLine(row: number, variant: string): string {
  const day = String((row % 28) + 1).padStart(2, "0");
  const platform = String(row % 12).padStart(2, "0");
  const shop = String(row % 400).padStart(3, "0");
  const sku = String(row % 100_000).padStart(6, "0");
  const amount = `${100 + (row % 10_000)}.${String(row % 100).padStart(2, "0")}`;
  return `${row},ORD${variant}${String(row).padStart(9, "0")},2026-08-${day},platform_${platform},shop_${shop},SKU${sku},${amount},${variant}-note-${String(row).padStart(7, "0")}-abcdefghijklmnopqrstuvwxyz\n`;
}

function deterministicCsv(rows: number, variant: string): { body: Readable; state: StreamState } {
  const state: StreamState = { byteCount: 0, sha256: null };
  const hash = createHash("sha256");
  const body = Readable.from((async function* () {
    const header = Buffer.from("row_no,order_no,event_date,platform,shop,sku,amount,note\n");
    state.byteCount += header.byteLength;
    hash.update(header);
    yield header;
    const lines: string[] = [];
    for (let row = 1; row <= rows; row++) {
      lines.push(csvLine(row, variant));
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

async function upload(
  options: Options,
  token: string,
  slot: number,
  rows: number,
  fileName: string,
  variant: string,
  onAccepted?: (sourceId: number) => void,
): Promise<RawUpload> {
  const generated = deterministicCsv(rows, variant);
  const query = new URLSearchParams({ filename: fileName, name: `API concurrent upload ${slot}`, expectedRows: String(rows) });
  const startedAtEpochMs = Date.now();
  const started = performance.now();
  const response = await fetch(`${options.apiUrl}/files/upload-large-csv?${query}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "text/csv; charset=utf-8",
    },
    body: generated.body as any,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const payload = await jsonResponse(response);
  const finishedAtEpochMs = Date.now();
  const acceptedSourceId = Number(payload?.data?.sourceId);
  if (response.status === 200 && payload?.ok === true && Number.isSafeInteger(acceptedSourceId) && acceptedSourceId > 0) {
    onAccepted?.(acceptedSourceId);
  }
  if (!generated.state.sha256) throw new Error(`client stream did not complete for ${fileName}`);
  return {
    slot,
    rows,
    fileName,
    status: response.status,
    payload,
    startedAtEpochMs,
    finishedAtEpochMs,
    seconds: Number(((performance.now() - started) / 1000).toFixed(3)),
    byteCount: generated.state.byteCount,
    sha256: generated.state.sha256,
  };
}

async function preview(apiUrl: string, token: string, sourceId: number, offset: number): Promise<any> {
  const response = await fetch(`${apiUrl}/files/${sourceId}/preview?limit=1&offset=${offset}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const payload = await jsonResponse(response);
  if (response.status !== 200 || payload?.ok !== true) throw new Error(`preview failed at source ${sourceId}, offset ${offset}`);
  return payload.data;
}

async function currentSource(apiUrl: string, token: string, fileName: string): Promise<any> {
  const response = await fetch(`${apiUrl}/files`, { headers: { authorization: `Bearer ${token}` } });
  const payload = await jsonResponse(response);
  if (response.status !== 200 || payload?.ok !== true || !Array.isArray(payload.data)) throw new Error("file list failed");
  const matches = payload.data.filter((source: any) => source?.config?.originalFileName === fileName);
  if (matches.length !== 1) throw new Error(`expected exactly one source for ${fileName}, got ${matches.length}`);
  return matches[0];
}

function exactOverlapMs(operations: Array<{ startedAtEpochMs: number; finishedAtEpochMs: number }>): number {
  return Math.max(
    0,
    Math.min(...operations.map((operation) => operation.finishedAtEpochMs))
      - Math.max(...operations.map((operation) => operation.startedAtEpochMs)),
  );
}

async function verifyUpload(options: Options, token: string, raw: RawUpload): Promise<any> {
  if (raw.status !== 200 || raw.payload?.ok !== true) {
    throw new Error(`upload failed for ${raw.fileName}: status=${raw.status} code=${raw.payload?.code ?? "unknown"}`);
  }
  const data = raw.payload.data;
  if (Number(data?.rowCount) !== raw.rows || Number(data?.byteCount) !== raw.byteCount || data?.sha256 !== raw.sha256) {
    throw new Error(`server row/byte/hash result differs for ${raw.fileName}`);
  }
  const sourceId = Number(data.sourceId);
  const first = await preview(options.apiUrl, token, sourceId, 0);
  const last = await preview(options.apiUrl, token, sourceId, raw.rows - 1);
  if (
    Number(first.total) !== raw.rows
    || Number(last.total) !== raw.rows
    || String(first.rows?.[0]?.row_no) !== "1"
    || String(last.rows?.[0]?.row_no) !== String(raw.rows)
  ) {
    throw new Error(`preview integrity mismatch for ${raw.fileName}`);
  }
  return {
    slot: raw.slot,
    fileName: raw.fileName,
    status: raw.status,
    startedAtEpochMs: raw.startedAtEpochMs,
    finishedAtEpochMs: raw.finishedAtEpochMs,
    seconds: raw.seconds,
    byteCount: raw.byteCount,
    serverByteCount: Number(data.byteCount),
    sha256: raw.sha256,
    serverSha256: String(data.sha256),
    sourceId,
    tableName: String(data.tableName),
    rowCount: Number(data.rowCount),
    exceededOrdinary50MbLimit: raw.byteCount > GLOBAL_BODY_LIMIT_BYTES,
    firstRowNo: String(first.rows[0].row_no),
    lastRowNo: String(last.rows[0].row_no),
    previewTotal: Number(last.total),
  };
}

async function timedSmallRequest(url: string, init: RequestInit): Promise<TimedResponse> {
  const startedAtEpochMs = Date.now();
  const started = performance.now();
  const response = await fetch(url, init);
  const payload = await jsonResponse(response);
  return {
    status: response.status,
    payload,
    startedAtEpochMs,
    finishedAtEpochMs: Date.now(),
    seconds: Number(((performance.now() - started) / 1000).toFixed(3)),
  };
}

async function conflictProbe(options: Options, token: string, fileName: string): Promise<TimedResponse> {
  const query = new URLSearchParams({ filename: fileName, name: "concurrent conflict probe", expectedRows: "1" });
  return timedSmallRequest(`${options.apiUrl}/files/upload-large-csv?${query}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/csv" },
    body: "row_no,value\n1,conflict\n",
  });
}

async function recoveryProbe(options: Options, token: string, fileName: string): Promise<TimedResponse> {
  const query = new URLSearchParams({
    filename: fileName,
    name: "concurrent replacement failure probe",
    replaceExisting: "true",
    expectedRows: "1",
  });
  const rowCountMismatch = [
    "row_no,order_no,event_date,platform,shop,sku,amount,note\n",
    "1,ORDR000000001,2026-08-02,platform_01,shop_001,SKU000001,101.01,valid\n",
    "2,ORDR000000002,2026-08-03,platform_02,shop_002,SKU000002,102.02,valid-two\n",
  ].join("");
  return timedSmallRequest(`${options.apiUrl}/files/upload-large-csv?${query}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/csv" },
    body: rowCountMismatch,
  });
}

async function deleteSource(apiUrl: string, token: string, sourceId: number): Promise<void> {
  const response = await fetch(`${apiUrl}/files/${sourceId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  const payload = await jsonResponse(response);
  if (response.status !== 200 || payload?.ok !== true) throw new Error(`cleanup failed for source ${sourceId}`);
}

async function sourceNamesAbsent(apiUrl: string, token: string, fileNames: string[]): Promise<boolean> {
  const response = await fetch(`${apiUrl}/files`, { headers: { authorization: `Bearer ${token}` } });
  const payload = await jsonResponse(response);
  if (response.status !== 200 || payload?.ok !== true || !Array.isArray(payload.data)) throw new Error("post-cleanup file list failed");
  const targets = new Set(fileNames);
  return !payload.data.some((source: any) => targets.has(String(source?.config?.originalFileName ?? "")));
}

async function settledOrThrow<T>(promises: Promise<T>[], label: string): Promise<T[]> {
  const settled = await Promise.allSettled(promises);
  const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
  if (failure) throw new Error(`${label} failed: ${failure.reason instanceof Error ? failure.reason.message : String(failure.reason)}`);
  return settled.map((item) => (item as PromiseFulfilledResult<T>).value);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const password = process.env.API_ADMIN_PASSWORD?.trim();
  if (!password) throw new Error("API_ADMIN_PASSWORD is required");
  const token = await login(options.apiUrl, password);
  const successFileNames = Array.from({ length: SUCCESS_CONCURRENCY }, (_, index) => `${options.fileNamePrefix}-${index + 1}.csv`);
  const freshFileName = `${options.fileNamePrefix}-fresh.csv`;
  const allFileNames = [...successFileNames, freshFileName];
  const acceptedSourceIds: number[] = [];
  let workload: any;
  let workloadError: unknown = null;
  const recordAccepted = (sourceId: number) => acceptedSourceIds.push(sourceId);

  try {
    const successStarted = performance.now();
    const rawSuccess = await settledOrThrow(
      successFileNames.map((fileName, index) => upload(
        options,
        token,
        index + 1,
        options.rows,
        fileName,
        `s${index + 1}`,
        recordAccepted,
      )),
      "success wave",
    );
    const successUploads = await settledOrThrow(rawSuccess.map((raw) => verifyUpload(options, token, raw)), "success verification");
    const successSeconds = Number(((performance.now() - successStarted) / 1000).toFixed(3));

    const mixedStarted = performance.now();
    const mixed = await settledOrThrow([
      recoveryProbe(options, token, successFileNames[0]),
      conflictProbe(options, token, successFileNames[1]),
      upload(options, token, 4, FRESH_ROWS, freshFileName, "fresh", recordAccepted),
    ], "mixed wave");
    const replacement = mixed[0] as TimedResponse;
    const duplicate = mixed[1] as TimedResponse;
    const freshRaw = mixed[2] as RawUpload;
    if (replacement.status !== 400 || replacement.payload?.code !== "LARGE_CSV_EXPECTED_ROWS_MISMATCH") {
      throw new Error(`replacement probe did not fail atomically: status=${replacement.status} code=${replacement.payload?.code ?? "unknown"}`);
    }
    if (duplicate.status !== 409 || duplicate.payload?.code !== "LARGE_CSV_NAME_CONFLICT") {
      throw new Error(`duplicate probe did not fail closed: status=${duplicate.status} code=${duplicate.payload?.code ?? "unknown"}`);
    }
    const freshUpload = await verifyUpload(options, token, freshRaw);
    const afterReplacement = await currentSource(options.apiUrl, token, successFileNames[0]);
    const afterDuplicate = await currentSource(options.apiUrl, token, successFileNames[1]);
    const replacementPreview = await preview(options.apiUrl, token, successUploads[0].sourceId, options.rows - 1);
    const duplicatePreview = await preview(options.apiUrl, token, successUploads[1].sourceId, options.rows - 1);
    const mixedSeconds = Number(((performance.now() - mixedStarted) / 1000).toFixed(3));

    workload = {
      schema: "api-concurrent-csv-upload-result/v1",
      generatedAt: new Date().toISOString(),
      boundary: {
        transport: "HTTP chunked raw text/csv",
        successConcurrency: SUCCESS_CONCURRENCY,
        rowsPerSuccessUpload: options.rows,
        successTotalRows: SUCCESS_CONCURRENCY * options.rows,
        mixedFreshUploadRows: FRESH_ROWS,
        ordinaryUploadCovered: false,
        concurrencyCovered: true,
        longDurationCovered: false,
        realDataCovered: false,
        productionSlaCovered: false,
      },
      successWave: {
        seconds: successSeconds,
        overlapMs: exactOverlapMs(successUploads),
        uploads: successUploads,
      },
      mixedWave: {
        seconds: mixedSeconds,
        overlapMs: exactOverlapMs([replacement, duplicate, freshUpload]),
        failedReplacement: {
          targetSourceId: successUploads[0].sourceId,
          status: replacement.status,
          code: String(replacement.payload?.code ?? ""),
          startedAtEpochMs: replacement.startedAtEpochMs,
          finishedAtEpochMs: replacement.finishedAtEpochMs,
          seconds: replacement.seconds,
          preservedSourceId: Number(afterReplacement.id),
          preservedSha256: String(afterReplacement.config?.largeCsvUpload?.sha256 ?? ""),
          preservedRows: Number(replacementPreview.total),
          preservedLastRowNo: String(replacementPreview.rows?.[0]?.row_no ?? ""),
        },
        duplicateConflict: {
          targetSourceId: successUploads[1].sourceId,
          status: duplicate.status,
          code: String(duplicate.payload?.code ?? ""),
          startedAtEpochMs: duplicate.startedAtEpochMs,
          finishedAtEpochMs: duplicate.finishedAtEpochMs,
          seconds: duplicate.seconds,
          preservedSourceId: Number(afterDuplicate.id),
          preservedSha256: String(afterDuplicate.config?.largeCsvUpload?.sha256 ?? ""),
          preservedRows: Number(duplicatePreview.total),
          preservedLastRowNo: String(duplicatePreview.rows?.[0]?.row_no ?? ""),
        },
        freshUpload,
      },
    };
  } catch (error) {
    workloadError = error;
  }

  const uniqueSourceIds = [...new Set(acceptedSourceIds)];
  const deletedSourceIds: number[] = [];
  try {
    for (const sourceId of uniqueSourceIds.slice().reverse()) {
      await deleteSource(options.apiUrl, token, sourceId);
      deletedSourceIds.push(sourceId);
    }
  } catch (cleanupError) {
    throw new Error(`workload cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
  }
  const namesAbsent = await sourceNamesAbsent(options.apiUrl, token, allFileNames);
  if (!namesAbsent) throw new Error("one or more concurrent source names remain after cleanup");
  if (workloadError) throw workloadError;
  workload.cleanup = {
    deletedSourceIds: deletedSourceIds.sort((left, right) => left - right),
    expectedDeletedSources: 4,
    sourceNamesAbsent: namesAbsent,
  };

  await mkdir(path.dirname(options.outFile), { recursive: true });
  const temporary = `${options.outFile}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(workload, null, 2)}\n`, "utf8");
  await rename(temporary, options.outFile);
  const written = JSON.parse(await readFile(options.outFile, "utf8"));
  if (written.schema !== workload.schema) throw new Error("result write verification failed");
  console.log(`result=${path.relative(REPO_ROOT, options.outFile).replaceAll(path.sep, "/")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
