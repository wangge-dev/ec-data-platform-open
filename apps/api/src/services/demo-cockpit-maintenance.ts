import {
  DEMO_DASHBOARD,
  DEMO_MODULE_CODE,
  LEGACY_DEMO_CHART_NAMES,
  LEGACY_DEMO_DASHBOARD,
  LEGACY_DEMO_DASHBOARD_DESCRIPTION,
  LEGACY_DEMO_DATASET,
  LEGACY_DEMO_FILE,
  LEGACY_DEMO_SOURCE_NAME,
} from "./demo-cockpit.js";

export const DEMO_SYSTEM_METADATA_PURPOSE = "synthetic-demo-cockpit" as const;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

export type DemoSourceLifecycle = "active" | "staging";

export function classifyDemoSource(config: unknown): DemoSourceLifecycle | null {
  const sourceConfig = record(config);
  if (!sourceConfig || sourceConfig.moduleCode !== DEMO_MODULE_CODE) return null;
  if (sourceConfig.syntheticDemo === true) return "active";

  const metadata = record(sourceConfig.systemMetadata);
  if (
    metadata?.purpose === DEMO_SYSTEM_METADATA_PURPOSE
    && metadata.moduleCode === DEMO_MODULE_CODE
    && metadata.lifecycle === "staging"
    && typeof metadata.generationId === "string"
    && metadata.generationId.length > 0
  ) {
    return "staging";
  }
  return null;
}

export function dashboardReferencesCharts(
  dashboard: { name: unknown; layout: unknown },
  chartIds: ReadonlySet<number>,
): boolean {
  if (dashboard.name !== DEMO_DASHBOARD || !Array.isArray(dashboard.layout)) return false;
  const referencedIds = dashboard.layout
    .map((item) => record(item)?.id)
    .filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0);
  return referencedIds.length === dashboard.layout.length
    && referencedIds.length > 0
    && referencedIds.every((id) => chartIds.has(id));
}

export type LegacyDemoBundleSignals = {
  sourceName: unknown;
  originalFileName: unknown;
  datasetName: unknown;
  chartNames: readonly unknown[];
  dashboardName: unknown;
  dashboardDescription: unknown;
};

export function isCompleteLegacyDemoBundle(signals: LegacyDemoBundleSignals): boolean {
  const chartNames = [...new Set(signals.chartNames.filter((name): name is string => typeof name === "string"))].sort();
  const expectedCharts = [...LEGACY_DEMO_CHART_NAMES].sort();
  return signals.sourceName === LEGACY_DEMO_SOURCE_NAME
    && signals.originalFileName === LEGACY_DEMO_FILE
    && signals.datasetName === LEGACY_DEMO_DATASET
    && chartNames.length === expectedCharts.length
    && chartNames.every((name, index) => name === expectedCharts[index])
    && signals.dashboardName === LEGACY_DEMO_DASHBOARD
    && signals.dashboardDescription === LEGACY_DEMO_DASHBOARD_DESCRIPTION;
}

type StagedDemoSource = { sourceId: number };

export class DemoRebuildCompensationError extends Error {
  constructor(
    readonly stagedSourceId: number,
    readonly switchFailure: unknown,
    readonly cleanupFailure: unknown,
  ) {
    super(`demo rebuild failed and staging source ${stagedSourceId} could not be removed`);
    this.name = "DemoRebuildCompensationError";
  }
}

export async function runCompensatedDemoRebuild<
  TStaged extends StagedDemoSource,
  TResult,
>(dependencies: {
  stage: () => Promise<TStaged>;
  switchGeneration: (staged: TStaged) => Promise<TResult>;
  compensate: (staged: TStaged) => Promise<void>;
}): Promise<TResult> {
  const staged = await dependencies.stage();
  try {
    return await dependencies.switchGeneration(staged);
  } catch (switchFailure) {
    try {
      await dependencies.compensate(staged);
    } catch (cleanupFailure) {
      throw new DemoRebuildCompensationError(
        staged.sourceId,
        switchFailure,
        cleanupFailure,
      );
    }
    throw switchFailure;
  }
}
