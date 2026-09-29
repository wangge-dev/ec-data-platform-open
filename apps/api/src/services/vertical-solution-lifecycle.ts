import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";

import type { ModuleDef } from "../modules/schema.js";
import type { StoredModuleConfig } from "./module-config-store.js";
import {
  VerticalSolutionManifestError,
  type VerticalSolutionManifest,
} from "./vertical-solution-manifest.js";

export type SolutionModuleVersionExpectation = {
  code: string;
  version: number;
};

export type VerticalSolutionApplicationPlan = {
  operation: "install" | "upgrade";
  currentSolutionVersion: number | null;
  expectedModuleVersions: SolutionModuleVersionExpectation[];
  moduleCodes: string[];
  connectorIds: string[];
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function portableModuleFingerprint(module: ModuleDef): string {
  const { solutionBinding: _solutionBinding, ...portable } = module;
  return createHash("sha256").update(stableJson(portable)).digest("hex");
}

function moduleOutputFields(module: ModuleDef): Set<string> {
  const joins = module.joins ?? (module.join ? [module.join] : []);
  return new Set([
    ...module.columns.map((column) => column.name),
    ...joins.flatMap((join) => Object.keys(join.enrich)),
    "platform",
  ]);
}

function incompatible(
  code: string,
  reasons: string[],
): VerticalSolutionManifestError {
  return new VerticalSolutionManifestError(
    "SOLUTION_UPGRADE_INCOMPATIBLE",
    "方案升级会破坏现有模块合同，已拒绝自动覆盖。",
    409,
    { moduleCode: code, reasons },
  );
}

export function assertVerticalSolutionModuleUpgradeCompatible(
  current: ModuleDef,
  incoming: ModuleDef,
): void {
  const reasons: string[] = [];
  if (current.code !== incoming.code) reasons.push("模块 code 发生变化");
  const currentOutputTable = current.outputTable ?? `unified_${current.code}`;
  const incomingOutputTable = incoming.outputTable ?? `unified_${incoming.code}`;
  if (currentOutputTable !== incomingOutputTable) reasons.push("输出表发生变化");
  if (current.dataContract !== incoming.dataContract) reasons.push("数据合同发生变化");
  if (current.isDict !== incoming.isDict || current.role !== incoming.role) {
    reasons.push("字典角色发生变化");
  }

  const incomingColumns = new Map(
    incoming.columns.map((column) => [column.name, column]),
  );
  for (const column of current.columns) {
    const replacement = incomingColumns.get(column.name);
    if (!replacement) {
      reasons.push(`移除了字段 ${column.name}`);
      continue;
    }
    if (
      replacement.type !== column.type
      || replacement.computed !== column.computed
    ) {
      reasons.push(`改变了字段 ${column.name} 的类型或计算属性`);
    }
  }

  const incomingOutputFields = moduleOutputFields(incoming);
  for (const field of moduleOutputFields(current)) {
    if (!incomingOutputFields.has(field)) reasons.push(`移除了输出字段 ${field}`);
  }

  // Saved charts and semantic queries are pinned to model ID + version. A
  // compatible package upgrade must therefore leave the semantic contract
  // byte-for-byte equivalent. A semantic version migration is a separate,
  // explicitly reviewed workflow rather than a silent package update.
  if (!isDeepStrictEqual(current.semanticModel, incoming.semanticModel)) {
    reasons.push("语义模型 ID、版本或指标维度合同发生变化");
  }
  if (reasons.length > 0) throw incompatible(current.code, reasons);
}

export function planVerticalSolutionApplication(
  manifest: VerticalSolutionManifest,
  activeModules: StoredModuleConfig[],
): VerticalSolutionApplicationPlan {
  const moduleCodes = manifest.modules.map((item) => item.module.code);
  const moduleCodeSet = new Set(moduleCodes);
  const activeByCode = new Map(activeModules.map((module) => [module.code, module]));
  const targetModules = moduleCodes.flatMap((code) => {
    const current = activeByCode.get(code);
    return current ? [current] : [];
  });
  const boundModules = activeModules.filter(
    (module) => module.config.solutionBinding?.solutionId === manifest.id,
  );

  if (targetModules.length === 0 && boundModules.length === 0) {
    return {
      operation: "install",
      currentSolutionVersion: null,
      expectedModuleVersions: [],
      moduleCodes,
      connectorIds: manifest.requiredConnectors.map((item) => item.id),
    };
  }

  const conflictingModuleCodes = targetModules
    .filter((module) => (
      module.origin !== "user"
      || module.config.solutionBinding?.solutionId !== manifest.id
    ))
    .map((module) => module.code);
  if (conflictingModuleCodes.length > 0) {
    throw new VerticalSolutionManifestError(
      "SOLUTION_MODULE_CONFLICT",
      "目标实例存在不属于该方案的同名模块，方案包不会覆盖现场配置。",
      409,
      { moduleCodes: conflictingModuleCodes },
    );
  }

  const boundCodeSet = new Set(boundModules.map((module) => module.code));
  const missingModuleCodes = moduleCodes.filter((code) => !boundCodeSet.has(code));
  const removedModuleCodes = boundModules
    .map((module) => module.code)
    .filter((code) => !moduleCodeSet.has(code));
  if (missingModuleCodes.length > 0 || removedModuleCodes.length > 0) {
    throw new VerticalSolutionManifestError(
      "SOLUTION_UPGRADE_INCOMPATIBLE",
      "自动升级要求方案模块集合保持不变。",
      409,
      { missingModuleCodes, removedModuleCodes },
    );
  }

  const currentVersions = new Set(
    boundModules.map((module) => module.config.solutionBinding!.solutionVersion),
  );
  if (currentVersions.size !== 1) {
    throw new VerticalSolutionManifestError(
      "SOLUTION_UPGRADE_INCOMPATIBLE",
      "目标实例中的方案模块版本不一致，请先恢复到同一方案版本。",
      409,
      {
        modules: boundModules.map((module) => ({
          code: module.code,
          solutionVersion: module.config.solutionBinding!.solutionVersion,
        })),
      },
    );
  }
  const currentSolutionVersion = [...currentVersions][0]!;
  if (manifest.version <= currentSolutionVersion) {
    throw new VerticalSolutionManifestError(
      "SOLUTION_VERSION_CONFLICT",
      "方案包版本必须高于目标实例当前版本。",
      409,
      { currentSolutionVersion, incomingSolutionVersion: manifest.version },
    );
  }

  const incomingByCode = new Map(
    manifest.modules.map((item) => [item.module.code, item.module]),
  );
  for (const current of boundModules) {
    if (
      current.config.solutionBinding!.moduleFingerprint
      !== portableModuleFingerprint(current.config)
    ) {
      throw new VerticalSolutionManifestError(
        "SOLUTION_UPGRADE_INCOMPATIBLE",
        "目标模块包含本地定制，自动升级不会覆盖现场修改。",
        409,
        { moduleCode: current.code, reasons: ["本地配置已偏离上次安装的方案基线"] },
      );
    }
    assertVerticalSolutionModuleUpgradeCompatible(
      current.config,
      incomingByCode.get(current.code)!,
    );
  }

  return {
    operation: "upgrade",
    currentSolutionVersion,
    expectedModuleVersions: moduleCodes.map((code) => ({
      code,
      version: activeByCode.get(code)!.version,
    })),
    moduleCodes,
    connectorIds: manifest.requiredConnectors.map((item) => item.id),
  };
}

export function assertSolutionVersionExpectations(
  expected: SolutionModuleVersionExpectation[],
  actual: SolutionModuleVersionExpectation[],
): void {
  const normalize = (items: SolutionModuleVersionExpectation[]) => [...items]
    .sort((left, right) => left.code.localeCompare(right.code));
  if (!isDeepStrictEqual(normalize(expected), normalize(actual))) {
    throw new VerticalSolutionManifestError(
      "SOLUTION_VERSION_CONFLICT",
      "目标模块在校验后已经变化，请重新校验方案包。",
      409,
      { expected: normalize(expected), actual: normalize(actual) },
    );
  }
}
