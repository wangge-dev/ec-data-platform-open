import { describe, expect, test } from "vitest";
import type { ModuleDef } from "../src/modules/schema.js";
import { moduleFieldSuggestions } from "../src/services/module-builder.js";

type SuggestionModule = ModuleDef & { origin: "builtin" | "user" };

function moduleWithColumns(
  columns: ModuleDef["columns"],
  origin: SuggestionModule["origin"] = "user",
): SuggestionModule {
  return {
    code: "pinduoduo_sales",
    name: "拼多多销售",
    description: "用户创建的销售模块",
    columns,
    platforms: [
      {
        code: "generic",
        name: "通用",
        filePattern: "orders_export",
        patternFlags: "i",
        enabled: true,
      },
    ],
    usages: ["summary"],
    enabled: true,
    hasTransform: false,
    isDict: false,
    origin,
  };
}

const column = (
  name: string,
  type: ModuleDef["columns"][number]["type"],
  options: Partial<ModuleDef["columns"][number]> = {},
): ModuleDef["columns"][number] => ({
  name,
  source: name,
  label: name,
  type,
  required: false,
  computed: false,
  ...options,
});

describe("module field suggestions", () => {
  test("returns no evolved-field suggestions for built-in modules", () => {
    const suggestions = moduleFieldSuggestions(
      moduleWithColumns(
        [
          column("paid_at", "timestamp", { semanticRole: "time" }),
          column("sales_amount", "numeric", { semanticRole: "amount" }),
          column("legacy_channel", "text", { label: "旧渠道" }),
          column("legacy_fee", "numeric", { label: "旧费用" }),
        ],
        "builtin",
      ),
    );

    expect(suggestions).toEqual([]);
  });

  test("suggests compatible charts for added fields without repeating seeded role charts", () => {
    const suggestions = moduleFieldSuggestions(
      moduleWithColumns([
        column("paid_at", "timestamp", { semanticRole: "time" }),
        column("sales_amount", "numeric", { semanticRole: "amount" }),
        column("goods_name", "text", { semanticRole: "product_name" }),
        column("order_status", "text", { semanticRole: "status" }),
        column("commission", "numeric", { label: "佣金" }),
        column("campaign", "text", { label: "活动名称" }),
        column("is_gift", "boolean", { label: "是否赠品" }),
        column("shipped_on", "date", { label: "发货日期" }),
      ]),
    );

    expect(suggestions).toEqual([
      {
        key: "field_commission",
        label: "佣金趋势",
        chartType: "line",
        dimension: "paid_at",
        metric: "commission",
      },
      {
        key: "field_campaign",
        label: "按活动名称查看sales_amount",
        chartType: "bar",
        dimension: "campaign",
        metric: "sales_amount",
      },
      {
        key: "field_is_gift",
        label: "按是否赠品查看sales_amount",
        chartType: "bar",
        dimension: "is_gift",
        metric: "sales_amount",
      },
      {
        key: "field_shipped_on",
        label: "sales_amount按发货日期趋势",
        chartType: "line",
        dimension: "shipped_on",
        metric: "sales_amount",
      },
    ]);
    expect(suggestions.map((suggestion) => suggestion.key)).not.toContain(
      "amount_by_time",
    );
    expect(suggestions.map((suggestion) => suggestion.key)).not.toContain(
      "status_distribution",
    );
  });

  test("never uses incompatible semantic fields in DATE_TRUNC or SUM suggestions", () => {
    const suggestions = moduleFieldSuggestions(
      moduleWithColumns([
        column("bad_time", "text", { semanticRole: "time" }),
        column("bad_amount", "text", { semanticRole: "amount" }),
        column("new_measure", "numeric", { label: "新增指标" }),
        column("new_dimension", "text", { label: "新增维度" }),
        column("new_date", "date", { label: "新增日期" }),
        column("new_flag", "boolean", { label: "新增标记" }),
        column("_included", "boolean"),
        column("computed_metric", "numeric", {
          source: undefined,
          computed: true,
          expression: "1",
        }),
      ]),
    );

    expect(suggestions).toEqual([
      {
        key: "field_new_measure",
        label: "新增指标趋势",
        chartType: "line",
        dimension: "new_date",
        metric: "new_measure",
      },
      {
        key: "field_new_dimension",
        label: "新增维度分布",
        chartType: "bar",
        dimension: "new_dimension",
        metric: "count",
      },
      {
        key: "field_new_date",
        label: "新增日期记录趋势",
        chartType: "line",
        dimension: "new_date",
        metric: "count",
      },
      {
        key: "field_new_flag",
        label: "新增标记分布",
        chartType: "pie",
        dimension: "new_flag",
        metric: "count",
      },
    ]);
  });
});
