// buildStatusWhere 单元测试（V0.27：statusFilter WHERE 构造，纯函数不连DB）
import { describe, it, expect } from "vitest";
import { buildStatusWhere } from "../src/services/etl";

const cols = (names: string[]) => names.map((n) => ({ raw: n, name: n }));

describe("buildStatusWhere", () => {
  it("无 statusFilter 返回空", () => {
    const r = buildStatusWhere(cols(["订单状态"]), undefined);
    expect(r.clause).toBe("");
    expect(r.params).toEqual([]);
  });

  it("构造 excludeStatus NOT IN", () => {
    const r = buildStatusWhere(cols(["订单状态"]), {
      statusColumn: "订单状态",
      excludeStatus: ["交易关闭", "已废弃"],
      refundExclude: [],
    });
    expect(r.clause).toContain('NOT IN ($1,$2)');
    expect(r.clause).toContain('o."订单状态"');
    expect(r.params).toEqual(["交易关闭", "已废弃"]);
  });

  it("构造 statusColumn + refundColumn 两个条件", () => {
    const r = buildStatusWhere(cols(["发货状态", "是否退款"]), {
      statusColumn: "发货状态",
      excludeStatus: ["已废弃(关闭)"],
      refundColumn: "是否退款",
      refundExclude: ["已退款"],
    });
    expect(r.clause).toContain('AND');
    expect(r.clause).toContain('o."发货状态"');
    expect(r.clause).toContain('o."是否退款"');
    expect(r.params).toEqual(["已废弃(关闭)", "已退款"]);
  });

  it("状态列不存在时跳过该条件", () => {
    const r = buildStatusWhere(cols(["其他列"]), {
      statusColumn: "订单状态",
      excludeStatus: ["交易关闭"],
      refundExclude: [],
    });
    expect(r.clause).toBe("");
    expect(r.params).toEqual([]);
  });

  it("空 excludeStatus 不构造条件", () => {
    const r = buildStatusWhere(cols(["订单状态"]), {
      statusColumn: "订单状态",
      excludeStatus: [],
      refundExclude: [],
    });
    expect(r.clause).toBe("");
  });

  it("列名带空格用 raw 匹配（trim）", () => {
    const r = buildStatusWhere([{ raw: " 订单状态 ", name: "订单状态" }], {
      statusColumn: "订单状态",
      excludeStatus: ["交易关闭"],
      refundExclude: [],
    });
    expect(r.params).toEqual(["交易关闭"]);
  });
});
