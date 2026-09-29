import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateVerticalSolutionManifest } from "../../src/services/vertical-solution-manifest.js";
import {
  ecommerceWorkbenchBoardBlueprint,
  ecommerceWorkbenchSolution,
  moduleCodes,
} from "./workbench-definition.js";

function outputDirectory(argv: string[]): string {
  const index = argv.indexOf("--output");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) throw new Error("用法：tsx build-workbench-assets.ts --output <目录>");
  return path.resolve(value);
}

const output = outputDirectory(process.argv.slice(2));
const solution = validateVerticalSolutionManifest(ecommerceWorkbenchSolution);

if (solution.modules.length !== 7) {
  throw new Error(`方案必须包含 7 个模块，实际为 ${solution.modules.length}`);
}
if (new Set(solution.modules.map((item) => item.module.code)).size !== moduleCodes.length) {
  throw new Error("方案模块 code 不唯一");
}
if (ecommerceWorkbenchBoardBlueprint.groups.length !== 4) {
  throw new Error("看板蓝图必须包含 4 个业务入口");
}

await mkdir(output, { recursive: true });
await writeFile(
  path.join(output, "ecommerce-operations-workbench.solution.json"),
  `${JSON.stringify(solution, null, 2)}\n`,
  "utf8",
);
await writeFile(
  path.join(output, "ecommerce-workbench-board.blueprint.json"),
  `${JSON.stringify(ecommerceWorkbenchBoardBlueprint, null, 2)}\n`,
  "utf8",
);
await writeFile(
  path.join(output, "package-manifest.json"),
  `${JSON.stringify({
    schemaVersion: "ecommerce-workbench-package/v1",
    name: "电商经营工作台",
    containsBusinessData: false,
    containsSecrets: false,
    moduleCodes,
    businessEntryCodes: ecommerceWorkbenchBoardBlueprint.groups.map((group) => group.code),
    samplePolicy: "fixed-synthetic-only",
  }, null, 2)}\n`,
  "utf8",
);

console.log(JSON.stringify({
  output,
  moduleCount: solution.modules.length,
  businessEntryCount: ecommerceWorkbenchBoardBlueprint.groups.length,
}, null, 2));
