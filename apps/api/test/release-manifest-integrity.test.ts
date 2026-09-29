import {
  chmodSync,
  copyFileSync,
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
const readRoot = (path: string) => readFileSync(resolve(root, path), "utf8");
const windowsTest = process.platform === "win32" ? test : test.skip;
const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
const hostBash = process.platform === "win32" ? gitBash : "bash";
const bashTest = spawnSync(hostBash, ["--version"], { stdio: "ignore" }).status === 0 ? test : test.skip;
const releaseFileRecord = (releaseRoot: string, relative: string) => {
  const bytes = readFileSync(join(releaseRoot, relative));
  return {
    path: relative.replaceAll("\\", "/"),
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};
const releaseFileRecords = (releaseRoot: string, relatives: string[]) =>
  relatives.map((relative) => releaseFileRecord(releaseRoot, relative))
    .sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
const toGitBashPath = (path: string): string =>
  path.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replaceAll("\\", "/");
const toHostBashPath = (path: string): string => process.platform === "win32" ? toGitBashPath(path) : path;

const releaseDocAllowlist = [
  "DIY_SEMANTIC_EXTENSIONS.md",
  "USER_GUIDE.md",
  "AI_DIY_GUIDE.md",
  "AI_PROMPTS.md",
  "HOW_TO_ADD_MODULE.md",
  "HOW_TO_ADD_PLATFORM.md",
  "SELF_SERVICE_MODULES.md",
  "加模块_给人看.md",
  "部署指南.md",
  "离线包使用说明.md",
];
const frontProfitWorkbookAllowlist = [
  "01-电商前台利润单表上传模板.xlsx",
  "02-电商前台利润数据准备与映射模板.xlsx",
];
const frontProfitTemplateAllowlist = [
  ...frontProfitWorkbookAllowlist,
  "README-前台利润模板使用说明.md",
  "SHA256SUMS.txt",
  "template-manifest.json",
];
const prepareMinimalReleaseSource = (sourceRoot: string, packager: string) => {
  for (const directory of [
    "scripts",
    "deploy",
    "docs",
    "apps/api/src/modules",
    "apps/api/extensions",
    "templates/front-profit",
  ]) {
    mkdirSync(join(sourceRoot, directory), { recursive: true });
  }
  copyFileSync(resolve(root, `scripts/${packager}`), join(sourceRoot, `scripts/${packager}`));
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    copyFileSync(resolve(root, name), join(sourceRoot, name));
  }
  copyFileSync(resolve(root, "scripts/sha256.ps1"), join(sourceRoot, "scripts/sha256.ps1"));
  for (const launcher of [
    "release-start.ps1",
    "release-start.sh",
    "release-start.bat",
    "instance-backup.ps1",
    "instance-restore.ps1",
    "instance-backup.sh",
    "instance-restore.sh",
  ]) {
    copyFileSync(resolve(root, `scripts/${launcher}`), join(sourceRoot, `scripts/${launcher}`));
  }
  writeFileSync(join(sourceRoot, "deploy/.env.example"), "EXAMPLE=true\n", "utf8");
  writeFileSync(join(sourceRoot, "apps/api/src/modules/fixture.ts"), "export {};\n", "utf8");
  for (const doc of releaseDocAllowlist) {
    writeFileSync(join(sourceRoot, "docs", doc), `recipient guide: ${doc}\n`, "utf8");
  }
  for (const template of frontProfitTemplateAllowlist) {
    copyFileSync(resolve(root, "templates/front-profit", template), join(sourceRoot, "templates/front-profit", template));
  }
  mkdirSync(join(sourceRoot, "docs/superpowers/plans"), { recursive: true });
  writeFileSync(join(sourceRoot, "docs/internal-evaluation.md"), "internal only\n", "utf8");
  writeFileSync(join(sourceRoot, "docs/superpowers/plans/internal-plan.md"), "internal only\n", "utf8");
};
const findFiles = (directory: string, suffix: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? findFiles(path, suffix) : path.endsWith(suffix) ? [path] : [];
  });

