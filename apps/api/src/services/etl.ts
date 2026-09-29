// 平台订单 ETL：按平台模板，JOIN 维护表(品牌字典)补品牌/店铺/运营，写入 unified_sales（销售额口径）
import { eq, and, desc } from "drizzle-orm";
import { db, sql } from "../db/client";
import { dataSources, platformTemplates } from "../db/schema";
import {
  resolveExistingRuntimeTableReferenceFromSql,
  runtimeTableReference,
} from "../db/table-scope";
import { compileSafeFilePattern } from "../lib/file-pattern.js";

// 配置化后平台名来自 DB（platform_templates），不再是固定枚举
export type Platform = string;

export type Template = {
  platform: Platform;
  filePattern: RegExp; // 文件名识别（仅 detectPlatform 用，etlOrderSource 不读）
  joinCol: string; // 订单表关联列(原始中文名)
  dictKey: "id" | "code"; // 关联到维护表的 id 列 还是 商家编码 列
  qtyCol: string;
  amountCol: string;
  payTimeCol: string; // 付款时间列(优先)
  orderTimeCol: string; // 下单时间列(退回)
  mainOrderCol: string;
  rowKeyCol: string; // 平台内唯一行标识列(子订单号/发货单ID)
};

// 各平台默认模板（仅用于 seed.ts 初始化 DB platform_templates 表）
// 【V0.26 废弃】运行时不再读 DB：orders.transform.ts 已改从 orders.json 的
// columnOverrides 构造等价 Template。此数组仅保留给 seed.ts 灌库用（DB 表保留
// 防回滚，但 ETL 代码不再读它）。新增平台请改 orders.json，不要动这里。
export const DEFAULT_TEMPLATES: Template[] = [
  {
    platform: "淘工厂",
    filePattern: /GEI@EXPORT_ORDER_INFO/i,
    joinCol: "商品编码",
    dictKey: "id",
    qtyCol: "宝贝数量",
    amountCol: "买家实际支付金额",
    payTimeCol: "订单付款时间",
    orderTimeCol: "订单创建时间",
    mainOrderCol: "主订单编号",
    rowKeyCol: "子订单编号",
  },
  {
    platform: "进口超市",
    filePattern: /全部数据导出/,
    joinCol: "商品id",
    dictKey: "id",
    qtyCol: "商品数量",
    amountCol: "订单金额",
    payTimeCol: "支付时间",
    orderTimeCol: "下单时间",
    mainOrderCol: "交易订单号",
    rowKeyCol: "子交易单号",
  },
  {
    platform: "旗舰店",
    filePattern: /ExportOrderList/i,
    joinCol: "商品ID",
    dictKey: "id",
    qtyCol: "购买数量",
    amountCol: "买家实付金额",
    payTimeCol: "订单付款时间",
    orderTimeCol: "订单创建时间",
    mainOrderCol: "主订单编号",
    rowKeyCol: "子订单编号",
  },
  {
    platform: "阿里健康",
    filePattern: /shiporder/i,
    joinCol: "前端商品ID",
    dictKey: "id",
    qtyCol: "商品数量",
    amountCol: "金额(不作为结算依据，仅供参考)",
    payTimeCol: "下单时间",
    orderTimeCol: "下单时间",
    mainOrderCol: "主订单ID",
    rowKeyCol: "主发货单ID",
  },
];

// 【V0.26 废弃】从 DB platform_templates 读取启用模板。orders ETL 已改读 orders.json，
// 此函数不再被运行时调用（仅留作回滚兜底）。新增平台请改 orders.json + reload。
export async function getTemplates(): Promise<Template[]> {
  const rows = await db.select().from(platformTemplates).where(eq(platformTemplates.enabled, true));
  const out: Template[] = [];
  for (const r of rows) {
    let pattern: RegExp;
    try {
      pattern = compileSafeFilePattern(r.filePattern, r.patternFlags ?? "i");
    } catch {
      // 非法正则源串（运营手填可能写错）跳过该模板，不让整个扫描崩
      console.warn(`[etl] 平台「${r.platform}」的 filePattern 非法正则，已跳过: ${r.filePattern}`);
      continue;
    }
    out.push({
      platform: r.platform,
      filePattern: pattern,
      joinCol: r.joinCol,
      dictKey: r.dictKey === "code" ? "code" : "id",
      qtyCol: r.qtyCol ?? "",
      amountCol: r.amountCol,
      payTimeCol: r.payTimeCol ?? "",
      orderTimeCol: r.orderTimeCol ?? "",
      mainOrderCol: r.mainOrderCol ?? "",
      rowKeyCol: r.rowKeyCol ?? "",
    });
  }
  return out;
}

