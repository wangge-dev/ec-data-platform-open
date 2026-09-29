import { z } from "zod";

import type { ModuleDef } from "../modules/schema.js";
import type { ConnectorManifest } from "./connector-manifest.js";
import {
  publicDiyModuleManifest,
  validateDiyModuleManifest,
  type DiyModuleManifest,
} from "./module-manifest.js";

const SolutionIdSchema = z.string().regex(
  /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/,
  "solution id 必须是 <namespace>.<name>",
);

const ConnectorRequirementSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
  version: z.number().int().positive(),
}).strict();

const VerticalSolutionEnvelopeSchema = z.object({
  schemaVersion: z.literal("vertical-solution/v1"),
  id: SolutionIdSchema,
  version: z.number().int().positive(),
  label: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(500).optional(),
  dataPolicy: z.object({
    containsBusinessData: z.literal(false),
    containsSecrets: z.literal(false),
  }).strict(),
  modules: z.array(z.unknown()).min(1).max(50),
  requiredConnectors: z.array(ConnectorRequirementSchema).max(20).default([]),
}).strict();

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
  modules: DiyModuleManifest[];
  requiredConnectors: Array<{ id: string; version: number }>;
};

export type VerticalSolutionManifestErrorCode =
  | "SOLUTION_MANIFEST_INVALID"
  | "SOLUTION_MODULE_CONFLICT"
  | "SOLUTION_CONNECTOR_REQUIREMENT_UNMET"
  | "SOLUTION_UPGRADE_INCOMPATIBLE"
  | "SOLUTION_VERSION_CONFLICT"
  | "SOLUTION_ROLLBACK_INVALID";

export class VerticalSolutionManifestError extends Error {
  constructor(
    readonly code: VerticalSolutionManifestErrorCode,
    readonly publicMessage: string,
    readonly status: 400 | 409,
    readonly details?: Record<string, unknown>,
  ) {
    super(publicMessage);
    this.name = "VerticalSolutionManifestError";
  }
}

function invalidManifest(
  message: string,
  details?: Record<string, unknown>,
): VerticalSolutionManifestError {
  return new VerticalSolutionManifestError(
    "SOLUTION_MANIFEST_INVALID",
    message,
    400,
    details,
  );
}

export function validateVerticalSolutionManifest(raw: unknown): VerticalSolutionManifest {
  const envelope = VerticalSolutionEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    throw invalidManifest("垂直方案配置包格式无效。", {
      issues: envelope.error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      })),
    });
  }

  let modules: DiyModuleManifest[];
  try {
    modules = envelope.data.modules.map(validateDiyModuleManifest);
  } catch (error) {
    throw invalidManifest(
      error instanceof Error ? error.message : "垂直方案包含无效模块清单。",
    );
  }

  const moduleCodes = modules.map((manifest) => manifest.module.code);
  if (new Set(moduleCodes).size !== moduleCodes.length) {
    throw invalidManifest("垂直方案配置包不能包含重复模块 code。", { moduleCodes });
  }
  const semanticModelIds = modules.map(
    (manifest) => manifest.module.semanticModel!.id,
  );
  if (new Set(semanticModelIds).size !== semanticModelIds.length) {
    throw invalidManifest("垂直方案配置包不能包含重复语义模型 ID。", {
      semanticModelIds,
    });
  }
  const connectorIds = envelope.data.requiredConnectors.map(
    (requirement) => requirement.id,
  );
  if (new Set(connectorIds).size !== connectorIds.length) {
    throw invalidManifest("垂直方案配置包不能包含重复连接器要求。", {
      connectorIds,
    });
  }

  return {
    schemaVersion: envelope.data.schemaVersion,
    id: envelope.data.id,
    version: envelope.data.version,
    label: envelope.data.label,
    ...(envelope.data.description
      ? { description: envelope.data.description }
      : {}),
    dataPolicy: envelope.data.dataPolicy,
    modules,
    requiredConnectors: envelope.data.requiredConnectors,
  };
}

export function assertVerticalSolutionConnectorRequirements(
  manifest: VerticalSolutionManifest,
  available: ConnectorManifest[],
): void {
  const availableById = new Map(available.map((connector) => [connector.id, connector]));
  const unmet = manifest.requiredConnectors.flatMap((requirement) => {
    const connector = availableById.get(requirement.id);
    return connector?.version === requirement.version
      ? []
      : [{
          ...requirement,
          availableVersion: connector?.version ?? null,
        }];
  });
  if (unmet.length > 0) {
    throw new VerticalSolutionManifestError(
      "SOLUTION_CONNECTOR_REQUIREMENT_UNMET",
      "垂直方案依赖的连接器未安装或版本不匹配。",
      409,
      { unmet },
    );
  }
}

export function buildVerticalSolutionManifest(input: {
  id: string;
  version: number;
  label: string;
  description?: string;
  modules: ModuleDef[];
  requiredConnectors?: Array<{ id: string; version: number }>;
}): VerticalSolutionManifest {
  return validateVerticalSolutionManifest({
    schemaVersion: "vertical-solution/v1",
    id: input.id,
    version: input.version,
    label: input.label,
    ...(input.description ? { description: input.description } : {}),
    dataPolicy: {
      containsBusinessData: false,
      containsSecrets: false,
    },
    modules: input.modules.map((module) => ({
      schemaVersion: "module-manifest/v1",
      module,
    })),
    requiredConnectors: input.requiredConnectors ?? [],
  });
}

export function publicVerticalSolutionManifest(manifest: VerticalSolutionManifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    version: manifest.version,
    label: manifest.label,
    ...(manifest.description ? { description: manifest.description } : {}),
    dataPolicy: manifest.dataPolicy,
    modules: manifest.modules.map(publicDiyModuleManifest),
    requiredConnectors: manifest.requiredConnectors,
  };
}
