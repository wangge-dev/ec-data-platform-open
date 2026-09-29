import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

import {
  compileSafeFilePattern,
  FILE_PATTERN_MAX_LENGTH,
  validateSafeFilePattern,
} from "../src/lib/file-pattern.js";
import { PlatformSchema } from "../src/modules/schema.js";

describe("module filename pattern security", () => {
  test.each([
    "GEI@EXPORT_ORDER_INFO",
    "PIC|pic.*dict|店铺.*维护",
    "成本.*xlsx?$|cost.*xlsx?$",
    "order\\.export\\+\\(final\\)",
    ".*",
  ])("accepts the bounded pattern language: %s", (source) => {
    expect(validateSafeFilePattern(source, "i")).toEqual({ ok: true });
    expect(() => compileSafeFilePattern(source, "i")).not.toThrow();
  });

  test.each([
    "(a+)+$",
    "(a|aa)+$",
    "a{1,100000}",
    "(?=orders)orders",
    "[a-z]+",
    "a.*b.*c",
    "a?a?a?b",
    "a\\1",
    "a||b",
    "a+",
  ])("rejects complex or backtracking-prone syntax: %s", (source) => {
    expect(validateSafeFilePattern(source, "i")).toMatchObject({ ok: false });
    expect(() => compileSafeFilePattern(source, "i")).toThrow("unsafe filePattern");
  });

  test("rejects unbounded length and stateful or duplicate flags", () => {
    expect(validateSafeFilePattern("a".repeat(FILE_PATTERN_MAX_LENGTH + 1), "i"))
      .toMatchObject({ ok: false });
    for (const flags of ["g", "y", "m", "ii", "iug"]) {
      expect(validateSafeFilePattern("orders", flags), flags)
        .toMatchObject({ ok: false });
    }
    expect(validateSafeFilePattern("orders", "iu")).toEqual({ ok: true });
  });

  test("module schema rejects an unsafe user-supplied filePattern", () => {
    const result = PlatformSchema.safeParse({
      code: "generic",
      name: "Generic",
      filePattern: "(a+)+$",
      patternFlags: "i",
      enabled: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ["filePattern"] }),
      ]));
    }
  });

  test("all runtime filename matching paths use the conservative compiler", () => {
    const sourceRoot = resolve(import.meta.dirname, "../src");
    for (const relative of [
      "modules/loader.ts",
      "modules/engine.ts",
      "services/etl.ts",
    ]) {
      const source = readFileSync(resolve(sourceRoot, relative), "utf8");
      expect(source, relative).toContain("compileSafeFilePattern(");
      expect(source, relative).not.toMatch(/new RegExp\([^\n]*filePattern/);
    }
  });
});
