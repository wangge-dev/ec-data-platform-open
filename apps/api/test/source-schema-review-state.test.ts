import { describe, expect, test, vi } from "vitest";
import {
  assertSourceSchemaReviewOperation,
  assignSourceToModule,
  clearSourceSchemaReview,
  markSourceSchemaReviewAwaitingRetry,
  markSourceSchemaReviewPending,
  readSourceSchemaReviewOperation,
} from "../src/services/source-schema-review-state.js";

describe("source schema review state", () => {
  test("stores only a bounded public schema review and clears it for the same module", async () => {
    const unsafe = vi.fn(async () => []);
    const client = { unsafe };
    const review = await markSourceSchemaReviewPending(
      161,
      "pinduoduo_sales",
      {
        added: ["新增备注"],
        missingRequired: [],
        missingOptional: ["店铺"],
        missingRequiredFields: [],
        missingOptionalFields: [{ name: "shop", label: "店铺" }],
        aliasCandidates: [],
        typeChanges: [
          {
            source: "金额",
            expected: "numeric",
            failures: 8,
            samples: ["待确认", "金额见备注", "第三个", "第四个", "第五个"],
          },
        ],
      },
      {
        moduleVersion: 2,
        schemaFingerprint: "a".repeat(64),
      },
      client,
    );

    expect(review).toMatchObject({
      status: "pending",
      moduleCode: "pinduoduo_sales",
      moduleVersion: 2,
      schemaFingerprint: "a".repeat(64),
      diff: { added: ["新增备注"] },
    });
    expect(JSON.stringify(review)).not.toMatch(/SELECT|user_data|uf_161/i);
    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining("'{schemaReview}'"),
      [expect.any(String), 161],
    );

    await clearSourceSchemaReview(161, "pinduoduo_sales", client);
    expect(unsafe).toHaveBeenLastCalledWith(
      expect.stringContaining("- 'schemaReview'"),
      [161, "pinduoduo_sales"],
    );
  });

  test("persists actionable retry state and clears old review when reassigning A to B", async () => {
    const unsafe = vi.fn(async (query: string) =>
      query.includes("jsonb_build_object('moduleCode'") ? [{ id: 161 }] : []);
    const client = { unsafe };
    await markSourceSchemaReviewAwaitingRetry(
      161,
      "module_a",
      {
        added: ["新金额"],
        missingRequired: [],
        missingOptional: [],
        missingRequiredFields: [],
        missingOptionalFields: [],
        aliasCandidates: [],
        typeChanges: [],
      },
      {
        moduleVersion: 3,
        schemaFingerprint: "b".repeat(64),
        stagedDecisions: [
          {
            sourceField: "新金额",
            decision: "alias",
            targetField: "amount",
          },
        ],
        retryMessage: "文件处理失败，请稍后重试",
      },
      client,
    );
    const stored = JSON.parse(unsafe.mock.calls[0][1][0] as string);
    expect(stored).toMatchObject({
      status: "awaiting_retry",
      moduleCode: "module_a",
      stagedDecisions: [
        {
          sourceField: "新金额",
          decision: "alias",
          targetField: "amount",
        },
      ],
    });

    await assignSourceToModule(161, "orders", client);
    expect(unsafe).toHaveBeenLastCalledWith(
      expect.stringContaining("- 'schemaReview'"),
      ["orders", 161],
    );
    expect(unsafe.mock.calls[1][0]).toContain("jsonb_build_object('moduleCode'");
    expect(unsafe.mock.calls[1][0]).toContain("IS DISTINCT FROM");
  });

  test("loads and validates every member of one durable operation", async () => {
    const marker = {
      status: "pending" as const,
      operationId: "11111111-1111-4111-8111-111111111111",
      sourceIds: [161, 162],
      moduleCode: "pinduoduo_sales",
      moduleVersion: 2,
      schemaFingerprint: "a".repeat(64),
      schemaFingerprints: {
        "161": "a".repeat(64),
        "162": "b".repeat(64),
      },
      diff: {
        added: ["新字段"],
        missingRequired: [],
        missingOptional: [],
        aliasCandidates: [],
        typeChanges: [],
      },
      detectedAt: "2026-07-17T00:00:00.000Z",
    };
    const members = [161, 162].map((id) => ({
      id: String(id), // postgres.js BIGINT default
      name: `${id}.csv`,
      config: {
        moduleCode: "pinduoduo_sales",
        schemaReview: {
          ...marker,
          schemaFingerprint: marker.schemaFingerprints[String(id)],
        },
      },
    }));
    const unsafe = vi.fn(async (query: string) =>
      query.includes("id = ANY") ? members : [members[0]]);

    const result = await readSourceSchemaReviewOperation(
      162,
      "pinduoduo_sales",
      { unsafe },
      { forUpdate: true },
    );

    expect(result.review.sourceIds).toEqual([161, 162]);
    expect(result.sources.map((source) => source.id)).toEqual([161, 162]);
    expect(result.sources).toHaveLength(2);
    expect(unsafe.mock.calls.every(([query]) =>
      String(query).includes("FOR UPDATE"))).toBe(true);
  });

  test.each([
    ["mixed status", (marker: any) => ({ ...marker, status: "awaiting_retry" })],
    ["mixed version", (marker: any) => ({ ...marker, moduleVersion: 3 })],
    ["mixed fingerprint", (marker: any) => ({
      ...marker,
      schemaFingerprint: "c".repeat(64),
    })],
    ["mixed fingerprint map", (marker: any) => ({
      ...marker,
      schemaFingerprints: {
        ...marker.schemaFingerprints,
        "162": "c".repeat(64),
      },
    })],
    ["mixed staged decisions", (marker: any) => ({
      ...marker,
      status: "awaiting_retry",
      stagedDecisions: [{ sourceField: "other", decision: "ignore" }],
    })],
  ])("rejects %s inside one operation", (_case, mutate) => {
    const marker = {
      status: "pending" as const,
      operationId: "11111111-1111-4111-8111-111111111111",
      sourceIds: [161, 162],
      moduleCode: "pinduoduo_sales",
      moduleVersion: 2,
      schemaFingerprint: "a".repeat(64),
      schemaFingerprints: {
        "161": "a".repeat(64),
        "162": "b".repeat(64),
      },
      diff: {
        added: ["new_field"],
        missingRequired: [],
        missingOptional: [],
        aliasCandidates: [],
        typeChanges: [],
      },
      detectedAt: "2026-07-17T00:00:00.000Z",
    };
    const operation = {
      review: marker,
      sources: [161, 162].map((id) => ({
        id,
        name: `${id}.csv`,
        config: {
          moduleCode: "pinduoduo_sales",
          schemaReview: id === 162 ? mutate({
            ...marker,
            schemaFingerprint: marker.schemaFingerprints[String(id)],
          }) : {
            ...marker,
            schemaFingerprint: marker.schemaFingerprints[String(id)],
          },
        },
      })),
    };

    expect(() => assertSourceSchemaReviewOperation(operation, {
      moduleCode: "pinduoduo_sales",
      operationId: marker.operationId,
      sourceIds: marker.sourceIds,
      moduleVersion: 2,
      schemaFingerprints: marker.schemaFingerprints,
      allowedStatuses: ["pending", "awaiting_retry"],
      stagedDecisions: [],
    })).toThrow(/刷新后重试/);
  });
});