// 【V0.26 废弃】按文件名匹配 DB 平台模板。文件归属识别改用 loader.matchFileToPlatform
// （读 JSON）。此函数仅留作回滚兜底，运行时不再被调用。
export async function detectPlatform(fileName: string, templates?: Template[]): Promise<Template | null> {
  const list = templates ?? (await getTemplates());
  return list.find((t) => t.filePattern.test(fileName)) ?? null;
}

type DictInfo = {
  table: string;
  tableRef: string;
  idCol: string | null;
  codeCol: string | null;
  brandCol: string | null;
  shopCol: string | null;
  operatorCol: string | null;
  productNameCol: string | null;
  categoryCol: string | null;
};

// 找最新的品牌字典(维护表)
export async function findBrandDict(): Promise<DictInfo | null> {
  return findDictByRole("brand_dict");
}

/**
 * 通用：按 data_sources.config.role 找最新且 uf_<id> 物理表存在的字典源
 * 返回表名和原始列名列表（给 JOIN 时用源列名映射）
 */
export type GenericDict = {
  table: string;
  tableRef: string;
  role: string;
  // 原始中文列名 → uf_ 表规范化列名 的映射
  columnMap: Record<string, string>;
};
export async function findDictByRole(
  role: string,
  executor?: { unsafe(query: string, parameters?: unknown[]): PromiseLike<any[]> },
): Promise<any | null> {
  const list = executor
    ? await executor.unsafe(
        `SELECT id, config FROM public.data_sources
         WHERE type = 'file' ORDER BY created_at DESC`,
      )
    : await db
        .select()
        .from(dataSources)
        .where(eq(dataSources.type, "file"))
        .orderBy(desc(dataSources.createdAt));
  for (const dict of list) {
    if ((dict.config as any)?.role !== role) continue;
    const table = `uf_${dict.id}`;
    const tableRef = await resolveExistingRuntimeTableReferenceFromSql(
      table,
      executor ?? sql,
    );
    if (!tableRef) continue;

    const cols = ((dict.config as any).columns ?? []) as Array<{ raw: string; name: string }>;
    const columnMap: Record<string, string> = {};
    for (const c of cols) columnMap[c.raw.trim()] = c.name;

    // 兼容 brand_dict：返回旧 DictInfo 形状，同时保留经过导入器规范化的
    // 完整列映射。JOIN 执行器不得把 manifest 里的原始文本直接当 SQL 标识符。
    if (role === "brand_dict") {
      const bd = (dict.config as any).brandDict ?? {};
      return {
        table,
        tableRef,
        idCol: bd.idCol ?? null,
        codeCol: bd.codeCol ?? null,
        brandCol: bd.brandCol ?? null,
        shopCol: bd.shopCol ?? null,
        operatorCol: bd.operatorCol ?? null,
        productNameCol: bd.productNameCol ?? null,
        categoryCol: bd.categoryCol ?? null,
        columnMap,
      };
    }

    // 通用：返回原始列名 → 规范化列名映射
    return { table, tableRef, role, columnMap } as GenericDict;
  }
  return null;
}

// 在订单表 columns(raw->name) 里按原始中文名找规范化列名
function resolveCol(cols: Array<{ raw: string; name: string }>, rawName: string): string | null {
  return cols.find((c) => c.raw.trim() === rawName.trim())?.name ?? null;
}

/**
 * V0.27：构造状态过滤 WHERE 子句 + 参数（GMV 只算有效销售）
 * 抽成纯函数便于单测（不连 DB）。statusFilter 来自模块 JSON 配置，状态值参数化防注入。
 */
