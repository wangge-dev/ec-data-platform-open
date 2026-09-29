import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const migrationPath = resolve(
  import.meta.dirname,
  "../drizzle/0001_unique_file_original_name.sql",
);

describe("file source original-name migration", () => {
  test("rejects existing duplicates before creating the partial unique index", () => {
    expect(existsSync(migrationPath)).toBe(true);
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toMatch(/GROUP BY\s+\(config->>'originalFileName'\)/i);
    expect(migration).toMatch(/HAVING COUNT\(\*\) > 1/i);
    expect(migration).toMatch(/RAISE EXCEPTION/i);
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX "uq_data_sources_file_original_name"\s+ON "public"\."data_sources"\s+\(\(config->>'originalFileName'\)\)/i,
    );
    expect(migration).toMatch(
      /WHERE type = 'file'\s+AND NULLIF\(config->>'originalFileName', ''\) IS NOT NULL/i,
    );
  });
});
