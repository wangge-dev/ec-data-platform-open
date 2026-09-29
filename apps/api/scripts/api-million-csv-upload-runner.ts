import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const API_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = path.resolve(API_ROOT, "../..");
const DEFAULT_ROWS = 1_000_000;
const GLOBAL_BODY_LIMIT_BYTES = 50 * 1024 * 1024;

type Options = {
  apiUrl: string;
  rows: number;
  fileName: string;
  outFile: string;
};

type StreamState = {
  byteCount: number;
  sha256: string | null;
};

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: api-million-csv-upload-runner.ts --api-url http://127.0.0.1:<high-port>/api --out <ignored-json> [--rows 1000000] [--filename name.csv]");
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
    throw new Error("--rows must be an integer between 1 and 1000000");
  }
  const fileName = values.get("filename") ?? "api-million-capacity.csv";
  if (!/^[a-z0-9][a-z0-9._-]*\.csv$/i.test(fileName)) throw new Error("--filename must be a simple ASCII .csv name");
  const outFile = path.resolve(REPO_ROOT, values.get("out") ?? "");
  const relativeOut = path.relative(REPO_ROOT, outFile);
  if (!relativeOut || relativeOut.startsWith("..") || path.isAbsolute(relativeOut)) {
    throw new Error("--out must stay inside the repository");
  }
  return { apiUrl: apiUrl.replace(/\/$/, ""), rows, fileName, outFile };
}

function csvLine(row: number): string {
  const day = String((row % 28) + 1).padStart(2, "0");
  const platform = String(row % 12).padStart(2, "0");
  const shop = String(row % 400).padStart(3, "0");
  const sku = String(row % 100_000).padStart(6, "0");
  const amount = `${100 + (row % 10_000)}.${String(row % 100).padStart(2, "0")}`;
  return `${row},ORD${String(row).padStart(10, "0")},2026-08-${day},platform_${platform},shop_${shop},SKU${sku},${amount},note-${String(row).padStart(7, "0")}-abcdefghijklmnopqrstuvwxyz\n`;
}

