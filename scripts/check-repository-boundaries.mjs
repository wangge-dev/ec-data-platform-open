#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

const modeArg = process.argv.find((arg) => arg.startsWith("--mode="));
const mode = modeArg?.slice("--mode=".length) || "private";

if (!new Set(["private", "public"]).has(mode)) {
  console.error("Usage: node scripts/check-repository-boundaries.mjs --mode=private|public");
  process.exit(2);
}

function git(args) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

function splitNull(value) {
  return value.split("\0").filter(Boolean);
}

function normalize(file) {
  return file.replaceAll("\\", "/");
}

function isPlaceholder(value) {
  return /change[_-]?me|placeholder|example|dummy|sample|test|your[_-]/i.test(value);
}

const frontProfitTemplateDirectory = "templates/front-profit";
const frontProfitManifestPath = `${frontProfitTemplateDirectory}/template-manifest.json`;
const frontProfitTemplatePaths = [
  `${frontProfitTemplateDirectory}/01-电商前台利润单表上传模板.xlsx`,
  `${frontProfitTemplateDirectory}/02-电商前台利润数据准备与映射模板.xlsx`,
];
const frontProfitTemplatePathSet = new Set(frontProfitTemplatePaths);
const ecommerceWorkbenchSampleDirectory = "templates/ecommerce-workbench/samples";
const ecommerceWorkbenchSamplePaths = [
  `${ecommerceWorkbenchSampleDirectory}/pdd_ads_account_day.xlsx`,
  `${ecommerceWorkbenchSampleDirectory}/pdd_ads_product_period.xlsx`,
  `${ecommerceWorkbenchSampleDirectory}/pdd_order_item.xlsx`,
  `${ecommerceWorkbenchSampleDirectory}/taobao_category_month.xlsx`,
  `${ecommerceWorkbenchSampleDirectory}/taobao_price_band_day.xlsx`,
  `${ecommerceWorkbenchSampleDirectory}/taobao_terminal_day.xlsx`,
  `${ecommerceWorkbenchSampleDirectory}/taobao_trade_day.xlsx`,
];
const ecommerceWorkbenchSamplePathSet = new Set(ecommerceWorkbenchSamplePaths);
const ecommerceWorkbenchSampleVerifier =
  "apps/api/scripts/ecommerce-intake/verify-workbench-share-samples.mjs";
const allowedRealSampleBoundaryPaths = new Set([
  "docs/front-profit-acceptance-manifest.example.json",
  "docs/front-profit-acceptance-result.example.json",
  "docs/front-profit-real-sample-acceptance-template.md",
]);
const allowedProductionReleaseBoundaryPaths = new Set([
  "docs/front-profit-production-release.example.json",
]);

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase();
}

const tracked = splitNull(git(["-c", "core.quotepath=false", "ls-files", "-z"])).map(normalize);
const failures = [];
const warnings = [];

const forbiddenExtensions = new Set([
  ".csv",
  ".db",
  ".dump",
  ".key",
  ".p12",
  ".pem",
  ".pfx",
  ".sqlite",
  ".xls",
  ".xlsx",
]);

for (const file of tracked) {
  const lower = file.toLowerCase();
  const base = path.posix.basename(lower);
  const extension = path.posix.extname(lower);

  if ((base === ".env" || base.startsWith(".env.")) && base !== ".env.example") {
    failures.push(`${file}: tracked environment file`);
  }

  if (forbiddenExtensions.has(extension)) {
    if (
      extension !== ".xlsx"
      || (!frontProfitTemplatePathSet.has(file) && !ecommerceWorkbenchSamplePathSet.has(file))
    ) {
      failures.push(`${file}: forbidden tracked data or secret extension`);
    }
  }

  if (/^(release|backups|data|docs\/spec)\//.test(lower)) {
    failures.push(`${file}: forbidden tracked local or generated asset`);
  }

  if (
    /^(real-samples|sample-acceptance|front-profit-real-samples|front-profit-acceptance)\//.test(lower) ||
    /^docs\/front-profit-acceptance-manifest.+\.json$/.test(lower) ||
    /^docs\/front-profit-acceptance-result.+\.json$/.test(lower)
  ) {
    if (!allowedRealSampleBoundaryPaths.has(file)) {
      failures.push(`${file}: forbidden tracked real-sample acceptance material`);
    }
  }

  if (/(^|\/)[^/]*(?:real-sample|real_sample|真实样本|脱敏样本)[^/]*$/.test(file)) {
    if (!allowedRealSampleBoundaryPaths.has(file)) {
      failures.push(`${file}: forbidden tracked real-sample acceptance material`);
    }
  }

  if (
    /^front-profit-production-release\//.test(lower) ||
    /^docs\/front-profit-production-release.+\.json$/.test(lower)
  ) {
    if (!allowedProductionReleaseBoundaryPaths.has(file)) {
      failures.push(`${file}: forbidden tracked production release authorization material`);
    }
  }

  if (mode === "public" && /^(outputs|docs\/superpowers)\//.test(lower)) {
    failures.push(`${file}: internal acceptance material is not public-safe`);
  }
}

const tracksEcommerceWorkbenchSamples = tracked.some((file) =>
  ecommerceWorkbenchSamplePathSet.has(file));

