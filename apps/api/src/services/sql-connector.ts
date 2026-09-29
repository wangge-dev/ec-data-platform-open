// 外部 SQL 连接器：测连接 / 列表 / 跑 SELECT
import postgres from "postgres";
import mysql from "mysql2/promise";
import net from "node:net";
import { ensureReadOnly, withLimit } from "../lib/sql-guard";
import { assertHostAllowed } from "../lib/host-guard";
import { assertSqlResultWithinBudget } from "../lib/sql-result-budget.js";

export type SqlDialect = "pg" | "mysql";

export type SqlConfig = {
  dialect: SqlDialect;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
};

export type ColumnInfo = { name: string; type: string };

export const SQL_QUERY_TIMEOUT_MS = 5_000;

function originalHost(cfg: SqlConfig): string {
  return cfg.host.trim().replace(/^\[|\]$/g, "");
}

function verifiedTlsServerName(cfg: SqlConfig): string | undefined {
  if (!cfg.ssl) return undefined;
  const servername = originalHost(cfg);
  if (net.isIP(servername)) {
    throw new Error("verified SQL TLS requires a DNS hostname that matches the server certificate");
  }
  return servername;
}

function pgOptions(cfg: SqlConfig, host: string) {
  const servername = verifiedTlsServerName(cfg);
  return {
    host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    max: 1,
    connect_timeout: 5,
    connection: { statement_timeout: SQL_QUERY_TIMEOUT_MS },
    ssl: cfg.ssl ? { rejectUnauthorized: true, servername } : undefined,
  };
}

function mysqlOptions(
  cfg: SqlConfig,
  host: string,
  onSocket?: (socket: ReturnType<typeof net.createConnection>) => void,
) {
  const servername = verifiedTlsServerName(cfg);
  return {
    // mysql2 derives SNI/identity verification from config.host. Keep the
    // original DNS name there, but supply a custom TCP stream pinned to the
    // address already approved by host-guard.
    host: originalHost(cfg),
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    connectTimeout: SQL_QUERY_TIMEOUT_MS,
    stream: () => {
      const socket = net.createConnection({ host, port: cfg.port });
      onSocket?.(socket);
      return socket;
    },
    ssl: cfg.ssl ? {
      rejectUnauthorized: true,
      verifyIdentity: true,
    } : undefined,
  };
}

function withHardTimeout<T>(
  operation: Promise<T>,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        onTimeout();
      } catch {
        // Preserve the stable timeout error even if cleanup itself fails.
      }
      reject(new Error("external SQL operation timed out"));
    }, SQL_QUERY_TIMEOUT_MS);
    timer.unref?.();

    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type MysqlConnection = Awaited<ReturnType<typeof mysql.createConnection>>;

async function createMysqlConnection(cfg: SqlConfig, host: string): Promise<MysqlConnection> {
  let socket: ReturnType<typeof net.createConnection> | undefined;
  let timedOut = false;
  const pending = mysql.createConnection(mysqlOptions(cfg, host, (created) => {
    socket = created;
  }));
  // A mocked or unusual driver can resolve after the watchdog fired. Ensure a
  // late connection is destroyed rather than becoming an orphan.
  void pending.then((connection) => {
    if (timedOut) connection.destroy();
  }, () => undefined);
  try {
    return await withHardTimeout(pending, () => {
      timedOut = true;
      socket?.destroy();
    });
  } catch (error) {
    if (timedOut) socket?.destroy();
    throw error;
  }
}

async function withMysqlConnection<T>(
  cfg: SqlConfig,
  host: string,
  operation: (connection: MysqlConnection) => Promise<T>,
): Promise<T> {
  const connection = await createMysqlConnection(cfg, host);
  try {
    const result = await withHardTimeout(
      Promise.resolve().then(() => operation(connection)),
      () => connection.destroy(),
    );
    await withHardTimeout(Promise.resolve(connection.end()), () => connection.destroy());
    return result;
  } catch (error) {
    // This connection is single-use. Destroying it immediately aborts any
    // active statement and makes the open transaction roll back server-side;
    // awaiting a queued ROLLBACK could otherwise hang behind that statement.
    connection.destroy();
    throw error;
  }
}

export async function testConnection(cfg: SqlConfig): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const host = await assertHostAllowed(cfg.host);
    if (cfg.dialect === "pg") {
      const sql = postgres(pgOptions(cfg, host));
      try {
        const [r] = await sql<any[]>`SELECT version()`;
        return { ok: true, version: r.version };
      } finally {
        await sql.end();
      }
    } else {
      return await withMysqlConnection(cfg, host, async (conn) => {
        const [rows] = await conn.execute({
          sql: "SELECT VERSION() AS version",
          timeout: SQL_QUERY_TIMEOUT_MS,
        });
        return { ok: true, version: (rows as any[])[0].version };
      });
    }
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export async function listTables(cfg: SqlConfig): Promise<Array<{ schema: string; name: string }>> {
  const host = await assertHostAllowed(cfg.host);
  if (cfg.dialect === "pg") {
    const sql = postgres(pgOptions(cfg, host));
    try {
      const rows = await sql<any[]>`
        SELECT table_schema AS schema, table_name AS name
        FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog','information_schema')
          AND table_type='BASE TABLE'
        ORDER BY table_schema, table_name
      `;
      return rows;
    } finally {
      await sql.end();
    }
  } else {
    return await withMysqlConnection(cfg, host, async (conn) => {
      const [rows] = await conn.execute(
        {
          sql: `SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name
         FROM information_schema.tables
         WHERE TABLE_SCHEMA = ?
         ORDER BY TABLE_NAME`,
          timeout: SQL_QUERY_TIMEOUT_MS,
        },
        [cfg.database],
      );
      return rows as any[];
    });
  }
}

export async function querySql(
  cfg: SqlConfig,
  sqlText: string,
  limit = 100,
): Promise<{ rows: any[]; columns: string[] }> {
  const host = await assertHostAllowed(cfg.host);
  const safe = ensureReadOnly(sqlText);
  const limited = withLimit(safe, limit);
  if (cfg.dialect === "pg") {
    const sql = postgres(pgOptions(cfg, host));
    try {
      return await sql.begin("read only", async (transaction) => {
        const rows = (await transaction.unsafe(limited)) as any[];
        const columns = rows.length ? Object.keys(rows[0]) : [];
        assertSqlResultWithinBudget(rows, { columns });
        return { rows, columns };
      });
    } finally {
      await sql.end();
    }
  } else {
    return await withMysqlConnection(cfg, host, async (conn) => {
      await conn.query("START TRANSACTION READ ONLY");
      const [rows, fields] = await conn.execute({
        sql: limited,
        timeout: SQL_QUERY_TIMEOUT_MS,
      });
      const cols = (fields as any[]).map((f) => f.name);
      const resultRows = rows as any[];
      assertSqlResultWithinBudget(resultRows, { columns: cols });
      await conn.commit();
      return { rows: resultRows, columns: cols };
    });
  }
}
