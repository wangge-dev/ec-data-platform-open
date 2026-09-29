import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  SHEETJS_TARBALL_URL,
  computeTreeDigest,
  verifyDependencyDeclarations,
} from "./verify-sheetjs-package.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiPackageText = readFileSync(join(root, "apps", "api", "package.json"), "utf8");
const lockfileText = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");

test("tree digest is order-independent and binds paths plus bytes", () => {
  const first = { path: "a.txt", bytes: Buffer.from("alpha") };
  const second = { path: "nested/b.bin", bytes: Buffer.from([0, 1, 2, 255]) };
  const expected = "e2824f415dc14acd282508805b153109305df6a40ef194ee825e0e36bd3d03ef";

  assert.equal(computeTreeDigest([first, second]), expected);
  assert.equal(computeTreeDigest([second, first]), expected);
  assert.notEqual(
    computeTreeDigest([first, { ...second, bytes: Buffer.from([0, 1, 3, 255]) }]),
    expected,
  );
  assert.notEqual(
    computeTreeDigest([first, { ...second, path: "nested/c.bin" }]),
    expected,
  );
  assert.notEqual(
    computeTreeDigest([first, second, { path: "empty", kind: "directory" }]),
    expected,
  );
});

test("dependency declaration validation rejects a changed SheetJS URL", () => {
  verifyDependencyDeclarations({ apiPackageText, lockfileText });
  assert.throws(
    () => verifyDependencyDeclarations({
      apiPackageText: apiPackageText.replace(
        "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz",
        "https://example.invalid/xlsx.tgz",
      ),
      lockfileText,
    }),
    /must pin xlsx/,
  );
  assert.throws(
    () => verifyDependencyDeclarations({
      apiPackageText,
      lockfileText: lockfileText.replace(
        SHEETJS_TARBALL_URL,
        "https://example.invalid/xlsx.tgz",
      ),
    }),
    /xlsx importer|pinned SheetJS tarball/,
  );
});
