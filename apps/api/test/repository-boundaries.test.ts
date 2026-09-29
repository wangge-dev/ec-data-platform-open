import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const boundaryScript = resolve(root, "scripts/check-repository-boundaries.mjs");
const sandboxes: string[] = [];
const templateNames = [
  "01-电商前台利润单表上传模板.xlsx",
  "02-电商前台利润数据准备与映射模板.xlsx",
];
const ecommerceSampleNames = [
  "pdd_ads_account_day.xlsx",
  "pdd_ads_product_period.xlsx",
  "pdd_order_item.xlsx",
  "taobao_category_month.xlsx",
  "taobao_price_band_day.xlsx",
  "taobao_terminal_day.xlsx",
  "taobao_trade_day.xlsx",
];

const git = (cwd: string, args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
};

const digest = (content: Buffer) => createHash("sha256").update(content).digest("hex").toUpperCase();

const prepareRepository = () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ec-boundary-front-profit-"));
  sandboxes.push(sandbox);
  mkdirSync(join(sandbox, "scripts"), { recursive: true });
  mkdirSync(join(sandbox, "templates/front-profit"), { recursive: true });
  mkdirSync(join(sandbox, "apps/api/scripts/ecommerce-intake"), { recursive: true });
  copyFileSync(boundaryScript, join(sandbox, "scripts/check-repository-boundaries.mjs"));
  writeFileSync(
    join(sandbox, "apps/api/scripts/ecommerce-intake/verify-workbench-share-samples.mjs"),
    "process.exit(0);\n",
    "utf8",
  );

  const contents = [Buffer.from("controlled-template-one"), Buffer.from("controlled-template-two")];
  for (const [index, name] of templateNames.entries()) {
    writeFileSync(join(sandbox, "templates/front-profit", name), contents[index]);
  }

  writeFileSync(
    join(sandbox, "templates/front-profit/template-manifest.json"),
    `${JSON.stringify({
      containsRealBusinessData: false,
      files: templateNames.map((name, index) => ({
        name,
        sha256: digest(contents[index]),
        businessDataRows: 0,
      })),
    }, null, 2)}\n`,
    "utf8",
  );

  git(sandbox, ["init", "--quiet"]);
  git(sandbox, ["add", "--", "apps", "scripts", "templates"]);
  return sandbox;
};

const runBoundaryCheck = (cwd: string) => spawnSync(
  process.execPath,
  ["scripts/check-repository-boundaries.mjs", "--mode=private"],
  { cwd, encoding: "utf8" },
);

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) {
    rmSync(sandbox, { force: true, recursive: true });
  }
});

