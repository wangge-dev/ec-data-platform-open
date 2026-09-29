import { sql } from "drizzle-orm";
import { PgSchema, bigserial, varchar, text, jsonb, timestamp, bigint, decimal, integer, boolean, unique, uniqueIndex, index, check, foreignKey } from "drizzle-orm/pg-core";

// Drizzle 0.36 rejects pgSchema("public"), but the exported schema factory supports
// explicit public qualification and prevents writable search_path schemas shadowing ORM tables.
const publicTable = new PgSchema("public").table;

// 用户
export const users = publicTable("users", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  username: varchar("username", { length: 64 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 128 }).notNull(),
  displayName: varchar("display_name", { length: 64 }),
  isAdmin: boolean("is_admin").default(false).notNull(), // V0.27：RBAC，admin 才能管用户/外部SQL等敏感操作
  // 每次重置密码时原子递增；JWT 必须携带并与当前值一致，才能立即吊销旧会话。
  tokenVersion: integer("token_version").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const moduleConfigs = publicTable(
  "module_configs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    code: varchar("code", { length: 64 }).notNull().unique("module_configs_code_key"),
    name: varchar("name", { length: 128 }).notNull(),
    category: varchar("category", { length: 64 }),
    description: text("description").notNull(),
    config: jsonb("config").notNull(),
    version: integer("version").notNull().default(1),
    origin: varchar("origin", { length: 32 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    createdBy: bigint("created_by", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    originCheck: check(
      "module_configs_origin_check",
      sql`${table.origin} IN ('user', 'builtin_overlay')`,
    ),
    statusCheck: check(
      "module_configs_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
    createdByForeignKey: foreignKey({
      name: "module_configs_created_by_fkey",
      columns: [table.createdBy],
      foreignColumns: [users.id],
    }),
  }),
);

export const moduleConfigVersions = publicTable(
  "module_config_versions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    moduleCode: varchar("module_code", { length: 64 }).notNull(),
    version: integer("version").notNull(),
    config: jsonb("config").notNull(),
    createdBy: bigint("created_by", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    moduleVersionUnique: unique("module_config_versions_module_code_version_key")
      .on(table.moduleCode, table.version),
    createdByForeignKey: foreignKey({
      name: "module_config_versions_created_by_fkey",
      columns: [table.createdBy],
      foreignColumns: [users.id],
    }),
  }),
);

export const moduleSchemaDecisions = publicTable(
  "module_schema_decisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    moduleCode: varchar("module_code", { length: 64 }).notNull(),
    sourceField: varchar("source_field", { length: 256 }).notNull(),
    decision: varchar("decision", { length: 16 }).notNull(),
    targetField: varchar("target_field", { length: 64 }),
    dataType: varchar("data_type", { length: 16 }),
    createdBy: bigint("created_by", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    decisionCheck: check(
      "module_schema_decisions_decision_check",
      sql`${table.decision} IN ('add', 'alias', 'ignore')`,
    ),
    moduleSourceUnique: unique("module_schema_decisions_module_code_source_field_key")
      .on(table.moduleCode, table.sourceField),
    createdByForeignKey: foreignKey({
      name: "module_schema_decisions_created_by_fkey",
      columns: [table.createdBy],
      foreignColumns: [users.id],
    }),
  }),
);

// 数据源（统一抽象：店铺账号 / 文件 / 外部 SQL）
export const dataSources = publicTable("data_sources", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  name: varchar("name", { length: 128 }).notNull(),
  type: varchar("type", { length: 32 }).notNull(), // 'shop_account' | 'file' | 'external_sql'
  platform: varchar("platform", { length: 32 }),
  config: jsonb("config").notNull(),
  status: varchar("status", { length: 16 }).default("active"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// 数据集
export const datasets = publicTable("datasets", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  name: varchar("name", { length: 128 }).notNull(),
  sourceId: bigint("source_id", { mode: "number" }).references(() => dataSources.id),
  queryType: varchar("query_type", { length: 16 }).notNull(), // 'semantic'；'sql' | 'table' 仅存量只读兼容
  queryText: text("query_text"),
  fields: jsonb("fields"),
  createdAt: timestamp("created_at").defaultNow(),
});

// 仪表盘
export const dashboards = publicTable("dashboards", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  name: varchar("name", { length: 128 }).notNull(),
  description: text("description"),
  layout: jsonb("layout").notNull().default([]),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// 图表
export const charts = publicTable("charts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  datasetId: bigint("dataset_id", { mode: "number" }).references(() => datasets.id),
  name: varchar("name", { length: 128 }).notNull(),
  chartType: varchar("chart_type", { length: 32 }).notNull(), // 'bar' | 'line' | 'pie' | 'table'
  config: jsonb("config").notNull(),
  moduleCode: varchar("module_code", { length: 64 }), // V0.27：图表归属模块，看板按模块分组展示
  createdAt: timestamp("created_at").defaultNow(),
});

// 智能体
export const agents = publicTable("agents", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  code: varchar("code", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 128 }).notNull(),
  description: text("description"),
  promptTemplate: text("prompt_template").notNull(),
  model: varchar("model", { length: 32 }).default("deepseek-v4-flash"),
  config: jsonb("config"),
  createdAt: timestamp("created_at").defaultNow(),
});