function deterministicCsv(rows: number): { body: Readable; state: StreamState } {
  const state: StreamState = { byteCount: 0, sha256: null };
  const hash = createHash("sha256");
  const body = Readable.from((async function* () {
    const header = Buffer.from("row_no,order_no,event_date,platform,shop,sku,amount,note\n");
    state.byteCount += header.byteLength;
    hash.update(header);
    yield header;
    const lines: string[] = [];
    for (let row = 1; row <= rows; row++) {
      lines.push(csvLine(row));
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

async function upload(options: Options, token: string): Promise<{
  status: number;
  payload: any;
  seconds: number;
  byteCount: number;
  sha256: string;
}> {
  const generated = deterministicCsv(options.rows);
  const query = new URLSearchParams({ filename: options.fileName, name: "API million row capacity", expectedRows: String(options.rows) });
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
  const seconds = Number(((performance.now() - started) / 1000).toFixed(3));
  if (!generated.state.sha256) throw new Error("client stream did not complete");
  return { status: response.status, payload, seconds, byteCount: generated.state.byteCount, sha256: generated.state.sha256 };
}

async function preview(apiUrl: string, token: string, sourceId: number, offset: number): Promise<any> {
  const response = await fetch(`${apiUrl}/files/${sourceId}/preview?limit=1&offset=${offset}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const payload = await jsonResponse(response);
  if (response.status !== 200 || payload?.ok !== true) throw new Error(`preview failed at offset ${offset}`);
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

async function conflictProbe(options: Options, token: string): Promise<{ status: number; code: string; seconds: number }> {
  const started = performance.now();
  const query = new URLSearchParams({ filename: options.fileName, name: "conflict probe", expectedRows: "1" });
  const response = await fetch(`${options.apiUrl}/files/upload-large-csv?${query}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/csv" },
    body: "row_no,value\n1,conflict\n",
  });
  const payload = await jsonResponse(response);
  return {
    status: response.status,
    code: String(payload?.code ?? ""),
    seconds: Number(((performance.now() - started) / 1000).toFixed(3)),
  };
}

async function recoveryProbe(options: Options, token: string): Promise<{ status: number; code: string; seconds: number }> {
  const started = performance.now();
  const query = new URLSearchParams({
    filename: options.fileName,
    name: "replacement failure probe",
    replaceExisting: "true",
    expectedRows: "1",
  });
  const rowCountMismatch = [
    "row_no,order_no,event_date,platform,shop,sku,amount,note\n",
    "1,ORD0000000001,2026-08-02,platform_01,shop_001,SKU000001,101.01,valid\n",
    "2,ORD0000000002,2026-08-03,platform_02,shop_002,SKU000002,102.02,valid-two\n",
  ].join("");
  const response = await fetch(`${options.apiUrl}/files/upload-large-csv?${query}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/csv" },
    body: rowCountMismatch,
  });
  const payload = await jsonResponse(response);
  return {
    status: response.status,
    code: String(payload?.code ?? ""),
    seconds: Number(((performance.now() - started) / 1000).toFixed(3)),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const password = process.env.API_ADMIN_PASSWORD?.trim();
  if (!password) throw new Error("API_ADMIN_PASSWORD is required");
  const token = await login(options.apiUrl, password);

  const uploaded = await upload(options, token);
  if (uploaded.status !== 200 || uploaded.payload?.ok !== true) {
    throw new Error(`million-row upload failed: status=${uploaded.status} code=${uploaded.payload?.code ?? "unknown"}`);
  }
  const data = uploaded.payload.data;
  if (Number(data?.rowCount) !== options.rows || Number(data?.byteCount) !== uploaded.byteCount || data?.sha256 !== uploaded.sha256) {
    throw new Error("server row/byte/hash result differs from the streamed request");
  }
  if (options.rows === DEFAULT_ROWS && uploaded.byteCount <= GLOBAL_BODY_LIMIT_BYTES) {
    throw new Error("million-row fixture did not exceed the ordinary 50MB request limit");
  }
  const sourceId = Number(data.sourceId);
  const first = await preview(options.apiUrl, token, sourceId, 0);
  const last = await preview(options.apiUrl, token, sourceId, options.rows - 1);
  if (Number(first.total) !== options.rows || Number(last.total) !== options.rows) throw new Error("preview total is not exact");
  if (String(first.rows?.[0]?.row_no) !== "1" || String(last.rows?.[0]?.row_no) !== String(options.rows)) {
    throw new Error("first/last row identity mismatch");
  }

  const conflict = await conflictProbe(options, token);
  if (conflict.status !== 409 || conflict.code !== "LARGE_CSV_NAME_CONFLICT") {
    throw new Error(`duplicate probe did not fail closed: ${JSON.stringify(conflict)}`);
  }
  const afterConflict = await currentSource(options.apiUrl, token, options.fileName);
  if (Number(afterConflict.id) !== sourceId || afterConflict.config?.largeCsvUpload?.sha256 !== uploaded.sha256) {
    throw new Error("duplicate probe changed the accepted source");
  }

  const recovery = await recoveryProbe(options, token);
  if (recovery.status !== 400 || recovery.code !== "LARGE_CSV_EXPECTED_ROWS_MISMATCH") {
    throw new Error(`replacement failure probe did not reach atomic COPY rollback: ${JSON.stringify(recovery)}`);
  }
  const afterRecovery = await currentSource(options.apiUrl, token, options.fileName);
  const recoveredPreview = await preview(options.apiUrl, token, sourceId, options.rows - 1);
  if (
    Number(afterRecovery.id) !== sourceId
    || afterRecovery.config?.largeCsvUpload?.sha256 !== uploaded.sha256
    || Number(recoveredPreview.total) !== options.rows
    || String(recoveredPreview.rows?.[0]?.row_no) !== String(options.rows)
  ) {
    throw new Error("failed replacement did not preserve the previously committed source");
  }

  const deleteResponse = await fetch(`${options.apiUrl}/files/${sourceId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  const deletePayload = await jsonResponse(deleteResponse);
  if (deleteResponse.status !== 200 || deletePayload?.ok !== true) throw new Error("capacity source cleanup failed");
  const listAfterDelete = await fetch(`${options.apiUrl}/files`, { headers: { authorization: `Bearer ${token}` } });
  const listPayload = await jsonResponse(listAfterDelete);
  if (!listPayload?.ok || listPayload.data.some((source: any) => source?.config?.originalFileName === options.fileName)) {
    throw new Error("capacity source remains after cleanup");
  }

  const result = {
    schema: "api-million-csv-upload-result/v1",
    generatedAt: new Date().toISOString(),
    boundary: {
      transport: "HTTP chunked raw text/csv",
      rows: options.rows,
      ordinaryUploadCovered: false,
      concurrencyCovered: false,
      longDurationCovered: false,
      realDataCovered: false,
    },
    upload: {
      seconds: uploaded.seconds,
      byteCount: uploaded.byteCount,
      sha256: uploaded.sha256,
      sourceId,
      tableName: String(data.tableName),
      rowCount: Number(data.rowCount),
      exceededOrdinary50MbLimit: uploaded.byteCount > GLOBAL_BODY_LIMIT_BYTES,
      firstRowNo: String(first.rows[0].row_no),
      lastRowNo: String(last.rows[0].row_no),
      previewTotal: Number(last.total),
    },
    repeatConflict: { ...conflict, preservedSourceId: Number(afterConflict.id), preservedSha256: afterConflict.config.largeCsvUpload.sha256 },
    failedReplacementRecovery: {
      ...recovery,
      preservedSourceId: Number(afterRecovery.id),
      preservedSha256: afterRecovery.config.largeCsvUpload.sha256,
      preservedRows: Number(recoveredPreview.total),
      preservedLastRowNo: String(recoveredPreview.rows[0].row_no),
    },
    cleanup: { deleted: true, sourceAbsent: true },
  };
  await mkdir(path.dirname(options.outFile), { recursive: true });
  const temporary = `${options.outFile}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await rename(temporary, options.outFile);
  const written = JSON.parse(await readFile(options.outFile, "utf8"));
  if (written.schema !== result.schema) throw new Error("result write verification failed");
  console.log(`result=${path.relative(REPO_ROOT, options.outFile).replaceAll(path.sep, "/")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
