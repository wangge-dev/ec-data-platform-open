import {
  assertPublishGateForRun,
  publishLockKey,
  updateComplexJobRunStatus,
} from "./complex-job.js";
import {
  canonicalRowsContract,
  type FrontProfitImportSummary,
} from "./front-profit-canonical-rows-contract.js";
import {
  type AuthoritySqlExecutor,
  assertFrontProfitAutoDraftAuthority,
  assertFrontProfitAutoPublishAuthority,
} from "./front-profit-authority.js";
import {
  frontProfitL4AggRowToCanonicalRow,
  markFrontProfitL4RowsPublishVersion,
  selectFrontProfitL4RowsForRun,
} from "./front-profit-layers.js";
import { FRONT_PROFIT_MODULE_CODE, frontProfitScopeKey } from "./front-profit-period.js";
import { FRONT_PROFIT_STANDARD_HEADERS } from "./front-profit-standard.js";

export type FrontProfitPublishVersion = {
  id: number;
  period: string;
  scopeKey: string;
  versionNo: number;
  status: "draft" | "validated" | "published" | "superseded" | "rolled_back";
  sourceRunId?: number | null;
};

export type FrontProfitPublishOptions = {
  actorId?: number | null;
  today?: string;
};

export type FrontProfitPublishSourceRole = "input" | "manual_baseline" | "adjustment";

export type FrontProfitPublishSourceInput = {
  sourceId: number;
  sourceRunId?: number | null;
  inputBatchId?: string | null;
  role?: FrontProfitPublishSourceRole;
  payload?: Record<string, unknown>;
};

type NormalizedFrontProfitPublishSource = Omit<FrontProfitPublishSourceInput, "role"> & {
  sourceId: number;
  role: FrontProfitPublishSourceRole;
};

export type FrontProfitStagedRowsResult = FrontProfitPublishVersion & {
  rowCount: number;
  summary: FrontProfitImportSummary;
};

export type FrontProfitRunPublishResult = {
  runId: number;
  period: string;
  version: FrontProfitPublishVersion;
  stagedRowCount: number;
  summary: FrontProfitImportSummary;
  sourceIds: number[];
  idempotent: boolean;
};

export type FrontProfitRollbackResult = {
  period: string;
  rolledBackVersion: FrontProfitPublishVersion;
  restoredVersion: FrontProfitPublishVersion;
  rolledBackRowCount: number;
  restoredRowCount: number;
  idempotent: boolean;
};

export class FrontProfitPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontProfitPublishError";
  }
}

function normalizeFrontProfitPublishSources(
  sources: readonly FrontProfitPublishSourceInput[],
): NormalizedFrontProfitPublishSource[] {
  const seen = new Set<string>();
  return sources.map((source) => {
    const sourceId = assertPositiveSafeId(source.sourceId, "sourceId");
    const role = assertPublishSourceRole(source.role ?? "input");
    const key = `${sourceId}:${role}`;
    if (seen.has(key)) {
      throw new FrontProfitPublishError("front-profit publish sources cannot contain duplicate source/role pairs");
    }
    seen.add(key);
    return { ...source, sourceId, role };
  });
}

async function assertFrontProfitPublishSourcesExist(
  executor: AuthoritySqlExecutor,
  sources: readonly NormalizedFrontProfitPublishSource[],
): Promise<void> {
  const sourceIds = [...new Set(sources.map((source) => source.sourceId))].sort((left, right) => left - right);
  if (sourceIds.length === 0) return;
  const rows = await executor.unsafe(
    `SELECT id FROM public.data_sources
     WHERE id = ANY($1::bigint[])
     ORDER BY id
     FOR KEY SHARE`,
    [sourceIds],
  );
  const existing = new Set(rows.map((row) => Number(row.id)));
  const missing = sourceIds.filter((sourceId) => !existing.has(sourceId));
  if (missing.length > 0) {
    throw new FrontProfitPublishError(`front-profit publish sources do not exist: ${missing.join(", ")}`);
  }
}