// 智能体运行记录
export const agentRuns = publicTable("agent_runs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  agentId: bigint("agent_id", { mode: "number" }).references(() => agents.id),
  status: varchar("status", { length: 16 }).default("running"),
  inputs: jsonb("inputs"),
  outputs: jsonb("outputs"),
  costCny: decimal("cost_cny", { precision: 10, scale: 4 }),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
});

// 系统配置
export const settings = publicTable("settings", {
  // Module-scoped one-time markers include a prefix plus a module code.
  key: varchar("key", { length: 128 }).primaryKey(),
  value: text("value"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// 统一销售表（多平台订单 ETL + JOIN 维护表后的标准销售额口径）
export const unifiedSales = publicTable(
  "unified_sales",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platform: varchar("platform", { length: 32 }).notNull(), // 阿里健康/进口超市/旗舰店/淘工厂
    rowKey: varchar("row_key", { length: 160 }).notNull(), // 平台内唯一行标识(子订单号/发货单ID)，增量去重用
    mainOrderNo: varchar("main_order_no", { length: 64 }),
    productId: varchar("product_id", { length: 128 }), // 订单关联键值
    qty: decimal("qty", { precision: 14, scale: 2 }),
    amount: decimal("amount", { precision: 14, scale: 2 }), // 销售额
    payTime: timestamp("pay_time"), // 付款时间，缺失退回下单时间
    orderMonth: varchar("order_month", { length: 8 }),
    // 来自维护表 JOIN
    shop: varchar("shop", { length: 128 }),
    brand: varchar("brand", { length: 64 }),
    operator: varchar("operator", { length: 64 }),
    productName: varchar("product_name", { length: 256 }),
    category: varchar("category", { length: 128 }),
    matched: boolean("matched").default(false),
    sourceFile: varchar("source_file", { length: 256 }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex("uq_unified_platform_rowkey").on(t.platform, t.rowKey),
  }),
);

// Shopee 跨境销售订单（V0.27：Shopee 独立成模块，不混入国内 unified_sales）
// 结构与 unified_sales 一致，独立表便于看板按模块分开、不与国内平台混比
export const unifiedShopeeSales = publicTable(
  "unified_shopee_sales",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platform: varchar("platform", { length: 32 }).notNull(),
    rowKey: varchar("row_key", { length: 160 }).notNull(),
    mainOrderNo: varchar("main_order_no", { length: 64 }),
    productId: varchar("product_id", { length: 128 }),
    qty: decimal("qty", { precision: 14, scale: 2 }),
    amount: decimal("amount", { precision: 14, scale: 2 }),
    payTime: timestamp("pay_time"),
    orderMonth: varchar("order_month", { length: 8 }),
    shop: varchar("shop", { length: 128 }),
    brand: varchar("brand", { length: 64 }),
    operator: varchar("operator", { length: 64 }),
    productName: varchar("product_name", { length: 256 }),
    category: varchar("category", { length: 128 }),
    matched: boolean("matched").default(false),
    sourceFile: varchar("source_file", { length: 256 }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex("uq_unified_shopee_platform_rowkey").on(t.platform, t.rowKey),
  }),
);

// 平台模板（多平台订单 ETL 的"文件名识别 + 列映射"规则，配置化，替代代码里硬编码的 TEMPLATES）
export const platformTemplates = publicTable("platform_templates", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  platform: varchar("platform", { length: 64 }).notNull().unique(),
  filePattern: varchar("file_pattern", { length: 256 }).notNull(), // 文件名识别正则源串，如 GEI@EXPORT_ORDER_INFO
  patternFlags: varchar("pattern_flags", { length: 8 }).default("i"),
  joinCol: varchar("join_col", { length: 64 }).notNull(), // 订单关联列(原始中文名)
  dictKey: varchar("dict_key", { length: 8 }).notNull().default("id"), // 'id' | 'code'
  amountCol: varchar("amount_col", { length: 64 }).notNull(),
  qtyCol: varchar("qty_col", { length: 64 }),
  payTimeCol: varchar("pay_time_col", { length: 64 }),
  orderTimeCol: varchar("order_time_col", { length: 64 }),
  mainOrderCol: varchar("main_order_col", { length: 64 }),
  rowKeyCol: varchar("row_key_col", { length: 64 }),
  enabled: boolean("enabled").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// 预警事件（V0.18+）：声明式规则触发的历史记录
// 规则定义在模块 JSON 的 alerts[]，每次 POST /api/alerts/run 会把命中的行写入这张表
export const alerts = publicTable("alerts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  moduleCode: varchar("module_code", { length: 64 }).notNull(), // 哪个模块的规则
  ruleKey: varchar("rule_key", { length: 64 }).notNull(),       // 规则 key（在该模块内唯一）
  ruleLabel: varchar("rule_label", { length: 256 }).notNull(),  // 规则中文名
  severity: varchar("severity", { length: 16 }).notNull().default("info"), // info/warning/critical
  message: text("message").notNull(),                            // 这条事件的展示文案（已渲染 ${var}）
  detail: jsonb("detail").notNull().default({}),                 // 命中行的原始数据（SQL 查询结果）
  status: varchar("status", { length: 16 }).notNull().default("open"), // open/ack/closed
  triggeredAt: timestamp("triggered_at").defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at"),
});

// Complex job framework: generic run/step/DQ/recon/publish metadata.
export const jobRuns = publicTable(
  "job_run",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    moduleCode: varchar("module_code", { length: 64 }).notNull(),
    scopeKey: varchar("scope_key", { length: 128 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("queued"),
    inputBatchIds: jsonb("input_batch_ids").notNull().default([]),
    lastCheckpointStep: varchar("last_checkpoint_step", { length: 64 }),
    startedAt: timestamp("started_at"),
    heartbeatAt: timestamp("heartbeat_at"),
    finishedAt: timestamp("finished_at"),
    triggeredBy: bigint("triggered_by", { mode: "number" }).references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    statusCheck: check(
      "job_run_status_check",
      sql`${table.status} IN ('queued', 'running', 'recon_pending', 'gated', 'published', 'failed', 'rolled_back')`,
    ),
    statusStartedIdx: index("idx_job_run_status_started_at").on(table.status, table.startedAt),
    moduleScopeIdx: index("idx_job_run_module_scope").on(table.moduleCode, table.scopeKey),
  }),
);

export const jobSteps = publicTable(
  "job_step",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: bigint("run_id", { mode: "number" }).notNull().references(() => jobRuns.id),
    stepKey: varchar("step_key", { length: 64 }).notNull(),
    attempt: integer("attempt").notNull().default(1),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    rowsIn: integer("rows_in"),
    rowsOut: integer("rows_out"),
    errorCode: varchar("error_code", { length: 64 }),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    runStepAttemptUnique: unique("job_step_run_id_step_key_attempt_key")
      .on(table.runId, table.stepKey, table.attempt),
    statusCheck: check(
      "job_step_status_check",
      sql`${table.status} IN ('pending', 'running', 'succeeded', 'failed', 'skipped')`,
    ),
    attemptCheck: check("job_step_attempt_check", sql`${table.attempt} >= 1`),
  }),
);

