import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const apiRoot = resolve(repoRoot, "apps/api");
const scriptPath = resolve(apiRoot, "scripts/front-profit-acceptance-preflight.ts");
const resultScriptPath = resolve(apiRoot, "scripts/front-profit-acceptance-result.ts");
const readinessScriptPath = resolve(apiRoot, "scripts/front-profit-acceptance-readiness.ts");
const readinessSmokeScriptPath = resolve(apiRoot, "scripts/front-profit-acceptance-readiness-smoke.ts");
const exampleManifestPath = resolve(repoRoot, "docs/front-profit-acceptance-manifest.example.json");
const exampleResultPath = resolve(repoRoot, "docs/front-profit-acceptance-result.example.json");
const acceptanceRoot = join(repoRoot, "front-profit-acceptance");
const createdPaths: string[] = [];
const allFamiliesOutput = "cost_period,cost_usage,fee_fact,manual_baseline,operator_assignment,promotion_spend,rebate,sales_fact";

type AcceptanceManifest = {
  mode: "template" | "authorized";
  authorization: {
    authorized: boolean;
    authorizer: string;
    executor: string;
    isolationEnvironment: string;
  };
  sources: Array<{
    family: string;
    participating: boolean;
    alias: string;
    rowCount: number;
    sourceSystem: string;
    sensitiveFields: string[];
    dateField?: string;
    dateRange?: { from: string; to: string };
    sanitizedPath?: string;
    nonParticipationReason?: string;
    fieldMappings?: Array<{
      sourceHeader: string;
      contractField: string;
      sanitization: "none" | "drop" | "mask" | "stable_hash" | "bucket" | "synthetic_replace";
      owner: string;
      required: boolean;
      exceptionPolicy: string;
    }>;
  }>;
};

type AcceptanceResultManifest = {
  mode: "template" | "dry_run";
  sourceManifest: {
    path: string;
    periods: string[];
    preflightPassed: boolean;
    checkFilesPassed: boolean;
    readinessPassed: boolean;
  };
  dryRun: {
    executor: string;
    isolationEnvironment: string;
    migrationPassed: boolean;
    apiSmokePassed: boolean;
    repoCheckPassed: boolean;
  };
  runs: Array<{
    period: string;
    rowCounts: {
      l4Rows: number;
      manualBaselineRows: number;
      publishedRows: number;
    };
    dq: {
      unresolvedBlockCount: number;
      warningCount: number;
      quarantinedRowCount: number;
      explainedWarningCodes: string[];
    };
    recon: {
      manualBaselineCompared: boolean;
      aggregationKeyCoverage: number;
      failedCount: number;
      diffRowCount: number;
      maxMoneyDiff: number;
    };
    publish: {
      authorityChangedByAdmin: boolean;
      publishVersionId: number;
      publishedRowCount: number;
      idempotencyKey: string;
      retryReturnedVersionId: number;
      retryCreatedNewVersion: boolean;
    };
    rollback: {
      rehearsed: boolean;
      rolledBackVersionId: number;
      restoredVersionId: number;
      restoredRowCount: number;
      retryIdempotent: boolean;
    };
  }>;
  evidenceArtifacts: Array<{
    kind: string;
    path: string;
    containsSampleRows: boolean;
    containsCredentials: boolean;
  }>;
  cleanup: {
    temporaryDbRemoved: boolean;
    temporaryUploadsRemoved: boolean;
    temporaryExportsRemoved: boolean;
    localCredentialsRemoved: boolean;
    retainedEvidenceOnly: boolean;
  };
  acceptance: {
    decision: "pending" | "pass" | "fail";
    acceptedBy: string;
    acceptedAt: string;
    productionReleaseAuthorized: boolean;
    notes?: string;
  };
  confirmations: {
    noSampleRowsInManifest: boolean;
    noCredentialsInManifest: boolean;
    noProductionDbTouched: boolean;
    noCiDependency: boolean;
  };
};

const runPreflight = (args: string[]) => spawnSync(
  process.execPath,
  ["./node_modules/tsx/dist/cli.mjs", scriptPath, ...args],
  { cwd: apiRoot, encoding: "utf8" },
);

