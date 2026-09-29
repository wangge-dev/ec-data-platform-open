/**
 * 默认行映射（D 方案阶段 3）
 *
 * 给无 transform 钩子的简单模块用：纯 JSON 配置就能跑 ETL。
 *
 * 流程：
 *   1. 读 uf_<sourceId> 全表
 *   2. 对每行：按 column.source / platform.columnOverrides 找源列
 *   3. 按 column.type 做类型 CAST（int/numeric/timestamp/date/boolean/text）
 *   4. required 字段缺失 → 丢弃整行
 *   5. text + maxLen → 截断（避免 value too long 整批失败，V0.10 教训）
 *   6. 写入 unified_<code> 表（自动建表，如果不存在）
 *   7. 可选 JOIN 字典：按 join.on 找字典最新版，按 join.enrich 补字段
 *
 * 不处理：复杂 SQL 转换、多表关联、自定义聚合 → 写 transform.ts 钩子
 */
import { sql } from "../db/client.js";
import {
  quoteSqlIdentifier,
  resolveExistingRuntimeTableReferenceFromSql,
  runtimeTableReference,
} from "../db/table-scope.js";
import {
  resolveSourceColumns,
  moduleTableName,
  type LoadedModule,
  type TransformContext,
} from "./loader.js";
import type { ColumnDef, PlatformDef } from "./schema.js";
import { findDictByRole } from "../services/etl.js";
import type { EtlReport } from "../services/etl.js";
import { validateExpression } from "../lib/sql-guard.js";

/**
 * Postgres 列类型映射
 */
function pgType(t: ColumnDef["type"]): string {
  switch (t) {
    case "int":
      return "INTEGER";
    case "numeric":
      return "NUMERIC(18,4)";
    case "timestamp":
      return "TIMESTAMP";
    case "date":
      return "DATE";
    case "boolean":
      return "BOOLEAN";
    case "text":
    default:
      return "TEXT";
  }
}

/**
 * 单值类型转换。返回 null 表示无法转或原值为空。
 */
function castValue(raw: any, col: ColumnDef): any {
  if (raw === null || raw === undefined || raw === "") return null;
  const s = typeof raw === "string" ? raw.trim() : raw;
  if (s === "" || s === "-" || s === "null" || s === "NULL") return null;

  switch (col.type) {
    case "int": {
      const n = parseInt(String(s).replace(/,/g, ""), 10);
      return Number.isNaN(n) ? null : n;
    }
    case "numeric": {
      const n = Number(String(s).replace(/,/g, "").replace(/¥|￥|\$/g, ""));
      return Number.isNaN(n) ? null : n;
    }
    case "timestamp":
    case "date": {
      const d = new Date(s as any);
      if (isNaN(d.getTime())) return null;
      return col.type === "date" ? d.toISOString().slice(0, 10) : d.toISOString();
    }
    case "boolean": {
      const v = String(s).toLowerCase();
      if (["true", "1", "y", "yes", "是"].includes(v)) return true;
      if (["false", "0", "n", "no", "否"].includes(v)) return false;
      return null;
    }
    case "text":
    default: {
      let str = String(s);
      if (col.maxLen && str.length > col.maxLen) str = str.slice(0, col.maxLen);
      return str;
    }
  }
}

/**
 * 取一行里某列的值：按候选源列依次找，第一个非空就用
 */
function pickValue(row: Record<string, any>, sources: string[]): any {
  for (const s of sources) {
    if (row[s] !== undefined && row[s] !== null && row[s] !== "") return row[s];
  }
  return null;
}

type StoredSourceColumn = {
  raw: string;
  name: string;
};

function sourceColumnAliases(value: unknown): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  if (!Array.isArray(value)) return aliases;
  for (const column of value) {
    if (
      !column ||
      typeof column !== "object" ||
      typeof (column as Partial<StoredSourceColumn>).raw !== "string" ||
      typeof (column as Partial<StoredSourceColumn>).name !== "string"
    ) {
      continue;
    }
    const raw = (column as StoredSourceColumn).raw.trim();
    const name = (column as StoredSourceColumn).name.trim();
    if (!raw || !name) continue;
    aliases.set(raw, [...(aliases.get(raw) ?? []), name]);
  }
  return aliases;
}

function storedSourceCandidates(
  configuredSources: string[],
  aliases: Map<string, string[]>,
): string[] {
  return Array.from(
    new Set(
      configuredSources.flatMap((source) => [
        ...(aliases.get(source.trim()) ?? []),
        source,
      ]),
    ),
  );
}

/**
 * 确保输出表存在（按列定义自动建表）
 */