describe("controlled front-profit workbook repository boundary", () => {
  test("allows exactly the two manifest-pinned sanitized workbooks", () => {
    const sandbox = prepareRepository();
    const result = runBoundaryCheck(sandbox);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Repository boundary check passed");
  });

  test("allows the checked-in real-sample acceptance template and example manifests", () => {
    const sandbox = prepareRepository();
    mkdirSync(join(sandbox, "docs"), { recursive: true });
    writeFileSync(
      join(sandbox, "docs/front-profit-real-sample-acceptance-template.md"),
      "# Front-profit acceptance template\n",
      "utf8",
    );
    writeFileSync(
      join(sandbox, "docs/front-profit-acceptance-manifest.example.json"),
      `${JSON.stringify({
        schemaVersion: "front-profit-real-sample-acceptance/v1",
        mode: "template",
      })}\n`,
      "utf8",
    );
    writeFileSync(
      join(sandbox, "docs/front-profit-acceptance-result.example.json"),
      `${JSON.stringify({
        schemaVersion: "front-profit-real-sample-acceptance-result/v1",
        mode: "template",
      })}\n`,
      "utf8",
    );
    writeFileSync(
      join(sandbox, "docs/front-profit-production-release.example.json"),
      `${JSON.stringify({
        schemaVersion: "front-profit-production-release/v1",
        mode: "template",
      })}\n`,
      "utf8",
    );
    git(sandbox, ["add", "--", "docs"]);

    const result = runBoundaryCheck(sandbox);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Repository boundary check passed");
  });

  test("rejects a workbook whose bytes no longer match the manifest", () => {
    const sandbox = prepareRepository();
    writeFileSync(
      join(sandbox, "templates/front-profit", templateNames[0]),
      Buffer.from("tampered-template"),
    );
    const result = runBoundaryCheck(sandbox);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SHA-256 does not match");
  });

  test("rejects any additional tracked workbook", () => {
    const sandbox = prepareRepository();
    writeFileSync(join(sandbox, "templates/front-profit/extra.xlsx"), Buffer.from("extra"));
    git(sandbox, ["add", "--", "templates/front-profit/extra.xlsx"]);
    const result = runBoundaryCheck(sandbox);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("extra.xlsx: forbidden tracked data or secret extension");
  });

  test("allows only the complete semantic-verified ecommerce workbench sample set", () => {
    const sandbox = prepareRepository();
    mkdirSync(join(sandbox, "templates/ecommerce-workbench/samples"), { recursive: true });
    for (const name of ecommerceSampleNames) {
      writeFileSync(
        join(sandbox, "templates/ecommerce-workbench/samples", name),
        Buffer.from(`synthetic-${name}`),
      );
    }
    git(sandbox, ["add", "--", "templates/ecommerce-workbench/samples"]);

    const result = runBoundaryCheck(sandbox);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Repository boundary check passed");
  });

  test("rejects an incomplete ecommerce workbench sample set", () => {
    const sandbox = prepareRepository();
    mkdirSync(join(sandbox, "templates/ecommerce-workbench/samples"), { recursive: true });
    writeFileSync(
      join(sandbox, "templates/ecommerce-workbench/samples", ecommerceSampleNames[0]),
      Buffer.from("synthetic-incomplete"),
    );
    git(sandbox, ["add", "--", "templates/ecommerce-workbench/samples"]);

    const result = runBoundaryCheck(sandbox);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("required controlled ecommerce workbench sample is not tracked");
  });

  test("rejects ecommerce workbench samples when semantic verification fails", () => {
    const sandbox = prepareRepository();
    mkdirSync(join(sandbox, "templates/ecommerce-workbench/samples"), { recursive: true });
    for (const name of ecommerceSampleNames) {
      writeFileSync(
        join(sandbox, "templates/ecommerce-workbench/samples", name),
        Buffer.from(`synthetic-${name}`),
      );
    }
    writeFileSync(
      join(sandbox, "apps/api/scripts/ecommerce-intake/verify-workbench-share-samples.mjs"),
      "console.error('semantic mismatch'); process.exit(1);\n",
      "utf8",
    );
    git(sandbox, ["add", "--", "templates/ecommerce-workbench/samples"]);

    const result = runBoundaryCheck(sandbox);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("semantic verification failed");
    expect(result.stderr).toContain("semantic mismatch");
  });

  test("rejects tracked real-sample acceptance manifests and directories", () => {
    const sandbox = prepareRepository();
    mkdirSync(join(sandbox, "docs"), { recursive: true });
    mkdirSync(join(sandbox, "front-profit-acceptance"), { recursive: true });
    writeFileSync(
      join(sandbox, "docs/front-profit-acceptance-manifest.customer.json"),
      "{}\n",
      "utf8",
    );
    writeFileSync(
      join(sandbox, "docs/front-profit-acceptance-result.customer.json"),
      "{}\n",
      "utf8",
    );
    writeFileSync(
      join(sandbox, "front-profit-acceptance/manifest.json"),
      "{}\n",
      "utf8",
    );
    git(sandbox, ["add", "--", "docs/front-profit-acceptance-manifest.customer.json", "docs/front-profit-acceptance-result.customer.json", "front-profit-acceptance/manifest.json"]);

    const result = runBoundaryCheck(sandbox);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/front-profit-acceptance-manifest.customer.json: forbidden tracked real-sample acceptance material");
    expect(result.stderr).toContain("docs/front-profit-acceptance-result.customer.json: forbidden tracked real-sample acceptance material");
    expect(result.stderr).toContain("front-profit-acceptance/manifest.json: forbidden tracked real-sample acceptance material");
  });

  test("rejects tracked files named like real or desensitized samples", () => {
    const sandbox = prepareRepository();
    mkdirSync(join(sandbox, "docs"), { recursive: true });
    writeFileSync(join(sandbox, "docs/customer-real-sample-notes.md"), "notes\n", "utf8");
    writeFileSync(join(sandbox, "docs/customer-脱敏样本-notes.md"), "notes\n", "utf8");
    git(sandbox, ["add", "--", "docs"]);

    const result = runBoundaryCheck(sandbox);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/customer-real-sample-notes.md: forbidden tracked real-sample acceptance material");
    expect(result.stderr).toContain("docs/customer-脱敏样本-notes.md: forbidden tracked real-sample acceptance material");
  });

  test("rejects tracked production release authorization material", () => {
    const sandbox = prepareRepository();
    mkdirSync(join(sandbox, "docs"), { recursive: true });
    mkdirSync(join(sandbox, "front-profit-production-release"), { recursive: true });
    writeFileSync(
      join(sandbox, "docs/front-profit-production-release.customer.json"),
      "{}\n",
      "utf8",
    );
    writeFileSync(
      join(sandbox, "front-profit-production-release/release.json"),
      "{}\n",
      "utf8",
    );
    git(sandbox, ["add", "--", "docs/front-profit-production-release.customer.json", "front-profit-production-release/release.json"]);

    const result = runBoundaryCheck(sandbox);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/front-profit-production-release.customer.json: forbidden tracked production release authorization material");
    expect(result.stderr).toContain("front-profit-production-release/release.json: forbidden tracked production release authorization material");
  });
});
