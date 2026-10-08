import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mitigatedId = "GHSA-vfj7-8cjw-p6xm";
const severityRank = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

// npm audits package versions, not pnpm's applied source patches. This one
// explicitly authorized exception requires live regression proof; no blanket ignores.
export function assessAudit(audit, { production = false, patchVerified = false } = {}) {
  if (!audit?.advisories || !audit.metadata?.vulnerabilities || audit.error) {
    throw new Error("Unrecognized dependency audit response; refusing to pass.");
  }
  const advisories = Object.values(audit.advisories);
  const counts = Object.values(audit.metadata.vulnerabilities);
  if (counts.length === 0 || counts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error("Invalid dependency audit counts.");
  }
  const reported = counts.reduce((sum, n) => sum + n, 0);
  if (reported > 0 && advisories.length === 0) {
    throw new Error("Audit reports vulnerabilities without advisory details.");
  }
  const threshold = production ? severityRank.high : severityRank.moderate;
  const blocked = [];
  const mitigated = [];
  for (const advisory of advisories) {
    if (!(advisory.severity in severityRank)) throw new Error("Unknown advisory severity.");
    const findings = advisory.findings;
    const onlyBuildBraces = Array.isArray(findings) && findings.length > 0 && findings.every((finding) =>
      finding.version === "3.0.3" && Array.isArray(finding.paths) && finding.paths.length > 0 &&
      finding.paths.every((rawPath) => {
        const path = rawPath.replaceAll("\\", "/").replace(/^apps__web/, "apps/web").replace(/\s*>\s*/g, ">");
        return /^apps\/web>tailwindcss(?:@[^>]+)?>/.test(path) && />(?:braces@3\.0\.3|braces)$/.test(path);
      }));
    if (!production && patchVerified && advisory.github_advisory_id === mitigatedId &&
      advisory.module_name === "braces" && onlyBuildBraces) {
      mitigated.push(advisory);
    } else if (severityRank[advisory.severity] >= threshold) {
      blocked.push(advisory);
    }
  }
  return { blocked, mitigated, rawCounts: audit.metadata.vulnerabilities };
}

function main() {
  const production = process.argv.includes("--prod");
  const pnpmEntry = process.env.npm_execpath;
  if (!pnpmEntry) throw new Error("Run through the pinned package manager: corepack pnpm audit:all");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const command = spawnSync(process.execPath, [pnpmEntry, "audit", "--json",
    "--registry=https://registry.npmjs.org/", ...(production ? ["--prod"] : [])], {
    cwd: root, encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024,
  });
  if (command.error || command.signal || ![0, 1].includes(command.status)) {
    throw new Error(`Dependency scan failed (${command.status ?? command.error?.message ?? command.signal}).`);
  }
  const audit = JSON.parse(command.stdout);
  console.log("Raw npm audit counts:", audit.metadata?.vulnerabilities);
  let patchVerified = false;
  if (!production) {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    if (manifest.pnpm?.patchedDependencies?.["braces@3.0.3"] !== "patches/braces@3.0.3.patch") {
      throw new Error("Expected declared braces patch is missing.");
    }
    const proof = spawnSync(process.execPath, ["--test", "scripts/braces-depth-regression.test.mjs"], {
      cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024,
    });
    process.stdout.write(proof.stdout ?? "");
    process.stderr.write(proof.stderr ?? "");
    if (proof.error || proof.status !== 0) throw new Error("Patched braces regression proof failed.");
    patchVerified = true;
  }
  const result = assessAudit(audit, { production, patchVerified });
  for (const advisory of result.mitigated) {
    console.warn(`MITIGATED (still reported upstream): ${advisory.github_advisory_id}; patched Tailwind build dependency, live regressions passed.`);
  }
  for (const advisory of result.blocked) {
    console.error(`BLOCKED: ${advisory.severity} ${advisory.module_name} ${advisory.github_advisory_id ?? advisory.url}`);
  }
  if (result.blocked.length > 0) process.exitCode = 1;
  else console.log("Dependency policy passed; raw findings shown above are not hidden.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
