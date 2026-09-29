import { compileSafeFilePattern } from "../lib/file-pattern.js";
import type { LoadedModule } from "../modules/loader.js";
import type { PlatformDef } from "../modules/schema.js";

export type FileAttribution =
  | {
      kind: "module";
      moduleCode: string;
      moduleName: string;
      platformCode: string;
      platformName: string;
      label: string;
    }
  | { kind: "dict"; role: string; label: string }
  | { kind: "unmatched"; label: string };

type FileAttributionSource = {
  name: string;
  config?: unknown;
};

type FileAttributionDeps = {
  getModule: (code: string) => Promise<LoadedModule | undefined>;
  matchFileToPlatform: (
    fileName: string,
  ) => Promise<{ module: LoadedModule; platform: PlatformDef } | null>;
};

function matchAssignedPlatform(
  module: LoadedModule,
  fileName: string,
): PlatformDef | undefined {
  const enabled = module.platforms.filter((platform) => platform.enabled !== false);
  const matched = enabled.find((platform) => {
    try {
      return compileSafeFilePattern(
        platform.filePattern,
        platform.patternFlags ?? "i",
      ).test(fileName);
    } catch {
      return false;
    }
  });
  return matched ?? enabled[0];
}

function moduleAttribution(
  module: LoadedModule,
  platform: PlatformDef,
): FileAttribution {
  return {
    kind: "module",
    moduleCode: module.code,
    moduleName: module.name,
    platformCode: platform.code,
    platformName: platform.name,
    label: `${module.name} / ${platform.name}`,
  };
}

/**
 * Resolve the durable assignment first. Filename matching is only a fallback for
 * files that have never been explicitly assigned by an upload or builder flow.
 */
export async function resolveFileAttribution(
  source: FileAttributionSource,
  deps: FileAttributionDeps,
): Promise<FileAttribution> {
  const config = (source.config ?? {}) as Record<string, unknown>;
  const fileName =
    typeof config.originalFileName === "string"
      ? config.originalFileName
      : source.name;
  const role = typeof config.role === "string" ? config.role : undefined;

  if (role && role !== "file") {
    return {
      kind: "dict",
      role,
      label: role === "brand_dict" ? "品牌维护表（字典）" : `字典：${role}`,
    };
  }

  const assignedModuleCode =
    typeof config.moduleCode === "string" ? config.moduleCode.trim() : "";
  if (assignedModuleCode) {
    const assignedModule = await deps.getModule(assignedModuleCode);
    if (assignedModule) {
      const platform = matchAssignedPlatform(assignedModule, fileName);
      if (platform) return moduleAttribution(assignedModule, platform);
    }
  }

  const match = await deps.matchFileToPlatform(fileName);
  if (match) return moduleAttribution(match.module, match.platform);

  return { kind: "unmatched", label: "未匹配任何模块" };
}
