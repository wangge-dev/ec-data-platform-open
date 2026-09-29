import { describe, expect, it } from "vitest";
import { filterRetiredModules, isRetiredModuleCode } from "./types";

describe("retired module visibility", () => {
  it("hides retired Shopee modules while preserving active and user modules", () => {
    expect(
      filterRetiredModules([
        { code: "shopee_ads" },
        { code: "orders" },
        { code: "shopee_sales" },
        { code: "module_qh6xec" },
      ]),
    ).toEqual([{ code: "orders" }, { code: "module_qh6xec" }]);
  });

  it("accepts an empty API result", () => {
    expect(filterRetiredModules(undefined)).toEqual([]);
  });

  it("matches only the two exact retired codes", () => {
    expect(isRetiredModuleCode("shopee_ads")).toBe(true);
    expect(isRetiredModuleCode("shopee_sales")).toBe(true);
    expect(isRetiredModuleCode("module_qh6xec")).toBe(false);
    expect(isRetiredModuleCode(null)).toBe(false);
  });
});
