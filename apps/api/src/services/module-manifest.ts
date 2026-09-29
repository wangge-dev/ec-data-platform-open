import { z } from "zod";

import { validateModuleConfig, type ModuleDef } from "../modules/schema.js";

const ModuleManifestEnvelopeSchema = z.object({
  schemaVersion: z.literal("module-manifest/v1"),
  module: z.unknown(),
}).strict();

export type DiyModuleManifest = {
  schemaVersion: "module-manifest/v1";
  module: ModuleDef;
};

export function validateDiyModuleManifest(raw: unknown): DiyModuleManifest {
  const envelope = ModuleManifestEnvelopeSchema.parse(raw);
  const parsedModule = validateModuleConfig(envelope.module, "module-manifest/v1");
  const { solutionBinding: _solutionBinding, ...portableModule } = parsedModule;
  const module = validateModuleConfig(portableModule, "module-manifest/v1");
  if (module.hasTransform) {
    throw new Error("DIY 模块清单不能启用 transform 钩子");
  }
  if (!module.semanticModel) {
    throw new Error("DIY 模块清单必须声明 semantic-manifest/v1");
  }
  return { schemaVersion: envelope.schemaVersion, module };
}

export function publicDiyModuleManifest(manifest: DiyModuleManifest) {
  const { solutionBinding: _solutionBinding, ...portableModule } = manifest.module;
  return {
    schemaVersion: manifest.schemaVersion,
    module: portableModule,
  };
}