async function insertFrontProfitPublishSources(
  executor: AuthoritySqlExecutor,
  publishVersionId: number,
  sources: readonly NormalizedFrontProfitPublishSource[],
): Promise<void> {
  if (sources.length === 0) return;
  const placeholders: string[] = [];
  const parameters: unknown[] = [];
  let paramIndex = 1;
  for (const source of sources) {
    placeholders.push(
      `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}::jsonb)`,
    );
    parameters.push(
      publishVersionId,
      source.sourceId,
      source.sourceRunId ?? null,
      source.inputBatchId ?? null,
      source.role,
      source.payload ?? {},
    );
  }
  await executor.unsafe(
    `INSERT INTO public.publish_version_source
       (publish_version_id, source_id, source_run_id, input_batch_id, role, payload)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (publish_version_id, source_id, role) DO UPDATE SET
       source_run_id = EXCLUDED.source_run_id,
       input_batch_id = EXCLUDED.input_batch_id,
       payload = public.publish_version_source.payload || EXCLUDED.payload`,
    parameters,
  );
}

function assertPositiveSafeId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new FrontProfitPublishError(`${label} must be a positive safe integer`);
  }
  return value;
}

function assertPublishSourceRole(role: string): FrontProfitPublishSourceRole {
  if (!["input", "manual_baseline", "adjustment"].includes(role)) {
    throw new FrontProfitPublishError("front-profit publish source role is invalid");
  }
  return role as FrontProfitPublishSourceRole;
}

function optionalPositiveSafeId(value: unknown, label: string): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new FrontProfitPublishError(`${label} must be a positive safe integer`);
  }
  return parsed;
}

function uniquePositiveSafeIds(values: readonly unknown[], label: string): number[] {
  const ids = new Set<number>();
  for (const value of values) {
    if (value == null) continue;
    ids.add(assertPositiveSafeId(Number(value), label));
  }
  return [...ids].sort((left, right) => left - right);
}

function parseInputBatchIds(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function sourceIdsFromInputBatchIds(value: unknown): number[] {
  const ids: number[] = [];
  for (const item of parseInputBatchIds(value)) {
    const match = /^source:(\d+)$/.exec(String(item ?? "").trim());
    if (match) ids.push(Number(match[1]));
  }
  return uniquePositiveSafeIds(ids, "sourceId");
}

function normalizeIdempotencyKey(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!/^[\x21-\x7E]{1,128}$/.test(normalized)) {
    throw new FrontProfitPublishError("front-profit publish idempotencyKey must be 1-128 printable ASCII characters");
  }
  return normalized;
}

function parseNumberList(value: unknown): number[] {
  if (Array.isArray(value)) {
    return uniquePositiveSafeIds(value, "sourceId");
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? uniquePositiveSafeIds(parsed, "sourceId") : [];
    } catch {
      return [];
    }
  }
  return [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseImportSummary(value: unknown, rowCount: number): FrontProfitImportSummary {
  const payload = typeof value === "string"
    ? (() => {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      })()
    : value;
  if (
    isPlainObject(payload) &&
    payload.schemaVersion === "front-profit-standard/v1" &&
    Number.isSafeInteger(Number(payload.businessRowCount)) &&
    Number.isSafeInteger(Number(payload.warningCount))
  ) {
    return {
      schemaVersion: "front-profit-standard/v1",
      businessRowCount: Number(payload.businessRowCount),
      warningCount: Number(payload.warningCount),
      warningCodes: Array.isArray(payload.warningCodes) ? payload.warningCodes.map(String) : [],
    };
  }
  return {
    schemaVersion: "front-profit-standard/v1",
    businessRowCount: rowCount,
    warningCount: 0,
    warningCodes: [],
  };
}

function parseVersionRow(period: string, row: Record<string, unknown> | undefined): FrontProfitPublishVersion {
  const id = Number(row?.id);
  const versionNo = Number(row?.version_no);
  const status = row?.status;
  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    !Number.isSafeInteger(versionNo) ||
    versionNo <= 0 ||
    !["draft", "validated", "published", "superseded", "rolled_back"].includes(String(status))
  ) {
    throw new FrontProfitPublishError("front-profit publish version could not be read");
  }
  return {
    id,
    period,
    scopeKey: frontProfitScopeKey(period),
    versionNo,
    status: status as FrontProfitPublishVersion["status"],
    sourceRunId: optionalPositiveSafeId(row?.source_run_id ?? row?.sourceRunId, "sourceRunId"),
  };
}

async function lockFrontProfitPublish(executor: AuthoritySqlExecutor): Promise<void> {
  await executor.unsafe(
    "SELECT pg_advisory_xact_lock(hashtext($1))",
    [publishLockKey(FRONT_PROFIT_MODULE_CODE)],
  );
}

