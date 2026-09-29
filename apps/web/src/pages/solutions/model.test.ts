import { describe, expect, test } from "vitest";

import type { ModuleData } from "@/pages/module/types";
import {
  SOLUTION_DELIVERY_SCOPE,
  parseSolutionManifestText,
  portableUserModules,
  solutionDownloadFileName,
  solutionErrorMessage,
} from "./model";

function module(overrides: Partial<ModuleData>): ModuleData {
  return {
    code: "sales",
    name: "销售",
    description: "销售模块",
    enabled: true,
    hasTransform: false,
    outputTable: "unified_sales",
    usages: ["summary"],
    columns: [],
    platforms: [],
    semanticModel: {
      schemaVersion: "semantic-manifest/v1",
      id: "sales.analysis",
      version: 1,
      dimensions: [],
      metrics: [],
    },
    ...overrides,
  };
}

const validManifest = {
  schemaVersion: "vertical-solution/v1",
  id: "customer.ops",
  version: 2,
  label: "客户经营方案",
  dataPolicy: {
    containsBusinessData: false,
    containsSecrets: false,
  },
  modules: [{
    schemaVersion: "module-manifest/v1",
    module: { code: "sales", name: "销售" },
  }],
  requiredConnectors: [],
};

describe("solution package UI model", () => {
  test("states the delivery boundary and connector guidance explicitly", () => {
    expect(SOLUTION_DELIVERY_SCOPE.includes).toContain("模块的配置与语义合同");
    expect(SOLUTION_DELIVERY_SCOPE.excludes).toContain("数据集、图表、看板布局");
    expect(SOLUTION_DELIVERY_SCOPE.excludes).toContain("业务数据、账号或连接密码");
    expect(SOLUTION_DELIVERY_SCOPE.connector).toContain("Excel/CSV");
    expect(SOLUTION_DELIVERY_SCOPE.connector).toContain("外部 SQL");
    expect(SOLUTION_DELIVERY_SCOPE.compatibility).toContain("目标实例必须具备");
    expect(SOLUTION_DELIVERY_SCOPE.compatibility).toContain("单模块方案也不等于完整工作台");
  });

  test("offers only data-only user modules with semantic contracts", () => {
    const modules = [
      module({ code: "builtin", name: "内置", origin: "builtin" }),
      module({ code: "hooked", name: "复杂", origin: "user", hasTransform: true }),
      module({ code: "legacy", name: "旧模块", origin: "user", semanticModel: undefined }),
      module({ code: "portable_b", name: "乙模块", origin: "user" }),
      module({ code: "portable_a", name: "甲模块", origin: "user" }),
    ];

    expect(portableUserModules(modules).map((item) => item.code)).toEqual([
      "portable_a",
      "portable_b",
    ]);
  });

  test("parses only explicit no-data, no-secret vertical solution files", () => {
    expect(parseSolutionManifestText(JSON.stringify(validManifest))).toMatchObject({
      id: "customer.ops",
      version: 2,
    });
    expect(() => parseSolutionManifestText("not-json")).toThrow("合法 JSON");
    expect(() => parseSolutionManifestText(JSON.stringify({
      ...validManifest,
      schemaVersion: "module-manifest/v1",
    }))).toThrow("vertical-solution/v1");
    expect(() => parseSolutionManifestText(JSON.stringify({
      ...validManifest,
      dataPolicy: { containsBusinessData: true, containsSecrets: false },
    }))).toThrow("不含业务数据和密钥");
    expect(() => parseSolutionManifestText(JSON.stringify({
      ...validManifest,
      modules: [{ schemaVersion: "module-manifest/v1" }],
    }))).toThrow("模块摘要结构无效");
  });

  test("builds a portable filename and preserves actionable server details", () => {
    const manifest = parseSolutionManifestText(JSON.stringify(validManifest));
    expect(solutionDownloadFileName(manifest)).toBe("customer-ops-v2.solution.json");
    expect(solutionErrorMessage({
      code: "SOLUTION_MODULE_CONFLICT",
      message: "目标实例已有模块。",
      details: { moduleCodes: ["sales", "inventory"] },
    }, "校验失败")).toContain("sales、inventory");
    expect(solutionErrorMessage({
      code: "SOLUTION_UPGRADE_INCOMPATIBLE",
      message: "不能自动升级。",
      details: { reasons: ["本地配置已偏离基线", "语义合同发生变化"] },
    }, "校验失败")).toContain("本地配置已偏离基线；语义合同发生变化");
  });
});
