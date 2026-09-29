type ColumnType = "text" | "int" | "numeric" | "timestamp" | "date" | "boolean";
type SemanticRole =
  | "time"
  | "amount"
  | "quantity"
  | "product_id"
  | "product_name"
  | "order_id"
  | "status"
  | "sku"
  | "shop"
  | "dimension";

type ColumnOptions = {
  required?: boolean;
  semanticRole?: SemanticRole;
  maxLen?: number;
  hint?: string;
};

function column(
  name: string,
  type: ColumnType,
  label: string,
  options: ColumnOptions = {},
) {
  return {
    name,
    source: [name],
    type,
    label,
    ...(options.required ? { required: true } : {}),
    ...(options.semanticRole ? { semanticRole: options.semanticRole } : {}),
    ...(options.maxLen ? { maxLen: options.maxLen } : {}),
    ...(options.hint ? { hint: options.hint } : {}),
  };
}

function dimension(
  moduleCode: string,
  field: string,
  label: string,
  kind: "categorical" | "time" = "categorical",
  timeGrain?: "day" | "month",
) {
  return {
    id: `${moduleCode}.${field}`,
    label,
    field,
    kind,
    ...(timeGrain ? { timeGrain } : {}),
  };
}

function sumMetric(
  moduleCode: string,
  field: string,
  label: string,
  unit: "number" | "currency" | "percent" | "quantity" = "number",
  additiveAcrossTime = true,
) {
  return {
    id: `${moduleCode}.${field}`,
    label,
    aggregation: "sum" as const,
    field,
    unit,
    additiveAcrossTime,
  };
}

function countMetric(moduleCode: string, label = "记录数", additiveAcrossTime = true) {
  return {
    id: `${moduleCode}.row_count`,
    label,
    aggregation: "count" as const,
    unit: "number" as const,
    additiveAcrossTime,
  };
}

function ratioMetric(
  moduleCode: string,
  id: string,
  label: string,
  numeratorField: string,
  denominatorField: string,
  unit: "number" | "currency" | "percent" = "number",
) {
  return {
    id: `${moduleCode}.${id}`,
    label,
    aggregation: "ratio" as const,
    numeratorField,
    denominatorField,
    unit,
    additiveAcrossTime: false,
  };
}

function moduleDefinition(input: {
  code: string;
  name: string;
  category: string;
  categoryLabel: string;
  description: string;
  columns: ReturnType<typeof column>[];
  timeKey: string;
  defaultRankingDimensionId: string | null;
  inclusionRule?: { field: string; includedValues: string[] };
  dimensions: ReturnType<typeof dimension>[];
  metrics: Array<
    ReturnType<typeof sumMetric>
    | ReturnType<typeof countMetric>
    | ReturnType<typeof ratioMetric>
  >;
}) {
  return {
    schemaVersion: "module-manifest/v1" as const,
    module: {
      code: input.code,
      name: input.name,
      category: input.category,
      categoryLabel: input.categoryLabel,
      description: input.description,
      columns: input.columns,
      platforms: [{
        code: "standard",
        name: "标准表",
        filePattern: input.code,
        patternFlags: "i",
        enabled: true,
      }],
      timeKey: input.timeKey,
      ...(input.inclusionRule ? { inclusionRule: input.inclusionRule } : {}),
      usages: ["summary", "ai_chart", "ai_analysis"] as const,
      enabled: true,
      hasTransform: false,
      semanticModel: {
        schemaVersion: "semantic-manifest/v1" as const,
        id: `${input.code}.analysis`,
        version: 1,
        dimensions: input.dimensions,
        metrics: input.metrics,
        defaultRankingDimensionId: input.defaultRankingDimensionId,
      },
    },
  };
}

const sycmTraceColumns = () => [
  column("source_system", "text", "来源系统", { required: true, maxLen: 64 }),
  column("source_account_alias", "text", "来源账户别名", {
    required: true,
    semanticRole: "shop",
    maxLen: 128,
  }),
  column("source_batch", "text", "来源批次", { required: true, maxLen: 128 }),
  column("source_exported_at", "timestamp", "导出时间"),
  column("period_start", "date", "期间开始日", { required: true, semanticRole: "time" }),
  column("period_end", "date", "期间结束日", { required: true }),
  column("period_granularity", "text", "期间粒度", { required: true, maxLen: 16 }),
];

