/**
 * 模块配置 Schema（D 方案阶段 1）
 *
 * 设计原则：
 *   - 一个 JSON 描述一个业务模块（销售订单/库存/流量/财务...）
 *   - 默认逻辑由 schema 直接表达，不写代码
 *   - 复杂模块写一个同名 .transform.ts 钩子兜底
 *   - 同事让 AI 加模块时：AI 读 docs/HOW_TO_ADD_MODULE.md + 现有 *.json 就会
 */
import { z } from "zod";
import { validateExpression } from "../lib/sql-guard.js";
import {
  FILE_PATTERN_MAX_LENGTH,
  validateSafeFilePattern,
} from "../lib/file-pattern.js";

export const SemanticRoleSchema = z.enum([
  "time",
  "amount",
  "quantity",
  "product_id",
  "product_name",
  "order_id",
  "status",
  "sku",
  "shop",
  "dimension",
]);
export type SemanticRole = z.infer<typeof SemanticRoleSchema>;

const SemanticIdSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/,
    "语义 ID 必须是 <namespace>.<name>，例如 orders.sales_amount",
  );

export const SemanticDimensionSchema = z.object({
  id: SemanticIdSchema,
  label: z.string().trim().min(1).max(128),
  field: z.string().regex(/^[a-z][a-z0-9_]*$/),
  kind: z.enum(["categorical", "time"]).default("categorical"),
  timeGrain: z.enum(["day", "month"]).optional(),
  description: z.string().trim().max(500).optional(),
});
export type SemanticDimensionDef = z.infer<typeof SemanticDimensionSchema>;

export const SemanticMetricSchema = z
  .object({
    id: SemanticIdSchema,
    label: z.string().trim().min(1).max(128),
    aggregation: z.enum(["sum", "average", "count", "min", "max", "ratio"]),
    field: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
    numeratorField: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
    denominatorField: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
    unit: z.enum(["number", "currency", "percent", "quantity"]).default("number"),
    additiveAcrossTime: z.boolean().default(true),
    description: z.string().trim().max(500).optional(),
  })
  .superRefine((metric, ctx) => {
    if (metric.aggregation === "ratio") {
      if (!metric.numeratorField || !metric.denominatorField) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "ratio 指标必须声明 numeratorField 和 denominatorField",
        });
      }
      if (metric.field) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["field"],
          message: "ratio 指标不能同时声明 field",
        });
      }
      return;
    }
    if (metric.aggregation !== "count" && !metric.field) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["field"],
        message: `${metric.aggregation} 指标必须声明 field`,
      });
    }
  });
export type SemanticMetricDef = z.infer<typeof SemanticMetricSchema>;

export const SemanticModelSchema = z.object({
  schemaVersion: z.literal("semantic-manifest/v1"),
  id: SemanticIdSchema,
  version: z.number().int().positive(),
  dimensions: z.array(SemanticDimensionSchema).min(1),
  metrics: z.array(SemanticMetricSchema).min(1),
  defaultRankingDimensionId: SemanticIdSchema.nullable().optional(),
}).superRefine((model, ctx) => {
  if (typeof model.defaultRankingDimensionId !== "string") return;
  const dimension = model.dimensions.find(
    (candidate) => candidate.id === model.defaultRankingDimensionId,
  );
  if (!dimension || dimension.kind !== "categorical") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["defaultRankingDimensionId"],
      message: "默认排行维度必须引用当前语义模型中的分类维度",
    });
  }
});
export type SemanticModelDef = z.infer<typeof SemanticModelSchema>;

export const InclusionRuleSchema = z.object({
  field: z.string().min(1),
  includedValues: z
    .array(
      z
        .string()
        .trim()
        .min(1, "inclusionRule.includedValues 不能包含空值"),
    )
    .min(1, "inclusionRule.includedValues 不能为空"),
});
export type InclusionRule = z.infer<typeof InclusionRuleSchema>;

/**
 * 列定义：声明这个模块"必须有的字段"和"输入文件里的中文/英文列名"
 */
