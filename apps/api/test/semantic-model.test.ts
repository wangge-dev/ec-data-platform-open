import { describe, expect, test } from "vitest";

import { loadModules } from "../src/modules/loader.js";
import {
  compileSemanticQuery,
  loadSemanticModels,
  publicSemanticModel,
  SemanticQueryError,
} from "../src/services/semantic-model.js";

describe("semantic-manifest/v1", () => {
  test("publishes front-profit plus three independently validated module models", async () => {
    const models = await loadSemanticModels();
    expect(models.map((model) => model.id)).toEqual(expect.arrayContaining([
      "front_profit.performance",
      "orders.analysis",
      "inventory.analysis",
      "ads.analysis",
    ]));

    const modules = await loadModules();
    for (const code of ["orders", "inventory", "ads"]) {
      const module = modules.find((candidate) => candidate.code === code);
      expect(module?.semanticModel).toMatchObject({
        schemaVersion: "semantic-manifest/v1",
        version: 1,
      });
      expect(module?.semanticModel?.metrics.length).toBeGreaterThan(0);
      expect(module?.semanticModel?.dimensions.length).toBeGreaterThan(0);
    }
  });

  test("compiles stable metric and dimension IDs into a bounded query and lineage", async () => {
    const models = await loadSemanticModels();
    const compiled = compileSemanticQuery({
      modelId: "orders.analysis",
      modelVersion: 1,
      metricIds: ["orders.sales_amount"],
      dimensionIds: ["orders.platform"],
      filters: [{ dimensionId: "orders.pay_date", operator: "gte", value: "2026-08-01" }],
      limit: 250,
    }, models);

    expect(compiled.sqlText).toContain('SUM("amount")');
    expect(compiled.sqlText).toContain('GROUP BY "platform"');
    expect(compiled.sqlText).toContain('DATE("pay_time") >= $1::date');
    expect(compiled.sqlText).not.toContain("orders.sales_amount");
    expect(compiled.parameters).toEqual(["2026-08-01"]);
    expect(compiled.lineage).toMatchObject({
      schemaVersion: "semantic-lineage/v1",
      modelId: "orders.analysis",
      modelVersion: 1,
      moduleCode: "orders",
      metricIds: ["orders.sales_amount"],
      dimensionIds: ["orders.platform"],
    });
    expect(compiled.budget).toMatchObject({
      schemaVersion: "semantic-query-budget/v1",
      maxRows: 250,
      statementTimeoutMs: 5000,
    });
  });

  test("publishes labels and IDs without leaking physical fields to chart or AI clients", async () => {
    const models = await loadSemanticModels();
    const model = models.find((candidate) => candidate.id === "orders.analysis")!;
    const published = publicSemanticModel(model);

    expect(published.metrics[0]).toMatchObject({ id: "orders.sales_amount", aggregation: "sum" });
    expect(published.dimensions[0]).toMatchObject({
      id: "orders.pay_date",
      kind: "time",
      timeGrain: "day",
    });
    expect(JSON.stringify(published)).not.toContain('"field"');
    expect(JSON.stringify(published)).not.toContain("numeratorField");
  });

  test("recomputes ratios from additive numerator and denominator instead of averaging row ratios", async () => {
    const models = await loadSemanticModels();
    const compiled = compileSemanticQuery({
      modelId: "ads.analysis",
      modelVersion: 1,
      metricIds: ["ads.ctr", "ads.cpc"],
      dimensionIds: ["ads.shop"],
    }, models);

    expect(compiled.sqlText).toContain('SUM("clicks")::numeric / NULLIF(SUM("impressions"), 0)');
    expect(compiled.sqlText).toContain('SUM("ads_spend")::numeric / NULLIF(SUM("clicks"), 0)');
    expect(compiled.sqlText).not.toContain('AVG("ctr")');
  });

  test("normalizes declared time dimensions to their grain and orders trends chronologically", async () => {
    const models = await loadSemanticModels();
    const compiled = compileSemanticQuery({
      modelId: "orders.analysis",
      modelVersion: 1,
      metricIds: ["orders.sales_amount"],
      dimensionIds: ["orders.pay_date"],
    }, models);

    expect(compiled.sqlText).toContain('SELECT DATE("pay_time") AS "d0__orders__pay_date"');
    expect(compiled.sqlText).toContain('GROUP BY DATE("pay_time")');
    expect(compiled.sqlText).toContain('ORDER BY "d0__orders__pay_date" ASC NULLS LAST');
  });

  test("requires a time grain for snapshot inventory metrics", async () => {
    const models = await loadSemanticModels();
    expect(() => compileSemanticQuery({
      modelId: "inventory.analysis",
      modelVersion: 1,
      metricIds: ["inventory.stock_quantity"],
      dimensionIds: ["inventory.warehouse"],
    }, models)).toThrowError(expect.objectContaining<Partial<SemanticQueryError>>({
      code: "SEMANTIC_TIME_GRAIN_REQUIRED",
    }));

    expect(() => compileSemanticQuery({
      modelId: "inventory.analysis",
      modelVersion: 1,
      metricIds: ["inventory.stock_quantity"],
      dimensionIds: ["inventory.snapshot_date", "inventory.warehouse"],
    }, models)).not.toThrow();
  });

  test("fails closed on model version drift and unknown IDs", async () => {
    const models = await loadSemanticModels();
    expect(() => compileSemanticQuery({
      modelId: "orders.analysis",
      modelVersion: 2,
      metricIds: ["orders.sales_amount"],
      dimensionIds: [],
    }, models)).toThrowError(expect.objectContaining<Partial<SemanticQueryError>>({
      code: "SEMANTIC_MODEL_VERSION_MISMATCH",
    }));

    expect(() => compileSemanticQuery({
      modelId: "orders.analysis",
      modelVersion: 1,
      metricIds: ["orders.guessed_metric"],
      dimensionIds: [],
    }, models)).toThrowError(expect.objectContaining<Partial<SemanticQueryError>>({
      code: "SEMANTIC_METRIC_NOT_FOUND",
    }));
  });
});