export const dqEvents = publicTable(
  "dq_event",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: bigint("run_id", { mode: "number" }).notNull().references(() => jobRuns.id),
    severity: varchar("severity", { length: 16 }).notNull(),
    code: varchar("code", { length: 64 }).notNull(),
    sourceId: bigint("source_id", { mode: "number" }).references(() => dataSources.id),
    rowNo: integer("row_no"),
    payload: jsonb("payload").notNull().default({}),
    resolvedBy: bigint("resolved_by", { mode: "number" }).references(() => users.id),
    resolvedAt: timestamp("resolved_at"),
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    severityCheck: check(
      "dq_event_severity_check",
      sql`${table.severity} IN ('block', 'warn', 'allow')`,
    ),
    runSeverityIdx: index("idx_dq_event_run_severity").on(table.runId, table.severity),
    codeIdx: index("idx_dq_event_code").on(table.code),
    unresolvedIdx: index("idx_dq_event_unresolved").on(table.runId).where(sql`${table.resolvedAt} IS NULL`),
  }),
);

export const reconResults = publicTable(
  "recon_result",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: bigint("run_id", { mode: "number" }).notNull().references(() => jobRuns.id),
    layer: varchar("layer", { length: 64 }).notNull(),
    metric: varchar("metric", { length: 128 }).notNull(),
    expectedValue: decimal("expected", { precision: 24, scale: 6 }),
    actualValue: decimal("actual", { precision: 24, scale: 6 }),
    toleranceValue: decimal("tolerance", { precision: 24, scale: 6 }),
    passed: boolean("passed").notNull().default(false),
    evidenceRef: jsonb("evidence_ref").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    runLayerMetricUnique: unique("recon_result_run_id_layer_metric_key")
      .on(table.runId, table.layer, table.metric),
  }),
);

export const publishVersions = publicTable(
  "publish_version",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    moduleCode: varchar("module_code", { length: 64 }).notNull(),
    scopeKey: varchar("scope_key", { length: 128 }).notNull(),
    versionNo: integer("version_no").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("draft"),
    publishedBy: bigint("published_by", { mode: "number" }).references(() => users.id),
    publishedAt: timestamp("published_at"),
    supersededBy: bigint("superseded_by", { mode: "number" }),
    sourceRunId: bigint("source_run_id", { mode: "number" }).references(() => jobRuns.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    versionUnique: unique("publish_version_module_scope_version_key")
      .on(table.moduleCode, table.scopeKey, table.versionNo),
    publishedScopeUnique: uniqueIndex("uq_publish_version_published_scope")
      .on(table.moduleCode, table.scopeKey)
      .where(sql`${table.status} = 'published'`),
    statusCheck: check(
      "publish_version_status_check",
      sql`${table.status} IN ('draft', 'validated', 'published', 'superseded', 'rolled_back')`,
    ),
    versionNoCheck: check("publish_version_version_no_check", sql`${table.versionNo} >= 1`),
  }),
);