export const ColumnSchema = z.object({
  // 在 unified_<module> 输出表里的字段名（英文小写下划线，符合 Postgres 惯例）
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, "name 必须是小写字母+下划线，如 product_id"),
  // 在原始 Excel/CSV 里的列名（用户文件里通常是中文）。一列可指定多个候选（不同平台叫法不同）
  // 计算字段（computed=true）不需要 source
  source: z.union([z.string(), z.array(z.string())]).optional(),
  // 字段类型，决定 PG 写出时怎么 CAST
  type: z.enum(["text", "int", "numeric", "timestamp", "date", "boolean"]),
  // 文本字段的最大长度（防 V0.10 那种 value too long 整批失败）
  maxLen: z.number().int().positive().optional(),
  // 是否必填（缺失时整行丢弃）。默认 false
  required: z.boolean().default(false),
  // 中文显示名，给前端展示用
  label: z.string().optional(),
  // 描述，给 AI 看的（"这一列在文件里通常叫商品ID"）
  hint: z.string().optional(),
  // 通用分析能力使用的业务语义角色
  semanticRole: SemanticRoleSchema.optional(),
  // 计算字段：由其他列算出来。不读源文件，按 expression 计算
  // 例：毛利 = "gmv - cost"；毛利率 = "gross_profit / NULLIF(gmv, 0)"
  // 表达式是 SQL 片段，引擎会做成 UPDATE 语句
  computed: z.boolean().default(false),
  // 计算表达式（SQL 片段，引用本表列名）。computed=true 时必填
  expression: z.string().optional(),
}).refine(
  (col) => col.computed ? !!col.expression : !!col.source,
  { message: "computed=true 必须给 expression；否则必须给 source" },
);
export type ColumnDef = z.infer<typeof ColumnSchema>;

/**
 * 平台定义：一个模块下可以有多个平台（销售订单模块有 4 个平台；库存模块可能只有 1 个）
 */
export const PlatformSchema = z.object({
  // 平台代号（英文，主键）
  code: z.string().regex(/^[a-z][a-z0-9_]*$/),
  // 中文展示名
  name: z.string(),
  // 受限文件名匹配模式；配置与运行时均通过防 ReDoS 编译器校验
  filePattern: z.string().min(1).max(FILE_PATTERN_MAX_LENGTH),
  patternFlags: z.string().max(2).default("i"),
  // 该平台特有的列映射覆盖：键是 columns[].name，值是这个平台里的源列名
  // 例：销售订单模块定义了通用列 amount，但阿里健康的 amount 列叫"金额(不作为结算依据，仅供参考)"
  columnOverrides: z.record(z.union([z.string(), z.array(z.string())])).optional(),
  // V0.27：订单状态过滤——GMV 只算有效销售，排除已取消/已退款等无效订单
  // 各平台状态列名和无效值不同（旗舰店"订单状态"/阿里健康"发货状态"），故配在 platform 级
  statusFilter: z
    .object({
      statusColumn: z.string(), // 状态列原始名（如"订单状态"/"发货状态"）
      excludeStatus: z.array(z.string()).default([]), // 排除的状态值（如"交易关闭"/"已废弃(关闭)"）
      refundColumn: z.string().optional(), // 退款列原始名（如"退款状态"/"是否退款"）
      refundExclude: z.array(z.string()).default([]), // 排除的退款值（如"退款成功"/"已退款"）
    })
    .optional(),
  // 是否启用
  enabled: z.boolean().default(true),
}).superRefine((platform, ctx) => {
  const validation = validateSafeFilePattern(
    platform.filePattern,
    platform.patternFlags,
  );
  if (!validation.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["filePattern"],
      message: validation.reason,
    });
  }
});
export type PlatformDef = z.infer<typeof PlatformSchema>;

/**
 * JOIN 配置：可选，模块需要关联字典表（比如订单 JOIN 品牌维护表）时声明
 */
