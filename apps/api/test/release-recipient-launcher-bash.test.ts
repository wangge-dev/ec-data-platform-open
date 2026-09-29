import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
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

describe("Bash recipient release launcher integrity", () => {
  bashTest("executes the Bash recipient launcher on CI with strict IDs and fail-closed stop", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ec-bash-recipient-"));
    const releaseRoot = join(sandbox, "release with space");
    const binRoot = join(sandbox, "fake-bin");
    const requiredImages = ["postgres:16", "redis:7-alpine", "deploy-api:latest", "deploy-web:latest"];
    const imageIds = Object.fromEntries(
      requiredImages.map((image, index) => [image, `sha256:${String(index + 1).repeat(64)}`]),
    );
    const containerIds = {
      postgres: "1".repeat(64),
      redis: "2".repeat(64),
      migrate: "3".repeat(64),
      api: "4".repeat(64),
      web: "5".repeat(64),
    };
    try {
      mkdirSync(join(releaseRoot, "deploy"), { recursive: true });
      mkdirSync(binRoot, { recursive: true });
      copyFileSync(resolve(root, "scripts/release-start.sh"), join(releaseRoot, "start.sh"));
      chmodSync(join(releaseRoot, "start.sh"), 0o755);
      const manifestPath = join(releaseRoot, "release-manifest.json");
      const releaseManifest = {
        name: basename(releaseRoot),
        createdAt: "2026-08-08T00:00:00.000Z",
        sourceRevision: "a".repeat(40),
        imageSource: "local-build",
        images: requiredImages,
        imageIds,
        files: [] as ReturnType<typeof releaseFileRecord>[],
      };
      const releaseFiles = [
          "deploy/docker-compose.yml",
          "ec-data-images.tar",
          "release-image-ids.txt",
          "start.sh",
        ].sort();
      writeFileSync(join(releaseRoot, "ec-data-images.tar"), "synthetic archive", "utf8");
      const contract = requiredImages.map((image) => `${image}=${imageIds[image]}`).join("\n") + "\n";
      writeFileSync(join(releaseRoot, "release-image-ids.txt"), contract, "utf8");
      writeFileSync(join(releaseRoot, "deploy/docker-compose.yml"), "services: {}\n", "utf8");
      const validEnvironment = [
          "POSTGRES_PASSWORD=unique-postgres-password",
          "APP_DB_PASSWORD=unique-application-password",
          "ADMIN_PASSWORD=unique-admin-password",
          "JWT_SECRET=unique-jwt-secret-that-is-longer-than-thirty-two-characters",
          "",
        ].join("\n");
      writeFileSync(join(releaseRoot, "deploy/.env"), validEnvironment, "utf8");
      releaseManifest.files = releaseFileRecords(releaseRoot, releaseFiles);
      writeFileSync(manifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8");

      const fakeDocker = join(binRoot, "docker");
      writeFileSync(fakeDocker, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [[ "$*" == *"config --quiet" ]] && [ "\${CONFIG_FAIL:-}" = "1" ]; then
  echo "synthetic compose config failure" >&2; exit 7
fi
if [[ "$*" == *"config --services" ]]; then
  if [ "\${EXTRA_SERVICE:-}" = "1" ]; then
    printf 'postgres\nredis\nmigrate\napi\nweb\nevil\n'
  else
    printf 'postgres\nredis\nmigrate\napi\nweb\n'
  fi
  exit 0
fi
if [[ "$*" == *"up -d"* ]] && [ "\${UP_FAIL:-}" = "1" ]; then
  echo "synthetic partial startup failure" >&2; exit 8
fi
if [ "$1" = "load" ]; then : > "$DOCKER_STATE"; exit 0; fi
if [ "$1 $2 $3" = "image inspect --format" ]; then
  if [ ! -f "$DOCKER_STATE" ]; then echo "sha256:${"a".repeat(64)}"; exit 0; fi
  case "$5" in
    postgres:16) echo "${imageIds["postgres:16"]}" ;;
    redis:7-alpine) echo "${imageIds["redis:7-alpine"]}" ;;
    deploy-api:latest) echo "${imageIds["deploy-api:latest"]}" ;;
    deploy-web:latest) echo "${imageIds["deploy-web:latest"]}" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "$1" = "compose" ] && [[ "$*" == *" ps --all -q "* ]]; then
  case "\${@: -1}" in
    postgres) echo "${containerIds.postgres}" ;;
    redis) echo "${containerIds.redis}" ;;
    migrate) echo "${containerIds.migrate}" ;;
    api) echo "${containerIds.api}" ;;
    web) echo "${containerIds.web}" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "$1" = "inspect" ]; then
  container="\${@: -1}"
  if [ "$3" = "{{.Image}}" ]; then
    if [ "\${POST_UP_FAIL:-}" = "1" ] && [ "$container" = "${containerIds.web}" ]; then
      echo "sha256:${"f".repeat(64)}"; exit 0
    fi
    case "$container" in
      ${containerIds.postgres}) echo "${imageIds["postgres:16"]}" ;;
      ${containerIds.redis}) echo "${imageIds["redis:7-alpine"]}" ;;
      ${containerIds.migrate}|${containerIds.api}) echo "${imageIds["deploy-api:latest"]}" ;;
      ${containerIds.web}) echo "${imageIds["deploy-web:latest"]}" ;;
      *) exit 1 ;;
    esac
  elif [ "$container" = "${containerIds.migrate}" ]; then
    echo "exited|0"
  else
    echo "running|healthy|0"
  fi
  exit 0
