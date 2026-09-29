import { beforeEach, describe, expect, test, vi } from "vitest";
import { sign } from "../src/lib/auth.js";

const mocks = vi.hoisted(() => {
  const tx = { unsafe: vi.fn() };
  const unsafe = vi.fn();
  const begin = vi.fn(async (callback: (executor: typeof tx) => Promise<unknown>) =>
    callback(tx));
  const runFrontProfitDraftShadow = vi.fn();
  const publishFrontProfitL4Run = vi.fn(async () => ({
    runId: 11,
    period: "2026-08",
    version: {
      id: 101,
      period: "2026-08",
      versionNo: 3,
      status: "published",
      sourceRunId: 11,
    },
    stagedRowCount: 9,
    summary: { totalGmv: 123, totalFrontProfit: 45 },
    sourceIds: [1, 2, 22],
    idempotent: true,
  }));
  const rollbackFrontProfitPublishVersion = vi.fn(async () => ({
    period: "2026-08",
    rolledBackVersion: {
      id: 101,
      period: "2026-08",
      versionNo: 3,
      status: "rolled_back",
      sourceRunId: 11,
    },
    restoredVersion: {
      id: 100,
      period: "2026-08",
      versionNo: 2,
      status: "published",
      sourceRunId: 10,
    },
    rolledBackRowCount: 9,
    restoredRowCount: 8,
    idempotent: false,
  }));
  return {
    tx,
    unsafe,
    begin,
    runFrontProfitDraftShadow,
    publishFrontProfitL4Run,
    rollbackFrontProfitPublishVersion,
  };
});

vi.mock("../src/lib/current-auth-user.js", () => ({
  resolveCurrentAuthUser: vi.fn(async (payload: any) => payload),
}));

vi.mock("../src/db/client", () => ({
  sql: {
    begin: mocks.begin,
    unsafe: mocks.unsafe,
  },
}));

vi.mock("../src/services/front-profit-draft-runner.js", () => ({
  FRONT_PROFIT_DRAFT_UNKNOWN_ERROR_CODE: "FRONT_PROFIT_DRAFT_RUN_FAILED",
  FRONT_PROFIT_DRAFT_UNKNOWN_ERROR_MESSAGE: "前台利润草稿处理失败，请稍后重试",
  runFrontProfitDraftShadow: mocks.runFrontProfitDraftShadow,
}));

vi.mock("../src/services/front-profit-publish.js", () => ({
  FrontProfitPublishError: class FrontProfitPublishError extends Error {},
  publishFrontProfitL4Run: mocks.publishFrontProfitL4Run,
  rollbackFrontProfitPublishVersion: mocks.rollbackFrontProfitPublishVersion,
}));

import frontProfitRoutes from "../src/routes/front-profit.js";

const adminToken = sign({ uid: 1, username: "admin", isAdmin: true, tokenVersion: 0 });
const userToken = sign({ uid: 2, username: "operator", isAdmin: false, tokenVersion: 0 });

