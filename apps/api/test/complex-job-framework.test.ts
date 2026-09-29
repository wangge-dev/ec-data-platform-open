import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { FRONT_PROFIT_STANDARD_HEADERS } from "../src/services/front-profit-standard.js";
import {
  ComplexJobContractError,
  ComplexJobGateError,
  assertPublishGate,
  jobRunLockKey,
  mappingLockKey,
  publishLockKey,
  summarizePublishGate,
} from "../src/services/complex-job.js";

const apiRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(apiRoot, "../..");

describe("complex job framework", () => {
  test("keeps the generic framework free of front-profit business fields", () => {
    const files = [
      resolve(apiRoot, "src/services/complex-job.ts"),
      resolve(apiRoot, "drizzle/0005_complex_job_framework.sql"),
    ];
    const forbiddenHeaders = FRONT_PROFIT_STANDARD_HEADERS.filter((header) => header !== "日期");

    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const header of forbiddenHeaders) {
        expect(content, `${file.slice(repoRoot.length + 1)} must not contain ${header}`).not.toContain(header);
      }
      expect(content).not.toContain("front_profit");
      expect(content).not.toContain("front-profit");
    }
  });

  test("uses namespaced advisory lock keys with strict identifiers", () => {
    expect(jobRunLockKey("toy_module", "scope:2026-08")).toBe(
      "complex-job:job:toy_module:scope:2026-08",
    );
    expect(publishLockKey("toy_module")).toBe("complex-job:publish:toy_module");
    expect(mappingLockKey("toy_mapping")).toBe("complex-job:mapping:toy_mapping");
    expect(() => jobRunLockKey("ToyModule", "scope")).toThrow(ComplexJobContractError);
    expect(() => jobRunLockKey("toy_module", "bad scope")).toThrow(ComplexJobContractError);
  });

  test("blocks publish on unresolved block events or failed reconciliation", () => {
    const summary = summarizePublishGate({
      dqEvents: [
        { severity: "warn", code: "WARN_ONLY" },
        { severity: "block", code: "RESOLVED_BLOCK", resolvedAt: new Date() },
        { severity: "block", code: "OPEN_BLOCK" },
      ],
      reconResults: [
        { layer: "L1", metric: "row_count", passed: true },
        { layer: "L2", metric: "amount_sum", passed: false },
      ],
    });

    expect(summary).toEqual({
      ok: false,
      blockingEventCodes: ["OPEN_BLOCK"],
      failedReconMetrics: ["L2:amount_sum"],
    });
    expect(() =>
      assertPublishGate({
        dqEvents: [{ severity: "block", code: "OPEN_BLOCK" }],
        reconResults: [],
      }),
    ).toThrow(ComplexJobGateError);
  });

  test("allows publish once gate evidence is clean", () => {
    expect(() =>
      assertPublishGate({
        dqEvents: [
          { severity: "warn", code: "WARN_ONLY" },
          { severity: "block", code: "RESOLVED_BLOCK", resolvedAt: "2026-08-09T00:00:00Z" },
        ],
        reconResults: [{ layer: "L1", metric: "row_count", passed: true }],
      }),
    ).not.toThrow();
  });
});
