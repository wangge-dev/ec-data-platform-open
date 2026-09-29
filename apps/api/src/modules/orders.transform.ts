/**
 * 订单模块 Transform 钩子
 *
 * 职责：从单个上传的订单表（uf_<id>）跑 ETL，JOIN 品牌维护表补品牌/店铺/运营，
 * 写入 unified_sales。
 *
 * 【V0.26 架构对齐】不再读 DB platform_templates 表。列映射全部从 orders.json
 * 的 platforms[].columnOverrides 解析，等价构造 etl.ts 的 Template 对象后
 * 复用 etlOrderSource。etl.ts 的 SQL 拼接逻辑零改动 → 金额逐行不变。
 *
 * 文件归属识别也走 JSON（loader.matchFileToPlatform），所以现在加一个新平台
 * 只需在 orders.json 的 platforms[] 加一项 + 调 POST /modules/reload，不碰 DB、
 * 不改代码、不重启容器。详见 docs/HOW_TO_ADD_PLATFORM.md。
 */
import type { TransformContext } from "./loader.js";
import { resolveSourceColumns } from "./loader.js";
import { etlOrderSource, type Template, type Platform, type EtlReport } from "../services/etl.js";

/**
 * 钩子函数：从 orders.json 的 columnOverrides 构造等价 Template，交给 etlOrderSource。
 *
 * Template 字段 ← orders.json 来源：
 *   platform     ← ctx.extra.platformName（matchFileToPlatform 已按 filePattern 命中）
 *   filePattern  ← 用空正则占位（etlOrderSource 不读，匹配已在 engine 层完成）
 *   joinCol      ← product_id 列的原始列名（订单表 JOIN 字典的关联键）
 *   dictKey      ← join.on.product_id 的值（如 "id"，表示字典侧用 id 列关联）
 *   qtyCol/amountCol/mainOrderCol/rowKeyCol ← 对应列的原始列名
 *   payTimeCol   ← pay_time 列候选第 1 个
 *   orderTimeCol ← pay_time 列候选第 2 个（无则退回 payTimeCol，与 etl 原逻辑一致）
 */
export default async function transform(ctx: TransformContext): Promise<EtlReport> {
  const { module: mod, platform: platformCode } = ctx;
  const { sourceId, platformName } = ctx.extra as { sourceId: number; platformName: string };

  // orders.json 的 columns 按 name 索引，给 resolveSourceColumns 用
  const col = (name: string) => mod.columns.find((c) => c.name === name);
  const pick = (name: string): string => {
    const c = col(name);
    return c ? resolveSourceColumns(mod, platformCode, c)[0] ?? "" : "";
  };

  // pay_time 支持数组候选：[0]=付款时间，[1]=下单时间（退回）
  const payCandidates = col("pay_time")
    ? resolveSourceColumns(mod, platformCode, col("pay_time")!)
    : [];
  const payTimeCol = payCandidates[0] ?? "";
  const orderTimeCol = payCandidates[1] ?? payTimeCol;

  // dictKey：从 join.on.product_id 取（值如 "id"/"code"），表示字典侧关联列
  const dictKeyRaw = (mod as any).join?.on?.product_id ?? "id";
  const dictKey: "id" | "code" = dictKeyRaw === "code" ? "code" : "id";

  const tpl: Template = {
    platform: platformName as Platform,
    filePattern: /.^/, // 占位：etlOrderSource 不读此字段（匹配已在 engine.ts 完成）
    joinCol: pick("product_id"),
    dictKey,
    qtyCol: pick("qty"),
    amountCol: pick("amount"),
    payTimeCol,
    orderTimeCol,
    mainOrderCol: pick("main_order_no"),
    rowKeyCol: pick("row_key"),
  };

  // 缺关联键或金额列时给清晰报错（etlOrderSource 内部也会查列，但这里提前拦更友好）
  if (!tpl.joinCol || !tpl.amountCol) {
    return {
      platform: platformName as Platform,
      sourceId,
      fileName: ctx.rawFileName ?? "",
      total: 0,
      inserted: 0,
      matched: 0,
      matchRate: 0,
      error: `订单模块「${platformName}」的 columnOverrides 缺 product_id 或 amount，请在 orders.json 补全该平台的列映射`,
    };
  }

  // V0.27：取平台的 statusFilter（订单状态过滤，GMV 只算有效销售）
  const platform = mod.platforms.find((p) => p.code === platformCode) as any;
  const statusFilter = platform?.statusFilter;

  return etlOrderSource(sourceId, tpl, "unified_sales", statusFilter);
}