export const publishVersionSources = publicTable(
  "publish_version_source",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    publishVersionId: bigint("publish_version_id", { mode: "number" })
      .notNull()
      .references(() => publishVersions.id),
    sourceId: bigint("source_id", { mode: "number" }).notNull(),
    sourceRunId: bigint("source_run_id", { mode: "number" }).references(() => jobRuns.id),
    inputBatchId: varchar("input_batch_id", { length: 128 }),
    role: varchar("role", { length: 32 }).notNull().default("input"),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    versionSourceRoleUnique: unique("publish_version_source_version_source_role_key")
      .on(table.publishVersionId, table.sourceId, table.role),
    versionIdx: index("idx_publish_version_source_version_id").on(table.publishVersionId),
    sourceIdx: index("idx_publish_version_source_source_id").on(table.sourceId),
    sourceRunIdx: index("idx_publish_version_source_run_id").on(table.sourceRunId),
    roleCheck: check(
      "publish_version_source_role_check",
      sql`${table.role} IN ('input', 'manual_baseline', 'adjustment')`,
    ),
  }),
);

export const frontProfitPublishRows = publicTable(
  "front_profit_publish_row",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    publishVersionId: bigint("publish_version_id", { mode: "number" }).notNull(),
    sourceId: bigint("source_id", { mode: "number" }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("draft"),
    period: varchar("period", { length: 7 }).notNull(),
    recordId: varchar("record_id", { length: 128 }).notNull(),
    aggregationKey: text("aggregation_key").notNull(),
    date: varchar("date", { length: 10 }).notNull(),
    platform: varchar("platform", { length: 64 }).notNull(),
    businessMode: varchar("business_mode", { length: 32 }).notNull(),
    groupName: varchar("group_name", { length: 128 }),
    shop: varchar("shop", { length: 128 }).notNull(),
    shopNormalized: varchar("shop_normalized", { length: 128 }),
    operator: varchar("operator", { length: 128 }).notNull(),
    quantity: decimal("quantity", { precision: 24, scale: 6 }),
    gmv: decimal("gmv", { precision: 24, scale: 6 }),
    fillOrderAmount: decimal("fill_order_amount", { precision: 24, scale: 6 }),
    fillOrderProductCost: decimal("fill_order_product_cost", { precision: 24, scale: 6 }),
    fillOrderQuantity: decimal("fill_order_quantity", { precision: 24, scale: 6 }),
    productCost: decimal("product_cost", { precision: 24, scale: 6 }),
    shipmentValue: decimal("shipment_value", { precision: 24, scale: 6 }),
    platformFee: decimal("platform_fee", { precision: 24, scale: 6 }),
    taxFee: decimal("tax_fee", { precision: 24, scale: 6 }),
    financeCost: decimal("finance_cost", { precision: 24, scale: 6 }),
    freight: decimal("freight", { precision: 24, scale: 6 }),
    commission: decimal("commission", { precision: 24, scale: 6 }),
    promotionFee: decimal("promotion_fee", { precision: 24, scale: 6 }),
    sourceFile: varchar("source_file", { length: 256 }),
    sourceBatch: varchar("source_batch", { length: 128 }),
    note: text("note"),
    realRevenue: decimal("real_revenue", { precision: 24, scale: 6 }),
    frontProfit: decimal("front_profit", { precision: 24, scale: 6 }),
    paidRatio: decimal("paid_ratio", { precision: 24, scale: 8 }),
    rowPayload: jsonb("row_payload").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    versionRecordUnique: unique("front_profit_publish_row_version_record_id_key")
      .on(table.publishVersionId, table.recordId),
    versionAggregationUnique: unique("front_profit_publish_row_version_aggregation_key")
      .on(table.publishVersionId, table.aggregationKey),
    publishedPeriodAggregationUnique: uniqueIndex("uq_front_profit_publish_row_published_period_key")
      .on(table.period, table.aggregationKey)
      .where(sql`${table.status} = 'published'`),
    versionIdx: index("idx_front_profit_publish_row_version_id").on(table.publishVersionId),
    sourceIdx: index("idx_front_profit_publish_row_source_id").on(table.sourceId),
    periodStatusIdx: index("idx_front_profit_publish_row_period_status").on(table.period, table.status),
    statusCheck: check(
      "front_profit_publish_row_status_check",
      sql`${table.status} IN ('draft', 'published', 'superseded', 'rolled_back')`,
    ),
    publishVersionForeignKey: foreignKey({
      name: "fp_publish_row_version_fk",
      columns: [table.publishVersionId],
      foreignColumns: [publishVersions.id],
    }),
  }),
);