export type StatusFilter = {
  statusColumn: string;
  excludeStatus: string[];
  refundColumn?: string;
  refundExclude: string[];
};
export function buildStatusWhere(
  cols: Array<{ raw: string; name: string }>,
  sf: StatusFilter | undefined,
): { clause: string; params: string[] } {
  if (!sf) return { clause: "", params: [] };
  const conds: string[] = [];
  const params: string[] = [];
  const statusCol = resolveCol(cols, sf.statusColumn);
  if (statusCol && sf.excludeStatus.length) {
    const base = params.length;
    conds.push(
      `(o."${statusCol}" IS NULL OR o."${statusCol}" NOT IN (${sf.excludeStatus.map((_, i) => `$${base + i + 1}`).join(",")}))`,
    );
    params.push(...sf.excludeStatus);
  }
  if (sf.refundColumn && sf.refundExclude.length) {
    const refundCol = resolveCol(cols, sf.refundColumn);
    if (refundCol) {
      const base = params.length;
      conds.push(
        `(o."${refundCol}" IS NULL OR o."${refundCol}" NOT IN (${sf.refundExclude.map((_, i) => `$${base + i + 1}`).join(",")}))`,
      );
      params.push(...sf.refundExclude);
    }
  }
  return { clause: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
}

export type EtlReport = {
  platform: Platform;
  sourceId: number;
  fileName: string;
  total: number;
  inserted: number;
  included?: number;
  excluded?: number;
  matched: number;
  matchRate: number;
  missingCols?: string[];
  missSamples?: string[];
  error?: string;
  schemaReview?: import("./source-schema-review-state.js").PendingSourceSchemaReview;
  defaultCharts?: {
    status: "no_data" | "existing_charts" | "created" | "already_seeded" | "error";
    created: number;
    message?: string;
  };
};

// 对一个已上传的订单 data_source 跑 ETL，写入 unified_sales
export async function etlOrderSource(
  sourceId: number,
  tpl: Template,
  outputTable = "unified_sales",
  statusFilter?: {
    statusColumn: string;
    excludeStatus: string[];
    refundColumn?: string;
    refundExclude: string[];
  },
): Promise<EtlReport> {
  const [src] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId)).limit(1);
  const base: EtlReport = {
    platform: tpl.platform,
    sourceId,
    fileName: (src?.config as any)?.originalFileName ?? "",
    total: 0,
    inserted: 0,
    matched: 0,
    matchRate: 0,
  };
  if (!src) return { ...base, error: "数据源不存在" };

  const cols = (src.config as any)?.columns as Array<{ raw: string; name: string }>;
  const orderTable = `uf_${sourceId}`;
  const orderTableRef = await resolveExistingRuntimeTableReferenceFromSql(orderTable, sql);
  if (!orderTableRef) return { ...base, error: `订单源表 ${orderTable} 不存在` };
  const outputTableRef =
    (await resolveExistingRuntimeTableReferenceFromSql(outputTable, sql))
    ?? runtimeTableReference(outputTable);
  const dict = await findBrandDict();
  if (!dict) return { ...base, error: "未导入维护表(品牌字典)，请先导入" };

  // 解析关键列
  const joinC = resolveCol(cols, tpl.joinCol);
  const amountC = resolveCol(cols, tpl.amountCol);
  const missing: string[] = [];
  if (!joinC) missing.push(tpl.joinCol);
  if (!amountC) missing.push(tpl.amountCol);
  if (missing.length) return { ...base, error: `订单表缺列: ${missing.join("、")}`, missingCols: missing };

  const qtyC = resolveCol(cols, tpl.qtyCol);
  const payC = resolveCol(cols, tpl.payTimeCol);
  const orderC = resolveCol(cols, tpl.orderTimeCol);
  const mainC = resolveCol(cols, tpl.mainOrderCol);
  const rowKeyC = resolveCol(cols, tpl.rowKeyCol);
  const dictKeyCol = tpl.dictKey === "id" ? dict.idCol : dict.codeCol;
  if (!dictKeyCol) return { ...base, error: `维护表缺少${tpl.dictKey === "id" ? "id" : "商家编码"}列` };

  // V0.27：状态过滤 WHERE 子句 + 参数（GMV 只算有效销售，排除已取消/已退款等无效订单）
  const { clause: statusWhere, params: statusParams } = buildStatusWhere(cols, statusFilter);
  // 安全表达式
  const num = (c: string | null) => (c ? `NULLIF(REPLACE(o."${c}",',',''),'')::numeric` : "NULL");
  const ts = `CASE WHEN ${payC ? `o."${payC}" ~ '^[0-9]{4}-'` : "FALSE"} THEN ${payC ? `o."${payC}"::timestamp` : "NULL::timestamp"} `
    + `WHEN ${orderC ? `o."${orderC}" ~ '^[0-9]{4}-'` : "FALSE"} THEN ${orderC ? `o."${orderC}"::timestamp` : "NULL::timestamp"} ELSE NULL::timestamp END`;
  const mainExpr = mainC ? `o."${mainC}"` : "NULL";
  const rowKeyExpr = `COALESCE(NULLIF(${rowKeyC ? `o."${rowKeyC}"` : "NULL"},''), ${mainExpr} || '-' || o."${joinC}")`;
  // 维护表去重子查询（一个关联键取一行品牌，避免一对多 JOIN 膨胀）
  const dictTableRef = dict.tableRef;
  const dictSub = `(SELECT DISTINCT ON (d."${dictKeyCol}")
      d."${dictKeyCol}" AS _k,
      ${dict.shopCol ? `d."${dict.shopCol}"` : "NULL"} AS _shop,
      ${dict.brandCol ? `d."${dict.brandCol}"` : "NULL"} AS _brand,
      ${dict.operatorCol ? `d."${dict.operatorCol}"` : "NULL"} AS _op,
      ${dict.productNameCol ? `d."${dict.productNameCol}"` : "NULL"} AS _pname,
      ${dict.categoryCol ? `d."${dict.categoryCol}"` : "NULL"} AS _cat
    FROM ${dictTableRef} d WHERE d."${dictKeyCol}" IS NOT NULL
    ORDER BY d."${dictKeyCol}") d`;

  // 字面量先转义单引号，再交给 SQL 的 LEFT() 截断长度（防 varchar 超长整批 INSERT 失败）
  const plat = tpl.platform.replace(/'/g, "''");
  const srcFile = ((src.config as any)?.originalFileName ?? "").replace(/'/g, "''").slice(0, 256);

  const insertSql = `
    INSERT INTO ${outputTableRef}
      (platform, row_key, main_order_no, product_id, qty, amount, pay_time, order_month,
       shop, brand, operator, product_name, category, matched, source_file)
    SELECT
      LEFT('${plat}', 32),
      LEFT(${rowKeyExpr}, 160),
      LEFT(${mainExpr}, 64),
      LEFT(o."${joinC}", 128),
      ${num(qtyC)},
      ${num(amountC)},
      ${ts},
      to_char(${ts}, 'YYYY-MM'),
      LEFT(d._shop, 128), LEFT(d._brand, 64), LEFT(d._op, 64), LEFT(d._pname, 256), LEFT(d._cat, 128),
      (d._k IS NOT NULL),
      '${srcFile}'
    FROM ${orderTableRef} o
    LEFT JOIN ${dictSub} ON o."${joinC}" = d._k
    ${statusWhere}
    ON CONFLICT (platform, row_key) DO NOTHING
  `;

  try {
    // 核验修复（HIGH）：订单状态回溯。
    // 旧实现仅 ON CONFLICT DO NOTHING——同一订单昨天有效已入库、今天取消/退款后重传，
    // 新行被 statusFilter 正确排除，但昨天的旧行永久留在表里计入 GMV（状态回溯失效）。
    // 修复：重传同一 source_file 前，先删该文件之前写入的行，再重插当前有效行。
    // unified 表就成了"最新一次导出"的镜像，取消/退款/金额修正都能回溯生效。
    // 按 (platform, source_file) 精确清理——只清本文件旧行，不动其他文件/平台。
    const srcFileFull = ((src.config as any)?.originalFileName ?? "").slice(0, 256);
    await sql.unsafe(
      `DELETE FROM ${outputTableRef} WHERE platform = $1 AND source_file = $2`,
      [tpl.platform, srcFileFull],
    );
    // total/inserted/matched/miss 全部带 statusWhere，统计口径=有效订单
    const totalSql = `SELECT COUNT(*)::int AS count FROM ${orderTableRef} o ${statusWhere}`;
    const matchedSql = `SELECT COUNT(*)::int AS matched FROM ${orderTableRef} o
       ${statusWhere ? statusWhere + " AND" : "WHERE"} EXISTS (SELECT 1 FROM ${dictTableRef} d WHERE d."${dictKeyCol}" = o."${joinC}")`;
    const missSql = `SELECT DISTINCT o."${joinC}" AS v FROM ${orderTableRef} o
       LEFT JOIN ${dictTableRef} d ON o."${joinC}" = d."${dictKeyCol}"
       ${statusWhere ? statusWhere + " AND" : "WHERE"} d."${dictKeyCol}" IS NULL AND o."${joinC}" IS NOT NULL LIMIT 5`;
    const [{ count: total }] = await sql.unsafe(totalSql, statusParams);
    const inserted = await sql.unsafe(insertSql, statusParams);
    const [{ matched }] = await sql.unsafe(matchedSql, statusParams);
    const miss = await sql.unsafe(missSql, statusParams);
    return {
      ...base,
      total,
      inserted: (inserted as any).count ?? 0,
      matched,
      matchRate: total ? Math.round((matched / total) * 100) : 0,
      missSamples: miss.map((m: any) => String(m.v)),
    };
  } catch (e: any) {
    return { ...base, error: e.message };
  }
}