async function ensureOutputTable(
  module: LoadedModule,
  tableName: string,
  executor: typeof sql,
): Promise<string> {
  const existingTableRef = await resolveExistingRuntimeTableReferenceFromSql(tableName, executor);
  const tableRef = existingTableRef ?? runtimeTableReference(tableName);
  const colDefs = module.columns
    .map((c) => `"${c.name}" ${pgType(c.type)}`)
    .join(", ");
  // 加上模块/平台/源文件等元信息列，方便后续追溯（与订单表 unified_sales 字段对齐：platform / matched）
  const extraCols = [
    `"_platform" TEXT`,
    `"_source_id" INTEGER`,
    `"_source_file" TEXT`,
    `"_matched" BOOLEAN DEFAULT false`,
    `"_included" BOOLEAN NOT NULL DEFAULT true`,
    `"_excluded_reason" TEXT`,
    `"_etl_at" TIMESTAMP DEFAULT NOW()`,
  ].join(", ");
  if (!existingTableRef) {
    await executor.unsafe(
      `CREATE TABLE IF NOT EXISTS ${tableRef} (id BIGSERIAL PRIMARY KEY, ${colDefs}, ${extraCols})`,
    );
  }

  // Existing output tables evolve additively: new mappings and inclusion metadata
  // are added in place, while old columns and data remain untouched.
  for (const column of module.columns) {
    await executor.unsafe(
      `ALTER TABLE ${tableRef} ADD COLUMN IF NOT EXISTS ${quoteSqlIdentifier(column.name)} ${pgType(column.type)}`,
    );
  }
  await executor.unsafe(
    `ALTER TABLE ${tableRef} ADD COLUMN IF NOT EXISTS "_included" BOOLEAN NOT NULL DEFAULT true`,
  );
  await executor.unsafe(
    `ALTER TABLE ${tableRef} ADD COLUMN IF NOT EXISTS "_excluded_reason" TEXT`,
  );

  // 如果模块声明了 join（单/多），给所有 enrich 字段建列
  const allJoins = module.joins ?? (module.join ? [module.join] : []);
  for (const j of allJoins) {
    for (const target of Object.keys(j.enrich)) {
      // 已在 columns 里声明的不重复建
      if (module.columns.find((c) => c.name === target)) continue;
      await executor.unsafe(
        `ALTER TABLE ${tableRef} ADD COLUMN IF NOT EXISTS ${quoteSqlIdentifier(target)} TEXT`,
      );
    }
  }
  return tableRef;
}

/**
 * 默认行映射主入口
 */
export async function runDefaultTransform(
  ctx: TransformContext & { module: LoadedModule; platform: string },
): Promise<EtlReport> {
  if (!ctx.sql) {
    return sql.begin(async (tx) => runDefaultTransformInTransaction({
      ...ctx,
      sql: tx,
    })) as Promise<EtlReport>;
  }
  return runDefaultTransformInTransaction({ ...ctx, sql: ctx.sql });
}

