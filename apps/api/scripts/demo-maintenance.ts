// Audited one-shot maintenance for the deterministic synthetic cockpit.
// Runtime usage:
//   pnpm demo:rebuild
//   pnpm demo:clear
//   pnpm demo:migrate-legacy
import { randomUUID } from "node:crypto";
import path from "node:path";

import { config } from "dotenv";
import postgres from "postgres";
import * as XLSX from "xlsx";

config({ path: path.resolve(process.cwd(), "../../.env") });

import { sql } from "../src/db/client.js";
import {
  deleteFileSource,
  deleteFileSourceInTransaction,
  importExcel,
} from "../src/services/import-excel.js";
import {
  DEMO_COCKPIT_CHARTS,
  DEMO_DASHBOARD,
  DEMO_DASHBOARD_DESCRIPTION,
  DEMO_DATASET,
  DEMO_MODULE_CODE,
  DEMO_MODULE_NAME,
  DEMO_PERIOD,
  DEMO_TAG,
  LEGACY_DEMO_DASHBOARD,
  LEGACY_DEMO_DASHBOARD_DESCRIPTION,
  LEGACY_DEMO_FILE,
  LEGACY_DEMO_SOURCE_NAME,
  buildDemoCockpitFactQuery,
  buildSyntheticCockpitRows,
} from "../src/services/demo-cockpit.js";
import {
  DEMO_SYSTEM_METADATA_PURPOSE,
  classifyDemoSource,
  dashboardReferencesCharts,
  isCompleteLegacyDemoBundle,
  runCompensatedDemoRebuild,
} from "../src/services/demo-cockpit-maintenance.js";

const MAINTENANCE_LOCK_KEY = "ec-data-platform:demo-cockpit-maintenance:v1";
const STAGING_FILE_PREFIX = `${DEMO_TAG}cockpit-staging-`;

type MaintenanceCommand = "rebuild" | "clear" | "migrate-legacy";
type SqlExecutor = { unsafe: (...args: any[]) => any };
type SourceRow = { id: number | string; name: string; config: unknown };
type DashboardRow = { id: number | string; name: string; description: string | null; layout: unknown };