export async function attachFrontProfitPublishSources(
  executor: AuthoritySqlExecutor,
  publishVersionId: number,
  sources: FrontProfitPublishSourceInput[],
): Promise<void> {
  assertPositiveSafeId(publishVersionId, "publishVersionId");
  const normalizedSources = normalizeFrontProfitPublishSources(sources);
  if (normalizedSources.length === 0) return;
  await assertFrontProfitPublishSourcesExist(executor, normalizedSources);
  await insertFrontProfitPublishSources(executor, publishVersionId, normalizedSources);
}

async function assertFrontProfitPublishIdempotencyKeyAvailable(
  executor: AuthoritySqlExecutor,
  input: {
    period: string;
    scopeKey: string;
    runId: number;
    idempotencyKey: string | null;
  },
): Promise<void> {
  if (!input.idempotencyKey) return;
  const [existing] = await executor.unsafe(
    `SELECT pv.source_run_id
     FROM public.publish_version_source pvs
     INNER JOIN public.publish_version pv ON pv.id = pvs.publish_version_id
     WHERE pv.module_code = $1
       AND pv.scope_key = $2
       AND pvs.payload->>'idempotencyKey' = $3
     ORDER BY pv.id DESC
     LIMIT 1`,
    [FRONT_PROFIT_MODULE_CODE, input.scopeKey, input.idempotencyKey],
  );
  if (!existing) return;
  const sourceRunId = optionalPositiveSafeId(existing.source_run_id ?? existing.sourceRunId, "sourceRunId");
  if (sourceRunId !== input.runId) {
    throw new FrontProfitPublishError("front-profit publish idempotency key is already bound to another run");
  }
}

async function loadPublishedFrontProfitRunResult(
  executor: AuthoritySqlExecutor,
  input: {
    period: string;
    scopeKey: string;
    runId: number;
  },
): Promise<FrontProfitRunPublishResult | null> {
  const [existing] = await executor.unsafe(
    `SELECT pv.id,
            pv.version_no,
            pv.status,
            pv.source_run_id,
            COALESCE((
              SELECT COUNT(*)::int
              FROM public.front_profit_publish_row fpr
              WHERE fpr.publish_version_id = pv.id AND fpr.status = 'published'
            ), 0)::int AS row_count,
            COALESCE((
              SELECT jsonb_agg(DISTINCT pvs.source_id ORDER BY pvs.source_id)
              FROM public.publish_version_source pvs
              WHERE pvs.publish_version_id = pv.id
            ), '[]'::jsonb) AS source_ids,
            (
              SELECT pvs.payload->'summary'
              FROM public.publish_version_source pvs
              WHERE pvs.publish_version_id = pv.id
                AND pvs.source_run_id = $3
                AND pvs.payload ? 'summary'
              LIMIT 1
            ) AS summary
     FROM public.publish_version pv
     WHERE pv.module_code = $1
       AND pv.scope_key = $2
       AND pv.source_run_id = $3
       AND pv.status = 'published'
     ORDER BY pv.id DESC
     LIMIT 1`,
    [FRONT_PROFIT_MODULE_CODE, input.scopeKey, input.runId],
  );
  if (!existing) return null;
  const stagedRowCount = Number(existing.row_count);
  if (!Number.isSafeInteger(stagedRowCount) || stagedRowCount < 0) {
    throw new FrontProfitPublishError("front-profit published row count could not be read");
  }
  return {
    runId: input.runId,
    period: input.period,
    version: parseVersionRow(input.period, existing),
    stagedRowCount,
    summary: parseImportSummary(existing.summary, stagedRowCount),
    sourceIds: parseNumberList(existing.source_ids ?? existing.sourceIds),
    idempotent: true,
  };
}

async function countFrontProfitPublishRows(
  executor: AuthoritySqlExecutor,
  versionId: number,
  status: "draft" | "published" | "superseded" | "rolled_back",
): Promise<number> {
  const [row] = await executor.unsafe(
    `SELECT COUNT(*)::int AS row_count
     FROM public.front_profit_publish_row
     WHERE publish_version_id = $1 AND status = $2`,
    [versionId, status],
  );
  const rowCount = Number(row?.row_count);
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new FrontProfitPublishError("front-profit publish row count could not be read");
  }
  return rowCount;
}

