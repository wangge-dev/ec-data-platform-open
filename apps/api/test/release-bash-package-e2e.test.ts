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
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
const windowsBashTest = process.platform === "win32" &&
  spawnSync(gitBash, ["--version"], { stdio: "ignore" }).status === 0
  ? test
  : test.skip;
const releaseDocAllowlist = [
  "HOW_TO_ADD_MODULE.md",
  "HOW_TO_ADD_PLATFORM.md",
  "SELF_SERVICE_MODULES.md",
  "DIY_SEMANTIC_EXTENSIONS.md",
  "USER_GUIDE.md",
  "AI_DIY_GUIDE.md",
  "AI_PROMPTS.md",
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
const toGitBashPath = (path: string): string =>
  path.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replaceAll("\\", "/");
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
const prepareMinimalReleaseSource = (sourceRoot: string, packager: string) => {
  for (const directory of ["scripts", "deploy", "docs", "apps/api/src/modules", "templates/front-profit"]) {
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
const assertFrontProfitTemplatePackage = (templateRoot: string) => {
  expect(readdirSync(templateRoot).sort()).toEqual([...frontProfitTemplateAllowlist].sort());
  const manifest = JSON.parse(readFileSync(join(templateRoot, "template-manifest.json"), "utf8"));
  expect(manifest.containsRealBusinessData).toBe(false);
  expect(manifest.files.map((entry: { name: string }) => entry.name).sort()).toEqual(
    [...frontProfitWorkbookAllowlist].sort(),
  );
  for (const entry of manifest.files as Array<{ name: string; sha256: string; businessDataRows: number }>) {
    expect(entry.businessDataRows).toBe(0);
    const actualHash = createHash("sha256").update(readFileSync(join(templateRoot, entry.name))).digest("hex").toUpperCase();
    expect(actualHash).toBe(entry.sha256);
  }
};
const findFiles = (directory: string, suffix: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? findFiles(path, suffix) : path.endsWith(suffix) ? [path] : [];
  });

describe("Bash release package end-to-end integrity", () => {
  windowsBashTest("Bash package audits its exact docs and always replaces stale image tags from the tar", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "ec-bash-launcher-"));
    const releaseRoot = join(sourceRoot, "release-output");
    const expandedRoot = join(sourceRoot, "expanded");
    try {
      prepareMinimalReleaseSource(sourceRoot, "package-release.sh");
      const result = spawnSync(gitBash, [toGitBashPath(join(sourceRoot, "scripts/package-release.sh"))], {
        cwd: sourceRoot,
        encoding: "utf8",
        env: { ...process.env, RELEASE_ROOT: toGitBashPath(releaseRoot), SKIP_IMAGE_EXPORT: "1" },
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.status, output).toBe(0);

      const [archive] = findFiles(releaseRoot, ".zip");
      expect(archive).toBeDefined();
      const expand = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -LiteralPath '${archive!.replaceAll("'", "''")}' -DestinationPath '${expandedRoot.replaceAll("'", "''")}' -Force`,
        ],
        { encoding: "utf8" },
      );
      expect(expand.status, `${expand.stdout ?? ""}${expand.stderr ?? ""}`).toBe(0);
      const [distRoot] = readdirSync(expandedRoot).map((name) => join(expandedRoot, name));
      expect(readdirSync(join(distRoot!, "docs")).sort()).toEqual([...releaseDocAllowlist].sort());
      assertFrontProfitTemplatePackage(join(distRoot!, "templates/front-profit"));

      const requiredImages = ["postgres:16", "redis:7-alpine", "deploy-api:latest", "deploy-web:latest"];
      const imageIds = Object.fromEntries(
        requiredImages.map((image, index) => [image, `sha256:${String(index + 1).repeat(64)}`]),
      );

      const launcher = readFileSync(join(distRoot!, "start.sh"), "utf8");
      for (const image of requiredImages) {
        expect(launcher).toContain(image);
      }
      expect(launcher).toContain("release-manifest.json");
      expect(launcher).toContain("release-image-ids.txt");
      expect(launcher).toContain("read_release_manifest_image_ids");
      expect(launcher).toContain("release-manifest.json and release-image-ids.txt disagree");
      expect(launcher).toContain("docker load -i ec-data-images.tar");
      expect(launcher).toContain("--no-build --force-recreate");
      expect(launcher).toContain("compose_cmd stop");
      expect(launcher).toContain("assert_compose_image");
      expect(launcher).toContain("ADMIN_PASSWORD");
      expect(launcher).not.toContain("123456");
      const windowsLauncher = readFileSync(join(distRoot!, "start.bat"), "utf8");
      const windowsPowerShell = readFileSync(join(distRoot!, "start.ps1"), "utf8");
      expect(windowsLauncher).toContain("start.ps1");
      expect(windowsLauncher).not.toContain("docker compose up -d");
      expect(windowsPowerShell).toContain("Wait-ReleaseHealth");
      expect(windowsPowerShell).toContain("Migration container exited with exit code");
      expect(windowsPowerShell).toContain("Read-ExpectedImageIds");
      expect(windowsPowerShell).toContain("Read-ImageIdContract");
      expect(windowsPowerShell).toContain("Assert-LoadedImageIds");
      expect(windowsPowerShell).toContain("Assert-ComposeImageIds");
      expect(windowsPowerShell).toContain("'--no-build', '--force-recreate'");

      writeFileSync(join(distRoot!, "ec-data-images.tar"), "fixture", "utf8");
      const manifestPath = join(distRoot!, "release-manifest.json");
      const releaseManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      releaseManifest.sourceRevision = "a".repeat(40);
      releaseManifest.imageSource = "local-build";
      releaseManifest.imageIds = imageIds;
      const contractPath = join(distRoot!, "release-image-ids.txt");
      const validContract = requiredImages.map((image) => `${image}=${imageIds[image]}`).join("\n") + "\n";
      writeFileSync(contractPath, validContract, "utf8");
      releaseManifest.files = releaseFileRecords(distRoot!, [
        ...releaseManifest.files.map((entry: { path: string }) => entry.path),
        "ec-data-images.tar",
        "release-image-ids.txt",
      ]);
      writeFileSync(manifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8");
      writeFileSync(
        join(distRoot!, "deploy/.env"),
        [
          "POSTGRES_PASSWORD=unique-postgres-password",
          "APP_DB_PASSWORD=unique-application-password",
          "ADMIN_PASSWORD=unique-admin-password",
          "JWT_SECRET=unique-jwt-secret-that-is-longer-than-thirty-two-characters",
          "",
        ].join("\n"),
        "utf8",
      );
      const binRoot = join(sourceRoot, "fake-bin");
      mkdirSync(binRoot);
      const fakeDocker = join(binRoot, "docker");
      writeFileSync(
        fakeDocker,
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [ "$1" = "load" ]; then : > "$DOCKER_STATE"; fi
if [ "$1 $2 $3" = "image inspect --format" ]; then
  image="$5"
  if [ ! -f "$DOCKER_STATE" ]; then
    echo "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    exit 0
  fi
  if [ "\${MISMATCH_IMAGE:-}" = "$image" ]; then
    echo "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    exit 0
  fi
  case "$image" in
    postgres:16) echo "${imageIds["postgres:16"]}" ;;
    redis:7-alpine) echo "${imageIds["redis:7-alpine"]}" ;;
    deploy-api:latest) echo "${imageIds["deploy-api:latest"]}" ;;
    deploy-web:latest) echo "${imageIds["deploy-web:latest"]}" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "$1" = "compose" ] && [[ "$*" == *"config --services" ]]; then
  printf 'postgres\nredis\nmigrate\napi\nweb\n'
  exit 0
fi
if [ "$1" = "compose" ] && [[ "$*" == *" ps --all -q "* ]]; then
  service="\${@: -1}"
  case "$service" in
    postgres) printf '%064d\n' 1 ;;
    redis) printf '%064d\n' 2 ;;
    migrate) printf '%064d\n' 3 ;;
    api) printf '%064d\n' 4 ;;
    web) printf '%064d\n' 5 ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "$1" = "inspect" ]; then
  container_id="\${@: -1}"
  if [ "$3" = "{{.Image}}" ]; then
    if [ "\${MISMATCH_CONTAINER:-}" = "$container_id" ]; then
      echo "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
      exit 0
    fi
    case "$container_id" in
      0000000000000000000000000000000000000000000000000000000000000001) echo "${imageIds["postgres:16"]}" ;;
      0000000000000000000000000000000000000000000000000000000000000002) echo "${imageIds["redis:7-alpine"]}" ;;
      0000000000000000000000000000000000000000000000000000000000000003|0000000000000000000000000000000000000000000000000000000000000004) echo "${imageIds["deploy-api:latest"]}" ;;
      0000000000000000000000000000000000000000000000000000000000000005) echo "${imageIds["deploy-web:latest"]}" ;;
      *) exit 1 ;;
    esac
    exit 0
  fi
  case "$container_id" in
    0000000000000000000000000000000000000000000000000000000000000003) echo "exited|0" ;;
    *) echo "running|healthy|0" ;;
  esac
  exit 0
fi
exit 0
`,
        "utf8",
      );
      chmodSync(fakeDocker, 0o755);
      const harness = join(sourceRoot, "run-launcher.sh");
      writeFileSync(harness, "#!/usr/bin/env bash\nset -e\nexport PATH=\"$1:$PATH\"\ncd \"$2\"\nexec bash start.sh\n", "utf8");
      const dockerLog = join(sourceRoot, "docker.log");
      const expectNoComposeDown = (calls: string) => {
        expect(calls).not.toContain("compose down");
        expect(calls).not.toContain("down -v");
      };
      const launch = spawnSync(
        gitBash,
        [toGitBashPath(harness), toGitBashPath(binRoot), toGitBashPath(distRoot!)],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            DOCKER_LOG: toGitBashPath(dockerLog),
            DOCKER_STATE: toGitBashPath(join(sourceRoot, "docker.loaded")),
          },
        },
      );
      expect(launch.status, `${launch.stdout ?? ""}${launch.stderr ?? ""}`).toBe(0);
      const calls = readFileSync(dockerLog, "utf8");
      for (const image of requiredImages) {
        expect(calls).toContain(`image inspect --format {{.Id}} ${image}`);
      }
      expect(calls).toContain("load -i ec-data-images.tar");
      expect(calls).toContain("config --quiet");
      expect(calls).toContain("up -d --no-build --force-recreate");
      expectNoComposeDown(calls);
      expect(calls.indexOf("load -i ec-data-images.tar")).toBeLessThan(
        calls.indexOf("up -d --no-build --force-recreate"),
      );

      writeFileSync(
        manifestPath,
        `THIS IS NOT JSON\n${JSON.stringify(releaseManifest, null, 2)}\nTRAILING NON-JSON\n`,
        "utf8",
      );
      const malformedManifestLog = join(sourceRoot, "malformed-manifest.log");
      const malformedManifest = spawnSync(
        gitBash,
        [toGitBashPath(harness), toGitBashPath(binRoot), toGitBashPath(distRoot!)],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            DOCKER_LOG: toGitBashPath(malformedManifestLog),
            DOCKER_STATE: toGitBashPath(join(sourceRoot, "malformed-manifest.loaded")),
          },
        },
      );
      const malformedManifestOutput = `${malformedManifest.stdout ?? ""}${malformedManifest.stderr ?? ""}`;
      expect(malformedManifest.status, malformedManifestOutput).not.toBe(0);
      expect(malformedManifestOutput).toContain("release-manifest.json root must be one canonical object");
      const malformedManifestCalls = existsSync(malformedManifestLog)
        ? readFileSync(malformedManifestLog, "utf8")
        : "";
      expect(malformedManifestCalls).not.toContain("load -i");
      expectNoComposeDown(malformedManifestCalls);
      writeFileSync(manifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8");

      const tamperedManifest = {
        ...releaseManifest,
        imageIds: {
          ...imageIds,
          "deploy-api:latest": `sha256:${"e".repeat(64)}`,
        },
      };
      writeFileSync(manifestPath, `${JSON.stringify(tamperedManifest, null, 2)}\n`, "utf8");
      const manifestMismatchLog = join(sourceRoot, "manifest-mismatch.log");
      const manifestMismatch = spawnSync(
        gitBash,
        [toGitBashPath(harness), toGitBashPath(binRoot), toGitBashPath(distRoot!)],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            DOCKER_LOG: toGitBashPath(manifestMismatchLog),
            DOCKER_STATE: toGitBashPath(join(sourceRoot, "manifest-mismatch.loaded")),
          },
        },
      );
      const manifestMismatchOutput = `${manifestMismatch.stdout ?? ""}${manifestMismatch.stderr ?? ""}`;
      expect(manifestMismatch.status, manifestMismatchOutput).not.toBe(0);
      expect(manifestMismatchOutput).toContain(
        "release-manifest.json and release-image-ids.txt disagree for deploy-api:latest",
      );
      const manifestMismatchCalls = existsSync(manifestMismatchLog)
        ? readFileSync(manifestMismatchLog, "utf8")
        : "";
      expect(manifestMismatchCalls).not.toContain("load -i");
      expectNoComposeDown(manifestMismatchCalls);
      writeFileSync(manifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8");

      const mismatchLog = join(sourceRoot, "docker-mismatch.log");
      const mismatchLaunch = spawnSync(
        gitBash,
        [toGitBashPath(harness), toGitBashPath(binRoot), toGitBashPath(distRoot!)],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            DOCKER_LOG: toGitBashPath(mismatchLog),
            DOCKER_STATE: toGitBashPath(join(sourceRoot, "docker-mismatch.loaded")),
            MISMATCH_IMAGE: "deploy-web:latest",
          },
        },
      );
      const mismatchOutput = `${mismatchLaunch.stdout ?? ""}${mismatchLaunch.stderr ?? ""}`;
      expect(mismatchLaunch.status, mismatchOutput).not.toBe(0);
      expect(mismatchOutput).toContain("Loaded image ID mismatch for deploy-web:latest");
      const mismatchCalls = readFileSync(mismatchLog, "utf8");
      expect(mismatchCalls).not.toContain(" up");
      expectNoComposeDown(mismatchCalls);

      const postUpFailureLog = join(sourceRoot, "docker-post-up-failure.log");
      const postUpFailure = spawnSync(
        gitBash,
        [toGitBashPath(harness), toGitBashPath(binRoot), toGitBashPath(distRoot!)],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            DOCKER_LOG: toGitBashPath(postUpFailureLog),
            DOCKER_STATE: toGitBashPath(join(sourceRoot, "docker-post-up.loaded")),
            MISMATCH_CONTAINER: "0000000000000000000000000000000000000000000000000000000000000005",
          },
        },
      );
      const postUpOutput = `${postUpFailure.stdout ?? ""}${postUpFailure.stderr ?? ""}`;
      expect(postUpFailure.status, postUpOutput).not.toBe(0);
      expect(postUpOutput).toContain("Compose service web uses image");
      const postUpCalls = readFileSync(postUpFailureLog, "utf8");
      expect(postUpCalls).toContain("up -d --no-build --force-recreate");
      expect(postUpCalls).toContain(" stop");
      expectNoComposeDown(postUpCalls);

      const invalidContracts: Array<{
        name: string;
        value: string | Buffer;
      }> = [
        {
          name: "missing-entry",
          value: validContract.split("\n").slice(0, 3).join("\n") + "\n",
        },
        {
          name: "extra-entry",
          value: validContract + `unexpected:latest=sha256:${"e".repeat(64)}\n`,
        },
        {
          name: "invalid-image-id",
          value: validContract.replace(imageIds["deploy-api:latest"], "sha256:not-a-real-id"),
        },
        {
          name: "wrong-image-order",
          value: validContract.split("\n").filter(Boolean).reverse().join("\n") + "\n",
        },
        {
          name: "utf8-bom",
          value: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(validContract)]),
        },
      ];
      for (const invalid of invalidContracts) {
        writeFileSync(contractPath, invalid.value);
        const invalidLog = join(sourceRoot, `${invalid.name}.log`);
        const invalidLaunch = spawnSync(
          gitBash,
          [toGitBashPath(harness), toGitBashPath(binRoot), toGitBashPath(distRoot!)],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              DOCKER_LOG: toGitBashPath(invalidLog),
              DOCKER_STATE: toGitBashPath(join(sourceRoot, `${invalid.name}.loaded`)),
            },
          },
        );
        expect(invalidLaunch.status, invalid.name).not.toBe(0);
        const invalidCalls = existsSync(invalidLog) ? readFileSync(invalidLog, "utf8") : "";
        expect(invalidCalls).not.toContain("load -i");
        expectNoComposeDown(invalidCalls);
      }
      writeFileSync(contractPath, validContract, "utf8");
    } finally {
      rmSync(sourceRoot, { force: true, recursive: true });
    }
  }, 90_000);


});