const runResultCheck = (args: string[]) => spawnSync(
  process.execPath,
  ["./node_modules/tsx/dist/cli.mjs", resultScriptPath, ...args],
  { cwd: apiRoot, encoding: "utf8" },
);

const runReadiness = (args: string[]) => spawnSync(
  process.execPath,
  ["./node_modules/tsx/dist/cli.mjs", readinessScriptPath, ...args],
  { cwd: apiRoot, encoding: "utf8" },
);

const runReadinessSmoke = () => spawnSync(
  process.execPath,
  ["./node_modules/tsx/dist/cli.mjs", readinessSmokeScriptPath],
  { cwd: apiRoot, encoding: "utf8" },
);

const makeNonParticipating = (source: AcceptanceManifest["sources"][number]) => {
  source.participating = false;
  source.rowCount = 0;
  source.sourceSystem = "not_provided";
  source.sensitiveFields = [];
  source.nonParticipationReason = "not included in this authorized dry run";
  delete source.dateField;
  delete source.dateRange;
  delete source.sanitizedPath;
  delete source.fieldMappings;
};

const ignoredRelativeDir = (name: string) => `front-profit-acceptance/vitest-${process.pid}-${name}`;

const trackedTempPath = (name: string) => {
  const target = join(apiRoot, `front-profit-preflight-${process.pid}-${name}.json`);
  createdPaths.push(target);
  return target;
};

const ignoredTempPath = (name: string) => {
  const target = join(repoRoot, ignoredRelativeDir(name), "manifest.json");
  createdPaths.push(join(repoRoot, ignoredRelativeDir(name)));
  mkdirSync(resolve(target, ".."), { recursive: true });
  return target;
};

const writeResultEvidenceFiles = (relativeDir: string) => {
  const absoluteDir = join(repoRoot, relativeDir);
  mkdirSync(absoluteDir, { recursive: true });
  if (!createdPaths.includes(absoluteDir)) createdPaths.push(absoluteDir);
  for (const name of [
    "dq-summary.json",
    "recon-summary.json",
    "diff-summary.json",
    "publish-summary.json",
    "rollback-summary.json",
  ]) {
    writeFileSync(
      join(absoluteDir, name),
      `${JSON.stringify({
        artifact: name,
        containsSampleRows: false,
        containsCredentials: false,
      }, null, 2)}\n`,
      "utf8",
    );
  }
};

