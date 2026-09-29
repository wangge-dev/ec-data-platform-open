import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  LARGE_CSV_MAX_BYTES,
  LARGE_CSV_MAX_COLUMNS,
  LARGE_CSV_MAX_RECORD_BYTES,
  LARGE_CSV_MAX_ROWS,
  LargeCsvImportError,
  inspectLargeCsvChunks,
  normalizeLargeCsvUploadMetadata,
  shouldBypassDefaultBodyLimit,
} from "../src/services/large-csv-import.js";

describe("large CSV API import contract", () => {
  test("counts logical CSV records across chunks without treating quoted newlines as rows", () => {
    const chunks = [
      Buffer.from("name,note\r\n1,\"line one\n"),
      Buffer.from("line two\"\r\n2,\"escaped \"\"quote\"\"\"\r\n"),
    ];

    expect(inspectLargeCsvChunks(chunks)).toEqual({
      byteCount: Buffer.concat(chunks).byteLength,
      rowCount: 2,
      headers: ["name", "note"],
    });
  });

  test("accepts exactly one million rows and rejects the next row", () => {
    const exact = [Buffer.from("id\n1\n2\n3\n")];
    expect(inspectLargeCsvChunks(exact, { maxRows: 3 }).rowCount).toBe(3);

    expect(() => inspectLargeCsvChunks([Buffer.from("id\n1\n2\n3\n4\n")], { maxRows: 3 })).toThrowError(
      expect.objectContaining({ code: "LARGE_CSV_ROW_LIMIT_EXCEEDED" }),
    );
  });

  test("fails closed on byte, column, record, syntax, and UTF-8 limits", () => {
    expect(() => inspectLargeCsvChunks([Buffer.alloc(12)], { maxBytes: 11 })).toThrowError(
      expect.objectContaining({ code: "LARGE_CSV_BYTE_LIMIT_EXCEEDED" }),
    );
    expect(() => inspectLargeCsvChunks([Buffer.from("a,b,c\n1,2,3\n")], { maxColumns: 2 })).toThrowError(
      expect.objectContaining({ code: "LARGE_CSV_COLUMN_LIMIT_EXCEEDED" }),
    );
    expect(() => inspectLargeCsvChunks([Buffer.from("a,b,\n1,2,3\n")], { maxColumns: 2 })).toThrowError(
      expect.objectContaining({ code: "LARGE_CSV_COLUMN_LIMIT_EXCEEDED" }),
    );
    expect(() => inspectLargeCsvChunks([Buffer.from("a\n12345\n")], { maxRecordBytes: 4 })).toThrowError(
      expect.objectContaining({ code: "LARGE_CSV_RECORD_LIMIT_EXCEEDED" }),
    );
    expect(() => inspectLargeCsvChunks([Buffer.from("a,b\n1,\"broken\n")])).toThrowError(
      expect.objectContaining({ code: "LARGE_CSV_MALFORMED" }),
    );
    expect(() => inspectLargeCsvChunks([Buffer.from("a,b\n1,2,3\n")])).toThrowError(
      expect.objectContaining({ code: "LARGE_CSV_COLUMN_COUNT_MISMATCH" }),
    );
    expect(() => inspectLargeCsvChunks([Buffer.from("a,b,c\n1,2,3\n,,\n4,5,6\n")])).toThrowError(
      expect.objectContaining({ code: "LARGE_CSV_BLANK_ROW_REJECTED" }),
    );
    expect(() => inspectLargeCsvChunks([Buffer.from([0xff, 0x0a, 0x31, 0x0a])])).toThrowError(
      expect.objectContaining({ code: "LARGE_CSV_HEADER_ENCODING_INVALID" }),
    );
    expect(() => inspectLargeCsvChunks([Buffer.from("a\n"), Buffer.from([0xff, 0x0a])])).toThrowError(
      expect.objectContaining({ code: "LARGE_CSV_DATA_ENCODING_INVALID" }),
    );
    expect(() => inspectLargeCsvChunks([Buffer.from([0x61, 0x0a, 0x00, 0x0a])])).toThrowError(
      expect.objectContaining({ code: "LARGE_CSV_NUL_BYTE_UNSUPPORTED" }),
    );
  });

  test("publishes stable production limits instead of inheriting spreadsheet limits", () => {
    expect(LARGE_CSV_MAX_BYTES).toBe(512 * 1024 * 1024);
    expect(LARGE_CSV_MAX_ROWS).toBe(1_000_000);
    expect(LARGE_CSV_MAX_COLUMNS).toBe(256);
    expect(LARGE_CSV_MAX_RECORD_BYTES).toBe(4 * 1024 * 1024);
  });

  test("normalizes safe metadata and rejects path, extension, role, and encoding bypasses", () => {
    expect(normalizeLargeCsvUploadMetadata({
      originalFileName: "folder\\million.csv",
      displayName: "百万行",
      group: "capacity",
      moduleCode: "sales",
      replaceExisting: true,
      expectedRows: 2,
    })).toEqual({
      originalFileName: "million.csv",
      displayName: "百万行",
      group: "capacity",
      moduleCode: "sales",
      replaceExisting: true,
      expectedRows: 2,
    });

    for (const originalFileName of ["", ".csv", "million.xlsx", "bad�.csv"]) {
      expect(() => normalizeLargeCsvUploadMetadata({ originalFileName, expectedRows: 1 })).toThrow(LargeCsvImportError);
    }
    expect(() => normalizeLargeCsvUploadMetadata({
      originalFileName: "ok.csv",
      role: "brand_dict",
      expectedRows: 1,
    })).toThrowError(expect.objectContaining({ code: "LARGE_CSV_ROLE_UNSUPPORTED" }));
    expect(() => normalizeLargeCsvUploadMetadata({ originalFileName: "ok.csv", expectedRows: 0 }))
      .toThrowError(expect.objectContaining({ code: "LARGE_CSV_EXPECTED_ROWS_INVALID" }));
  });

  test("bypasses the global in-memory body limit only for the exact streamed endpoint", () => {
    expect(shouldBypassDefaultBodyLimit("POST", "/api/files/upload-large-csv")).toBe(true);
    expect(shouldBypassDefaultBodyLimit("GET", "/api/files/upload-large-csv")).toBe(false);
    expect(shouldBypassDefaultBodyLimit("POST", "/api/files/upload")).toBe(false);
    expect(shouldBypassDefaultBodyLimit("POST", "/api/files/upload-large-csv/extra")).toBe(false);
  });

  test("the dedicated route stays admin-only and never materializes multipart or ArrayBuffer input", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/routes/files.ts", import.meta.url)),
      "utf8",
    );
    const routeStart = source.indexOf('"/upload-large-csv"');
    const nextRoute = source.indexOf("r.post(", routeStart + 1);
    const route = source.slice(routeStart, nextRoute < 0 ? undefined : nextRoute);

    expect(routeStart).toBeGreaterThan(0);
    expect(route).toContain("adminGuard");
    expect(route).toContain("FileSourceDeleteBlockedError");
    expect(route).toContain("c.req.raw.body");
    expect(route).toContain('c.req.query("expectedRows")');
    expect(route).not.toContain("formData(");
    expect(route).not.toContain("arrayBuffer(");
  });
});
