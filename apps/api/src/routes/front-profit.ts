import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import { sql } from "../db/client";
import { adminGuard } from "../lib/admin-guard";
import { authMiddleware, type AuthPayload } from "../lib/auth";
import { ComplexJobGateError } from "../services/complex-job.js";
import {
  FrontProfitAuthorityError,
  getOrCreateFrontProfitPeriodAuthority,
  reopenFrontProfitPeriod,
  setFrontProfitPeriodAuthority,
  type FrontProfitAuthorityState,
} from "../services/front-profit-authority.js";
import { FRONT_PROFIT_FEE_KINDS } from "../services/front-profit-business-rules.js";
import {
  FRONT_PROFIT_DRAFT_UNKNOWN_ERROR_CODE,
  FRONT_PROFIT_DRAFT_UNKNOWN_ERROR_MESSAGE,
  runFrontProfitDraftShadow,
  type FrontProfitDraftRunResult,
} from "../services/front-profit-draft-runner.js";
import {
  FrontProfitPublishError,
  publishFrontProfitL4Run,
  rollbackFrontProfitPublishVersion,
} from "../services/front-profit-publish.js";
import { FRONT_PROFIT_MODULE_CODE, frontProfitScopeKey } from "../services/front-profit-period.js";
import { FrontProfitValidationError } from "../services/front-profit-standard.js";

const r = new Hono<{ Variables: { user: AuthPayload } }>();
r.use("*", authMiddleware);

