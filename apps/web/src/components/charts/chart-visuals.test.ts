import { describe, expect, it } from "vitest";
import {
  buildChartInitOptions,
  displayFieldName,
  formatBusinessNumber,
  normalizeDevicePixelRatio,
} from "./chart-visuals";

describe("chart visual helpers", () => {
  it("uses the actual high-DPI ratio for canvas and caps excessive memory use", () => {
    expect(buildChartInitOptions("canvas", 2.5)).toMatchObject({
      renderer: "canvas",
      devicePixelRatio: 2.5,
    });
    expect(normalizeDevicePixelRatio(4)).toBe(3);
    expect(normalizeDevicePixelRatio(Number.NaN)).toBe(1);
  });

  it("keeps SVG as an explicitly supported renderer", () => {
    const options = buildChartInitOptions("svg", 2);
    expect(options).toMatchObject({
      renderer: "svg",
      devicePixelRatio: 2,
    });
    expect(options).not.toHaveProperty("width");
    expect(options).not.toHaveProperty("height");
  });

  it("removes floating-point tails and formats business amounts consistently", () => {
    expect(formatBusinessNumber(2330.4500000000003, { fixed: true })).toBe(
      "2,330.45",
    );
    expect(formatBusinessNumber(18033.32, { compact: true })).toBe("1.80 万");
    expect(formatBusinessNumber(undefined)).toBe("—");
  });

  it("prefers the Chinese business label over an internal field name", () => {
    expect(
      displayFieldName("field_18", [
        { name: "field_18", label: "前台利润" },
      ]),
    ).toBe("前台利润");
    expect(displayFieldName("amount", [])).toBe("amount");
  });
});