async function selectRollbackRestoreVersion(
  executor: AuthoritySqlExecutor,
  input: {
    period: string;
    scopeKey: string;
    beforeVersionNo: number;
    status: "published" | "superseded";
  },
): Promise<FrontProfitPublishVersion | null> {
  const [candidate] = await executor.unsafe(
    `SELECT id, version_no, status, source_run_id
     FROM public.publish_version
     WHERE module_code = $1
       AND scope_key = $2
       AND version_no < $3
       AND status = $4
     ORDER BY version_no DESC
     LIMIT 1
     FOR UPDATE`,
    [FRONT_PROFIT_MODULE_CODE, input.scopeKey, input.beforeVersionNo, input.status],
  );
  return candidate ? parseVersionRow(input.period, candidate) : null;
}

async function recordFrontProfitRollbackPayload(
  executor: AuthoritySqlExecutor,
  input: {
    rolledBackVersionId: number;
    restoredVersionId: number;
    actorId: number;
    reason?: string | null;
  },
): Promise<void> {
  await executor.unsafe(
    `UPDATE public.publish_version_source
     SET payload = payload || jsonb_build_object(
       'rollback',
       jsonb_build_object(
         'actorId', $2::bigint,
         'reason', $3::text,
         'restoredVersionId', $4::bigint,
         'rolledBackAt', NOW()
       )
     )
     WHERE publish_version_id = $1`,
    [
      input.rolledBackVersionId,
      input.actorId,
      input.reason?.trim() || null,
      input.restoredVersionId,
    ],
  );
}

export async function createFrontProfitDraftPublishVersion(
  executor: AuthoritySqlExecutor,
  input: {
    period: string;
    sourceRunId?: number | null;
    sources?: FrontProfitPublishSourceInput[];
  } & FrontProfitPublishOptions,
): Promise<FrontProfitPublishVersion> {
  await lockFrontProfitPublish(executor);
  await assertFrontProfitAutoDraftAuthority(executor, [input.period], {
    actorId: input.actorId,
    today: input.today,
  });
  const normalizedSources = normalizeFrontProfitPublishSources(input.sources ?? []);
  await assertFrontProfitPublishSourcesExist(executor, normalizedSources);

  const scopeKey = frontProfitScopeKey(input.period);
  const [next] = await executor.unsafe(
    `SELECT (COALESCE(MAX(version_no), 0) + 1)::int AS version_no
     FROM public.publish_version
     WHERE module_code = $1 AND scope_key = $2`,
    [FRONT_PROFIT_MODULE_CODE, scopeKey],
  );
  const versionNo = Number(next?.version_no);
  if (!Number.isSafeInteger(versionNo) || versionNo <= 0) {
    throw new FrontProfitPublishError("front-profit draft version number could not be allocated");
  }

  const [created] = await executor.unsafe(
    `INSERT INTO public.publish_version
       (module_code, scope_key, version_no, status, source_run_id)
     VALUES ($1, $2, $3, 'draft', $4)
     RETURNING id, version_no, status, source_run_id`,
    [
      FRONT_PROFIT_MODULE_CODE,
      scopeKey,
      versionNo,
      input.sourceRunId ?? null,
    ],
  );
  const version = parseVersionRow(input.period, created);
  await insertFrontProfitPublishSources(executor, version.id, normalizedSources);
  return version;
}

function headerIndex(rawHeader: string): number {
  const index = FRONT_PROFIT_STANDARD_HEADERS.findIndex((header) => header === rawHeader);
  if (index < 0) {
    throw new FrontProfitPublishError(`front-profit publish header is not part of the contract: ${rawHeader}`);
  }
  return index;
}

const headerIndexes = {
  date: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[0]),
  platform: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[1]),
  businessMode: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[2]),
  groupName: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[3]),
  shop: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[4]),
  shopNormalized: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[5]),
  operator: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[6]),
  quantity: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[7]),
  gmv: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[8]),
  fillOrderAmount: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[9]),
  fillOrderProductCost: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[10]),
  fillOrderQuantity: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[11]),
  productCost: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[12]),
  shipmentValue: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[13]),
  platformFee: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[14]),
  taxFee: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[15]),
  financeCost: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[16]),
  freight: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[17]),
  commission: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[18]),
  promotionFee: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[19]),
  sourceFile: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[20]),
  sourceBatch: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[21]),
  note: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[22]),
  realRevenue: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[23]),
  frontProfit: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[24]),
  paidRatio: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[25]),
  recordId: headerIndex(FRONT_PROFIT_STANDARD_HEADERS[26]),
};

const textCell = (row: readonly unknown[], index: number): string =>
  String(row[index] ?? "").trim();

const decimalCell = (row: readonly unknown[], index: number): string =>
  String(row[index] ?? "").trim();

