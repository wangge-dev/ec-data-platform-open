import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const windowsTest = process.platform === "win32" ? test : test.skip;
const powerShellExecutable = process.platform === "win32" ? "powershell.exe" : "pwsh";
const requiredImages = ["postgres:16", "redis:7-alpine", "deploy-api:latest", "deploy-web:latest"];
const imageIds = Object.fromEntries(
  requiredImages.map((image, index) => [image, `sha256:${String(index + 1).repeat(64)}`]),
);

const releaseFileRecord = (releaseRoot: string, relative: string) => {
  const bytes = readFileSync(join(releaseRoot, relative));
  return {
    path: relative.replaceAll("\\", "/"),
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};

const listFiles = (directory: string, prefix = ""): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(join(directory, entry.name), relative) : [relative];
  });

const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;

const powerShellArgs = (script: string) => [
  "-NoProfile",
  ...(process.platform === "win32" ? ["-ExecutionPolicy", "Bypass"] : []),
  "-Command",
  script,
];

const normalizePowerShellOutput = (value: string) =>
  value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\|\s?/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

const ensureZipRuntime = `
Add-Type -AssemblyName System.IO.Compression -ErrorAction Stop
if ($null -eq ('System.IO.Compression.ZipFile' -as [type])) {
  foreach ($assemblyName in @('System.IO.Compression.FileSystem', 'System.IO.Compression.ZipFileSystem')) {
    try { Add-Type -AssemblyName $assemblyName -ErrorAction Stop } catch { continue }
    if ($null -ne ('System.IO.Compression.ZipFile' -as [type])) { break }
  }
}
if ($null -eq ('System.IO.Compression.ZipFile' -as [type])) { throw 'ZIP runtime unavailable in test.' }
`;

const createSyntheticZip = (
  archivePath: string,
  entries: Array<{ Name: string; Value: string; ExternalAttributes?: number }>,
) => {
  const encodedEntries = Buffer.from(JSON.stringify(entries), "utf8").toString("base64");
  const created = spawnSync(
    powerShellExecutable,
    powerShellArgs(`${ensureZipRuntime}
$decodedItems = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedEntries}')) | ConvertFrom-Json
$items = @($decodedItems)
$fileStream = [IO.File]::Open(${psQuote(archivePath)}, [IO.FileMode]::CreateNew)
$archive = [IO.Compression.ZipArchive]::new($fileStream, [IO.Compression.ZipArchiveMode]::Create, $false)
try {
  foreach ($item in $items) {
    $entry = $archive.CreateEntry([string]$item.Name)
    if ($null -ne $item.PSObject.Properties['ExternalAttributes']) {
      $entry.ExternalAttributes = [int]$item.ExternalAttributes
    }
    $writer = [IO.StreamWriter]::new($entry.Open())
    try { $writer.Write([string]$item.Value) } finally { $writer.Dispose() }
  }
}
finally { $archive.Dispose(); $fileStream.Dispose() }`),
    { encoding: "utf8" },
  );
  expect(created.status, `${created.stdout ?? ""}${created.stderr ?? ""}`).toBe(0);
};

