import { describe, expect, test, vi } from "vitest";
import { ComplexJobGateError } from "../src/services/complex-job.js";
import { setFrontProfitPeriodAuthority } from "../src/services/front-profit-authority.js";
import {
  createFrontProfitDraftPublishVersion,
  publishFrontProfitL4Run,
  publishFrontProfitVersion,
  rollbackFrontProfitPublishVersion,
  stageFrontProfitL4PublishRows,
  stageFrontProfitPublishRows,
} from "../src/services/front-profit-publish.js";
import { FRONT_PROFIT_STANDARD_HEADERS } from "../src/services/front-profit-standard.js";
import {
  syntheticFrontProfitL4AggRow,
} from "./fixtures/front-profit-complex-fixtures.js";
import type { FrontProfitL4AggRowForContract } from "../src/services/front-profit-layers.js";

type AuthorityRow = {
  authority: "manual" | "auto";
  close_day: number;
  reopened_at: Date | null;
};

type VersionRow = {
  id: number;
  module_code: string;
  scope_key: string;
  version_no: number;
  status: "draft" | "validated" | "published" | "superseded" | "rolled_back";
  superseded_by?: number | null;
  source_run_id?: number | null;
};

type JobRunRow = {
  id: number;
  module_code: string;
  scope_key: string;
  status: "queued" | "running" | "recon_pending" | "gated" | "published" | "failed" | "rolled_back";
  input_batch_ids: unknown[];
  last_checkpoint_step?: string | null;
};

type PublishSourceRow = {
  publishVersionId: number;
  sourceId: number;
  sourceRunId: number | null;
  inputBatchId: string | null;
  role: string;
  payload: Record<string, unknown>;
};

type PublishRow = {
  publishVersionId: number;
  sourceId: number;
  status: "draft" | "published" | "superseded" | "rolled_back";
  period: string;
  recordId: string;
  aggregationKey: string;
  date?: string;
};

type L4StoredRow = FrontProfitL4AggRowForContract & {
  id: number;
  runId: number;
  period: string;
  publishVersionId: number | null;
};

type DqEventRow = {
  runId: number;
  severity: "block" | "warn" | "allow";
  code: string;
  resolvedAt?: unknown;
};

type ReconResultRow = {
  runId: number;
  layer: string;
  metric: string;
  passed: boolean;
};

