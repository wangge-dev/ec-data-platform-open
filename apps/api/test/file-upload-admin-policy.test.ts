import { beforeEach, describe, expect, test, vi } from "vitest";
import { sign } from "../src/lib/auth.js";

const mocks = vi.hoisted(() => ({
  importExcel: vi.fn(async () => ({
    sourceId: 1,
    tableName: "uf_1",
    rowCount: 1,
    columns: [],
  })),
  matchFileToPlatform: vi.fn(async () => null as any),
}));

vi.mock("../src/lib/current-auth-user.js", () => ({
  resolveCurrentAuthUser: vi.fn(async (payload: any) => payload),
}));

vi.mock("../src/db/client", () => ({
  db: {},
  sql: { unsafe: vi.fn() },
}));

vi.mock("../src/modules/loader", () => ({
  getModule: vi.fn(async () => null),
  matchFileToPlatform: mocks.matchFileToPlatform,
}));

vi.mock("../src/services/import-excel", () => ({
  importExcel: mocks.importExcel,
  deleteFileSource: vi.fn(),
  deleteFileSourcesAtomically: vi.fn(),
  FILE_TABLE_PREFIX: "uf_",
  isFileNameUniqueConflict: vi.fn(() => false),
  FileSourceDeleteBlockedError: class FileSourceDeleteBlockedError extends Error {},
}));

import routes from "../src/routes/files.js";

const adminToken = sign({ uid: 1, username: "admin", isAdmin: true, tokenVersion: 0 });
const operatorToken = sign({ uid: 2, username: "operator", isAdmin: false, tokenVersion: 0 });

function upload(
  token: string,
  role = "file",
  options: { headerRows?: string; headerStartRow?: string; shapeMode?: string } = {},
) {
  const form = new FormData();
  form.set("file", new Blob(["date,amount\n2026-08-01,1\n"], { type: "text/csv" }), "orders.csv");
  form.set("name", "synthetic orders");
  form.set("role", role);
  if (options.headerRows) form.set("headerRows", options.headerRows);
  if (options.headerStartRow) form.set("headerStartRow", options.headerStartRow);
  if (options.shapeMode) form.set("shapeMode", options.shapeMode);
  return routes.request("/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
}

describe("file upload administrator policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.matchFileToPlatform.mockResolvedValue(null);
  });

  test("returns 400 without leaking parser details for malformed multipart bodies", async () => {
    const response = await routes.request("/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${operatorToken}`,
        "Content-Type": "multipart/form-data; boundary=broken-boundary",
      },
      body: "this is not a valid multipart body",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      message: "上传表单格式无效",
    });
    expect(mocks.importExcel).not.toHaveBeenCalled();
  });

  test("keeps ordinary new-file upload but cannot replace a shared same-name source", async () => {
    const response = await upload(operatorToken);

    expect(response.status).toBe(200);
    expect(mocks.importExcel).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      "orders.csv",
      "synthetic orders",
      "file",
      false,
      null,
      null,
      null,
      { actorId: 2 },
    );
  });

  test("allows an administrator to use the explicit replacement path", async () => {
    const response = await upload(adminToken);

    expect(response.status).toBe(200);
    expect(mocks.importExcel).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      "orders.csv",
      "synthetic orders",
      "file",
      true,
      null,
      null,
      null,
      { actorId: 1 },
    );
  });

  test("passes an explicit safe multi-row header choice to the importer", async () => {
    const response = await upload(adminToken, "file", { headerRows: "2", headerStartRow: "3" });

    expect(response.status).toBe(200);
    expect(mocks.importExcel).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      "orders.csv",
      "synthetic orders",
      "file",
      true,
      null,
      null,
      null,
      { actorId: 1, headerRows: 2, headerStartRow: 3 },
    );
  });

  test("rejects an invalid explicit header start before parsing the workbook", async () => {
    const response = await upload(adminToken, "file", { headerStartRow: "0" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "HEADER_START_ROW_INVALID",
    });
    expect(mocks.importExcel).not.toHaveBeenCalled();
  });

  test("rejects ambiguous multi-row-header and wide-to-long combinations", async () => {
    const response = await upload(adminToken, "file", {
      headerRows: "2",
      shapeMode: "date-columns-to-rows",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "HEADER_ROWS_WITH_WIDE_TO_LONG_UNSUPPORTED",
    });
    expect(mocks.importExcel).not.toHaveBeenCalled();
  });

  test.each(["brand_dict", "cost_dict", "shop_pic_dict"])(
    "rejects ordinary upload of the global %s role",
    async (role) => {
      const response = await upload(operatorToken, role);

      expect(response.status).toBe(403);
      expect(mocks.importExcel).not.toHaveBeenCalled();
    },
  );

  test("also rejects a dictionary role inferred from the filename", async () => {
    mocks.matchFileToPlatform.mockResolvedValue({
      module: { isDict: true, role: "brand_dict" },
    } as any);

    const response = await upload(operatorToken);

    expect(response.status).toBe(403);
    expect(mocks.importExcel).not.toHaveBeenCalled();
  });

  test("redacts an unexpected importer failure", async () => {
    mocks.importExcel.mockRejectedValueOnce(
      new Error("password=top-secret relation user_data.uf_1 failed"),
    );

    const response = await upload(adminToken);
    const body = await response.json() as any;

    expect(response.status).toBe(500);
    expect(body).toEqual({ ok: false, code: "FILE_IMPORT_FAILED", message: "文件导入失败，请稍后重试" });
    expect(JSON.stringify(body)).not.toContain("top-secret");
    expect(JSON.stringify(body)).not.toContain("user_data");
  });
});
