// 阶段1-4 端到端冒烟：CSV 上传 + 分组 + 批量删除 + 出图范围 + AI 分析
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });

const API = "http://localhost:4000/api";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD?.trim();
if (!ADMIN_PASSWORD) throw new Error("ADMIN_PASSWORD is required");
let token = "";
async function login() {
  const r = await fetch(`${API}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD }),
  });
  token = (await r.json()).data.token;
}
const H = () => ({ Authorization: `Bearer ${token}` });

async function uploadCsv(name: string, csv: string, group: string) {
  const fd = new FormData();
  fd.append("file", new Blob([csv], { type: "text/csv" }), `${name}.csv`);
  fd.append("name", name);
  fd.append("group", group);
  const r = await fetch(`${API}/files/upload`, { method: "POST", headers: H(), body: fd });
  return r.json();
}

async function main() {
  await login();
  const results: string[] = [];

  // 1. CSV 上传（中文表头）+ 分组
  const csv = "品牌,价格,月销量\n雅诗兰黛,520,1200\n兰蔻,480,1500\nSK-II,790,800\n薇诺娜,180,3200";
  const u1 = await uploadCsv("ZZCSV面霜A", csv, "ZZ冒烟分组");
  const u2 = await uploadCsv("ZZCSV面霜B", csv, "ZZ冒烟分组");
  results.push(u1.ok && u1.data.rowCount === 4 && u1.data.columns.length === 3
    ? `✅ CSV上传：${u1.data.rowCount}行 ${u1.data.columns.length}列(中文表头)`
    : `❌ CSV上传失败：${JSON.stringify(u1)}`);
  const id1 = u1.data?.sourceId, id2 = u2.data?.sourceId;

  // 2. 预览确认中文列正确
  const prev: any = await (await fetch(`${API}/files/${id1}/preview?limit=2`, { headers: H() })).json();
  const cols = prev.data?.columns?.map((c: any) => c.raw).join(",");
  results.push(cols === "品牌,价格,月销量" ? `✅ 预览中文列正确：${cols}` : `❌ 列异常：${cols}`);

  // 3. 出图按分组范围（应只引用该组的 uf_ 表）
  const chart: any = await (await fetch(`${API}/board/ai-chart`, {
    method: "POST", headers: { ...H(), "Content-Type": "application/json" },
    body: JSON.stringify({ question: "各品牌价格对比", scope: { kind: "group", value: "ZZ冒烟分组" } }),
  })).json();
  const sql = chart.ok ? chart.data.spec.sql : "";
  const refOk = chart.ok && (sql.includes(`uf_${id1}`) || sql.includes(`uf_${id2}`)) && !sql.includes("unified_sales");
  results.push(refOk ? `✅ 出图按分组范围：${chart.data.spec.chartType} 引用了组内表` : `❌ 出图范围异常：${chart.ok ? sql.slice(0,80) : chart.message}`);

  // 4. AI 分析（自定义维度，单文件）
  const ana: any = await (await fetch(`${API}/agents/data_analysis/run`, {
    method: "POST", headers: { ...H(), "Content-Type": "application/json" },
    body: JSON.stringify({ sourceId: id1, mode: "custom", dimensions: "价格梯度,性价比" }),
  })).json();
  const anaOk = ana.ok && (ana.data.outputs?.content?.length ?? 0) > 50;
  results.push(anaOk ? `✅ AI分析(自定义维度)：${ana.data.outputs.content.length}字 ¥${ana.data.costCny}` : `❌ AI分析失败：${ana.message ?? JSON.stringify(ana).slice(0,120)}`);

  // 5. 批量删除（清理本次 CSV）
  const del: any = await (await fetch(`${API}/files/batch-delete`, {
    method: "POST", headers: { ...H(), "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id1, id2] }),
  })).json();
  // 验证物理表已 DROP
  const { sql: pg } = await import("../src/db/client");
  const left = await pg.unsafe(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('uf_${id1}','uf_${id2}')`);
  results.push(del.ok && del.data.deleted === 2 && left.length === 0
    ? `✅ 批量删除：删除 2 个，底层表无残留`
    : `❌ 批量删除异常：del=${JSON.stringify(del)} 残留表=${left.length}`);

  console.log("\n" + results.join("\n"));
  const pass = results.filter((r) => r.startsWith("✅")).length;
  console.log(`\n=== 冒烟：${pass}/${results.length} 通过 ===`);
  await pg.end();
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => { console.error("crash:", e); process.exit(2); });
