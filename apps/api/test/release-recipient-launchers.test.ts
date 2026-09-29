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

describe("recipient release launcher integrity", () => {
  windowsTest("executes the PowerShell recipient launcher end to end with a fake Docker command", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "电商中台 PowerShell recipient "));
    const releaseRoot = join(sandbox, "离线发布包 with space");
    const binRoot = join(sandbox, "fake docker bin");
    const requiredImages = ["postgres:16", "redis:7-alpine", "deploy-api:latest", "deploy-web:latest"];
    const imageIds = Object.fromEntries(
      requiredImages.map((image, index) => [image, `sha256:${String(index + 1).repeat(64)}`]),
    );
    const releaseFiles = [
      "deploy/docker-compose.yml",
      "ec-data-images.tar",
      "release-image-ids.txt",
      "sha256.ps1",
      "start.ps1",
    ];
    const releaseManifest = {
      name: basename(releaseRoot),
      createdAt: "2026-08-08T00:00:00.000Z",
      sourceRevision: "a".repeat(40),
      imageSource: "local-build",
      images: requiredImages,
      imageIds,
      files: [] as ReturnType<typeof releaseFileRecord>[],
    };
    const containerIds = {
      postgres: "a".repeat(64),
      redis: "b".repeat(64),
      migrate: "c".repeat(64),
      api: "d".repeat(64),
      web: "e".repeat(64),
    };
    try {
      mkdirSync(join(releaseRoot, "deploy"), { recursive: true });
      mkdirSync(binRoot, { recursive: true });
      copyFileSync(resolve(root, "scripts/release-start.ps1"), join(releaseRoot, "start.ps1"));
      copyFileSync(resolve(root, "scripts/sha256.ps1"), join(releaseRoot, "sha256.ps1"));
      writeFileSync(join(releaseRoot, "release-image-ids.txt"),
        requiredImages.map((image) => `${image}=${imageIds[image]}`).join("\n") + "\n", "utf8");
      writeFileSync(join(releaseRoot, "ec-data-images.tar"), "synthetic archive", "utf8");
      writeFileSync(join(releaseRoot, "deploy/docker-compose.yml"), "services: {}\n", "utf8");
      writeFileSync(join(releaseRoot, "deploy/.env"), [
        "POSTGRES_PASSWORD=unique-postgres-password",
        "APP_DB_PASSWORD=unique-application-password",
        "ADMIN_PASSWORD=unique-admin-password",
        "JWT_SECRET=unique-jwt-secret-that-is-longer-than-thirty-two-characters",
        "",
      ].join("\n"), "utf8");
      releaseManifest.files = releaseFileRecords(releaseRoot, releaseFiles);
      writeFileSync(
        join(releaseRoot, "release-manifest.json"),
        `${JSON.stringify(releaseManifest, null, 2)}\n`,
        "utf8",
      );

      const fakeDockerJs = join(binRoot, "fake-docker.cjs");
      writeFileSync(fakeDockerJs, `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DOCKER_LOG, args.join(" ") + "\\n", "utf8");
const fail = (code, message) => { console.error(message); process.exit(code); };
if (args[0] === "version" || (args[0] === "compose" && args[1] === "version")) process.exit(0);
const composeAction = args[0] === "compose" ? args[5] : "";
if (composeAction === "config") {
  if (process.env.CONFIG_FAIL === "1") fail(7, "synthetic compose config failure");
  if (args[6] === "--services") {
    console.log(process.env.EXTRA_SERVICE === "1"
      ? "postgres\\nredis\\nmigrate\\napi\\nweb\\nevil"
      : "postgres\\nredis\\nmigrate\\napi\\nweb");
  }
  process.exit(0);
}
if (args[0] === "load") {
  if (args.length !== 3 || args[1] !== "-i" || !path.isAbsolute(args[2]) ||
      !args[2].includes("电商中台 PowerShell recipient") ||
      !args[2].endsWith("离线发布包 with space\\\\ec-data-images.tar")) {
    fail(5, "archive path was not preserved as one absolute Unicode argument");
  }
  if (process.env.LOAD_FAIL === "1") fail(6, "synthetic docker load failure");
  process.exit(0);
}
if (composeAction === "up") {
  if (process.env.UP_FAIL === "1") fail(8, "synthetic partial startup failure");
  process.exit(0);
}
if (composeAction === "stop") {
  if (process.env.STOP_FAIL === "1") fail(9, "synthetic stop failure");
  process.exit(0);
}
if (args[0] === "image" && args[1] === "inspect") {
  console.error("synthetic inspect diagnostic on stderr");
  const ids = ${JSON.stringify(imageIds)};
  if (!ids[args[4]]) fail(11, "unknown image");
  console.log(ids[args[4]]);
  process.exit(0);
}
if (composeAction === "ps") {
  const containers = ${JSON.stringify(containerIds)};
  const service = args.at(-1);
  if (!containers[service]) fail(12, "unknown service");
  console.log(containers[service]);
  process.exit(0);
}
if (args[0] === "inspect" && args[2] === "{{.Image}}") {
  const images = {
    "${containerIds.postgres}": "${imageIds["postgres:16"]}",
    "${containerIds.redis}": "${imageIds["redis:7-alpine"]}",
    "${containerIds.migrate}": "${imageIds["deploy-api:latest"]}",
    "${containerIds.api}": "${imageIds["deploy-api:latest"]}",
    "${containerIds.web}": "${imageIds["deploy-web:latest"]}"
  };
  if (!images[args[3]]) fail(13, "unknown container");
  console.log(images[args[3]]);
  process.exit(0);
}
if (args[0] === "inspect" && args[2] === "{{json .State}}") {
  if (args[3] === "${containerIds.migrate}") {
    console.log(JSON.stringify({ Status: "exited", ExitCode: 0, Health: null }));
  } else if (process.env.HEALTH_FAIL === "1" && args[3] === "${containerIds.web}") {
    console.log(JSON.stringify({ Status: "running", ExitCode: 0, Health: { Status: "unhealthy" } }));
  } else {
    console.log(JSON.stringify({ Status: "running", ExitCode: 0, Health: { Status: "healthy" } }));
  }
  process.exit(0);
}
fail(99, "unknown fake Docker command: " + args.join(" "));
`, "utf8");
      writeFileSync(
        join(binRoot, "docker.cmd"),
        '@echo off\r\n"%FAKE_NODE_EXE%" "%FAKE_DOCKER_JS%" %*\r\nexit /b %ERRORLEVEL%\r\n',
        "utf8",
      );

      const run = (name: string, extraEnv: Record<string, string> = {}) => {
        const log = join(sandbox, `${name}.log`);
        const result = spawnSync(
          "powershell.exe",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(releaseRoot, "start.ps1")],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${binRoot};${process.env.PATH ?? ""}`,
              DOCKER_LOG: log,
              FAKE_NODE_EXE: process.execPath,
              FAKE_DOCKER_JS: fakeDockerJs,
              ...extraEnv,
            },
          },
        );
        return { result, log };
      };

      const success = run("success");
      const successOutput = `${success.result.stdout ?? ""}${success.result.stderr ?? ""}`;
      expect(success.result.status, successOutput).toBe(0);
      expect(successOutput).not.toContain("synthetic inspect diagnostic on stderr");
      const successCalls = readFileSync(success.log, "utf8");
      expect(successCalls.indexOf("config --quiet"))
        .toBeLessThan(successCalls.indexOf("load -i"));
      expect(successCalls).toContain("up -d --no-build --force-recreate");
      expect(successCalls).toContain("离线发布包 with space\\ec-data-images.tar");
      expect(successCalls).not.toContain(" stop");

      const validWindowsEnvironment = readFileSync(join(releaseRoot, "deploy/.env"), "utf8");
      writeFileSync(join(releaseRoot, "deploy/.env"), `${validWindowsEnvironment}COMPOSE_FILE=../../evil.yml\n`, "utf8");
      const composeFileOverride = run("compose-file-override");
      expect(composeFileOverride.result.status).not.toBe(0);
      expect(existsSync(composeFileOverride.log)).toBe(false);
      writeFileSync(join(releaseRoot, "deploy/.env"), validWindowsEnvironment, "utf8");

      const unexpectedService = run("unexpected-service", { EXTRA_SERVICE: "1" });
      expect(unexpectedService.result.status).not.toBe(0);
      const unexpectedServiceCalls = readFileSync(unexpectedService.log, "utf8");
      expect(unexpectedServiceCalls).toContain("config --services");
      expect(unexpectedServiceCalls).not.toContain("load -i");
      expect(unexpectedServiceCalls).not.toContain(" up ");

      writeFileSync(join(releaseRoot, "ec-data-images.tar"), "same name, tampered contents", "utf8");
      const tamperedPayload = run("tampered-payload");
      const tamperedOutput = `${tamperedPayload.result.stdout ?? ""}${tamperedPayload.result.stderr ?? ""}`;
      expect(tamperedPayload.result.status, tamperedOutput).not.toBe(0);
      expect(tamperedOutput).toContain("Release manifest file integrity check failed: ec-data-images.tar");
      expect(existsSync(tamperedPayload.log)).toBe(false);
      writeFileSync(join(releaseRoot, "ec-data-images.tar"), "synthetic archive", "utf8");

      const loadFailed = run("load-failure", { LOAD_FAIL: "1" });
      const loadOutput = `${loadFailed.result.stdout ?? ""}${loadFailed.result.stderr ?? ""}`;
      expect(loadFailed.result.status, loadOutput).not.toBe(0);
      expect(loadOutput).toContain("synthetic docker load failure");
      const loadCalls = readFileSync(loadFailed.log, "utf8");
      expect(loadCalls).toContain("load -i");
      expect(loadCalls).not.toContain("compose up");
      expect(loadCalls).not.toContain(" stop");

      const unhealthy = run("health-failure", { HEALTH_FAIL: "1" });
      const unhealthyOutput = `${unhealthy.result.stdout ?? ""}${unhealthy.result.stderr ?? ""}`;
      expect(unhealthy.result.status, unhealthyOutput).not.toBe(0);
      expect(unhealthyOutput).toContain("Release service web failed");
      expect(readFileSync(unhealthy.log, "utf8")).toContain(" stop");

      const upAndStopFailed = run("up-and-stop-failure", { UP_FAIL: "1", STOP_FAIL: "1" });
      const upAndStopOutput = `${upAndStopFailed.result.stdout ?? ""}${upAndStopFailed.result.stderr ?? ""}`;
      expect(upAndStopFailed.result.status, upAndStopOutput).not.toBe(0);
      expect(upAndStopOutput).toContain("synthetic partial startup failure");
      expect(upAndStopOutput).toContain("Failed to stop the unsuccessful release");
      const upAndStopCalls = readFileSync(upAndStopFailed.log, "utf8");
      expect(upAndStopCalls).toContain("up -d --no-build --force-recreate");
      expect(upAndStopCalls).toContain(" stop");

      const configFailed = run("config-failure", { CONFIG_FAIL: "1" });
      expect(configFailed.result.status).not.toBe(0);
      const configCalls = readFileSync(configFailed.log, "utf8");
      expect(configCalls).toContain("config --quiet");
      expect(configCalls).not.toContain("load -i");
      expect(configCalls).not.toContain(" stop");
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  }, 30_000);


});
