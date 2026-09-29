import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import path, { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SHEETJS_VERSION = "0.20.3";
export const SHEETJS_TARBALL_URL =
  "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz";
export const SHEETJS_EXPECTED_FILE_COUNT = 26;
export const SHEETJS_EXPECTED_DIRECTORY_COUNT = 3;
export const SHEETJS_EXPECTED_TREE_SHA256 =
  "825490eeef146d3c82e7011f0a3567f1d4a2d2529da107260c3f698392b2fc0b";

const TREE_HASH_DOMAIN = Buffer.from(
  "ec-data-platform/sheetjs-package-tree/v1\0",
  "utf8",
);
const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");

function fail(message) {
  throw new Error(`SheetJS integrity gate failed: ${message}`);
}

function normalizedLines(text, label) {
  if (text.charCodeAt(0) === 0xfeff) fail(`${label} must not contain a BOM`);
  const normalized = text.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) fail(`${label} contains a non-canonical carriage return`);
  return normalized.split("\n");
}

function indentation(line) {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
}

function findUniqueBlock(lines, exactHeader, indent, within = [0, lines.length]) {
  const expected = `${" ".repeat(indent)}${exactHeader}`;
  const matches = [];
  for (let index = within[0]; index < within[1]; index += 1) {
    if (lines[index] === expected) matches.push(index);
  }
  if (matches.length !== 1) {
    fail(`pnpm-lock.yaml must contain exactly one ${exactHeader} block at indentation ${indent}`);
  }
  const start = matches[0];
  let end = within[1];
  for (let index = start + 1; index < within[1]; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (indentation(line) <= indent) {
      end = index;
      break;
    }
  }
  return [start + 1, end];
}

function directProperties(lines, block, indent) {
  const properties = new Map();
  for (let index = block[0]; index < block[1]; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (indentation(line) !== indent) continue;
    const match = line.trim().match(/^([^:]+):(?: (.*))?$/);
    if (!match) fail(`pnpm-lock.yaml contains malformed content near line ${index + 1}`);
    const [, key, value = ""] = match;
    if (properties.has(key)) fail(`pnpm-lock.yaml contains duplicate ${key} properties`);
    properties.set(key, value);
  }
  return properties;
}

function xlsxHeaders(lines, section, indent) {
  const prefix = `${" ".repeat(indent)}xlsx@`;
  const headers = [];
  for (let index = section[0]; index < section[1]; index += 1) {
    if (indentation(lines[index]) === indent && lines[index].startsWith(prefix)) {
      headers.push({ index, line: lines[index] });
    }
  }
  return headers;
}

export function verifyDependencyDeclarations({ apiPackageText, lockfileText }) {
  let apiPackage;
  try {
    apiPackage = JSON.parse(apiPackageText);
  } catch {
    fail("apps/api/package.json is not valid JSON");
  }
  if (apiPackage?.dependencies?.xlsx !== SHEETJS_TARBALL_URL) {
    fail(`apps/api/package.json must pin xlsx to ${SHEETJS_TARBALL_URL}`);
  }
  for (const dependencyGroup of ["devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (Object.prototype.hasOwnProperty.call(apiPackage?.[dependencyGroup] ?? {}, "xlsx")) {
      fail(`apps/api/package.json must not declare a second xlsx entry in ${dependencyGroup}`);
    }
  }

  const lines = normalizedLines(lockfileText, "pnpm-lock.yaml");
  const importers = findUniqueBlock(lines, "importers:", 0);
  const apiImporter = findUniqueBlock(lines, "apps/api:", 2, importers);
  const apiDependencies = findUniqueBlock(lines, "dependencies:", 4, apiImporter);
  const xlsxImporter = findUniqueBlock(lines, "xlsx:", 6, apiDependencies);
  const importerProperties = directProperties(lines, xlsxImporter, 8);
  if (
    importerProperties.size !== 2
    || importerProperties.get("specifier") !== SHEETJS_TARBALL_URL
    || importerProperties.get("version") !== SHEETJS_TARBALL_URL
  ) {
    fail("pnpm-lock.yaml apps/api xlsx importer must contain only the pinned specifier and version");
  }

  const packages = findUniqueBlock(lines, "packages:", 0);
  const packageHeaders = xlsxHeaders(lines, packages, 2);
  const expectedPackageHeader = `  xlsx@${SHEETJS_TARBALL_URL}:`;
  if (packageHeaders.length !== 1 || packageHeaders[0].line !== expectedPackageHeader) {
    fail("pnpm-lock.yaml packages must contain exactly the pinned SheetJS tarball");
  }
  const packageBlock = findUniqueBlock(
    lines,
    `xlsx@${SHEETJS_TARBALL_URL}:`,
    2,
    packages,
  );
  const packageProperties = directProperties(lines, packageBlock, 4);
  if (
    packageProperties.get("resolution") !== `{tarball: ${SHEETJS_TARBALL_URL}}`
    || packageProperties.get("version") !== SHEETJS_VERSION
  ) {
    fail("pnpm-lock.yaml SheetJS package resolution or version does not match the pinned artifact");
  }

  const snapshots = findUniqueBlock(lines, "snapshots:", 0);
  const snapshotHeaders = xlsxHeaders(lines, snapshots, 2);
  const expectedSnapshotHeader = `  xlsx@${SHEETJS_TARBALL_URL}: {}`;
  if (snapshotHeaders.length !== 1 || snapshotHeaders[0].line !== expectedSnapshotHeader) {
    fail("pnpm-lock.yaml snapshots must contain exactly the pinned empty SheetJS snapshot");
  }
}