const prepareReleaseArchive = (sandbox: string, includeImageArchive = true) => {
  const sourceRoot = join(sandbox, "source");
  const releaseRoot = join(sourceRoot, "ec-data-platform-20990102");
  const deployRoot = join(releaseRoot, "deploy");
  mkdirSync(deployRoot, { recursive: true });
  writeFileSync(join(deployRoot, ".env.example"), "PUBLIC_SYNTHETIC_SETTING=example\n", "utf8");
  writeFileSync(join(deployRoot, "docker-compose.yml"), "services: {}\n", "utf8");
  if (includeImageArchive) {
    writeFileSync(join(releaseRoot, "ec-data-images.tar"), "synthetic image archive", "utf8");
  }
  writeFileSync(
    join(releaseRoot, "release-image-ids.txt"),
    requiredImages.map((image) => `${image}=${imageIds[image]}`).join("\n") + "\n",
    "utf8",
  );
  mkdirSync(join(releaseRoot, "templates"), { recursive: true });
  cpSync(
    resolve(root, "templates/front-profit"),
    join(releaseRoot, "templates/front-profit"),
    { recursive: true },
  );

  const files = listFiles(releaseRoot)
    .filter((path) => path !== "release-manifest.json")
    .map((path) => releaseFileRecord(releaseRoot, path))
    .sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
  const manifest = {
    name: basename(releaseRoot),
    createdAt: "2099-01-02T00:00:00.000Z",
    sourceRevision: "a".repeat(40),
    imageSource: "local-build",
    images: requiredImages,
    imageIds,
    files,
  };
  writeFileSync(
    join(releaseRoot, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  const archivePath = join(sandbox, "release.zip");
  const compressed = spawnSync(
    powerShellExecutable,
    powerShellArgs(`${ensureZipRuntime}
$sourceRoot = [IO.Path]::GetFullPath(${psQuote(sourceRoot)})
$fileStream = [IO.File]::Open(${psQuote(archivePath)}, [IO.FileMode]::CreateNew)
$archive = [IO.Compression.ZipArchive]::new($fileStream, [IO.Compression.ZipArchiveMode]::Create, $false)
try {
  foreach ($sourceFile in @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File -Force | Sort-Object FullName)) {
    $relativePath = $sourceFile.FullName.Substring($sourceRoot.Length).TrimStart([char[]]@('\\', '/')).Replace('\\', '/')
    $entry = $archive.CreateEntry($relativePath, [IO.Compression.CompressionLevel]::Optimal)
    $sourceStream = [IO.File]::OpenRead($sourceFile.FullName)
    $entryStream = $entry.Open()
    try { $sourceStream.CopyTo($entryStream) }
    finally { $entryStream.Dispose(); $sourceStream.Dispose() }
  }
}
finally { $archive.Dispose(); $fileStream.Dispose() }`),
    { encoding: "utf8" },
  );
  expect(compressed.status, `${compressed.stdout ?? ""}${compressed.stderr ?? ""}`).toBe(0);
  return archivePath;
};

describe("isolated release verifier supply-chain gate", () => {
  test("preserves manifest-listed dotfiles with the cross-platform safe ZIP extractor", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ec-release-dotfile-"));
    try {
      const archivePath = prepareReleaseArchive(sandbox, false);
      const workingRoot = join(sandbox, "working");
      mkdirSync(workingRoot);
      const result = spawnSync(
        powerShellExecutable,
        [
          "-NoProfile",
          ...(process.platform === "win32" ? ["-ExecutionPolicy", "Bypass"] : []),
          "-File",
          resolve(root, "scripts/verify-release.ps1"),
          "-ArchivePath",
          archivePath,
          "-WorkingRoot",
          workingRoot,
          "-PreserveEvidence",
          "-UsePublicTestCredentials",
        ],
        { encoding: "utf8" },
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      const normalizedOutput = normalizePowerShellOutput(output);
      expect(result.status, output).not.toBe(0);
      expect(normalizedOutput).toContain("Offline image archive was not found:");
      expect(normalizedOutput).not.toContain("Could not find item");
      const preservedDotfile = listFiles(workingRoot).find((path) =>
        path.endsWith("/deploy/.env.example"),
      );
      expect(preservedDotfile).toBeDefined();
      expect(readFileSync(join(workingRoot, preservedDotfile!), "utf8")).toBe(
        "PUBLIC_SYNTHETIC_SETTING=example\n",
      );
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  }, 30_000);

  test("rejects ZIP traversal before writing any archive entry", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ec-release-zip-slip-"));
    try {
      const archivePath = join(sandbox, "malicious.zip");
      createSyntheticZip(archivePath, [
        { Name: "ec-data-platform-20990102/good.txt", Value: "must not be written" },
        { Name: "../escape.txt", Value: "must not escape" },
      ]);

      const workingRoot = join(sandbox, "working");
      mkdirSync(workingRoot);
      const result = spawnSync(
        powerShellExecutable,
        [
          "-NoProfile",
          ...(process.platform === "win32" ? ["-ExecutionPolicy", "Bypass"] : []),
          "-File",
          resolve(root, "scripts/verify-release.ps1"),
          "-ArchivePath",
          archivePath,
          "-WorkingRoot",
          workingRoot,
          "-PreserveEvidence",
          "-UsePublicTestCredentials",
        ],
        { encoding: "utf8" },
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      const normalizedOutput = normalizePowerShellOutput(output);
      expect(result.status, output).not.toBe(0);
      expect(normalizedOutput).toContain("unsafe or duplicate entry path: ../escape.txt");
      expect(listFiles(workingRoot)).toEqual([]);
      expect(existsSync(join(workingRoot, "escape.txt"))).toBe(false);
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  }, 30_000);

  test("rejects cross-platform path collisions, ADS, and Unix special files during preflight", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ec-release-zip-policy-"));
    const cases = [
      {
        name: "case-duplicate",
        entries: [
          { Name: "ec-data-platform-20990102/File.txt", Value: "first" },
          { Name: "ec-data-platform-20990102/file.txt", Value: "second" },
        ],
        expected: "unsafe or duplicate entry path",
      },
      {
        name: "prefix-conflict",
        entries: [
          { Name: "ec-data-platform-20990102/node", Value: "file" },
          { Name: "ec-data-platform-20990102/node/child.txt", Value: "child" },
        ],
        expected: "file/directory prefix conflict",
      },
      {
        name: "windows-ads",
        entries: [
          { Name: "ec-data-platform-20990102/deploy/config.txt:secret", Value: "ads" },
        ],
        expected: "Windows-incompatible entry path",
      },
      {
        name: "windows-superscript-device",
        entries: [
          { Name: "ec-data-platform-20990102/deploy/COM¹.txt", Value: "reserved device" },
        ],
        expected: "Windows-incompatible entry path",
      },
      {
        name: "unix-fifo",
        entries: [
          {
            Name: "ec-data-platform-20990102/fifo",
            Value: "fifo",
            ExternalAttributes: 0x11a40000,
          },
        ],
        expected: "unsupported Unix special-file entry",
      },
      {
        name: "multiple-roots",
        entries: [
          { Name: "ec-data-platform-20990102/file.txt", Value: "first root" },
          { Name: "second-root/file.txt", Value: "second root" },
        ],
        expected: "exactly one top-level directory",
      },
    ];
    try {
      for (const testCase of cases) {
        const caseRoot = join(sandbox, testCase.name);
        const workingRoot = join(caseRoot, "working");
        mkdirSync(workingRoot, { recursive: true });
        const archivePath = join(caseRoot, "malicious.zip");
        createSyntheticZip(archivePath, testCase.entries);
        const result = spawnSync(
          powerShellExecutable,
          [
            "-NoProfile",
            ...(process.platform === "win32" ? ["-ExecutionPolicy", "Bypass"] : []),
            "-File",
            resolve(root, "scripts/verify-release.ps1"),
            "-ArchivePath",
            archivePath,
            "-WorkingRoot",
            workingRoot,
            "-PreserveEvidence",
            "-UsePublicTestCredentials",
          ],
          { encoding: "utf8" },
        );
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        const normalizedOutput = normalizePowerShellOutput(output);
        expect(result.status, output).not.toBe(0);
        expect(normalizedOutput).toContain(testCase.expected);
        expect(listFiles(workingRoot), `${testCase.name} wrote archive bytes before rejection`).toEqual([]);
      }
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  }, 30_000);

  test("keeps explicit archive expansion budgets and actual-byte accounting", () => {
    expect(
      normalizePowerShellOutput(
        "Verification: Release archive contains an unsafe or duplicate entry\r\n     | path: ../escape.txt",
      ),
    ).toContain("unsafe or duplicate entry path: ../escape.txt");
    const verifier = readFileSync(resolve(root, "scripts/verify-release.ps1"), "utf8");
    expect(verifier).toContain("$maxEntryCount = 4096");
    expect(verifier).toContain("$maxArchiveBytes = [int64]4GB");
    expect(verifier).toContain("$maxEntryBytes = [int64]2GB");
    expect(verifier).toContain("$maxTotalBytes = [int64]4GB");
    expect(verifier).toContain("$maxCompressionRatio = 200.0");
    expect(verifier).toContain("$actualEntryBytes -ne [int64]$record.ExpectedLength");
    expect(verifier).toContain("Safe release extraction requires the .NET ZIP runtime:");
    expect(verifier).toContain("Safe release extraction requires System.IO.Compression.ZipFile");
    expect(verifier).not.toContain("Expand-Archive -LiteralPath $resolvedArchive");
  });

  windowsTest("creates preserved public-test env before Compose and blocks ID/service/build drift", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ec-release-verifier-"));
    const binRoot = join(sandbox, "bin");
    mkdirSync(binRoot);
    try {
      const archivePath = prepareReleaseArchive(sandbox);
      const fakeDockerJs = join(binRoot, "fake-docker.cjs");
      writeFileSync(fakeDockerJs, `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const envExists = fs.existsSync(path.join(process.cwd(), ".env"));
fs.appendFileSync(
  process.env.DOCKER_LOG,
  "ENV=" + (envExists ? "1" : "0") + " " + args.join(" ") + "\\n",
  "utf8",
);
const fail = (code, message) => { console.error(message); process.exit(code); };
if (args[0] === "version") process.exit(0);
if (args[0] === "load") {
  fs.writeFileSync(process.env.DOCKER_STATE, "loaded", "utf8");
  process.exit(0);
}
if (args[0] === "image" && args[1] === "inspect" && args[2] === "--format") {
  const ids = ${JSON.stringify(imageIds)};
  const image = args[4];
  if (!ids[image]) fail(11, "unknown image");
  if (fs.existsSync(process.env.DOCKER_STATE) &&
      process.env.ID_MISMATCH === "1" && image === "deploy-web:latest") {
    console.log("sha256:" + "f".repeat(64));
  } else {
    console.log(ids[image]);
  }
  process.exit(0);
}
if (args[0] === "compose") {
  if (args[1] !== "--env-file" || args[2] !== ".env" ||
      args[3] !== "-f" || args[4] !== "docker-compose.yml") {
    fail(12, "Compose did not use the explicit release env/file.");
  }
  const action = args[7];
  if (action === "config" && args[8] === "--quiet") process.exit(0);
  if (action === "config" && args[8] === "--services") {
    console.log(process.env.EXTRA_SERVICE === "1"
      ? "postgres\\nredis\\nmigrate\\napi\\nweb\\nevil"
      : "postgres\\nredis\\nmigrate\\napi\\nweb");
    process.exit(0);
  }
  if (action === "up") {
    if (!args.includes("--no-build")) fail(13, "Compose up omitted --no-build.");
    fail(77, "synthetic controlled up failure");
  }
}
fail(99, "unexpected Docker command: " + args.join(" "));
`, "utf8");
      writeFileSync(
        join(binRoot, "docker.cmd"),
        '@echo off\r\n"%FAKE_NODE_EXE%" "%FAKE_DOCKER_JS%" %*\r\nexit /b %ERRORLEVEL%\r\n',
        "utf8",
      );

      const run = (name: string, extraEnv: Record<string, string> = {}) => {
        const workingRoot = join(sandbox, `working-${name}`);
        const log = join(sandbox, `${name}.log`);
        const state = join(sandbox, `${name}.loaded`);
        mkdirSync(workingRoot);
        const result = spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            resolve(root, "scripts/verify-release.ps1"),
            "-ArchivePath",
            archivePath,
            "-WorkingRoot",
            workingRoot,
            "-PreserveEvidence",
            "-UsePublicTestCredentials",
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${binRoot};${process.env.PATH ?? ""}`,
              DOCKER_LOG: log,
              DOCKER_STATE: state,
              FAKE_NODE_EXE: process.execPath,
              FAKE_DOCKER_JS: fakeDockerJs,
              ...extraEnv,
            },
          },
        );
        return {
          result,
          workingRoot,
          calls: existsSync(log) ? readFileSync(log, "utf8") : "",
        };
      };

      const controlledFailure = run("controlled");
      const controlledOutput =
        `${controlledFailure.result.stdout ?? ""}${controlledFailure.result.stderr ?? ""}`;
      expect(controlledFailure.result.status, controlledOutput).not.toBe(0);
      expect(controlledOutput).toContain("synthetic controlled up failure");
      expect(controlledOutput).toContain("Evidence root preserved:");
      expect(controlledOutput).not.toContain("public-test-only-postgres-not-for-production");
      const controlledCompose = controlledFailure.calls
        .split(/\r?\n/)
        .filter((line) => line.includes(" compose "));
      expect(controlledCompose[0]).toContain("ENV=1");
      expect(controlledFailure.calls).toContain(
        "compose --env-file .env -f docker-compose.yml",
      );
      expect(controlledFailure.calls).toContain("up -d --no-build");
      expect(controlledFailure.calls).not.toContain(" build ");
      const [evidenceRoot] = readdirSync(controlledFailure.workingRoot).map(
        (name) => join(controlledFailure.workingRoot, name),
      );
      const [preservedRelease] = readdirSync(evidenceRoot).map((name) => join(evidenceRoot, name));
      expect(existsSync(join(preservedRelease, "deploy/.env"))).toBe(true);

      const mismatched = run("id-mismatch", { ID_MISMATCH: "1" });
      const mismatchOutput = `${mismatched.result.stdout ?? ""}${mismatched.result.stderr ?? ""}`;
      expect(mismatched.result.status, mismatchOutput).not.toBe(0);
      expect(mismatchOutput).toContain("Loaded image ID mismatch for deploy-web:latest");
      expect(mismatched.calls).not.toContain(" compose ");

      const extraService = run("extra-service", { EXTRA_SERVICE: "1" });
      const extraOutput = `${extraService.result.stdout ?? ""}${extraService.result.stderr ?? ""}`;
      expect(extraService.result.status, extraOutput).not.toBe(0);
      expect(extraOutput).toContain(
        "Release Compose file must contain exactly postgres, redis, migrate, api, and web.",
      );
      expect(extraService.calls).toContain("config --services");
      expect(extraService.calls).not.toContain(" up ");
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  }, 45_000);
});
