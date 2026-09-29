import { createReadStream, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { z } from "zod";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const DEFAULT_MANIFEST = path.join(REPO_ROOT, "docs/front-profit-acceptance-manifest.example.json");
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TEMPLATE_MARKERS = new Set(["", "TBD", "TODO", "N/A"]);

const REQUIRED_SOURCE_FAMILIES = [
  "operator_assignment",
  "sales_fact",
  "cost_period",
  "cost_usage",
  "rebate",
  "fee_fact",
  "promotion_spend",
  "manual_baseline",
] as const;

const sourceFamilySchema = z.enum(REQUIRED_SOURCE_FAMILIES);

const fieldMappingSchema = z.object({
  sourceHeader: z.string().trim().min(1),
  contractField: z.string().trim().min(1),
  sanitization: z.enum(["none", "drop", "mask", "stable_hash", "bucket", "synthetic_replace"]),
  owner: z.string().trim().min(1),
  required: z.boolean(),
  exceptionPolicy: z.string().trim().min(1),
});

const sourceBaseSchema = z.object({
  family: sourceFamilySchema,
  alias: z.string().trim().min(1),
  rowCount: z.number().int().nonnegative(),
  sourceSystem: z.string().trim().min(1),
  sensitiveFields: z.array(z.string().trim().min(1)).default([]),
});

const sourceDateRangeSchema = z.object({
  from: z.string().regex(DATE_PATTERN),
  to: z.string().regex(DATE_PATTERN),
});

const participatingSourceSchema = sourceBaseSchema.extend({
  participating: z.literal(true),
  dateField: z.string().trim().min(1),
  dateRange: sourceDateRangeSchema,
  sanitizedPath: z.string().trim().min(1),
  fieldMappings: z.array(fieldMappingSchema).min(1),
  nonParticipationReason: z.never().optional(),
});

const nonParticipatingSourceSchema = sourceBaseSchema.extend({
  participating: z.literal(false),
  rowCount: z.literal(0),
  nonParticipationReason: z.string().trim().min(1),
  dateField: z.string().trim().optional(),
  dateRange: sourceDateRangeSchema.optional(),
  sanitizedPath: z.string().trim().optional(),
  fieldMappings: z.array(fieldMappingSchema).optional().default([]),
});

const sourceSchema = z.discriminatedUnion("participating", [
  participatingSourceSchema,
  nonParticipatingSourceSchema,
]);

const manifestSchema = z.object({
  schemaVersion: z.literal("front-profit-real-sample-acceptance/v1"),
  mode: z.enum(["template", "authorized"]),
  authorization: z.object({
    authorized: z.boolean(),
    authorizationDate: z.string().regex(DATE_PATTERN),
    authorizer: z.string().trim().min(1),
    executor: z.string().trim().min(1),
    allowedPurpose: z.literal("front-profit-isolated-dry-run"),
    allowedPeriods: z.array(z.string().regex(PERIOD_PATTERN)).min(1),
    retentionDays: z.number().int().positive().max(30),
    isolationEnvironment: z.string().trim().min(1),
    confirmNoGit: z.literal(true),
    confirmNoCi: z.literal(true),
    confirmNoProductionDb: z.literal(true),
    confirmSanitizedOnly: z.literal(true),
    confirmCleanupRequired: z.literal(true),
  }),
  sources: z.array(sourceSchema).min(1),
  businessRules: z.object({
    periodBasis: z.literal("calendar_month"),
    closeDayOfNextMonth: z.literal(5),
    rebateKey: z.literal("rebate_key"),
    rebateDate: z.literal("rebate_event_date"),
    feeAuthorityPriority: z.tuple([
      z.literal("settlement"),
      z.literal("platform_bill"),
      z.literal("rate_rule"),
      z.literal("manual_estimate"),
    ]),
    operatorAuthorityPriority: z.tuple([
      z.literal("sku"),
      z.literal("ad_account"),
      z.literal("product_owner"),
      z.literal("order_owner"),
      z.literal("manual_mapping"),
    ]),
    costMatchDate: z.literal("shipment_date"),
    promotionOrphanPolicy: z.literal("keep_and_allow_negative_profit"),
  }),
  dryRunGates: z.object({
    aggregationKeyCoverage: z.literal(1),
    maxMoneyDiff: z.literal(0.01),
    unresolvedBlockCount: z.literal(0),
    publishRetryMustBeIdempotent: z.literal(true),
    rollbackMustRestorePreviousVersion: z.literal(true),
  }),
});

type Manifest = z.infer<typeof manifestSchema>;

function resolveFromRepo(value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(REPO_ROOT, value);
}

function parseArgs(argv: string[]) {
  let manifestPath = DEFAULT_MANIFEST;
  let templateOk = false;
  let checkFiles = false;
  let allowSynthetic = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") {
      const next = argv[index + 1];
      if (!next) throw new Error("--manifest requires a path");
      manifestPath = resolveFromRepo(next);
      index += 1;
    } else if (arg === "--template-ok") {
      templateOk = true;
    } else if (arg === "--check-files") {
      checkFiles = true;
    } else if (arg === "--allow-synthetic") {
      allowSynthetic = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: pnpm --filter @ec/api run front-profit:acceptance-preflight -- --manifest <manifest.json> [--template-ok] [--check-files] [--allow-synthetic]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { manifestPath: resolveFromRepo(manifestPath), templateOk, checkFiles, allowSynthetic };
}

function relativeToRepo(value: string): string | null {
  const resolved = resolveFromRepo(value);
  const relative = path.relative(REPO_ROOT, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return relative.replaceAll(path.sep, "/");
  }
  return null;
}

function isIgnoredByGit(repoRelativePath: string): boolean {
  const result = spawnSync(
    "git",
    ["check-ignore", "--quiet", "--", repoRelativePath],
    { cwd: REPO_ROOT, stdio: "ignore", shell: false },
  );
  return result.status === 0;
}

function hasTemplateMarker(value: unknown): boolean {
  if (typeof value === "string") return TEMPLATE_MARKERS.has(value.trim());
  if (Array.isArray(value)) return value.some(hasTemplateMarker);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(hasTemplateMarker);
  }
  return false;
}