const pddTraceColumns = () => [
  column("source_platform", "text", "来源平台", { required: true, maxLen: 64 }),
  column("source_account_alias", "text", "来源账户别名", {
    required: true,
    semanticRole: "shop",
    maxLen: 128,
  }),
  column("source_batch", "text", "来源批次", { required: true, maxLen: 128 }),
];

const tradeCode = "taobao_trade_day";
const terminalCode = "taobao_terminal_day";
const priceCode = "taobao_price_band_day";
const categoryCode = "taobao_category_month";
const orderCode = "pdd_order_item";
const accountAdsCode = "pdd_ads_account_day";
const productAdsCode = "pdd_ads_product_period";

export const moduleCodes = [
  tradeCode,
  terminalCode,
  priceCode,
  categoryCode,
  orderCode,
  accountAdsCode,
  productAdsCode,
] as const;

export const ecommerceWorkbenchSolution = {
  schemaVersion: "vertical-solution/v1" as const,
  id: "ecommerce.operations_workbench",
  version: 1,
  label: "电商经营工作台",
  description: "淘系交易结构与拼多多订单、推广的七表标准方案。仅包含字段、指标与模块定义，不包含业务数据或密钥。",
  dataPolicy: {
    containsBusinessData: false as const,
    containsSecrets: false as const,
  },
  modules: [
    moduleDefinition({
      code: tradeCode,
      name: "淘系交易日",
      category: "workbench_taobao_overview",
      categoryLabel: "淘系经营概览",
      description: "生意参谋交易总览按日归并后的标准事实表。",
      columns: [
        ...sycmTraceColumns(),
        column("terminal_scope", "text", "终端范围", { semanticRole: "dimension", maxLen: 64 }),
        column("visitors", "int", "访客数", { required: true, semanticRole: "quantity" }),
        column("visitors_change_rate", "numeric", "访客变化率"),
        column("ordering_buyers", "int", "下单买家数"),
        column("ordering_buyers_change_rate", "numeric", "下单买家变化率"),
        column("ordering_amount", "numeric", "下单金额"),
        column("ordering_amount_change_rate", "numeric", "下单金额变化率"),
        column("paying_buyers", "int", "支付买家数"),
        column("paying_buyers_change_rate", "numeric", "支付买家变化率"),
        column("paid_amount", "numeric", "支付金额", { required: true, semanticRole: "amount" }),
        column("paid_amount_change_rate", "numeric", "支付金额变化率"),
        column("avg_order_value", "numeric", "客单价"),
        column("avg_order_value_change_rate", "numeric", "客单价变化率"),
        column("order_conversion_rate", "numeric", "下单转化率"),
        column("order_to_pay_conversion_rate", "numeric", "下单支付转化率"),
        column("payment_conversion_rate", "numeric", "支付转化率"),
        column("payment_conversion_rate_change_rate", "numeric", "支付转化率变化"),
        column("paid_suborders", "int", "支付子订单数"),
        column("new_buyers", "int", "新买家数"),
        column("returning_buyers", "int", "老买家数"),
      ],
      timeKey: "period_start",
      defaultRankingDimensionId: null,
      dimensions: [
        dimension(tradeCode, "period_start", "日期", "time", "day"),
        dimension(tradeCode, "source_account_alias", "账户"),
        dimension(tradeCode, "terminal_scope", "终端范围"),
      ],
      metrics: [
        sumMetric(tradeCode, "paid_amount", "支付金额", "currency"),
        sumMetric(tradeCode, "visitors", "访客数", "quantity", false),
        sumMetric(tradeCode, "paying_buyers", "支付买家数", "quantity", false),
        sumMetric(tradeCode, "ordering_amount", "下单金额", "currency"),
        sumMetric(tradeCode, "ordering_buyers", "下单买家数", "quantity", false),
        sumMetric(tradeCode, "paid_suborders", "支付子订单数", "quantity"),
        sumMetric(tradeCode, "new_buyers", "新买家数", "quantity", false),
        sumMetric(tradeCode, "returning_buyers", "老买家数", "quantity", false),
        ratioMetric(tradeCode, "avg_order_value", "客单价", "paid_amount", "paying_buyers", "currency"),
        ratioMetric(tradeCode, "payment_conversion_rate", "支付转化率", "paying_buyers", "visitors", "percent"),
        ratioMetric(tradeCode, "order_to_pay_conversion_rate", "下单支付转化率", "paying_buyers", "ordering_buyers", "percent"),
      ],
    }),
    moduleDefinition({
      code: terminalCode,
      name: "淘系终端日",
      category: "workbench_taobao_structure",
      categoryLabel: "淘系交易结构",
      description: "生意参谋终端构成按日归并后的标准事实表。",
      columns: [
        ...sycmTraceColumns(),
        column("terminal", "text", "终端", { required: true, semanticRole: "dimension", maxLen: 64 }),
        column("paid_amount", "numeric", "支付金额", { required: true, semanticRole: "amount" }),
        column("paid_amount_share", "numeric", "支付金额占比"),
        column("paid_product_count", "int", "支付商品数", { semanticRole: "quantity" }),
        column("paying_buyers", "int", "支付买家数"),
        column("payment_conversion_rate", "numeric", "支付转化率"),
      ],
      timeKey: "period_start",
      defaultRankingDimensionId: `${terminalCode}.terminal`,
      dimensions: [
        dimension(terminalCode, "period_start", "日期", "time", "day"),
        dimension(terminalCode, "terminal", "终端"),
        dimension(terminalCode, "source_account_alias", "账户"),
      ],
      metrics: [
        sumMetric(terminalCode, "paid_amount", "支付金额", "currency"),
        sumMetric(terminalCode, "paid_product_count", "支付商品数", "quantity", false),
        sumMetric(terminalCode, "paying_buyers", "支付买家数", "quantity", false),
        countMetric(terminalCode),
      ],
    }),
    moduleDefinition({
      code: priceCode,
      name: "淘系价格带日",
      category: "workbench_taobao_structure",
      categoryLabel: "淘系交易结构",
      description: "生意参谋价格带构成按日归并后的标准事实表。买家占比不视为互斥构成。",
      columns: [
        ...sycmTraceColumns(),
        column("terminal_scope", "text", "终端范围", { maxLen: 64 }),
        column("price_band_id", "text", "价格带 ID", { required: true, maxLen: 128 }),
        column("price_band_label", "text", "价格带", { required: true, semanticRole: "dimension", maxLen: 128 }),
        column("paying_buyer_share", "numeric", "支付买家占比"),
        column("paying_buyers", "int", "支付买家数", { semanticRole: "quantity" }),
        column("paid_amount", "numeric", "支付金额", { required: true, semanticRole: "amount" }),
        column("payment_conversion_rate", "numeric", "支付转化率"),
      ],
      timeKey: "period_start",
      defaultRankingDimensionId: `${priceCode}.price_band_label`,
      dimensions: [
        dimension(priceCode, "period_start", "日期", "time", "day"),
        dimension(priceCode, "price_band_label", "价格带"),
        dimension(priceCode, "source_account_alias", "账户"),
      ],
      metrics: [
        sumMetric(priceCode, "paid_amount", "支付金额", "currency"),
        sumMetric(priceCode, "paying_buyers", "支付买家数", "quantity", false),
        countMetric(priceCode),
      ],
    }),
    moduleDefinition({
      code: categoryCode,
      name: "淘系类目月",
      category: "workbench_taobao_structure",
      categoryLabel: "淘系交易结构",
      description: "生意参谋一级与叶子类目按月合并的标准事实表，保留层级字段。",
      columns: [
        ...sycmTraceColumns(),
        column("period_month", "date", "月份"),
        column("category_level", "text", "类目层级", { required: true, maxLen: 32 }),
        column("category_id", "text", "类目 ID", { required: true, maxLen: 128 }),
        column("category_label", "text", "类目", { required: true, semanticRole: "dimension", maxLen: 256 }),
        column("terminal_scope", "text", "终端范围", { maxLen: 64 }),
        column("level_1_category_id", "text", "一级类目 ID", { maxLen: 128 }),
        column("level_1_category_label", "text", "一级类目", { maxLen: 256 }),
        column("leaf_category_id", "text", "叶子类目 ID", { maxLen: 128 }),
        column("leaf_category_label", "text", "叶子类目", { maxLen: 256 }),
        column("paid_amount", "numeric", "支付金额", { required: true, semanticRole: "amount" }),
        column("paid_amount_change_rate", "numeric", "支付金额变化率"),
        column("paid_amount_share", "numeric", "支付金额占比"),
        column("paid_amount_share_change_rate", "numeric", "支付金额占比变化率"),
        column("paying_buyers", "int", "支付买家数", { semanticRole: "quantity" }),
        column("paying_buyers_change_rate", "numeric", "支付买家变化率"),
        column("payment_conversion_rate", "numeric", "支付转化率"),
        column("payment_conversion_rate_change_rate", "numeric", "支付转化率变化"),
        column("visitors_change_rate", "numeric", "访客变化率"),
      ],
      timeKey: "period_start",
      defaultRankingDimensionId: `${categoryCode}.category_label`,
      inclusionRule: {
        field: "category_level",
        includedValues: ["leaf"],
      },
      dimensions: [
        dimension(categoryCode, "period_start", "月份", "time", "month"),
        dimension(categoryCode, "category_label", "类目"),
        dimension(categoryCode, "category_level", "类目层级"),
        dimension(categoryCode, "source_account_alias", "账户"),
      ],
      metrics: [
        sumMetric(categoryCode, "paid_amount", "支付金额", "currency"),
        sumMetric(categoryCode, "paying_buyers", "支付买家数", "quantity", false),
        countMetric(categoryCode),
      ],
    }),
    moduleDefinition({
      code: orderCode,
      name: "拼多多订单明细",
      category: "workbench_pdd_orders_quality",
      categoryLabel: "拼多多订单与数据质量",
      description: "拼多多订单商品明细标准表。成交指标使用有效销售派生字段，同时保留取消、退款和质量记录。",
      columns: [
        ...pddTraceColumns(),
        column("order_id", "text", "订单号", { required: true, semanticRole: "order_id", maxLen: 128 }),
        column("order_status", "text", "订单状态", { required: true, semanticRole: "status", maxLen: 128 }),
        column("order_created_at", "timestamp", "成交时间"),
        column("order_date", "date", "成交日期", { semanticRole: "time" }),
        column("has_order_created_at", "boolean", "成交时间完整"),
        column("product_id", "text", "商品 ID", { required: true, semanticRole: "product_id", maxLen: 128 }),
        column("sku_id", "text", "样式 ID", { semanticRole: "sku", maxLen: 128 }),
        column("merchant_sku_code", "text", "商家编码", { maxLen: 256 }),
        column("quantity", "int", "商品数量", { semanticRole: "quantity" }),
        column("product_gross_amount", "numeric", "商品总价"),
        column("shipping_amount", "numeric", "运费"),
        column("merchant_discount_amount", "numeric", "商家优惠"),
        column("platform_discount_amount", "numeric", "平台优惠"),
        column("payment_discount_amount", "numeric", "支付优惠"),
        column("buyer_paid_amount", "numeric", "买家实付"),
        column("merchant_receivable_amount", "numeric", "商家应收", { semanticRole: "amount" }),
        column("after_sale_status", "text", "售后状态", { maxLen: 128 }),
        column("shipped_at", "timestamp", "发货时间"),
        column("received_at", "timestamp", "确认收货时间"),
        column("promotion_coverage_status", "text", "推广商品覆盖", { maxLen: 32 }),
        column("order_weight", "int", "订单权重"),
        column("matched_order_weight", "int", "推广覆盖订单权重"),
        column("is_effective_sale", "boolean", "是否有效销售"),
        column("effective_quantity", "int", "有效销售数量"),
        column("effective_buyer_paid_amount", "numeric", "有效买家实付"),
        column("effective_merchant_receivable_amount", "numeric", "有效商家应收"),
      ],
      timeKey: "order_date",
      defaultRankingDimensionId: `${orderCode}.order_status`,
      dimensions: [
        dimension(orderCode, "order_date", "成交日期", "time", "day"),
        dimension(orderCode, "product_id", "商品 ID"),
        dimension(orderCode, "order_status", "订单状态"),
        dimension(orderCode, "after_sale_status", "售后状态"),
        dimension(orderCode, "promotion_coverage_status", "推广商品覆盖"),
        dimension(orderCode, "has_order_created_at", "成交时间完整"),
        dimension(orderCode, "is_effective_sale", "是否有效销售"),
        dimension(orderCode, "source_account_alias", "账户"),
      ],
      metrics: [
        sumMetric(orderCode, "effective_merchant_receivable_amount", "有效商家应收", "currency"),
        sumMetric(orderCode, "effective_buyer_paid_amount", "有效买家实付", "currency"),
        sumMetric(orderCode, "effective_quantity", "有效销售数量", "quantity"),
        sumMetric(orderCode, "order_weight", "订单数", "quantity"),
        sumMetric(orderCode, "matched_order_weight", "推广覆盖订单数", "quantity"),
        ratioMetric(orderCode, "promotion_coverage_rate", "推广商品订单覆盖率", "matched_order_weight", "order_weight", "percent"),
        countMetric(orderCode, "订单商品记录数"),
      ],
    }),
    moduleDefinition({
      code: accountAdsCode,
      name: "拼多多推广账户日",
      category: "workbench_pdd_ads",
      categoryLabel: "拼多多推广",
      description: "拼多多账户级推广按日标准事实表。比率指标按汇总分子和分母重新计算。",
      columns: [
        ...pddTraceColumns(),
        column("date", "date", "日期", { required: true, semanticRole: "time" }),
        column("conversion_spend", "numeric", "成交花费", { semanticRole: "amount" }),
        column("attributed_gmv", "numeric", "推广交易额"),
        column("actual_roas", "numeric", "实际投产比"),
        column("total_spend", "numeric", "总花费"),
        column("net_gmv", "numeric", "净交易额"),
        column("net_roas", "numeric", "净投产比"),
        column("net_orders", "int", "净成交笔数", { semanticRole: "quantity" }),
        column("net_cpa", "numeric", "净每笔成交花费"),
        column("net_gmv_share", "numeric", "净交易额占比"),
        column("net_order_share", "numeric", "净订单占比"),
        column("net_aov", "numeric", "净客单价"),
        column("settled_gmv", "numeric", "结算交易额"),
        column("settled_roas", "numeric", "结算投产比"),
        column("settled_orders", "int", "结算成交笔数"),
        column("refund_exemption_rate", "numeric", "退款豁免率"),
        column("canceled_order_exemption_rate", "numeric", "退单豁免率"),
        column("settled_cpa", "numeric", "结算每笔成交花费"),
        column("gmv_settlement_rate", "numeric", "交易额结算率"),
        column("order_settlement_rate", "numeric", "订单结算率"),
        column("settled_aov", "numeric", "结算客单价"),
        column("attributed_orders", "int", "推广成交笔数"),
        column("attributed_cpa", "numeric", "推广每笔成交花费"),
        column("attributed_aov", "numeric", "推广客单价"),
        column("impressions", "int", "曝光量"),
        column("clicks", "int", "点击量"),
      ],
      timeKey: "date",
      defaultRankingDimensionId: null,
      dimensions: [
        dimension(accountAdsCode, "date", "日期", "time", "day"),
        dimension(accountAdsCode, "source_account_alias", "账户"),
      ],
      metrics: [
        sumMetric(accountAdsCode, "total_spend", "总花费", "currency"),
        sumMetric(accountAdsCode, "attributed_gmv", "推广交易额", "currency"),
        sumMetric(accountAdsCode, "net_gmv", "净交易额", "currency"),
        sumMetric(accountAdsCode, "settled_gmv", "结算交易额", "currency"),
        sumMetric(accountAdsCode, "attributed_orders", "推广成交笔数", "quantity"),
        sumMetric(accountAdsCode, "net_orders", "净成交笔数", "quantity"),
        sumMetric(accountAdsCode, "settled_orders", "结算成交笔数", "quantity"),
        sumMetric(accountAdsCode, "impressions", "曝光量", "quantity"),
        sumMetric(accountAdsCode, "clicks", "点击量", "quantity"),
        ratioMetric(accountAdsCode, "actual_roas", "实际投产比", "attributed_gmv", "conversion_spend"),
        ratioMetric(accountAdsCode, "net_roas", "净投产比", "net_gmv", "total_spend"),
        ratioMetric(accountAdsCode, "ctr", "点击率", "clicks", "impressions", "percent"),
        ratioMetric(accountAdsCode, "cpc", "平均点击花费", "total_spend", "clicks", "currency"),
      ],
    }),
    moduleDefinition({
      code: productAdsCode,
      name: "拼多多推广商品周期",
      category: "workbench_pdd_ads",
      categoryLabel: "拼多多推广",
      description: "拼多多商品推广周期快照。指标可在同一报告期内按商品汇总，不允许跨重叠周期直接相加。",
      columns: [
        ...pddTraceColumns(),
        column("period_start", "date", "报告开始日", { required: true, semanticRole: "time" }),
        column("period_end", "date", "报告结束日", { required: true }),
        column("product_id", "text", "商品 ID", { required: true, semanticRole: "product_id", maxLen: 128 }),
        column("product_name", "text", "商品名称", { semanticRole: "product_name", maxLen: 512 }),
        column("group_name", "text", "分组名称", { semanticRole: "dimension", maxLen: 256 }),
        column("promotion_name", "text", "推广名称", { maxLen: 256 }),
        column("bid_method", "text", "出价方式", { maxLen: 128 }),
        column("is_deleted", "boolean", "是否删除"),
        column("conversion_spend", "numeric", "成交花费", { semanticRole: "amount" }),
        column("attributed_gmv", "numeric", "推广交易额"),
        column("actual_roas", "numeric", "实际投产比"),
        column("total_spend", "numeric", "总花费"),
        column("net_gmv", "numeric", "净交易额"),
        column("net_roas", "numeric", "净投产比"),
        column("net_orders", "int", "净成交笔数", { semanticRole: "quantity" }),
        column("net_cpa", "numeric", "净每笔成交花费"),
        column("net_gmv_share", "numeric", "净交易额占比"),
        column("net_order_share", "numeric", "净订单占比"),
        column("net_aov", "numeric", "净客单价"),
        column("settled_gmv", "numeric", "结算交易额"),
        column("settled_roas", "numeric", "结算投产比"),
        column("settled_orders", "int", "结算成交笔数"),
        column("refund_exemption_rate", "numeric", "退款豁免率"),
        column("canceled_order_exemption_rate", "numeric", "退单豁免率"),
        column("settled_cpa", "numeric", "结算每笔成交花费"),
        column("gmv_settlement_rate", "numeric", "交易额结算率"),
        column("order_settlement_rate", "numeric", "订单结算率"),
        column("settled_aov", "numeric", "结算客单价"),
        column("attributed_orders", "int", "推广成交笔数"),
        column("attributed_cpa", "numeric", "推广每笔成交花费"),
        column("attributed_aov", "numeric", "推广客单价"),
        column("impressions", "int", "曝光量"),
        column("clicks", "int", "点击量"),
        column("direct_gmv", "numeric", "直接交易额"),
        column("indirect_gmv", "numeric", "间接交易额"),
        column("direct_orders", "int", "直接成交笔数"),
        column("indirect_orders", "int", "间接成交笔数"),
        column("inquiry_spend", "numeric", "询单花费"),
        column("inquiries", "int", "询单量"),
        column("inquiry_cpa", "numeric", "平均询单花费"),
        column("favorite_spend", "numeric", "收藏花费"),
        column("favorites", "int", "收藏量"),
        column("favorite_cpa", "numeric", "平均收藏花费"),
        column("follow_spend", "numeric", "关注花费"),
        column("follows", "int", "关注量"),
        column("follow_cpa", "numeric", "平均关注花费"),
      ],
      timeKey: "period_start",
      defaultRankingDimensionId: `${productAdsCode}.product_name`,
      dimensions: [
        dimension(productAdsCode, "period_start", "报告开始日", "time", "day"),
        dimension(productAdsCode, "product_name", "商品"),
        dimension(productAdsCode, "product_id", "商品 ID"),
        dimension(productAdsCode, "group_name", "分组"),
        dimension(productAdsCode, "source_account_alias", "账户"),
      ],
      metrics: [
        sumMetric(productAdsCode, "total_spend", "总花费", "currency", false),
        sumMetric(productAdsCode, "attributed_gmv", "推广交易额", "currency", false),
        sumMetric(productAdsCode, "net_gmv", "净交易额", "currency", false),
        sumMetric(productAdsCode, "settled_gmv", "结算交易额", "currency", false),
        sumMetric(productAdsCode, "direct_gmv", "直接交易额", "currency", false),
        sumMetric(productAdsCode, "indirect_gmv", "间接交易额", "currency", false),
        sumMetric(productAdsCode, "attributed_orders", "推广成交笔数", "quantity", false),
        sumMetric(productAdsCode, "impressions", "曝光量", "quantity", false),
        sumMetric(productAdsCode, "clicks", "点击量", "quantity", false),
        ratioMetric(productAdsCode, "actual_roas", "实际投产比", "attributed_gmv", "conversion_spend"),
      ],
    }),
  ],
  requiredConnectors: [],
};

