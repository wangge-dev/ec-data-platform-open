import postgres from "postgres";

import { ensureReadOnly } from "./sql-guard.js";
import { assertSqlResultWithinBudget } from "./sql-result-budget.js";

export const LOCAL_SQL_STATEMENT_TIMEOUT_MS = 5_000;
export const LOCAL_SQL_MAX_ROWS = 5_000;
export const LOCAL_SQL_MAX_CONCURRENCY = 4;
export const LOCAL_SQL_ACQUIRE_TIMEOUT_MS = 1_000;
export const LOCAL_SQL_MAX_WAITERS = 32;
export const LOCAL_SQL_MAX_QUERY_BYTES = 64 * 1024;

const USER_DATA_RELATION = /^(?:uf_\d+|unified_[a-z][a-z0-9_]*)$/;
const PUBLIC_ANALYSIS_RELATIONS = new Set([
  "unified_sales",
  "unified_shopee_sales",
]);

type SqlToken = {
  kind: "word" | "quoted" | "string" | "number" | "parameter" | "symbol";
  value: string;
  start: number;
  end: number;
};

type Replacement = { start: number; end: number; text: string };

const FROM_CLAUSE_END = new Set([
  "where", "group", "having", "window", "order", "limit", "offset",
  "fetch", "for", "union", "intersect", "except",
]);

// Local SQL is used by dashboards, alert rules and AI-authored analysis. Keep
// the callable surface intentionally small: the row cap cannot protect the
// process when the PostgreSQL driver first materializes one giant value (for
// example repeat(...), json_agg(...) or string_agg(...)).
const ALLOWED_LOCAL_SQL_FUNCTIONS = new Set([
  // Aggregates used by the chart builders and ordinary analysis queries.
  "count", "sum", "avg", "min", "max",
  // Null handling and bounded scalar calculations.
  "coalesce", "nullif", "greatest", "least", "cast",
  "abs", "round", "ceil", "ceiling", "floor", "trunc",
  // Date grouping and presentation used by the dashboard query templates.
  "date", "date_trunc", "date_part", "extract", "now", "to_char", "to_number",
  // Non-expanding or reducing text helpers.
  "lower", "upper", "btrim", "ltrim", "rtrim", "length", "char_length",
  "left", "right", "substring",
]);

// These words may legally precede a parenthesized SQL expression but are not
// function calls. Deliberately omit FILTER/OVER/ARRAY/ROW and other optional
// constructs; the built-in dashboard queries do not need them and rejecting
// them keeps the execution surface conservative.
const PARENTHESIZED_SQL_SYNTAX = new Set([
  "and", "as", "by", "case", "distinct", "else", "except", "exists",
  "from", "having", "in", "intersect", "join", "lateral", "materialized",
  "not", "on", "or", "select", "then", "union", "using", "when", "where",
]);

const UNQUALIFIABLE_SQL_FORMS = new Set([
  "cast", "coalesce", "extract", "greatest", "least", "nullif",
]);

function sqlScopeError(): Error {
  return new Error("SQL relation is outside the analytics data scope");
}

function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === "'") {
      const start = i++;
      let value = "";
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          value += "'";
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          closed = true;
          break;
        } else {
          value += sql[i++];
        }
      }
      if (!closed) throw sqlScopeError();
      tokens.push({ kind: "string", value, start, end: i });
      continue;
    }

    if (ch === '"') {
      const start = i++;
      let value = "";
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (sql[i] === '"') {
          i++;
          closed = true;
          break;
        } else {
          value += sql[i++];
        }
      }
      if (!closed) throw sqlScopeError();
      tokens.push({ kind: "quoted", value, start, end: i });
      continue;
    }

    if (ch === "$") {
      const rest = sql.slice(i);
      const dollarQuote = rest.match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (dollarQuote) {
        const start = i;
        const close = sql.indexOf(dollarQuote, i + dollarQuote.length);
        if (close < 0) throw sqlScopeError();
        i = close + dollarQuote.length;
        tokens.push({ kind: "string", value: "", start, end: i });
        continue;
      }
      const parameter = rest.match(/^\$\d+/)?.[0];
      if (parameter) {
        tokens.push({ kind: "parameter", value: parameter, start: i, end: i + parameter.length });
        i += parameter.length;
        continue;
      }
    }

    if (/[A-Za-z_]/.test(ch)) {
      const start = i++;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      tokens.push({ kind: "word", value: sql.slice(start, i), start, end: i });
      continue;
    }

    if (/\d/.test(ch)) {
      const start = i++;
      while (i < sql.length && /[0-9.]/.test(sql[i])) i++;
      tokens.push({ kind: "number", value: sql.slice(start, i), start, end: i });
      continue;
    }

    tokens.push({ kind: "symbol", value: ch, start: i, end: i + 1 });
    i++;
  }
  return tokens;
}