function hasSyntheticMarker(value: unknown): boolean {
  if (typeof value === "string") {
    return /\b(synthetic|placeholder|not[-_]?real|rehearsal)\b/i.test(value);
  }
  if (Array.isArray(value)) return value.some(hasSyntheticMarker);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(hasSyntheticMarker);
  }
  return false;
}

function addIssue(issues: string[], message: string) {
  issues.push(`- ${message}`);
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  const text = line.startsWith("\ufeff") ? line.slice(1) : line;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\"") {
      if (quoted && text[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

async function inspectCsvFile(filePath: string): Promise<{ headers: string[]; rowCount: number }> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const reader = createInterface({ input, crlfDelay: Infinity });
  let headers: string[] | null = null;
  let rowCount = 0;
  for await (const line of reader) {
    if (headers == null) {
      if (!line.trim()) continue;
      headers = parseCsvLine(line);
      continue;
    }
    if (line.trim()) rowCount += 1;
  }
  return { headers: headers ?? [], rowCount };
}

function validateManifest(manifest: Manifest, manifestPath: string, templateOk: boolean, allowSynthetic: boolean): string[] {
  const issues: string[] = [];
  const isTemplate = manifest.mode === "template";
  if (isTemplate && !templateOk) {
    addIssue(issues, "manifest is in template mode; pass --template-ok only when validating the checked-in example");
  }
  if (!isTemplate && templateOk) {
    addIssue(issues, "--template-ok cannot be used with an authorized manifest");
  }
  if (!isTemplate && !manifest.authorization.authorized) {
    addIssue(issues, "authorized manifest must set authorization.authorized=true");
  }
  if (!isTemplate && hasTemplateMarker(manifest)) {
    addIssue(issues, "authorized manifest still contains template markers such as TBD/TODO/N/A");
  }
  if (!isTemplate && !allowSynthetic && hasSyntheticMarker(manifest)) {
    addIssue(issues, "authorized manifest contains synthetic/placeholder markers; use --allow-synthetic only for local smoke rehearsal");
  }

  const manifestRelative = relativeToRepo(manifestPath);
  const isExample = manifestRelative === "docs/front-profit-acceptance-manifest.example.json";
  if (manifestRelative && !isExample && !isIgnoredByGit(manifestRelative)) {
    addIssue(issues, `manifest file is inside the repo but is not git-ignored: ${manifestRelative}`);
  }

  const participating = manifest.sources.filter((source) => source.participating);
  if (!participating.some((source) => source.family === "manual_baseline")) {
    addIssue(issues, "manual_baseline must participate so auto output can be compared with the existing 28-field result");
  }
  const inventoriedFamilies = new Set(manifest.sources.map((source) => source.family));
  const missingFamilies = REQUIRED_SOURCE_FAMILIES.filter((family) => !inventoriedFamilies.has(family));
  if (missingFamilies.length > 0) {
    addIssue(issues, `manifest must inventory every source family; missing: ${missingFamilies.join(", ")}`);
  }
  const duplicateFamilyAliases = new Set<string>();
  const seenFamilyAliases = new Set<string>();
  for (const source of manifest.sources) {
    const key = `${source.family}:${source.alias}`;
    if (seenFamilyAliases.has(key)) duplicateFamilyAliases.add(key);
    seenFamilyAliases.add(key);
    if (source.dateRange && source.dateRange.from > source.dateRange.to) {
      addIssue(issues, `${key} has dateRange.from later than dateRange.to`);
    }
    if (source.participating && source.rowCount <= 0) {
      addIssue(issues, `${key} participates but rowCount is 0`);
    }
    if (!source.participating && !source.nonParticipationReason.trim()) {
      addIssue(issues, `${key} does not participate and must explain nonParticipationReason`);
    }
    if (source.sanitizedPath) {
      const sanitizedRelative = relativeToRepo(source.sanitizedPath);
      if (sanitizedRelative && !isIgnoredByGit(sanitizedRelative)) {
        addIssue(issues, `${key} sanitizedPath is inside the repo but is not git-ignored: ${sanitizedRelative}`);
      }
    }
    if (source.participating && source.sensitiveFields.length > 0) {
      const riskyMappings = source.fieldMappings.filter((mapping) =>
        source.sensitiveFields.includes(mapping.sourceHeader) &&
        mapping.sanitization === "none",
      );
      if (riskyMappings.length > 0) {
        addIssue(issues, `${key} maps sensitive headers without sanitization: ${riskyMappings.map((item) => item.sourceHeader).join(", ")}`);
      }
    }
  }
  for (const key of duplicateFamilyAliases) {
    addIssue(issues, `duplicate source family/alias entry: ${key}`);
  }

  return issues;
}

async function validateFileEvidence(manifest: Manifest): Promise<{ checkedFiles: number; issues: string[] }> {
  const issues: string[] = [];
  let checkedFiles = 0;
  for (const source of manifest.sources) {
    if (!source.participating) continue;
    const key = `${source.family}:${source.alias}`;
    const sanitizedPath = resolveFromRepo(source.sanitizedPath);
    if (!/\.csv$/i.test(sanitizedPath)) {
      addIssue(issues, `${key} sanitizedPath must be a CSV file for --check-files`);
      continue;
    }
    if (!existsSync(sanitizedPath)) {
      addIssue(issues, `${key} sanitizedPath not found for --check-files`);
      continue;
    }
    let inspected: { headers: string[]; rowCount: number };
    try {
      inspected = await inspectCsvFile(sanitizedPath);
    } catch (error) {
      addIssue(issues, `${key} could not be read as UTF-8 CSV: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    checkedFiles += 1;
    if (inspected.headers.length === 0) {
      addIssue(issues, `${key} CSV has no header row`);
      continue;
    }
    const headerSet = new Set(inspected.headers);
    const requiredHeaders = [...new Set([
      source.dateField,
      ...source.fieldMappings.map((mapping) => mapping.sourceHeader),
    ])];
    const missingHeaders = requiredHeaders.filter((header) => !headerSet.has(header));
    if (missingHeaders.length > 0) {
      addIssue(issues, `${key} missing required CSV headers: ${missingHeaders.join(", ")}`);
    }
    if (inspected.rowCount !== source.rowCount) {
      addIssue(issues, `${key} rowCount mismatch: manifest=${source.rowCount}, csv=${inspected.rowCount}`);
    }
  }
  return { checkedFiles, issues };
}

async function main() {
  const { manifestPath, templateOk, checkFiles, allowSynthetic } = parseArgs(process.argv.slice(2));
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest not found: ${manifestPath}`);
  }

  const parsed = manifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (!parsed.success) {
    console.error("FRONT_PROFIT_ACCEPTANCE_PREFLIGHT_FAILED");
    for (const issue of parsed.error.issues) {
      console.error(`- ${issue.path.join(".") || "<root>"}: ${issue.message}`);
    }
    process.exit(1);
  }

  const issues = validateManifest(parsed.data, manifestPath, templateOk, allowSynthetic);
  let checkedFiles = 0;
  if (checkFiles) {
    if (parsed.data.mode !== "authorized") {
      addIssue(issues, "--check-files can only be used with an authorized manifest");
    } else {
      const fileEvidence = await validateFileEvidence(parsed.data);
      checkedFiles = fileEvidence.checkedFiles;
      issues.push(...fileEvidence.issues);
    }
  }
  if (issues.length > 0) {
    console.error("FRONT_PROFIT_ACCEPTANCE_PREFLIGHT_FAILED");
    for (const issue of issues) console.error(issue);
    process.exit(1);
  }

  const participatingFamilies = parsed.data.sources
    .filter((source) => source.participating)
    .map((source) => source.family)
    .sort();
  const inventoriedFamilies = [...new Set(parsed.data.sources.map((source) => source.family))].sort();
  console.log("FRONT_PROFIT_ACCEPTANCE_PREFLIGHT_OK");
  console.log(`manifest=${path.relative(REPO_ROOT, manifestPath).replaceAll(path.sep, "/")}`);
  console.log(`mode=${parsed.data.mode}`);
  console.log(`periods=${parsed.data.authorization.allowedPeriods.join(",")}`);
  console.log(`inventoriedFamilies=${inventoriedFamilies.join(",")}`);
  console.log(`participatingFamilies=${participatingFamilies.join(",")}`);
  if (checkFiles) console.log(`checkedFiles=${checkedFiles}`);
  if (allowSynthetic) console.log("syntheticRehearsal=allowed");
}

main().catch((error) => {
  console.error("FRONT_PROFIT_ACCEPTANCE_PREFLIGHT_FAILED");
  console.error(`- ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