if (tracksEcommerceWorkbenchSamples) {
  const hasCompleteSampleSet = ecommerceWorkbenchSamplePaths.every((file) => {
    if (tracked.includes(file)) return true;
    failures.push(`${file}: required controlled ecommerce workbench sample is not tracked`);
    return false;
  });

  if (!tracked.includes(ecommerceWorkbenchSampleVerifier)) {
    failures.push(`${ecommerceWorkbenchSampleVerifier}: required for controlled ecommerce samples`);
  } else if (hasCompleteSampleSet) {
    try {
      execFileSync(
        process.execPath,
        [ecommerceWorkbenchSampleVerifier, ecommerceWorkbenchSampleDirectory],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
          stdio: "pipe",
        },
      );
    } catch (error) {
      const detail = `${error.stderr || error.stdout || error.message}`.trim();
      failures.push(
        `${ecommerceWorkbenchSampleDirectory}: semantic verification failed${detail ? ` (${detail})` : ""}`,
      );
    }
  }
}

const tracksFrontProfitTemplates = tracked.some(
  (file) => file === frontProfitManifestPath || frontProfitTemplatePathSet.has(file),
);

if (tracksFrontProfitTemplates) {
  if (!tracked.includes(frontProfitManifestPath)) {
    failures.push(`${frontProfitManifestPath}: required for controlled front-profit templates`);
  }

  for (const file of frontProfitTemplatePaths) {
    if (!tracked.includes(file)) {
      failures.push(`${file}: required controlled front-profit template is not tracked`);
    }
  }

  if (tracked.includes(frontProfitManifestPath)) {
    let manifest;
    let parsedManifest = false;
    try {
      manifest = JSON.parse(readFileSync(frontProfitManifestPath, "utf8"));
      parsedManifest = true;
    } catch (error) {
      failures.push(`${frontProfitManifestPath}: invalid JSON (${error.message})`);
    }

    if (parsedManifest && (!manifest || typeof manifest !== "object" || Array.isArray(manifest))) {
      failures.push(`${frontProfitManifestPath}: root must be a JSON object`);
    } else if (parsedManifest) {
      if (manifest.containsRealBusinessData !== false) {
        failures.push(`${frontProfitManifestPath}: containsRealBusinessData must be false`);
      }

      if (!Array.isArray(manifest.files)) {
        failures.push(`${frontProfitManifestPath}: files must be an array`);
      } else {
        const expectedNames = frontProfitTemplatePaths.map((file) => path.posix.basename(file));
        const entriesByName = new Map();

        for (const entry of manifest.files) {
          if (!entry || typeof entry.name !== "string") continue;
          if (entriesByName.has(entry.name)) {
            failures.push(`${frontProfitManifestPath}: duplicate file entry ${entry.name}`);
          }
          entriesByName.set(entry.name, entry);
        }

        const manifestNames = [...entriesByName.keys()].sort();
        if (
          manifest.files.length !== expectedNames.length
          || JSON.stringify(manifestNames) !== JSON.stringify([...expectedNames].sort())
        ) {
          failures.push(
            `${frontProfitManifestPath}: files must list exactly ${expectedNames.join(", ")}`,
          );
        }

        for (const file of frontProfitTemplatePaths) {
          if (!tracked.includes(file)) continue;

          const entry = entriesByName.get(path.posix.basename(file));
          if (!entry) continue;

          if (entry.businessDataRows !== 0) {
            failures.push(`${frontProfitManifestPath}: ${entry.name} businessDataRows must be 0`);
          }

          if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
            failures.push(`${frontProfitManifestPath}: ${entry.name} has an invalid SHA-256`);
            continue;
          }

          try {
            if (!lstatSync(file).isFile()) {
              failures.push(`${file}: controlled template must be a regular file`);
              continue;
            }

            const actual = sha256(file);
            if (actual !== entry.sha256.toUpperCase()) {
              failures.push(`${file}: SHA-256 does not match ${frontProfitManifestPath}`);
            }
          } catch (error) {
            failures.push(`${file}: cannot verify controlled template (${error.message})`);
          }
        }
      }
    }
  }
}

const secretRules = [
  { name: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/g },
  { name: "GitHub token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: "API key", pattern: /sk-[A-Za-z0-9_-]{20,}/g },
];

for (const file of tracked) {
  const extension = path.posix.extname(file.toLowerCase());
  if ([".gif", ".ico", ".jpeg", ".jpg", ".png", ".webp", ".xlsx", ".zip"].includes(extension)) {
    continue;
  }

  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  for (const rule of secretRules) {
    for (const match of content.matchAll(rule.pattern)) {
      if (!isPlaceholder(match[0])) {
        failures.push(`${file}: possible ${rule.name}`);
      }
    }
  }
}

const status = splitNull(git(["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z"]));
for (const entry of status) {
  if (!entry.startsWith("?? ")) continue;
  const file = normalize(entry.slice(3));
  if (/^(outputs|release|docs\/spec)\//.test(file) || /HANDOFF/i.test(file)) {
    warnings.push(`${file}: untracked local material; do not stage with "git add ."`);
  }
}

if (warnings.length > 0) {
  console.warn("Repository boundary warnings:");
  for (const warning of warnings) console.warn(`- ${warning}`);
}

if (failures.length > 0) {
  console.error(`Repository boundary check failed (${mode} mode):`);
  for (const failure of [...new Set(failures)].sort()) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Repository boundary check passed (${mode} mode, ${tracked.length} tracked files).`);