function word(token: SqlToken | undefined, expected?: string): boolean {
  if (token?.kind !== "word") return false;
  return expected === undefined || token.value.toLowerCase() === expected;
}

function identifier(token: SqlToken | undefined): string | null {
  if (!token || (token.kind !== "word" && token.kind !== "quoted")) return null;
  return token.kind === "word" ? token.value.toLowerCase() : token.value;
}

function assertLocalSqlQuerySize(sql: string): void {
  if (Buffer.byteLength(sql, "utf8") > LOCAL_SQL_MAX_QUERY_BYTES) {
    throw new Error(
      `local SQL query exceeds ${LOCAL_SQL_MAX_QUERY_BYTES} bytes`,
    );
  }
}

function assertAllowedLocalSqlFunctions(tokens: SqlToken[]): void {
  for (let open = 1; open < tokens.length; open += 1) {
    if (tokens[open].value !== "(") continue;

    const nameToken = tokens[open - 1];
    const name = identifier(nameToken);
    if (!name) continue;
    const normalizedName = nameToken.kind === "word"
      ? name.toLowerCase()
      : name;

    if (
      nameToken.kind === "word"
      && PARENTHESIZED_SQL_SYNTAX.has(normalizedName)
    ) {
      continue;
    }

    const parts = [normalizedName];
    let cursor = open - 1;
    while (tokens[cursor - 1]?.value === ".") {
      const qualifierToken = tokens[cursor - 2];
      const qualifier = identifier(qualifierToken);
      if (!qualifier || !qualifierToken) break;
      parts.unshift(
        qualifierToken.kind === "word" ? qualifier.toLowerCase() : qualifier,
      );
      cursor -= 2;
    }

    const unqualified = parts.length === 1;
    const pgCatalogQualified = parts.length === 2
      && parts[0] === "pg_catalog"
      && !UNQUALIFIABLE_SQL_FORMS.has(normalizedName);
    const canonicalIdentifiers = parts.every((part) => part === part.toLowerCase());
    if (
      !canonicalIdentifiers
      || (!unqualified && !pgCatalogQualified)
      || !ALLOWED_LOCAL_SQL_FUNCTIONS.has(normalizedName)
    ) {
      const displayName = parts.join(".").replace(/[^a-zA-Z0-9_$.]/g, "?").slice(0, 96);
      throw new Error(
        `SQL function is not allowed in local analytics queries: ${displayName}`,
      );
    }
  }
}

function assertNoAmplifyingSqlConstructs(tokens: SqlToken[]): void {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value === "|" && tokens[index + 1]?.value === "|") {
      throw new Error(
        "SQL value-amplifying construct is not allowed in local analytics queries: ||",
      );
    }
    if (
      word(tokens[index], "array")
      && (tokens[index + 1]?.value === "[" || tokens[index + 1]?.value === "(")
    ) {
      throw new Error(
        "SQL value-amplifying construct is not allowed in local analytics queries: ARRAY",
      );
    }
  }
}

function matchingParen(tokens: SqlToken[], open: number, end: number): number {
  let depth = 0;
  for (let i = open; i < end; i++) {
    if (tokens[i].value === "(") depth++;
    else if (tokens[i].value === ")" && --depth === 0) return i;
  }
  throw sqlScopeError();
}