function compareUtf8Path(left, right) {
  return Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"));
}

export function computeTreeDigest(entries) {
  const ordered = [...entries].sort(compareUtf8Path);
  const seen = new Set();
  const hash = createHash("sha256");
  hash.update(TREE_HASH_DOMAIN);

  for (const entry of ordered) {
    if (typeof entry.path !== "string" || !entry.path || entry.path.includes("\\")) {
      fail("tree entries must use non-empty POSIX relative paths");
    }
    if (seen.has(entry.path)) fail(`duplicate package tree path: ${entry.path}`);
    seen.add(entry.path);
    const kind = entry.kind ?? "file";
    if (kind !== "file" && kind !== "directory") fail(`invalid tree entry type for ${entry.path}`);
    const bytes = kind === "directory"
      ? Buffer.alloc(0)
      : Buffer.isBuffer(entry.bytes)
        ? entry.bytes
        : Buffer.from(entry.bytes);
    if (kind === "directory" && entry.bytes !== undefined && entry.bytes.length !== 0) {
      fail(`directory tree entry must not contain bytes: ${entry.path}`);
    }
    const pathBytes = Buffer.from(entry.path, "utf8");
    const pathLength = Buffer.allocUnsafe(4);
    pathLength.writeUInt32BE(pathBytes.length);
    const fileLength = Buffer.allocUnsafe(8);
    fileLength.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(kind === "file" ? Buffer.from([0x46]) : Buffer.from([0x44]));
    hash.update(pathLength);
    hash.update(pathBytes);
    hash.update(fileLength);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function readPackageTree(packageRoot) {
  const entries = [];
  const validateGeneratedNodeModules = (nodeModulesPath) => {
    const topLevel = readdirSync(nodeModulesPath, { withFileTypes: true });
    if (
      topLevel.length !== 1
      || topLevel[0].name !== ".bin"
      || !topLevel[0].isDirectory()
    ) {
      fail("installed xlsx/node_modules may contain only pnpm's generated .bin directory");
    }
    const allowedShims = new Set(["xlsx", "xlsx.CMD", "xlsx.ps1"]);
    const shims = readdirSync(join(nodeModulesPath, ".bin"), { withFileTypes: true });
    if (!shims.some((entry) => entry.name === "xlsx")) {
      fail("installed xlsx/node_modules/.bin is missing the xlsx launcher");
    }
    for (const shim of shims) {
      if (!allowedShims.has(shim.name) || (!shim.isFile() && !shim.isSymbolicLink())) {
        fail(`unexpected entry in installed xlsx/node_modules/.bin: ${shim.name}`);
      }
    }
  };
  const visit = (directory, relativeDirectory = "") => {
    const children = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const child of children) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      const absolutePath = join(directory, child.name);
      const metadata = lstatSync(absolutePath);

      // pnpm generates dependency links and platform-specific executable shims
      // here. They are separate lockfile-managed packages, not bytes from the
      // SheetJS tarball, so they are deliberately outside this artifact hash.
      if (relativeDirectory === "" && child.name === "node_modules") {
        if (!metadata.isDirectory()) fail("installed xlsx/node_modules must be a directory");
        validateGeneratedNodeModules(absolutePath);
        continue;
      }
      if (metadata.isSymbolicLink()) fail(`unexpected symbolic link in SheetJS package: ${relativePath}`);
      if (metadata.isDirectory()) {
        entries.push({ path: relativePath, kind: "directory" });
        visit(absolutePath, relativePath);
      } else if (metadata.isFile()) {
        entries.push({ path: relativePath, kind: "file", bytes: readFileSync(absolutePath) });
      } else {
        fail(`unexpected filesystem entry in SheetJS package: ${relativePath}`);
      }
    }
  };
  visit(packageRoot);
  return entries;
}

