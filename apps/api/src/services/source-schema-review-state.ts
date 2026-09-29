import { randomUUID } from "node:crypto";
import { sql as defaultSql } from "../db/client.js";
import type { SchemaDiff } from "./module-source-inspector.js";
import type { SchemaReviewDecision } from "./module-schema-review.js";

export type PendingSourceSchemaReview = {
  status: "pending" | "awaiting_retry";
  operationId: string;
  sourceIds: number[];
  moduleCode: string;
  moduleVersion: number;
  schemaFingerprint: string;
  schemaFingerprints: Record<string, string>;
  diff: SchemaDiff;
  detectedAt: string;
  stagedDecisions?: SchemaReviewDecision[];
  retryMessage?: string;
};

type SqlClient = {
  unsafe(query: string, parameters?: unknown[]): PromiseLike<unknown[]>;
};

export async function markSourceSchemaReviewPending(
  sourceId: number,
  moduleCode: string,
  diff: SchemaDiff,
  metadata: {
    moduleVersion: number;
    schemaFingerprint: string;
    operationId?: string;
    sourceIds?: number[];
    schemaFingerprints?: Record<string, string>;
  },
  client: SqlClient = defaultSql,
): Promise<PendingSourceSchemaReview> {
  const review: PendingSourceSchemaReview = {
    status: "pending",
    operationId: metadata.operationId ?? randomUUID(),
    sourceIds: [...new Set(metadata.sourceIds ?? [sourceId])].sort((a, b) => a - b),
    moduleCode,
    moduleVersion: metadata.moduleVersion,
    schemaFingerprint: metadata.schemaFingerprint,
    schemaFingerprints:
      metadata.schemaFingerprints ?? { [sourceId]: metadata.schemaFingerprint },
    diff,
    detectedAt: new Date().toISOString(),
  };
  await client.unsafe(
    `UPDATE public.data_sources
     SET config = jsonb_set(
       COALESCE(config, '{}'::jsonb),
       '{schemaReview}',
       $1::jsonb,
       true
     ),
     updated_at = NOW()
     WHERE id = $2 AND type = 'file'`,
    [JSON.stringify(review), sourceId],
  );
  return review;
}

export async function markSourceSchemaReviewAwaitingRetry(
  sourceId: number,
  moduleCode: string,
  diff: SchemaDiff,
  metadata: {
    moduleVersion: number;
    schemaFingerprint: string;
    stagedDecisions: SchemaReviewDecision[];
    retryMessage: string;
    operationId?: string;
    sourceIds?: number[];
    schemaFingerprints?: Record<string, string>;
  },
  client: SqlClient = defaultSql,
): Promise<PendingSourceSchemaReview> {
  const review: PendingSourceSchemaReview = {
    status: "awaiting_retry",
    operationId: metadata.operationId ?? randomUUID(),
    sourceIds: [...new Set(metadata.sourceIds ?? [sourceId])].sort((a, b) => a - b),
    moduleCode,
    moduleVersion: metadata.moduleVersion,
    schemaFingerprint: metadata.schemaFingerprint,
    schemaFingerprints:
      metadata.schemaFingerprints ?? { [sourceId]: metadata.schemaFingerprint },
    diff,
    detectedAt: new Date().toISOString(),
    stagedDecisions: structuredClone(metadata.stagedDecisions),
    retryMessage: metadata.retryMessage,
  };
  await client.unsafe(
    `UPDATE public.data_sources
     SET config = jsonb_set(
       COALESCE(config, '{}'::jsonb),
       '{schemaReview}',
       $1::jsonb,
       true
     ),
     updated_at = NOW()
     WHERE id = $2 AND type = 'file'`,
    [JSON.stringify(review), sourceId],
  );
  return review;
}

export async function clearSourceSchemaReview(
  sourceId: number,
  moduleCode: string,
  client: SqlClient = defaultSql,
): Promise<void> {
  await client.unsafe(
    `UPDATE public.data_sources
     SET config = COALESCE(config, '{}'::jsonb) - 'schemaReview',
         updated_at = NOW()
     WHERE id = $1
       AND type = 'file'
       AND config -> 'schemaReview' ->> 'moduleCode' = $2`,
    [sourceId, moduleCode],
  );
}

