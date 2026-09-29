import { describe, expect, test, vi } from "vitest";

import {
  DemoRebuildCompensationError,
  classifyDemoSource,
  dashboardReferencesCharts,
  isCompleteLegacyDemoBundle,
  runCompensatedDemoRebuild,
} from "../src/services/demo-cockpit-maintenance.js";
import {
  DEMO_DASHBOARD,
  DEMO_FILE,
  DEMO_MODULE_CODE,
  LEGACY_DEMO_CHART_NAMES,
  LEGACY_DEMO_DASHBOARD,
  LEGACY_DEMO_DASHBOARD_DESCRIPTION,
  LEGACY_DEMO_DATASET,
  LEGACY_DEMO_FILE,
  LEGACY_DEMO_SOURCE_NAME,
} from "../src/services/demo-cockpit.js";

describe("demo cockpit maintenance safety", () => {
  test("never grants delete authority from a reserved filename alone", () => {
    expect(classifyDemoSource({ originalFileName: DEMO_FILE })).toBeNull();
    expect(classifyDemoSource({ originalFileName: LEGACY_DEMO_FILE })).toBeNull();
    expect(classifyDemoSource({ syntheticDemo: true })).toBeNull();
    expect(classifyDemoSource({ moduleCode: DEMO_MODULE_CODE })).toBeNull();
  });

  test("recognizes only the exact active or internal staging marker pair", () => {
    expect(classifyDemoSource({
      syntheticDemo: true,
      moduleCode: DEMO_MODULE_CODE,
    })).toBe("active");
    expect(classifyDemoSource({
      moduleCode: DEMO_MODULE_CODE,
      systemMetadata: {
        purpose: "synthetic-demo-cockpit",
        moduleCode: DEMO_MODULE_CODE,
        lifecycle: "staging",
        generationId: "gen-1",
      },
    })).toBe("staging");
    expect(classifyDemoSource({
      moduleCode: "orders",
      systemMetadata: {
        purpose: "synthetic-demo-cockpit",
        moduleCode: DEMO_MODULE_CODE,
        lifecycle: "staging",
        generationId: "gen-1",
      },
    })).toBeNull();
  });

  test("links a demo dashboard only through chart ids owned by the demo source", () => {
    expect(dashboardReferencesCharts({
      name: DEMO_DASHBOARD,
      layout: [{ id: 11, key: "gmv-kpi" }, { id: 12, key: "profit-kpi" }],
    }, new Set([11, 12]))).toBe(true);
    expect(dashboardReferencesCharts({
      name: DEMO_DASHBOARD,
      layout: [{ id: 99, key: "user-chart" }],
    }, new Set([11, 12]))).toBe(false);
    expect(dashboardReferencesCharts({
      name: DEMO_DASHBOARD,
      layout: [{ id: 11 }, { key: "malformed" }],
    }, new Set([11]))).toBe(false);
    expect(dashboardReferencesCharts({
      name: "用户同名之外的看板",
      layout: [{ id: 11 }],
    }, new Set([11]))).toBe(false);
  });

  test("requires every historical signal before granting one-time legacy cleanup", () => {
    const complete = {
      sourceName: LEGACY_DEMO_SOURCE_NAME,
      originalFileName: LEGACY_DEMO_FILE,
      datasetName: LEGACY_DEMO_DATASET,
      chartNames: [...LEGACY_DEMO_CHART_NAMES],
      dashboardName: LEGACY_DEMO_DASHBOARD,
      dashboardDescription: LEGACY_DEMO_DASHBOARD_DESCRIPTION,
    };
    expect(isCompleteLegacyDemoBundle(complete)).toBe(true);
    expect(isCompleteLegacyDemoBundle({ ...complete, chartNames: [LEGACY_DEMO_CHART_NAMES[0]] })).toBe(false);
    expect(isCompleteLegacyDemoBundle({ ...complete, sourceName: "用户真实文件" })).toBe(false);
    expect(isCompleteLegacyDemoBundle({ ...complete, dashboardDescription: null })).toBe(false);
  });

  test("stages before switching and does not compensate a successful generation", async () => {
    const order: string[] = [];
    const compensate = vi.fn();
    const result = await runCompensatedDemoRebuild({
      stage: async () => {
        order.push("stage");
        return { sourceId: 71 };
      },
      switchGeneration: async (staged) => {
        order.push(`switch:${staged.sourceId}`);
        return { sourceId: staged.sourceId, chartCount: 13 };
      },
      compensate,
    });

    expect(order).toEqual(["stage", "switch:71"]);
    expect(result).toEqual({ sourceId: 71, chartCount: 13 });
    expect(compensate).not.toHaveBeenCalled();
  });

  test("keeps the old generation untouched until switch and compensates a failed switch", async () => {
    const order: string[] = [];
    const failure = new Error("chart insert failed");
    await expect(runCompensatedDemoRebuild({
      stage: async () => {
        order.push("stage");
        return { sourceId: 72 };
      },
      switchGeneration: async () => {
        order.push("switch");
        throw failure;
      },
      compensate: async (staged) => {
        order.push(`compensate:${staged.sourceId}`);
      },
    })).rejects.toBe(failure);

    expect(order).toEqual(["stage", "switch", "compensate:72"]);
  });

  test("reports the exact staging source when compensation also fails", async () => {
    const switchFailure = new Error("dashboard insert failed");
    const cleanupFailure = new Error("staging cleanup failed");
    const promise = runCompensatedDemoRebuild({
      stage: async () => ({ sourceId: 73 }),
      switchGeneration: async () => { throw switchFailure; },
      compensate: async () => { throw cleanupFailure; },
    });

    await expect(promise).rejects.toMatchObject({
      name: "DemoRebuildCompensationError",
      stagedSourceId: 73,
      switchFailure,
      cleanupFailure,
    });
    await expect(promise).rejects.toBeInstanceOf(DemoRebuildCompensationError);
  });
});