describe("front-profit publish routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.unsafe.mockReset();
    mocks.runFrontProfitDraftShadow.mockReset();
  });

  test("redacts an unsafe generic draft failure from both response message locations", async () => {
    const sensitiveDetail = [
      "password=top-secret",
      "postgres://ec_app:top-secret@127.0.0.1:5432/ec_data",
      "SELECT * FROM user_data.uf_8299",
      "C:\\private\\front-profit\\source.csv",
    ].join(" ");
    mocks.runFrontProfitDraftShadow.mockResolvedValue({
      runId: 22,
      period: "2026-08",
      status: "failed",
      sourceLoads: [],
      l3StageTimings: [],
      l3RowCount: 0,
      l4RowCount: 0,
      reconResultCount: 0,
      dqEventCount: 1,
      errorCode: "FRONT_PROFIT_DRAFT_RUN_FAILED",
      message: sensitiveDetail,
    });

    const response = await frontProfitRoutes.request("/draft-runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ period: "2026-08", sources: { sales: [8299] } }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      ok: false,
      message: "前台利润草稿处理失败，请稍后重试",
      data: {
        errorCode: "FRONT_PROFIT_DRAFT_RUN_FAILED",
        message: "前台利润草稿处理失败，请稍后重试",
      },
    });
    const publicResponse = JSON.stringify(body);
    expect(publicResponse).not.toContain("top-secret");
    expect(publicResponse).not.toContain("postgres://");
    expect(publicResponse).not.toContain("user_data");
    expect(publicResponse).not.toContain("source.csv");
  });

  test("returns run detail with paged evidence payloads for API smoke", async () => {
    mocks.unsafe.mockImplementation(async (query: string, parameters?: unknown[]) => {
      const text = String(query);
      if (text.startsWith("SELECT id, module_code")) {
        return [{
          id: 88,
          module_code: "front_profit",
          scope_key: "front_profit:2026-08",
          status: "recon_pending",
          input_batch_ids: ["source:1", "source:2"],
          last_checkpoint_step: "shadow_recon",
          started_at: "2026-08-11T00:00:00.000Z",
          heartbeat_at: null,
          finished_at: null,
          created_at: "2026-08-11T00:00:00.000Z",
          updated_at: "2026-08-11T00:00:01.000Z",
        }];
      }
      if (text.includes("SELECT COUNT(*)::int FROM public.job_step")) {
        return [{
          step_count: 4,
          dq_count: 5,
          unresolved_block_count: 0,
          recon_count: 39,
          failed_recon_count: 0,
          l4_count: 6047,
          publish_version_count: 1,
        }];
      }
      if (text.startsWith("SELECT step_key")) {
        return [
          { step_key: "source_load", attempt: 1, status: "succeeded", rows_in: 7, rows_out: 119200, error_code: null },
          { step_key: "l3_stage", attempt: 1, status: "succeeded", rows_in: null, rows_out: 105500, error_code: null },
          { step_key: "l4_aggregate", attempt: 1, status: "succeeded", rows_in: 105500, rows_out: 6047, error_code: null },
          { step_key: "shadow_recon", attempt: 1, status: "succeeded", rows_in: 6047, rows_out: 4, error_code: null },
        ];
      }
      if (text.startsWith("SELECT severity")) {
        expect(parameters).toEqual([88, 1, 2]);
        return [{
          severity: "warn",
          code: "SYNTHETIC_WARN",
          source_id: 7,
          row_no: 9,
          payload: { message: "paged dq evidence" },
          resolved_at: null,
          created_at: "2026-08-11T00:00:02.000Z",
        }];
      }
      if (text.startsWith("SELECT layer")) {
        expect(parameters).toEqual([88, 2, 1]);
        return [{
          layer: "L3_L4",
          metric: "gmv_sum",
          expected: "10.00",
          actual: "10.00",
          tolerance: "0.01",
          passed: true,
          evidence_ref: { sourceLayer: "front_profit_l3_calc_detail", targetLayer: "front_profit_l4_agg_row" },
          created_at: "2026-08-11T00:00:03.000Z",
        }];
      }
      if (text.startsWith("SELECT id, publish_version_id")) {
        expect(parameters).toEqual([88, 3, 4]);
        return [{
          id: 501,
          publish_version_id: null,
          period: "2026-08",
          record_id: "FP_L4_001",
          aggregation_key: "2026-08-01\u001ftmall\u001fstandard\u001fshop-a\u001fop-a",
          gmv: "10.00",
          front_profit: "3.00",
          data_status: "auto_draft",
          created_at: "2026-08-11T00:00:04.000Z",
        }];
      }
      if (text.startsWith("SELECT id, scope_key")) {
        return [{
          id: 101,
          scope_key: "front_profit:2026-08",
          version_no: 1,
          status: "published",
          source_run_id: 88,
          published_by: 1,
          published_at: "2026-08-11T00:00:05.000Z",
          created_at: "2026-08-11T00:00:05.000Z",
        }];
      }
      throw new Error(`unexpected SQL: ${text}`);
    });

    const response = await frontProfitRoutes.request(
      "/runs/88?dqLimit=1&dqOffset=2&reconLimit=2&reconOffset=1&l4Limit=3&l4Offset=4",
      {
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.summary).toMatchObject({
      stepCount: 4,
      dqCount: 5,
      reconCount: 39,
      l4Count: 6047,
      publishVersionCount: 1,
    });
    expect(body.data.pages).toMatchObject({
      dqEvents: { limit: 1, offset: 2, total: 5, hasMore: true },
      reconResults: { limit: 2, offset: 1, total: 39, hasMore: true },
      l4Rows: { limit: 3, offset: 4, total: 6047, hasMore: true },
    });
    expect(body.data.dqEvents[0].payload).toEqual({ message: "paged dq evidence" });
    expect(body.data.reconResults[0].evidence_ref).toMatchObject({
      sourceLayer: "front_profit_l3_calc_detail",
    });
    expect(body.data.l4Rows[0]).toMatchObject({
      record_id: "FP_L4_001",
      data_status: "auto_draft",
    });
    expect(body.data.publishVersions).toHaveLength(1);
  });

  test("requires an administrator for run publish", async () => {
    const response = await frontProfitRoutes.request("/publish-runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        period: "2026-08",
        runId: 11,
        publishSourceId: 22,
      }),
    });

    expect(response.status).toBe(403);
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.publishFrontProfitL4Run).not.toHaveBeenCalled();
  });

  test("publishes a run inside a transaction with the idempotency key", async () => {
    const response = await frontProfitRoutes.request("/publish-runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        period: "2026-08",
        runId: 11,
        publishSourceId: 22,
        sourceIds: [1, 2],
        manualBaselineSourceId: null,
        idempotencyKey: "front-profit:2026-08:run:11",
        today: "2026-09-05",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      runId: 11,
      period: "2026-08",
      stagedRowCount: 9,
      idempotent: true,
    });
    expect(mocks.begin).toHaveBeenCalledTimes(1);
    expect(mocks.publishFrontProfitL4Run).toHaveBeenCalledWith(mocks.tx, {
      period: "2026-08",
      runId: 11,
      publishSourceId: 22,
      sourceIds: [1, 2],
      manualBaselineSourceId: null,
      idempotencyKey: "front-profit:2026-08:run:11",
      actorId: 1,
      today: "2026-09-05",
    });
  });

  test("rolls back a publish version inside a transaction", async () => {
    const response = await frontProfitRoutes.request("/publish-versions/101/rollback", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        period: "2026-08",
        reason: " restore previous version ",
        today: "2026-09-06",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      period: "2026-08",
      rolledBackRowCount: 9,
      restoredRowCount: 8,
      idempotent: false,
    });
    expect(mocks.begin).toHaveBeenCalledTimes(1);
    expect(mocks.rollbackFrontProfitPublishVersion).toHaveBeenCalledWith(mocks.tx, {
      period: "2026-08",
      versionId: 101,
      actorId: 1,
      reason: "restore previous version",
      today: "2026-09-06",
    });
  });

  test("requires an administrator for publish rollback", async () => {
    const response = await frontProfitRoutes.request("/publish-versions/101/rollback", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        period: "2026-08",
      }),
    });

    expect(response.status).toBe(403);
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.rollbackFrontProfitPublishVersion).not.toHaveBeenCalled();
  });

  test("returns a structured 400 response for an invalid rollback version id", async () => {
    const response = await frontProfitRoutes.request("/publish-versions/not-a-number/rollback", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        period: "2026-08",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      ok: false,
      message: "versionId must be a positive safe integer",
      data: {
        errorCode: "FRONT_PROFIT_PUBLISH_FAILED",
      },
    });
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.rollbackFrontProfitPublishVersion).not.toHaveBeenCalled();
  });
});