function startsQuery(tokens: SqlToken[], start: number, end: number): boolean {
  while (start < end && tokens[start].value === "(") {
    const close = matchingParen(tokens, start, end);
    if (close !== end - 1) break;
    start++;
    end = close;
  }
  return word(tokens[start], "select") || word(tokens[start], "with");
}

function qualifyRelation(
  parts: string[],
  token: SqlToken,
  visibleCtes: Set<string>,
  replacements: Replacement[],
): void {
  if (parts.length === 1 && visibleCtes.has(parts[0])) return;

  if (parts.length === 1) {
    const name = parts[0];
    const schema = PUBLIC_ANALYSIS_RELATIONS.has(name)
      ? "public"
      : USER_DATA_RELATION.test(name)
        ? "user_data"
        : null;
    if (!schema) throw new Error(
      `SQL relation is outside the analytics data scope: ${name}`,
    );
    replacements.push({
      start: token.start,
      end: token.end,
      text: `"${schema}"."${name}"`,
    });
    return;
  }

  if (parts.length !== 2) throw sqlScopeError();
  const [schema, name] = parts;
  const allowed = schema === "user_data"
    ? USER_DATA_RELATION.test(name)
    : schema === "public" && PUBLIC_ANALYSIS_RELATIONS.has(name);
  if (!allowed) throw new Error(
    `SQL relation is outside the analytics data scope: ${schema}.${name}`,
  );
}

function parseLeadingCtes(
  tokens: SqlToken[],
  start: number,
  end: number,
  inheritedCtes: Set<string>,
  replacements: Replacement[],
): { cursor: number; ctes: Set<string> } {
  if (!word(tokens[start], "with")) {
    return { cursor: start, ctes: new Set(inheritedCtes) };
  }

  let cursor = start + 1;
  const recursive = word(tokens[cursor], "recursive");
  if (recursive) cursor++;
  const definitions: Array<{
    start: number;
    end: number;
    visibleBefore: Set<string>;
  }> = [];
  const ctes = new Set(inheritedCtes);

  while (cursor < end) {
    const name = identifier(tokens[cursor]);
    if (!name) throw sqlScopeError();
    const visibleBefore = new Set(ctes);
    cursor++;

    if (tokens[cursor]?.value === "(") {
      cursor = matchingParen(tokens, cursor, end) + 1;
    }
    if (!word(tokens[cursor], "as")) throw sqlScopeError();
    cursor++;
    if (word(tokens[cursor], "not") && word(tokens[cursor + 1], "materialized")) cursor += 2;
    else if (word(tokens[cursor], "materialized")) cursor++;
    if (tokens[cursor]?.value !== "(") throw sqlScopeError();
    const close = matchingParen(tokens, cursor, end);
    definitions.push({ start: cursor + 1, end: close, visibleBefore });
    ctes.add(name);
    cursor = close + 1;
    if (tokens[cursor]?.value !== ",") break;
    cursor++;
  }

  for (const definition of definitions) {
    analyzeQueryRange(
      tokens,
      definition.start,
      definition.end,
      recursive ? ctes : definition.visibleBefore,
      replacements,
    );
  }
  return { cursor, ctes };
}

function parseRelation(
  tokens: SqlToken[],
  start: number,
  end: number,
  visibleCtes: Set<string>,
  replacements: Replacement[],
): number {
  while (word(tokens[start], "only") || word(tokens[start], "lateral")) start++;

  if (tokens[start]?.value === "(") {
    const close = matchingParen(tokens, start, end);
    if (!startsQuery(tokens, start + 1, close)) throw sqlScopeError();
    analyzeQueryRange(tokens, start + 1, close, visibleCtes, replacements);
    return close + 1;
  }

  const firstToken = tokens[start];
  const first = identifier(firstToken);
  if (!first || !firstToken) throw sqlScopeError();
  const parts = [first];
  let cursor = start + 1;
  let lastToken = firstToken;
  while (tokens[cursor]?.value === ".") {
    const partToken = tokens[cursor + 1];
    const part = identifier(partToken);
    if (!part || !partToken) throw sqlScopeError();
    parts.push(part);
    lastToken = partToken;
    cursor += 2;
  }
  if (tokens[cursor]?.value === "(") throw sqlScopeError();

  qualifyRelation(
    parts,
    { ...firstToken, end: lastToken.end },
    visibleCtes,
    replacements,
  );
  return cursor;
}

