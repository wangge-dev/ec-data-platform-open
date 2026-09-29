import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  postgresFactory: vi.fn(),
}));

vi.mock("postgres", () => ({ default: mocks.postgresFactory }));

import {
  executeLocalReadOnlyQuery,
  executeLocalReadOnlyQueryWithMetadata,
  LOCAL_SQL_ACQUIRE_TIMEOUT_MS,
  LOCAL_SQL_MAX_CONCURRENCY,
  LOCAL_SQL_MAX_QUERY_BYTES,
  LOCAL_SQL_MAX_ROWS,
  LOCAL_SQL_STATEMENT_TIMEOUT_MS,
  scopeLocalAnalyticsSql,
} from "../src/lib/local-readonly-sql.js";
import { SQL_RESULT_MAX_CELL_BYTES } from "../src/lib/sql-result-budget.js";

type FakeClient = {
  unsafe: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

function successfulClient(rows: Array<Record<string, unknown>> = []): FakeClient {
  return {
    unsafe: vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([]),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

describe("local user SQL execution boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = "postgres://synthetic:test@127.0.0.1:1/synthetic";
  });

  afterEach(() => vi.useRealTimers());

  test("runs an ordinary SELECT in a timed read-only transaction and always rolls it back", async () => {
    const client = successfulClient([{ id: 1 }]);
    mocks.postgresFactory.mockReturnValue(client);

    await expect(executeLocalReadOnlyQuery(
      "SELECT id FROM user_data.uf_1",
      [],
      { limit: 25 },
    )).resolves.toEqual([{ id: 1 }]);

    expect(mocks.postgresFactory).toHaveBeenCalledWith(
      process.env.DATABASE_URL,
      expect.objectContaining({
        max: 1,
        connection: { statement_timeout: LOCAL_SQL_STATEMENT_TIMEOUT_MS },
      }),
    );
    expect(client.unsafe.mock.calls).toEqual([
      ["BEGIN TRANSACTION READ ONLY"],
      [`SET LOCAL statement_timeout = ${LOCAL_SQL_STATEMENT_TIMEOUT_MS}`],
      ["SET LOCAL search_path = pg_catalog"],
      [
        'SELECT * FROM (SELECT id FROM user_data.uf_1) AS "__local_readonly_result" LIMIT 25',
        [],
      ],
      ["ROLLBACK"],
    ]);
    expect(client.end).toHaveBeenCalledWith({ timeout: 1 });
  });

  test.each([
    { returnedRows: LOCAL_SQL_MAX_ROWS - 1, truncated: false },
    { returnedRows: LOCAL_SQL_MAX_ROWS, truncated: false },
    { returnedRows: LOCAL_SQL_MAX_ROWS + 1, truncated: true },
  ])(
    "distinguishes $returnedRows rows from the $truncated truncation state",
    async ({ returnedRows, truncated }) => {
      const rows = Array.from({ length: returnedRows }, (_, index) => ({ id: index + 1 }));
      const client = successfulClient(rows);
      mocks.postgresFactory.mockReturnValue(client);

      const result = await executeLocalReadOnlyQueryWithMetadata(
        "SELECT id FROM user_data.uf_1",
      );

      expect(result).toEqual({
        rows: rows.slice(0, LOCAL_SQL_MAX_ROWS),
        truncated,
        rowLimit: LOCAL_SQL_MAX_ROWS,
      });
      expect(client.unsafe.mock.calls[3]).toEqual([
        `SELECT * FROM (SELECT id FROM user_data.uf_1) AS "__local_readonly_result" LIMIT ${LOCAL_SQL_MAX_ROWS + 1}`,
        [],
      ]);
    },
  );

  test("keeps slow allowed queries behind the server timeout and closes the failed session", async () => {
    const timeout = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    });
    const client: FakeClient = {
      unsafe: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(timeout)
        .mockResolvedValueOnce([]),
      end: vi.fn().mockResolvedValue(undefined),
    };
    mocks.postgresFactory.mockReturnValue(client);

    await expect(executeLocalReadOnlyQuery(
      "SELECT COUNT(*) FROM user_data.uf_1",
    ))
      .rejects.toBe(timeout);
    expect(client.unsafe.mock.calls.slice(0, 4)).toEqual([
      ["BEGIN TRANSACTION READ ONLY"],
      [`SET LOCAL statement_timeout = ${LOCAL_SQL_STATEMENT_TIMEOUT_MS}`],
      ["SET LOCAL search_path = pg_catalog"],
      [
        `SELECT * FROM (SELECT COUNT(*) FROM user_data.uf_1) AS "__local_readonly_result" LIMIT ${LOCAL_SQL_MAX_ROWS}`,
        [],
      ],
    ]);
    expect(client.unsafe).toHaveBeenLastCalledWith("ROLLBACK");
    expect(client.end).toHaveBeenCalledOnce();
  });

  test.each([
    "SELECT pg_sleep(60)",
    "SELECT pg_advisory_lock(42)",
    "SELECT set_config('search_path', 'attacker', false)",
  ])("blocks session-control function calls before opening a connection: %s", async (query) => {
    await expect(executeLocalReadOnlyQuery(query)).rejects.toThrow(
      "SQL function is not allowed in local analytics queries",
    );
    expect(mocks.postgresFactory).not.toHaveBeenCalled();
  });

  test.each([
    "SELECT username, password_hash FROM public.users",
    "SELECT config FROM public.data_sources",
    "SELECT * FROM user_data.users",
    "SELECT * FROM PUBLIC.USERS",
    'SELECT * FROM "public"."users"',
    'SELECT * FROM "PUBLIC"."unified_sales"',
    "SELECT * FROM pg_catalog.pg_authid",
    "SELECT * FROM information_schema.tables",
    "SELECT * FROM public.analytics_view",
    "SELECT a.id FROM user_data.uf_1 a JOIN public.users u ON u.id = a.id",
    "SELECT * FROM user_data.uf_1, public.module_configs",
    "SELECT * FROM generate_series(1, 10)",
    "SELECT * FROM pg_catalog.pg_get_keywords()",
    "SELECT * FROM (WITH uf_1 AS (SELECT * FROM public.agent_runs) SELECT * FROM uf_1) q",
    "SELECT * FROM (WITH users AS (SELECT username FROM users) SELECT * FROM users) q",
    "SELECT COALESCE((SELECT username FROM public.users LIMIT 1), 'x') FROM user_data.uf_1",
  ])("rejects a non-analytics relation before opening a connection: %s", async (query) => {
    await expect(executeLocalReadOnlyQuery(query)).rejects.toThrow(
      "SQL relation is outside the analytics data scope",
    );
    expect(mocks.postgresFactory).not.toHaveBeenCalled();
  });

  test.each([
    "SELECT repeat('x', 1000000000)",
    "SELECT RePeAt('x', 1000000000)",
    "SELECT pg_catalog.repeat('x', 1000000000)",
    "SELECT public.sum(amount) FROM user_data.uf_1",
    "SELECT generate_series(1, 1000000000)",
    "SELECT json_agg(payload) FROM user_data.uf_1",
    "SELECT jsonb_agg(payload) FROM user_data.uf_1",
    "SELECT string_agg(payload, '') FROM user_data.uf_1",
    "SELECT array_agg(payload) FROM user_data.uf_1",
    "SELECT ROUND(LENGTH(REPEAT('x', 1000000000)))",
    'SELECT "repeat"(\'x\', 1000000000)',
  ])("rejects row/cell-amplifying or non-allowlisted functions: %s", async (query) => {
    await expect(executeLocalReadOnlyQuery(query)).rejects.toThrow(
      "SQL function is not allowed in local analytics queries",
    );
    expect(mocks.postgresFactory).not.toHaveBeenCalled();
  });

  test.each([
    "SELECT payload || payload FROM user_data.uf_1",
    "SELECT ARRAY[payload, payload] FROM user_data.uf_1",
    "SELECT ARRAY(SELECT payload FROM user_data.uf_1)",
  ])("rejects non-function value-amplifying constructs: %s", async (query) => {
    await expect(executeLocalReadOnlyQuery(query)).rejects.toThrow(
      "SQL value-amplifying construct is not allowed in local analytics queries",
    );
    expect(mocks.postgresFactory).not.toHaveBeenCalled();
  });

  test("accepts the bounded aggregate, scalar and date functions used by dashboards", async () => {
    const client = successfulClient([]);
    mocks.postgresFactory.mockReturnValue(client);
    const query = [
      "SELECT * FROM (WITH daily AS (",
      "SELECT DATE_TRUNC('day', paid_at)::date AS day,",
      "pg_catalog.COUNT(*)::int AS orders,",
      "COALESCE(SUM(amount), 0)::numeric AS amount,",
      "ROUND(AVG(amount)::numeric, 2) AS average,",
      "MIN(amount) AS minimum, MAX(amount) AS maximum,",
      "NULLIF(MAX(amount), 0) AS nonzero_maximum,",
      "EXTRACT(DOW FROM paid_at) AS weekday,",
      "LOWER(BTRIM(shop)) AS normalized_shop,",
      "SUBSTRING(TO_CHAR(paid_at, 'YYYY-MM-DD') FROM 1 FOR 10) AS day_text",
      "FROM unified_sales",
      "WHERE (paid_at IS NOT NULL) AND (shop IN ('a', 'b'))",
      "GROUP BY 1, 9, 10",
      ") SELECT * FROM daily) AS report",
    ].join(" ");

    await expect(executeLocalReadOnlyQuery(query)).resolves.toEqual([]);
    expect(client.unsafe.mock.calls[3]?.[0]).toContain(
      'FROM "public"."unified_sales"',
    );
  });

  test("rejects oversized SQL text before opening a connection", async () => {
    const query = `SELECT '${"x".repeat(LOCAL_SQL_MAX_QUERY_BYTES)}'`;
    await expect(executeLocalReadOnlyQuery(query)).rejects.toThrow(
      `local SQL query exceeds ${LOCAL_SQL_MAX_QUERY_BYTES} bytes`,
    );
    await expect(executeLocalReadOnlyQuery(
      `SELECT 1${" ".repeat(LOCAL_SQL_MAX_QUERY_BYTES)}`,
    )).rejects.toThrow(
      `local SQL query exceeds ${LOCAL_SQL_MAX_QUERY_BYTES} bytes`,
    );
    expect(mocks.postgresFactory).not.toHaveBeenCalled();
  });

  test("accepts and pins only product analytics relations", () => {
    expect(scopeLocalAnalyticsSql("SELECT * FROM user_data.uf_42")).toBe(
      "SELECT * FROM user_data.uf_42",
    );
    expect(scopeLocalAnalyticsSql('SELECT * FROM "user_data"."unified_ads"')).toBe(
      'SELECT * FROM "user_data"."unified_ads"',
    );
    expect(scopeLocalAnalyticsSql("SELECT * FROM public.unified_sales")).toBe(
      "SELECT * FROM public.unified_sales",
    );
    expect(scopeLocalAnalyticsSql("SELECT * FROM unified_inventory")).toBe(
      'SELECT * FROM "user_data"."unified_inventory"',
    );
    expect(scopeLocalAnalyticsSql("SELECT * FROM unified_sales")).toBe(
      'SELECT * FROM "public"."unified_sales"',
    );
    expect(scopeLocalAnalyticsSql(
      "SELECT a.id FROM uf_7 a JOIN unified_cost c ON c.id = a.id",
    )).toBe(
      'SELECT a.id FROM "user_data"."uf_7" a JOIN "user_data"."unified_cost" c ON c.id = a.id',
    );
    expect(scopeLocalAnalyticsSql(
      "SELECT * FROM (WITH recent AS (SELECT * FROM user_data.uf_9) SELECT * FROM recent) q",
    )).toBe(
      "SELECT * FROM (WITH recent AS (SELECT * FROM user_data.uf_9) SELECT * FROM recent) q",
    );
  });

  test("enforces an absolute outer row cap even when the inner SQL has a larger LIMIT", async () => {
    const client = successfulClient([]);
    mocks.postgresFactory.mockReturnValue(client);

    await executeLocalReadOnlyQuery(
      "SELECT * FROM user_data.uf_1 LIMIT 999999",
      [],
      { limit: 999999 },
    );

    expect(client.unsafe).toHaveBeenNthCalledWith(
      4,
      `SELECT * FROM (SELECT * FROM user_data.uf_1 LIMIT 999999) AS "__local_readonly_result" LIMIT ${LOCAL_SQL_MAX_ROWS}`,
      [],
    );
  });

  test("rejects an oversized cell before returning and still closes the session", async () => {
    const client = successfulClient([{
      payload: "x".repeat(SQL_RESULT_MAX_CELL_BYTES + 1),
    }]);
    mocks.postgresFactory.mockReturnValue(client);

    await expect(executeLocalReadOnlyQuery("SELECT payload FROM user_data.uf_1"))
      .rejects.toThrow(/SQL result cell exceeds/);

    expect(client.unsafe).toHaveBeenLastCalledWith("ROLLBACK");
    expect(client.end).toHaveBeenCalledWith({ timeout: 1 });
  });

  test("limits concurrent dedicated clients and times out waiting for a slot", async () => {
    vi.useFakeTimers();
    const deferred = Array.from({ length: LOCAL_SQL_MAX_CONCURRENCY }, () => {
      let resolve!: (rows: Array<Record<string, unknown>>) => void;
      const promise = new Promise<Array<Record<string, unknown>>>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    });
    const clients = deferred.map((pending) => {
      let call = 0;
      const client: FakeClient = {
        unsafe: vi.fn(() => {
          call++;
          if (call <= 3 || call === 5) return Promise.resolve([]);
          return pending.promise;
        }),
        end: vi.fn().mockResolvedValue(undefined),
      };
      return client;
    });
    clients.forEach((client) => mocks.postgresFactory.mockReturnValueOnce(client));

    const running = Array.from({ length: LOCAL_SQL_MAX_CONCURRENCY }, (_, index) =>
      executeLocalReadOnlyQuery(`SELECT ${index}`));
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(mocks.postgresFactory).toHaveBeenCalledTimes(LOCAL_SQL_MAX_CONCURRENCY);

    const waiting = executeLocalReadOnlyQuery("SELECT 99");
    const rejected = expect(waiting).rejects.toThrow(
      "local SQL concurrency acquisition timed out",
    );
    await vi.advanceTimersByTimeAsync(LOCAL_SQL_ACQUIRE_TIMEOUT_MS + 1);
    await rejected;
    expect(mocks.postgresFactory).toHaveBeenCalledTimes(LOCAL_SQL_MAX_CONCURRENCY);

    deferred.forEach((pending) => pending.resolve([]));
    await Promise.all(running);
  });

  test("routes every local user-controlled SQL entry through the sole helper", () => {
    const sourceRoot = resolve(import.meta.dirname, "../src");
    const board = readFileSync(resolve(sourceRoot, "routes/board.ts"), "utf8");
    const agents = readFileSync(resolve(sourceRoot, "routes/agents.ts"), "utf8");
    const alerts = readFileSync(resolve(sourceRoot, "modules/alerts-engine.ts"), "utf8");

    // All board execution paths use the bounded metadata helper. New previews,
    // chart bundles, and AI charts compile semantic IDs on the server; no AI SQL
    // is accepted or executed directly.
    expect(board.match(/await executeLocalReadOnlyQuery\(/g) ?? []).toHaveLength(0);
    expect(board.match(/await executeLocalReadOnlyQueryWithMetadata\(/g)).toHaveLength(4);
    expect(board).not.toContain("executeLocalReadOnlyQuery(finalSpec.sql");
    expect(board).toContain('queryType: z.literal("semantic")');
    expect(board).toContain("compileSemanticQuery(semanticQuery, models)");
    expect(board).toContain("aggregationSql.queryText");
    expect(board.match(/renderSql\.parameters/g)).toHaveLength(1);
    expect(board).not.toMatch(/sql\.unsafe\(\s*withLimit/);
    expect(board).not.toContain("sql.unsafe(limited)");

    // Agent-provided dataset SQL and module alert rule SQL.
    expect(agents).toContain("executeLocalReadOnlyQuery(datasetSql");
    expect(agents).not.toContain("sql.unsafe(withLimit(ensureReadOnly(datasetSql)");
    expect(alerts).toContain("executeLocalReadOnlyQuery(ruleSql)");
    expect(alerts).not.toContain("sql.unsafe(ruleSql)");
  });
});
