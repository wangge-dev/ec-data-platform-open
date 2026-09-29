import { describe, expect, test } from "vitest";
import {
  GENERIC_PROCESSING_ERROR,
  publicProcessingError,
} from "../src/services/public-processing-error";
import { sanitizeEtlRouteReport } from "../src/routes/etl";

describe("public processing errors", () => {
  test.each([
    ["未导入维护表(品牌字典)，请先导入", "未导入品牌维护表，请先导入"],
    ["订单表缺列: 商品编码、订单金额", "订单文件缺少必要字段，请检查字段对应"],
    ["输入文件缺少必填列: 日期", "输入文件缺少必要字段，请检查字段对应"],
    ["维护表缺少id列", "品牌维护表缺少必要的 ID 字段"],
    [
      "订单模块「拼多多」的 columnOverrides 缺 product_id 或 amount，请在 orders.json 补全该平台的列映射",
      "订单字段映射缺少商品或金额字段，请检查字段对应",
    ],
    [
      "全部行因 required 字段缺失被丢弃，请检查列名映射",
      "必填字段缺失，请检查字段对应",
    ],
  ])("maps a known fixable error without exposing internals", (raw, expected) => {
    expect(publicProcessingError(raw)).toBe(expected);
  });

  test.each([
    "password=top-secret SQL relation user_data.uf_161 failed",
    "读取源表 user_data.uf_161 失败：driver password=top-secret",
  ])("redacts unknown or unsafe details", (raw) => {
    expect(publicProcessingError(raw)).toBe(GENERIC_PROCESSING_ERROR);
  });

  test.each(["run", "rerun-all", "scan"])(
    "/etl/%s returns actionable safe errors and redacts secret reports",
    () => {
      expect(
        sanitizeEtlRouteReport({
          sourceId: 161,
          error: "未导入维护表(品牌字典)，请先导入",
        }),
      ).toEqual({
        sourceId: 161,
        error: "未导入品牌维护表，请先导入",
      });
      const secret = JSON.stringify(
        sanitizeEtlRouteReport({
          sourceId: 161,
          error: "password=top-secret SQL relation user_data.uf_161 failed",
        }),
      );
      expect(secret).toContain(GENERIC_PROCESSING_ERROR);
      expect(secret).not.toContain("top-secret");
      expect(secret).not.toContain("user_data");
    },
  );
});