function analyzeNestedQueryRanges(
  tokens: SqlToken[],
  start: number,
  end: number,
  visibleCtes: Set<string>,
  replacements: Replacement[],
): void {
  for (let i = start; i < end;) {
    if (tokens[i].value !== "(") {
      i++;
      continue;
    }
    const close = matchingParen(tokens, i, end);
    if (startsQuery(tokens, i + 1, close)) {
      analyzeQueryRange(tokens, i + 1, close, visibleCtes, replacements);
    } else {
      analyzeNestedQueryRanges(tokens, i + 1, close, visibleCtes, replacements);
    }
    i = close + 1;
  }
}

function analyzeQueryRange(
  tokens: SqlToken[],
  start: number,
  end: number,
  inheritedCtes: Set<string>,
  replacements: Replacement[],
): void {
  const leading = parseLeadingCtes(tokens, start, end, inheritedCtes, replacements);
  const visibleCtes = leading.ctes;
  let inFrom = false;
  let expectRelation = false;

  for (let i = leading.cursor; i < end;) {
    const token = tokens[i];
    if (expectRelation) {
      i = parseRelation(tokens, i, end, visibleCtes, replacements);
      expectRelation = false;
      continue;
    }
    if (token.value === "(") {
      const close = matchingParen(tokens, i, end);
      if (startsQuery(tokens, i + 1, close)) {
        analyzeQueryRange(tokens, i + 1, close, visibleCtes, replacements);
      } else {
        analyzeNestedQueryRanges(tokens, i + 1, close, visibleCtes, replacements);
      }
      i = close + 1;
      continue;
    }

    if (word(token, "from") || word(token, "join")) {
      inFrom = true;
      expectRelation = true;
      i++;
      continue;
    }
    if (inFrom && word(token) && FROM_CLAUSE_END.has(token.value.toLowerCase())) {
      inFrom = false;
    } else if (inFrom && token.value === ",") {
      expectRelation = true;
    }
    i++;
  }
  if (expectRelation) throw sqlScopeError();
}

export function scopeLocalAnalyticsSql(sql: string): string {
  assertLocalSqlQuerySize(sql);
  const tokens = tokenizeSql(sql);
  const replacements: Replacement[] = [];
  analyzeQueryRange(tokens, 0, tokens.length, new Set(), replacements);
  assertNoAmplifyingSqlConstructs(tokens);
  assertAllowedLocalSqlFunctions(tokens);
  return replacements
    .sort((a, b) => b.start - a.start)
    .reduce(
      (result, replacement) =>
        result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end),
      sql,
    );
}

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

let activeQueries = 0;
const queryWaiters: Waiter[] = [];

function releaseQuerySlot(): void {
  const waiter = queryWaiters.shift();
  if (waiter) {
    clearTimeout(waiter.timer);
    waiter.resolve(releaseQuerySlot);
    return;
  }
  activeQueries--;
}

function acquireQuerySlot(): Promise<() => void> {
  if (activeQueries < LOCAL_SQL_MAX_CONCURRENCY) {
    activeQueries++;
    return Promise.resolve(releaseQuerySlot);
  }
  if (queryWaiters.length >= LOCAL_SQL_MAX_WAITERS) {
    return Promise.reject(new Error("local SQL concurrency queue is full"));
  }
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = queryWaiters.indexOf(waiter);
        if (index >= 0) queryWaiters.splice(index, 1);
        reject(new Error("local SQL concurrency acquisition timed out"));
      }, LOCAL_SQL_ACQUIRE_TIMEOUT_MS),
    };
    waiter.timer.unref?.();
    queryWaiters.push(waiter);
  });
}

