export const DEMO_TAG = "[演示]";
export const LEGACY_DEMO_TAG = "[示例]";
export const DEMO_FILE = `${DEMO_TAG}全域经营驾驶舱事实表.xlsx`;
export const LEGACY_DEMO_FILE = `${LEGACY_DEMO_TAG}竞品面霜SKU.xlsx`;
export const LEGACY_DEMO_SOURCE_NAME = `${LEGACY_DEMO_TAG}竞品面霜 SKU`;
export const DEMO_DATASET = `${DEMO_TAG}全域经营事实明细`;
export const LEGACY_DEMO_DATASET = `${LEGACY_DEMO_TAG}竞品价格销量`;
export const DEMO_DASHBOARD = `${DEMO_TAG}全域电商经营驾驶舱`;
export const LEGACY_DEMO_DASHBOARD = `${LEGACY_DEMO_TAG}竞品分析看板`;
export const LEGACY_DEMO_CHART_NAMES = [
  `${LEGACY_DEMO_TAG}竞品价格对比`,
  `${LEGACY_DEMO_TAG}竞品月销量对比`,
] as const;
export const LEGACY_DEMO_DASHBOARD_DESCRIPTION = "公开品牌竞品面霜的价格/销量对比示例，用于演示与新同事上手。";
export const DEMO_MODULE_CODE = "cockpit_demo";
export const DEMO_MODULE_NAME = "全域电商经营演示";
export const DEMO_PERIOD = {
  from: "2026-06-26",
  to: "2026-08-20",
  days: 56,
} as const;
export const DEMO_DASHBOARD_DESCRIPTION = `确定性合成数据，覆盖 ${DEMO_PERIOD.from} 至 ${DEMO_PERIOD.to}，用于产品演示与回归验收。`;

export const DEMO_FIELD_LABELS: Record<string, string> = {
  record_id: "记录编号",
  event_date: "日期",
  weekday: "星期",
  hour_bucket: "成交时段",
  platform: "平台",
  region: "区域",
  category: "品类",
  brand: "品牌",
  store: "店铺",
  campaign: "营销活动",
  visitors: "访客数",
  product_views: "商品浏览量",
  add_to_cart: "加购人数",
  paid_orders: "支付订单数",
  units_sold: "销售件数",
  gmv: "成交金额",
  refund_amount: "退款金额",
  ad_spend: "广告花费",
  product_cost: "商品成本",
  fulfillment_cost: "履约成本",
  gross_profit: "毛利润",
  gmv_target: "成交目标",
  profit_target: "毛利目标",
  order_target: "订单目标",
  stock_turnover_days: "库存周转天数",
  rating: "客户评分",
  new_customers: "新客数",
  repeat_customers: "复购客数",
};

export const DEMO_FILTER_FIELDS = [
  "platform",
  "region",
  "category",
  "brand",
] as const;

export type DemoCockpitRow = {
  记录编号: string;
  日期: string;
  星期: string;
  成交时段: string;
  平台: string;
  区域: string;
  品类: string;
  品牌: string;
  店铺: string;
  营销活动: string;
  访客数: number;
  商品浏览量: number;
  加购人数: number;
  支付订单数: number;
  销售件数: number;
  成交金额: number;
  退款金额: number;
  广告花费: number;
  商品成本: number;
  履约成本: number;
  毛利润: number;
  成交目标: number;
  毛利目标: number;
  订单目标: number;
  库存周转天数: number;
  客户评分: number;
  新客数: number;
  复购客数: number;
};

type DemoChartType =
  | "bar"
  | "horizontal_bar"
  | "stacked_bar"
  | "line"
  | "area"
  | "pie"
  | "radar"
  | "combo"
  | "scatter"
  | "funnel"
  | "treemap"
  | "heatmap"
  | "gauge"
  | "kpi"
  | "table";

export type DemoCockpitChartDefinition = {
  key: string;
  name: string;
  chartType: DemoChartType;
  config: Record<string, unknown>;
};

const PLATFORMS = [
  { name: "天猫", factor: 1.18 },
  { name: "京东", factor: 1.08 },
  { name: "抖音", factor: 1.28 },
  { name: "拼多多", factor: 0.92 },
] as const;

