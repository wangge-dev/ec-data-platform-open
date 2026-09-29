// 模块化 ETL 阶段 3 全量真实订单回归测试
// 对所有订单文件跑新引擎，与 unified_sales 当前状态对比（金额一字不变即通过）
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });

import { eq, desc } from "drizzle-orm";
import { db, sql } from "../src/db/client.js";
import { dataSources } from "../src/db/schema.js";
import { matchFileToPlatform } from "../src/modules/loader.js";
import { runModuleEtl } from "../src/modules/engine.js";

console.log("=== 阶段 3 全量回归测试 ===\n");

// 1. 快照：当前 unified_sales 各平台金额
console.log("1. 当前 unified_sales 状态（旧 ETL 跑过的）：");
const before: any[] = (await sql.unsafe(
  `SELECT platform, COUNT(*)::int AS rows, ROUND(SUM(amount)::numeric, 2) AS amount,
          SUM(matched::int)::int AS matched
   FROM unified_sales GROUP BY platform ORDER BY platform`,
)) as any[];
for (const r of before) {
  console.log(`   ${r.platform}: ${r.rows} 行  ¥${r.amount}  matched=${r.matched}`);
}
const totalBefore = before.reduce((a, b) => a + Number(b.amount), 0);
const rowsBefore = before.reduce((a, b) => a + Number(b.rows), 0);
console.log(`   合计: ${rowsBefore} 行  ¥${totalBefore.toFixed(2)}\n`);

// 2. 找所有订单文件
const all = await db
  .select()
  .from(dataSources)
  .where(eq(dataSources.type, "file"))
  .orderBy(desc(dataSources.createdAt));

const orderFiles: any[] = [];
for (const f of all) {
  const name = ((f.config as any)?.originalFileName) ?? f.name;
  const m = await matchFileToPlatform(name);
  if (m && m.module.code === "orders") {
    orderFiles.push({ id: f.id, name, rowCount: (f.config as any)?.rowCount ?? 0, platform: m.platform.name });
  }
}
console.log(`2. 找到 ${orderFiles.length} 个订单文件，按平台分组：`);
const byPlatform = orderFiles.reduce((acc, f) => {
  acc[f.platform] = (acc[f.platform] ?? 0) + 1;
  return acc;
}, {} as Record<string, number>);
for (const [k, v] of Object.entries(byPlatform)) console.log(`   ${k}: ${v} 文件`);
console.log("");

// 3. 跑全量 ETL
console.log(`3. 跑新引擎全量 ETL...\n`);
const tStart = Date.now();
let okCount = 0;
let errCount = 0;
let totalRows = 0;
const errors: { file: string; error: string }[] = [];

for (let i = 0; i < orderFiles.length; i++) {
  const f = orderFiles[i];
  process.stdout.write(`   [${i + 1}/${orderFiles.length}] uf_${f.id} (${f.platform}, ${f.rowCount} 行)... `);
  try {
    const t0 = Date.now();
    const r = await runModuleEtl(f.id);
    const dt = Date.now() - t0;
    if (r?.error) {
      errCount++;
      errors.push({ file: f.name, error: r.error });
      process.stdout.write(`✗ ${r.error.slice(0, 60)} (${dt}ms)\n`);
    } else {
      okCount++;
      totalRows += r?.total ?? 0;
      process.stdout.write(`✓ ${r?.inserted}/${r?.total} matched=${r?.matched} (${dt}ms)\n`);
    }
  } catch (e: any) {
    errCount++;
    errors.push({ file: f.name, error: e.message });
    process.stdout.write(`✗ ${e.message.slice(0, 60)}\n`);
  }
}
const totalTime = ((Date.now() - tStart) / 1000).toFixed(1);
console.log(`\n   完成 ${okCount} 成功 / ${errCount} 失败，处理 ${totalRows} 原始行，耗时 ${totalTime}s\n`);

if (errors.length) {
  console.log("   失败明细：");
  for (const e of errors.slice(0, 10)) console.log(`     ${e.file}: ${e.error.slice(0, 100)}`);
  if (errors.length > 10) console.log(`     ... 还有 ${errors.length - 10} 个`);
  console.log("");
}

// 4. 对比 AFTER
console.log("4. 重跑后 unified_sales 状态：");
const after: any[] = (await sql.unsafe(
  `SELECT platform, COUNT(*)::int AS rows, ROUND(SUM(amount)::numeric, 2) AS amount,
          SUM(matched::int)::int AS matched
   FROM unified_sales GROUP BY platform ORDER BY platform`,
)) as any[];
for (const r of after) {
  console.log(`   ${r.platform}: ${r.rows} 行  ¥${r.amount}  matched=${r.matched}`);
}
const totalAfter = after.reduce((a, b) => a + Number(b.amount), 0);
const rowsAfter = after.reduce((a, b) => a + Number(b.rows), 0);
console.log(`   合计: ${rowsAfter} 行  ¥${totalAfter.toFixed(2)}\n`);

// 5. 逐平台对比
console.log("5. 平台级金额对比：");
const beforeMap = new Map(before.map((r) => [r.platform, r]));
const afterMap = new Map(after.map((r) => [r.platform, r]));
const platforms = new Set<string>([...beforeMap.keys(), ...afterMap.keys()] as any);
let allEqual = true;
for (const p of platforms) {
  const b = beforeMap.get(p);
  const a = afterMap.get(p);
  const bAmt = b ? Number(b.amount) : 0;
  const aAmt = a ? Number(a.amount) : 0;
  const bRows = b ? Number(b.rows) : 0;
  const aRows = a ? Number(a.rows) : 0;
  const eq = bAmt === aAmt && bRows === aRows;
  if (!eq) allEqual = false;
  console.log(
    `   ${p}: ${eq ? "✓" : "✗"}  ¥${bAmt} → ¥${aAmt} (Δ=¥${(aAmt - bAmt).toFixed(2)}, 行${bRows}→${aRows})`,
  );
}

console.log("\n=== 结果 ===");
if (allEqual && errCount === 0) {
  console.log("✅ 通过：金额一字不变，全部 ETL 成功");
} else if (allEqual) {
  console.log(`⚠️  金额一致但有 ${errCount} 个失败文件（看上面明细）`);
} else {
  console.log(`❌ 失败：金额变了，请排查`);
}

await sql.end();
process.exit(allEqual && errCount === 0 ? 0 : 1);