function jsonbParam<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function fakePublishExecutor() {
  const authorities = new Map<string, AuthorityRow>();
  const dataSourceIds = new Set([51, 60, 61, 77]);
  const jobRuns: JobRunRow[] = [];
  const versions: VersionRow[] = [];
  const sources: PublishSourceRow[] = [];
  const rows: PublishRow[] = [];
  const l4Rows: L4StoredRow[] = [];
  const dqEvents: DqEventRow[] = [];
  const reconResults: ReconResultRow[] = [];
  let nextId = 1;
  const executor = {
    authorities,
    dataSourceIds,
    jobRuns,
    versions,
    sources,
    rows,
    l4Rows,
    dqEvents,
    reconResults,
    locks: [] as string[],
    unsafe: vi.fn(async (query: string, parameters?: unknown[]) => {
      const text = String(query);
      const key = `${parameters?.[0]}:${parameters?.[1]}`;

      if (text.startsWith("SELECT pg_advisory_xact_lock")) {
        executor.locks.push(String(parameters?.[0]));
        return [{ pg_advisory_xact_lock: null }];
      }

      if (text.startsWith("SELECT id FROM public.data_sources")) {
        const requested = Array.isArray(parameters?.[0]) ? parameters[0] : [];
        return requested
          .map(Number)
          .filter((id) => dataSourceIds.has(id))
          .map((id) => ({ id }));
      }

      if (text.startsWith("SELECT severity, code, resolved_at")) {
        const runId = Number(parameters?.[0]);
        return dqEvents
          .filter((event) => event.runId === runId)
          .map((event) => ({
            severity: event.severity,
            code: event.code,
            resolvedAt: event.resolvedAt,
          }));
      }
      if (text.startsWith("SELECT layer, metric, passed")) {
        const runId = Number(parameters?.[0]);
        return reconResults
          .filter((result) => result.runId === runId)
          .map((result) => ({
            layer: result.layer,
            metric: result.metric,
            passed: result.passed,
          }));
      }
      if (text.startsWith("SELECT id, module_code, scope_key, status, input_batch_ids")) {
        const runId = Number(parameters?.[0]);
        const run = jobRuns.find((item) => item.id === runId);
        return run ? [{
          id: run.id,
          module_code: run.module_code,
          scope_key: run.scope_key,
          status: run.status,
          input_batch_ids: run.input_batch_ids,
        }] : [];
      }
      if (text.startsWith("UPDATE public.job_run")) {
        const runId = Number(parameters?.[0]);
        const moduleCode = String(parameters?.[1]);
        const run = jobRuns.find((item) => item.id === runId && item.module_code === moduleCode);
        if (run) {
          run.status = parameters?.[2] as JobRunRow["status"];
          run.last_checkpoint_step = parameters?.[3] == null ? run.last_checkpoint_step : String(parameters?.[3]);
        }
        return [];
      }

      if (text.startsWith("INSERT INTO public.period_authority_event")) return [];
      if (text.startsWith("INSERT INTO public.period_authority")) {
        if (!authorities.has(key)) {
          authorities.set(key, {
            authority: "manual",
            close_day: Number(parameters?.[2]),
            reopened_at: null,
          });
          return [{ id: authorities.size }];
        }
        return [];
      }
      if (text.startsWith("SELECT authority, close_day, reopened_at")) {
        const row = authorities.get(key);
        return row ? [row] : [];
      }
      if (text.startsWith("UPDATE public.period_authority") && text.includes("SET authority")) {
        const row = authorities.get(key);
        if (row) row.authority = parameters?.[2] as "manual" | "auto";
        return [];
      }

      if (text.startsWith("SELECT date,")) {
        const runId = Number(parameters?.[0]);
        const period = String(parameters?.[1]);
        return l4Rows
          .filter((row) => row.runId === runId && row.period === period)
          .sort((left, right) => left.id - right.id)
          .map((row) => ({
            date: row.date,
            aggregation_key: row.aggregationKey,
            platform: row.platform,
            business_mode: row.businessMode,
            group_name: row.groupName ?? null,
            shop: row.shop,
            shop_normalized: row.shopNormalized ?? null,
            operator: row.operator,
            quantity: row.quantity,
            gmv: row.gmv,
            fill_order_amount: row.fillOrderAmount,
            fill_order_product_cost: row.fillOrderProductCost,
            fill_order_quantity: row.fillOrderQuantity,
            product_cost: row.productCost,
            shipment_value: row.shipmentValue,
            platform_fee: row.platformFee,
            tax_fee: row.taxFee,
            finance_cost: row.financeCost,
            freight: row.freight,
            commission: row.commission,
            promotion_fee: row.promotionFee,
            source_file: row.sourceFile ?? null,
            source_batch: row.sourceBatch ?? null,
            note: row.note ?? null,
            real_revenue: row.realRevenue,
            front_profit: row.frontProfit,
            paid_ratio: row.paidRatio,
            record_id: row.recordId,
            data_status: row.dataStatus ?? null,
          }));
      }
      if (text.startsWith("UPDATE public.front_profit_l4_agg_row")) {
        const publishVersionId = Number(parameters?.[0]);
        const runId = Number(parameters?.[1]);
        const period = String(parameters?.[2]);
        for (const row of l4Rows) {
          if (row.runId === runId && row.period === period) {
            row.publishVersionId = publishVersionId;
          }
        }
        return [];
      }

      if (text.startsWith("INSERT INTO public.publish_version_source")) {
        const chunkSize = 6;
        for (let i = 0; i < (parameters?.length ?? 0); i += chunkSize) {
          const publishVersionId = Number(parameters?.[i]);
          const sourceId = Number(parameters?.[i + 1]);
          const role = String(parameters?.[i + 4]);
          const existing = sources.find((source) =>
            source.publishVersionId === publishVersionId &&
            source.sourceId === sourceId &&
            source.role === role,
          );
          const next = {
            publishVersionId,
            sourceId,
            sourceRunId: parameters?.[i + 2] == null ? null : Number(parameters?.[i + 2]),
            inputBatchId: parameters?.[i + 3] == null ? null : String(parameters?.[i + 3]),
            role,
            payload: jsonbParam<Record<string, unknown>>(parameters?.[i + 5], {}),
          };
          if (existing) {
            Object.assign(existing, {
              ...next,
              payload: { ...existing.payload, ...next.payload },
            });
          }
          else sources.push(next);
        }
        return [];
      }
      if (text.startsWith("UPDATE public.publish_version_source") && text.includes("'rollback'")) {
        const publishVersionId = Number(parameters?.[0]);
        for (const source of sources) {
          if (source.publishVersionId === publishVersionId) {
            source.payload = {
              ...source.payload,
              rollback: {
                actorId: Number(parameters?.[1]),
                reason: parameters?.[2] == null ? null : String(parameters?.[2]),
                restoredVersionId: Number(parameters?.[3]),
              },
            };
          }
        }
        return [];
      }

      if (text.startsWith("SELECT pv.source_run_id")) {
        const moduleCode = String(parameters?.[0]);
        const scopeKey = String(parameters?.[1]);
        const idempotencyKey = String(parameters?.[2]);
        const matched = sources
          .map((source) => ({
            source,
            version: versions.find((version) => version.id === source.publishVersionId),
          }))
          .filter(({ source, version }) =>
            version?.module_code === moduleCode &&
            version.scope_key === scopeKey &&
            source.payload.idempotencyKey === idempotencyKey,
          )
          .sort((left, right) => (right.version?.id ?? 0) - (left.version?.id ?? 0))[0];
        return matched?.version ? [{ source_run_id: matched.version.source_run_id ?? null }] : [];
      }

      if (text.startsWith("SELECT pv.id,")) {
        const moduleCode = String(parameters?.[0]);
        const scopeKey = String(parameters?.[1]);
        const runId = Number(parameters?.[2]);
        const version = versions
          .filter((item) =>
            item.module_code === moduleCode &&
            item.scope_key === scopeKey &&
            item.source_run_id === runId &&
            item.status === "published",
          )
          .sort((left, right) => right.id - left.id)[0];
        if (!version) return [];
        const versionSources = sources.filter((source) => source.publishVersionId === version.id);
        return [{
          id: version.id,
          version_no: version.version_no,
          status: version.status,
          source_run_id: version.source_run_id ?? null,
          row_count: rows.filter((row) =>
            row.publishVersionId === version.id &&
            row.status === "published",
          ).length,
          source_ids: [...new Set(versionSources.map((source) => source.sourceId))]
            .sort((left, right) => left - right),
          summary: versionSources.find((source) => source.sourceRunId === runId && source.payload.summary)?.payload.summary ?? null,
        }];
      }

      if (text.startsWith("SELECT (COALESCE(MAX(version_no)")) {
        const moduleCode = String(parameters?.[0]);
        const scopeKey = String(parameters?.[1]);
        const max = versions
          .filter((version) => version.module_code === moduleCode && version.scope_key === scopeKey)
          .reduce((highest, version) => Math.max(highest, version.version_no), 0);
        return [{ version_no: max + 1 }];
      }
      if (text.startsWith("INSERT INTO public.publish_version")) {
        const version: VersionRow = {
          id: nextId++,
          module_code: String(parameters?.[0]),
          scope_key: String(parameters?.[1]),
          version_no: Number(parameters?.[2]),
          status: "draft",
          source_run_id: parameters?.[3] == null ? null : Number(parameters?.[3]),
        };
        versions.push(version);
        return [{
          id: version.id,
          version_no: version.version_no,
          status: version.status,
          source_run_id: version.source_run_id,
        }];
      }
      if (text.startsWith("SELECT id, version_no, status, source_run_id") && text.includes("version_no <")) {
        const moduleCode = String(parameters?.[0]);
        const scopeKey = String(parameters?.[1]);
        const beforeVersionNo = Number(parameters?.[2]);
        const status = parameters?.[3] as VersionRow["status"];
        const version = versions
          .filter((item) =>
            item.module_code === moduleCode &&
            item.scope_key === scopeKey &&
            item.version_no < beforeVersionNo &&
            item.status === status,
          )
          .sort((left, right) => right.version_no - left.version_no)[0];
        return version ? [{
          id: version.id,
          version_no: version.version_no,
          status: version.status,
          source_run_id: version.source_run_id ?? null,
        }] : [];
      }
      if (text.startsWith("SELECT id, version_no, status")) {
        const id = Number(parameters?.[0]);
        const moduleCode = String(parameters?.[1]);
        const scopeKey = String(parameters?.[2]);
        const version = versions.find((item) =>
          item.id === id && item.module_code === moduleCode && item.scope_key === scopeKey,
        );
        return version ? [{
          id: version.id,
          version_no: version.version_no,
          status: version.status,
          source_run_id: version.source_run_id ?? null,
        }] : [];
      }
      if (text.startsWith("DELETE FROM public.front_profit_publish_row")) {
        const versionId = Number(parameters?.[0]);
        const sourceId = Number(parameters?.[1]);
        for (let i = rows.length - 1; i >= 0; i--) {
          if (
            rows[i]?.publishVersionId === versionId &&
            rows[i]?.sourceId === sourceId &&
            rows[i]?.status === "draft"
          ) {
            rows.splice(i, 1);
          }
        }
        return [];
      }
      if (text.startsWith("INSERT INTO public.front_profit_publish_row")) {
        const chunkSize = 33;
        for (let i = 0; i < (parameters?.length ?? 0); i += chunkSize) {
          rows.push({
            publishVersionId: Number(parameters?.[i]),
            sourceId: Number(parameters?.[i + 1]),
            status: parameters?.[i + 2] as PublishRow["status"],
            period: String(parameters?.[i + 3]),
            recordId: String(parameters?.[i + 4]),
            aggregationKey: String(parameters?.[i + 5]),
            date: String(parameters?.[i + 6]),
          });
        }
        return [];
      }
      if (text.startsWith("UPDATE public.publish_version") && text.includes("status = 'validated'")) {
        const versionId = Number(parameters?.[0]);
        const version = versions.find((item) => item.id === versionId && item.status === "draft");
        if (!version) return [];
        version.status = "validated";
        return [{ id: version.id, version_no: version.version_no, status: version.status }];
      }
      if (text.startsWith("SELECT COUNT(*)::int AS row_count")) {
        const versionId = Number(parameters?.[0]);
        const status = parameters?.[1] == null ? "draft" : String(parameters?.[1]);
        return [{
          row_count: rows.filter((row) =>
            row.publishVersionId === versionId && row.status === status,
          ).length,
        }];
      }
      if (text.startsWith("UPDATE public.publish_version") && text.includes("SET status = 'superseded'")) {
        const versionId = Number(parameters?.[0]);
        const moduleCode = String(parameters?.[1]);
        const scopeKey = String(parameters?.[2]);
        for (const version of versions) {
          if (
            version.id !== versionId &&
            version.module_code === moduleCode &&
            version.scope_key === scopeKey &&
            version.status === "published"
          ) {
            version.status = "superseded";
            version.superseded_by = versionId;
          }
        }
        return [];
      }
      if (text.startsWith("UPDATE public.front_profit_publish_row") && text.includes("SET status = 'superseded'")) {
        const period = String(parameters?.[0]);
        const versionId = Number(parameters?.[1]);
        for (const row of rows) {
          if (
            row.period === period &&
            row.status === "published" &&
            row.publishVersionId !== versionId
          ) {
            row.status = "superseded";
          }
        }
        return [];
      }
      if (text.startsWith("UPDATE public.front_profit_publish_row") && text.includes("SET status = 'rolled_back'")) {
        const versionId = Number(parameters?.[0]);
        for (const row of rows) {
          if (row.publishVersionId === versionId && row.status === "published") {
            row.status = "rolled_back";
          }
        }
        return [];
      }
      if (text.startsWith("UPDATE public.publish_version") && text.includes("SET status = 'rolled_back'")) {
        const versionId = Number(parameters?.[0]);
        const restoredVersionId = Number(parameters?.[1]);
        const version = versions.find((item) => item.id === versionId && item.status === "published");
        if (!version) return [];
        version.status = "rolled_back";
        version.superseded_by = restoredVersionId;
        return [{
          id: version.id,
          version_no: version.version_no,
          status: version.status,
          source_run_id: version.source_run_id ?? null,
        }];
      }
      if (text.startsWith("UPDATE public.front_profit_publish_row") && text.includes("SET status = 'published'") && text.includes("status = 'superseded'")) {
        const versionId = Number(parameters?.[0]);
        for (const row of rows) {
          if (row.publishVersionId === versionId && row.status === "superseded") {
            row.status = "published";
          }
        }
        return [];
      }
      if (text.startsWith("UPDATE public.front_profit_publish_row") && text.includes("SET status = 'published'")) {
        const versionId = Number(parameters?.[0]);
        for (const row of rows) {
          if (row.publishVersionId === versionId && row.status === "draft") {
            row.status = "published";
          }
        }
        return [];
      }
      if (text.startsWith("UPDATE public.publish_version") && text.includes("status = 'published'")) {
        const versionId = Number(parameters?.[0]);
        const version = versions.find((item) => item.id === versionId);
        if (!version) return [];
        version.status = "published";
        if (text.includes("superseded_by = NULL")) {
          version.superseded_by = null;
        }
        return [{
          id: version.id,
          version_no: version.version_no,
          status: version.status,
          source_run_id: version.source_run_id ?? null,
        }];
      }

      throw new Error(`unexpected SQL: ${text}`);
    }),
  };
  return executor;
}