export const JoinSchema = z.object({
  // 字典数据源：从某个 uf_<id> 表里取（动态找最新或指定 role）
  dictRole: z.string().trim().min(1).max(64), // 例 "brand_dict"
  // 关联键映射：左 = 当前模块输出列，右 = 字典里的列
  on: z.record(z.string().trim().min(1).max(256)),
  // 要补的字段：键 = 当前输出列，值 = 字典里的列
  enrich: z.record(z.string().trim().min(1).max(256)),
  // 可选标签（多 join 时区分用途，例 "brand" / "pic" / "cost"）
  label: z.string().trim().min(1).max(128).optional(),
});
/**
 * 场景预设：常用分析查询的一键入口（V0.18+）
 * 模块管理页会渲染成按钮，点击跳转 /compare 并预填参数
 */
export const PresetSchema = z.object({
  // 唯一标识（在该模块下唯一）
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  // 中文显示名（按钮文字）
  label: z.string(),
  // 简短描述（hover 提示）
  description: z.string().optional(),
  // 跳转的目标页：compare（经营对比页）或 board（看板）
  target: z.enum(["compare", "board"]).default("compare"),
  // compare 目标的参数
  metric: z.string().optional(),
  agg: z.enum(["sum", "avg", "count", "max", "min"]).optional(),
  dim: z.string().optional(),
  metricId: SemanticIdSchema.optional(),
  dimensionId: SemanticIdSchema.optional(),
  period: z.enum(["dod", "wow", "mom", "yoy"]).optional(),
  // 视觉强调（"warning" 红橙、"info" 蓝、默认莫兰迪）
  emphasis: z.enum(["warning", "info", "neutral"]).default("neutral"),
});
export type PresetDef = z.infer<typeof PresetSchema>;

/**
 * 预警规则（V0.18+）：声明式规则，跑 SQL 拿到的每一行都触发一条预警
 * 规则只读模块本身的 unified 表，不修改数据
 */
export const AlertRuleSchema = z.object({
  // 唯一标识（模块内唯一）
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  // 中文规则名
  label: z.string(),
  // 严重程度
  severity: z.enum(["info", "warning", "critical"]).default("warning"),
  // 查询 SQL —— 必须 SELECT，限定查本模块的 unified_<code> 表
  // 返回的每一行都触发一条预警，行的字段会被填入 message 模板
  // 例：SELECT product_id, stock_qty FROM unified_inventory WHERE stock_qty < 10
  sql: z.string().min(10),
  // 消息模板（支持 ${字段名} 占位符，从 sql 结果行取值）
  // 例："SKU ${product_id} 库存仅剩 ${stock_qty}"
  message: z.string(),
  // 是否启用
  enabled: z.boolean().default(true),
});
export type AlertRuleDef = z.infer<typeof AlertRuleSchema>;

