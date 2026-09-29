import { beforeEach, describe, expect, test, vi } from "vitest";
import { sign } from "../src/lib/auth.js";

const mocks = vi.hoisted(() => ({
  testConnection: vi.fn(),
  listTables: vi.fn(),
  querySql: vi.fn(),
}));

vi.mock("../src/lib/current-auth-user.js", () => ({
  resolveCurrentAuthUser: vi.fn(async (payload: any) => payload),
}));

vi.mock("../src/db/client", () => ({ db: {} }));
vi.mock("../src/services/sql-connector", () => ({
  testConnection: mocks.testConnection,
  listTables: mocks.listTables,
  querySql: mocks.querySql,
}));

import routes from "../src/routes/external-sql.js";

const validConfig = {
  dialect: "pg",
  host: "93.184.216.34",
  port: 5432,
  user: "readonly",
  password: "synthetic-only",
  database: "analytics",
};

function request(
  path: string,
  method: "GET" | "POST" | "DELETE",
  isAdmin: boolean,
  body?: unknown,
) {
  const token = sign({ uid: isAdmin ? 1 : 2, username: "tester", isAdmin, tokenVersion: 0 });
  return routes.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("external SQL route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.testConnection.mockResolvedValue({ ok: true, version: "synthetic" });
  });

  test("rejects a non-admin before attempting a network connection", async () => {
    const response = await request("/test", "POST", false, validConfig);
    expect(response.status).toBe(403);
    expect(mocks.testConnection).not.toHaveBeenCalled();
  });

  test.each([
    { path: "/", method: "GET" as const },
    { path: "/7/tables", method: "GET" as const },
    {
      path: "/7/query",
      method: "POST" as const,
      body: { sql: "SELECT 1", limit: 100 },
    },
  ])("rejects a non-admin before accessing a saved connection: $method $path", async ({ path, method, body }) => {
    const response = await request(path, method, false, body);
    expect(response.status).toBe(403);
    expect(mocks.listTables).not.toHaveBeenCalled();
    expect(mocks.querySql).not.toHaveBeenCalled();
  });

  test("keeps the dedicated admin path functional", async () => {
    const response = await request("/test", "POST", true, validConfig);
    expect(response.status).toBe(200);
    expect(mocks.testConnection).toHaveBeenCalledWith(validConfig);
  });

  test("publishes the versioned connector catalog without credentials", async () => {
    const response = await request("/connectors", "GET", true);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({
      schemaVersion: "connector-catalog/v1",
      connectors: expect.arrayContaining([
        expect.objectContaining({ id: "postgres.readonly", version: 1, adapter: "pg" }),
        expect.objectContaining({ id: "mysql.readonly", version: 1, adapter: "mysql" }),
      ]),
    });
    expect(JSON.stringify(body)).not.toContain("password");
  });

  test("rejects a connector/dialect mismatch before network access", async () => {
    const response = await request("/test", "POST", true, {
      ...validConfig,
      connectorId: "mysql.readonly",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "CONNECTOR_DIALECT_MISMATCH" });
    expect(mocks.testConnection).not.toHaveBeenCalled();
  });
});
