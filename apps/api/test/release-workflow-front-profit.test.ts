import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const workflow = readFileSync(
  resolve(root, ".github/workflows/release.yml"),
  "utf8",
);

describe("release workflow front-profit gate", () => {
  test("runs the packaged ZIP against an isolated empty database before publishing", () => {
    expect(workflow).toContain("release:");
    expect(workflow).toMatch(/release:[\s\S]+needs: verify/);
    expect(workflow).toContain("./scripts/verify-release.ps1");
    expect(workflow).toContain("-WorkingRoot");
    expect(workflow).toContain("-PreserveEvidence");
    expect(workflow).toContain("-UsePublicTestCredentials");

    const releaseJob = workflow.slice(workflow.indexOf("  release:"));
    expect(releaseJob).toContain("Stage the seven verified public Release assets");
    expect(releaseJob).not.toContain("actions/upload-artifact@");
    expect(releaseJob).not.toContain("actions/download-artifact@");
    expect(releaseJob.indexOf("./scripts/verify-release.ps1")).toBeLessThan(
      releaseJob.indexOf("gh release create"),
    );
  });
});
