import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertHostAllowed: vi.fn(),
  postgresFactory: vi.fn(),
  mysqlCreateConnection: vi.fn(),
  netCreateConnection: vi.fn(),
}));

vi.mock("../src/lib/host-guard", () => ({
  assertHostAllowed: mocks.assertHostAllowed,
}));
vi.mock("postgres", () => ({ default: mocks.postgresFactory }));
vi.mock("mysql2/promise", () => ({
  default: { createConnection: mocks.mysqlCreateConnection },
}));
vi.mock("node:net", () => ({
  default: {
    createConnection: mocks.netCreateConnection,
    isIP: (value: string) => value === "93.184.216.34" ? 4 : 0,
  },
}));

import {
  querySql,
  SQL_QUERY_TIMEOUT_MS,
  type SqlConfig,
} from "../src/services/sql-connector.js";
import { SQL_RESULT_MAX_CELL_BYTES } from "../src/lib/sql-result-budget.js";

const baseConfig: Omit<SqlConfig, "dialect"> = {
  host: "database.example",
  port: 5432,
  user: "readonly",
  password: "synthetic-only",
  database: "analytics",
};

describe("external SQL connector security boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertHostAllowed.mockResolvedValue("93.184.216.34");
    mocks.netCreateConnection.mockReturnValue({ destroy: vi.fn() });
  });

  afterEach(() => vi.useRealTimers());

  test("pins PostgreSQL to the validated address and uses a timed read-only transaction", async () => {
    const unsafe = vi.fn().mockResolvedValue([{ id: 1 }]);
    const begin = vi.fn(async (mode: string, fn: (tx: { unsafe: typeof unsafe }) => unknown) =>
      fn({ unsafe }));
    const end = vi.fn();
    mocks.postgresFactory.mockReturnValue({ begin, end });

    const result = await querySql({ ...baseConfig, dialect: "pg", ssl: true }, "SELECT id FROM sales", 100);

    expect(mocks.assertHostAllowed).toHaveBeenCalledWith("database.example");
    expect(mocks.postgresFactory).toHaveBeenCalledWith(expect.objectContaining({
      host: "93.184.216.34",
      connection: { statement_timeout: SQL_QUERY_TIMEOUT_MS },
      ssl: {
        rejectUnauthorized: true,
        servername: "database.example",
      },
    }));
    expect(begin).toHaveBeenCalledWith("read only", expect.any(Function));
    expect(unsafe).toHaveBeenCalledWith("SELECT id FROM sales LIMIT 100");
    expect(result).toEqual({ rows: [{ id: 1 }], columns: ["id"] });
    expect(end).toHaveBeenCalledOnce();
  });

  test("uses a timed MySQL read-only transaction and commits successful reads", async () => {
    const connection = {
      query: vi.fn().mockResolvedValue([[], []]),
      execute: vi.fn().mockResolvedValue([[{ id: 1 }], [{ name: "id" }]]),
      commit: vi.fn(),
      rollback: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    mocks.mysqlCreateConnection.mockResolvedValue(connection);

    await querySql({ ...baseConfig, dialect: "mysql", port: 3306, ssl: true }, "SELECT id FROM sales", 50);

    const options = mocks.mysqlCreateConnection.mock.calls[0][0];
    expect(options).toEqual(expect.objectContaining({
      host: "database.example",
      ssl: { rejectUnauthorized: true, verifyIdentity: true },
      stream: expect.any(Function),
    }));
    options.stream();
    expect(mocks.netCreateConnection).toHaveBeenCalledWith({
      host: "93.184.216.34",
      port: 3306,
    });
    expect(connection.query).toHaveBeenCalledWith("START TRANSACTION READ ONLY");
    expect(connection.execute).toHaveBeenCalledWith({
      sql: "SELECT id FROM sales LIMIT 50",
      timeout: SQL_QUERY_TIMEOUT_MS,
    });
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.end).toHaveBeenCalledOnce();
  });

  test("rejects an oversized PostgreSQL cell inside the read-only transaction", async () => {
    const unsafe = vi.fn().mockResolvedValue([{
      payload: "x".repeat(SQL_RESULT_MAX_CELL_BYTES + 1),
    }]);
    const begin = vi.fn(async (mode: string, fn: (tx: { unsafe: typeof unsafe }) => unknown) =>
      fn({ unsafe }));
    const end = vi.fn();
    mocks.postgresFactory.mockReturnValue({ begin, end });

    await expect(querySql(
      { ...baseConfig, dialect: "pg" },
      "SELECT payload FROM sales",
      10,
    )).rejects.toThrow(/SQL result cell exceeds/);
    expect(begin).toHaveBeenCalledWith("read only", expect.any(Function));
    expect(end).toHaveBeenCalledOnce();
  });

  test("rejects an oversized MySQL cell before commit and destroys the connection", async () => {
    const connection = {
      query: vi.fn().mockResolvedValue([[], []]),
      execute: vi.fn().mockResolvedValue([[
        { payload: "x".repeat(SQL_RESULT_MAX_CELL_BYTES + 1) },
      ], [{ name: "payload" }]]),
      commit: vi.fn(),
      rollback: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    mocks.mysqlCreateConnection.mockResolvedValue(connection);

    await expect(querySql(
      { ...baseConfig, dialect: "mysql", port: 3306 },
      "SELECT payload FROM sales",
      10,
    )).rejects.toThrow(/SQL result cell exceeds/);
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(connection.end).not.toHaveBeenCalled();
  });

  test("rolls back a failed MySQL read and preserves the original error", async () => {
    const original = new Error("synthetic timeout");
    const connection = {
      query: vi.fn().mockResolvedValue([[], []]),
      execute: vi.fn().mockRejectedValue(original),
      commit: vi.fn(),
      rollback: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    mocks.mysqlCreateConnection.mockResolvedValue(connection);

    await expect(querySql(
      { ...baseConfig, dialect: "mysql", port: 3306 },
      "SELECT id FROM sales",
      50,
    )).rejects.toBe(original);
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.end).not.toHaveBeenCalled();
  });

  test("fails closed instead of weakening TLS for a numeric host", async () => {
    mocks.assertHostAllowed.mockResolvedValue("93.184.216.34");
    await expect(querySql(
      { ...baseConfig, dialect: "pg", host: "93.184.216.34", ssl: true },
      "SELECT id FROM sales",
      50,
    )).rejects.toThrow(/requires a DNS hostname/);
    expect(mocks.postgresFactory).not.toHaveBeenCalled();
  });

  test("hard-stops a hanging MySQL statement without waiting for rollback", async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => undefined);
    const connection = {
      query: vi.fn().mockResolvedValue([[], []]),
      execute: vi.fn().mockReturnValue(never),
      commit: vi.fn(),
      rollback: vi.fn().mockReturnValue(never),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    mocks.mysqlCreateConnection.mockResolvedValue(connection);

    const pending = querySql(
      { ...baseConfig, dialect: "mysql", port: 3306 },
      "SELECT SLEEP(999)",
      50,
    );
    const rejected = expect(pending).rejects.toThrow("operation timed out");
    await vi.advanceTimersByTimeAsync(SQL_QUERY_TIMEOUT_MS + 1);
    await rejected;
    expect(connection.destroy).toHaveBeenCalled();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.end).not.toHaveBeenCalled();
  });

  test("hard-stops a stalled MySQL connect or TLS handshake", async () => {
    vi.useFakeTimers();
    const socket = { destroy: vi.fn() };
    mocks.netCreateConnection.mockReturnValue(socket);
    mocks.mysqlCreateConnection.mockImplementation((options: any) => {
      options.stream();
      return new Promise(() => undefined);
    });

    const pending = querySql(
      { ...baseConfig, dialect: "mysql", port: 3306, ssl: true },
      "SELECT id FROM sales",
      50,
    );
    const rejected = expect(pending).rejects.toThrow("operation timed out");
    await vi.advanceTimersByTimeAsync(SQL_QUERY_TIMEOUT_MS + 1);
    await rejected;
    expect(socket.destroy).toHaveBeenCalled();
  });
});
