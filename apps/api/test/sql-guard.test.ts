// SQL guard 单元测试（V0.27 Codex P1：补基础测试）
// 验证 SQL 注入防护：ensureReadOnly 拒写操作/多语句，validateExpression 白名单
import { describe, it, expect } from "vitest";
import {
  ensureReadOnly,
  validateExpression,
  withLimit,
} from "../src/lib/sql-guard";

describe("ensureReadOnly", () => {
  it("通过合法 SELECT", () => {
    expect(() => ensureReadOnly("SELECT * FROM unified_sales")).not.toThrow();
    expect(() => ensureReadOnly("  select 1  ")).not.toThrow();
  });

  it("拒绝写操作关键字", () => {
    for (const kw of ["insert", "update", "delete", "drop", "alter", "truncate", "create", "grant", "revoke", "merge", "copy", "into", "call", "do"]) {
      expect(() => ensureReadOnly(`SELECT 1; ${kw} x`)).toThrow();
    }
  });

  it("拒绝多语句分号", () => {
    expect(() => ensureReadOnly("SELECT 1; DROP TABLE users")).toThrow();
    expect(() => ensureReadOnly("SELECT 1; SELECT 2")).toThrow();
  });

  it("拒绝隐式写 SELECT INTO", () => {
    expect(() => ensureReadOnly("SELECT * INTO new_table FROM unified_sales")).toThrow();
  });

  it("leaves nested CTEs, identifiers, and E strings unchanged", () => {
    const input = `SELECT nested.id, E'FROM users JOIN unified_sales' AS note
      FROM (
        WITH users AS (SELECT 1 AS id)
        SELECT id FROM users
      ) nested
      JOIN dynamic_runtime d ON d.id = nested.id`;

    expect(ensureReadOnly(input)).toBe(input);
  });

  it("rejects comments that could swallow an appended LIMIT", () => {
    expect(() => ensureReadOnly("SELECT * FROM t LIMIT 100000 -- ")).toThrow();
    expect(() => ensureReadOnly("SELECT * FROM t LIMIT 100000 # ignored")).toThrow();
    expect(() => ensureReadOnly("SELECT * FROM t /* LIMIT 1 */")).toThrow();
  });
});

describe("withLimit", () => {
  it("无 LIMIT 时追加", () => {
    expect(withLimit("SELECT * FROM t", 100)).toBe("SELECT * FROM t LIMIT 100");
  });
  it("已有 LIMIT 不重复追加", () => {
    expect(withLimit("SELECT * FROM t LIMIT 50", 100)).toBe("SELECT * FROM t LIMIT 50");
  });
  it("caps an oversized PostgreSQL LIMIT and preserves OFFSET", () => {
    expect(withLimit("SELECT * FROM t LIMIT 500", 100)).toBe(
      "SELECT * FROM t LIMIT 100",
    );
    expect(withLimit("SELECT * FROM t LIMIT 500 OFFSET 20", 100)).toBe(
      "SELECT * FROM t LIMIT 100 OFFSET 20",
    );
    expect(withLimit("SELECT * FROM t LIMIT 50 OFFSET 20", 100)).toBe(
      "SELECT * FROM t LIMIT 50 OFFSET 20",
    );
  });
  it("caps only the row count in MySQL LIMIT offset,count syntax", () => {
    expect(withLimit("SELECT * FROM t LIMIT 20, 500", 100)).toBe(
      "SELECT * FROM t LIMIT 20, 100",
    );
    expect(withLimit("SELECT * FROM t LIMIT 20, 50", 100)).toBe(
      "SELECT * FROM t LIMIT 20, 50",
    );
  });
  it("末尾分号先去掉", () => {
    expect(withLimit("SELECT * FROM t;", 100)).toBe("SELECT * FROM t LIMIT 100");
  });
});

describe("validateExpression (computed 白名单)", () => {
  it("通过合法表达式（CASE/COALESCE/四则/列名）", () => {
    expect(validateExpression("CASE WHEN COALESCE(impressions,0)=0 THEN NULL ELSE clicks::numeric / impressions END").ok).toBe(true);
    expect(validateExpression("COALESCE(amount, 0) * 1.5").ok).toBe(true);
    expect(validateExpression('("销售额" - "成本") / "销售额"').ok).toBe(true);
    expect(validateExpression("ROUND(amount::numeric, 2)").ok).toBe(true);
  });

  it("拒绝空表达式", () => {
    expect(validateExpression("").ok).toBe(false);
    expect(validateExpression("   ").ok).toBe(false);
  });

  it("拒绝分号（多语句）", () => {
    expect(validateExpression("amount; DROP TABLE users").ok).toBe(false);
  });

  it("拒绝写/查询关键字", () => {
    for (const kw of ["insert", "update", "delete", "drop", "select", "from", "where", "create"]) {
      expect(validateExpression(`${kw} x`).ok).toBe(false);
    }
  });

  it("拒绝注释", () => {
    expect(validateExpression("amount -- comment").ok).toBe(false);
    expect(validateExpression("amount /* c */").ok).toBe(false);
  });

  it("拒绝非法字符", () => {
    expect(validateExpression("amount$@!").ok).toBe(false);
  });

  it("rejects unknown or side-effect functions", () => {
    for (const expression of [
      "pg_sleep(999999)",
      "pg_advisory_lock(1)",
      "set_config(setting_name, setting_value, false)",
      "unknown_business_function(amount)",
    ]) {
      expect(validateExpression(expression, ["amount", "setting_name", "setting_value"]).ok)
        .toBe(false);
    }
  });

  it("accepts only declared bare or quoted column identifiers", () => {
    expect(validateExpression("ROUND(amount::numeric, 2)", ["amount"]).ok).toBe(true);
    expect(validateExpression('COALESCE("amount", 0)', ["amount"]).ok).toBe(true);
    expect(validateExpression("ROUND(other_amount, 2)", ["amount"]).ok).toBe(false);
    expect(validateExpression('COALESCE("other_amount", 0)', ["amount"]).ok).toBe(false);
  });
});
