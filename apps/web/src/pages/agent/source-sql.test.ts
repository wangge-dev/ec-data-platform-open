import { describe, expect, it } from "vitest";
import { buildSourceSampleSql } from "./source-sql";

describe("agent source SQL", () => {
  it("builds a bounded query for the selected uploaded file", () => {
    expect(buildSourceSampleSql(68)).toBe(
      'SELECT * FROM "user_data"."uf_68" LIMIT 30',
    );
  });

  it("rejects invalid source ids", () => {
    expect(() => buildSourceSampleSql(-1)).toThrow("有效的数据文件");
  });
});
