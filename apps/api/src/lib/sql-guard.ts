// SQL 安全工具：只读校验 + 安全追加 LIMIT
// 全站唯一实现，board / agents / sql-connector 一律复用，避免多份黑名单标准漂移。

// 写操作关键词黑名单（含 pg/mysql 特有的隐式写：select into / copy / merge / call / do 等）
const WRITE_KEYWORDS =
  /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|merge|copy|into|call|do|vacuum|comment|replace|lock|reindex|cluster|analyze)\b/i;

/**
 * 只读校验：必须以 SELECT 开头、不含写关键词、不含多语句分号。
 * - 仅允许单条语句：去掉行尾分号后，串内若仍有 `;` 视为多语句直接拒（防 `SELECT 1; DROP ...`）。
 *   代价是字符串字面量里含分号的查询也会被拒，对内部 BI 场景可接受。
 */
export function ensureReadOnly(s: string): string {
  const trimmed = s.trim().replace(/;+\s*$/, "");
  if (!/^select\s/i.test(trimmed)) {
    throw new Error("仅支持 SELECT 查询");
  }
  if (trimmed.includes(";")) {
    throw new Error("禁止多语句查询");
  }
  // Appending a LIMIT is unsafe when a line comment can swallow it. Reject
  // comments entirely instead of attempting dialect-specific SQL rewriting.
  if (/--|#|\/\*|\*\//.test(trimmed)) {
    throw new Error("SQL comments are not allowed");
  }
  if (WRITE_KEYWORDS.test(trimmed)) {
    throw new Error("禁止修改类操作");
  }
  return trimmed;
}

// 安全追加/收紧 LIMIT：保留已有 offset，但返回行数不得超过上限 n。
export function withLimit(s: string, n: number): string {
  const trimmed = s.trim().replace(/;+\s*$/, "");

  const postgresLimit = /(\blimit\s+)(\d+)(\s+offset\s+\d+)?$/i;
  const postgresMatch = trimmed.match(postgresLimit);
  if (postgresMatch) {
    const existing = Number(postgresMatch[2]);
    if (existing <= n) return trimmed;
    return trimmed.replace(
      postgresLimit,
      (_match, prefix: string, _count: string, offset = "") =>
        `${prefix}${n}${offset}`,
    );
  }

  const mysqlLimit = /(\blimit\s+\d+\s*,\s*)(\d+)$/i;
  const mysqlMatch = trimmed.match(mysqlLimit);
  if (mysqlMatch) {
    const existing = Number(mysqlMatch[2]);
    if (existing <= n) return trimmed;
    return trimmed.replace(
      mysqlLimit,
      (_match, prefix: string) => `${prefix}${n}`,
    );
  }

  return `${trimmed} LIMIT ${n}`;
}

/**
 * V0.27：computed expression 白名单校验
 * 模块 JSON 的 computed.expression 现在直接拼进 UPDATE SQL（default-transform.ts），
 * 若模块 JSON 可信（开发者维护）可接受，但 AI 生成模块落盘前必须校验。
 * 只允许：列名(双引号)、数字、四则/比较运算符、括号、::类型转换、有限函数白名单。
 */
const WRITE_KW = /\b(insert|update|delete|drop|create|alter|truncate|grant|revoke|merge|copy|into|do|call|set|from|where|select|table|schema)\b/i;
const ALLOWED_EXPRESSION_FUNCTIONS = new Set([
  "COALESCE", "NULLIF", "CAST", "ABS", "ROUND", "GREATEST", "LEAST",
  "FLOOR", "CEIL", "CEILING", "TO_CHAR", "TO_NUMBER", "DATE_PART",
  "EXTRACT", "NOW",
]);
const ALLOWED_EXPRESSION_WORDS = new Set([
  ...ALLOWED_EXPRESSION_FUNCTIONS,
  "CASE", "WHEN", "THEN", "ELSE", "END", "NULL", "TRUE", "FALSE",
  "AND", "OR", "NOT", "IS", "AS",
  "NUMERIC", "INTEGER", "INT", "TEXT", "BOOLEAN", "DATE", "TIMESTAMP",
  "FLOAT", "REAL",
]);

export function validateExpression(
  expr: string,
  allowedIdentifiers?: Iterable<string>,
): { ok: boolean; reason?: string } {
  const e = expr.trim();
  if (!e) return { ok: false, reason: "空表达式" };
  if (e.includes(";")) return { ok: false, reason: "含分号（禁止多语句）" };
  if (/--|\/\*|\*\//.test(e)) return { ok: false, reason: "含注释" };
  const writeKw = e.match(WRITE_KW);
  if (writeKw) return { ok: false, reason: `含写/查询关键字 ${writeKw[0]}` };

  const quotedIdentifiers = [...e.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const unquoted = e.replace(/"[^"]+"/g, "");
  if (unquoted.includes('"')) return { ok: false, reason: "双引号不匹配" };
  if (!/^[0-9a-zA-Z+\-*/().\s,=<>!:_]+$/.test(unquoted)) {
    const bad = unquoted.replace(/[0-9a-zA-Z+\-*/().\s,=<>!:_]/g, "").slice(0, 30);
    return { ok: false, reason: `含非法字符: ${bad}` };
  }

  for (const match of unquoted.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    if (!ALLOWED_EXPRESSION_FUNCTIONS.has(match[1].toUpperCase())) {
      return { ok: false, reason: `函数不在白名单: ${match[1]}` };
    }
  }

  if (allowedIdentifiers) {
    const allowed = new Set(allowedIdentifiers);
    for (const identifier of quotedIdentifiers) {
      if (!allowed.has(identifier)) {
        return { ok: false, reason: `引用未知列: ${identifier}` };
      }
    }
    for (const match of unquoted.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
      const identifier = match[0];
      if (
        !ALLOWED_EXPRESSION_WORDS.has(identifier.toUpperCase())
        && !allowed.has(identifier)
      ) {
        return { ok: false, reason: `引用未知列或关键字: ${identifier}` };
      }
    }
  }
  return { ok: true };
}
