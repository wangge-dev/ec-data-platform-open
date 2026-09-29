import { describe, expect, it } from "vitest";
import { buildLegacyModuleRedirect } from "./redirect-target";

describe("legacy module redirects", () => {
  it("builds valid module routes and preserves compare filters", () => {
    const params = new URLSearchParams(
      "module=sales_orders&metric=gmv&agg=sum",
    );

    expect(buildLegacyModuleRedirect("compare", params)).toBe(
      "/module/sales_orders/compare?metric=gmv&agg=sum",
    );
    expect(buildLegacyModuleRedirect("alerts", params)).toBe(
      "/module/sales_orders/alerts",
    );
  });

  it.each([
    ["slash", "module=orders%2Fadmin"],
    ["backslash", "module=orders%5Cadmin"],
    ["absolute protocol", "module=https%3A%2F%2Fevil.example"],
    ["protocol-relative", "module=%2F%2Fevil.example"],
    ["uppercase", "module=Sales"],
    ["hyphen", "module=sales-orders"],
    ["missing", "metric=gmv"],
  ])("rejects %s module input", (_name, query) => {
    const params = new URLSearchParams(query);
    expect(buildLegacyModuleRedirect("compare", params)).toBe("/analytics");
    expect(buildLegacyModuleRedirect("alerts", params)).toBe("/analytics");
  });
});