describe("release manifest and prebuilt archive integrity", () => {
  test("supports one prebuilt image archive with canonical provenance and records file hashes", () => {
    const windowsPackager = readRoot("scripts/package-release.ps1");
    const bashPackager = readRoot("scripts/package-release.sh");

    expect(windowsPackager).toContain("'-f', $composeFile, 'build', '--pull', 'api', 'web'");
    expect(windowsPackager).toContain("front-profit:local-release-precheck");
    expect(windowsPackager).toContain("SkipFrontProfitLocalPrecheck");
    expect(bashPackager).toContain(
      "docker compose --env-file .env.example -f docker-compose.yml build --pull api web",
    );
    expect(bashPackager).toContain("front-profit:local-release-precheck");
    expect(bashPackager).toContain("SKIP_FRONT_PROFIT_LOCAL_PRECHECK");
    for (const packager of [windowsPackager, bashPackager]) {
      expect(packager).toContain("sourceRevision");
      expect(packager).toContain("imageIds");
      expect(packager).toContain("PREBUILT_IMAGE_ARCHIVE");
      expect(packager).toContain("PREBUILT_IMAGE_PROVENANCE");
      expect(packager).toContain("archiveSha256");
      expect(packager).toContain("image-provenance.json");
      expect(packager).toContain("sha256");
      expect(packager).toContain("prebuilt-archive");
    }
  });


  bashTest("packages the exact prebuilt archive without rebuilding and binds canonical provenance", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ec-prebuilt-release-"));
    const sourceRoot = join(sandbox, "source");
    const releaseRoot = join(sandbox, "release");
    const binRoot = join(sandbox, "bin");
    const archivePath = join(sandbox, "one-build-images.tar");
    const provenancePath = join(sandbox, "image-provenance.json");
    const dockerLog = join(sandbox, "docker.log");
    const sourceRevision = "a".repeat(40);
    const requiredImages = ["postgres:16", "redis:7-alpine", "deploy-api:latest", "deploy-web:latest"];
    const imageIds = Object.fromEntries(requiredImages.map((image, index) => [image, `sha256:${String(index + 1).repeat(64)}`]));
    try {
      prepareMinimalReleaseSource(sourceRoot, "package-release.sh");
      mkdirSync(releaseRoot, { recursive: true });
      mkdirSync(binRoot, { recursive: true });
      writeFileSync(archivePath, "the exact single-build image archive", "utf8");
      const archiveSha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
      const provenance = {
        schemaVersion: 1,
        sourceRevision,
        archiveSha256,
        images: {
          "postgres:16": {
            imageId: imageIds["postgres:16"],
            registryRepository: "docker.io/library/postgres",
            digest: "sha256:95206741a5b214807675e14165369d05b93a9cf692223b616d07cca227e74b0b",
            reference: "docker.io/library/postgres@sha256:95206741a5b214807675e14165369d05b93a9cf692223b616d07cca227e74b0b",
          },
          "redis:7-alpine": {
            imageId: imageIds["redis:7-alpine"],
            registryRepository: "docker.io/library/redis",
            digest: "sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2",
            reference: "docker.io/library/redis@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2",
          },
          "deploy-api:latest": {
            imageId: imageIds["deploy-api:latest"],
            registryRepository: "ghcr.io/example/ec-data-api",
            digest: `sha256:${"a".repeat(64)}`,
            reference: `ghcr.io/example/ec-data-api@sha256:${"a".repeat(64)}`,
          },
          "deploy-web:latest": {
            imageId: imageIds["deploy-web:latest"],
            registryRepository: "ghcr.io/example/ec-data-web",
            digest: `sha256:${"b".repeat(64)}`,
            reference: `ghcr.io/example/ec-data-web@sha256:${"b".repeat(64)}`,
          },
        },
      };
      writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
      writeFileSync(join(binRoot, "date"), "#!/usr/bin/env bash\necho 20990102\n", "utf8");
      writeFileSync(join(binRoot, "git"), `#!/usr/bin/env bash
if [ "$1" = "status" ]; then exit 0; fi
if [ "$1" = "rev-parse" ]; then echo "${sourceRevision}"; exit 0; fi
exit 2
`, "utf8");
      writeFileSync(join(binRoot, "docker"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [ "$1" = "load" ]; then exit 0; fi
if [ "$1 $2" = "image inspect" ]; then
  image="\${@: -1}"
  case "$image" in
    postgres:16) id="${imageIds["postgres:16"]}" ;;
    redis:7-alpine) id="${imageIds["redis:7-alpine"]}" ;;
    deploy-api:latest) id="${imageIds["deploy-api:latest"]}" ;;
    deploy-web:latest) id="${imageIds["deploy-web:latest"]}" ;;
    *) exit 3 ;;
  esac
  [ "$3" = "--format" ] && echo "$id"
  exit 0
fi
echo "unexpected Docker call" >&2
exit 90
`, "utf8");
      for (const name of ["date", "git", "docker"]) chmodSync(join(binRoot, name), 0o755);
      const harness = join(sandbox, "run.sh");
      writeFileSync(harness, `#!/usr/bin/env bash
set -e
export PATH="$1:$PATH"
export RELEASE_ROOT="$2"
export PREBUILT_IMAGE_ARCHIVE="$3"
export PREBUILT_IMAGE_PROVENANCE="$4"
export SKIP_FRONT_PROFIT_LOCAL_PRECHECK=1
export DOCKER_LOG="$5"
cd "$6"
exec bash scripts/package-release.sh
`, "utf8");
      chmodSync(harness, 0o755);
      const result = spawnSync(hostBash, [
        toHostBashPath(harness),
        toHostBashPath(binRoot),
        toHostBashPath(releaseRoot),
        toHostBashPath(archivePath),
        toHostBashPath(provenancePath),
        toHostBashPath(dockerLog),
        toHostBashPath(sourceRoot),
      ], { encoding: "utf8" });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.status, output).toBe(0);
      const calls = readFileSync(dockerLog, "utf8");
      expect(calls).toContain("load -i");
      expect(calls).not.toContain("compose");
      expect(calls).not.toContain("save");

      const archive = findFiles(releaseRoot, ".zip")[0]!;
      const expandedRoot = join(sandbox, "expanded");
      const expand = process.platform === "win32"
        ? spawnSync("powershell.exe", ["-NoProfile", "-Command",
          `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${expandedRoot.replaceAll("'", "''")}' -Force`,
        ], { encoding: "utf8" })
        : spawnSync("unzip", ["-q", archive, "-d", expandedRoot], { encoding: "utf8" });
      expect(
        expand.status,
        `${expand.error?.message ?? ""}${expand.stdout ?? ""}${expand.stderr ?? ""}`,
      ).toBe(0);
      const packagedRoot = join(expandedRoot, readdirSync(expandedRoot)[0]!);
      expect(readFileSync(join(packagedRoot, "ec-data-images.tar"))).toEqual(readFileSync(archivePath));
      expect(readFileSync(join(packagedRoot, "image-provenance.json"))).toEqual(readFileSync(provenancePath));
      const manifest = JSON.parse(readFileSync(join(packagedRoot, "release-manifest.json"), "utf8"));
      expect(manifest.imageSource).toBe("prebuilt-archive");
      for (const entry of manifest.files as Array<{ path: string; size: number; sha256: string }>) {
        expect(entry).toEqual(releaseFileRecord(packagedRoot, entry.path));
      }
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  }, 30_000);

  windowsTest("PowerShell local build stops on front-profit precheck failure before fake Docker", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ec-ps-front-profit-precheck-"));
    const sourceRoot = join(sandbox, "source");
    const outputRoot = join(sandbox, "release");
    const binRoot = join(sandbox, "bin");
    const dockerLog = join(sandbox, "docker.log");
    const pnpmLog = join(sandbox, "pnpm.log");
    try {
      prepareMinimalReleaseSource(sourceRoot, "package-release.ps1");
      mkdirSync(binRoot);
      const fakeGit = join(binRoot, "fake-git.cjs");
      const fakeDocker = join(binRoot, "fake-docker.cjs");
      const fakePnpm = join(binRoot, "fake-pnpm.cjs");
      writeFileSync(fakeGit, `
const args = process.argv.slice(2);
if (args.includes("status")) process.exit(0);
if (args.includes("rev-parse")) { console.log("${"a".repeat(40)}"); process.exit(0); }
process.exit(2);
`, "utf8");
      writeFileSync(
        fakeDocker,
        'require("node:fs").appendFileSync(process.env.DOCKER_LOG, process.argv.slice(2).join(" ") + "\\n"); process.exit(90);\n',
        "utf8",
      );
      writeFileSync(
        fakePnpm,
        'require("node:fs").appendFileSync(process.env.PNPM_LOG, process.argv.slice(2).join(" ") + "\\n"); console.error("fake front-profit precheck failure"); process.exit(42);\n',
        "utf8",
      );
      writeFileSync(
        join(binRoot, "git.cmd"),
        '@echo off\r\n"%FAKE_NODE_EXE%" "%FAKE_GIT_JS%" %*\r\nexit /b %ERRORLEVEL%\r\n',
        "utf8",
      );
      writeFileSync(
        join(binRoot, "docker.cmd"),
        '@echo off\r\n"%FAKE_NODE_EXE%" "%FAKE_DOCKER_JS%" %*\r\nexit /b %ERRORLEVEL%\r\n',
        "utf8",
      );
      writeFileSync(
        join(binRoot, "pnpm.cmd"),
        '@echo off\r\n"%FAKE_NODE_EXE%" "%FAKE_PNPM_JS%" %*\r\nexit /b %ERRORLEVEL%\r\n',
        "utf8",
      );
      const cleanEnv = { ...process.env };
      for (const key of Object.keys(cleanEnv)) {
        if (key.startsWith("COMPOSE_")) delete cleanEnv[key];
      }
      delete cleanEnv.PREBUILT_IMAGE_ARCHIVE;
      delete cleanEnv.PREBUILT_IMAGE_PROVENANCE;
      delete cleanEnv.SKIP_FRONT_PROFIT_LOCAL_PRECHECK;
      delete cleanEnv.SKIP_IMAGE_EXPORT;
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(sourceRoot, "scripts/package-release.ps1"),
          "-OutputRoot",
          outputRoot,
        ],
        {
          encoding: "utf8",
          env: {
            ...cleanEnv,
            PATH: `${binRoot};${process.env.PATH ?? ""}`,
            DOCKER_LOG: dockerLog,
            PNPM_LOG: pnpmLog,
            FAKE_NODE_EXE: process.execPath,
            FAKE_GIT_JS: fakeGit,
            FAKE_DOCKER_JS: fakeDocker,
            FAKE_PNPM_JS: fakePnpm,
          },
        },
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.status, output).not.toBe(0);
      expect(output).toContain("fake front-profit precheck failure");
      expect(readFileSync(pnpmLog, "utf8")).toContain("--filter @ec/api run front-profit:local-release-precheck");
      expect(existsSync(dockerLog)).toBe(false);
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  }, 20_000);

  bashTest("Bash local build stops on front-profit precheck failure before fake Docker", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ec-bash-front-profit-precheck-"));
    const sourceRoot = join(sandbox, "source");
    const outputRoot = join(sandbox, "release");
    const binRoot = join(sandbox, "bin");
    const dockerLog = join(sandbox, "docker.log");
    const pnpmLog = join(sandbox, "pnpm.log");
    try {
      prepareMinimalReleaseSource(sourceRoot, "package-release.sh");
      mkdirSync(binRoot);
      writeFileSync(join(binRoot, "git"), `#!/usr/bin/env bash
case " $* " in
  *" status "*) exit 0 ;;
  *" rev-parse "*) echo "${"a".repeat(40)}"; exit 0 ;;
esac
exit 2
`, "utf8");
      writeFileSync(join(binRoot, "docker"), `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
exit 90
`, "utf8");
      writeFileSync(join(binRoot, "pnpm"), `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$PNPM_LOG"
echo "fake front-profit precheck failure" >&2
exit 42
`, "utf8");
      for (const name of ["git", "docker", "pnpm"]) chmodSync(join(binRoot, name), 0o755);
      const harness = join(sandbox, "run-front-profit-precheck.sh");
      writeFileSync(harness, `#!/usr/bin/env bash
set -e
unset SKIP_FRONT_PROFIT_LOCAL_PRECHECK SKIP_IMAGE_EXPORT PREBUILT_IMAGE_ARCHIVE PREBUILT_IMAGE_PROVENANCE
while IFS='=' read -r name _; do
  case "$name" in COMPOSE_*) unset "$name" ;; esac
done < <(env)
export PATH="$1:$PATH"
export RELEASE_ROOT="$2"
export PNPM_LOG="$3"
export DOCKER_LOG="$4"
cd "$5"
exec bash scripts/package-release.sh
`, "utf8");
      chmodSync(harness, 0o755);
      const result = spawnSync(
        hostBash,
        [
          toHostBashPath(harness),
          toHostBashPath(binRoot),
          toHostBashPath(outputRoot),
          toHostBashPath(pnpmLog),
          toHostBashPath(dockerLog),
          toHostBashPath(sourceRoot),
        ],
        { encoding: "utf8" },
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.status, output).not.toBe(0);
      expect(output).toContain("fake front-profit precheck failure");
      expect(readFileSync(pnpmLog, "utf8")).toContain("--filter @ec/api run front-profit:local-release-precheck");
      expect(existsSync(dockerLog)).toBe(false);
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  }, 20_000);

  windowsTest("PowerShell local build rejects Compose file overrides before fake Docker", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ec-ps-compose-override-"));
    const sourceRoot = join(sandbox, "source");
    const outputRoot = join(sandbox, "release");
    const binRoot = join(sandbox, "bin");
    const dockerLog = join(sandbox, "docker.log");
    try {
      prepareMinimalReleaseSource(sourceRoot, "package-release.ps1");
      mkdirSync(binRoot);
      const fakeGit = join(binRoot, "fake-git.cjs");
      const fakeDocker = join(binRoot, "fake-docker.cjs");
      writeFileSync(fakeGit, `
const args = process.argv.slice(2);
if (args.includes("status")) process.exit(0);
if (args.includes("rev-parse")) { console.log("${"a".repeat(40)}"); process.exit(0); }
process.exit(2);
`, "utf8");
      writeFileSync(
        fakeDocker,
        'require("node:fs").appendFileSync(process.env.DOCKER_LOG, process.argv.slice(2).join(" ") + "\\n"); process.exit(90);\n',
        "utf8",
      );
      writeFileSync(
        join(binRoot, "git.cmd"),
        '@echo off\r\n"%FAKE_NODE_EXE%" "%FAKE_GIT_JS%" %*\r\nexit /b %ERRORLEVEL%\r\n',
        "utf8",
      );
      writeFileSync(
        join(binRoot, "docker.cmd"),
        '@echo off\r\n"%FAKE_NODE_EXE%" "%FAKE_DOCKER_JS%" %*\r\nexit /b %ERRORLEVEL%\r\n',
        "utf8",
      );
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(sourceRoot, "scripts/package-release.ps1"),
          "-OutputRoot",
          outputRoot,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${binRoot};${process.env.PATH ?? ""}`,
            COMPOSE_FILE: join(sandbox, "evil.yml"),
            DOCKER_LOG: dockerLog,
            FAKE_NODE_EXE: process.execPath,
            FAKE_GIT_JS: fakeGit,
            FAKE_DOCKER_JS: fakeDocker,
          },
        },
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.status, output).not.toBe(0);
      expect(output).toContain("Local image build refuses Docker Compose control variable: COMPOSE_FILE");
      expect(existsSync(dockerLog)).toBe(false);
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  }, 20_000);

  bashTest("Bash local build rejects Compose file overrides before fake Docker", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ec-bash-compose-override-"));
    const sourceRoot = join(sandbox, "source");
    const outputRoot = join(sandbox, "release");
    const binRoot = join(sandbox, "bin");
    const dockerLog = join(sandbox, "docker.log");
    try {
      prepareMinimalReleaseSource(sourceRoot, "package-release.sh");
      mkdirSync(binRoot);
      writeFileSync(join(binRoot, "git"), `#!/usr/bin/env bash
case " $* " in
  *" status "*) exit 0 ;;
  *" rev-parse "*) echo "${"a".repeat(40)}"; exit 0 ;;
esac
exit 2
`, "utf8");
      writeFileSync(join(binRoot, "docker"), `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
exit 90
`, "utf8");
      chmodSync(join(binRoot, "git"), 0o755);
      chmodSync(join(binRoot, "docker"), 0o755);
      const harness = join(sandbox, "run-compose-override.sh");
      writeFileSync(harness, `#!/usr/bin/env bash
set -e
export PATH="$1:$PATH"
export RELEASE_ROOT="$2"
export COMPOSE_PATH_SEPARATOR=:
export DOCKER_LOG="$3"
cd "$4"
exec bash scripts/package-release.sh
`, "utf8");
      chmodSync(harness, 0o755);
      const result = spawnSync(
        hostBash,
        [
          toHostBashPath(harness),
          toHostBashPath(binRoot),
          toHostBashPath(outputRoot),
          toHostBashPath(dockerLog),
          toHostBashPath(sourceRoot),
        ],
        {
          encoding: "utf8",
        },
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.status, output).not.toBe(0);
      expect(output).toContain(
        "Local image build refuses Docker Compose control variable: COMPOSE_PATH_SEPARATOR",
      );
      expect(existsSync(dockerLog)).toBe(false);
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  }, 20_000);

});