export type LocalReadOnlyQueryOptions = {
  limit?: number;
};

export type LocalReadOnlyQueryResult<T extends Record<string, unknown>> = {
  rows: T[];
  truncated: boolean;
  rowLimit: number;
};

function localSqlRowLimit(options: LocalReadOnlyQueryOptions): number {
  const requestedLimit = options.limit ?? LOCAL_SQL_MAX_ROWS;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
    throw new Error("local SQL row limit must be a positive safe integer");
  }
  return Math.min(requestedLimit, LOCAL_SQL_MAX_ROWS);
}

async function executeLocalReadOnlyRows<T extends Record<string, unknown>>(
  queryText: string,
  parameters: unknown[],
  databaseRowLimit: number,
): Promise<T[]> {
  assertLocalSqlQuerySize(queryText);
  const safe = ensureReadOnly(queryText);
  const scoped = scopeLocalAnalyticsSql(safe);
  const query = `SELECT * FROM (${scoped}) AS "__local_readonly_result" LIMIT ${databaseRowLimit}`;

  const releaseSlot = await acquireQuerySlot();
  let client: ReturnType<typeof postgres> | undefined;

  let transactionStarted = false;
  let operationFailed = false;
  let cleanupError: unknown;

  try {
    client = postgres(process.env.DATABASE_URL!, {
      max: 1,
      connect_timeout: 5,
      idle_timeout: 1,
      connection: { statement_timeout: LOCAL_SQL_STATEMENT_TIMEOUT_MS },
    });
    await client.unsafe("BEGIN TRANSACTION READ ONLY");
    transactionStarted = true;
    await client.unsafe(
      `SET LOCAL statement_timeout = ${LOCAL_SQL_STATEMENT_TIMEOUT_MS}`,
    );
    // Relations have already been schema-qualified above. Keeping only
    // pg_catalog on the path prevents a same-named public/user_data overload
    // from shadowing an allowlisted built-in function.
    await client.unsafe("SET LOCAL search_path = pg_catalog");
    const rows = (await client.unsafe(query, parameters as any[])) as T[];
    assertSqlResultWithinBudget(rows);
    return rows;
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    if (client && transactionStarted) {
      try {
        await client.unsafe("ROLLBACK");
      } catch (error) {
        cleanupError = error;
      }
    }

    if (client) {
      try {
        await client.end({ timeout: 1 });
      } catch (error) {
        cleanupError ??= error;
      }
    }
    releaseSlot();

    if (!operationFailed && cleanupError !== undefined) {
      throw cleanupError;
    }
  }
}

/**
 * Execute user-controlled SQL against the local PostgreSQL database without
 * borrowing a session from the application's shared pool.
 *
 * A fresh one-connection client is deliberately closed after every query.
 * ROLLBACK clears transaction-local state, while closing the session also
 * releases session advisory locks and settings created through set_config.
 */
export async function executeLocalReadOnlyQuery<T extends Record<string, unknown> = Record<string, unknown>>(
  queryText: string,
  parameters: unknown[] = [],
  options: LocalReadOnlyQueryOptions = {},
): Promise<T[]> {
  const rowLimit = localSqlRowLimit(options);
  return executeLocalReadOnlyRows<T>(queryText, parameters, rowLimit);
}

/**
 * Execute one extra probe row so callers can prove whether the returned rows
 * are complete. The public row cap remains unchanged; the probe row is never
 * included in the returned payload.
 */
export async function executeLocalReadOnlyQueryWithMetadata<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  queryText: string,
  parameters: unknown[] = [],
  options: LocalReadOnlyQueryOptions = {},
): Promise<LocalReadOnlyQueryResult<T>> {
  const rowLimit = localSqlRowLimit(options);
  const probedRows = await executeLocalReadOnlyRows<T>(
    queryText,
    parameters,
    rowLimit + 1,
  );
  return {
    rows: probedRows.slice(0, rowLimit),
    truncated: probedRows.length > rowLimit,
    rowLimit,
  };
}
