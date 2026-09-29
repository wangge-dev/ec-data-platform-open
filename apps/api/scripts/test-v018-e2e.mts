// V0.18 E - 端到端验证 inventory/cost/ads 三模块
// 直接造 Excel buffer 调 importExcel + runModuleEtl，跑完看汇总数据是否正常
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });

import * as XLSX from "xlsx";
import { sql } from "../src/db/client.js";
import { importExcel } from "../src/services/import-excel.js";
import { runModuleEtl } from "../src/modules/engine.js";

function makeBuf(rows: Record<string, any>[]): Buffer {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function clearTable(name: string) {
  try {
    await sql.unsafe(`TRUNCATE "${name}"`);
    console.log(`  清空表 ${name}`);
  } catch {}
}

console.log("=== V0.18 三模块端到端验证 ===\n");

// ============== E1: Inventory（默认行映射 + computed is_low_stock + JOIN brand_dict）==============
console.log("== E1: Inventory ==");
await clearTable("unified_inventory");
const invRows = [
  { "商品编码": "SKU-001", "商品名称": "毛巾", "可用库存数": 5, "盘点日期": "2026-06-20" },
  { "商品编码": "SKU-002", "商品名称": "牙刷", "可用库存数": 35, "盘点日期": "2026-06-20" },
  { "商品编码": "SKU-003", "商品名称": "牙膏", "可用库存数": 2, "盘点日期": "2026-06-20" },
  { "商品编码": "SKU-004", "商品名称": "洗发水", "可用库存数": 120, "盘点日期": "2026-06-20" },
  { "商品编码": "SKU-005", "商品名称": "沐浴露", "可用库存数": 8, "盘点日期": "2026-06-20" },
];
const invName = "A仓库存_20260620.xlsx";
const invBuf = makeBuf(invRows);
const invImp = await importExcel(invBuf, invName, `A仓库存 · ${invName}`, "file", true);
console.log(`  imported uf_${invImp.sourceId}: ${invImp.rowCount} 行`);
const invReport = await runModuleEtl(invImp.sourceId);
console.log(`  ETL: platform=${invReport?.platform} inserted=${invReport?.inserted} matched=${invReport?.matched}`);
const invStats = await sql.unsafe(
  `SELECT COUNT(*)::int AS total,
          SUM(CASE WHEN is_low_stock THEN 1 ELSE 0 END)::int AS low
   FROM unified_inventory`,
);
console.log(`  unified_inventory total=${invStats[0].total} low_stock=${invStats[0].low}`);
const invSamples = await sql.unsafe(
  `SELECT product_id, product_name, stock_qty, warehouse, is_low_stock
   FROM unified_inventory ORDER BY stock_qty LIMIT 5`,
);
for (const r of invSamples) {
  console.log(`    ${r.product_id} ${r.product_name}: 库存=${r.stock_qty} 仓库=${r.warehouse} 低库存=${r.is_low_stock}`);
}

// ============== E2: Cost（computed total_cost）==============
console.log("\n== E2: Cost ==");
await clearTable("unified_cost");
const costRows = [
  { "SKU": "SKU-001", "采购成本": 3.5, "物流成本": 0.8, "包装成本": 0.5, "月份": "2026-06-01" },
  { "SKU": "SKU-002", "采购成本": 2.0, "物流成本": 0.5, "包装成本": 0.3, "月份": "2026-06-01" },
  { "SKU": "SKU-003", "采购成本": 4.0, "物流成本": 1.0, "包装成本": 0.6, "月份": "2026-06-01" },
  { "SKU": "SKU-004", "采购成本": 15.0, "物流成本": 2.0, "包装成本": 1.5, "月份": "2026-06-01" },
  { "SKU": "SKU-005", "采购成本": 18.0, "物流成本": 2.5, "包装成本": 1.8, "月份": "2026-06-01" },
];
const costName = "成本_202606.xlsx";
const costImp = await importExcel(makeBuf(costRows), costName, `成本表 · ${costName}`, "file", true);
console.log(`  imported uf_${costImp.sourceId}: ${costImp.rowCount} 行`);
const costReport = await runModuleEtl(costImp.sourceId);
console.log(`  ETL: platform=${costReport?.platform} inserted=${costReport?.inserted}`);
const costSamples = await sql.unsafe(
  `SELECT sku, purchase_cost, logistics_cost, package_cost, total_cost, snapshot_month
   FROM unified_cost ORDER BY sku LIMIT 5`,
);
for (const r of costSamples) {
  console.log(`    ${r.sku}: 采购=${r.purchase_cost} 物流=${r.logistics_cost} 包装=${r.package_cost} → 总成本=${r.total_cost} 月=${r.snapshot_month?.toISOString?.()?.slice(0,10) ?? r.snapshot_month}`);
}

// ============== E3: Ads（computed CTR/CPC + JOIN shop_pic_dict）==============
console.log("\n== E3: Ads ==");
await clearTable("unified_ads");
// 先导入 shop_pic_dict 字典表
const picDictRows = [
  { "店铺ID": "SHOP-A", "店铺名称": "A店铺", "运营负责人": "小明" },
  { "店铺ID": "SHOP-B", "店铺名称": "B店铺", "运营负责人": "小红" },
  { "店铺ID": "SHOP-C", "店铺名称": "C店铺", "运营负责人": "小蓝" },
];
const picName = "店铺PIC维护表.xlsx";
// 注意 role 标 shop_pic_dict，但 importExcel 只支持 brand_dict 角色。看下能不能直接用 brand_dict 走通
// 实际上 default-transform.findDictByRole 是通用的，我们让 importExcel 接受任意 role
console.log("  上传 shop_pic_dict 字典（先尝试 brand_dict role 兼容写法）");
// V0.18 importExcel role 只接 'file' | 'brand_dict'，先用 brand_dict（虽然不是品牌字典）做兼容
// 真正生产需要扩 importExcel role 类型——这里跳过 JOIN 直接验证默认行映射
const picImp = await importExcel(makeBuf(picDictRows), picName, `店铺PIC · ${picName}`, "file", true);
console.log(`  imported uf_${picImp.sourceId} (role=file, JOIN 跳过)`);
// 直接 UPDATE config 把 role 改成 shop_pic_dict
await sql.unsafe(
  `UPDATE data_sources
   SET config = config || jsonb_build_object('role', 'shop_pic_dict')
   WHERE id = $1`,
  [picImp.sourceId],
);
console.log("  ✓ 已手动改 role=shop_pic_dict");

// 上传 ads 数据
const adsRows = [
  { "店铺ID": "SHOP-A", "店铺名称": "A店铺", "日期": "2026-06-19", "广告花费": 1000, "曝光": 100000, "点击": 1500, "订单": 30, "ROAS": 5.2 },
  { "店铺ID": "SHOP-A", "店铺名称": "A店铺", "日期": "2026-06-20", "广告花费": 1200, "曝光": 110000, "点击": 1700, "订单": 35, "ROAS": 5.5 },
  { "店铺ID": "SHOP-B", "店铺名称": "B店铺", "日期": "2026-06-19", "广告花费": 800, "曝光": 80000, "点击": 1000, "订单": 20, "ROAS": 4.0 },
  { "店铺ID": "SHOP-B", "店铺名称": "B店铺", "日期": "2026-06-20", "广告花费": 900, "曝光": 85000, "点击": 1100, "订单": 22, "ROAS": 4.2 },
  { "店铺ID": "SHOP-C", "店铺名称": "C店铺", "日期": "2026-06-20", "广告花费": 500, "曝光": 50000, "点击": 600, "订单": 12, "ROAS": 3.8 },
];
const adsName = "tiktok_ads_20260620.xlsx";
const adsImp = await importExcel(makeBuf(adsRows), adsName, `TikTok广告 · ${adsName}`, "file", true);
console.log(`  imported uf_${adsImp.sourceId}: ${adsImp.rowCount} 行`);
const adsReport = await runModuleEtl(adsImp.sourceId);
console.log(`  ETL: platform=${adsReport?.platform} inserted=${adsReport?.inserted} matched=${adsReport?.matched}`);
const adsSamples = await sql.unsafe(
  `SELECT shop_id, shop_name, ad_date, ads_spend, impressions, clicks,
          ROUND(ctr::numeric, 4) AS ctr,
          ROUND(cpc::numeric, 4) AS cpc,
          pic
   FROM unified_ads ORDER BY ad_date, shop_id LIMIT 10`,
);
for (const r of adsSamples) {
  const d = r.ad_date?.toISOString?.()?.slice(0,10) ?? r.ad_date;
  console.log(`    ${d} ${r.shop_id}: 花费=${r.ads_spend} 曝光=${r.impressions} 点击=${r.clicks} CTR=${r.ctr} CPC=${r.cpc} PIC=${r.pic ?? "(未关联)"}`);
}

// ============== 4. 汇总检查 ==============
console.log("\n== 4. 各模块统一表概况 ==");
const tables = ["unified_sales", "unified_inventory", "unified_cost", "unified_ads"];
for (const t of tables) {
  try {
    const [{ n }] = await sql.unsafe(`SELECT COUNT(*)::int AS n FROM "${t}"`);
    console.log(`  ${t}: ${n} 行`);
  } catch (e: any) {
    console.log(`  ${t}: 不存在`);
  }
}

await sql.end();
console.log("\n=== 完成 ===");
process.exit(0);