function sourceId(value: unknown, label = "source id"): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label} is invalid`);
  return id;
}

function parseCommand(args: readonly string[]): MaintenanceCommand {
  if (args.length !== 1 || !["rebuild", "clear", "migrate-legacy"].includes(args[0])) {
    throw new Error("usage: demo-maintenance.ts <rebuild|clear|migrate-legacy>");
  }
  return args[0] as MaintenanceCommand;
}

async function markedSources(executor: SqlExecutor, excludeId?: number): Promise<Array<{
  id: number;
  lifecycle: "active" | "staging";
}>> {
  const rows = await executor.unsafe(
    "SELECT id, name, config FROM public.data_sources WHERE type = 'file' ORDER BY id",
  ) as SourceRow[];
  return rows.flatMap((row) => {
    const id = sourceId(row.id);
    const lifecycle = classifyDemoSource(row.config);
    return lifecycle && id !== excludeId ? [{ id, lifecycle }] : [];
  });
}

async function chartIdsForSources(executor: SqlExecutor, sourceIds: readonly number[]): Promise<number[]> {
  if (sourceIds.length === 0) return [];
  const rows = await executor.unsafe(
    `SELECT c.id
       FROM public.charts c
       INNER JOIN public.datasets d ON d.id = c.dataset_id
      WHERE d.source_id = ANY($1::bigint[])
      ORDER BY c.id`,
    [[...sourceIds]],
  ) as Array<{ id: number | string }>;
  return rows.map((row) => sourceId(row.id, "chart id"));
}

async function linkedDemoDashboardIds(
  executor: SqlExecutor,
  chartIds: readonly number[],
): Promise<number[]> {
  if (chartIds.length === 0) return [];
  const rows = await executor.unsafe(
    "SELECT id, name, description, layout FROM public.dashboards WHERE name = $1 ORDER BY id",
    [DEMO_DASHBOARD],
  ) as DashboardRow[];
  const ownedChartIds = new Set(chartIds);
  return rows
    .filter((row) => dashboardReferencesCharts(row, ownedChartIds))
    .map((row) => sourceId(row.id, "dashboard id"));
}

async function clearMarkedDemoSources(
  executor: SqlExecutor,
  excludeId?: number,
): Promise<{ sourceIds: number[]; dashboardIds: number[] }> {
  const sources = await markedSources(executor, excludeId);
  const sourceIds = sources.map((source) => source.id);
  const chartIds = await chartIdsForSources(executor, sourceIds);
  const dashboardIds = await linkedDemoDashboardIds(executor, chartIds);
  if (dashboardIds.length > 0) {
    await executor.unsafe(
      "DELETE FROM public.dashboards WHERE id = ANY($1::bigint[])",
      [dashboardIds],
    );
  }
  for (const id of sourceIds) {
    await deleteFileSourceInTransaction(executor, id);
  }
  return { sourceIds, dashboardIds };
}

function buildWorkbook(): Buffer {
  const worksheet = XLSX.utils.json_to_sheet(buildSyntheticCockpitRows());
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "经营事实");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function stageGeneration() {
  const generationId = randomUUID();
  const imported = await importExcel(
    buildWorkbook(),
    `${STAGING_FILE_PREFIX}${generationId}.xlsx`,
    `${DEMO_TAG}${DEMO_MODULE_NAME}事实表（构建中）`,
    "file",
    false,
    null,
    DEMO_MODULE_CODE,
    null,
    {
      systemMetadata: {
        purpose: DEMO_SYSTEM_METADATA_PURPOSE,
        moduleCode: DEMO_MODULE_CODE,
        lifecycle: "staging",
        generationId,
      },
    },
  );
  console.log(JSON.stringify({
    event: "demo_generation_staged",
    generationId,
    sourceId: imported.sourceId,
    rows: imported.rowCount,
  }));
  return { ...imported, generationId };
}

async function switchGeneration(staged: Awaited<ReturnType<typeof stageGeneration>>) {
  return sql.begin(async (tx) => {
    const sourceRows = await tx.unsafe(
      "SELECT config FROM public.data_sources WHERE id = $1 AND type = 'file' FOR UPDATE",
      [staged.sourceId],
    ) as Array<{ config: unknown }>;
    const existingConfig = sourceRows[0]?.config;
    if (classifyDemoSource(existingConfig) !== "staging") {
      throw new Error(`staging source ${staged.sourceId} lost its internal lifecycle marker`);
    }
    const configRecord = existingConfig && typeof existingConfig === "object" && !Array.isArray(existingConfig)
      ? existingConfig as Record<string, unknown>
      : {};
    const systemMetadata = configRecord.systemMetadata && typeof configRecord.systemMetadata === "object"
      ? configRecord.systemMetadata as Record<string, unknown>
      : {};
    const activeConfig = {
      ...configRecord,
      moduleCode: DEMO_MODULE_CODE,
      moduleName: DEMO_MODULE_NAME,
      syntheticDemo: true,
      demoPeriod: DEMO_PERIOD,
      systemMetadata: { ...systemMetadata, lifecycle: "active" },
    };
    await tx.unsafe(
      "UPDATE public.data_sources SET name = $2, config = $3::jsonb, updated_at = NOW() WHERE id = $1",
      [staged.sourceId, `${DEMO_TAG}${DEMO_MODULE_NAME}事实表`, JSON.stringify(activeConfig)],
    );

    const datasetRows = await tx.unsafe(
      `INSERT INTO public.datasets (name, source_id, query_type, query_text, fields)
       VALUES ($1, $2, 'sql', $3, NULL) RETURNING id`,
      [DEMO_DATASET, staged.sourceId, buildDemoCockpitFactQuery(staged.tableName)],
    ) as Array<{ id: number | string }>;
    const datasetId = sourceId(datasetRows[0]?.id, "dataset id");

    const createdCharts: Array<{ id: number; key: string }> = [];
    for (const definition of DEMO_COCKPIT_CHARTS) {
      const chartRows = await tx.unsafe(
        `INSERT INTO public.charts (dataset_id, name, chart_type, config, module_code)
         VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
        [
          datasetId,
          definition.name,
          definition.chartType,
          JSON.stringify(definition.config),
          DEMO_MODULE_CODE,
        ],
      ) as Array<{ id: number | string }>;
      createdCharts.push({
        id: sourceId(chartRows[0]?.id, "chart id"),
        key: definition.key,
      });
    }

    const dashboardRows = await tx.unsafe(
      `INSERT INTO public.dashboards (name, description, layout)
       VALUES ($1, $2, $3::jsonb) RETURNING id`,
      [DEMO_DASHBOARD, DEMO_DASHBOARD_DESCRIPTION, JSON.stringify(createdCharts)],
    ) as Array<{ id: number | string }>;
    const dashboardId = sourceId(dashboardRows[0]?.id, "dashboard id");

    // The new generation is complete before the old marked generation is
    // removed. Both actions share this transaction, so any cleanup failure
    // rolls the metadata switch back and leaves the previous demo intact.
    const removed = await clearMarkedDemoSources(tx, staged.sourceId);
    return {
      sourceId: staged.sourceId,
      datasetId,
      dashboardId,
      chartCount: createdCharts.length,
      rowCount: staged.rowCount,
      removed,
    };
  });
}