const FRONT_PROFIT_SOURCE_FAMILIES = [
  "operator_assignment",
  "sales_fact",
  "cost_period",
  "cost_usage",
  "rebate",
  "fee_fact",
  "promotion_spend",
] as const;
const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const authorityUpdateSchema = z.object({
  authority: z.enum(["manual", "auto"]).optional(),
  reopen: z.boolean().optional(),
  reason: z.string().trim().max(500).optional(),
});
const sourceFamilySchema = z.object({
  family: z.enum(FRONT_PROFIT_SOURCE_FAMILIES),
});
const sourceIdsSchema = z.array(z.number().int().positive()).optional().default([]);
const draftRunSchema = z.object({
  period: periodSchema,
  sources: z.object({
    operatorAssignments: sourceIdsSchema,
    sales: sourceIdsSchema,
    costPeriods: sourceIdsSchema,
    costUsages: sourceIdsSchema,
    rebates: sourceIdsSchema,
    fees: sourceIdsSchema,
    promotions: sourceIdsSchema,
  }).optional().default({}),
  manualBaselineSourceId: z.number().int().positive().nullable().optional(),
  requiredFeeKinds: z.array(z.enum(FRONT_PROFIT_FEE_KINDS)).optional(),
  mappingVersionId: z.number().int().positive().nullable().optional(),
  jobVersion: z.string().trim().min(1).max(128).optional(),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
const publishRunSchema = z.object({
  period: periodSchema,
  runId: z.number().int().positive(),
  publishSourceId: z.number().int().positive(),
  sourceIds: z.array(z.number().int().positive()).optional(),
  manualBaselineSourceId: z.number().int().positive().nullable().optional(),
  idempotencyKey: z.string().trim().min(1).max(128).regex(/^[\x21-\x7E]+$/).optional(),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
const rollbackPublishSchema = z.object({
  period: periodSchema,
  reason: z.string().trim().max(500).optional(),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
const RUN_DETAIL_DEFAULT_LIMITS = {
  dq: 100,
  recon: 200,
  l4: 50,
} as const;
const RUN_DETAIL_MAX_LIMIT = 500;

function statePayload(state: FrontProfitAuthorityState) {
  return {
    moduleCode: state.moduleCode,
    period: state.period,
    scopeKey: state.scopeKey,
    authority: state.authority,
    closeDay: state.closeDay,
    reopened: state.reopenedAt != null,
    reopenedAt: state.reopenedAt,
  };
}

function publishErrorPayload(error: unknown) {
  if (error instanceof FrontProfitAuthorityError) {
    return {
      ok: false,
      message: error.message,
      data: {
        errorCode: "FRONT_PROFIT_AUTHORITY_REJECTED",
        decisions: error.decisions,
      },
    };
  }
  if (error instanceof ComplexJobGateError) {
    return {
      ok: false,
      message: error.message,
      data: {
        errorCode: "FRONT_PROFIT_PUBLISH_GATE_REJECTED",
        blockingEventCodes: error.blockingEventCodes,
        failedReconMetrics: error.failedReconMetrics,
      },
    };
  }
  if (error instanceof FrontProfitPublishError) {
    return {
      ok: false,
      message: error.message,
      data: {
        errorCode: "FRONT_PROFIT_PUBLISH_FAILED",
      },
    };
  }
  if (error instanceof FrontProfitValidationError) {
    return {
      ok: false,
      message: error.message,
      data: {
        errorCode: "FRONT_PROFIT_PUBLISH_CONTRACT_INVALID",
        issues: error.issues,
      },
    };
  }
  return null;
}

function publicDraftFailure(result: FrontProfitDraftRunResult): FrontProfitDraftRunResult {
  const message = result.errorCode && result.errorCode !== FRONT_PROFIT_DRAFT_UNKNOWN_ERROR_CODE
    ? result.message ?? FRONT_PROFIT_DRAFT_UNKNOWN_ERROR_MESSAGE
    : FRONT_PROFIT_DRAFT_UNKNOWN_ERROR_MESSAGE;
  return { ...result, message };
}

function parsePositiveParam(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new FrontProfitPublishError(`${label} must be a positive safe integer`);
  }
  return parsed;
}

function parseBoundedQueryInt(
  value: string | undefined,
  input: {
    label: string;
    defaultValue: number;
    min: number;
    max: number;
  },
): number {
  if (value == null || value.trim() === "") return input.defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < input.min || parsed > input.max) {
    throw new FrontProfitPublishError(`${input.label} must be an integer between ${input.min} and ${input.max}`);
  }
  return parsed;
}

function pagePayload(input: { limit: number; offset: number; total: number }) {
  return {
    limit: input.limit,
    offset: input.offset,
    total: input.total,
    hasMore: input.offset + input.limit < input.total,
  };
}

r.get("/authority/:period", adminGuard, async (c) => {
  const period = periodSchema.parse(c.req.param("period"));
  const state = await getOrCreateFrontProfitPeriodAuthority(sql, period, {
    actorId: c.get("user").uid,
  });
  return c.json({ ok: true, data: statePayload(state) });
});

r.put("/authority/:period", adminGuard, zValidator("json", authorityUpdateSchema), async (c) => {
  const period = periodSchema.parse(c.req.param("period"));
  const body = c.req.valid("json");
  if (!body.authority && body.reopen !== true) {
    return c.json({ ok: false, message: "authority or reopen is required" }, 400);
  }

  const actorId = c.get("user").uid;
  const state = await sql.begin(async (tx) => {
    let current = body.authority
      ? await setFrontProfitPeriodAuthority(tx, {
          period,
          authority: body.authority,
          actorId,
          reason: body.reason,
        })
      : await getOrCreateFrontProfitPeriodAuthority(tx, period, { actorId });
    if (body.reopen === true) {
      current = await reopenFrontProfitPeriod(tx, {
        period,
        actorId,
        reason: body.reason,
      });
    }
    return current;
  });

  return c.json({ ok: true, data: statePayload(state) });
});

r.put("/source-family/:sourceId", adminGuard, zValidator("json", sourceFamilySchema), async (c) => {
  const sourceId = parsePositiveParam(c.req.param("sourceId"), "sourceId");
  const body = c.req.valid("json");
  const [updated] = await sql.unsafe(
    `UPDATE public.data_sources
     SET config = jsonb_set(
       COALESCE(config, '{}'::jsonb),
       '{frontProfitSourceFamily}',
       to_jsonb($2::text),
       true
     )
     WHERE id = $1
     RETURNING id, name, config`,
    [sourceId, body.family],
  );
  if (!updated) return c.json({ ok: false, message: "source not found" }, 404);
  return c.json({ ok: true, data: updated });
});

r.get("/runs", adminGuard, async (c) => {
  const periodResult = periodSchema.safeParse(c.req.query("period"));
  if (!periodResult.success) {
    return c.json({ ok: false, message: "period must be YYYY-MM" }, 400);
  }
  const scopeKey = frontProfitScopeKey(periodResult.data);
  const rows = await sql.unsafe(
    `SELECT jr.id,
            jr.module_code,
            jr.scope_key,
            jr.status,
            jr.input_batch_ids,
            jr.last_checkpoint_step,
            jr.started_at,
            jr.finished_at,
            jr.created_at,
            (SELECT COUNT(*)::int FROM public.job_step js WHERE js.run_id = jr.id) AS step_count,
            (SELECT COUNT(*)::int FROM public.dq_event dq WHERE dq.run_id = jr.id) AS dq_count,
            (SELECT COUNT(*)::int FROM public.dq_event dq WHERE dq.run_id = jr.id AND dq.severity = 'block' AND dq.resolved_at IS NULL) AS unresolved_block_count,
            (SELECT COUNT(*)::int FROM public.recon_result rr WHERE rr.run_id = jr.id) AS recon_count,
            (SELECT COUNT(*)::int FROM public.recon_result rr WHERE rr.run_id = jr.id AND rr.passed IS NOT TRUE) AS failed_recon_count,
            (SELECT COUNT(*)::int FROM public.front_profit_l4_agg_row l4 WHERE l4.run_id = jr.id) AS l4_count,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', pv.id,
                'versionNo', pv.version_no,
                'status', pv.status,
                'publishedAt', pv.published_at
              ) ORDER BY pv.id)
              FROM public.publish_version pv
              WHERE pv.module_code = $1 AND pv.scope_key = $2 AND pv.source_run_id = jr.id
            ), '[]'::jsonb) AS publish_versions
     FROM public.job_run jr
     WHERE jr.module_code = $1 AND jr.scope_key = $2
     ORDER BY jr.id DESC
     LIMIT 50`,
    [FRONT_PROFIT_MODULE_CODE, scopeKey],
  );
  return c.json({ ok: true, data: { rows } });
});

r.get("/runs/:runId", adminGuard, async (c) => {
  const runId = parsePositiveParam(c.req.param("runId"), "runId");
  const dqLimit = parseBoundedQueryInt(c.req.query("dqLimit"), {
    label: "dqLimit",
    defaultValue: RUN_DETAIL_DEFAULT_LIMITS.dq,
    min: 1,
    max: RUN_DETAIL_MAX_LIMIT,
  });
  const dqOffset = parseBoundedQueryInt(c.req.query("dqOffset"), {
    label: "dqOffset",
    defaultValue: 0,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  const reconLimit = parseBoundedQueryInt(c.req.query("reconLimit"), {
    label: "reconLimit",
    defaultValue: RUN_DETAIL_DEFAULT_LIMITS.recon,
    min: 1,
    max: RUN_DETAIL_MAX_LIMIT,
  });
  const reconOffset = parseBoundedQueryInt(c.req.query("reconOffset"), {
    label: "reconOffset",
    defaultValue: 0,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  const l4Limit = parseBoundedQueryInt(c.req.query("l4Limit"), {
    label: "l4Limit",
    defaultValue: RUN_DETAIL_DEFAULT_LIMITS.l4,
    min: 1,
    max: RUN_DETAIL_MAX_LIMIT,
  });
  const l4Offset = parseBoundedQueryInt(c.req.query("l4Offset"), {
    label: "l4Offset",
    defaultValue: 0,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  const [run] = await sql.unsafe(
    `SELECT id, module_code, scope_key, status, input_batch_ids, last_checkpoint_step,
            started_at, heartbeat_at, finished_at, created_at, updated_at
     FROM public.job_run
     WHERE id = $1 AND module_code = $2
     LIMIT 1`,
    [runId, FRONT_PROFIT_MODULE_CODE],
  );
  if (!run) return c.json({ ok: false, message: "run not found" }, 404);

  const [summaryRows, steps, dqEvents, reconResults, l4Rows, publishVersions] = await Promise.all([
    sql.unsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM public.job_step WHERE run_id = $1) AS step_count,
         (SELECT COUNT(*)::int FROM public.dq_event WHERE run_id = $1) AS dq_count,
         (SELECT COUNT(*)::int FROM public.dq_event WHERE run_id = $1 AND severity = 'block' AND resolved_at IS NULL) AS unresolved_block_count,
         (SELECT COUNT(*)::int FROM public.recon_result WHERE run_id = $1) AS recon_count,
         (SELECT COUNT(*)::int FROM public.recon_result WHERE run_id = $1 AND passed IS NOT TRUE) AS failed_recon_count,
         (SELECT COUNT(*)::int FROM public.front_profit_l4_agg_row WHERE run_id = $1) AS l4_count,
         (SELECT COUNT(*)::int FROM public.publish_version WHERE module_code = $2 AND source_run_id = $1) AS publish_version_count`,
      [runId, FRONT_PROFIT_MODULE_CODE],
    ),
    sql.unsafe(
      `SELECT step_key, attempt, status, rows_in, rows_out, error_code, started_at, finished_at
       FROM public.job_step
       WHERE run_id = $1
       ORDER BY id`,
      [runId],
    ),
    sql.unsafe(
      `SELECT severity, code, source_id, row_no, payload, resolved_at, created_at
       FROM public.dq_event
       WHERE run_id = $1
       ORDER BY id
       LIMIT $2 OFFSET $3`,
      [runId, dqLimit, dqOffset],
    ),
    sql.unsafe(
      `SELECT layer, metric, expected, actual, tolerance, passed, evidence_ref, created_at
       FROM public.recon_result
       WHERE run_id = $1
       ORDER BY id
       LIMIT $2 OFFSET $3`,
      [runId, reconLimit, reconOffset],
    ),
    sql.unsafe(
      `SELECT id, publish_version_id, period, record_id, aggregation_key, gmv, front_profit, data_status, created_at
       FROM public.front_profit_l4_agg_row
       WHERE run_id = $1
       ORDER BY id
       LIMIT $2 OFFSET $3`,
      [runId, l4Limit, l4Offset],
    ),
    sql.unsafe(
      `SELECT id, scope_key, version_no, status, source_run_id, published_by, published_at, created_at
       FROM public.publish_version
       WHERE module_code = $1 AND source_run_id = $2
       ORDER BY id`,
      [FRONT_PROFIT_MODULE_CODE, runId],
    ),
  ]);
  const summaryRow = summaryRows[0] ?? {};
  const summary = {
    stepCount: Number(summaryRow.step_count ?? 0),
    dqCount: Number(summaryRow.dq_count ?? 0),
    unresolvedBlockCount: Number(summaryRow.unresolved_block_count ?? 0),
    reconCount: Number(summaryRow.recon_count ?? 0),
    failedReconCount: Number(summaryRow.failed_recon_count ?? 0),
    l4Count: Number(summaryRow.l4_count ?? 0),
    publishVersionCount: Number(summaryRow.publish_version_count ?? 0),
  };

  return c.json({
    ok: true,
    data: {
      run,
      summary,
      pages: {
        dqEvents: pagePayload({ limit: dqLimit, offset: dqOffset, total: summary.dqCount }),
        reconResults: pagePayload({ limit: reconLimit, offset: reconOffset, total: summary.reconCount }),
        l4Rows: pagePayload({ limit: l4Limit, offset: l4Offset, total: summary.l4Count }),
      },
      steps,
      dqEvents,
      reconResults,
      l4Rows,
      publishVersions,
    },
  });
});

r.post("/draft-runs", adminGuard, zValidator("json", draftRunSchema), async (c) => {
  const body = c.req.valid("json");
  const result = await sql.begin(async (tx) =>
    runFrontProfitDraftShadow(tx, {
      period: body.period,
      sources: {
        operatorAssignmentSourceIds: body.sources.operatorAssignments,
        salesSourceIds: body.sources.sales,
        costPeriodSourceIds: body.sources.costPeriods,
        costUsageSourceIds: body.sources.costUsages,
        rebateSourceIds: body.sources.rebates,
        feeSourceIds: body.sources.fees,
        promotionSourceIds: body.sources.promotions,
      },
      manualBaselineSourceId: body.manualBaselineSourceId ?? null,
      requiredFeeKinds: body.requiredFeeKinds,
      actorId: c.get("user").uid,
      today: body.today,
      mappingVersionId: body.mappingVersionId ?? null,
      jobVersion: body.jobVersion,
    }));

  if (result.status === "failed") {
    const publicResult = publicDraftFailure(result);
    return c.json({ ok: false, message: publicResult.message, data: publicResult }, 400);
  }
  return c.json({ ok: true, data: result });
});

r.post("/publish-runs", adminGuard, zValidator("json", publishRunSchema), async (c) => {
  const body = c.req.valid("json");
  try {
    const result = await sql.begin(async (tx) =>
      publishFrontProfitL4Run(tx, {
        period: body.period,
        runId: body.runId,
        publishSourceId: body.publishSourceId,
        sourceIds: body.sourceIds,
        manualBaselineSourceId: body.manualBaselineSourceId ?? null,
        idempotencyKey: body.idempotencyKey,
        actorId: c.get("user").uid,
        today: body.today,
      }));
    return c.json({ ok: true, data: result });
  } catch (error) {
    const payload = publishErrorPayload(error);
    if (payload) return c.json(payload, 400);
    throw error;
  }
});

r.post("/publish-versions/:versionId/rollback", adminGuard, zValidator("json", rollbackPublishSchema), async (c) => {
  const body = c.req.valid("json");
  try {
    const versionId = parsePositiveParam(c.req.param("versionId"), "versionId");
    const result = await sql.begin(async (tx) =>
      rollbackFrontProfitPublishVersion(tx, {
        period: body.period,
        versionId,
        actorId: c.get("user").uid,
        reason: body.reason,
        today: body.today,
      }));
    return c.json({ ok: true, data: result });
  } catch (error) {
    const payload = publishErrorPayload(error);
    if (payload) return c.json(payload, 400);
    throw error;
  }
});

export default r;