async function runDefaultTransformInTransaction(
  ctx: TransformContext & { module: LoadedModule; platform: string; sql: any },
): Promise<EtlReport> {
  const { module: mod, platform: platformCode, rawFileName } = ctx;
  const executor = ctx.sql as typeof sql;
  const sourceId = ctx.extra?.sourceId as number;
  const platformName = (ctx.extra?.platformName as string) ?? platformCode;

  await executor.unsafe(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`ec-data-platform:module-etl:${mod.code}:${sourceId}`],
  );

  const platform = mod.platforms.find((p) => p.code === platformCode);
  if (!platform) {
    return {
      platform: platformName,
      sourceId,
      fileName: rawFileName ?? "",
      total: 0,
      inserted: 0,
      matched: 0,
      matchRate: 0,
      error: `平台 ${platformCode} 不在模块 ${mod.code} 中`,
    };
  }

  const tableName = moduleTableName(mod);
  const tableRef = await ensureOutputTable(mod, tableName, executor);

  // 读原始上传表（uf_<id>）
  const srcTable = `uf_${sourceId}`;
  const srcTableRef = await resolveExistingRuntimeTableReferenceFromSql(srcTable, executor);
  if (!srcTableRef) {
    return {
      platform: platformName,
      sourceId,
      fileName: rawFileName ?? "",
      total: 0,
      inserted: 0,
      matched: 0,
      matchRate: 0,
      error: `读取源表 ${srcTable} 失败：表不存在`,
    };
  }
  let rows: Record<string, any>[];
  try {
    rows = (await executor.unsafe(`SELECT * FROM ${srcTableRef}`)) as any[];
  } catch (e: any) {
    return {
      platform: platformName,
      sourceId,
      fileName: rawFileName ?? "",
      total: 0,
      inserted: 0,
      matched: 0,
      matchRate: 0,
      error: `读取源表 ${srcTable} 失败：${e.message}`,
    };
  }

  if (!rows.length) {
    return {
      platform: platformName,
      sourceId,
      fileName: rawFileName ?? "",
      total: 0,
      inserted: 0,
      matched: 0,
      matchRate: 0,
    };
  }

  // 每行按 schema 映射（仅处理源列字段，计算字段在 INSERT 后用 SQL 算）
  const sourceColumns = mod.columns.filter((c) => !c.computed);
  const sourceAliases = sourceColumnAliases(ctx.extra?.sourceColumns);
  const inclusionRule = mod.inclusionRule;
  const includedValues = new Set(
    inclusionRule?.includedValues.map((value) => normalizeInclusionValue(value)) ?? [],
  );
  const mapped: Record<string, any>[] = [];
  let invalidRequiredValue = false;
  for (const row of rows) {
    const out: Record<string, any> = {};
    let skip = false;
    const inclusionColumn = inclusionRule
      ? sourceColumns.find((column) => column.name === inclusionRule.field)
      : undefined;
    const inclusionValue = inclusionColumn
      ? castValue(
          pickValue(
            row,
            storedSourceCandidates(
              resolveSourceColumns(mod, platformCode, inclusionColumn),
              sourceAliases,
            ),
          ),
          inclusionColumn,
        )
      : null;
    const included = !inclusionRule
      || includedValues.has(normalizeInclusionValue(inclusionValue));
    for (const col of sourceColumns) {
      const sources = storedSourceCandidates(
        resolveSourceColumns(mod, platformCode, col),
        sourceAliases,
      );
      const raw = pickValue(row, sources);
      const v = castValue(raw, col);
      if (
        included &&
        col.required &&
        (v === null || v === undefined)
      ) {
        invalidRequiredValue = true;
        skip = true;
        break;
      }
      out[col.name] = v;
    }
    if (skip) continue;
    out._platform = platformName;
    out._source_id = sourceId;
    out._source_file = rawFileName ?? null;
    out._matched = false;
    out._included = included;
    out._excluded_reason = included
      ? null
      : `状态「${formatInclusionValue(inclusionValue)}」未计入有效数据`;
    mapped.push(out);
  }

  if (invalidRequiredValue) {
    return {
      platform: platformName,
      sourceId,
      fileName: rawFileName ?? "",
      total: rows.length,
      inserted: 0,
      matched: 0,
      matchRate: 0,
      error: "必要字段存在无法读取的值，请修正源文件后重新上传",
    };
  }

  if (!mapped.length) {
    return {
      platform: platformName,
      sourceId,
      fileName: rawFileName ?? "",
      total: rows.length,
      inserted: 0,
      matched: 0,
      matchRate: 0,
      error: "全部行因 required 字段缺失被丢弃，请检查列名映射",
    };
  }

  // 先按 _source_id 清理该文件之前的 ETL 结果（重跑幂等）
  await executor.unsafe(
    `DELETE FROM ${tableRef} WHERE "_source_id" = $1`,
    [sourceId],
  );

  // 批量插入
  const allCols = Object.keys(mapped[0]);
  const colNames = allCols.map((column) => quoteSqlIdentifier(column)).join(", ");
  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < mapped.length; i += BATCH) {
    const slice = mapped.slice(i, i + BATCH);
    const placeholders: string[] = [];
    const params: any[] = [];
    let pIdx = 1;
    for (const r of slice) {
      placeholders.push(`(${allCols.map(() => `$${pIdx++}`).join(", ")})`);
      for (const c of allCols) params.push(r[c]);
    }
    await executor.unsafe(
      `INSERT INTO ${tableRef} (${colNames}) VALUES ${placeholders.join(", ")}`,
      params,
    );
    inserted += slice.length;
  }

  // 可选 JOIN：补字典字段。joins[] 优先于 join（单）
  let matched = 0;
  const allJoins = mod.joins ?? (mod.join ? [mod.join] : []);
  for (let idx = 0; idx < allJoins.length; idx++) {
    const j = allJoins[idx];
    const dict = await findDictByRole(j.dictRole, executor);
    if (!dict) {
      throw new Error(`字典 JOIN「${j.label ?? j.dictRole}」缺少可用字典来源`);
    }

    // 解析 on/enrich 里的"字典列原始名" → uf_ 表规范化列名
    // brand_dict 走旧 DictInfo（直接用 idCol/codeCol/...）；其他 role 走 columnMap
    const dictColName = (rawName: string): string | null => {
      if (j.dictRole === "brand_dict") {
        // brand_dict 的 enrich 值通常已经是中文（"品牌"/"店铺"），翻成 DictInfo 字段
        const map: Record<string, string | null> = {
          "id": (dict as any).idCol,
          "商家编码": (dict as any).codeCol,
          "商品编码": (dict as any).codeCol,
          "货品编码": (dict as any).codeCol,
          "品牌": (dict as any).brandCol,
          "店铺": (dict as any).shopCol,
          "运营": (dict as any).operatorCol,
          "产品名称": (dict as any).productNameCol,
          "商品名称": (dict as any).productNameCol,
          "品类": (dict as any).categoryCol,
        };
        return map[rawName]
          ?? (dict as any).columnMap?.[rawName.trim()]
          ?? null;
      }
      // 通用：从 columnMap 找
      return (dict as any).columnMap?.[rawName] ?? null;
    };

    const resolvedOn = Object.entries(j.on).map(([left, right]) => ({
      left,
      right: dictColName(right),
      rawRight: right,
    }));
    const unresolvedOn = resolvedOn.find((pair) => !pair.right);
    if (unresolvedOn) {
      throw new Error(
        `字典 JOIN「${j.label ?? j.dictRole}」找不到关联列「${unresolvedOn.rawRight}」`,
      );
    }
    const resolvedEnrich = Object.entries(j.enrich).map(([target, rawRight]) => ({
      target,
      right: dictColName(rawRight),
      rawRight,
    }));
    const unresolvedEnrich = resolvedEnrich.find((pair) => !pair.right);
    if (unresolvedEnrich) {
      throw new Error(
        `字典 JOIN「${j.label ?? j.dictRole}」找不到补充列「${unresolvedEnrich.rawRight}」`,
      );
    }

    const dictionaryKeyColumns = resolvedOn.map((pair) => quoteSqlIdentifier(pair.right!));
    const dictTableRef = dict.tableRef;
    try {
      const duplicateKeys = await executor.unsafe(
        `SELECT 1 FROM ${dictTableRef} d
         WHERE ${dictionaryKeyColumns.map((column) => `d.${column} IS NOT NULL`).join(" AND ")}
         GROUP BY ${dictionaryKeyColumns.map((column) => `d.${column}`).join(", ")}
         HAVING COUNT(*) > 1
         LIMIT 1`,
      );
      if (duplicateKeys.length > 0) {
        throw new Error(`字典 JOIN「${j.label ?? j.dictRole}」关联键不唯一`);
      }

      const onPairsArr = resolvedOn.map((pair) => (
        `t.${quoteSqlIdentifier(pair.left)} = d.${quoteSqlIdentifier(pair.right!)}`
      ));
      const setPairsArr = resolvedEnrich.map((pair) => (
        `${quoteSqlIdentifier(pair.target)} = d.${quoteSqlIdentifier(pair.right!)}`
      ));
      const setMatched = idx === 0 ? `, "_matched" = true` : "";
      await executor.unsafe(
        `UPDATE ${tableRef} t SET ${setPairsArr.join(", ")}${setMatched}
         FROM ${dictTableRef} d
         WHERE ${onPairsArr.join(" AND ")} AND t."_source_id" = $1`,
        [sourceId],
      );
    } catch (e: any) {
      if (e instanceof Error && e.message.includes("关联键不唯一")) throw e;
      throw new Error(`字典 JOIN「${j.label ?? j.dictRole}」执行失败`, { cause: e });
    }
  }

  // 统计 matched（多 join 时按第一个的命中率算）
  if (allJoins.length) {
    const [{ cnt }] = (await executor.unsafe(
      `SELECT COUNT(*)::int AS cnt FROM ${tableRef} WHERE "_source_id" = $1 AND "_matched" = true`,
      [sourceId],
    )) as any[];
    matched = cnt;
  }

  // 计算字段：所有 join 完成后，按 expression 算（V0.27：expression 白名单校验防注入）
  const computedCols = mod.columns.filter((c) => c.computed && c.expression);
  for (const c of computedCols) {
    const v = validateExpression(c.expression!, mod.columns.map((column) => column.name));
    if (!v.ok) {
      throw new Error(`计算字段「${c.label ?? c.name}」表达式无效：${v.reason}`);
    }
    try {
      await executor.unsafe(
        `UPDATE ${tableRef} SET ${quoteSqlIdentifier(c.name)} = (${c.expression})
         WHERE "_source_id" = $1`,
        [sourceId],
      );
    } catch (e: any) {
      throw new Error(`计算字段「${c.label ?? c.name}」执行失败`, { cause: e });
    }
  }

  return {
    platform: platformName,
    sourceId,
    fileName: rawFileName ?? "",
    total: rows.length,
    inserted,
    included: mapped.filter((row) => row._included === true).length,
    excluded: mapped.filter((row) => row._included === false).length,
    matched,
    matchRate: inserted > 0 ? Math.round((matched / inserted) * 100) : 0,
  };
}

function normalizeInclusionValue(value: unknown): string {
  return String(value ?? "").trim().normalize("NFKC");
}

function formatInclusionValue(value: unknown): string {
  return String(value ?? "").trim();
}
