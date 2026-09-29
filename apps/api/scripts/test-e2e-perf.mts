// ④ 端到端业务流 + 性能：全链路计时(扫描→汇总→导出) + 并发压测。
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });

const API = "http://localhost:4000/api";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD?.trim();
if (!ADMIN_PASSWORD) throw new Error("ADMIN_PASSWORD is required");
async function login(): Promise<string> {
  const r = await fetch(`${API}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD }),
  });
  return (await r.json()).data.token;
}
const now = () => Number(process.hrtime.bigint() / 1000000n);

async function main() {
  const token = await login();
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const auth = { Authorization: `Bearer ${token}` };

  // 当前扫描文件夹
  const folder = (await (await fetch(`${API}/etl/folder`, { headers: auth })).json()).data.folder;
  console.log(`扫描文件夹: ${folder || "(未配置)"}`);

  // 1. 全量扫描（真实文件夹，重导入+重ETL，幂等）
  console.log("\n===== 1. 全链路扫描 =====");
  let t = now();
  const scan = await (await fetch(`${API}/etl/scan`, { method: "POST", headers: H })).json();
  const scanMs = now() - t;
  if (scan.ok) {
    const d = scan.data;
    const rows = (d.platforms || []).reduce((s: number, p: any) => s + (p.total || 0), 0);
    console.log(`扫描 ${d.fileCount} 文件 → ${d.platforms.length} 平台 / ${rows} 订单行 / 维护表 ${d.dict?.rows ?? "?"} 行`);
    console.log(`耗时: ${scanMs}ms (${(scanMs / 1000).toFixed(1)}s)`);
    for (const p of d.platforms) console.log(`  ${p.platform}: ${p.total}行 入${p.inserted} 匹配${p.matchRate}%`);
    if (d.skipped?.length) console.log(`  跳过(未识别): ${d.skipped.join(", ")}`);
  } else console.log(`扫描失败: ${scan.message}`);

  // 2. 汇总查询
  console.log("\n===== 2. 汇总查询 =====");
  t = now();
  const sum = await (await fetch(`${API}/etl/summary`, { headers: auth })).json();
  const sumMs = now() - t;
  console.log(`汇总 ${sumMs}ms — 总 ${sum.data.total} 行，${sum.data.byPlatform.length} 平台，${sum.data.byBrand.length} 品牌`);
  console.log(`  平台销售额: ${sum.data.byPlatform.map((p: any) => `${p.platform}¥${Math.round(p.amount)}`).join(" / ")}`);

  // 3. 导出 Excel
  console.log("\n===== 3. 导出 Excel =====");
  t = now();
  const exp = await fetch(`${API}/etl/export`, { headers: auth });
  const buf = Buffer.from(await exp.arrayBuffer());
  const expMs = now() - t;
  console.log(`导出 ${expMs}ms — 文件 ${(buf.length / 1024).toFixed(0)}KB`);

  // 4. 并发压测：20 路并行汇总查询
  console.log("\n===== 4. 并发压测 (20路并行 summary) =====");
  t = now();
  const tasks = Array.from({ length: 20 }, () => fetch(`${API}/etl/summary`, { headers: auth }).then((r) => r.json()));
  const rs = await Promise.all(tasks);
  const concMs = now() - t;
  const okCount = rs.filter((r) => r.ok).length;
  console.log(`20 路并行: ${concMs}ms 全程，${okCount}/20 成功，均摊 ${(concMs / 20).toFixed(0)}ms/req`);

  // 5. 并发压测：15 路并行表预览(unified_sales 取100行)
  console.log("\n===== 5. 并发压测 (15路并行 preview) =====");
  t = now();
  const tasks2 = Array.from({ length: 15 }, () =>
    fetch(`${API}/board/datasets/preview`, { method: "POST", headers: H, body: JSON.stringify({ queryType: "table", queryText: "unified_sales", limit: 100 }) }).then((r) => r.json()));
  const rs2 = await Promise.all(tasks2);
  const conc2Ms = now() - t;
  console.log(`15 路并行 preview: ${conc2Ms}ms，${rs2.filter((r) => r.ok).length}/15 成功`);

  console.log("\n=== 性能小结 ===");
  console.log(`扫描全链路 ${(scanMs / 1000).toFixed(1)}s | 汇总 ${sumMs}ms | 导出 ${expMs}ms | 20并发 ${concMs}ms`);
  process.exit(0);
}
main().catch((e) => { console.error("crash:", e); process.exit(2); });
