import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { validateConnectorManifest } from "../src/services/connector-manifest.js";
import type { ModuleDef } from "../src/modules/schema.js";
import type { StoredModuleConfig } from "../src/services/module-config-store.js";
import {
  assertVerticalSolutionConnectorRequirements,
  buildVerticalSolutionManifest,
  validateVerticalSolutionManifest,
  VerticalSolutionManifestError,
} from "../src/services/vertical-solution-manifest.js";
import {
  planVerticalSolutionApplication,
  portableModuleFingerprint,
} from "../src/services/vertical-solution-lifecycle.js";

function readJson(relativePath: string) {
  return JSON.parse(readFileSync(path.resolve(process.cwd(), relativePath), "utf8"));
}

function storedSolutionModule(
  config: ModuleDef,
  solutionVersion: number,
  moduleVersion: number,
): StoredModuleConfig {
  const bound: ModuleDef = {
    ...structuredClone(config),
    solutionBinding: {
      schemaVersion: "solution-binding/v1",
      solutionId: "ecommerce.starter",
      solutionVersion,
      moduleFingerprint: portableModuleFingerprint(config),
    },
  };
  return {
    code: bound.code,
    name: bound.name,
    category: bound.category ?? null,
    description: bound.description,
    config: bound,
    version: moduleVersion,
    origin: "user",
    status: "active",
    createdBy: 1,
  };
}

describe("vertical-solution/v1", () => {
  test("validates the checked-in two-module, no-data, no-secret solution", () => {
    const manifest = validateVerticalSolutionManifest(
      readJson("extensions/solutions/ecommerce-starter.solution.json"),
    );
    const connector = validateConnectorManifest(
      readJson("extensions/connectors/warehouse-postgres.example.json"),
    );

    expect(manifest).toMatchObject({
      schemaVersion: "vertical-solution/v1",
      id: "ecommerce.starter",
      version: 1,
      dataPolicy: {
        containsBusinessData: false,
        containsSecrets: false,
      },
      requiredConnectors: [{ id: "warehouse.postgres", version: 1 }],
    });
    expect(manifest.modules.map((item) => item.module.code)).toEqual([
      "example_sales",
      "example_inventory",
    ]);
    expect(() => assertVerticalSolutionConnectorRequirements(
      manifest,
      [connector],
    )).not.toThrow();
  });

  test("fails closed for business data, secrets, duplicates, and connector drift", () => {
    const raw = readJson("extensions/solutions/ecommerce-starter.solution.json");
    expect(() => validateVerticalSolutionManifest({
      ...raw,
      dataPolicy: { containsBusinessData: true, containsSecrets: false },
    })).toThrowError(VerticalSolutionManifestError);
    expect(() => validateVerticalSolutionManifest({
      ...raw,
      secrets: { databasePassword: "must-not-be-accepted" },
    })).toThrowError(VerticalSolutionManifestError);
    expect(() => validateVerticalSolutionManifest({
      ...raw,
      modules: [raw.modules[0], raw.modules[0]],
    })).toThrow("重复模块 code");
    expect(() => validateVerticalSolutionManifest({
      ...raw,
      requiredConnectors: [
        raw.requiredConnectors[0],
        raw.requiredConnectors[0],
      ],
    })).toThrow("重复连接器要求");

    const manifest = validateVerticalSolutionManifest(raw);
    expect(() => assertVerticalSolutionConnectorRequirements(manifest, []))
      .toThrowError(expect.objectContaining({
        code: "SOLUTION_CONNECTOR_REQUIREMENT_UNMET",
      }));
  });

  test("builds a canonical export from validated module configs", () => {
    const source = validateVerticalSolutionManifest(
      readJson("extensions/solutions/ecommerce-starter.solution.json"),
    );
    const exported = buildVerticalSolutionManifest({
      id: "customer.ops",
      version: 3,
      label: "客户经营方案",
      modules: source.modules.map((item) => item.module),
      requiredConnectors: [{ id: "postgres.readonly", version: 1 }],
    });

    expect(exported).toMatchObject({
      id: "customer.ops",
      version: 3,
      dataPolicy: {
        containsBusinessData: false,
        containsSecrets: false,
      },
      requiredConnectors: [{ id: "postgres.readonly", version: 1 }],
    });
  });

  test("plans a bound, contract-preserving package as an optimistic upgrade", () => {
    const current = validateVerticalSolutionManifest(
      readJson("extensions/solutions/ecommerce-starter.solution.json"),
    );
    const incoming = validateVerticalSolutionManifest({
      ...readJson("extensions/solutions/ecommerce-starter.solution.json"),
      version: 2,
      label: "电商经营分析起步方案 2",
    });
    const active = current.modules.map((item, index) =>
      storedSolutionModule(item.module, 1, index + 3));

    expect(planVerticalSolutionApplication(incoming, active)).toEqual({
      operation: "upgrade",
      currentSolutionVersion: 1,
      expectedModuleVersions: [
        { code: "example_sales", version: 3 },
        { code: "example_inventory", version: 4 },
      ],
      moduleCodes: ["example_sales", "example_inventory"],
      connectorIds: ["warehouse.postgres"],
    });
  });

  test("rejects semantic drift and a partial module set during automatic upgrade", () => {
    const raw = readJson("extensions/solutions/ecommerce-starter.solution.json");
    const current = validateVerticalSolutionManifest(raw);
    const active = current.modules.map((item, index) =>
      storedSolutionModule(item.module, 1, index + 1));
    const semanticDrift = structuredClone(raw);
    semanticDrift.version = 2;
    semanticDrift.modules[0].module.semanticModel.metrics[0].label = "改口径";

    expect(() => planVerticalSolutionApplication(
      validateVerticalSolutionManifest(semanticDrift),
      active,
    )).toThrowError(expect.objectContaining({
      code: "SOLUTION_UPGRADE_INCOMPATIBLE",
    }));

    const partial = structuredClone(raw);
    partial.version = 2;
    partial.modules = [partial.modules[0]];
    expect(() => planVerticalSolutionApplication(
      validateVerticalSolutionManifest(partial),
      active,
    )).toThrowError(expect.objectContaining({
      code: "SOLUTION_UPGRADE_INCOMPATIBLE",
    }));

    const locallyCustomized = structuredClone(active);
    locallyCustomized[0].config.description = "客户现场已经改过";
    const compatibleV2 = structuredClone(raw);
    compatibleV2.version = 2;
    expect(() => planVerticalSolutionApplication(
      validateVerticalSolutionManifest(compatibleV2),
      locallyCustomized,
    )).toThrowError(expect.objectContaining({
      code: "SOLUTION_UPGRADE_INCOMPATIBLE",
      publicMessage: expect.stringContaining("本地定制"),
    }));
  });

  test("portable exports never leak source-instance solution bindings", () => {
    const source = validateVerticalSolutionManifest(
      readJson("extensions/solutions/ecommerce-starter.solution.json"),
    );
    const rebound = source.modules.map((item) => ({
      ...item.module,
      solutionBinding: {
        schemaVersion: "solution-binding/v1" as const,
        solutionId: "legacy.customer",
        solutionVersion: 8,
        moduleFingerprint: portableModuleFingerprint(item.module),
      },
    }));
    const exported = buildVerticalSolutionManifest({
      id: "customer.ops",
      version: 9,
      label: "客户经营方案",
      modules: rebound,
    });

    expect(exported.modules.every((item) =>
      item.module.solutionBinding === undefined)).toBe(true);
  });
});