fi
exit 0
`, "utf8");
      chmodSync(fakeDocker, 0o755);
      const harness = join(sandbox, "run.sh");
      writeFileSync(harness, "#!/usr/bin/env bash\nset -e\nexport PATH=\"$1:$PATH\"\ncd \"$2\"\nexec bash start.sh\n", "utf8");
      chmodSync(harness, 0o755);
      const run = (name: string, extraEnv: Record<string, string> = {}) => {
        const log = join(sandbox, `${name}.log`);
        const state = join(sandbox, `${name}.loaded`);
        const result = spawnSync(
          hostBash,
          [toHostBashPath(harness), toHostBashPath(binRoot), toHostBashPath(releaseRoot)],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              DOCKER_LOG: toHostBashPath(log),
              DOCKER_STATE: toHostBashPath(state),
              ...extraEnv,
            },
          },
        );
        return { result, log };
      };
      const readCalls = (log: string) => existsSync(log) ? readFileSync(log, "utf8") : "";
      const expectNoComposeDown = (calls: string) => {
        expect(calls).not.toContain("compose down");
        expect(calls).not.toContain("down -v");
      };
      const expectManifestFailureBeforeDocker = (
        name: string,
        manifestText: string,
        expectedMessage: string,
      ) => {
        writeFileSync(manifestPath, manifestText, "utf8");
        const attempt = run(name);
        const output = `${attempt.result.stdout ?? ""}${attempt.result.stderr ?? ""}`;
        expect(attempt.result.status, output).not.toBe(0);
        expect(output).toContain(expectedMessage);
        const calls = readCalls(attempt.log);
        expect(calls).not.toContain("load -i");
        expect(calls).not.toContain(" stop");
        expectNoComposeDown(calls);
      };

      const success = run("success");
      expect(success.result.status, `${success.result.stdout ?? ""}${success.result.stderr ?? ""}`).toBe(0);
      const successCalls = readFileSync(success.log, "utf8");
      expect(successCalls).toContain("load -i ec-data-images.tar");
      expect(successCalls).toContain("config --quiet");
      expect(successCalls).toContain("up -d --no-build --force-recreate");
      expect(successCalls).not.toContain(" stop");
      expectNoComposeDown(successCalls);

      writeFileSync(join(releaseRoot, "deploy/.env"), `${validEnvironment}COMPOSE_FILE=../../evil.yml\n`, "utf8");
      const composeFileOverride = run("compose-file-override");
      expect(composeFileOverride.result.status).not.toBe(0);
      expect(readCalls(composeFileOverride.log)).toBe("");
      writeFileSync(join(releaseRoot, "deploy/.env"), validEnvironment, "utf8");

      const unexpectedService = run("unexpected-service", { EXTRA_SERVICE: "1" });
      expect(unexpectedService.result.status).not.toBe(0);
      const unexpectedServiceCalls = readCalls(unexpectedService.log);
      expect(unexpectedServiceCalls).toContain("config --services");
      expect(unexpectedServiceCalls).not.toContain("load -i");
      expect(unexpectedServiceCalls).not.toContain(" up ");

      writeFileSync(
        manifestPath,
        `${JSON.stringify(releaseManifest, null, 2)}\n`.replaceAll("\n", "\r\n"),
        "utf8",
      );
      const crlfManifest = run("crlf-manifest");
      expect(
        crlfManifest.result.status,
        `${crlfManifest.result.stdout ?? ""}${crlfManifest.result.stderr ?? ""}`,
      ).toBe(0);
      expectNoComposeDown(readCalls(crlfManifest.log));
      writeFileSync(manifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8");

      expectManifestFailureBeforeDocker(
        "leading-manifest-garbage",
        `THIS IS NOT JSON\n${JSON.stringify(releaseManifest, null, 2)}\n`,
        "release-manifest.json root must be one canonical object",
      );
      expectManifestFailureBeforeDocker(
        "trailing-manifest-garbage",
        `${JSON.stringify(releaseManifest, null, 2)}\nTRAILING NON-JSON\n`,
        "release-manifest.json contains trailing content",
      );
      expectManifestFailureBeforeDocker(
        "manifest-structure-deviation",
        `${JSON.stringify({
          name: releaseManifest.name,
          createdAt: releaseManifest.createdAt,
          sourceRevision: releaseManifest.sourceRevision,
          imageSource: releaseManifest.imageSource,
          imageIds,
          images: requiredImages,
          files: releaseManifest.files,
        }, null, 2)}\n`,
        "release-manifest.json images must use the canonical array format",
      );
      expectManifestFailureBeforeDocker(
        "manifest-file-list-deviation",
        `${JSON.stringify({
          ...releaseManifest,
          files: releaseManifest.files.filter((file) => file.path !== "start.sh"),
        }, null, 2)}\n`,
        "release-manifest.json files does not exactly match the extracted payload",
      );
      writeFileSync(manifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8");

      writeFileSync(join(releaseRoot, "ec-data-images.tar"), "same name, tampered contents", "utf8");
      const tamperedPayload = run("tampered-payload");
      const tamperedOutput = `${tamperedPayload.result.stdout ?? ""}${tamperedPayload.result.stderr ?? ""}`;
      expect(tamperedPayload.result.status, tamperedOutput).not.toBe(0);
      expect(tamperedOutput).toContain("Release manifest file integrity check failed: ec-data-images.tar");
      expect(readCalls(tamperedPayload.log)).toBe("");
      writeFileSync(join(releaseRoot, "ec-data-images.tar"), "synthetic archive", "utf8");

      writeFileSync(manifestPath, `${JSON.stringify({
        ...releaseManifest,
        imageIds: { ...imageIds, "deploy-api:latest": `sha256:${"e".repeat(64)}` },
      }, null, 2)}\n`, "utf8");
      const manifestMismatch = run("manifest-mismatch");
      const manifestMismatchOutput = `${manifestMismatch.result.stdout ?? ""}${manifestMismatch.result.stderr ?? ""}`;
      expect(manifestMismatch.result.status, manifestMismatchOutput).not.toBe(0);
      expect(manifestMismatchOutput).toContain(
        "release-manifest.json and release-image-ids.txt disagree for deploy-api:latest",
      );
      const manifestMismatchCalls = readCalls(manifestMismatch.log);
      expect(manifestMismatchCalls).not.toContain("load -i");
      expectNoComposeDown(manifestMismatchCalls);
      writeFileSync(manifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8");

      const failed = run("post-up-failure", { POST_UP_FAIL: "1" });
      const failedOutput = `${failed.result.stdout ?? ""}${failed.result.stderr ?? ""}`;
      expect(failed.result.status, failedOutput).not.toBe(0);
      expect(failedOutput).toContain("Compose service web uses image");
      const failedCalls = readCalls(failed.log);
      expect(failedCalls).toContain(" stop");
      expectNoComposeDown(failedCalls);

      const configFailed = run("config-failure", { CONFIG_FAIL: "1" });
      expect(configFailed.result.status).not.toBe(0);
      const configCalls = readFileSync(configFailed.log, "utf8");
      expect(configCalls).toContain("config --quiet");
      expect(configCalls).not.toContain("load -i");
      expect(configCalls).not.toContain(" stop");
      expectNoComposeDown(configCalls);

      const upFailed = run("up-failure", { UP_FAIL: "1" });
      const upFailedOutput = `${upFailed.result.stdout ?? ""}${upFailed.result.stderr ?? ""}`;
      expect(upFailed.result.status).not.toBe(0);
      expect(upFailedOutput).toContain("synthetic partial startup failure");
      const upFailedCalls = readFileSync(upFailed.log, "utf8");
      expect(upFailedCalls).toContain("up -d --no-build --force-recreate");
      expect(upFailedCalls).toContain(" stop");
      expectNoComposeDown(upFailedCalls);

      expect(readFileSync(join(releaseRoot, "deploy/.env"), "utf8")).toBe(validEnvironment);
      writeFileSync(
        join(releaseRoot, "deploy/.env"),
        validEnvironment.replace("unique-admin-password", "change_me_admin_password"),
        "utf8",
      );
      const invalidEnvironment = run("invalid-environment");
      expect(invalidEnvironment.result.status).not.toBe(0);
      const invalidEnvironmentCalls = readCalls(invalidEnvironment.log);
      expect(invalidEnvironmentCalls).not.toContain("load -i");
      expectNoComposeDown(invalidEnvironmentCalls);

      writeFileSync(
        join(releaseRoot, "deploy/.env"),
        `${validEnvironment}ADMIN_PASSWORD=change_me_admin_password\n`,
        "utf8",
      );
      const duplicateEnvironment = run("duplicate-environment");
      expect(duplicateEnvironment.result.status).not.toBe(0);
      const duplicateEnvironmentCalls = readCalls(duplicateEnvironment.log);
      expect(duplicateEnvironmentCalls).not.toContain("load -i");
      expectNoComposeDown(duplicateEnvironmentCalls);

      writeFileSync(
        join(releaseRoot, "deploy/.env"),
        validEnvironment.replace(
          "unique-admin-password",
          '"change_me_admin_password"',
        ),
        "utf8",
      );
      const quotedEnvironment = run("quoted-environment");
      expect(quotedEnvironment.result.status).not.toBe(0);
      const quotedEnvironmentCalls = readCalls(quotedEnvironment.log);
      expect(quotedEnvironmentCalls).not.toContain("load -i");
      expectNoComposeDown(quotedEnvironmentCalls);

      writeFileSync(
        join(releaseRoot, "deploy/.env"),
        validEnvironment.replace(
          "unique-jwt-secret-that-is-longer-than-thirty-two-characters",
          "${UNSET:-x}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
        "utf8",
      );
      const interpolatedEnvironment = run("interpolated-environment");
      expect(interpolatedEnvironment.result.status).not.toBe(0);
      const interpolatedEnvironmentCalls = readCalls(interpolatedEnvironment.log);
      expect(interpolatedEnvironmentCalls).not.toContain("load -i");
      expectNoComposeDown(interpolatedEnvironmentCalls);

      writeFileSync(
        join(releaseRoot, "deploy/.env"),
        validEnvironment.replace("unique-admin-password", "tiny # comment makes the source line long"),
        "utf8",
      );
      const commentedEnvironment = run("commented-environment");
      expect(commentedEnvironment.result.status).not.toBe(0);
      const commentedEnvironmentCalls = readCalls(commentedEnvironment.log);
      expect(commentedEnvironmentCalls).not.toContain("load -i");
      expectNoComposeDown(commentedEnvironmentCalls);

      writeFileSync(
        join(releaseRoot, "deploy/.env"),
        validEnvironment.replace("unique-application-password", "aaaaaaaaaaaa@"),
        "utf8",
      );
      const uriUnsafeEnvironment = run("uri-unsafe-environment");
      expect(uriUnsafeEnvironment.result.status).not.toBe(0);
      const uriUnsafeEnvironmentCalls = readCalls(uriUnsafeEnvironment.log);
      expect(uriUnsafeEnvironmentCalls).not.toContain("load -i");
      expectNoComposeDown(uriUnsafeEnvironmentCalls);
      writeFileSync(join(releaseRoot, "deploy/.env"), validEnvironment, "utf8");

      writeFileSync(join(releaseRoot, "release-image-ids.txt"), contract.replace("postgres:16=", "redis:7-alpine="), "utf8");
      const invalid = run("invalid-contract");
      expect(invalid.result.status).not.toBe(0);
      const invalidCalls = readCalls(invalid.log);
      expect(invalidCalls).not.toContain("load -i");
      expectNoComposeDown(invalidCalls);
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  }, 45_000);



});