export const SolutionBindingSchema = z.object({
  schemaVersion: z.literal("solution-binding/v1"),
  solutionId: z.string().regex(
    /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/,
    "solutionId 必须是 <namespace>.<name>",
  ),
  solutionVersion: z.number().int().positive(),
  moduleFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type SolutionBinding = z.infer<typeof SolutionBindingSchema>;

/**
 * 模块根 Schema
 */
export const ModuleSchema = z.object({
  // 模块代号（英文，唯一）。决定输出表名 unified_<code>
  code: z.string().regex(/^[a-z][a-z0-9_]*$/, "code 必须英文小写"),
  // 中文模块名
  name: z.string(),
  // 可选：业务分类（V0.21+）——首页按这个把模块卡片分组渲染
  // 例 orders/cost/ads 都属于 "shop_ops"，inventory 属于 "warehouse"
  category: z.string().optional(),
  // 可选：分类中文显示名（同一 category 写一次即可，多次声明取第一个非空）
  categoryLabel: z.string().optional(),
  // 描述，给同事 + AI 看
  description: z.string(),
  // Accounting modules may bind themselves to a strict source-side contract.
  // This flag survives renames and generated module codes.
  dataContract: z.literal("front-profit-standard/v1").optional(),
  // 该模块下的列定义（通用列；具体平台可在 columnOverrides 覆盖）
  columns: z.array(ColumnSchema).min(1),
  // 该模块下的平台列表
  platforms: z.array(PlatformSchema).min(1),
  // 可选：字典 JOIN（如订单 JOIN 品牌维护表）。向后兼容老配置（单 join）
  join: JoinSchema.optional(),
  // 可选：多 JOIN（订单 × 成本 × 广告 × PIC 这种）。joins 优先于 join
  joins: z.array(JoinSchema).optional(),
  // 可选：时间维度字段名（必须是 columns 里的字段），用于生成 DoD/MoM/YoY 对比视图
  timeKey: z.string().trim().min(1, "timeKey 不能为空").optional(),
  // 可选：场景预设（V0.18+）——模块管理页一键跳转对比页/看板的快捷入口
  presets: z.array(PresetSchema).optional(),
  // 可选：预警规则（V0.18+）——POST /api/alerts/run 时跑这些规则
  alerts: z.array(AlertRuleSchema).optional(),
  // 可选：自动调度（V0.20+）——5 字段 crontab，到点自动跑本模块的全部预警
  // 例 "0 9 * * *" 每天 9 点；"*/10 * * * *" 每 10 分钟；不写则只能手动跑
  schedule: z.string().optional(),
  // 这个模块出来的统一表可以在哪些功能里被引用
  usages: z.array(z.enum(["summary", "ai_chart", "ai_analysis"])).default(["summary", "ai_chart", "ai_analysis"]),
  // 是否启用整个模块
  enabled: z.boolean().default(true),
  // 自定义 transform 钩子（写 modules/<code>.transform.ts，导出 default 函数）
  // 这里只是声明意图，代码里 import 走文件系统
  hasTransform: z.boolean().default(false),
  // 可选：覆盖默认输出表名（默认 unified_<code>）。
  // 用于过渡：现有订单模块用 unified_sales（已有数据），新模块默认 unified_<code>
  outputTable: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
  // V0.25+ 字典模块标志：true 表示这是个维护表/字典，不跑 unified ETL
  // 用法：上传时 filePattern 匹配上 → 自动标 data_sources.config.role = <role>
  // 其他模块 joins[].dictRole 通过 role 找它
  isDict: z.boolean().default(false),
  // V0.25+ 字典 role（仅 isDict=true 时有意义）。例 brand_dict / cost_dict / shop_pic_dict
  role: z.string().optional(),
  // 可选：哪些状态值计入默认汇总和分析
  inclusionRule: InclusionRuleSchema.optional(),
  // 稳定的 DIY 分析合同。图表、AI 与查询只引用这里的指标/维度 ID，
  // 物理字段名被限制在 manifest 内部，避免各入口分别猜口径。
  semanticModel: SemanticModelSchema.optional(),
  // 仅由方案安装/升级事务写入。普通模块导出会移除该字段，防止把
  // 源实例的安装归属误带到另一个实例。
  solutionBinding: SolutionBindingSchema.optional(),
}).superRefine((module, ctx) => {
  const columnNames = new Set(module.columns.map((column) => column.name));

  if (module.timeKey && !columnNames.has(module.timeKey)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["timeKey"],
      message: "timeKey 必须引用 columns",
    });
  }

  if (
    module.inclusionRule &&
    !columnNames.has(module.inclusionRule.field)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["inclusionRule", "field"],
      message: "inclusionRule.field 必须引用 columns",
    });
  }

  const joins = module.joins ?? (module.join ? [module.join] : []);
  const enrichTargets = new Set<string>();
  joins.forEach((join, joinIndex) => {
    const joinPath: Array<string | number> = module.joins
      ? ["joins", joinIndex]
      : ["join"];
    if (Object.keys(join.on).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...joinPath, "on"],
        message: "JOIN 至少需要一个关联键",
      });
    }
    if (Object.keys(join.enrich).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...joinPath, "enrich"],
        message: "JOIN 至少需要一个补充字段",
      });
    }
    for (const leftField of Object.keys(join.on)) {
      if (!columnNames.has(leftField)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...joinPath, "on", leftField],
          message: `JOIN 左侧字段不存在于 columns：${leftField}`,
        });
      }
    }
    for (const targetField of Object.keys(join.enrich)) {
      if (!/^[a-z][a-z0-9_]*$/.test(targetField)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...joinPath, "enrich", targetField],
          message: "JOIN 输出字段必须是英文小写字母、数字或下划线",
        });
      }
      if (enrichTargets.has(targetField)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...joinPath, "enrich", targetField],
          message: `多个 JOIN 不能重复写入字段：${targetField}`,
        });
      }
      enrichTargets.add(targetField);
    }
  });

  const semanticRoles = new Set<SemanticRole>();
  for (const [index, column] of module.columns.entries()) {
    if (column.computed && column.expression) {
      const validation = validateExpression(column.expression, columnNames);
      if (!validation.ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["columns", index, "expression"],
          message: `计算字段表达式不安全：${validation.reason}`,
        });
      }
    }
    const role = column.semanticRole;
    if (!role || role === "dimension") continue;
    if (semanticRoles.has(role)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["columns", index, "semanticRole"],
        message: "semanticRole 除 dimension 外不能重复",
      });
      continue;
    }
    semanticRoles.add(role);
  }

  if (module.semanticModel) {
    const expectedPrefix = `${module.code}.`;
    const allowedFields = new Set([
      ...module.columns.map((column) => column.name),
      ...joins.flatMap((join) => Object.keys(join.enrich)),
      "platform",
    ]);
    const ids = new Set<string>();
    const registerId = (id: string, path: Array<string | number>) => {
      if (!id.startsWith(expectedPrefix)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `语义 ID 必须使用模块前缀 ${expectedPrefix}`,
        });
      }
      if (ids.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `语义 ID 重复：${id}`,
        });
      }
      ids.add(id);
    };
    const assertField = (field: string | undefined, path: Array<string | number>) => {
      if (field && !allowedFields.has(field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `语义字段不存在于模块输出合同：${field}`,
        });
      }
    };
    module.semanticModel.dimensions.forEach((dimension, index) => {
      registerId(dimension.id, ["semanticModel", "dimensions", index, "id"]);
      assertField(dimension.field, ["semanticModel", "dimensions", index, "field"]);
    });
    module.semanticModel.metrics.forEach((metric, index) => {
      registerId(metric.id, ["semanticModel", "metrics", index, "id"]);
      assertField(metric.field, ["semanticModel", "metrics", index, "field"]);
      assertField(metric.numeratorField, ["semanticModel", "metrics", index, "numeratorField"]);
      assertField(metric.denominatorField, ["semanticModel", "metrics", index, "denominatorField"]);
    });
    const metricIds = new Set(module.semanticModel.metrics.map((metric) => metric.id));
    const dimensionIds = new Set(module.semanticModel.dimensions.map((dimension) => dimension.id));
    module.presets?.forEach((preset, index) => {
      if (preset.metricId && !metricIds.has(preset.metricId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["presets", index, "metricId"],
          message: `预设引用了不存在的指标 ID：${preset.metricId}`,
        });
      }
      if (preset.dimensionId && !dimensionIds.has(preset.dimensionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["presets", index, "dimensionId"],
          message: `预设引用了不存在的维度 ID：${preset.dimensionId}`,
        });
      }
      if (preset.target === "compare" && !preset.metricId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["presets", index, "metricId"],
          message: "带语义模型的 compare 预设必须引用 metricId",
        });
      }
    });
  }
});
export type ModuleDef = z.infer<typeof ModuleSchema>;

/**
 * 校验：保证 JSON 写错时启动就报错，不让坏配置进生产
 */
export function validateModuleConfig(raw: unknown, filename = "<inline>"): ModuleDef {
  const result = ModuleSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`[模块配置错误] ${filename}\n${issues}`);
  }
  return result.data;
}
