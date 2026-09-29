// 一次性脚本：把今天上传但没跑 ETL 的文件批量 runModuleEtl
// 解决"上传文件夹"按钮 bug 遗留——文件入库了但 unified_sales 没数据
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });

import { sql } from "../src/db/client.js";
import { runModuleEtl } from "../src/modules/engine.js";

console.log("=== 把今天上传的文件批量跑 ETL ===\n");

const rows = (await sql.unsafe(
  `SELECT id, name, config->>'originalFileName' AS original, config->>'role' AS role
   FROM data_sources
   WHERE type='file' AND created_at >= '2026-06-25 00:00'
   ORDER BY id`,
)) as any[];

console.log(`找到 ${rows.length} 个今天上传的文件\n`);

let ok = 0;
let skipped = 0;
let failed = 0;

for (const r of rows) {
  const name = r.original || r.name || `uf_${r.id}`;
  const isDict = r.role && r.role !== "file";
  process.stdout.write(`  [${r.id}] ${String(name).slice(0, 50).padEnd(50)} `);

  if (isDict) {
    process.stdout.write(`字典(role=${r.role})跳过\n`);
    skipped++;
    continue;
  }

  try {
    const t0 = Date.now();
    const report = await runModuleEtl(r.id);
    const dt = Date.now() - t0;

    if (!report) {
      process.stdout.write(`⚠ 没匹配任何模块（跳过）\n`);
      skipped++;
    } else if (report.error) {
      process.stdout.write(`✗ ${report.error.slice(0, 60)} (${dt}ms)\n`);
      failed++;
    } else {
      process.stdout.write(
        `✓ ${report.platform} ${report.inserted}/${report.total} matched=${report.matched} (${dt}ms)\n`,
      );
      ok++;
    }
  } catch (e: any) {
    process.stdout.write(`✗ EXCEPTION: ${e.message?.slice(0, 60)}\n`);
    failed++;
  }
}

console.log(`\n=== 结果 ===`);
console.log(`✓ 成功: ${ok}`);
console.log(`⚠ 跳过: ${skipped}`);
console.log(`✗ 失败: ${failed}`);

console.log(`\n=== 当前 unified_sales 最新日期分布 ===`);
const recent = (await sql.unsafe(
  `SELECT DATE(pay_time) AS d, platform, COUNT(*)::int AS rows
   FROM unified_sales
   WHERE pay_time >= '2026-06-20'
   GROUP BY DATE(pay_time), platform
   ORDER BY d DESC, rows DESC`,
)) as any[];
for (const r of recent) {
  const ds = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : r.d;
  console.log(`  ${ds}  ${r.platform}  ${r.rows} 行`);
}

await sql.end();
process.exit(0);
