import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ecommerceWorkbenchBoardBlueprint,
  ecommerceWorkbenchSolution,
  moduleCodes,
} from "../scripts/ecommerce-intake/workbench-definition.js";
import { PDD_STANDARD_SCHEMAS } from "../scripts/ecommerce-intake/pdd-standardize.mjs";
import { OUTPUT_SCHEMAS as SYCM_STANDARD_SCHEMAS } from "../scripts/ecommerce-intake/sycm-standardize.mjs";
import { validateVerticalSolutionManifest } from "../src/services/vertical-solution-manifest.js";

describe("电商经营工作台方案", () => {
  it("打包脚本只向调用方输出最终机器可读清单", () => {
    const script = readFileSync(
      resolve(import.meta.dirname, "../../../scripts/package-ecommerce-workbench.ps1"),
      "utf8",
    );

    expect(script).toContain("$null = & $localTsx $builder --output $solutionRoot");
    expect(script.match(/\| ConvertTo-Json/g)).toHaveLength(1);
  });

  it("是七张标准表、四个业务入口且不声明业务数据或密钥", () => {
    const manifest = validateVerticalSolutionManifest(ecommerceWorkbenchSolution);
    const categoryCodes = new Set(
      manifest.modules.map(({ module }) => module.category),
    );

    expect(manifest.modules.map(({ module }) => module.code)).toEqual(moduleCodes);
    expect(categoryCodes).toEqual(new Set([
      "workbench_taobao_overview",
      "workbench_taobao_structure",
      "workbench_pdd_ads",
      "workbench_pdd_orders_quality",
    ]));
    expect(ecommerceWorkbenchBoardBlueprint.groups).toHaveLength(4);
    expect(manifest.dataPolicy).toEqual({
      containsBusinessData: false,
      containsSecrets: false,
    });
    expect(manifest.requiredConnectors).toEqual([]);
  });

  it("所有模块都只接标准表，且没有隐藏转换或连接器依赖", () => {
    const manifest = validateVerticalSolutionManifest(ecommerceWorkbenchSolution);

    for (const { module } of manifest.modules) {
      expect(module.platforms).toEqual([expect.objectContaining({
        code: "standard",
        enabled: true,
      })]);
      expect(module.hasTransform).toBe(false);
      expect(module.transform).toBeUndefined();
    }
  });

  it("七个模块字段与两套标准化转换器逐项一致", () => {
    const manifest = validateVerticalSolutionManifest(ecommerceWorkbenchSolution);
    const columnsByModule = new Map(manifest.modules.map(({ module }) => [
      module.code,
      module.columns.map(({ name }) => name),
    ]));
    const schemaNames = (schema: ReadonlyArray<string | { name: string }>) =>
      schema.map((item) => typeof item === "string" ? item : item.name);

    expect(new Set(columnsByModule.get("taobao_trade_day"))).toEqual(
      new Set(schemaNames(SYCM_STANDARD_SCHEMAS.trade_day)),
    );
    expect(new Set(columnsByModule.get("taobao_terminal_day"))).toEqual(
      new Set(schemaNames(SYCM_STANDARD_SCHEMAS.terminal_day)),
    );
    expect(new Set(columnsByModule.get("taobao_price_band_day"))).toEqual(
      new Set(schemaNames(SYCM_STANDARD_SCHEMAS.price_band_day)),
    );
    expect(new Set(columnsByModule.get("taobao_category_month"))).toEqual(
      new Set(schemaNames(SYCM_STANDARD_SCHEMAS.category_month)),
    );
    expect(new Set(columnsByModule.get("pdd_order_item"))).toEqual(
      new Set(schemaNames(PDD_STANDARD_SCHEMAS.order_item)),
    );
    expect(new Set(columnsByModule.get("pdd_ads_account_day"))).toEqual(
      new Set(schemaNames(PDD_STANDARD_SCHEMAS.ads_account_day)),
    );
    expect(new Set(columnsByModule.get("pdd_ads_product_period"))).toEqual(
      new Set(schemaNames(PDD_STANDARD_SCHEMAS.ads_product_period)),
    );
  });

  it("订单口径使用订单权重，商品周期快照的图表显式带报告期", () => {
    const manifest = validateVerticalSolutionManifest(ecommerceWorkbenchSolution);
    const categoryModule = manifest.modules.find(
      ({ module }) => module.code === "taobao_category_month",
    )!.module;
    expect(categoryModule.inclusionRule).toEqual({
      field: "category_level",
      includedValues: ["leaf"],
    });

    const orderModule = manifest.modules.find(
      ({ module }) => module.code === "pdd_order_item",
    )!.module;
    const metricIds = orderModule.semanticModel!.metrics.map(({ id }) => id);
    expect(metricIds).toContain("pdd_order_item.order_weight");
    expect(metricIds).toContain("pdd_order_item.matched_order_weight");
    expect(metricIds).toContain("pdd_order_item.promotion_coverage_rate");

    const productChart = ecommerceWorkbenchBoardBlueprint.groups
      .flatMap(({ charts }) => charts)
      .find(({ key }) => key === "pdd_product_gmv")!;
    expect(productChart.dimensionIds).toEqual([
      "pdd_ads_product_period.product_name",
      "pdd_ads_product_period.period_start",
    ]);
  });

  it("去重人数与商品数不允许跨时间直接求和", () => {
    const manifest = validateVerticalSolutionManifest(ecommerceWorkbenchSolution);
    const nonAdditiveMetricIds = new Set(
      manifest.modules.flatMap(({ module }) =>
        module.semanticModel!.metrics
          .filter(({ additiveAcrossTime }) => additiveAcrossTime === false)
          .map(({ id }) => id),
      ),
    );

    expect([...nonAdditiveMetricIds]).toEqual(expect.arrayContaining([
      "taobao_trade_day.visitors",
      "taobao_trade_day.paying_buyers",
      "taobao_trade_day.ordering_buyers",
      "taobao_trade_day.new_buyers",
      "taobao_trade_day.returning_buyers",
      "taobao_terminal_day.paid_product_count",
      "taobao_terminal_day.paying_buyers",
      "taobao_price_band_day.paying_buyers",
      "taobao_category_month.paying_buyers",
    ]));
  });

  it("为五张有业务分类的表声明排行维度，并让两张汇总表省略排行", () => {
    const manifest = validateVerticalSolutionManifest(ecommerceWorkbenchSolution);
    const rankingDimensions = Object.fromEntries(
      manifest.modules.map(({ module }) => [
        module.code,
        (module.semanticModel as any).defaultRankingDimensionId,
      ]),
    );

    expect(rankingDimensions).toEqual({
      taobao_trade_day: null,
      taobao_terminal_day: "taobao_terminal_day.terminal",
      taobao_price_band_day: "taobao_price_band_day.price_band_label",
      taobao_category_month: "taobao_category_month.category_label",
      pdd_order_item: "pdd_order_item.order_status",
      pdd_ads_account_day: null,
      pdd_ads_product_period: "pdd_ads_product_period.product_name",
    });
  });
});