async function rebuildDemo() {
  const result = await runCompensatedDemoRebuild({
    stage: stageGeneration,
    switchGeneration,
    compensate: async (staged) => {
      await deleteFileSource(staged.sourceId);
      console.log(JSON.stringify({
        event: "demo_staging_compensated",
        generationId: staged.generationId,
        sourceId: staged.sourceId,
      }));
    },
  });
  console.log(JSON.stringify({ event: "demo_generation_activated", ...result }));
}

async function clearDemo() {
  const removed = await sql.begin(async (tx) => clearMarkedDemoSources(tx));
  console.log(JSON.stringify({ event: "demo_marked_sources_cleared", ...removed }));
}

async function migrateLegacyDemo() {
  const result = await sql.begin(async (tx) => {
    const sources = await tx.unsafe(
      "SELECT id, name, config FROM public.data_sources WHERE type = 'file' ORDER BY id",
    ) as SourceRow[];
    const dashboards = await tx.unsafe(
      "SELECT id, name, description, layout FROM public.dashboards WHERE name = $1 ORDER BY id",
      [LEGACY_DEMO_DASHBOARD],
    ) as DashboardRow[];
    const matchingDashboards = dashboards.filter((dashboard) =>
      dashboard.description === LEGACY_DEMO_DASHBOARD_DESCRIPTION);
    if (matchingDashboards.length > 1) {
      throw new Error("legacy demo dashboard signals are ambiguous; no records were removed");
    }

    const completeBundles: Array<{
      sourceId: number;
      datasetId: number;
      chartIds: number[];
      dashboardId: number;
      signals: Parameters<typeof isCompleteLegacyDemoBundle>[0];
    }> = [];
    for (const source of sources) {
      const config = source.config && typeof source.config === "object" && !Array.isArray(source.config)
        ? source.config as Record<string, unknown>
        : {};
      if (
        source.name !== LEGACY_DEMO_SOURCE_NAME
        || config.originalFileName !== LEGACY_DEMO_FILE
      ) {
        continue;
      }
      const datasets = await tx.unsafe(
        "SELECT id, name FROM public.datasets WHERE source_id = $1 ORDER BY id",
        [source.id],
      ) as Array<{ id: number | string; name: string }>;
      if (datasets.length !== 1) continue;
      const chartRows = await tx.unsafe(
        "SELECT id, name FROM public.charts WHERE dataset_id = $1 ORDER BY id",
        [datasets[0].id],
      ) as Array<{ id: number | string; name: string }>;
      if (matchingDashboards.length !== 1) continue;
      const signals = {
        sourceName: source.name,
        originalFileName: config.originalFileName,
        datasetName: datasets[0].name,
        chartNames: chartRows.map((chart) => chart.name),
        dashboardName: matchingDashboards[0].name,
        dashboardDescription: matchingDashboards[0].description,
      };
      if (!isCompleteLegacyDemoBundle(signals)) continue;
      completeBundles.push({
        sourceId: sourceId(source.id),
        datasetId: sourceId(datasets[0].id, "dataset id"),
        chartIds: chartRows.map((chart) => sourceId(chart.id, "chart id")),
        dashboardId: sourceId(matchingDashboards[0].id, "dashboard id"),
        signals,
      });
    }
    if (completeBundles.length > 1) {
      throw new Error("legacy demo migration is ambiguous; no records were removed");
    }
    const bundle = completeBundles[0];
    if (!bundle) return { migrated: false };
    await tx.unsafe("DELETE FROM public.dashboards WHERE id = $1", [bundle.dashboardId]);
    await deleteFileSourceInTransaction(tx, bundle.sourceId);
    return { migrated: true, ...bundle };
  });
  console.log(JSON.stringify({ event: "legacy_demo_migration", ...result }));
}

async function withMaintenanceLock(operation: () => Promise<void>): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const lockClient = postgres(databaseUrl, { max: 1, connect_timeout: 5 });
  let acquired = false;
  try {
    const [lock] = await lockClient<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtextextended(${MAINTENANCE_LOCK_KEY}, 0)) AS acquired
    `;
    acquired = lock?.acquired === true;
    if (!acquired) throw new Error("another demo maintenance command is already running");
    await operation();
  } finally {
    if (acquired) {
      await lockClient`
        SELECT pg_advisory_unlock(hashtextextended(${MAINTENANCE_LOCK_KEY}, 0))
      `;
    }
    await lockClient.end({ timeout: 1 });
  }
}

async function main() {
  const command = parseCommand(process.argv.slice(2));
  await withMaintenanceLock(async () => {
    if (command === "rebuild") await rebuildDemo();
    else if (command === "clear") await clearDemo();
    else await migrateLegacyDemo();
  });
  await sql.end();
}

try {
  await main();
} catch (error) {
  console.error(error);
  try {
    await sql.end({ timeout: 1 });
  } catch {
    // Preserve the maintenance failure as the process-level error.
  }
  process.exitCode = 1;
}
