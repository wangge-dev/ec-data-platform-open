import {
  appendFileSync,
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
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const hostPowerShell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const powerShellAvailable = spawnSync(
  hostPowerShell,
  ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
  { stdio: "ignore" },
).status === 0;
const powerShellTest = powerShellAvailable ? test : test.skip;
const revisionA = "a".repeat(40);
const revisionB = "b".repeat(40);

const copyRuntimeScript = (runtimeRoot: string, sourceName: string, targetName = sourceName) => {
  copyFileSync(resolve(root, "scripts", sourceName), join(runtimeRoot, targetName));
};

const makeRuntime = (sandbox: string, name: string, instanceId: string, revision = revisionA) => {
  const runtimeRoot = join(sandbox, name);
  mkdirSync(join(runtimeRoot, "deploy"), { recursive: true });
  writeFileSync(join(runtimeRoot, "deploy/.env"), [
    `INSTANCE_ID=${instanceId}`,
    `COMPOSE_PROJECT_NAME=${instanceId}`,
    "POSTGRES_PASSWORD=postgres-secret-1",
    "APP_DB_PASSWORD=application-secret-2",
    "ADMIN_PASSWORD=administrator-secret-3",
    `JWT_SECRET=${"j".repeat(40)}`,
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(runtimeRoot, "deploy/docker-compose.yml"), "services: {}\n", "utf8");
  writeFileSync(join(runtimeRoot, "release-manifest.json"), JSON.stringify({ sourceRevision: revision }), "utf8");
  copyRuntimeScript(runtimeRoot, "sha256.ps1");
  copyRuntimeScript(runtimeRoot, "instance-backup.ps1", "backup.ps1");
  copyRuntimeScript(runtimeRoot, "instance-restore.ps1", "restore.ps1");
  return runtimeRoot;
};

const makeFakeDocker = (sandbox: string) => {
  const binRoot = join(sandbox, "fake-bin");
  mkdirSync(binRoot, { recursive: true });
  const fake = String.raw`
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\n", "utf8");
const ids = {
  postgres: "1".repeat(64),
  redis: "2".repeat(64),
  migrate: "3".repeat(64),
  api: "4".repeat(64),
  web: "5".repeat(64),
};
const serviceById = Object.fromEntries(Object.entries(ids).map(([service, id]) => [id, service]));

if (args[0] === "compose") {
  const commandIndex = args.findIndex((value, index) => index > 0 && ["config", "ps", "exec", "stop", "up"].includes(value));
  const command = args[commandIndex];
  const tail = args.slice(commandIndex + 1);
  if (command === "config") process.exit(0);
  if (command === "ps") {
    const service = tail.at(-1);
    if (ids[service]) process.stdout.write(ids[service] + "\n");
    process.exit(ids[service] ? 0 : 1);
  }
  if (command === "exec") {
    const service = tail[1];
    const executable = tail[2];
    if (service === "postgres" && executable === "pg_restore" && tail.includes("-U") && process.env.FAKE_DOCKER_FAIL_RESTORE === "1") {
      process.stderr.write("INJECTED_DATABASE_RESTORE_FAILURE\n");
      process.exit(41);
    }
    process.exit(0);
  }
  if (command === "stop" || command === "up") process.exit(0);
}

if (args[0] === "inspect") {
  const format = args[2];
  const id = args[3];
  if (format.includes("State.Running")) {
    process.stdout.write("true\n");
    process.exit(0);
  }
  if (format.includes("State.Status")) {
    const service = serviceById[id];
    process.stdout.write(service === "migrate" ? "exited||0\n" : "running|healthy|0\n");
    process.exit(service ? 0 : 1);
  }
}

if (args[0] === "cp") {
  const source = args[1];
  const destination = args[2];
  if (/^[0-9a-f]{64}:/.test(source)) {
    writeFileSync(destination, Buffer.from("PGDMP synthetic instance backup\n", "utf8"));
  }
  process.exit(0);
}

process.stderr.write("Unsupported fake docker call: " + JSON.stringify(args) + "\n");
process.exit(97);
`;
  writeFileSync(join(binRoot, "fake-docker.mjs"), fake, "utf8");
  if (process.platform === "win32") {
    writeFileSync(join(binRoot, "docker.cmd"), "@echo off\r\nnode \"%~dp0fake-docker.mjs\" %*\r\n", "utf8");
  } else {
    const launcher = join(binRoot, "docker");
    writeFileSync(
      launcher,
      "#!/usr/bin/env bash\nexec node \"$(dirname \"$0\")/fake-docker.mjs\" \"$@\"\n",
      "utf8",
    );
    chmodSync(launcher, 0o755);
  }
  return binRoot;
};

const cleanEnvironment = (extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const name of Object.keys(env)) {
    if (name.startsWith("COMPOSE_") || name.startsWith("DOCKER_")) delete env[name];
  }
  return env;
};

const runPowerShell = (script: string, args: string[], env: NodeJS.ProcessEnv) => spawnSync(
  hostPowerShell,
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
  { encoding: "utf8", env, timeout: 30_000 },
);

const readCalls = (logPath: string): string[][] => existsSync(logPath)
  ? readFileSync(logPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  : [];

const commandText = (call: string[]) => call.join(" ");
const normalizePowerShellOutput = (value: string) => value
  .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/[\s|]+/g, "");

describe("instance backup and restore operator contract", () => {
  test("ships mirrored scripts with a strict sensitive-data manifest contract", () => {
    const scripts = [
      "scripts/instance-backup.ps1",
      "scripts/instance-restore.ps1",
      "scripts/instance-backup.sh",
      "scripts/instance-restore.sh",
    ].map((path) => readFileSync(resolve(root, path), "utf8"));
    for (const script of scripts) {
      expect(script).toContain("instance-backup/v1");
      expect(script).toContain("containsBusinessData");
      expect(script).toContain("containsSecrets");
      expect(script).toContain("environmentIncluded");
      expect(script).toContain("sourceReleaseRevision");
      expect(script).toContain("INSTANCE_ID");
      expect(script).toContain("status --porcelain --untracked-files=normal");
    }
    expect(readFileSync(resolve(root, "scripts/package-release.ps1"), "utf8")).toContain("instance-backup.ps1");
    expect(readFileSync(resolve(root, "scripts/package-release.sh"), "utf8")).toContain("instance-restore.sh");
    expect(readFileSync(resolve(root, "deploy/.env.example"), "utf8")).toContain("INSTANCE_ID=change_me_instance_id");
  });

  powerShellTest("refuses to label a backup from a dirty source worktree before Docker", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ec-instance-dirty-revision-"));
    try {
      const sourceRoot = makeRuntime(sandbox, "source-runtime", "tenant_source");
      mkdirSync(join(sourceRoot, ".git"));
      const backupRoot = join(sandbox, "secure-backups");
      mkdirSync(backupRoot);
      const binRoot = makeFakeDocker(sandbox);
      if (process.platform === "win32") {
        writeFileSync(
          join(binRoot, "git.cmd"),
          "@echo off\r\nif \"%~3\"==\"status\" (echo  M tracked.txt& exit /b 0)\r\nexit /b 1\r\n",
          "utf8",
        );
      } else {
        const fakeGit = join(binRoot, "git");
        writeFileSync(
          fakeGit,
          "#!/usr/bin/env bash\nif [ \"$3\" = status ]; then printf ' M tracked.txt\\n'; exit 0; fi\nexit 1\n",
          "utf8",
        );
        chmodSync(fakeGit, 0o755);
      }
      const logPath = join(sandbox, "docker.log");
      const result = runPowerShell(
        join(sourceRoot, "backup.ps1"),
        ["-OutputRoot", backupRoot],
        cleanEnvironment({
          FAKE_DOCKER_LOG: logPath,
          PATH: `${binRoot}${delimiter}${process.env.PATH ?? ""}`,
        }),
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.status, output).not.toBe(0);
      expect(normalizePowerShellOutput(output)).toContain("dirtysourceworktree");
      expect(existsSync(logPath)).toBe(false);
      expect(readdirSync(backupRoot)).toHaveLength(0);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  powerShellTest("backs up and restores through fake Docker with validation before mutation", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ec-instance-lifecycle-"));
    try {
      const sourceRoot = makeRuntime(sandbox, "source-runtime", "tenant_source");
      const targetRoot = makeRuntime(sandbox, "target-runtime", "tenant_target");
      const backupRoot = join(sandbox, "secure-backups");
      mkdirSync(backupRoot);
      const binRoot = makeFakeDocker(sandbox);
      const logPath = join(sandbox, "docker.log");
      const env = cleanEnvironment({
        FAKE_DOCKER_LOG: logPath,
        PATH: `${binRoot}${delimiter}${process.env.PATH ?? ""}`,
      });

      const backupResult = runPowerShell(
        join(sourceRoot, "backup.ps1"),
        ["-OutputRoot", backupRoot],
        env,
      );
      const backupOutput = `${backupResult.stdout ?? ""}${backupResult.stderr ?? ""}`;
      expect(backupResult.status, backupOutput).toBe(0);
      const backupDirectories = readdirSync(backupRoot);
      expect(backupDirectories).toHaveLength(1);
      const backupPath = join(backupRoot, backupDirectories[0]!);
      const dump = readFileSync(join(backupPath, "ec_data.dump"));
      const manifest = readFileSync(join(backupPath, "backup-manifest.txt"), "utf8");
      expect(manifest).toContain("sourceInstanceId=tenant_source\n");
      expect(manifest).toContain(`sourceReleaseRevision=${revisionA}\n`);
      expect(manifest).toContain(`fileBytes=${dump.length}\n`);
      expect(manifest).toContain(`fileSha256=${createHash("sha256").update(dump).digest("hex")}\n`);

      writeFileSync(logPath, "", "utf8");
      const restoreResult = runPowerShell(
        join(targetRoot, "restore.ps1"),
        [
          "-BackupPath", backupPath,
          "-ConfirmInstanceId", "tenant_target",
          "-AcknowledgeDataOverwrite",
        ],
        env,
      );
      const restoreOutput = `${restoreResult.stdout ?? ""}${restoreResult.stderr ?? ""}`;
      expect(restoreResult.status, restoreOutput).toBe(0);
      expect(restoreOutput).toContain("source instance 'tenant_source'");
      expect(restoreOutput).toContain("target 'tenant_target'");

      const calls = readCalls(logPath).map(commandText);
      const validateIndex = calls.findIndex((call) => call.includes("exec -T postgres pg_restore --list"));
      const stopIndex = calls.findIndex((call) => call.includes(" stop api migrate"));
      const dropIndex = calls.findIndex((call) => call.includes("exec -T postgres dropdb -U ec --if-exists --force ec_data"));
      const createIndex = calls.findIndex((call) => call.includes("exec -T postgres createdb -U ec -O ec ec_data"));
      const restoreIndex = calls.findIndex((call) => call.includes("pg_restore -U ec -d ec_data --no-owner"));
      const redisIndex = calls.findIndex((call) => call.includes("exec -T redis redis-cli FLUSHDB"));
      const upIndex = calls.findIndex((call) => call.includes(" up -d --no-build --force-recreate migrate api web"));
      expect(validateIndex).toBeGreaterThanOrEqual(0);
      expect(validateIndex).toBeLessThan(stopIndex);
      expect(stopIndex).toBeLessThan(dropIndex);
      expect(dropIndex).toBeLessThan(createIndex);
      expect(createIndex).toBeLessThan(restoreIndex);
      expect(restoreIndex).toBeLessThan(redisIndex);
      expect(redisIndex).toBeLessThan(upIndex);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 60_000);

  powerShellTest("rejects wrong target confirmation and tampered bytes before Docker", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ec-instance-reject-"));
    try {
      const sourceRoot = makeRuntime(sandbox, "source-runtime", "tenant_source");
      const targetRoot = makeRuntime(sandbox, "target-runtime", "tenant_target");
      const backupRoot = join(sandbox, "secure-backups");
      mkdirSync(backupRoot);
      const binRoot = makeFakeDocker(sandbox);
      const logPath = join(sandbox, "docker.log");
      const env = cleanEnvironment({ FAKE_DOCKER_LOG: logPath, PATH: `${binRoot}${delimiter}${process.env.PATH ?? ""}` });
      const backupResult = runPowerShell(join(sourceRoot, "backup.ps1"), ["-OutputRoot", backupRoot], env);
      expect(backupResult.status, `${backupResult.stdout ?? ""}${backupResult.stderr ?? ""}`).toBe(0);
      const backupPath = join(backupRoot, readdirSync(backupRoot)[0]!);

      rmSync(logPath, { force: true });
      const wrongTarget = runPowerShell(
        join(targetRoot, "restore.ps1"),
        ["-BackupPath", backupPath, "-ConfirmInstanceId", "someone_else", "-AcknowledgeDataOverwrite"],
        env,
      );
      expect(wrongTarget.status).not.toBe(0);
      expect(`${wrongTarget.stdout ?? ""}${wrongTarget.stderr ?? ""}`).toContain("must exactly match target INSTANCE_ID");
      expect(existsSync(logPath)).toBe(false);

      appendFileSync(join(backupPath, "ec_data.dump"), "tampered", "utf8");
      const tampered = runPowerShell(
        join(targetRoot, "restore.ps1"),
        ["-BackupPath", backupPath, "-ConfirmInstanceId", "tenant_target", "-AcknowledgeDataOverwrite"],
        env,
      );
      expect(tampered.status).not.toBe(0);
      expect(`${tampered.stdout ?? ""}${tampered.stderr ?? ""}`).toMatch(/byte count|SHA-256/);
      expect(existsSync(logPath)).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 60_000);

  powerShellTest("requires cross-revision acknowledgement and fails closed after restore errors", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ec-instance-fail-closed-"));
    try {
      const sourceRoot = makeRuntime(sandbox, "source-runtime", "tenant_source", revisionA);
      const targetRoot = makeRuntime(sandbox, "target-runtime", "tenant_target", revisionB);
      const backupRoot = join(sandbox, "secure-backups");
      mkdirSync(backupRoot);
      const binRoot = makeFakeDocker(sandbox);
      const logPath = join(sandbox, "docker.log");
      const baseEnv = cleanEnvironment({ FAKE_DOCKER_LOG: logPath, PATH: `${binRoot}${delimiter}${process.env.PATH ?? ""}` });
      const backupResult = runPowerShell(join(sourceRoot, "backup.ps1"), ["-OutputRoot", backupRoot], baseEnv);
      expect(backupResult.status, `${backupResult.stdout ?? ""}${backupResult.stderr ?? ""}`).toBe(0);
      const backupPath = join(backupRoot, readdirSync(backupRoot)[0]!);

      rmSync(logPath, { force: true });
      const mismatch = runPowerShell(
        join(targetRoot, "restore.ps1"),
        ["-BackupPath", backupPath, "-ConfirmInstanceId", "tenant_target", "-AcknowledgeDataOverwrite"],
        baseEnv,
      );
      expect(mismatch.status).not.toBe(0);
      expect(normalizePowerShellOutput(`${mismatch.stdout ?? ""}${mismatch.stderr ?? ""}`)).toContain("notprovenidentical");
      expect(existsSync(logPath)).toBe(false);

      const failed = runPowerShell(
        join(targetRoot, "restore.ps1"),
        [
          "-BackupPath", backupPath,
          "-ConfirmInstanceId", "tenant_target",
          "-AcknowledgeDataOverwrite",
          "-AcknowledgeReleaseMismatch",
        ],
        cleanEnvironment({
          FAKE_DOCKER_LOG: logPath,
          FAKE_DOCKER_FAIL_RESTORE: "1",
          PATH: `${binRoot}${delimiter}${process.env.PATH ?? ""}`,
        }),
      );
      const output = `${failed.stdout ?? ""}${failed.stderr ?? ""}`;
      expect(failed.status, output).not.toBe(0);
      const normalizedOutput = normalizePowerShellOutput(output);
      expect(normalizedOutput).toContain("INJECTED_DATABASE_RESTORE_FAILURE");
      expect(normalizedOutput).toContain("stoppedtofailclosed");
      const calls = readCalls(logPath).map(commandText);
      expect(calls.filter((call) => call.includes(" stop api migrate")).length).toBeGreaterThanOrEqual(2);
      expect(calls.some((call) => call.includes(" up -d"))).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 60_000);
});