export const frontProfitL1SourceRows = publicTable(
  "front_profit_l1_source_row",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: bigint("run_id", { mode: "number" }).notNull(),
    sourceId: bigint("source_id", { mode: "number" }).notNull(),
    sourceRowNo: integer("source_row_no").notNull(),
    period: varchar("period", { length: 7 }).notNull(),
    sourceFamily: varchar("source_family", { length: 32 }).notNull(),
    sourceRecordKey: varchar("source_record_key", { length: 160 }).notNull(),
    eventDate: varchar("event_date", { length: 10 }).notNull(),
    platform: varchar("platform", { length: 64 }),
    shop: varchar("shop", { length: 128 }),
    operatorKey: varchar("operator_key", { length: 128 }),
    skuKey: varchar("sku_key", { length: 128 }),
    amountKind: varchar("amount_kind", { length: 64 }).notNull(),
    amountValue: decimal("amount_value", { precision: 24, scale: 6 }),
    quantity: decimal("quantity", { precision: 24, scale: 6 }),
    currency: varchar("currency", { length: 3 }).notNull().default("CNY"),
    rowPayload: jsonb("row_payload").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    runRecordKindUnique: unique("fp_l1_source_row_run_record_kind_key")
      .on(table.runId, table.sourceFamily, table.sourceRecordKey, table.amountKind),
    runPeriodIdx: index("idx_fp_l1_source_row_run_period").on(table.runId, table.period),
    sourceIdx: index("idx_fp_l1_source_row_source_id").on(table.sourceId),
    periodFamilyIdx: index("idx_fp_l1_source_row_period_family").on(table.period, table.sourceFamily),
    sourceRowNoCheck: check("fp_l1_source_row_no_check", sql`${table.sourceRowNo} >= 1`),
    periodCheck: check("fp_l1_period_check", sql`${table.period} ~ '^\\d{4}-\\d{2}$'`),
    eventDateCheck: check("fp_l1_event_date_check", sql`${table.eventDate} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
    currencyCheck: check("fp_l1_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    runForeignKey: foreignKey({
      name: "fp_l1_run_fk",
      columns: [table.runId],
      foreignColumns: [jobRuns.id],
    }),
    sourceForeignKey: foreignKey({
      name: "fp_l1_source_fk",
      columns: [table.sourceId],
      foreignColumns: [dataSources.id],
    }),
  }),
);

export const frontProfitL3CalcDetails = publicTable(
  "front_profit_l3_calc_detail",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: bigint("run_id", { mode: "number" }).notNull(),
    detailKey: varchar("detail_key", { length: 160 }).notNull(),
    l1SourceRowId: bigint("l1_source_row_id", { mode: "number" }),
    sourceId: bigint("source_id", { mode: "number" }),
    period: varchar("period", { length: 7 }).notNull(),
    recordId: varchar("record_id", { length: 128 }).notNull(),
    aggregationKey: text("aggregation_key").notNull(),
    date: varchar("date", { length: 10 }).notNull(),
    platform: varchar("platform", { length: 64 }).notNull(),
    businessMode: varchar("business_mode", { length: 32 }).notNull(),
    groupName: varchar("group_name", { length: 128 }),
    shop: varchar("shop", { length: 128 }).notNull(),
    shopNormalized: varchar("shop_normalized", { length: 128 }),
    operator: varchar("operator", { length: 128 }).notNull(),
    calculationRole: varchar("calculation_role", { length: 64 }).notNull(),
    mappingVersionId: bigint("mapping_version_id", { mode: "number" }),
    ruleVersion: varchar("rule_version", { length: 64 }).notNull(),
    jobVersion: varchar("job_version", { length: 64 }).notNull(),
    quantity: decimal("quantity", { precision: 24, scale: 6 }).notNull(),
    gmv: decimal("gmv", { precision: 24, scale: 6 }).notNull(),
    fillOrderAmount: decimal("fill_order_amount", { precision: 24, scale: 6 }).notNull(),
    fillOrderProductCost: decimal("fill_order_product_cost", { precision: 24, scale: 6 }).notNull(),
    fillOrderQuantity: decimal("fill_order_quantity", { precision: 24, scale: 6 }).notNull(),
    productCost: decimal("product_cost", { precision: 24, scale: 6 }).notNull(),
    shipmentValue: decimal("shipment_value", { precision: 24, scale: 6 }).notNull(),
    platformFee: decimal("platform_fee", { precision: 24, scale: 6 }).notNull(),
    taxFee: decimal("tax_fee", { precision: 24, scale: 6 }).notNull(),
    financeCost: decimal("finance_cost", { precision: 24, scale: 6 }).notNull(),
    freight: decimal("freight", { precision: 24, scale: 6 }).notNull(),
    commission: decimal("commission", { precision: 24, scale: 6 }).notNull(),
    promotionFee: decimal("promotion_fee", { precision: 24, scale: 6 }).notNull(),
    lineagePayload: jsonb("lineage_payload").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    runDetailUnique: unique("fp_l3_calc_detail_run_detail_key").on(table.runId, table.detailKey),
    runAggregationIdx: index("idx_fp_l3_calc_detail_run_aggregation").on(table.runId, table.aggregationKey),
    runRecordIdx: index("idx_fp_l3_calc_detail_run_record").on(table.runId, table.recordId),
    l1SourceRowIdx: index("idx_fp_l3_calc_detail_l1_row").on(table.l1SourceRowId),
    sourceIdx: index("idx_fp_l3_calc_detail_source_id").on(table.sourceId),
    periodCheck: check("fp_l3_period_check", sql`${table.period} ~ '^\\d{4}-\\d{2}$'`),
    dateCheck: check("fp_l3_date_check", sql`${table.date} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
    runForeignKey: foreignKey({
      name: "fp_l3_run_fk",
      columns: [table.runId],
      foreignColumns: [jobRuns.id],
    }),
    l1SourceRowForeignKey: foreignKey({
      name: "fp_l3_l1_row_fk",
      columns: [table.l1SourceRowId],
      foreignColumns: [frontProfitL1SourceRows.id],
    }),
    sourceForeignKey: foreignKey({
      name: "fp_l3_source_fk",
      columns: [table.sourceId],
      foreignColumns: [dataSources.id],
    }),
  }),
);

