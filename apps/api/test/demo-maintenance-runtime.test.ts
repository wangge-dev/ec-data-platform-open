import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const readRoot = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("supported demo maintenance runtime entry", () => {
  test("ships an audited runtime command instead of the retired development seed script", () => {
    const apiPackage = JSON.parse(readRoot("apps/api/package.json"));
    const verifier = readRoot("apps/api/scripts/verify-runtime-package.mjs");

    expect(apiPackage.files).toContain("scripts/demo-maintenance.ts");
    expect(apiPackage.files).not.toContain("scripts/seed-demo.ts");
    expect(apiPackage.scripts["demo:rebuild"]).toBe("tsx scripts/demo-maintenance.ts rebuild");
    expect(apiPackage.scripts["demo:clear"]).toBe("tsx scripts/demo-maintenance.ts clear");
    expect(apiPackage.scripts["demo:migrate-legacy"]).toBe("tsx scripts/demo-maintenance.ts migrate-legacy");
    expect(verifier).toContain('"scripts/demo-maintenance.ts"');
    expect(verifier).toContain('"scripts/seed-demo.ts"');
    expect(existsSync(resolve(root, "apps/api/scripts/seed-demo.ts"))).toBe(false);
  });

  test("serializes maintenance and exposes only explicit commands", () => {
    const script = readRoot("apps/api/scripts/demo-maintenance.ts");
    const importer = readRoot("apps/api/src/services/import-excel.ts");

    expect(script).toContain("pg_try_advisory_lock");
    expect(script).toContain("migrate-legacy");
    expect(script).toContain("runCompensatedDemoRebuild");
    expect(script).toMatch(/importExcel\([^]*?"file",\s*false,/);
    expect(script.indexOf("const dashboardRows = await tx.unsafe")).toBeLessThan(
      script.indexOf("clearMarkedDemoSources(tx, staged.sourceId)"),
    );
    expect(script).toContain("return sql.begin(async (tx) =>");
    expect(importer).toContain("systemMetadata?: Readonly<Record<string, string>>");
    expect(script).not.toContain("replaceExisting = true");
    expect(script).not.toContain("originalFileName === DEMO_FILE");
  });

  test("documents the runtime command and the current 4480-row 13-card cockpit", () => {
    const guide = readRoot("docs/部署指南.md");

    expect(guide).toContain("docker compose exec api npm run demo:rebuild");
    expect(guide).toContain("pnpm --filter @ec/api demo:rebuild");
    expect(guide).toContain("4,480 行");
    expect(guide).toContain("13 个卡片");
    expect(guide).not.toContain("5 个虚构面霜 SKU + 2 张图表");
  });
});