type BlueprintChart = {
  key: string;
  name: string;
  moduleCode: string;
  chartType: "bar" | "line" | "combo";
  metricIds: string[];
  dimensionIds: string[];
  displaySize: "kpi" | "wide" | "compact" | "half" | "full";
  valuePrefix?: string;
  valueSuffix?: string;
  valueDecimals?: number;
};

function chart(
  key: string,
  name: string,
  moduleCode: string,
  chartType: BlueprintChart["chartType"],
  metricIds: string[],
  dimensionIds: string[],
  displaySize: BlueprintChart["displaySize"] = "half",
  display: Pick<BlueprintChart, "valuePrefix" | "valueSuffix" | "valueDecimals"> = {},
): BlueprintChart {
  return { key, name, moduleCode, chartType, metricIds, dimensionIds, displaySize, ...display };
}

export const ecommerceWorkbenchBoardBlueprint = {
  schemaVersion: "ecommerce-workbench-board/v1" as const,
  solutionId: ecommerceWorkbenchSolution.id,
  groups: [
    {
      code: "workbench_taobao_overview",
      name: "淘系经营概览",
      order: 1,
      charts: [
        chart("taobao_paid_trend", "支付金额趋势", tradeCode, "line", [`${tradeCode}.paid_amount`], [`${tradeCode}.period_start`], "wide", { valuePrefix: "¥", valueDecimals: 0 }),
        chart("taobao_visitors_trend", "访客趋势", tradeCode, "line", [`${tradeCode}.visitors`], [`${tradeCode}.period_start`]),
        chart("taobao_conversion_trend", "支付转化率趋势", tradeCode, "line", [`${tradeCode}.payment_conversion_rate`], [`${tradeCode}.period_start`], "half", { valueSuffix: "%", valueDecimals: 2 }),
        chart("taobao_aov_trend", "客单价趋势", tradeCode, "line", [`${tradeCode}.avg_order_value`], [`${tradeCode}.period_start`], "half", { valuePrefix: "¥", valueDecimals: 2 }),
      ],
    },
    {
      code: "workbench_taobao_structure",
      name: "淘系交易结构",
      order: 2,
      charts: [
        chart("taobao_terminal_amount", "终端支付金额", terminalCode, "bar", [`${terminalCode}.paid_amount`], [`${terminalCode}.terminal`]),
        chart("taobao_price_amount", "价格带支付金额", priceCode, "bar", [`${priceCode}.paid_amount`], [`${priceCode}.price_band_label`]),
        chart("taobao_category_amount", "类目支付金额", categoryCode, "bar", [`${categoryCode}.paid_amount`], [`${categoryCode}.category_label`], "wide"),
      ],
    },
    {
      code: "workbench_pdd_ads",
      name: "拼多多推广",
      order: 3,
      charts: [
        chart("pdd_spend_gmv_trend", "推广花费与交易额", accountAdsCode, "combo", [`${accountAdsCode}.total_spend`, `${accountAdsCode}.attributed_gmv`], [`${accountAdsCode}.date`], "wide"),
        chart("pdd_roas_trend", "实际投产比趋势", accountAdsCode, "line", [`${accountAdsCode}.actual_roas`], [`${accountAdsCode}.date`]),
        chart("pdd_ctr_trend", "点击率趋势", accountAdsCode, "line", [`${accountAdsCode}.ctr`], [`${accountAdsCode}.date`]),
        chart("pdd_product_gmv", "商品推广交易额", productAdsCode, "bar", [`${productAdsCode}.attributed_gmv`], [`${productAdsCode}.product_name`, `${productAdsCode}.period_start`], "wide"),
      ],
    },
    {
      code: "workbench_pdd_orders_quality",
      name: "拼多多订单与数据质量",
      order: 4,
      charts: [
        chart("pdd_effective_receivable", "有效商家应收趋势", orderCode, "line", [`${orderCode}.effective_merchant_receivable_amount`], [`${orderCode}.order_date`], "wide"),
        chart("pdd_order_status", "订单状态", orderCode, "bar", [`${orderCode}.order_weight`], [`${orderCode}.order_status`]),
        chart("pdd_after_sale_status", "售后状态", orderCode, "bar", [`${orderCode}.row_count`], [`${orderCode}.after_sale_status`]),
        chart("pdd_promotion_coverage", "推广商品覆盖", orderCode, "bar", [`${orderCode}.order_weight`], [`${orderCode}.promotion_coverage_status`]),
        chart("pdd_transaction_time_quality", "成交时间完整性", orderCode, "bar", [`${orderCode}.row_count`], [`${orderCode}.has_order_created_at`]),
      ],
    },
  ],
};
