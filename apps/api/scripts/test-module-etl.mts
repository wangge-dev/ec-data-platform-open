// 模块化 ETL 阶段 2 回归测试
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });

import { eq, desc } from "drizzle-orm";
import { db, sql } from "../src/db/client.js";
import { dataSources } from "../src/db/schema.js";
import { loadModules, matchFileToPlatform } from "../src/modules/loader.js";
import { runModuleEtl, getModuleOutputTable } from "../src/modules/engine.js";

console.log("=== 1. 加载模块 ===");
const mods = await loadModules();
const orders = mods[0];
console.log(`✓ ${mods.length} 模块`);
console.log(`  code=${orders.code}, hasTransform=${orders.hasTransform}, transform fn=${typeof orders.transform === "function"}`);
console.log(`  输出表: ${await getModuleOutputTable("orders")}`);

console.log("\n=== 2. 测最近 5 个文件的匹配 ===");
const files = await db
  .select()
  .from(dataSources)
  .where(eq(dataSources.type, "file"))
  .orderBy(desc(dataSources.createdAt))
  .limit(5);

for (const f of files) {
  const name = ((f.config as any)?.originalFileName) ?? f.name;
  const m = await matchFileToPlatform(name);
  console.log(`  [uf_${f.id}] ${name.slice(0, 60)}`);
  console.log(`         → ${m ? m.module.code + "/" + m.platform.code : "(不匹配，可能是维护表)"}`);
}

console.log("\n=== 3. 阶段 2 关键回归：跑一个旗舰店小文件 ===");
const all = await db
  .select()
  .from(dataSources)
  .where(eq(dataSources.type, "file"))
  .orderBy(desc(dataSources.createdAt));

// 挑行数 < 200 的 ExportOrderList 文件（快）
const target = all.find((f) => {
  const n = ((f.config as any)?.originalFileName) ?? f.name;
  const cnt = (f.config as any)?.rowCount ?? 0;
  return /ExportOrderList/i.test(n) && cnt > 0 && cnt < 200;
});

if (!target) {
  console.log("  没找到小行数的 ExportOrderList 文件，跳过");
  await sql.end();
  process.exit(0);
}

const tname = ((target.config as any)?.originalFileName) ?? target.name;
const rc = (target.config as any)?.rowCount;
console.log(`  目标: uf_${target.id} (${tname}, ${rc} 行)`);

// 跑 BEFORE: 该文件在 unified_sales 已经有的销售额（之前老 ETL 跑过的）
const [{ before }] = await sql.unsafe(
  `SELECT COALESCE(SUM(amount), 0)::numeric AS before FROM unified_sales
   WHERE source_file = '${tname.replace(/'/g, "''").slice(0, 256)}'`,
);
console.log(`  unified_sales 中该文件已有金额合计: ¥${before}`);

console.log("  调用 runModuleEtl()...");
const t0 = Date.now();
const r = await runModuleEtl(target.id);
const dt = Date.now() - t0;
console.log(`  ✓ 完成（${dt}ms）`);
console.log(`    platform=${r.platform}`);
console.log(`    total=${r.total}, inserted=${r.inserted}, matched=${r.matched} (${r.matchRate}%)`);
if (r.error) console.log(`    ✗ error: ${r.error}`);

// 跑 AFTER 验证：ON CONFLICT DO NOTHING 应该让金额不变
const [{ after }] = await sql.unsafe(
  `SELECT COALESCE(SUM(amount), 0)::numeric AS after FROM unified_sales
   WHERE source_file = '${tname.replace(/'/g, "''").slice(0, 256)}'`,
);
console.log(`  unified_sales 中该文件金额合计（重跑后）: ¥${after}`);
console.log(`  ${before === after ? "✓ 一致（幂等）" : `✗ 金额变了! before=${before} after=${after}`}`);

await sql.end();
process.exit(0);
