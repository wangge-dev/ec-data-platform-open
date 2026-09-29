import type { ModuleData } from "@/pages/module/types";

export const MAX_SOLUTION_FILE_BYTES = 2 * 1024 * 1024;
export const SOLUTION_ID_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
export const SOLUTION_DELIVERY_SCOPE = Object.freeze({
  includes: "方案包只包含所选模块的配置与语义合同。",
  excludes: "不包含数据集、图表、看板布局、业务数据、账号或连接密码。",
  connector: "Excel/CSV 导入模块通常无需勾选连接器；只有模块依赖外部 SQL 时才选择对应连接器。",
  compatibility: "目标实例必须具备该方案依赖的平台能力；单模块方案也不等于完整工作台。",
});

export type ConnectorCatalogItem = {
  schemaVersion: "connector-manifest/v1";
  id: string;
  version: number;
  label: string;
  description: string;
  adapter: "pg" | "mysql";
  capabilities: string[];
};

export type SolutionModuleManifest = {
  schemaVersion: "module-manifest/v1";
  module: {
    code: string;
    name: string;
    semanticModel?: {
      id: string;
      version: number;
      metrics: unknown[];
      dimensions: unknown[];
    };
  };
};

export type VerticalSolutionManifest = {
  schemaVersion: "vertical-solution/v1";
  id: string;
  version: number;
  label: string;
  description?: string;
  dataPolicy: {
    containsBusinessData: false;
    containsSecrets: false;
  };
  modules: SolutionModuleManifest[];
  requiredConnectors: Array<{ id: string; version: number }>;
};

export type SolutionValidationResult = {
  manifest: VerticalSolutionManifest;
  readiness: {
    installable: true;
    operation: "install" | "upgrade";
    currentSolutionVersion: number | null;
    expectedModuleVersions: Array<{ code: string; version: number }>;
    moduleCodes: string[];
    connectorIds: string[];
  };
};

export type SolutionRollbackReceipt = {
  schemaVersion: "solution-rollback/v1";
  solutionId: string;
  fromSolutionVersion: number;
  toSolutionVersion: number;
  modules: Array<{
    code: string;
    expectedVersion: number;
    restoreVersion: number;
  }>;
};

export type SolutionInstallResult = {
  schemaVersion: "vertical-solution/v1";
  solutionId: string;
  solutionVersion: number;
  operation: "install" | "upgrade";
  modules: Array<{
    code: string;
    version: number;
    semanticModelId: string;
    semanticModelVersion: number;
  }>;
  rollback?: SolutionRollbackReceipt;
};

export type SolutionRollbackResult = {
  schemaVersion: "solution-rollback/v1";
  solutionId: string;
  solutionVersion: number;
  modules: SolutionInstallResult["modules"];
};

export function portableUserModules(modules: ModuleData[] | null | undefined): ModuleData[] {
  return (modules ?? [])
    .filter((module) => (
      module.origin === "user"
      && module.hasTransform === false
      && Boolean(module.semanticModel)
    ))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

export function parseSolutionManifestText(text: string): VerticalSolutionManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("文件不是合法 JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("方案包根节点必须是 JSON 对象");
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate.schemaVersion !== "vertical-solution/v1") {
    throw new Error("仅支持 vertical-solution/v1 方案包");
  }
  if (!Array.isArray(candidate.modules) || candidate.modules.length === 0) {
    throw new Error("方案包至少需要一个模块");
  }
  if (
    typeof candidate.id !== "string"
    || typeof candidate.label !== "string"
    || typeof candidate.version !== "number"
    || !Number.isInteger(candidate.version)
    || candidate.version < 1
  ) {
    throw new Error("方案包身份信息无效");
  }
  const moduleSummariesValid = candidate.modules.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const module = (item as { module?: unknown }).module;
    if (!module || typeof module !== "object" || Array.isArray(module)) return false;
    const value = module as { code?: unknown; name?: unknown };
    return typeof value.code === "string" && typeof value.name === "string";
  });
  if (!moduleSummariesValid) {
    throw new Error("方案包模块摘要结构无效");
  }
  if (!Array.isArray(candidate.requiredConnectors)) {
    throw new Error("方案包缺少 requiredConnectors 数组");
  }
  const connectorSummariesValid = candidate.requiredConnectors.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const value = item as { id?: unknown; version?: unknown };
    return typeof value.id === "string"
      && typeof value.version === "number"
      && Number.isInteger(value.version)
      && value.version > 0;
  });
  if (!connectorSummariesValid) {
    throw new Error("方案包连接器摘要结构无效");
  }
  const dataPolicy = candidate.dataPolicy as Record<string, unknown> | undefined;
  if (
    !dataPolicy
    || dataPolicy.containsBusinessData !== false
    || dataPolicy.containsSecrets !== false
  ) {
    throw new Error("方案包必须明确声明不含业务数据和密钥");
  }
  return raw as VerticalSolutionManifest;
}

export function solutionDownloadFileName(manifest: VerticalSolutionManifest): string {
  const safeId = manifest.id.replace(/[^a-z0-9_.-]/gi, "-").replace(/\./g, "-");
  return `${safeId}-v${manifest.version}.solution.json`;
}

export function solutionErrorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== "object") return fallback;
  const payload = error as {
    message?: unknown;
    code?: unknown;
    details?: { moduleCodes?: unknown; unmet?: unknown };
  };
  const message = typeof payload.message === "string" ? payload.message : fallback;
  if (
    payload.code === "SOLUTION_MODULE_CONFLICT"
    && Array.isArray(payload.details?.moduleCodes)
  ) {
    return `${message} 冲突模块：${payload.details.moduleCodes.join("、")}`;
  }
  if (
    payload.code === "SOLUTION_CONNECTOR_REQUIREMENT_UNMET"
    && Array.isArray(payload.details?.unmet)
  ) {
    const connectorIds = payload.details.unmet.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const id = (item as { id?: unknown }).id;
      return typeof id === "string" ? [id] : [];
    });
    return connectorIds.length > 0
      ? `${message} 缺失或版本不符：${connectorIds.join("、")}`
      : message;
  }
  if (
    payload.code === "SOLUTION_UPGRADE_INCOMPATIBLE"
    && payload.details
    && Array.isArray((payload.details as { reasons?: unknown }).reasons)
  ) {
    return `${message} ${(payload.details as { reasons: unknown[] }).reasons.join("；")}`;
  }
  return message;
}
