import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const apiRoot = resolve(repoRoot, "apps/api");
const tsxCli = resolve(apiRoot, "node_modules/tsx/dist/cli.mjs");
const scriptPath = resolve(apiRoot, "scripts/front-profit-acceptance-init.ts");
const acceptanceDir = "front-profit-acceptance/init-test";
const releaseDir = "front-profit-production-release/init-test";
const createdRoots = [
  join(repoRoot, "front-profit-acceptance/init-test"),
  join(repoRoot, "front-profit-production-release/init-test"),
  join(repoRoot, "docs/front-profit-acceptance-init-test"),
];

function runInit(args: string[]) {
  return spawnSync(process.execPath, [tsxCli, scriptPath, ...args], {
    cwd: apiRoot,
    encoding: "utf8",
  });
}

describe("front-profit acceptance init", () => {
  afterEach(() => {
    for (const root of createdRoots) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("creates ignored placeholder manifests from the checked-in examples and refuses overwrite", () => {
    const result = runInit([
      "--acceptance-dir",
      acceptanceDir,
      "--release-dir",
      releaseDir,
    ]);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("FRONT_PROFIT_ACCEPTANCE_INIT_OK");
    expect(output).toContain("mode=templates_only");
    expect(output).toContain("realSamples=not_used");

    const files = [
      [
        "docs/front-profit-acceptance-manifest.example.json",
        "front-profit-acceptance/init-test/manifest.json",
      ],
      [
        "docs/front-profit-acceptance-result.example.json",
        "front-profit-acceptance/init-test/result.json",
      ],
      [
        "docs/front-profit-production-release.example.json",
        "front-profit-production-release/init-test/release.json",
      ],
    ] as const;
    for (const [example, created] of files) {
      expect(readFileSync(join(repoRoot, created), "utf8"))
        .toBe(readFileSync(join(repoRoot, example), "utf8"));
    }

    const second = runInit([
      "--acceptance-dir",
      acceptanceDir,
      "--release-dir",
      releaseDir,
    ]);
    const secondOutput = `${second.stdout ?? ""}${second.stderr ?? ""}`;
    expect(second.status, secondOutput).not.toBe(0);
    expect(secondOutput).toContain("already exists; refusing to overwrite");
  });

  test("rejects manifest destinations that are inside the repo but not git-ignored", () => {
    const result = runInit([
      "--acceptance-dir",
      "docs/front-profit-acceptance-init-test",
      "--release-dir",
      releaseDir,
    ]);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    expect(result.status, output).not.toBe(0);
    expect(output).toContain("not git-ignored");
    expect(existsSync(join(repoRoot, "docs/front-profit-acceptance-init-test/manifest.json"))).toBe(false);
  });
});