const publishDataRow = (): unknown[] => [
  new Date(2026, 7, 1, 12),
  "合成平台",
  "自营",
  "合成组",
  "合成店铺",
  "合成归一店铺",
  "合成运营",
  1,
  100,
  10,
  2,
  1,
  30,
  100,
  5,
  1,
  2,
  3,
  4,
  5,
  "synthetic-source.xlsx",
  "BATCH-1",
  "synthetic",
  90,
  42,
  0.05,
  "SYNTHETIC_PUBLISH_001",
  "原状态",
];

describe("front-profit automatic publish path", () => {
  test("allows auto draft creation while the period authority is still manual", async () => {
    const executor = fakePublishExecutor();

    await expect(createFrontProfitDraftPublishVersion(executor, {
      period: "2026-08",
      sourceRunId: 11,
      sources: [{ sourceId: 51, sourceRunId: 11, inputBatchId: "BATCH-1" }],
      today: "2026-09-01",
    })).resolves.toMatchObject({
      period: "2026-08",
      scopeKey: "front_profit:2026-08",
      versionNo: 1,
      status: "draft",
    });
    expect(executor.locks).toEqual(["complex-job:publish:front_profit"]);
    expect(executor.versions).toHaveLength(1);
    expect(executor.sources).toEqual([expect.objectContaining({
      publishVersionId: 1,
      sourceId: 51,
      sourceRunId: 11,
      inputBatchId: "BATCH-1",
      role: "input",
    })]);
  });

  test("stages fixed publish rows through the canonical rows contract", async () => {
    const executor = fakePublishExecutor();
    const draft = await createFrontProfitDraftPublishVersion(executor, {
      period: "2026-08",
      today: "2026-09-01",
    });

    await expect(stageFrontProfitPublishRows(executor, {
      period: "2026-08",
      versionId: draft.id,
      sourceId: 51,
      sourceRunId: 11,
      inputBatchId: "BATCH-1",
      headers: FRONT_PROFIT_STANDARD_HEADERS,
      dataRows: [publishDataRow()],
    })).resolves.toMatchObject({
      id: draft.id,
      status: "validated",
      rowCount: 1,
      summary: {
        schemaVersion: "front-profit-standard/v1",
        businessRowCount: 1,
        warningCount: 0,
      },
    });
    expect(executor.sources).toEqual([expect.objectContaining({
      publishVersionId: draft.id,
      sourceId: 51,
      sourceRunId: 11,
      inputBatchId: "BATCH-1",
      role: "input",
    })]);
    expect(executor.rows).toEqual([expect.objectContaining({
      publishVersionId: draft.id,
      sourceId: 51,
      status: "draft",
      period: "2026-08",
      recordId: "SYNTHETIC_PUBLISH_001",
      date: "2026-08-01",
    })]);
  });

  test("stages L4 aggregation rows through the same canonical publish path", async () => {
    const executor = fakePublishExecutor();
    const draft = await createFrontProfitDraftPublishVersion(executor, {
      period: "2026-08",
      today: "2026-09-01",
    });
    executor.l4Rows.push({
      id: 1,
      runId: 22,
      period: "2026-08",
      publishVersionId: null,
      ...syntheticFrontProfitL4AggRow({
        date: "2026-08-02",
        recordId: "SYNTHETIC_L4_PUBLISH_001",
      }),
    });

    await expect(stageFrontProfitL4PublishRows(executor, {
      period: "2026-08",
      versionId: draft.id,
      sourceId: 77,
      runId: 22,
    })).resolves.toMatchObject({
      id: draft.id,
      status: "validated",
      rowCount: 1,
    });

    expect(executor.sources).toEqual([expect.objectContaining({
      publishVersionId: draft.id,
      sourceId: 77,
      sourceRunId: 22,
      inputBatchId: "front-profit-l4-run:22",
      role: "input",
    })]);
    expect(executor.rows).toEqual([expect.objectContaining({
      publishVersionId: draft.id,
      sourceId: 77,
      status: "draft",
      period: "2026-08",
      recordId: "SYNTHETIC_L4_PUBLISH_001",
      date: "2026-08-02",
    })]);
    expect(executor.l4Rows[0]?.publishVersionId).toBe(draft.id);
  });

  test("rejects L4 staging when the run produced no aggregation rows", async () => {
    const executor = fakePublishExecutor();
    const draft = await createFrontProfitDraftPublishVersion(executor, {
      period: "2026-08",
      today: "2026-09-01",
    });

    await expect(stageFrontProfitL4PublishRows(executor, {
      period: "2026-08",
      versionId: draft.id,
      sourceId: 77,
      runId: 22,
    })).rejects.toThrow(/no aggregation rows/);
    expect(executor.rows).toEqual([]);
  });

  test("blocks L4 staging when the run has unresolved gate evidence", async () => {
    const executor = fakePublishExecutor();
    const draft = await createFrontProfitDraftPublishVersion(executor, {
      period: "2026-08",
      today: "2026-09-01",
    });
    executor.l4Rows.push({
      id: 1,
      runId: 22,
      period: "2026-08",
      publishVersionId: null,
      ...syntheticFrontProfitL4AggRow({
        date: "2026-08-02",
        recordId: "SYNTHETIC_L4_PUBLISH_001",
      }),
    });
    executor.dqEvents.push({
      runId: 22,
      severity: "block",
      code: "UNRESOLVED_SOURCE_GAP",
    });

    await expect(stageFrontProfitL4PublishRows(executor, {
      period: "2026-08",
      versionId: draft.id,
      sourceId: 77,
      runId: 22,
    })).rejects.toBeInstanceOf(ComplexJobGateError);
    expect(executor.rows).toEqual([]);
    expect(executor.l4Rows[0]?.publishVersionId).toBeNull();
  });

  test("publishes a reconciled L4 run end to end under auto authority", async () => {
    const executor = fakePublishExecutor();
    await setFrontProfitPeriodAuthority(executor, {
      period: "2026-08",
      authority: "auto",
      actorId: 9,
    });
    executor.jobRuns.push({
      id: 22,
      module_code: "front_profit",
      scope_key: "front_profit:2026-08",
      status: "recon_pending",
      input_batch_ids: ["source:51", "source:60"],
    });
    executor.l4Rows.push({
      id: 1,
      runId: 22,
      period: "2026-08",
      publishVersionId: null,
      ...syntheticFrontProfitL4AggRow({
        date: "2026-08-02",
        recordId: "SYNTHETIC_RUN_PUBLISH_001",
      }),
    });

    await expect(publishFrontProfitL4Run(executor, {
      period: "2026-08",
      runId: 22,
      publishSourceId: 51,
      manualBaselineSourceId: 60,
      idempotencyKey: "publish-2026-08-run-22",
      actorId: 9,
      today: "2026-09-01",
    })).resolves.toMatchObject({
      runId: 22,
      period: "2026-08",
      version: {
        status: "published",
        versionNo: 1,
      },
      stagedRowCount: 1,
      sourceIds: [51, 60],
      idempotent: false,
    });

    expect(executor.jobRuns[0]).toMatchObject({
      status: "published",
      last_checkpoint_step: "publish",
    });
    expect(executor.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 51, role: "input", sourceRunId: 22 }),
      expect.objectContaining({ sourceId: 60, role: "manual_baseline", sourceRunId: 22 }),
    ]));
    expect(executor.rows).toEqual([expect.objectContaining({
      publishVersionId: 1,
      sourceId: 51,
      status: "published",
      period: "2026-08",
      recordId: "SYNTHETIC_RUN_PUBLISH_001",
    })]);
    expect(executor.l4Rows[0]?.publishVersionId).toBe(1);
    expect(executor.sources.find((source) => source.sourceId === 51)?.payload).toMatchObject({
      idempotencyKey: "publish-2026-08-run-22",
      summary: {
        schemaVersion: "front-profit-standard/v1",
        businessRowCount: 1,
        warningCount: 0,
      },
    });
  });

  test("rejects a missing publish source before creating provenance or a version", async () => {
    const executor = fakePublishExecutor();
    await setFrontProfitPeriodAuthority(executor, {
      period: "2026-08",
      authority: "auto",
      actorId: 9,
    });
    executor.jobRuns.push({
      id: 22,
      module_code: "front_profit",
      scope_key: "front_profit:2026-08",
      status: "recon_pending",
      input_batch_ids: ["source:51"],
    });
    executor.l4Rows.push({
      id: 1,
      runId: 22,
      period: "2026-08",
      publishVersionId: null,
      ...syntheticFrontProfitL4AggRow({
        date: "2026-08-02",
        recordId: "SYNTHETIC_MISSING_SOURCE_001",
      }),
    });

    await expect(publishFrontProfitL4Run(executor, {
      period: "2026-08",
      runId: 22,
      publishSourceId: 999_999,
      actorId: 9,
      today: "2026-09-01",
    })).rejects.toThrow(/sources do not exist: 999999/);

    expect(executor.versions).toEqual([]);
    expect(executor.sources).toEqual([]);
    expect(executor.rows).toEqual([]);
    expect(executor.jobRuns[0]?.status).toBe("recon_pending");
  });

  test("returns the existing published version for an idempotent run publish retry", async () => {
    const executor = fakePublishExecutor();
    await setFrontProfitPeriodAuthority(executor, {
      period: "2026-08",
      authority: "auto",
      actorId: 9,
    });
    executor.jobRuns.push({
      id: 22,
      module_code: "front_profit",
      scope_key: "front_profit:2026-08",
      status: "recon_pending",
      input_batch_ids: ["source:51", "source:60"],
    });
    executor.l4Rows.push({
      id: 1,
      runId: 22,
      period: "2026-08",
      publishVersionId: null,
      ...syntheticFrontProfitL4AggRow({
        date: "2026-08-02",
        recordId: "SYNTHETIC_RUN_PUBLISH_001",
      }),
    });

    const first = await publishFrontProfitL4Run(executor, {
      period: "2026-08",
      runId: 22,
      publishSourceId: 51,
      manualBaselineSourceId: 60,
      idempotencyKey: "publish-2026-08-run-22",
      actorId: 9,
      today: "2026-09-01",
    });
    const second = await publishFrontProfitL4Run(executor, {
      period: "2026-08",
      runId: 22,
      publishSourceId: 51,
      manualBaselineSourceId: 60,
      idempotencyKey: "publish-2026-08-run-22",
      actorId: 9,
      today: "2026-09-01",
    });

    expect(first.idempotent).toBe(false);
    expect(second).toMatchObject({
      runId: 22,
      period: "2026-08",
      version: {
        id: 1,
        status: "published",
        versionNo: 1,
      },
      stagedRowCount: 1,
      sourceIds: [51, 60],
      summary: {
        schemaVersion: "front-profit-standard/v1",
        businessRowCount: 1,
        warningCount: 0,
      },
      idempotent: true,
    });
    expect(executor.versions).toHaveLength(1);
    expect(executor.rows).toHaveLength(1);
    expect(executor.jobRuns[0]).toMatchObject({
      status: "published",
      last_checkpoint_step: "publish",
    });
  });

  test("rejects reusing a publish idempotency key for another run in the same period", async () => {
    const executor = fakePublishExecutor();
    executor.versions.push({
      id: 1,
      module_code: "front_profit",
      scope_key: "front_profit:2026-08",
      version_no: 1,
      status: "published",
      source_run_id: 22,
    });
    executor.sources.push({
      publishVersionId: 1,
      sourceId: 51,
      sourceRunId: 22,
      inputBatchId: "source:51",
      role: "input",
      payload: { idempotencyKey: "publish-2026-08-run-22" },
    });
    executor.jobRuns.push({
      id: 23,
      module_code: "front_profit",
      scope_key: "front_profit:2026-08",
      status: "recon_pending",
      input_batch_ids: ["source:61"],
    });

    await expect(publishFrontProfitL4Run(executor, {
      period: "2026-08",
      runId: 23,
      publishSourceId: 61,
      idempotencyKey: "publish-2026-08-run-22",
      actorId: 9,
      today: "2026-09-01",
    })).rejects.toThrow(/idempotency key/);
    expect(executor.versions).toHaveLength(1);
    expect(executor.rows).toEqual([]);
  });

  test("rejects run publish before the run reaches the publishable state", async () => {
    const executor = fakePublishExecutor();
    executor.jobRuns.push({
      id: 22,
      module_code: "front_profit",
      scope_key: "front_profit:2026-08",
      status: "failed",
      input_batch_ids: ["source:51"],
    });

    await expect(publishFrontProfitL4Run(executor, {
      period: "2026-08",
      runId: 22,
      publishSourceId: 51,
      actorId: 9,
      today: "2026-09-01",
    })).rejects.toThrow(/recon_pending or gated/);
    expect(executor.versions).toEqual([]);
  });

  test("blocks formal publish while authority remains manual", async () => {
    const executor = fakePublishExecutor();
    const draft = await createFrontProfitDraftPublishVersion(executor, {
      period: "2026-08",
      today: "2026-09-01",
    });

    await expect(publishFrontProfitVersion(executor, {
      period: "2026-08",
      versionId: draft.id,
      actorId: 9,
      today: "2026-09-01",
    })).rejects.toMatchObject({
      decisions: [{ code: "FRONT_PROFIT_PERIOD_AUTHORITY_MANUAL" }],
    });
    expect(executor.versions[0]?.status).toBe("draft");
  });

  test("blocks formal publish when no fixed publish rows were staged", async () => {
    const executor = fakePublishExecutor();
    await setFrontProfitPeriodAuthority(executor, {
      period: "2026-08",
      authority: "auto",
      actorId: 9,
    });
    executor.versions.push({
      id: 1,
      module_code: "front_profit",
      scope_key: "front_profit:2026-08",
      version_no: 1,
      status: "validated",
    });

    await expect(publishFrontProfitVersion(executor, {
      period: "2026-08",
      versionId: 1,
      actorId: 9,
      today: "2026-09-01",
    })).rejects.toThrow(/no staged rows/);
    expect(executor.versions[0]?.status).toBe("validated");
  });

  test("blocks formal publish when the source run failed reconciliation", async () => {
    const executor = fakePublishExecutor();
    await setFrontProfitPeriodAuthority(executor, {
      period: "2026-08",
      authority: "auto",
      actorId: 9,
    });
    executor.versions.push({
      id: 1,
      module_code: "front_profit",
      scope_key: "front_profit:2026-08",
      version_no: 1,
      status: "validated",
      source_run_id: 22,
    });
    executor.rows.push({
      publishVersionId: 1,
      sourceId: 51,
      status: "draft",
      period: "2026-08",
      recordId: "SYNTHETIC_BLOCKED",
      aggregationKey: "blocked-key",
    });
    executor.reconResults.push({
      runId: 22,
      layer: "L3_L4",
      metric: "gmv_sum",
      passed: false,
    });

    await expect(publishFrontProfitVersion(executor, {
      period: "2026-08",
      versionId: 1,
      actorId: 9,
      today: "2026-09-01",
    })).rejects.toBeInstanceOf(ComplexJobGateError);
    expect(executor.versions[0]?.status).toBe("validated");
    expect(executor.rows[0]?.status).toBe("draft");
  });

  test("publishes under auto authority and supersedes the previous published version", async () => {
    const executor = fakePublishExecutor();
    await setFrontProfitPeriodAuthority(executor, {
      period: "2026-08",
      authority: "auto",
      actorId: 9,
    });
    executor.versions.push({
      id: 1,
      module_code: "front_profit",
      scope_key: "front_profit:2026-08",
      version_no: 1,
      status: "published",
    });
    executor.versions.push({
      id: 2,
      module_code: "front_profit",
      scope_key: "front_profit:2026-08",
      version_no: 2,
      status: "validated",
    });
    executor.rows.push({
      publishVersionId: 1,
      sourceId: 40,
      status: "published",
      period: "2026-08",
      recordId: "SYNTHETIC_OLD",
      aggregationKey: "old-key",
    });
    executor.rows.push({
      publishVersionId: 2,
      sourceId: 51,
      status: "draft",
      period: "2026-08",
      recordId: "SYNTHETIC_NEW",
      aggregationKey: "new-key",
    });

    await expect(publishFrontProfitVersion(executor, {
      period: "2026-08",
      versionId: 2,
      actorId: 9,
      today: "2026-09-01",
    })).resolves.toMatchObject({
      id: 2,
      versionNo: 2,
      status: "published",
    });
    expect(executor.versions.map((version) => ({
      id: version.id,
      status: version.status,
      supersededBy: version.superseded_by,
    }))).toEqual([
      { id: 1, status: "superseded", supersededBy: 2 },
      { id: 2, status: "published", supersededBy: undefined },
    ]);
    expect(executor.rows.map((row) => ({
      versionId: row.publishVersionId,
      status: row.status,
    }))).toEqual([
      { versionId: 1, status: "superseded" },
      { versionId: 2, status: "published" },
    ]);
  });

  test("rolls back the current published version and restores the previous superseded version", async () => {
    const executor = fakePublishExecutor();
    await setFrontProfitPeriodAuthority(executor, {
      period: "2026-08",
      authority: "auto",
      actorId: 9,
    });
    executor.jobRuns.push({
      id: 21,
      module_code: "front_profit",
      scope_key: "front_profit:2026-08",
      status: "published",
      input_batch_ids: ["source:40"],
      last_checkpoint_step: "publish",
    });
    executor.jobRuns.push({
      id: 22,
      module_code: "front_profit",
      scope_key: "front_profit:2026-08",
      status: "published",
      input_batch_ids: ["source:51"],
      last_checkpoint_step: "publish",
    });
    executor.versions.push({
      id: 1,
      module_code: "front_profit",
      scope_key: "front_profit:2026-08",
      version_no: 1,
      status: "superseded",
      superseded_by: 2,
      source_run_id: 21,
    });
    executor.versions.push({
      id: 2,
      module_code: "front_profit",
      scope_key: "front_profit:2026-08",
      version_no: 2,
      status: "published",
      source_run_id: 22,
    });
    executor.sources.push({
      publishVersionId: 1,
      sourceId: 40,
      sourceRunId: 21,
      inputBatchId: "source:40",
      role: "input",
      payload: {},
    });
    executor.sources.push({
      publishVersionId: 2,
      sourceId: 51,
      sourceRunId: 22,
      inputBatchId: "source:51",
      role: "input",
      payload: {},
    });
    executor.rows.push({
      publishVersionId: 1,
      sourceId: 40,
      status: "superseded",
      period: "2026-08",
      recordId: "SYNTHETIC_OLD",
      aggregationKey: "same-key",
    });
    executor.rows.push({
      publishVersionId: 2,
      sourceId: 51,
      status: "published",
      period: "2026-08",
      recordId: "SYNTHETIC_NEW",
      aggregationKey: "same-key",
    });

    await expect(rollbackFrontProfitPublishVersion(executor, {
      period: "2026-08",
      versionId: 2,
      actorId: 9,
      reason: "restore previous accepted version",
      today: "2026-09-01",
    })).resolves.toMatchObject({
      rolledBackVersion: { id: 2, versionNo: 2, status: "rolled_back" },
      restoredVersion: { id: 1, versionNo: 1, status: "published" },
      rolledBackRowCount: 1,
      restoredRowCount: 1,
      idempotent: false,
    });
    expect(executor.versions.map((version) => ({
      id: version.id,
      status: version.status,
      supersededBy: version.superseded_by,
    }))).toEqual([
      { id: 1, status: "published", supersededBy: null },
      { id: 2, status: "rolled_back", supersededBy: 1 },
    ]);
    expect(executor.rows.map((row) => ({
      versionId: row.publishVersionId,
      status: row.status,
    }))).toEqual([
      { versionId: 1, status: "published" },
      { versionId: 2, status: "rolled_back" },
    ]);
    expect(executor.jobRuns.map((run) => ({
      id: run.id,
      status: run.status,
      lastCheckpointStep: run.last_checkpoint_step,
    }))).toEqual([
      { id: 21, status: "published", lastCheckpointStep: "publish" },
      { id: 22, status: "rolled_back", lastCheckpointStep: "rollback" },
    ]);
    expect(executor.sources.find((source) => source.publishVersionId === 2)?.payload).toMatchObject({
      rollback: {
        actorId: 9,
        reason: "restore previous accepted version",
        restoredVersionId: 1,
      },
    });

    await expect(rollbackFrontProfitPublishVersion(executor, {
      period: "2026-08",
      versionId: 2,
      actorId: 9,
      today: "2026-09-01",
    })).resolves.toMatchObject({
      rolledBackVersion: { id: 2, versionNo: 2, status: "rolled_back" },
      restoredVersion: { id: 1, versionNo: 1, status: "published" },
      idempotent: true,
    });
  });

  test("rejects rollback when no superseded previous version exists", async () => {
    const executor = fakePublishExecutor();
    await setFrontProfitPeriodAuthority(executor, {
      period: "2026-08",
      authority: "auto",
      actorId: 9,
    });
    executor.versions.push({
      id: 1,
      module_code: "front_profit",
      scope_key: "front_profit:2026-08",
      version_no: 1,
      status: "published",
    });
    executor.rows.push({
      publishVersionId: 1,
      sourceId: 51,
      status: "published",
      period: "2026-08",
      recordId: "SYNTHETIC_ONLY",
      aggregationKey: "only-key",
    });

    await expect(rollbackFrontProfitPublishVersion(executor, {
      period: "2026-08",
      versionId: 1,
      actorId: 9,
      today: "2026-09-01",
    })).rejects.toThrow(/superseded previous version/);
    expect(executor.versions[0]?.status).toBe("published");
    expect(executor.rows[0]?.status).toBe("published");
  });
});
