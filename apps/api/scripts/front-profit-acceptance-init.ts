import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

type Target = {
  label: string;
  example: string;
  destination: string;
};

type Options = {
  acceptanceDir: string;
  releaseDir: string;
};

function resolveFromRepo(value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(REPO_ROOT, value);
}

function repoRelative(value: string): string | null {
  const resolved = resolveFromRepo(value);
  const relative = path.relative(REPO_ROOT, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return relative.replaceAll(path.sep, "/");
  }
  return null;
}

function isIgnoredByGit(relativePath: string): boolean {
  const result = spawnSync(
    "git",
    ["check-ignore", "--quiet", "--", relativePath],
    { cwd: REPO_ROOT, stdio: "ignore", shell: false },
  );
  return result.status === 0;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    acceptanceDir: "front-profit-acceptance",
    releaseDir: "front-profit-production-release",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--acceptance-dir") {
      const next = argv[index + 1];
      if (!next) throw new Error("--acceptance-dir requires a path");
      options.acceptanceDir = next;
      index += 1;
    } else if (arg === "--release-dir") {
      const next = argv[index + 1];
      if (!next) throw new Error("--release-dir requires a path");
      options.releaseDir = next;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: pnpm --filter @ec/api run front-profit:acceptance-init -- [--acceptance-dir front-profit-acceptance] [--release-dir front-profit-production-release]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function assertDestinationBoundary(target: Target): string {
  const relative = repoRelative(target.destination);
  if (!relative) {
    throw new Error(`${target.label} destination must be inside the repository so git-ignore protection can be verified: ${target.destination}`);
  }
  if (!isIgnoredByGit(relative)) {
    throw new Error(`${target.label} destination is inside the repository but is not git-ignored: ${relative}`);
  }
  if (existsSync(target.destination)) {
    throw new Error(`${target.label} already exists; refusing to overwrite: ${relative}`);
  }
  return relative;
}

async function copyTemplate(target: Target): Promise<string> {
  const relative = assertDestinationBoundary(target);
  await mkdir(path.dirname(target.destination), { recursive: true });
  const content = await readFile(target.example, "utf8");
  await writeFile(target.destination, content, "utf8");
  return relative;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const acceptanceDir = resolveFromRepo(options.acceptanceDir);
  const releaseDir = resolveFromRepo(options.releaseDir);
  const targets: Target[] = [
    {
      label: "acceptance manifest",
      example: path.join(REPO_ROOT, "docs/front-profit-acceptance-manifest.example.json"),
      destination: path.join(acceptanceDir, "manifest.json"),
    },
    {
      label: "acceptance result manifest",
      example: path.join(REPO_ROOT, "docs/front-profit-acceptance-result.example.json"),
      destination: path.join(acceptanceDir, "result.json"),
    },
    {
      label: "production release manifest",
      example: path.join(REPO_ROOT, "docs/front-profit-production-release.example.json"),
      destination: path.join(releaseDir, "release.json"),
    },
  ];

  const created: string[] = [];
  for (const target of targets) {
    created.push(await copyTemplate(target));
  }

  console.log("FRONT_PROFIT_ACCEPTANCE_INIT_OK");
  for (const relative of created) console.log(`created=${relative}`);
  console.log("mode=templates_only");
  console.log("realSamples=not_used");
  console.log("next=fill manifest.json, then run front-profit:acceptance-preflight");
}

main().catch((error) => {
  console.error("FRONT_PROFIT_ACCEPTANCE_INIT_FAILED");
  console.error(`- ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