export async function stageFrontProfitPublishRows(
  executor: AuthoritySqlExecutor,
  input: {
    period: string;
    versionId: number;
    sourceId: number;
    headers?: readonly unknown[];
    dataRows: unknown[][];
    firstDataRowNumber?: number;
    sourceRunId?: number | null;
    inputBatchId?: string | null;
  },
): Promise<FrontProfitStagedRowsResult> {
  assertPositiveSafeId(input.versionId, "versionId");
  assertPositiveSafeId(input.sourceId, "sourceId");
  await lockFrontProfitPublish(executor);

  const scopeKey = frontProfitScopeKey(input.period);
  const [candidate] = await executor.unsafe(
    `SELECT id, version_no, status
     FROM public.publish_version
     WHERE id = $1 AND module_code = $2 AND scope_key = $3
     FOR UPDATE`,
    [input.versionId, FRONT_PROFIT_MODULE_CODE, scopeKey],
  );
  const version = parseVersionRow(input.period, candidate);
  if (version.status !== "draft") {
    throw new FrontProfitPublishError("front-profit rows can only be staged into a draft version");
  }

  const contract = canonicalRowsContract({
    headers: input.headers ?? FRONT_PROFIT_STANDARD_HEADERS,
    dataRows: input.dataRows,
    firstDataRowNumber: input.firstDataRowNumber ?? 2,
  });
  if (contract.periods.length !== 1 || contract.periods[0] !== input.period) {
    throw new FrontProfitPublishError("front-profit staged rows must belong to the publish period");
  }

  await attachFrontProfitPublishSources(executor, input.versionId, [{
    sourceId: input.sourceId,
    sourceRunId: input.sourceRunId ?? null,
    inputBatchId: input.inputBatchId ?? null,
    role: "input",
    payload: {
      rowCount: contract.summary.businessRowCount,
      scopeKeys: contract.scopeKeys,
      summary: contract.summary,
    },
  }]);

  await executor.unsafe(
    `DELETE FROM public.front_profit_publish_row
     WHERE publish_version_id = $1 AND source_id = $2 AND status = 'draft'`,
    [input.versionId, input.sourceId],
  );

  const rowsByNumber = new Map<number, readonly unknown[]>();
  for (const [index, row] of input.dataRows.entries()) {
    rowsByNumber.set((input.firstDataRowNumber ?? 2) + index, row);
  }

  const BATCH = 200;
  for (let i = 0; i < contract.identities.length; i += BATCH) {
    const slice = contract.identities.slice(i, i + BATCH);
    if (!slice.length) continue;
    const placeholders: string[] = [];
    const parameters: unknown[] = [];
    let paramIndex = 1;
    for (const identity of slice) {
      const row = rowsByNumber.get(identity.rowNumber);
      if (!row) {
        throw new FrontProfitPublishError("front-profit staged row could not be matched to its identity");
      }
      placeholders.push(
        `(${Array.from({ length: 32 }, () => `$${paramIndex++}`).join(", ")}, $${paramIndex++}::jsonb)`,
      );
      parameters.push(
        input.versionId,
        input.sourceId,
        "draft",
        input.period,
        identity.recordId,
        identity.aggregationKey,
        textCell(row, headerIndexes.date),
        textCell(row, headerIndexes.platform),
        textCell(row, headerIndexes.businessMode),
        textCell(row, headerIndexes.groupName) || null,
        textCell(row, headerIndexes.shop),
        textCell(row, headerIndexes.shopNormalized) || null,
        textCell(row, headerIndexes.operator),
        decimalCell(row, headerIndexes.quantity),
        decimalCell(row, headerIndexes.gmv),
        decimalCell(row, headerIndexes.fillOrderAmount),
        decimalCell(row, headerIndexes.fillOrderProductCost),
        decimalCell(row, headerIndexes.fillOrderQuantity),
        decimalCell(row, headerIndexes.productCost),
        decimalCell(row, headerIndexes.shipmentValue),
        decimalCell(row, headerIndexes.platformFee),
        decimalCell(row, headerIndexes.taxFee),
        decimalCell(row, headerIndexes.financeCost),
        decimalCell(row, headerIndexes.freight),
        decimalCell(row, headerIndexes.commission),
        decimalCell(row, headerIndexes.promotionFee),
        textCell(row, headerIndexes.sourceFile) || null,
        textCell(row, headerIndexes.sourceBatch) || null,
        textCell(row, headerIndexes.note) || null,
        decimalCell(row, headerIndexes.realRevenue),
        decimalCell(row, headerIndexes.frontProfit),
        decimalCell(row, headerIndexes.paidRatio),
        Object.fromEntries(
          FRONT_PROFIT_STANDARD_HEADERS.map((header, index) => [header, row[index] ?? null]),
        ),
      );
    }
    await executor.unsafe(
      `INSERT INTO public.front_profit_publish_row
         (publish_version_id, source_id, status, period, record_id, aggregation_key, date,
          platform, business_mode, group_name, shop, shop_normalized, operator,
          quantity, gmv, fill_order_amount, fill_order_product_cost, fill_order_quantity,
          product_cost, shipment_value, platform_fee, tax_fee, finance_cost, freight,
          commission, promotion_fee, source_file, source_batch, note, real_revenue,
          front_profit, paid_ratio, row_payload)
       VALUES ${placeholders.join(", ")}`,
      parameters,
    );
  }

  const [validated] = await executor.unsafe(
    `UPDATE public.publish_version
     SET status = 'validated'
     WHERE id = $1 AND status = 'draft'
     RETURNING id, version_no, status`,
    [input.versionId],
  );
  return {
    ...parseVersionRow(input.period, validated),
    rowCount: contract.summary.businessRowCount,
    summary: contract.summary,
  };
}

