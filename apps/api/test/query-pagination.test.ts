import { describe, expect, test } from "vitest";
import { parseBoundedQueryInteger } from "../src/lib/query-pagination.js";

describe("bounded query integers", () => {
  test.each([
    [undefined, 50],
    ["", 50],
    ["NaN", 50],
    ["1.5", 50],
    ["-1", 50],
    ["0", 50],
    ["51", 51],
    ["999999", 500],
  ])("parses limit %j without producing an unsafe SQL number", (input, expected) => {
    expect(parseBoundedQueryInteger(input, { defaultValue: 50, minimum: 1, maximum: 500 }))
      .toBe(expected);
  });

  test.each([
    [undefined, 0],
    ["", 0],
    ["Infinity", 0],
    ["-1", 0],
    ["0", 0],
    ["25", 25],
  ])("parses offset %j as a non-negative safe integer", (input, expected) => {
    expect(parseBoundedQueryInteger(input, { defaultValue: 0, minimum: 0, maximum: 1_000_000_000 }))
      .toBe(expected);
  });
});