export const frontProfitL4AggRows = publicTable(
  "front_profit_l4_agg_row",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: bigint("run_id", { mode: "number" }).notNull(),
    publishVersionId: bigint("publish_version_id", { mode: "number" }),
    period: varchar("period", { length: 7 }).notNull(),
    recordId: varchar("record_id", { length: 128 }).notNull(),
    aggregationKey: text("aggregation_key").notNull(),
    date: varchar("date", { length: 10 }).notNull(),
    platform: varchar("platform", { length: 64 }).notNull(),
    businessMode: varchar("business_mode", { length: 32 }).notNull(),
    groupName: varchar("group_name", { length: 128 }),
    shop: varchar("shop", { length: 128 }).notNull(),
    shopNormalized: varchar("shop_normalized", { length: 128 }),
    operator: varchar("operator", { length: 128 }).notNull(),
    quantity: decimal("quantity", { precision: 24, scale: 6 }).notNull(),
    gmv: decimal("gmv", { precision: 24, scale: 6 }).notNull(),
    fillOrderAmount: decimal("fill_order_amount", { precision: 24, scale: 6 }).notNull(),
    fillOrderProductCost: decimal("fill_order_product_cost", { precision: 24, scale: 6 }).notNull(),
    fillOrderQuantity: decimal("fill_order_quantity", { precision: 24, scale: 6 }).notNull(),
    productCost: decimal("product_cost", { precision: 24, scale: 6 }).notNull(),
    shipmentValue: decimal("shipment_value", { precision: 24, scale: 6 }).notNull(),
    platformFee: decimal("platform_fee", { precision: 24, scale: 6 }).notNull(),
    taxFee: decimal("tax_fee", { precision: 24, scale: 6 }).notNull(),
    financeCost: decimal("finance_cost", { precision: 24, scale: 6 }).notNull(),
    freight: decimal("freight", { precision: 24, scale: 6 }).notNull(),
    commission: decimal("commission", { precision: 24, scale: 6 }).notNull(),
    promotionFee: decimal("promotion_fee", { precision: 24, scale: 6 }).notNull(),
    sourceFile: varchar("source_file", { length: 256 }),
    sourceBatch: varchar("source_batch", { length: 128 }),
    note: text("note"),
    realRevenue: decimal("real_revenue", { precision: 24, scale: 6 }).notNull(),
    frontProfit: decimal("front_profit", { precision: 24, scale: 6 }).notNull(),
    paidRatio: decimal("paid_ratio", { precision: 24, scale: 8 }).notNull(),
    dataStatus: varchar("data_status", { length: 128 }),
    rowPayload: jsonb("row_payload").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    runRecordUnique: unique("fp_l4_agg_row_run_record_key").on(table.runId, table.recordId),
    runAggregationUnique: unique("fp_l4_agg_row_run_aggregation_key").on(table.runId, table.aggregationKey),
    runPeriodIdx: index("idx_fp_l4_agg_row_run_period").on(table.runId, table.period),
    publishVersionIdx: index("idx_fp_l4_agg_row_publish_version").on(table.publishVersionId),
    periodCheck: check("fp_l4_period_check", sql`${table.period} ~ '^\\d{4}-\\d{2}$'`),
    dateCheck: check("fp_l4_date_check", sql`${table.date} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
    runForeignKey: foreignKey({
      name: "fp_l4_run_fk",
      columns: [table.runId],
      foreignColumns: [jobRuns.id],
    }),
    publishVersionForeignKey: foreignKey({
      name: "fp_l4_publish_version_fk",
      columns: [table.publishVersionId],
      foreignColumns: [publishVersions.id],
    }),
  }),
);

export const frontProfitRebateFacts = publicTable(
  "front_profit_rebate_fact",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: bigint("run_id", { mode: "number" }).notNull(),
    sourceId: bigint("source_id", { mode: "number" }).notNull(),
    sourceRowNo: integer("source_row_no").notNull(),
    period: varchar("period", { length: 7 }).notNull(),
    rebateKey: varchar("rebate_key", { length: 160 }).notNull(),
    rebateEventDate: varchar("rebate_event_date", { length: 10 }).notNull(),
    platform: varchar("platform", { length: 64 }),
    shop: varchar("shop", { length: 128 }),
    operatorKey: varchar("operator_key", { length: 128 }),
    skuKey: varchar("sku_key", { length: 128 }),
    orderKey: varchar("order_key", { length: 160 }),
    fillOrderAmount: decimal("fill_order_amount", { precision: 24, scale: 6 }).notNull(),
    fillOrderProductCost: decimal("fill_order_product_cost", { precision: 24, scale: 6 }).notNull(),
    fillOrderQuantity: decimal("fill_order_quantity", { precision: 24, scale: 6 }).notNull(),
    rowPayload: jsonb("row_payload").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    runRebateKeyUnique: unique("fp_rebate_fact_run_rebate_key")
      .on(table.runId, table.rebateKey),
    runPeriodIdx: index("idx_fp_rebate_fact_run_period").on(table.runId, table.period),
    sourceIdx: index("idx_fp_rebate_fact_source_id").on(table.sourceId),
    skuIdx: index("idx_fp_rebate_fact_sku_key").on(table.skuKey),
    sourceRowNoCheck: check("fp_rebate_source_row_no_check", sql`${table.sourceRowNo} >= 1`),
    periodCheck: check("fp_rebate_period_check", sql`${table.period} ~ '^\\d{4}-\\d{2}$'`),
    eventDateCheck: check("fp_rebate_event_date_check", sql`${table.rebateEventDate} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
    runForeignKey: foreignKey({
      name: "fp_rebate_run_fk",
      columns: [table.runId],
      foreignColumns: [jobRuns.id],
    }),
    sourceForeignKey: foreignKey({
      name: "fp_rebate_source_fk",
      columns: [table.sourceId],
      foreignColumns: [dataSources.id],
    }),
  }),
);