export async function stageFrontProfitL4PublishRows(
  executor: AuthoritySqlExecutor,
  input: {
    period: string;
    versionId: number;
    sourceId: number;
    runId: number;
    firstDataRowNumber?: number;
    inputBatchId?: string | null;
  },
): Promise<FrontProfitStagedRowsResult> {
  assertPositiveSafeId(input.runId, "runId");
  await assertPublishGateForRun(executor, input.runId);
  const rows = await selectFrontProfitL4RowsForRun(executor, {
    runId: input.runId,
    period: input.period,
  });
  if (rows.length === 0) {
    throw new FrontProfitPublishError("front-profit L4 run has no aggregation rows");
  }

  const result = await stageFrontProfitPublishRows(executor, {
    period: input.period,
    versionId: input.versionId,
    sourceId: input.sourceId,
    sourceRunId: input.runId,
    inputBatchId: input.inputBatchId ?? `front-profit-l4-run:${input.runId}`,
    headers: FRONT_PROFIT_STANDARD_HEADERS,
    dataRows: rows.map(frontProfitL4AggRowToCanonicalRow),
    firstDataRowNumber: input.firstDataRowNumber,
  });
  await markFrontProfitL4RowsPublishVersion(executor, {
    runId: input.runId,
    period: input.period,
    publishVersionId: input.versionId,
  });
  return result;
}

export async function publishFrontProfitVersion(
  executor: AuthoritySqlExecutor,
  input: {
    period: string;
    versionId: number;
    actorId: number;
  } & FrontProfitPublishOptions,
): Promise<FrontProfitPublishVersion> {
  await lockFrontProfitPublish(executor);
  await assertFrontProfitAutoPublishAuthority(executor, [input.period], {
    actorId: input.actorId,
    today: input.today,
  });

  const scopeKey = frontProfitScopeKey(input.period);
  const [candidate] = await executor.unsafe(
    `SELECT id, version_no, status, source_run_id
     FROM public.publish_version
     WHERE id = $1 AND module_code = $2 AND scope_key = $3
     FOR UPDATE`,
    [input.versionId, FRONT_PROFIT_MODULE_CODE, scopeKey],
  );
  const version = parseVersionRow(input.period, candidate);
  if (version.status !== "draft" && version.status !== "validated") {
    throw new FrontProfitPublishError("front-profit publish version must be draft or validated");
  }
  if (version.sourceRunId != null) {
    await assertPublishGateForRun(executor, version.sourceRunId);
  }

  const [rowCount] = await executor.unsafe(
    `SELECT COUNT(*)::int AS row_count
     FROM public.front_profit_publish_row
     WHERE publish_version_id = $1 AND status = 'draft'`,
    [input.versionId],
  );
  if (Number(rowCount?.row_count) <= 0) {
    throw new FrontProfitPublishError("front-profit publish version has no staged rows");
  }

  await executor.unsafe(
    `UPDATE public.publish_version
     SET status = 'superseded', superseded_by = $1
     WHERE module_code = $2 AND scope_key = $3 AND status = 'published' AND id <> $1`,
    [input.versionId, FRONT_PROFIT_MODULE_CODE, scopeKey],
  );

  await executor.unsafe(
    `UPDATE public.front_profit_publish_row
     SET status = 'superseded'
     WHERE period = $1 AND status = 'published' AND publish_version_id <> $2`,
    [input.period, input.versionId],
  );

  await executor.unsafe(
    `UPDATE public.front_profit_publish_row
     SET status = 'published'
     WHERE publish_version_id = $1 AND status = 'draft'`,
    [input.versionId],
  );

  const [published] = await executor.unsafe(
    `UPDATE public.publish_version
     SET status = 'published', published_by = $2, published_at = NOW()
     WHERE id = $1
     RETURNING id, version_no, status, source_run_id`,
    [input.versionId, input.actorId],
  );
  return parseVersionRow(input.period, published);
}

