import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, test } from "vitest";
import * as XLSX from "xlsx";
import { resolveIsolatedTestDatabase } from "./helpers/isolated-database.js";

import {
  FRONT_PROFIT_STANDARD_HEADERS,
  FrontProfitValidationError,
} from "../src/services/front-profit-standard.js";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1";
const databaseUrl = runDatabaseTests ? resolveIsolatedTestDatabase(process.env, true) : undefined;
const describeDatabase = runDatabaseTests ? describe : describe.skip;

// importExcel uses the production db client, which reads DATABASE_URL. Keep the
// exercised service and the independent verification connection on the exact
// same isolated database when callers provide the test-specific override.
if (runDatabaseTests && databaseUrl) process.env.DATABASE_URL = databaseUrl;

describeDatabase("PostgreSQL advisory transaction locks for file imports", () => {
  test("serializes the same import key across two independent connections", async () => {
    const first = postgres(databaseUrl!, { max: 1, connect_timeout: 5 });
    const second = postgres(databaseUrl!, { max: 1, connect_timeout: 5 });
    const lockKey = "front-profit-standard-import";
    let firstOpen = false;
    let secondOpen = false;

    try {
      await first.unsafe("BEGIN");
      firstOpen = true;
      await first.unsafe(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [lockKey],
      );

      await second.unsafe("BEGIN");
      secondOpen = true;
      const blocked = await second.unsafe(
        "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired",
        [lockKey],
      ) as Array<{ acquired: boolean }>;
      expect(blocked[0]?.acquired).toBe(false);
      await second.unsafe("ROLLBACK");
      secondOpen = false;

      await first.unsafe("COMMIT");
      firstOpen = false;

      await second.unsafe("BEGIN");
      secondOpen = true;
      const acquired = await second.unsafe(
        "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired",
        [lockKey],
      ) as Array<{ acquired: boolean }>;
      expect(acquired[0]?.acquired).toBe(true);
      await second.unsafe("ROLLBACK");
      secondOpen = false;
    } finally {
      if (secondOpen) await second.unsafe("ROLLBACK").catch(() => undefined);
      if (firstOpen) await first.unsafe("ROLLBACK").catch(() => undefined);
      await Promise.all([
        first.end({ timeout: 1 }).catch(() => undefined),
        second.end({ timeout: 1 }).catch(() => undefined),
      ]);
    }
  });

  test("serializes the same generic filename key across two independent connections", async () => {
    const first = postgres(databaseUrl!, { max: 1, connect_timeout: 5 });
    const second = postgres(databaseUrl!, { max: 1, connect_timeout: 5 });
    const lockKey = `ec-data-platform:file-import:generic-lock-${randomUUID()}.xlsx`;
    let firstOpen = false;
    let secondOpen = false;

    try {
      await first.unsafe("BEGIN");
      firstOpen = true;
      await first.unsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [lockKey],
      );

      await second.unsafe("BEGIN");
      secondOpen = true;
      const blocked = await second.unsafe(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
        [lockKey],
      ) as Array<{ acquired: boolean }>;
      expect(blocked[0]?.acquired).toBe(false);
      await second.unsafe("ROLLBACK");
      secondOpen = false;

      await first.unsafe("COMMIT");
      firstOpen = false;

      await second.unsafe("BEGIN");
      secondOpen = true;
      const acquired = await second.unsafe(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
        [lockKey],
      ) as Array<{ acquired: boolean }>;
      expect(acquired[0]?.acquired).toBe(true);
      await second.unsafe("ROLLBACK");
      secondOpen = false;
    } finally {
      if (secondOpen) await second.unsafe("ROLLBACK").catch(() => undefined);
      if (firstOpen) await first.unsafe("ROLLBACK").catch(() => undefined);
      await Promise.all([
        first.end({ timeout: 1 }).catch(() => undefined),
        second.end({ timeout: 1 }).catch(() => undefined),
      ]);
    }
  });

  test("allows only one of two concurrent real standard imports to persist", async () => {
    const { deleteFileSource, importExcel } = await import("../src/services/import-excel.js");
    const suffix = randomUUID().replaceAll("-", "");
    const fileNames = [
      `front-profit-concurrent-a-${suffix}.xlsx`,
      `front-profit-concurrent-b-${suffix}.xlsx`,
    ];
    const record: Record<string, unknown> = {
      日期: "2098-12-31",
      平台: "合成平台",
      业务模式: "自营",
      组: "合成组",
      店铺: `合成并发店铺-${suffix}`,
      店铺2: "合成归一店铺",
      运营: `合成运营-${suffix}`,
      单量: 10,
      GMV: 1200,
      补单金额: 50,
      补单产品成本: 15,
      补单单量: 1,
      产品成本: 200,
      出货货值: 1000,
      "平台扣点/毛保": 30,
      税点: 20,
      财务成本: 5,
      运费: 10,
      佣金: 8,
      推广费: 100,
      真实营业额: 1150,
      前台利润: 592,
      付费占比: 100 / 1200,
      来源文件: "synthetic-concurrency-integration",
      来源批次: suffix,
      备注: "synthetic database integration only",
      record_id: `SYNTHETIC_CONCURRENT_${suffix}`,
      数据状态: "合成金标",
    };
    const sheet = XLSX.utils.aoa_to_sheet([
      [...FRONT_PROFIT_STANDARD_HEADERS],
      FRONT_PROFIT_STANDARD_HEADERS.map((header) => record[header]),
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "前台利润标准数据");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    try {
      const results = await Promise.allSettled([
        importExcel(bytes, fileNames[0], "synthetic concurrent A"),
        importExcel(bytes, fileNames[1], "synthetic concurrent B"),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const rejection = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejection).toBeInstanceOf(FrontProfitValidationError);
      expect(
        (rejection as FrontProfitValidationError).issues.map((issue) => issue.code),
      ).toEqual(
        expect.arrayContaining([
          "DUPLICATE_RECORD_ID_EXISTING",
          "DUPLICATE_AGGREGATION_KEY_EXISTING",
        ]),
      );

      const verification = postgres(databaseUrl!, { max: 1, connect_timeout: 5 });
      try {
        const rows = await verification.unsafe(
          `SELECT id, config->>'originalFileName' AS file_name
           FROM public.data_sources
           WHERE type = 'file'
             AND config->>'originalFileName' IN ($1, $2)`,
          fileNames,
        ) as Array<{ id: number | string; file_name: string }>;
        expect(rows).toHaveLength(1);
        const tables = await verification.unsafe(
          `SELECT count(*)::int AS count
           FROM information_schema.tables
           WHERE table_schema = 'user_data'
             AND table_name = $1`,
          [`uf_${Number(rows[0]!.id)}`],
        ) as Array<{ count: number }>;
        expect(tables[0]?.count).toBe(1);
      } finally {
        await verification.end({ timeout: 1 }).catch(() => undefined);
      }
    } finally {
      const cleanup = postgres(databaseUrl!, { max: 1, connect_timeout: 5 });
      try {
        const rows = await cleanup.unsafe(
          `SELECT id FROM public.data_sources
           WHERE type = 'file'
             AND config->>'originalFileName' IN ($1, $2)`,
          fileNames,
        ) as Array<{ id: number | string }>;
        for (const row of rows) await deleteFileSource(Number(row.id));
      } finally {
        await cleanup.end({ timeout: 1 }).catch(() => undefined);
      }
    }
  }, 30_000);

  test("keeps one same-name generic import and restores unrelated database state after cleanup", async () => {
    const {
      deleteFileSource,
      importExcel,
      isFileNameUniqueConflict,
    } = await import("../src/services/import-excel.js");
    const suffix = randomUUID().replaceAll("-", "");
    const fileName = `generic-concurrent-${suffix}.xlsx`;
    const sheet = XLSX.utils.aoa_to_sheet([
      ["date", "sku", "amount"],
      ["2098-12-30", `SYNTHETIC_GENERIC_${suffix}`, "12.34"],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "generic");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    const verification = postgres(databaseUrl!, { max: 1, connect_timeout: 5 });

    const snapshot = async () => {
      const sources = await verification.unsafe(
        "SELECT id::text AS id FROM public.data_sources ORDER BY id",
      ) as Array<{ id: string }>;
      const tables = await verification.unsafe(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'user_data'
           AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
      ) as Array<{ table_name: string }>;
      return {
        sourceIds: sources.map((row) => row.id),
        userDataTables: tables.map((row) => row.table_name),
      };
    };
    let baseline: Awaited<ReturnType<typeof snapshot>> | null = null;

    try {
      baseline = await snapshot();
      const results = await Promise.allSettled([
        importExcel(bytes, fileName, "synthetic generic concurrent A"),
        importExcel(bytes, fileName, "synthetic generic concurrent B"),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(isFileNameUniqueConflict(
        (rejected[0] as PromiseRejectedResult).reason,
      )).toBe(true);

      const rows = await verification.unsafe(
        `SELECT id, config->>'originalFileName' AS file_name
         FROM public.data_sources
         WHERE type = 'file'
           AND config->>'originalFileName' = $1`,
        [fileName],
      ) as Array<{ id: number | string; file_name: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.file_name).toBe(fileName);

      const sourceId = Number(rows[0]!.id);
      expect(Number.isSafeInteger(sourceId) && sourceId > 0).toBe(true);
      const tableName = `uf_${sourceId}`;
      const tableRows = await verification.unsafe(
        `SELECT count(*)::int AS count FROM "user_data"."${tableName}"`,
      ) as Array<{ count: number }>;
      expect(tableRows[0]?.count).toBe(1);

      const importedState = await snapshot();
      const baselineSourceIds = new Set(baseline!.sourceIds);
      const baselineTables = new Set(baseline!.userDataTables);
      expect(
        importedState.sourceIds.filter((id) => !baselineSourceIds.has(id)),
      ).toEqual([String(sourceId)]);
      expect(
        baseline!.sourceIds.filter((id) => !importedState.sourceIds.includes(id)),
      ).toEqual([]);
      expect(
        importedState.userDataTables.filter((name) => !baselineTables.has(name)),
      ).toEqual([tableName]);
      expect(
        baseline!.userDataTables.filter((name) => !importedState.userDataTables.includes(name)),
      ).toEqual([]);
    } finally {
      try {
        const rows = await verification.unsafe(
          `SELECT id FROM public.data_sources
           WHERE type = 'file'
             AND config->>'originalFileName' = $1`,
          [fileName],
        ) as Array<{ id: number | string }>;
        for (const row of rows) await deleteFileSource(Number(row.id));

        const remaining = await verification.unsafe(
          `SELECT count(*)::int AS count FROM public.data_sources
           WHERE type = 'file'
             AND config->>'originalFileName' = $1`,
          [fileName],
        ) as Array<{ count: number }>;
        expect(remaining[0]?.count).toBe(0);
        if (baseline) expect(await snapshot()).toEqual(baseline);
      } finally {
        await verification.end({ timeout: 1 }).catch(() => undefined);
      }
    }
  }, 30_000);
});
