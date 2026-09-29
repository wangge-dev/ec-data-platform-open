import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import * as XLSX from "xlsx";
import { validateFrontProfitStandardSheet } from "../src/services/front-profit-standard.js";

const root = resolve(import.meta.dirname, "../../..");
const verifierPath = resolve(root, "scripts/verify-release.ps1");
const verifier = readFileSync(verifierPath, "utf8");
const windowsTest = process.platform === "win32" ? test : test.skip;

describe("release verifier front-profit acceptance", () => {
  test("requires an explicit safe working root and exposes preservation controls", () => {
    expect(verifier).toContain("[string]$WorkingRoot");
    expect(verifier).toContain("function Resolve-SafeWorkingRoot");
    expect(verifier).toContain("WorkingRoot cannot be a filesystem root");
    expect(verifier).not.toContain("[IO.Path]::GetTempPath()");
    expect(verifier).toContain("[switch]$PreserveEvidence");
    expect(verifier).toContain("[switch]$UsePublicTestCredentials");
    expect(verifier).toContain(
      "PreserveEvidence requires UsePublicTestCredentials",
    );

    const cleanup = verifier.slice(verifier.lastIndexOf("finally {"));
    expect(cleanup).toContain("if ($PreserveEvidence)");
    expect(cleanup.indexOf("if ($PreserveEvidence)")).toBeLessThan(
      cleanup.indexOf("Invoke-IsolatedDown"),
    );
    expect(cleanup).toContain(
      "PreserveEvidence skipped Compose, volume, image-tag, and extracted-file cleanup.",
    );
    expect(cleanup).toContain("Evidence root preserved:");
    expect(cleanup).toContain("Compose project evidence preserved:");
    expect(verifier).toContain(
      "Invoke-IsolatedDown is disabled while PreserveEvidence is active.",
    );
    expect(verifier).toContain(
      "Restore-ImageTags is disabled while PreserveEvidence is active.",
    );
  });

  test("verifies the packaged template and recreates a user module through public APIs", () => {
    expect(verifier).toContain("function Get-FrontProfitTemplateBundle");
    expect(verifier).toContain("containsRealBusinessData=false");
    expect(verifier).toContain("(Get-Sha256Hex $filePath).ToUpperInvariant()");
    expect(verifier).toContain("self-service-single-table-upload");
    expect(verifier).toContain("$ExpectedFrontProfitColumnCount = 28");
    expect(verifier).toContain("/api/files/upload");
    expect(verifier).toContain(
      "Get-Command 'curl.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1",
    );
    expect(verifier).toContain(
      "Get-Command 'curl' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1",
    );
    expect(verifier).toContain("--form-string");
    expect(verifier).toContain("--output', $responsePath");
    expect(verifier).not.toContain("MultipartFormDataContent");
    expect(verifier).toContain("$upload.data.frontProfitValidation");
    expect(verifier).toContain("front-profit-standard/v1");
    expect(verifier).toContain("$frontProfitValidation.PSObject.Properties[$propertyName]");
    expect(verifier).toContain("$frontProfitValidation.warningCodes -isnot [array]");
    expect(verifier).toContain("$frontProfitValidation.businessRowCount -ne 1");
    expect(verifier).toContain("$frontProfitValidation.warningCount -ne 0");
    expect(verifier).toContain("@($frontProfitValidation.warningCodes).Count -ne 0");
    expect(verifier).toContain("function Invoke-Utf8JsonApi");
    expect(verifier).toContain("ReadAsByteArrayAsync");
    expect(verifier).toContain("$script:StrictUtf8.GetString($bytes)");
    expect(verifier).toContain("/api/modules/inspect-sources");
    expect(verifier).toContain("-Uri \"$apiBase/api/modules\"");
    expect(verifier).toContain("$_.origin -eq 'user'");
    expect(verifier).toContain("$_.status -ne 'success'");
    expect(verifier).toContain("$createdModule.data.columns");
    expect(verifier).not.toMatch(/modules[\\/]front_profit\.json/);
  });

  test("keeps the generated release acceptance CSV synthetic and formula-consistent", () => {
    const match = verifier.match(/\$csvBase64 = '([A-Za-z0-9+/=]+)'/);
    expect(match?.[1]).toBeDefined();
    const csv = Buffer.from(match![1], "base64").toString("utf8");
    expect(csv).toContain("RELEASE_SYNTHETIC_20991231");
    const workbook = XLSX.read(csv, { type: "string", cellDates: true });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[workbook.SheetNames[0]!], {
      header: 1,
      defval: null,
    });
    const result = validateFrontProfitStandardSheet(rows[0]!, rows.slice(1));
    expect(result.businessRowCount).toBe(1);
    expect(result.warnings).toHaveLength(0);
  });

  test("keeps the Windows PowerShell verifier source ASCII-safe", () => {
    expect(Buffer.from(verifier, "utf8").every((byte) => byte < 0x80)).toBe(
      true,
    );
    expect(verifier).toContain("$script:StrictUtf8.GetString");
  });

  windowsTest("parses under Windows PowerShell 5.1", () => {
    const escapedPath = verifierPath.replaceAll("'", "''");
    const probe = `
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile('${escapedPath}', [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
Write-Output 'VERIFY_RELEASE_PS51_PARSE_OK'
`;
    const encoded = Buffer.from(probe, "utf16le").toString("base64");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-EncodedCommand", encoded],
      { encoding: "utf8" },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("VERIFY_RELEASE_PS51_PARSE_OK");
  });
});
