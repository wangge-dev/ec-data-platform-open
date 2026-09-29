import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { validateDiyModuleManifest } from "../src/services/module-manifest.js";

describe("DIY module manifest", () => {
  test("validates the checked-in no-code scaffold with semantic IDs", () => {
    const filePath = path.resolve(
      process.cwd(),
      "extensions/modules/example-sales.module.json",
    );
    const manifest = validateDiyModuleManifest(
      JSON.parse(readFileSync(filePath, "utf8")),
    );

    expect(manifest).toMatchObject({
      schemaVersion: "module-manifest/v1",
      module: {
        code: "example_sales",
        hasTransform: false,
        semanticModel: {
          schemaVersion: "semantic-manifest/v1",
          id: "example_sales.analysis",
          version: 1,
        },
      },
    });
  });

  test("validates the checked-in lookup JOIN and computed-field recipe", () => {
    const filePath = path.resolve(
      process.cwd(),
      "extensions/modules/example-sales-enriched.module.json",
    );
    const manifest = validateDiyModuleManifest(
      JSON.parse(readFileSync(filePath, "utf8")),
    );

    expect(manifest.module).toMatchObject({
      code: "example_sales_enriched",
      hasTransform: false,
      join: {
        dictRole: "brand_dict",
        on: { product_id: "id" },
        enrich: { brand: "品牌", shop: "店铺" },
      },
    });
    expect(manifest.module.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "gross_profit",
        computed: true,
        expression: '"revenue" - "cost"',
      }),
    ]));
  });

  test("rejects JOINs with unknown left fields or unsafe output names", () => {
    const filePath = path.resolve(
      process.cwd(),
      "extensions/modules/example-sales-enriched.module.json",
    );
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    raw.module.join.on = { missing_field: "id" };
    raw.module.join.enrich = { "品牌字段;drop": "品牌" };

    expect(() => validateDiyModuleManifest(raw)).toThrow("JOIN 左侧字段不存在于 columns");
    expect(() => validateDiyModuleManifest(raw)).toThrow("JOIN 输出字段必须是英文小写字母");
  });

  test("rejects executable and semantic-less DIY manifests", () => {
    const base = {
      code: "unsafe_extension",
      name: "不安全扩展",
      description: "测试",
      columns: [{ name: "value", source: "值", type: "numeric" }],
      platforms: [{ code: "generic", name: "通用", filePattern: "unsafe" }],
      usages: ["summary"],
      enabled: true,
      isDict: false,
    };

    expect(() => validateDiyModuleManifest({
      schemaVersion: "module-manifest/v1",
      module: { ...base, hasTransform: true },
    })).toThrow("DIY 模块清单不能启用 transform 钩子");
    expect(() => validateDiyModuleManifest({
      schemaVersion: "module-manifest/v1",
      module: { ...base, hasTransform: false },
    })).toThrow("DIY 模块清单必须声明 semantic-manifest/v1");
  });
});
