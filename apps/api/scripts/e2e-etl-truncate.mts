// 一次性 E2E：验证 ETL 对超长字段的 LEFT() 截断不再让整批 INSERT 失败。
// 用独立平台名 ZZE2E 隔离合成数据，跑完即清，绝不碰真实订单。
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });

import * as XLSX from "xlsx";

async function main() {
  const { db, sql } = await import("../src/db/client");
  const { platformTemplates, dataSources } = await import("../src/db/schema");
  const { importExcel } = await import("../src/services/import-excel");
  const { getTemplates, detectPlatform, etlOrderSource } = await import("../src/services/etl");
  const { eq } = await import("drizzle-orm");

  const PLATFORM = "ZZE2E";
  const FILE = "ZZE2E_SAMPLE_test.xlsx";
  let sourceId: number | null = null;

  try {
    // 1. 建临时平台模板
    await db.delete(platformTemplates).where(eq(platformTemplates.platform, PLATFORM));
    await db.insert(platformTemplates).values({
      platform: PLATFORM,
      filePattern: "ZZE2E_SAMPLE",
      joinCol: "商品ID",
      dictKey: "id",
      amountCol: "金额",
      qtyCol: "数量",
      rowKeyCol: "子单号",
      mainOrderCol: "主单号",
      payTimeCol: "付款时间",
      enabled: true,
    });

    // 2. 合成订单：一行正常 + 一行超长(子单号 300 字符 / 商品ID 200 字符，均超 varchar 上限)
    const longKey = "K".repeat(300);
    const longPid = "P".repeat(200);
    const rows = [
      ["商品ID", "金额", "数量", "子单号", "主单号", "付款时间"],
      ["1016132642243", "54.90", "1", "NORMALSUBORDER001", "MAIN001", "2026-06-19 07:55:46"],
      [longPid, "110.00", "2", longKey, "MAIN002", "2026-06-19 13:50:54"],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    // 3. 导入 + ETL
    const imp = await importExcel(buf, FILE, "ZZE2E测试", "file", true);
    sourceId = imp.sourceId;
    const tpls = await getTemplates();
    const tpl = await detectPlatform(FILE, tpls);
    if (!tpl) throw new Error("未识别到 ZZE2E 平台模板");
    const report = await etlOrderSource(sourceId, tpl);

    console.log("ETL report:", JSON.stringify(report));
    if (report.error) throw new Error("ETL 报错(说明超长行仍炸批): " + report.error);
    if (report.inserted !== 2) throw new Error(`期望写入 2 行(含超长行),实际 ${report.inserted}`);

    // 4. 验证超长 row_key 被截断到 160
    const [{ maxlen }] = await sql.unsafe(
      `SELECT MAX(LENGTH(row_key))::int AS maxlen FROM unified_sales WHERE platform='${PLATFORM}'`,
    );
    console.log("max row_key length:", maxlen);
    if (maxlen > 160) throw new Error(`row_key 未截断, 长度 ${maxlen}`);

    console.log("✅ PASS: 超长行已安全截断写入, 整批未失败");
  } finally {
    // 5. 清理合成数据(绝不影响真实订单)
    await sql.unsafe(`DELETE FROM unified_sales WHERE platform='ZZE2E'`);
    if (sourceId) {
      await sql.unsafe(`DROP TABLE IF EXISTS "uf_${sourceId}"`);
      await db.delete(dataSources).where(eq(dataSources.id, sourceId));
    }
    await db.delete(platformTemplates).where(eq(platformTemplates.platform, "ZZE2E"));
    console.log("已清理 ZZE2E 合成数据");
    await sql.end();
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("❌ FAIL:", e.message);
  process.exit(1);
});
