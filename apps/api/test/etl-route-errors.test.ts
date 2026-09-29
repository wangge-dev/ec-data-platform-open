import { beforeEach, describe, expect, test, vi } from "vitest";
import { sign } from "../src/lib/auth";

const mocks = vi.hoisted(() => {
  const state = {
    files: [] as any[],
    scanFolder: "C:\\scan",
  };
  const safeDirectory = {
    listSpreadsheetFiles: vi.fn(),
    openSubdirectory: vi.fn(),
    readFile: vi.fn(),
    close: vi.fn(),
  };
  return {
    state,
    safeDirectory,
    runModuleEtl: vi.fn(),
    importExcel: vi.fn(),
    openSafeSpreadsheetDirectory: vi.fn(),
    matchFileToPlatform: vi.fn(),
    findBrandDict: vi.fn(),
    sqlUnsafe: vi.fn(async (query: string) =>
      query.includes("scan_folder") ? [{ value: state.scanFolder }] : [],
    ),
  };
});

vi.mock("../src/lib/current-auth-user.js", () => ({
  resolveCurrentAuthUser: vi.fn(async (payload: any) => payload),
}));

vi.mock("../src/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () =>
          Object.assign(Promise.resolve(mocks.state.files), {
            limit: async () => mocks.state.files,
          }),
      }),
    }),
  },
  sql: { unsafe: mocks.sqlUnsafe },
}));
vi.mock("../src/db/table-scope", () => ({
  resolveExistingRuntimeTableFromSql: vi.fn(),
}));
vi.mock("../src/services/etl", () => ({
  findBrandDict: mocks.findBrandDict,
}));
vi.mock("../src/services/import-excel", () => ({
  importExcel: mocks.importExcel,
}));
vi.mock("../src/services/safe-spreadsheet-file.js", () => ({
  SafeSpreadsheetDirectory: {
    open: mocks.openSafeSpreadsheetDirectory,
  },
}));
vi.mock("../src/modules/engine", () => ({
  runModuleEtl: mocks.runModuleEtl,
}));
vi.mock("../src/modules/loader", () => ({
  matchFileToPlatform: mocks.matchFileToPlatform,
  loadModules: vi.fn(),
  moduleTableName: vi.fn(),
}));
vi.mock("../src/services/unmatched-orders.js", () => ({
  exportUnmatchedOrdersCsv: vi.fn(),
  getUnmatchedOrders: vi.fn(),
  InvalidUnmatchedPaginationError: class extends Error {},
}));
import etlRoutes from "../src/routes/etl";

const token = sign({ uid: 7, username: "tester", isAdmin: true, tokenVersion: 0 });

function request(path: string) {
  return etlRoutes.request(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.files = [
    {
      id: 161,
      type: "file",
      name: "orders.xlsx",
      config: { originalFileName: "orders.xlsx" },
    },
  ];
  mocks.findBrandDict.mockResolvedValue(null);
  mocks.matchFileToPlatform.mockResolvedValue({
    platform: { name: "拼多多" },
  });
  mocks.importExcel.mockResolvedValue({ sourceId: 161 });
  mocks.openSafeSpreadsheetDirectory.mockResolvedValue(mocks.safeDirectory);
  mocks.safeDirectory.listSpreadsheetFiles.mockResolvedValue(["orders.xlsx"]);
  mocks.safeDirectory.openSubdirectory.mockResolvedValue(null);
  mocks.safeDirectory.readFile.mockResolvedValue(Buffer.from("xlsx"));
  mocks.safeDirectory.close.mockResolvedValue(undefined);
});

describe("ETL route public errors", () => {
  test.each([
    ["safe", "未导入维护表(品牌字典)，请先导入", "未导入品牌维护表，请先导入"],
    [
      "secret",
      "password=top-secret driver SQL relation user_data.uf_161 failed",
      "文件处理失败，请稍后重试",
    ],
  ])("/run keeps %s details within the public policy", async (_kind, raw, expected) => {
    mocks.runModuleEtl.mockResolvedValueOnce({
      sourceId: 161,
      total: 0,
      inserted: 0,
      error: raw,
    });

    const response = await request("/run/161");
    const body = await response.json();

    expect(body.data.error).toBe(expected);
    expect(JSON.stringify(body)).not.toContain("top-secret");
    expect(JSON.stringify(body)).not.toContain("user_data");
  });

  test.each([
    ["safe", "订单表缺列: 商品编码、订单金额", "订单文件缺少必要字段，请检查字段对应"],
    [
      "secret",
      "password=top-secret driver SQL relation user_data.uf_161 failed",
      "文件处理失败，请稍后重试",
    ],
  ])("/rerun-all keeps %s details within the public policy", async (_kind, raw, expected) => {
    mocks.runModuleEtl.mockResolvedValueOnce({
      sourceId: 161,
      total: 0,
      inserted: 0,
      error: raw,
    });

    const response = await request("/rerun-all");
    const body = await response.json();

    expect(body.data.details[0].error).toBe(expected);
    expect(JSON.stringify(body)).not.toContain("top-secret");
    expect(JSON.stringify(body)).not.toContain("user_data");
  });

  test.each([
    ["safe", "维护表缺少id列", "品牌维护表缺少必要的 ID 字段"],
    [
      "secret",
      "password=top-secret driver SQL relation user_data.uf_161 failed",
      "文件处理失败，请稍后重试",
    ],
  ])("/scan keeps %s reports within the public policy", async (_kind, raw, expected) => {
    mocks.runModuleEtl.mockResolvedValueOnce({
      sourceId: 161,
      total: 0,
      inserted: 0,
      error: raw,
    });

    const response = await request("/scan");
    const body = await response.json();

    expect(body.data.platforms[0].error).toBe(expected);
    expect(JSON.stringify(body)).not.toContain("top-secret");
    expect(JSON.stringify(body)).not.toContain("user_data");
  });

  test("/scan refuses a file rejected by the bounded no-follow reader before import", async () => {
    mocks.safeDirectory.readFile.mockRejectedValueOnce(
      new Error("symbolic link to password=top-secret"),
    );

    const response = await request("/scan");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.importExcel).not.toHaveBeenCalled();
    expect(body.data.platforms[0].error).toBe(
      "文件处理失败，请稍后重试",
    );
    expect(JSON.stringify(body)).not.toContain("top-secret");
  });

  test("/scan closes the pinned directory when initial bounded enumeration fails", async () => {
    mocks.safeDirectory.listSpreadsheetFiles.mockRejectedValueOnce(
      new Error("directory entry limit exceeded"),
    );

    const response = await request("/scan");

    expect(response.status).toBe(400);
    expect(mocks.safeDirectory.close).toHaveBeenCalledOnce();
    expect(mocks.importExcel).not.toHaveBeenCalled();
  });
});
