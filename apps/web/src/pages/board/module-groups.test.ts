import { describe, expect, test } from "vitest";
import type { ModuleData } from "../module/types";
import {
  buildModuleFilterOptions,
  buildModuleSuggestionPrefill,
  fieldSuggestionsForSelection,
  filterModuleGroups,
  groupChartsByModule,
  moduleCodesForSelection,
  resolveDefaultModuleCode,
  resolveSelectedModuleCode,
  type BoardChart,
} from "./module-groups";

function sampleModules(): ModuleData[] {
  return [
    { code: "orders", name: "销售订单", enabled: true },
    { code: "pinduoduo_sales", name: "拼多多销售", enabled: true },
    { code: "archived", name: "已停用模块", enabled: false },
  ] as ModuleData[];
}

function sampleCharts(): BoardChart[] {
  return [
    { id: 1, moduleCode: "pinduoduo_sales" },
    { id: 2, moduleCode: "orders" },
    { id: 3, moduleCode: null },
    { id: 4, moduleCode: "orders" },
    { id: 5, moduleCode: "archived" },
    { id: 6, moduleCode: "missing_module" },
    { id: 7, moduleCode: "shopee_ads" },
  ] as BoardChart[];
}

describe("board module grouping", () => {
  test("keeps active modules in module-list order and unclassified charts last", () => {
    const groups = groupChartsByModule(sampleCharts(), sampleModules());

    expect(groups.map((group) => group.name)).toEqual([
      "销售订单",
      "拼多多销售",
      "未分类",
    ]);
    expect(groups.map((group) => group.charts.map((chart) => chart.id))).toEqual([
      [2, 4],
      [1],
      [3, 5, 6],
    ]);
  });

  test("filters one complete named group while all retains unclassified charts", () => {
    const groups = groupChartsByModule(sampleCharts(), sampleModules());

    expect(
      filterModuleGroups(groups, "pinduoduo_sales").map((group) => group.code),
    ).toEqual(["pinduoduo_sales"]);
    expect(
      filterModuleGroups(groups, "all").flatMap((group) =>
        group.charts.map((chart) => chart.id),
      ),
    ).toEqual([2, 4, 1, 3, 5, 6]);
  });

  test("never resurrects retired module charts as unclassified", () => {
    const groups = groupChartsByModule(
      [
        ...sampleCharts(),
        { id: 8, moduleCode: "shopee_sales" } as BoardChart,
        { id: 9, moduleCode: "shopee_custom" } as BoardChart,
      ],
      [
        ...sampleModules(),
        {
          code: "shopee_custom",
          name: "User Shopee Analysis",
          enabled: true,
        } as ModuleData,
      ],
    );

    const chartIds = groups.flatMap((group) =>
      group.charts.map((chart) => chart.id),
    );

    expect(chartIds).not.toContain(7);
    expect(chartIds).not.toContain(8);
    expect(chartIds).toContain(9);
  });

  test("does not emit empty module groups and keeps exact chip counts", () => {
    const groups = groupChartsByModule(
      sampleCharts().filter((chart) => chart.id !== 1),
      sampleModules(),
    );

    expect(groups.map((group) => [group.code, group.charts.length])).toEqual([
      ["orders", 2],
      ["", 3],
    ]);
  });

  test("builds a safe hidden query prefill for one selected module suggestion", () => {
    const prefill = buildModuleSuggestionPrefill(
      {
        code: "pinduoduo_sales",
        name: "拼多多销售",
        enabled: true,
        origin: "user",
        outputTable: "unified_pinduoduo_sales",
        columns: [
          { name: "paid_at", label: "支付时间", type: "timestamp" },
          { name: "sales_amount", label: "商品金额", type: "numeric" },
        ],
        semanticModel: {
          schemaVersion: "semantic-manifest/v1",
          id: "pinduoduo_sales.analysis",
          version: 1,
          dimensions: [{ id: "pinduoduo_sales.paid_at", label: "支付时间", field: "paid_at", kind: "time" }],
          metrics: [{ id: "pinduoduo_sales.sales_amount", label: "商品金额", aggregation: "sum", field: "sales_amount", unit: "currency", additiveAcrossTime: true }],
        },
      } as ModuleData,
      {
        key: "amount_by_time",
        label: "商品金额趋势",
        chartType: "line",
        dimension: "paid_at",
        metric: "sales_amount",
      },
    );

    expect(prefill).toMatchObject({
      moduleCode: "pinduoduo_sales",
      moduleName: "拼多多销售",
      suggestionLabel: "商品金额趋势",
      chartType: "line",
      modelId: "pinduoduo_sales.analysis",
      metricIds: ["pinduoduo_sales.sales_amount"],
      dimensionIds: ["pinduoduo_sales.paid_at"],
    });
    expect(JSON.parse(prefill.queryText)).toEqual(expect.objectContaining({
      modelId: "pinduoduo_sales.analysis",
      modelVersion: 1,
      metricIds: ["pinduoduo_sales.sales_amount"],
      dimensionIds: ["pinduoduo_sales.paid_at"],
    }));
    expect(prefill.queryText).not.toContain("unified_pinduoduo_sales");
  });

  test("omits the inclusion predicate for built-in module suggestions", () => {
    const prefill = buildModuleSuggestionPrefill(
      {
        code: "orders",
        name: "销售订单",
        enabled: true,
        origin: "builtin",
        outputTable: "unified_sales",
        columns: [
          { name: "campaign", label: "活动", type: "text" },
          { name: "amount", label: "金额", type: "numeric" },
        ],
        semanticModel: {
          schemaVersion: "semantic-manifest/v1",
          id: "orders.analysis",
          version: 1,
          dimensions: [{ id: "orders.campaign", label: "活动", field: "campaign", kind: "categorical" }],
          metrics: [{ id: "orders.amount", label: "金额", aggregation: "sum", field: "amount", unit: "currency", additiveAcrossTime: true }],
        },
      } as ModuleData,
      {
        key: "field_campaign",
        label: "按活动查看金额",
        chartType: "bar",
        dimension: "campaign",
        metric: "amount",
      },
    );

    expect(JSON.parse(prefill.queryText)).toEqual(expect.objectContaining({
      modelId: "orders.analysis",
      metricIds: ["orders.amount"],
      dimensionIds: ["orders.campaign"],
    }));
    expect(prefill.queryText).not.toContain("unified_sales");
  });

  test("builds a count trend only for a compatible date field", () => {
    const prefill = buildModuleSuggestionPrefill(
      {
        code: "pinduoduo_sales",
        name: "拼多多销售",
        enabled: true,
        origin: "user",
        outputTable: "unified_pinduoduo_sales",
        columns: [
          { name: "shipped_on", label: "发货日期", type: "date" },
        ],
        semanticModel: {
          schemaVersion: "semantic-manifest/v1",
          id: "pinduoduo_sales.analysis",
          version: 1,
          dimensions: [{ id: "pinduoduo_sales.shipped_on", label: "发货日期", field: "shipped_on", kind: "time" }],
          metrics: [{ id: "pinduoduo_sales.row_count", label: "记录数", aggregation: "count", unit: "number", additiveAcrossTime: true }],
        },
      } as ModuleData,
      {
        key: "field_shipped_on",
        label: "发货日期记录趋势",
        chartType: "line",
        dimension: "shipped_on",
        metric: "count",
      },
    );

    expect(JSON.parse(prefill.queryText)).toEqual(expect.objectContaining({
      modelId: "pinduoduo_sales.analysis",
      metricIds: ["pinduoduo_sales.row_count"],
      dimensionIds: ["pinduoduo_sales.shipped_on"],
    }));
    expect(prefill.queryText).not.toContain("COUNT(");
  });

  test("rejects unsafe module and field identifiers before opening the creator", () => {
    expect(() =>
      buildModuleSuggestionPrefill(
        {
          code: "orders",
          name: "销售订单",
          enabled: true,
          outputTable: "unified_sales; DROP TABLE charts",
        } as ModuleData,
        {
          key: "amount_by_product",
          label: "商品金额排行",
          chartType: "bar",
          dimension: "product_name",
          metric: "amount",
        },
      ),
    ).toThrow("无法创建该字段建议");
  });

  test("rejects incompatible time and measure types before generating SQL", () => {
    const module = {
      code: "pinduoduo_sales",
      name: "拼多多销售",
      enabled: true,
      origin: "user",
      outputTable: "unified_pinduoduo_sales",
      columns: [
        { name: "bad_time", label: "错误日期", type: "text" },
        { name: "bad_amount", label: "错误金额", type: "text" },
      ],
    } as ModuleData;

    expect(() =>
      buildModuleSuggestionPrefill(module, {
        key: "bad_line",
        label: "错误趋势",
        chartType: "line",
        dimension: "bad_time",
        metric: "count",
      }),
    ).toThrow("无法创建该字段建议");
    expect(() =>
      buildModuleSuggestionPrefill(module, {
        key: "bad_bar",
        label: "错误汇总",
        chartType: "bar",
        dimension: "bad_time",
        metric: "bad_amount",
      }),
    ).toThrow("无法创建该字段建议");
  });

  test("falls back invalid URL modules to all and exposes suggestions only for one selection", () => {
    const modules = sampleModules().map((module) =>
      module.code === "pinduoduo_sales"
        ? {
            ...module,
            fieldSuggestions: [
              {
                key: "field_campaign",
                label: "活动分布",
                chartType: "bar" as const,
                dimension: "campaign",
                metric: "count",
              },
            ],
          }
        : module,
    );

    expect(resolveSelectedModuleCode("missing", modules)).toBe("all");
    expect(resolveSelectedModuleCode("archived", modules)).toBe("all");
    expect(resolveSelectedModuleCode("pinduoduo_sales", modules)).toBe(
      "pinduoduo_sales",
    );
    expect(fieldSuggestionsForSelection("all", modules)).toEqual([]);
    expect(
      fieldSuggestionsForSelection("pinduoduo_sales", modules).map(
        (suggestion) => suggestion.key,
      ),
    ).toEqual(["field_campaign"]);
  });

  test("groups categorized modules into one stable business entry", () => {
    const modules = [
      {
        code: "orders",
        name: "销售订单",
        category: "shop_ops",
        categoryLabel: "店铺经营",
        enabled: true,
      },
      {
        code: "standalone",
        name: "单独模块",
        categoryLabel: "没有 category 时不应改名",
        enabled: true,
      },
      {
        code: "pinduoduo_sales",
        name: "拼多多销售",
        category: "shop_ops",
        categoryLabel: "不会覆盖首个分类名",
        enabled: true,
      },
    ] as ModuleData[];
    const charts = [
      { id: 30, moduleCode: "pinduoduo_sales", config: { dashboardOrder: 2 } },
      { id: 20, moduleCode: "standalone", config: {} },
      { id: 10, moduleCode: "orders", config: { dashboardOrder: 1 } },
    ] as BoardChart[];

    const groups = groupChartsByModule(charts, modules);

    expect(groups.map((group) => [group.code, group.name, group.moduleCodes])).toEqual([
      ["category:shop_ops", "店铺经营", ["orders", "pinduoduo_sales"]],
      ["standalone", "单独模块", ["standalone"]],
    ]);
    expect(groups[0].charts.map((chart) => chart.id)).toEqual([10, 30]);
    expect(filterModuleGroups(groups, "category:shop_ops")[0].charts).toHaveLength(2);
    expect(resolveSelectedModuleCode("orders", modules, charts)).toBe("category:shop_ops");
    expect(moduleCodesForSelection("category:shop_ops", modules)).toEqual([
      "orders",
      "pinduoduo_sales",
    ]);
  });

  test("keeps one empty category option and suppresses ambiguous suggestions", () => {
    const modules = [
      {
        code: "orders",
        name: "销售订单",
        category: "shop_ops",
        enabled: true,
        fieldSuggestions: [{
          key: "orders_by_day",
          label: "订单趋势",
          chartType: "line",
          dimension: "paid_at",
          metric: "amount",
        }],
      },
      {
        code: "ads",
        name: "推广数据",
        category: "shop_ops",
        categoryLabel: "店铺经营",
        enabled: true,
      },
    ] as ModuleData[];

    expect(buildModuleFilterOptions([], modules)).toEqual([
      { code: "category:shop_ops", name: "店铺经营", count: 0 },
    ]);
    expect(fieldSuggestionsForSelection("category:shop_ops", modules)).toEqual([]);
  });

  test("disambiguates duplicate names and virtual codes without merging charts", () => {
    const modules = [
      {
        code: "orders",
        name: "销售订单",
        category: "shop_ops",
        categoryLabel: "经营",
        enabled: true,
      },
      { code: "standalone", name: "经营", enabled: true },
    ] as ModuleData[];
    const charts = [
      { id: 1, moduleCode: "orders", config: {} },
      { id: 2, moduleCode: "standalone", config: {} },
      {
        id: 3,
        moduleCode: "category:shop_ops",
        config: { moduleName: "经营" },
      },
    ] as BoardChart[];

    const groups = groupChartsByModule(charts, modules);

    expect(groups.map((group) => group.code)).toEqual([
      "category:shop_ops",
      "standalone",
      "virtual:category%3Ashop_ops",
    ]);
    expect(new Set(groups.map((group) => group.name)).size).toBe(groups.length);
    expect(groups.map((group) => group.charts.map((chart) => chart.id))).toEqual([
      [1],
      [2],
      [3],
    ]);
    expect(resolveSelectedModuleCode(
      "virtual:category%3Ashop_ops",
      modules,
      charts,
    )).toBe("virtual:category%3Ashop_ops");
  });

  test("promotes a named synthetic cockpit without registering a fake ETL module", () => {
    const demoChart = {
      id: 20,
      datasetId: 20,
      name: "成交总额",
      chartType: "kpi",
      moduleCode: "cockpit_demo",
      createdAt: "2026-08-21T00:00:00.000Z",
      config: {
        moduleName: "全域电商经营演示",
        moduleOrder: -100,
        featured: true,
        demo: true,
        dashboardOrder: 1,
      },
    } as BoardChart;
    const groups = groupChartsByModule([...sampleCharts(), demoChart], sampleModules());

    expect(groups[0]).toMatchObject({
      code: "cockpit_demo",
      name: "全域电商经营演示",
      demo: true,
    });
    expect(groups[0].charts.map((chart) => chart.id)).toEqual([20]);
    expect(resolveSelectedModuleCode("cockpit_demo", sampleModules(), [demoChart])).toBe("cockpit_demo");
  });

  test("defaults to the first real business entry even when a synthetic cockpit is featured", () => {
    const groups = [
      {
        code: "category:taobao_overview",
        name: "淘系经营概览",
        charts: [{ id: 1, moduleCode: "taobao_trade_day", config: {} }],
        moduleCodes: ["taobao_trade_day"],
      },
      {
        code: "cockpit_demo",
        name: "经营驾驶舱",
        charts: [{ id: 2, moduleCode: "cockpit_demo", config: { featured: true } }],
        moduleCodes: ["cockpit_demo"],
        demo: true,
      },
    ] as ReturnType<typeof groupChartsByModule>;

    expect(resolveDefaultModuleCode(groups)).toBe("category:taobao_overview");
  });

  test("falls back to a featured synthetic cockpit only when no real entry has charts", () => {
    const groups = [{
      code: "cockpit_demo",
      name: "经营驾驶舱",
      charts: [{ id: 2, moduleCode: "cockpit_demo", config: { featured: true } }],
      moduleCodes: ["cockpit_demo"],
      demo: true,
    }] as ReturnType<typeof groupChartsByModule>;

    expect(resolveDefaultModuleCode(groups)).toBe("cockpit_demo");
    expect(resolveDefaultModuleCode([])).toBe("all");
  });
});
