import { describe, expect, test } from "vitest";
import { dataSourceMutationSchema } from "../src/routes/data-sources.js";

describe("server-managed data-source validation evidence", () => {
  const ordinary = {
    name: "synthetic source",
    type: "shop_account" as const,
    config: { columns: [{ raw: "日期", name: "date" }] },
  };

  test("accepts ordinary user-writable source configuration", () => {
    expect(dataSourceMutationSchema.safeParse(ordinary).success).toBe(true);
  });

  test("rejects forged front-profit validation evidence on create", () => {
    const result = dataSourceMutationSchema.safeParse({
      ...ordinary,
      config: {
        ...ordinary.config,
        frontProfitValidation: { schemaVersion: "front-profit-standard/v1" },
      },
    });
    expect(result.success).toBe(false);
  });

  test("rejects creation or retyping of a managed file source through generic CRUD", () => {
    expect(dataSourceMutationSchema.safeParse({
      ...ordinary,
      type: "file",
    }).success).toBe(false);
    expect(dataSourceMutationSchema.partial().safeParse({ type: "file" }).success).toBe(false);
  });

  test("rejects creation or retyping of an external SQL source through generic CRUD", () => {
    expect(dataSourceMutationSchema.safeParse({
      ...ordinary,
      type: "external_sql",
    }).success).toBe(false);
    expect(dataSourceMutationSchema.partial().safeParse({ type: "external_sql" }).success).toBe(false);
  });

  test("rejects forged front-profit validation evidence on partial update", () => {
    const result = dataSourceMutationSchema.partial().safeParse({
      config: {
        frontProfitValidation: { schemaVersion: "front-profit-standard/v1" },
      },
    });
    expect(result.success).toBe(false);
  });
});