const csvCell = (value: string) => /[",\r\n]/.test(value)
  ? `"${value.replaceAll("\"", "\"\"")}"`
  : value;

const writeCsvFilesForManifest = (
  manifest: AcceptanceManifest,
  fixtureName: string,
  options: {
    omit?: { family: string; header: string };
    rowsForFamily?: Record<string, number>;
  } = {},
) => {
  const relativeDir = ignoredRelativeDir(fixtureName);
  const absoluteDir = join(repoRoot, relativeDir);
  mkdirSync(absoluteDir, { recursive: true });
  if (!createdPaths.includes(absoluteDir)) createdPaths.push(absoluteDir);

  for (const source of manifest.sources) {
    if (!source.participating) continue;
    source.rowCount = 2;
    source.sanitizedPath = `${relativeDir}/${source.family}.csv`;
    const headers = [...new Set([
      source.dateField!,
      ...(source.fieldMappings ?? []).map((mapping) => mapping.sourceHeader),
    ])].filter((header) => !(options.omit?.family === source.family && options.omit.header === header));
    const rowCount = options.rowsForFamily?.[source.family] ?? source.rowCount;
    const rows = Array.from({ length: rowCount }, (_, index) =>
      headers.map((header) => `${source.family}-${header}-${index + 1}`),
    );
    const csv = [
      headers.map(csvCell).join(","),
      ...rows.map((row) => row.map(csvCell).join(",")),
    ].join("\n") + "\n";
    writeFileSync(join(repoRoot, source.sanitizedPath), csv, "utf8");
  }
};

const authorizedManifest = (): AcceptanceManifest => {
  const manifest = JSON.parse(readFileSync(exampleManifestPath, "utf8")) as AcceptanceManifest;
  manifest.mode = "authorized";
  manifest.authorization.authorized = true;
  manifest.authorization.authorizer = "Data Owner";
  manifest.authorization.executor = "Codex";
  manifest.authorization.isolationEnvironment = "isolated dry-run database";

  for (const source of manifest.sources) {
    source.sourceSystem = "sanitized fixture";
    source.sanitizedPath = `front-profit-acceptance/${source.family}-${process.pid}.csv`;
    source.fieldMappings = source.sensitiveFields.length > 0
      ? source.sensitiveFields.map((field) => ({
        sourceHeader: field,
        contractField: `${source.family}.${field}`,
        sanitization: "stable_hash",
        owner: "Data Owner",
        required: true,
        exceptionPolicy: "BLOCK when missing",
      }))
      : [{
        sourceHeader: `${source.family}_id`,
        contractField: `${source.family}.id`,
        sanitization: "none",
        owner: "Data Owner",
        required: true,
        exceptionPolicy: "BLOCK when missing",
      }];
  }
  return manifest;
};

const acceptedResultManifest = (name: string): AcceptanceResultManifest => {
  const result = JSON.parse(readFileSync(exampleResultPath, "utf8")) as AcceptanceResultManifest;
  const relativeDir = ignoredRelativeDir(name);
  result.mode = "dry_run";
  result.sourceManifest.path = `${relativeDir}/manifest.json`;
  result.sourceManifest.preflightPassed = true;
  result.sourceManifest.checkFilesPassed = true;
  result.sourceManifest.readinessPassed = true;
  result.dryRun.executor = "Codex";
  result.dryRun.isolationEnvironment = "isolated dry-run database";
  result.dryRun.migrationPassed = true;
  result.dryRun.apiSmokePassed = true;
  result.dryRun.repoCheckPassed = true;
  result.runs[0]!.dq.warningCount = 1;
  result.runs[0]!.dq.explainedWarningCodes = ["PROMOTION_ORPHAN_ALLOWED"];
  result.runs[0]!.publish.idempotencyKey = "front-profit:2026-08:run:101";
  result.evidenceArtifacts = [
    { kind: "dq_summary", path: `${relativeDir}/dq-summary.json`, containsSampleRows: false, containsCredentials: false },
    { kind: "recon_summary", path: `${relativeDir}/recon-summary.json`, containsSampleRows: false, containsCredentials: false },
    { kind: "diff_summary", path: `${relativeDir}/diff-summary.json`, containsSampleRows: false, containsCredentials: false },
    { kind: "publish_smoke", path: `${relativeDir}/publish-summary.json`, containsSampleRows: false, containsCredentials: false },
    { kind: "rollback_smoke", path: `${relativeDir}/rollback-summary.json`, containsSampleRows: false, containsCredentials: false },
  ];
  writeResultEvidenceFiles(relativeDir);
  result.cleanup.temporaryDbRemoved = true;
  result.cleanup.temporaryUploadsRemoved = true;
  result.cleanup.temporaryExportsRemoved = true;
  result.cleanup.localCredentialsRemoved = true;
  result.cleanup.retainedEvidenceOnly = true;
  result.acceptance.decision = "pass";
  result.acceptance.acceptedBy = "Data Owner";
  result.acceptance.notes = "accepted isolated dry run";
  return result;
};

const writeManifest = (filePath: string, manifest: unknown) => {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
};

afterEach(() => {
  for (const target of createdPaths.splice(0)) {
    rmSync(target, { force: true, recursive: true });
  }
});

describe("front-profit real-sample acceptance preflight", () => {
  test("allows the checked-in example only when template mode is explicit", () => {
    const result = runPreflight(["--template-ok"]);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("FRONT_PROFIT_ACCEPTANCE_PREFLIGHT_OK");
    expect(result.stdout).toContain("mode=template");
    expect(result.stdout).toContain(`inventoriedFamilies=${allFamiliesOutput}`);
  });

  test("fails closed for the checked-in template without template mode", () => {
    const result = runPreflight(["--manifest", "docs/front-profit-acceptance-manifest.example.json"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FRONT_PROFIT_ACCEPTANCE_PREFLIGHT_FAILED");
    expect(result.stderr).toContain("manifest is in template mode");
  });

  test("accepts an authorized manifest only from a git-ignored repo path", () => {
    const manifestPath = ignoredTempPath("authorized");
    writeManifest(manifestPath, authorizedManifest());

    const result = runPreflight(["--manifest", "front-profit-acceptance/vitest-" + process.pid + "-authorized/manifest.json"]);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("mode=authorized");
    expect(result.stdout).toContain(`inventoriedFamilies=${allFamiliesOutput}`);
    expect(result.stdout).toContain(`participatingFamilies=${allFamiliesOutput}`);
  });

  test("rejects synthetic manifest placeholders unless explicitly allowed for smoke rehearsal", () => {
    const manifest = authorizedManifest();
    manifest.authorization.authorizer = "synthetic-data-owner";
    manifest.authorization.executor = "synthetic-codex";
    manifest.authorization.isolationEnvironment = "synthetic-isolated-db";
    const manifestPath = ignoredTempPath("synthetic-guard");
    writeManifest(manifestPath, manifest);
    const relativePath = "front-profit-acceptance/vitest-" + process.pid + "-synthetic-guard/manifest.json";

    const blocked = runPreflight(["--manifest", relativePath]);
    const allowed = runPreflight(["--manifest", relativePath, "--allow-synthetic"]);

    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("contains synthetic/placeholder markers");
    expect(allowed.status, `${allowed.stdout}${allowed.stderr}`).toBe(0);
    expect(allowed.stdout).toContain("FRONT_PROFIT_ACCEPTANCE_PREFLIGHT_OK");
    expect(allowed.stdout).toContain("syntheticRehearsal=allowed");
  });

  test("allows an inventoried non-participating source only when the reason is explicit", () => {
    const manifest = authorizedManifest();
    const promotion = manifest.sources.find((source) => source.family === "promotion_spend");
    expect(promotion).toBeDefined();
    makeNonParticipating(promotion!);
    const manifestPath = ignoredTempPath("non-participating");
    writeManifest(manifestPath, manifest);

    const result = runPreflight(["--manifest", "front-profit-acceptance/vitest-" + process.pid + "-non-participating/manifest.json"]);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`inventoriedFamilies=${allFamiliesOutput}`);
    expect(result.stdout).toContain("participatingFamilies=cost_period,cost_usage,fee_fact,manual_baseline,operator_assignment,rebate,sales_fact");
  });

  test("checks authorized sanitized CSV headers and row counts when requested", () => {
    const manifest = authorizedManifest();
    writeCsvFilesForManifest(manifest, "check-files-ok");
    const manifestPath = ignoredTempPath("check-files-ok");
    writeManifest(manifestPath, manifest);

    const result = runPreflight(["--manifest", "front-profit-acceptance/vitest-" + process.pid + "-check-files-ok/manifest.json", "--check-files"]);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("checkedFiles=8");
    expect(result.stdout).not.toContain("sales_fact-order_id-1");
  });

  test("passes the readiness wrapper when file evidence and repository boundary are clean", () => {
    const manifest = authorizedManifest();
    writeCsvFilesForManifest(manifest, "readiness-ok");
    const manifestPath = ignoredTempPath("readiness-ok");
    writeManifest(manifestPath, manifest);

    const result = runReadiness(["--manifest", "front-profit-acceptance/vitest-" + process.pid + "-readiness-ok/manifest.json"]);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("FRONT_PROFIT_ACCEPTANCE_READINESS_OK");
    expect(result.stdout).toContain("gates=preflight_check_files,repo_check");
    expect(result.stdout).not.toContain("sales_fact-order_id-1");
  });

  test("runs the synthetic readiness smoke and cleans generated files", () => {
    const result = runReadinessSmoke();

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("FRONT_PROFIT_ACCEPTANCE_READINESS_SMOKE_OK");
    expect(result.stdout).toContain("families=8");
    expect(result.stdout).toContain("syntheticRehearsal=allowed");
    expect(result.stdout).not.toContain("sales_fact-sale_key-1");
    if (existsSync(acceptanceRoot)) {
      expect(readdirSync(acceptanceRoot).filter((entry) => entry.startsWith("readiness-smoke-"))).toEqual([]);
    }
  });

  test("allows the checked-in result manifest example only when template mode is explicit", () => {
    const result = runResultCheck(["--template-ok"]);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("FRONT_PROFIT_ACCEPTANCE_RESULT_OK");
    expect(result.stdout).toContain("mode=template");
  });

  test("fails closed for the checked-in result manifest example without template mode", () => {
    const result = runResultCheck(["--result", "docs/front-profit-acceptance-result.example.json"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FRONT_PROFIT_ACCEPTANCE_RESULT_FAILED");
    expect(result.stderr).toContain("result manifest is in template mode");
  });

  test("accepts a passing dry-run result manifest only from a git-ignored repo path", () => {
    const resultManifest = acceptedResultManifest("result-ok");
    const resultPath = ignoredTempPath("result-ok");
    writeManifest(resultPath, resultManifest);

    const result = runResultCheck(["--result", "front-profit-acceptance/vitest-" + process.pid + "-result-ok/manifest.json"]);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("FRONT_PROFIT_ACCEPTANCE_RESULT_OK");
    expect(result.stdout).toContain("mode=dry_run");
    expect(result.stdout).toContain("periods=2026-08");
    expect(result.stdout).toContain("publishedVersions=201");
  });

  test("rejects synthetic result placeholders unless explicitly allowed for smoke rehearsal", () => {
    const resultManifest = acceptedResultManifest("result-synthetic-guard");
    resultManifest.dryRun.executor = "synthetic-result-executor";
    resultManifest.dryRun.isolationEnvironment = "synthetic-result-db";
    resultManifest.acceptance.acceptedBy = "synthetic-reviewer";
    const resultPath = ignoredTempPath("result-synthetic-guard");
    writeManifest(resultPath, resultManifest);
    const relativePath = "front-profit-acceptance/vitest-" + process.pid + "-result-synthetic-guard/manifest.json";

    const blocked = runResultCheck(["--result", relativePath]);
    const allowed = runResultCheck(["--result", relativePath, "--allow-synthetic"]);

    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("contains synthetic/placeholder markers");
    expect(allowed.status, `${allowed.stdout}${allowed.stderr}`).toBe(0);
    expect(allowed.stdout).toContain("FRONT_PROFIT_ACCEPTANCE_RESULT_OK");
    expect(allowed.stdout).toContain("syntheticRehearsal=allowed");
  });

  test("rejects a dry-run result manifest inside the repo when it is not git-ignored", () => {
    const resultPath = trackedTempPath("result-tracked");
    writeManifest(resultPath, acceptedResultManifest("result-tracked"));

    const result = runResultCheck(["--result", resultPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("result manifest is inside the repo but is not git-ignored");
  }, 15000);

  test("rejects dry-run result gates that would make production discussion unsafe", () => {
    const resultManifest = acceptedResultManifest("result-gates");
    resultManifest.runs[0]!.dq.unresolvedBlockCount = 1;
    resultManifest.runs[0]!.recon.maxMoneyDiff = 0.02;
    resultManifest.runs[0]!.publish.retryCreatedNewVersion = true;
    resultManifest.runs[0]!.rollback.rolledBackVersionId = 999;
    resultManifest.cleanup.temporaryDbRemoved = false;
    const resultPath = ignoredTempPath("result-gates");
    writeManifest(resultPath, resultManifest);

    const result = runResultCheck(["--result", "front-profit-acceptance/vitest-" + process.pid + "-result-gates/manifest.json"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("period 2026-08 unresolved BLOCK count must be 0");
    expect(result.stderr).toContain("period 2026-08 maxMoneyDiff must be <= 0.01");
    expect(result.stderr).toContain("period 2026-08 publish retry must not create a new version");
    expect(result.stderr).toContain("period 2026-08 rollback.rolledBackVersionId must equal publish.publishVersionId");
    expect(result.stderr).toContain("temporary dry-run DB must be removed");
  });

  test("rejects result evidence that points at sample-like artifacts", () => {
    const resultManifest = acceptedResultManifest("result-artifact-leak");
    resultManifest.evidenceArtifacts[0]!.containsSampleRows = true;
    resultManifest.evidenceArtifacts[1]!.path = "apps/api/recon-leak.csv";
    const resultPath = ignoredTempPath("result-artifact-leak");
    writeManifest(resultPath, resultManifest);

    const result = runResultCheck(["--result", "front-profit-acceptance/vitest-" + process.pid + "-result-artifact-leak/manifest.json"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("evidenceArtifacts[0] must not contain sample rows");
    expect(result.stderr).toContain("evidenceArtifacts[1].path must not point at raw or tabular sample data");
    expect(result.stderr).toContain("evidenceArtifacts[1].path is inside the repo but is not git-ignored");
  });

  test("rejects file checks for the checked-in template manifest", () => {
    const result = runPreflight(["--template-ok", "--check-files"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--check-files can only be used with an authorized manifest");
  });

  test("fails the readiness wrapper before repo check when file evidence is missing", () => {
    const manifest = authorizedManifest();
    const manifestPath = ignoredTempPath("readiness-missing-file");
    writeManifest(manifestPath, manifest);

    const result = runReadiness(["--manifest", "front-profit-acceptance/vitest-" + process.pid + "-readiness-missing-file/manifest.json"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FRONT_PROFIT_ACCEPTANCE_READINESS_FAILED");
    expect(result.stderr).toContain("gate=preflight_check_files");
    expect(result.stderr).toContain("sanitizedPath not found for --check-files");
  });

  test("rejects an authorized manifest inside the repo when it is not git-ignored", () => {
    const manifestPath = trackedTempPath("tracked");
    writeManifest(manifestPath, authorizedManifest());

    const result = runPreflight(["--manifest", manifestPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("manifest file is inside the repo but is not git-ignored");
  });

  test("rejects an authorized manifest that does not inventory every source family", () => {
    const manifest = authorizedManifest();
    manifest.sources = manifest.sources.filter((source) => source.family !== "fee_fact");
    const manifestPath = ignoredTempPath("missing-family");
    writeManifest(manifestPath, manifest);

    const result = runPreflight(["--manifest", "front-profit-acceptance/vitest-" + process.pid + "-missing-family/manifest.json"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("manifest must inventory every source family; missing: fee_fact");
  });

  test("rejects a non-participating source without a reason", () => {
    const manifest = authorizedManifest();
    const promotion = manifest.sources.find((source) => source.family === "promotion_spend");
    expect(promotion).toBeDefined();
    makeNonParticipating(promotion!);
    delete promotion!.nonParticipationReason;
    const manifestPath = ignoredTempPath("missing-non-participation-reason");
    writeManifest(manifestPath, manifest);

    const result = runPreflight(["--manifest", "front-profit-acceptance/vitest-" + process.pid + "-missing-non-participation-reason/manifest.json"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("nonParticipationReason");
  });

  test("rejects a participating CSV missing a declared header", () => {
    const manifest = authorizedManifest();
    writeCsvFilesForManifest(manifest, "missing-header", {
      omit: { family: "sales_fact", header: "order_id" },
    });
    const manifestPath = ignoredTempPath("missing-header");
    writeManifest(manifestPath, manifest);

    const result = runPreflight(["--manifest", "front-profit-acceptance/vitest-" + process.pid + "-missing-header/manifest.json", "--check-files"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("sales_fact:sales-fact-sample missing required CSV headers: order_id");
  });

  test("rejects a participating CSV whose row count differs from the manifest", () => {
    const manifest = authorizedManifest();
    writeCsvFilesForManifest(manifest, "row-count-mismatch", {
      rowsForFamily: { manual_baseline: 1 },
    });
    const manifestPath = ignoredTempPath("row-count-mismatch");
    writeManifest(manifestPath, manifest);

    const result = runPreflight(["--manifest", "front-profit-acceptance/vitest-" + process.pid + "-row-count-mismatch/manifest.json", "--check-files"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("manual_baseline:manual-01-baseline rowCount mismatch: manifest=2, csv=1");
  });

  test("rejects sensitive source headers that are mapped without sanitization", () => {
    const manifest = authorizedManifest();
    const sales = manifest.sources.find((source) => source.family === "sales_fact");
    expect(sales).toBeDefined();
    sales!.fieldMappings![0]!.sanitization = "none";
    const manifestPath = ignoredTempPath("sensitive-none");
    writeManifest(manifestPath, manifest);

    const result = runPreflight(["--manifest", "front-profit-acceptance/vitest-" + process.pid + "-sensitive-none/manifest.json"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("maps sensitive headers without sanitization");
  });
});