const CATEGORIES = [
  { name: "个护清洁", demand: 1.22, price: 129, costRate: 0.39 },
  { name: "家居日用", demand: 1.08, price: 89, costRate: 0.43 },
  { name: "宠物生活", demand: 0.94, price: 159, costRate: 0.42 },
  { name: "健康护理", demand: 0.88, price: 219, costRate: 0.37 },
  { name: "数码配件", demand: 0.78, price: 269, costRate: 0.51 },
] as const;

const BRANDS = [
  { name: "示例·澄野", factor: 1.16 },
  { name: "示例·栖木", factor: 1.02 },
  { name: "示例·砾光", factor: 0.92 },
  { name: "示例·弥新", factor: 0.82 },
] as const;

const REGIONS = ["华东", "华南", "华北", "华中", "西南", "东北"] as const;
const CAMPAIGNS = ["日常经营", "会员日", "新品首发", "平台大促", "达人直播"] as const;
const HOURS = ["06-09", "09-12", "12-15", "15-18", "18-21", "21-24"] as const;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function round(value: number, digits = 0): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function dateText(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function buildSyntheticCockpitRows(seed = 20260821): DemoCockpitRow[] {
  const random = seededRandom(seed);
  const rows: DemoCockpitRow[] = [];
  const endDate = new Date(`${DEMO_PERIOD.to}T00:00:00.000Z`);
  const startDate = new Date(endDate.getTime() - (DEMO_PERIOD.days - 1) * 86_400_000);

  for (let dayIndex = 0; dayIndex < DEMO_PERIOD.days; dayIndex += 1) {
    const date = new Date(startDate.getTime() + dayIndex * 86_400_000);
    const weekday = WEEKDAYS[date.getUTCDay()];
    const weekendFactor = date.getUTCDay() === 0 || date.getUTCDay() === 6 ? 1.13 : 1;
    const trendFactor = 0.9 + dayIndex / (DEMO_PERIOD.days - 1) * 0.19;

    for (let platformIndex = 0; platformIndex < PLATFORMS.length; platformIndex += 1) {
      const platform = PLATFORMS[platformIndex];
      for (let categoryIndex = 0; categoryIndex < CATEGORIES.length; categoryIndex += 1) {
        const category = CATEGORIES[categoryIndex];
        for (let brandIndex = 0; brandIndex < BRANDS.length; brandIndex += 1) {
          const brand = BRANDS[brandIndex];
          const region = REGIONS[(dayIndex + platformIndex * 2 + categoryIndex + brandIndex) % REGIONS.length];
          const campaignIndex = dayIndex % 14 === 0
            ? 3
            : dayIndex % 9 === 0
              ? 4
              : (dayIndex + categoryIndex + platformIndex) % CAMPAIGNS.length;
          const campaign = CAMPAIGNS[campaignIndex];
          const campaignFactor = [0.98, 1.08, 1.14, 1.3, 1.22][campaignIndex];
          const noise = 0.86 + random() * 0.28;
          const visitors = Math.max(40, round(
            235 * platform.factor * category.demand * brand.factor * weekendFactor * trendFactor * campaignFactor * noise,
          ));
          const productViews = round(visitors * (0.74 + random() * 0.18));
          const addToCart = Math.min(productViews, round(visitors * (0.17 + random() * 0.1)));
          const paidOrders = Math.min(addToCart, round(addToCart * (0.43 + random() * 0.22)));
          const unitsSold = Math.max(paidOrders, round(paidOrders * (1.06 + random() * 0.22)));
          const unitPrice = category.price * (0.93 + random() * 0.16) * (platform.name === "拼多多" ? 0.9 : 1);
          const gmv = round(unitsSold * unitPrice, 2);
          const refundAmount = round(gmv * (0.022 + random() * 0.045), 2);
          const adSpend = round(gmv * (0.075 + random() * 0.07), 2);
          const productCost = round(gmv * (category.costRate + random() * 0.045), 2);
          const fulfillmentCost = round(paidOrders * (6.2 + categoryIndex * 1.4 + random() * 4), 2);
          const grossProfit = round(Math.max(
            gmv * 0.08,
            gmv - refundAmount - adSpend - productCost - fulfillmentCost,
          ), 2);
          const targetPulse = 0.92 + ((dayIndex + platformIndex + categoryIndex) % 7) * 0.025;
          const gmvTarget = round(gmv / targetPulse, 2);
          const profitTarget = round(grossProfit / (0.9 + ((dayIndex + brandIndex) % 6) * 0.035), 2);
          const orderTarget = Math.max(1, round(paidOrders / (0.91 + ((dayIndex + categoryIndex) % 5) * 0.04)));
          const newCustomers = round(paidOrders * (0.51 + random() * 0.16));
          const repeatCustomers = Math.max(0, paidOrders - newCustomers);

          rows.push({
            记录编号: `DEMO-${dateText(date).replaceAll("-", "")}-${platformIndex + 1}${categoryIndex + 1}${brandIndex + 1}`,
            日期: dateText(date),
            星期: weekday,
            成交时段: HOURS[(dayIndex + platformIndex + brandIndex * 2) % HOURS.length],
            平台: platform.name,
            区域: region,
            品类: category.name,
            品牌: brand.name,
            店铺: `${brand.name.replace("示例·", "")}${platform.name}旗舰店`,
            营销活动: campaign,
            访客数: visitors,
            商品浏览量: productViews,
            加购人数: addToCart,
            支付订单数: paidOrders,
            销售件数: unitsSold,
            成交金额: gmv,
            退款金额: refundAmount,
            广告花费: adSpend,
            商品成本: productCost,
            履约成本: fulfillmentCost,
            毛利润: grossProfit,
            成交目标: gmvTarget,
            毛利目标: profitTarget,
            订单目标: orderTarget,
            库存周转天数: round(17 + categoryIndex * 3.1 + random() * 11, 1),
            客户评分: round(4.3 + random() * 0.65, 2),
            新客数: newCustomers,
            复购客数: repeatCustomers,
          });
        }
      }
    }
  }

  return rows;
}

export function buildDemoCockpitFactQuery(tableName: string): string {
  if (!/^uf_\d+$/.test(tableName)) throw new Error("非法演示数据表名");
  return `SELECT
  "记录编号" AS record_id,
  "日期"::date AS event_date,
  "星期" AS weekday,
  "成交时段" AS hour_bucket,
  "平台" AS platform,
  "区域" AS region,
  "品类" AS category,
  "品牌" AS brand,
  "店铺" AS store,
  "营销活动" AS campaign,
  "访客数"::numeric AS visitors,
  "商品浏览量"::numeric AS product_views,
  "加购人数"::numeric AS add_to_cart,
  "支付订单数"::numeric AS paid_orders,
  "销售件数"::numeric AS units_sold,
  "成交金额"::numeric AS gmv,
  "退款金额"::numeric AS refund_amount,
  "广告花费"::numeric AS ad_spend,
  "商品成本"::numeric AS product_cost,
  "履约成本"::numeric AS fulfillment_cost,
  "毛利润"::numeric AS gross_profit,
  "成交目标"::numeric AS gmv_target,
  "毛利目标"::numeric AS profit_target,
  "订单目标"::numeric AS order_target,
  "库存周转天数"::numeric AS stock_turnover_days,
  "客户评分"::numeric AS rating,
  "新客数"::numeric AS new_customers,
  "复购客数"::numeric AS repeat_customers
FROM "user_data"."${tableName}"
ORDER BY "日期"::date, "平台", "品类", "品牌"`;
}

const sharedConfig = {
  aggregationMode: "sum" as const,
  moduleName: DEMO_MODULE_NAME,
  moduleOrder: -100,
  featured: true,
  demo: true,
  dateField: "event_date",
  filterFields: [...DEMO_FILTER_FIELDS],
  fieldLabels: DEMO_FIELD_LABELS,
  periodFrom: DEMO_PERIOD.from,
  periodTo: DEMO_PERIOD.to,
  rowCount: DEMO_PERIOD.days * PLATFORMS.length * CATEGORIES.length * BRANDS.length,
};

export const DEMO_COCKPIT_CHARTS: DemoCockpitChartDefinition[] = [
  {
    key: "gmv-kpi",
    name: "成交总额",
    chartType: "kpi",
    config: {
      ...sharedConfig,
      subtitle: "全渠道含税成交",
      yFields: ["gmv"],
      benchmarkField: "gmv_target",
      comparisonLabel: "目标达成",
      valuePrefix: "¥",
      displaySize: "kpi",
      dashboardOrder: 10,
    },
  },
  {
    key: "profit-kpi",
    name: "毛利润",
    chartType: "kpi",
    config: {
      ...sharedConfig,
      subtitle: "扣除退款、投放、货品与履约",
      yFields: ["gross_profit"],
      benchmarkField: "profit_target",
      comparisonLabel: "目标达成",
      valuePrefix: "¥",
      displaySize: "kpi",
      dashboardOrder: 11,
    },
  },
  {
    key: "orders-kpi",
    name: "支付订单",
    chartType: "kpi",
    config: {
      ...sharedConfig,
      subtitle: "已支付订单口径",
      yFields: ["paid_orders"],
      benchmarkField: "order_target",
      comparisonLabel: "目标达成",
      valueSuffix: " 单",
      displaySize: "kpi",
      dashboardOrder: 12,
    },
  },
  {
    key: "roi-kpi",
    name: "广告投入产出",
    chartType: "kpi",
    config: {
      ...sharedConfig,
      subtitle: "成交金额 ÷ 广告花费",
      yFields: ["gmv", "ad_spend"],
      valueMode: "ratio",
      targetValue: 7.2,
      comparisonLabel: "较目标",
      valueSuffix: "x",
      valueDecimals: 2,
      valueLabel: "广告投入产出比",
      displaySize: "kpi",
      dashboardOrder: 13,
    },
  },
  {
    key: "trend-combo",
    name: "成交额与毛利润趋势",
    chartType: "combo",
    config: {
      ...sharedConfig,
      subtitle: "按日观察规模与利润同步变化",
      xField: "event_date",
      yFields: ["gmv", "gross_profit"],
      displaySize: "wide",
      dashboardOrder: 20,
    },
  },
  {
    key: "target-gauge",
    name: "销售目标达成率",
    chartType: "gauge",
    config: {
      ...sharedConfig,
      subtitle: "当前筛选范围内动态计算",
      yFields: ["gmv", "gmv_target"],
      displaySize: "compact",
      dashboardOrder: 21,
    },
  },
  {
    key: "category-platform",
    name: "品类 × 平台成交结构",
    chartType: "stacked_bar",
    config: {
      ...sharedConfig,
      subtitle: "点击平台系列可联动其他图表",
      xField: "category",
      seriesField: "platform",
      yFields: ["gmv"],
      displaySize: "wide",
      dashboardOrder: 30,
    },
  },
  {
    key: "profit-treemap",
    name: "品类品牌利润版图",
    chartType: "treemap",
    config: {
      ...sharedConfig,
      subtitle: "面积代表毛利润贡献",
      xField: "category",
      seriesField: "brand",
      yFields: ["gross_profit"],
      displaySize: "compact",
      dashboardOrder: 31,
    },
  },
  {
    key: "orders-heatmap",
    name: "星期 × 时段订单热力",
    chartType: "heatmap",
    config: {
      ...sharedConfig,
      subtitle: "识别高转化经营时段",
      xField: "hour_bucket",
      seriesField: "weekday",
      yFields: ["paid_orders"],
      displaySize: "wide",
      dashboardOrder: 40,
    },
  },
  {
    key: "conversion-funnel",
    name: "全链路转化漏斗",
    chartType: "funnel",
    config: {
      ...sharedConfig,
      subtitle: "访客到支付的逐层转化",
      yFields: ["visitors", "product_views", "add_to_cart", "paid_orders"],
      displaySize: "compact",
      dashboardOrder: 41,
    },
  },
  {
    key: "ad-profit-scatter",
    name: "品牌投放效率矩阵",
    chartType: "scatter",
    config: {
      ...sharedConfig,
      subtitle: "横轴投放、纵轴利润、气泡代表成交",
      xField: "ad_spend",
      yFields: ["gross_profit"],
      seriesField: "platform",
      pointField: "brand",
      sizeField: "gmv",
      displaySize: "half",
      dashboardOrder: 50,
    },
  },
  {
    key: "brand-ranking",
    name: "品牌成交贡献排行",
    chartType: "horizontal_bar",
    config: {
      ...sharedConfig,
      subtitle: "点击品牌可联动其他图表",
      xField: "brand",
      yFields: ["gmv"],
      displaySize: "half",
      dashboardOrder: 51,
    },
  },
  {
    key: "detail-table",
    name: "渠道经营明细",
    chartType: "table",
    config: {
      ...sharedConfig,
      subtitle: "支持当前切片条件下核对明细",
      columnOrder: [
        "event_date",
        "platform",
        "region",
        "category",
        "brand",
        "store",
        "campaign",
        "gmv",
        "gross_profit",
        "paid_orders",
        "refund_amount",
        "ad_spend",
      ],
      displaySize: "full",
      dashboardOrder: 60,
    },
  },
];
