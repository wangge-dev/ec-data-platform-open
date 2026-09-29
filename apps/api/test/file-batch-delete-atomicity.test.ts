import { describe, expect, test, vi } from "vitest";

import {
  deleteFileSourcesAtomically,
  FileSourceDeleteBlockedError,
} from "../src/services/import-excel.js";

function fakeBatchDatabase(options: { blockedId?: number } = {}) {
  const queryLog: string[] = [];
  const tagged = vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    queryLog.push(text);
    return [];
  });
  const tx = Object.assign(tagged, {
    unsafe: vi.fn(async (query: string, parameters?: unknown[]) => {
      const text = String(query);
      queryLog.push(text);
      if (text.startsWith("SELECT id, type FROM public.data_sources")) {
        return [
          { id: 1, type: "file" },
          { id: 2, type: "file" },
        ];
      }
      if (text.includes("FROM public.publish_version_source")) {
        const sourceId = Number(parameters?.[0]);
        return sourceId === options.blockedId
          ? [{ publish_version_id: 9, module_code: "front_profit", scope_key: "front_profit:2026-08", version_no: 1 }]
          : [];
      }
      if (text.startsWith("SELECT id FROM public.datasets")) return [];
      if (text.includes("FROM information_schema.columns")) return [];
      return [];
    }),
  });
  const database = {
    begin: vi.fn(async (work: (executor: typeof tx) => Promise<number>) => work(tx)),
  };
  return { database, queryLog };
}

describe("file batch delete atomicity", () => {
  test("preflights every locked source before issuing the first destructive statement", async () => {
    const { database, queryLog } = fakeBatchDatabase({ blockedId: 2 });

    await expect(deleteFileSourcesAtomically([1, 2], database as any))
      .rejects.toBeInstanceOf(FileSourceDeleteBlockedError);

    expect(database.begin).toHaveBeenCalledTimes(1);
    expect(queryLog.some((query) => /\b(?:DELETE|DROP)\b/.test(query))).toBe(false);
  });

  test("deletes all eligible file sources inside one transaction", async () => {
    const { database, queryLog } = fakeBatchDatabase();

    await expect(deleteFileSourcesAtomically([1, 2, 2], database as any)).resolves.toBe(2);

    expect(database.begin).toHaveBeenCalledTimes(1);
    expect(queryLog.filter((query) => query.startsWith("DELETE FROM public.data_sources"))).toHaveLength(2);
    expect(queryLog.filter((query) => query.startsWith("DROP TABLE IF EXISTS"))).toHaveLength(4);
  });
});
