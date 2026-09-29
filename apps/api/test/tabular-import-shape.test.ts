import { describe, expect, test } from "vitest";
import {
  prepareTabularSheet,
  TabularImportShapeError,
} from "../src/services/tabular-import-shape.js";

describe("tabular import shape", () => {
  test("skips metadata and fully blank rows while retaining a quality warning", () => {
    const result = prepareTabularSheet([
      ["报表标题"],
      [null, null],
      ["店铺", "商品", "销售额"],
      ["A", "甲", 100],
      [null, "", null],
      ["B", "乙", 200],
    ]);

    expect(result.headerRowIndex).toBe(2);
    expect(result.dataRows).toEqual([
      ["A", "甲", 100],
      ["B", "乙", 200],
    ]);
    expect(result.quality).toMatchObject({
      inputRows: 3,
      importedRows: 2,
      blankRowsSkipped: 1,
      status: "warning",
      warningCodes: ["BLANK_ROWS_SKIPPED"],
    });
  });

  test("rejects a sheet whose header is followed only by blank rows", () => {
    expect(() => prepareTabularSheet([
      ["店铺", "商品", "销售额"],
      [null, null, null],
    ])).toThrowError(TabularImportShapeError);
  });

  test("merges a two-row header and forward-fills merged group labels", () => {
    const result = prepareTabularSheet([
      ["导出说明"],
      [null, null, null, null],
      ["订单", null, "商品", null, "经营"],
      ["订单号", "日期", "名称", "数量", "销售额"],
      ["A-1", "2026-08-01", "甲", 2, 100],
    ], { headerRows: 2 });

    expect(result.headerRowIndex).toBe(3);
    expect(result.headerRow).toEqual([
      "订单 / 订单号",
      "订单 / 日期",
      "商品 / 名称",
      "商品 / 数量",
      "经营 / 销售额",
    ]);
    expect(result.dataRows).toEqual([["A-1", "2026-08-01", "甲", 2, 100]]);
    expect(result.headerProcessing).toEqual({
      mode: "merge-header-rows",
      headerRows: 2,
      sourceStartRow: 3,
      sourceEndRow: 4,
      outputColumns: 5,
    });
  });

  test("uses an explicit one-based start row for a multi-row header", () => {
    const result = prepareTabularSheet([
      ["2026 年经营报表"],
      ["导出人：测试"],
      ["订单", null, "经营"],
      ["订单号", "日期", "销售额"],
      ["A-1", "2026-08-01", 100],
    ], { headerRows: 2, headerStartRow: 3 });

    expect(result.headerRowIndex).toBe(3);
    expect(result.headerRow).toEqual([
      "订单 / 订单号",
      "订单 / 日期",
      "经营 / 销售额",
    ]);
    expect(result.dataRows).toEqual([["A-1", "2026-08-01", 100]]);
  });

  test("rejects an explicit header start that leaves no data row", () => {
    expect(() => prepareTabularSheet([
      ["说明"],
      ["订单", null, "经营"],
      ["订单号", "日期", "销售额"],
    ], { headerRows: 2, headerStartRow: 2 })).toThrowError(
      expect.objectContaining({ code: "HEADER_START_ROW_INVALID" }),
    );
  });

  test("merges an explicit three-level header without consuming its first data row", () => {
    const result = prepareTabularSheet([
      ["月度汇总"],
      ["经营", null, "库存"],
      ["销售", null, "快照"],
      ["店铺", "金额", "数量"],
      ["A 店", 100, 8],
    ], { headerRows: 3, headerStartRow: 2 });

    expect(result.headerRow).toEqual([
      "经营 / 销售 / 店铺",
      "经营 / 销售 / 金额",
      "库存 / 快照 / 数量",
    ]);
    expect(result.dataRows).toEqual([["A 店", 100, 8]]);
    expect(result.headerProcessing).toMatchObject({
      headerRows: 3,
      sourceStartRow: 2,
      sourceEndRow: 4,
    });
  });

  test("rejects ambiguous simultaneous multi-row-header and wide-to-long shaping", () => {
    expect(() => prepareTabularSheet([
      ["经营", null, "日期"],
      ["店铺", "商品", "2026-08-01"],
      ["A", "甲", 10],
    ], {
      headerRows: 2,
      shapeMode: "date-columns-to-rows",
    })).toThrowError(expect.objectContaining({
      code: "HEADER_ROWS_WITH_WIDE_TO_LONG_UNSUPPORTED",
    }));
  });

  test("turns date columns into date/value rows and ignores total columns", () => {
    const result = prepareTabularSheet([
      ["店铺", "商品", "2026/08/01", new Date(2026, 7, 2), "总计"],
      ["A", "甲", 10, 20, 30],
      ["B", "乙", null, 5, 5],
    ], { shapeMode: "date-columns-to-rows" });

    expect(result.headerRow).toEqual(["店铺", "商品", "统计日期", "指标值"]);
    expect(result.dataRows).toEqual([
      ["A", "甲", "2026-08-01", 10],
      ["A", "甲", "2026-08-02", 20],
      ["B", "乙", "2026-08-02", 5],
    ]);
    expect(result.transform).toMatchObject({
      sourceRows: 2,
      outputRows: 3,
      dimensionColumns: 2,
      dateColumns: 2,
      blankValuesSkipped: 1,
      repeatedHeaderRowsSkipped: 0,
    });
  });

  test("recognizes stacked measure headers and carries the section label", () => {
    const result = prepareTabularSheet([
      ["营业额", "组", "2026-02-01", "2026-02-02"],
      [null, "直营组", 100, 200],
      ["单量", "组", "2026-02-01", "2026-02-02"],
      [null, "直营组", 2, 3],
    ], { shapeMode: "date-columns-to-rows" });

    expect(result.dataRows).toEqual([
      ["营业额", "直营组", "2026-02-01", 100],
      ["营业额", "直营组", "2026-02-02", 200],
      ["单量", "直营组", "2026-02-01", 2],
      ["单量", "直营组", "2026-02-02", 3],
    ]);
    expect(result.transform?.repeatedHeaderRowsSkipped).toBe(1);
  });

  test("fails closed when wide-to-long finds no date headers", () => {
    expect(() => prepareTabularSheet([
      ["店铺", "商品", "销售额"],
      ["A", "甲", 10],
    ], { shapeMode: "date-columns-to-rows" })).toThrowError(
      expect.objectContaining({ code: "WIDE_TO_LONG_DATE_COLUMNS_NOT_FOUND" }),
    );
  });
});
