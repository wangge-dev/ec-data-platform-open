import { describe, expect, test } from "vitest";
import {
  isFileNameUniqueConflict,
  serializeImportedCellValue,
} from "../src/services/import-excel.js";

describe("file upload conflict classification", () => {
  test("recognizes only the original-file-name unique index", () => {
    expect(
      isFileNameUniqueConflict({
        code: "23505",
        constraint_name: "uq_data_sources_file_original_name",
      }),
    ).toBe(true);
    expect(isFileNameUniqueConflict({ code: "23505", constraint_name: "users_username_key" })).toBe(false);
    expect(isFileNameUniqueConflict(new Error("invalid workbook"))).toBe(false);
  });
});

describe("Excel cell serialization", () => {
  test("preserves a calendar date without locale-dependent text", () => {
    expect(serializeImportedCellValue(new Date(2099, 11, 31))).toBe(
      "2099-12-31",
    );
  });

  test("preserves time and milliseconds when present", () => {
    expect(
      serializeImportedCellValue(new Date(2099, 11, 31, 13, 5, 9, 120)),
    ).toBe("2099-12-31 13:05:09.120");
  });

  test("keeps nulls and ordinary scalar values unchanged", () => {
    expect(serializeImportedCellValue(null)).toBeNull();
    expect(serializeImportedCellValue(12.34)).toBe("12.34");
    expect(serializeImportedCellValue("2026-07-01")).toBe("2026-07-01");
  });
});