export async function rollbackFrontProfitPublishVersion(
  executor: AuthoritySqlExecutor,
  input: {
    period: string;
    versionId: number;
    actorId: number;
    reason?: string | null;
  } & FrontProfitPublishOptions,
): Promise<FrontProfitRollbackResult> {
  const versionId = assertPositiveSafeId(input.versionId, "versionId");
  const scopeKey = frontProfitScopeKey(input.period);

  await lockFrontProfitPublish(executor);
  await assertFrontProfitAutoPublishAuthority(executor, [input.period], {
    actorId: input.actorId,
    today: input.today,
  });

  const [candidate] = await executor.unsafe(
    `SELECT id, version_no, status, source_run_id
     FROM public.publish_version
     WHERE id = $1 AND module_code = $2 AND scope_key = $3
     FOR UPDATE`,
    [versionId, FRONT_PROFIT_MODULE_CODE, scopeKey],
  );
  const target = parseVersionRow(input.period, candidate);

  if (target.status === "rolled_back") {
    const restored = await selectRollbackRestoreVersion(executor, {
      period: input.period,
      scopeKey,
      beforeVersionNo: target.versionNo,
      status: "published",
    });
    if (!restored) {
      throw new FrontProfitPublishError("front-profit rollback target is rolled_back but no restored version was found");
    }
    return {
      period: input.period,
      rolledBackVersion: target,
      restoredVersion: restored,
      rolledBackRowCount: await countFrontProfitPublishRows(executor, target.id, "rolled_back"),
      restoredRowCount: await countFrontProfitPublishRows(executor, restored.id, "published"),
      idempotent: true,
    };
  }

  if (target.status !== "published") {
    throw new FrontProfitPublishError("front-profit rollback target must be the current published version");
  }

  const previous = await selectRollbackRestoreVersion(executor, {
    period: input.period,
    scopeKey,
    beforeVersionNo: target.versionNo,
    status: "superseded",
  });
  if (!previous) {
    throw new FrontProfitPublishError("front-profit rollback requires a superseded previous version");
  }

  const targetPublishedRows = await countFrontProfitPublishRows(executor, target.id, "published");
  const previousSupersededRows = await countFrontProfitPublishRows(executor, previous.id, "superseded");
  if (targetPublishedRows <= 0 || previousSupersededRows <= 0) {
    throw new FrontProfitPublishError("front-profit rollback requires both published target rows and superseded restore rows");
  }

  await executor.unsafe(
    `UPDATE public.front_profit_publish_row
     SET status = 'rolled_back'
     WHERE publish_version_id = $1 AND status = 'published'`,
    [target.id],
  );

  const [rolledBack] = await executor.unsafe(
    `UPDATE public.publish_version
     SET status = 'rolled_back', superseded_by = $2
     WHERE id = $1 AND status = 'published'
     RETURNING id, version_no, status, source_run_id`,
    [target.id, previous.id],
  );

  await executor.unsafe(
    `UPDATE public.front_profit_publish_row
     SET status = 'published'
     WHERE publish_version_id = $1 AND status = 'superseded'`,
    [previous.id],
  );

  const [restored] = await executor.unsafe(
    `UPDATE public.publish_version
     SET status = 'published', published_by = $2, published_at = NOW(), superseded_by = NULL
     WHERE id = $1 AND status = 'superseded'
     RETURNING id, version_no, status, source_run_id`,
    [previous.id, input.actorId],
  );

  const rolledBackVersion = parseVersionRow(input.period, rolledBack);
  const restoredVersion = parseVersionRow(input.period, restored);
  await recordFrontProfitRollbackPayload(executor, {
    rolledBackVersionId: rolledBackVersion.id,
    restoredVersionId: restoredVersion.id,
    actorId: input.actorId,
    reason: input.reason,
  });
  if (rolledBackVersion.sourceRunId != null) {
    await updateComplexJobRunStatus(executor, {
      runId: rolledBackVersion.sourceRunId,
      moduleCode: FRONT_PROFIT_MODULE_CODE,
      status: "rolled_back",
      lastCheckpointStep: "rollback",
    });
  }
  if (restoredVersion.sourceRunId != null) {
    await updateComplexJobRunStatus(executor, {
      runId: restoredVersion.sourceRunId,
      moduleCode: FRONT_PROFIT_MODULE_CODE,
      status: "published",
      lastCheckpointStep: "publish",
    });
  }

  return {
    period: input.period,
    rolledBackVersion,
    restoredVersion,
    rolledBackRowCount: targetPublishedRows,
    restoredRowCount: previousSupersededRows,
    idempotent: false,
  };
}

