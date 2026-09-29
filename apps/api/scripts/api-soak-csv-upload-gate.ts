import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateApiSoakCsvEvidence } from "./api-soak-csv-upload-contract.js";

const API_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = path.resolve(API_ROOT, "../..");

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((arg) => arg !== "--");
  const resultIndex = argv.indexOf("--result");
  if (resultIndex < 0 || !argv[resultIndex + 1]) throw new Error("--result is required");
  const checkFiles = argv.includes("--check-files");
  const resultFile = path.resolve(REPO_ROOT, argv[resultIndex + 1]);
  const evidence = JSON.parse(await readFile(resultFile, "utf8"));
  const issues = validateApiSoakCsvEvidence(evidence);
  const sourceCommit = String(evidence?.provenance?.sourceCommit ?? "");
  if (/^[a-f0-9]{40}$/.test(sourceCommit)) {
    const commit = spawnSync("git", ["cat-file", "-e", `${sourceCommit}^{commit}`], {
      cwd: REPO_ROOT,
      stdio: "ignore",
      shell: false,
    });
    if (commit.status !== 0) issues.push(`sourceCommit is not present in local Git history: ${sourceCommit}`);
  }
  if (checkFiles) {
    const observationFile = path.resolve(REPO_ROOT, String(evidence.observationPath ?? ""));
    if (!existsSync(observationFile)) {
      issues.push("observation file is missing");
    } else {
      const observation = JSON.parse(await readFile(observationFile, "utf8"));
      if (JSON.stringify(observation) !== JSON.stringify(evidence.observation)) issues.push("observation file differs from final evidence");
      const workloadFile = path.resolve(REPO_ROOT, String(observation.workloadResultPath ?? ""));
      if (!existsSync(workloadFile)) {
        issues.push("workload result file is missing");
      } else {
        const workload = JSON.parse(await readFile(workloadFile, "utf8"));
        if (JSON.stringify(workload) !== JSON.stringify(observation.workload)) issues.push("workload file differs from observation");
      }
      const progressFile = path.resolve(REPO_ROOT, String(observation.progressPath ?? ""));
      if (!existsSync(progressFile)) {
        issues.push("progress file is missing");
      } else {
        const progress = JSON.parse(await readFile(progressFile, "utf8"));
        if (
          progress?.schema !== "api-soak-csv-upload-progress/v1"
          || progress?.state !== "completed"
          || Number(progress?.completedCycles) !== 90
          || Number(progress?.unexpectedErrors) !== 0
        ) issues.push("progress file does not prove completed zero-error soak");
      }
    }
  }
  if (issues.length) {
    [...new Set(issues)].forEach((issue) => console.error(`FAIL ${issue}`));
    process.exit(1);
  }
  console.log("PASS API long-duration CSV soak gate");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
