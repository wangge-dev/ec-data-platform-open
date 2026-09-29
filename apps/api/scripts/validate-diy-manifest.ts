import { readFileSync } from "node:fs";
import path from "node:path";

import { validateConnectorManifest } from "../src/services/connector-manifest.js";
import { validateDiyModuleManifest } from "../src/services/module-manifest.js";
import { validateVerticalSolutionManifest } from "../src/services/vertical-solution-manifest.js";

const input = process.argv[2]?.trim();
if (!input) {
  throw new Error("用法：pnpm diy:validate <manifest.json>");
}

const filePath = path.resolve(input);
const raw = JSON.parse(readFileSync(filePath, "utf8"));
if (raw?.schemaVersion === "connector-manifest/v1") {
  const manifest = validateConnectorManifest(raw);
  console.log(`✓ connector ${manifest.id}@${manifest.version} (${manifest.adapter})`);
} else if (raw?.schemaVersion === "module-manifest/v1") {
  const manifest = validateDiyModuleManifest(raw);
  console.log(
    `✓ module ${manifest.module.code} · semantic ${manifest.module.semanticModel!.id}@${manifest.module.semanticModel!.version}`,
  );
} else if (raw?.schemaVersion === "vertical-solution/v1") {
  const manifest = validateVerticalSolutionManifest(raw);
  console.log(
    `✓ solution ${manifest.id}@${manifest.version} · ${manifest.modules.length} module(s) · ${manifest.requiredConnectors.length} connector requirement(s)`,
  );
} else {
  throw new Error("不支持的 schemaVersion；仅支持 module-manifest/v1、connector-manifest/v1 或 vertical-solution/v1");
}