export async function publishFrontProfitL4Run(
  executor: AuthoritySqlExecutor,
  input: {
    period: string;
    runId: number;
    publishSourceId: number;
    actorId: number;
    sourceIds?: readonly number[];
    manualBaselineSourceId?: number | null;
    idempotencyKey?: string | null;
  } & FrontProfitPublishOptions,
): Promise<FrontProfitRunPublishResult> {
  const runId = assertPositiveSafeId(input.runId, "runId");
  const publishSourceId = assertPositiveSafeId(input.publishSourceId, "publishSourceId");
  const scopeKey = frontProfitScopeKey(input.period);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);

  await lockFrontProfitPublish(executor);
  const [run] = await executor.unsafe(
    `SELECT id, module_code, scope_key, status, input_batch_ids
     FROM public.job_run
     WHERE id = $1
     FOR UPDATE`,
    [runId],
  );
  if (
    Number(run?.id) !== runId ||
    String(run?.module_code ?? "") !== FRONT_PROFIT_MODULE_CODE ||
    String(run?.scope_key ?? "") !== scopeKey
  ) {
    throw new FrontProfitPublishError("front-profit source run does not match the publish period");
  }

  await assertFrontProfitPublishIdempotencyKeyAvailable(executor, {
    period: input.period,
    scopeKey,
    runId,
    idempotencyKey,
  });
  const publishedResult = await loadPublishedFrontProfitRunResult(executor, {
    period: input.period,
    scopeKey,
    runId,
  });
  if (publishedResult) return publishedResult;

  const runStatus = String(run.status ?? "");
  if (runStatus !== "recon_pending" && runStatus !== "gated") {
    throw new FrontProfitPublishError("front-profit source run must be recon_pending or gated before publish");
  }

  const manualBaselineSourceId = input.manualBaselineSourceId == null
    ? null
    : assertPositiveSafeId(input.manualBaselineSourceId, "manualBaselineSourceId");
  if (manualBaselineSourceId != null && publishSourceId === manualBaselineSourceId) {
    throw new FrontProfitPublishError("publishSourceId cannot be the manual baseline source");
  }

  const sourceIds = uniquePositiveSafeIds([
    ...sourceIdsFromInputBatchIds(run.input_batch_ids ?? run.inputBatchIds),
    ...(input.sourceIds ?? []),
    publishSourceId,
    manualBaselineSourceId,
  ], "sourceId");
  const publishPayload = idempotencyKey ? { idempotencyKey } : {};

  const version = await createFrontProfitDraftPublishVersion(executor, {
    period: input.period,
    sourceRunId: runId,
    actorId: input.actorId,
    today: input.today,
    sources: sourceIds.map((sourceId) => ({
      sourceId,
      sourceRunId: runId,
      inputBatchId: `source:${sourceId}`,
      role: sourceId === manualBaselineSourceId ? "manual_baseline" : "input",
      payload: publishPayload,
    })),
  });
  const staged = await stageFrontProfitL4PublishRows(executor, {
    period: input.period,
    versionId: version.id,
    sourceId: publishSourceId,
    runId,
  });
  const published = await publishFrontProfitVersion(executor, {
    period: input.period,
    versionId: version.id,
    actorId: input.actorId,
    today: input.today,
  });
  await updateComplexJobRunStatus(executor, {
    runId,
    moduleCode: FRONT_PROFIT_MODULE_CODE,
    status: "published",
    lastCheckpointStep: "publish",
  });

  return {
    runId,
    period: input.period,
    version: published,
    stagedRowCount: staged.rowCount,
    summary: staged.summary,
    sourceIds,
    idempotent: false,
  };
}