export function resolveInstalledSheetJsRoot(root = repositoryRoot) {
  const apiPackagePath = join(root, "apps", "api", "package.json");
  const requireFromApi = createRequire(apiPackagePath);
  let cursor;
  try {
    cursor = dirname(realpathSync(requireFromApi.resolve("xlsx")));
  } catch {
    fail("xlsx is not installed for apps/api");
  }
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(cursor, "package.json");
    try {
      const metadata = JSON.parse(readFileSync(candidate, "utf8"));
      if (metadata?.name === "xlsx") {
        const packageRoot = realpathSync(cursor);
        const relativeRoot = relative(root, packageRoot);
        if (relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot)) {
          fail("installed xlsx package resolves outside the workspace");
        }
        if (metadata.version !== SHEETJS_VERSION) {
          fail(`installed xlsx version is ${metadata.version ?? "unknown"}, expected ${SHEETJS_VERSION}`);
        }
        return packageRoot;
      }
    } catch (error) {
      if (error instanceof SyntaxError) fail("installed xlsx package.json is invalid JSON");
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  fail("could not locate the installed xlsx package root");
}

export function verifySheetJsPackage(root = repositoryRoot) {
  const apiPackagePath = join(root, "apps", "api", "package.json");
  const lockfilePath = join(root, "pnpm-lock.yaml");
  verifyDependencyDeclarations({
    apiPackageText: readFileSync(apiPackagePath, "utf8"),
    lockfileText: readFileSync(lockfilePath, "utf8"),
  });

  const packageRoot = resolveInstalledSheetJsRoot(root);
  const entries = readPackageTree(packageRoot);
  const digest = computeTreeDigest(entries);
  const fileCount = entries.filter((entry) => entry.kind === "file").length;
  const directoryCount = entries.filter((entry) => entry.kind === "directory").length;
  if (fileCount !== SHEETJS_EXPECTED_FILE_COUNT) {
    fail(`installed SheetJS tree has ${fileCount} files, expected ${SHEETJS_EXPECTED_FILE_COUNT}`);
  }
  if (directoryCount !== SHEETJS_EXPECTED_DIRECTORY_COUNT) {
    fail(
      `installed SheetJS tree has ${directoryCount} directories, expected ${SHEETJS_EXPECTED_DIRECTORY_COUNT}`,
    );
  }
  if (digest !== SHEETJS_EXPECTED_TREE_SHA256) {
    fail(`installed SheetJS tree SHA-256 is ${digest}, expected ${SHEETJS_EXPECTED_TREE_SHA256}`);
  }
  return { digest, directoryCount, fileCount, version: SHEETJS_VERSION };
}

function main() {
  try {
    const verified = verifySheetJsPackage();
    console.log(
      `Verified official SheetJS ${verified.version}: ${verified.fileCount} files, ${verified.directoryCount} directories, tree SHA-256 ${verified.digest}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "SheetJS integrity gate failed");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) main();