export async function assignSourceToModule(
  sourceId: number,
  moduleCode: string,
  client: SqlClient = defaultSql,
): Promise<void> {
  const updated = await client.unsafe(
    `UPDATE public.data_sources
     SET config = (
       CASE
         WHEN config ->> 'moduleCode' IS DISTINCT FROM $1::text
           THEN COALESCE(config, '{}'::jsonb) - 'schemaReview'
         ELSE COALESCE(config, '{}'::jsonb)
       END
     ) || jsonb_build_object('moduleCode', $1::text),
     updated_at = NOW()
     WHERE id = $2 AND type = 'file'
     RETURNING id`,
    [moduleCode, sourceId],
  );
  if (updated.length === 0) {
    throw new Error(`File source ${sourceId} does not exist`);
  }
}

export class SourceSchemaReviewStateError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
    this.name = "SourceSchemaReviewStateError";
  }
}

export type SourceSchemaReviewOperation = {
  review: PendingSourceSchemaReview;
  sources: Array<{ id: number; name: string; config: Record<string, any> }>;
};

export type SourceSchemaReviewExpectation = {
  moduleCode: string;
  operationId: string;
  sourceIds: number[];
  moduleVersion: number;
  schemaFingerprints: Record<string, string>;
  allowedStatuses: PendingSourceSchemaReview["status"][];
  stagedDecisions?: SchemaReviewDecision[];
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function normalizedSourceIds(sourceIds: number[]): number[] {
  return [...new Set(sourceIds)].sort((left, right) => left - right);
}

export function assertSourceSchemaReviewOperation(
  operation: SourceSchemaReviewOperation,
  expected?: SourceSchemaReviewExpectation,
): SourceSchemaReviewOperation {
  const anchor = operation.review;
  const expectation: SourceSchemaReviewExpectation = expected ?? {
    moduleCode: anchor.moduleCode,
    operationId: anchor.operationId,
    sourceIds: anchor.sourceIds,
    moduleVersion: anchor.moduleVersion,
    schemaFingerprints: anchor.schemaFingerprints,
    allowedStatuses: ["pending", "awaiting_retry"],
    stagedDecisions: anchor.stagedDecisions,
  };
  const sourceIds = normalizedSourceIds(expectation.sourceIds);
  const actualSourceIds = normalizedSourceIds(anchor.sourceIds ?? []);
  const fingerprintKeys = Object.keys(expectation.schemaFingerprints)
    .map(Number)
    .sort((left, right) => left - right);
  const members = [...operation.sources].sort((left, right) => left.id - right.id);
  const expectedStatus = anchor.status;
  const expectedStagedDecisions =
    expectedStatus === "awaiting_retry"
      ? expectation.stagedDecisions ?? anchor.stagedDecisions ?? []
      : [];
  const invalidAnchor =
    anchor.moduleCode !== expectation.moduleCode ||
    anchor.operationId !== expectation.operationId ||
    anchor.moduleVersion !== expectation.moduleVersion ||
    !sameJson(actualSourceIds, sourceIds) ||
    !sameJson(fingerprintKeys, sourceIds) ||
    !sameJson(anchor.schemaFingerprints, expectation.schemaFingerprints) ||
    !expectation.allowedStatuses.includes(expectedStatus) ||
    (expectedStatus === "pending" &&
      (anchor.stagedDecisions?.length ?? 0) > 0) ||
    (expectedStatus === "awaiting_retry" &&
      !sameJson(anchor.stagedDecisions ?? [], expectedStagedDecisions));
  if (
    invalidAnchor ||
    members.length !== sourceIds.length ||
    !sameJson(members.map((member) => member.id), sourceIds)
  ) {
    throw new SourceSchemaReviewStateError(
      "待确认文件组状态不一致，请刷新后重试",
      409,
    );
  }
  for (const member of members) {
    const marker = member.config?.schemaReview as
      | PendingSourceSchemaReview
      | undefined;
    if (
      member.config?.moduleCode !== expectation.moduleCode ||
      !marker ||
      marker.moduleCode !== expectation.moduleCode ||
      marker.operationId !== expectation.operationId ||
      marker.moduleVersion !== expectation.moduleVersion ||
      marker.status !== expectedStatus ||
      !expectation.allowedStatuses.includes(marker.status) ||
      !sameJson(normalizedSourceIds(marker.sourceIds ?? []), sourceIds) ||
      marker.schemaFingerprint !==
        expectation.schemaFingerprints[String(member.id)] ||
      !sameJson(marker.schemaFingerprints, expectation.schemaFingerprints) ||
      (marker.status === "pending" &&
        (marker.stagedDecisions?.length ?? 0) > 0) ||
      (marker.status === "awaiting_retry" &&
        !sameJson(marker.stagedDecisions ?? [], expectedStagedDecisions))
    ) {
      throw new SourceSchemaReviewStateError(
        "待确认文件组状态不一致，请刷新后重试",
        409,
      );
    }
  }
  return {
    review: {
      ...anchor,
      sourceIds,
      schemaFingerprints: { ...expectation.schemaFingerprints },
    },
    sources: members,
  };
}

export async function readSourceSchemaReviewOperation(
  sourceId: number,
  moduleCode: string,
  client: SqlClient = defaultSql,
  options?: { forUpdate?: boolean; expectedSourceIds?: number[] },
): Promise<SourceSchemaReviewOperation> {
  const rows = await client.unsafe(
    `SELECT id, name, config FROM public.data_sources
     WHERE id = $1 AND type = 'file'
     LIMIT 1
     ${options?.forUpdate ? "FOR UPDATE" : ""}`,
    [sourceId],
  ) as Array<{ id: number; name: string; config: Record<string, any> }>;
  const anchor = rows[0];
  const review = anchor?.config?.schemaReview as PendingSourceSchemaReview | undefined;
  if (!anchor || !review || review.moduleCode !== moduleCode) {
    throw new SourceSchemaReviewStateError("该文件没有待确认的字段变化");
  }
  const sourceIds = normalizedSourceIds(
    options?.expectedSourceIds ?? review.sourceIds ?? [sourceId],
  );
  const memberRows = await client.unsafe(
    `SELECT id, name, config FROM public.data_sources
     WHERE id = ANY($1::bigint[]) AND type = 'file'
     ORDER BY id
     ${options?.forUpdate ? "FOR UPDATE" : ""}`,
    [sourceIds],
  ) as Array<{ id: number | string; name: string; config: Record<string, any> }>;
  // postgres.js returns BIGINT identifiers as strings by default.  Normalize at
  // this boundary so operation membership comparisons do not reject an intact
  // review group merely because one side is "28" and the other is 28.
  const members = memberRows.map((member) => ({
    ...member,
    id: Number(member.id),
  }));
  if (members.length !== sourceIds.length) {
    throw new SourceSchemaReviewStateError("待确认文件组已变化，请重新上传", 409);
  }
  return assertSourceSchemaReviewOperation(
    { review: { ...review, sourceIds }, sources: members },
  );
}

export async function readSourceSchemaReview(
  sourceId: number,
  client: SqlClient = defaultSql,
): Promise<{
  moduleCode?: string;
  schemaReview?: PendingSourceSchemaReview;
} | null> {
  const rows = await client.unsafe(
    `SELECT config ->> 'moduleCode' AS module_code,
            config -> 'schemaReview' AS schema_review
     FROM public.data_sources
     WHERE id = $1 AND type = 'file'
     LIMIT 1`,
    [sourceId],
  ) as Array<{ module_code?: string; schema_review?: PendingSourceSchemaReview }>;
  const row = rows[0];
  if (!row) return null;
  return {
    ...(row.module_code ? { moduleCode: row.module_code } : {}),
    ...(row.schema_review ? { schemaReview: row.schema_review } : {}),
  };
}