export const frontProfitFeeFacts = publicTable(
  "front_profit_fee_fact",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: bigint("run_id", { mode: "number" }).notNull(),
    sourceId: bigint("source_id", { mode: "number" }).notNull(),
    sourceRowNo: integer("source_row_no").notNull(),
    period: varchar("period", { length: 7 }).notNull(),
    feeKind: varchar("fee_kind", { length: 32 }).notNull(),
    authoritySource: varchar("authority_source", { length: 32 }).notNull(),
    authorityPriority: integer("authority_priority").notNull(),
    feeKey: varchar("fee_key", { length: 160 }).notNull(),
    eventDate: varchar("event_date", { length: 10 }).notNull(),
    platform: varchar("platform", { length: 64 }),
    shop: varchar("shop", { length: 128 }),
    operatorKey: varchar("operator_key", { length: 128 }),
    skuKey: varchar("sku_key", { length: 128 }),
    adAccountKey: varchar("ad_account_key", { length: 128 }),
    amount: decimal("amount", { precision: 24, scale: 6 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("CNY"),
    rowPayload: jsonb("row_payload").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    runFeeSourceKeyUnique: unique("fp_fee_fact_run_fee_source_key")
      .on(table.runId, table.feeKind, table.authoritySource, table.feeKey),
    runPeriodKindIdx: index("idx_fp_fee_fact_run_period_kind").on(table.runId, table.period, table.feeKind),
    sourceIdx: index("idx_fp_fee_fact_source_id").on(table.sourceId),
    skuIdx: index("idx_fp_fee_fact_sku_key").on(table.skuKey),
    sourceRowNoCheck: check("fp_fee_source_row_no_check", sql`${table.sourceRowNo} >= 1`),
    periodCheck: check("fp_fee_period_check", sql`${table.period} ~ '^\\d{4}-\\d{2}$'`),
    eventDateCheck: check("fp_fee_event_date_check", sql`${table.eventDate} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
    currencyCheck: check("fp_fee_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    kindCheck: check(
      "fp_fee_kind_check",
      sql`${table.feeKind} IN ('platform_fee', 'tax_fee', 'finance_cost', 'freight', 'commission', 'promotion_fee')`,
    ),
    authoritySourceCheck: check(
      "fp_fee_authority_source_check",
      sql`${table.authoritySource} IN ('settlement', 'platform_bill', 'rate_rule', 'manual_estimate')`,
    ),
    authorityPriorityCheck: check("fp_fee_authority_priority_check", sql`${table.authorityPriority} BETWEEN 1 AND 4`),
    runForeignKey: foreignKey({
      name: "fp_fee_run_fk",
      columns: [table.runId],
      foreignColumns: [jobRuns.id],
    }),
    sourceForeignKey: foreignKey({
      name: "fp_fee_source_fk",
      columns: [table.sourceId],
      foreignColumns: [dataSources.id],
    }),
  }),
);

export const frontProfitOperatorAssignments = publicTable(
  "front_profit_operator_assignment",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: bigint("run_id", { mode: "number" }).notNull(),
    sourceId: bigint("source_id", { mode: "number" }).notNull(),
    sourceRowNo: integer("source_row_no").notNull(),
    period: varchar("period", { length: 7 }).notNull(),
    shop: varchar("shop", { length: 128 }).notNull(),
    authorityKeyType: varchar("authority_key_type", { length: 32 }).notNull(),
    authorityKey: varchar("authority_key", { length: 160 }).notNull(),
    operator: varchar("operator", { length: 128 }).notNull(),
    effectiveFrom: varchar("effective_from", { length: 10 }).notNull(),
    effectiveTo: varchar("effective_to", { length: 10 }).notNull(),
    rowPayload: jsonb("row_payload").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    runAuthorityKeyUnique: unique("fp_operator_assignment_run_key")
      .on(table.runId, table.shop, table.authorityKeyType, table.authorityKey, table.effectiveFrom),
    runPeriodIdx: index("idx_fp_operator_assignment_run_period").on(table.runId, table.period),
    sourceIdx: index("idx_fp_operator_assignment_source_id").on(table.sourceId),
    sourceRowNoCheck: check("fp_operator_source_row_no_check", sql`${table.sourceRowNo} >= 1`),
    periodCheck: check("fp_operator_period_check", sql`${table.period} ~ '^\\d{4}-\\d{2}$'`),
    effectiveFromCheck: check("fp_operator_effective_from_check", sql`${table.effectiveFrom} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
    effectiveToCheck: check("fp_operator_effective_to_check", sql`${table.effectiveTo} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
    effectiveRangeCheck: check("fp_operator_effective_range_check", sql`${table.effectiveTo} >= ${table.effectiveFrom}`),
    authorityKeyTypeCheck: check(
      "fp_operator_authority_key_type_check",
      sql`${table.authorityKeyType} IN ('sku', 'ad_account', 'product_owner', 'order_owner', 'manual_mapping')`,
    ),
    authorityKeyCheck: check("fp_operator_authority_key_check", sql`length(trim(${table.authorityKey})) > 0`),
    runForeignKey: foreignKey({
      name: "fp_operator_run_fk",
      columns: [table.runId],
      foreignColumns: [jobRuns.id],
    }),
    sourceForeignKey: foreignKey({
      name: "fp_operator_source_fk",
      columns: [table.sourceId],
      foreignColumns: [dataSources.id],
    }),
  }),
);

export const frontProfitCostPeriods = publicTable(
  "front_profit_cost_period",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: bigint("run_id", { mode: "number" }).notNull(),
    sourceId: bigint("source_id", { mode: "number" }).notNull(),
    sourceRowNo: integer("source_row_no").notNull(),
    period: varchar("period", { length: 7 }).notNull(),
    skuKey: varchar("sku_key", { length: 128 }).notNull(),
    costKind: varchar("cost_kind", { length: 32 }).notNull().default("product_cost"),
    effectiveFrom: varchar("effective_from", { length: 10 }).notNull(),
    effectiveTo: varchar("effective_to", { length: 10 }).notNull(),
    unitCost: decimal("unit_cost", { precision: 24, scale: 6 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("CNY"),
    rowPayload: jsonb("row_payload").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    runSkuKindFromUnique: unique("fp_cost_period_run_sku_kind_from")
      .on(table.runId, table.skuKey, table.costKind, table.effectiveFrom),
    runPeriodIdx: index("idx_fp_cost_period_run_period").on(table.runId, table.period),
    sourceIdx: index("idx_fp_cost_period_source_id").on(table.sourceId),
    skuIdx: index("idx_fp_cost_period_sku_key").on(table.skuKey),
    sourceRowNoCheck: check("fp_cost_source_row_no_check", sql`${table.sourceRowNo} >= 1`),
    periodCheck: check("fp_cost_period_check", sql`${table.period} ~ '^\\d{4}-\\d{2}$'`),
    effectiveFromCheck: check("fp_cost_effective_from_check", sql`${table.effectiveFrom} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
    effectiveToCheck: check("fp_cost_effective_to_check", sql`${table.effectiveTo} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
    effectiveRangeCheck: check("fp_cost_effective_range_check", sql`${table.effectiveTo} >= ${table.effectiveFrom}`),
    costKindCheck: check("fp_cost_kind_check", sql`${table.costKind} IN ('product_cost')`),
    currencyCheck: check("fp_cost_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    runForeignKey: foreignKey({
      name: "fp_cost_run_fk",
      columns: [table.runId],
      foreignColumns: [jobRuns.id],
    }),
    sourceForeignKey: foreignKey({
      name: "fp_cost_source_fk",
      columns: [table.sourceId],
      foreignColumns: [dataSources.id],
    }),
  }),
);

export const periodAuthorities = publicTable(
  "period_authority",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    moduleCode: varchar("module_code", { length: 64 }).notNull(),
    scopeKey: varchar("scope_key", { length: 128 }).notNull(),
    authority: varchar("authority", { length: 16 }).notNull().default("manual"),
    closeDay: integer("close_day").notNull().default(5),
    reopenedBy: bigint("reopened_by", { mode: "number" }).references(() => users.id),
    reopenedAt: timestamp("reopened_at"),
    createdBy: bigint("created_by", { mode: "number" }).references(() => users.id),
    updatedBy: bigint("updated_by", { mode: "number" }).references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    moduleScopeUnique: unique("period_authority_module_scope_key")
      .on(table.moduleCode, table.scopeKey),
    authorityCheck: check(
      "period_authority_authority_check",
      sql`${table.authority} IN ('manual', 'auto')`,
    ),
    closeDayCheck: check(
      "period_authority_close_day_check",
      sql`${table.closeDay} BETWEEN 1 AND 28`,
    ),
    moduleAuthorityIdx: index("idx_period_authority_module_authority")
      .on(table.moduleCode, table.authority),
  }),
);

export const periodAuthorityEvents = publicTable(
  "period_authority_event",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    moduleCode: varchar("module_code", { length: 64 }).notNull(),
    scopeKey: varchar("scope_key", { length: 128 }).notNull(),
    action: varchar("action", { length: 32 }).notNull(),
    fromAuthority: varchar("from_authority", { length: 16 }),
    toAuthority: varchar("to_authority", { length: 16 }),
    actorId: bigint("actor_id", { mode: "number" }).references(() => users.id),
    reason: text("reason"),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    actionCheck: check(
      "period_authority_event_action_check",
      sql`${table.action} IN ('initialized', 'set_authority', 'reopen_period')`,
    ),
    fromAuthorityCheck: check(
      "period_authority_event_from_authority_check",
      sql`${table.fromAuthority} IS NULL OR ${table.fromAuthority} IN ('manual', 'auto')`,
    ),
    toAuthorityCheck: check(
      "period_authority_event_to_authority_check",
      sql`${table.toAuthority} IS NULL OR ${table.toAuthority} IN ('manual', 'auto')`,
    ),
    moduleScopeCreatedIdx: index("idx_period_authority_event_module_scope_created")
      .on(table.moduleCode, table.scopeKey, table.createdAt),
  }),
);
