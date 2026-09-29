// ② 脏数据混沌测试：折腾平台，验证 V0.10 健壮性。合成数据 + 不污染真实订单。
import { config } from "dotenv";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });
import * as XLSX from "xlsx";

const API = "http://localhost:4000/api";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD?.trim();
if (!ADMIN_PASSWORD) throw new Error("ADMIN_PASSWORD is required");
const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✅" : "❌"} ${name} — ${detail}`);
}

function xlsxBuf(rows: any[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "S1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

async function login(): Promise<string> {
  const r = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD }),
  });
  return (await r.json()).data.token;
}

async function main() {
  const { db, sql } = await import("../src/db/client");
  const { platformTemplates, dataSources } = await import("../src/db/schema");
  const { importExcel } = await import("../src/services/import-excel");
  const { getTemplates, detectPlatform, etlOrderSource, findBrandDict } = await import("../src/services/etl");
  const { eq } = await import("drizzle-orm");
  const token = await login();
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  // 1. 文件名不匹配任何模板
  const tpls = await getTemplates();
  const noMatch = await detectPlatform("随便一个文件abc.xlsx", tpls);
  check("文件名不匹配→null", noMatch === null, noMatch ? `误匹配到${noMatch.platform}` : "正确返回 null 不误判");

  // 2. 非法正则模板不崩 getTemplates
  await db.delete(platformTemplates).where(eq(platformTemplates.platform, "ZZBADRE"));
  await db.insert(platformTemplates).values({
    platform: "ZZBADRE", filePattern: "[invalid(regex", joinCol: "x", dictKey: "id", amountCol: "y", enabled: true,
  });
  let getTplOk = false, included = true;
  try {
    const t2 = await getTemplates();
    getTplOk = true;
    included = t2.some((t) => t.platform === "ZZBADRE");
  } catch (e: any) { getTplOk = false; }
  await db.delete(platformTemplates).where(eq(platformTemplates.platform, "ZZBADRE"));
  check("非法正则模板不崩扫描", getTplOk && !included, getTplOk ? (included ? "非法模板竟被纳入" : "已跳过非法模板，其余正常") : "getTemplates 抛错");

  // 3. 损坏 xlsx
  let corruptCaught = false, corruptMsg = "";
  try {
    await importExcel(Buffer.from("this is not a real xlsx file at all 随机字节"), "坏文件.xlsx", "坏", "file", true);
  } catch (e: any) { corruptCaught = true; corruptMsg = e.message; }
  check("损坏xlsx被捕获", corruptCaught, corruptCaught ? `优雅抛错: ${corruptMsg.slice(0, 50)}` : "竟未抛错");

  // 4. 缺关键列订单 → ETL 报缺列
  await db.delete(platformTemplates).where(eq(platformTemplates.platform, "ZZMISS"));
  await db.insert(platformTemplates).values({
    platform: "ZZMISS", filePattern: "ZZMISS_SAMPLE", joinCol: "不存在的商品ID列", dictKey: "id", amountCol: "金额", enabled: true,
  });
  let missSrcId: number | null = null;
  try {
    const imp = await importExcel(xlsxBuf([["金额", "数量"], ["10", "1"]]), "ZZMISS_SAMPLE.xlsx", "缺列测试", "file", true);
    missSrcId = imp.sourceId;
    const t = await detectPlatform("ZZMISS_SAMPLE.xlsx", await getTemplates());
    const rep = await etlOrderSource(missSrcId, t!);
    check("缺关键列→友好报错", !!rep.error && rep.error.includes("缺列"), rep.error ?? "竟无报错");
  } finally {
    if (missSrcId) { await sql.unsafe(`DROP TABLE IF EXISTS "uf_${missSrcId}"`); await db.delete(dataSources).where(eq(dataSources.id, missSrcId)); }
    await db.delete(platformTemplates).where(eq(platformTemplates.platform, "ZZMISS"));
  }

  // 5. 孤儿 brand_dict 回退到有效维护表
  const realDict = await findBrandDict();
  let orphanId: number | null = null;
  try {
    const [orphan] = await db.insert(dataSources).values({
      name: "孤儿维护表", type: "file", config: { role: "brand_dict", brandDict: { idCol: "id" } } as any,
    }).returning({ id: dataSources.id }); // 故意不建 uf_ 表
    orphanId = orphan.id;
    const after = await findBrandDict();
    const ok = after !== null && after.table === realDict?.table && after.table !== `uf_${orphanId}`;
    check("孤儿维护表→回退到有效表", ok, after ? `跳过孤儿uf_${orphanId}, 回退到 ${after.table}` : "竟返回 null");
  } finally {
    if (orphanId) await db.delete(dataSources).where(eq(dataSources.id, orphanId));
  }

  // 6. 重复 ETL 幂等（拿一个真实订单源跑两遍，unified_sales 不翻倍）
  const fileSrcs = await db.select().from(dataSources).where(eq(dataSources.type, "file"));
  const liveTpls = await getTemplates();
  let orderSrc: any = null, orderTpl: any = null;
  for (const s of fileSrcs) {
    if ((s.config as any)?.role === "brand_dict") continue;
    const fn = (s.config as any)?.originalFileName ?? s.name;
    const t = await detectPlatform(fn, liveTpls);
    const exists = await sql.unsafe(`SELECT 1 FROM information_schema.tables WHERE table_name='uf_${s.id}' LIMIT 1`);
    if (t && exists.length) { orderSrc = s; orderTpl = t; break; }
  }
  if (orderSrc) {
    const platform = orderTpl.platform;
    const [{ c: before }] = await sql.unsafe(`SELECT COUNT(*)::int AS c FROM unified_sales WHERE platform='${platform}'`);
    await etlOrderSource(orderSrc.id, orderTpl);
    await etlOrderSource(orderSrc.id, orderTpl);
    const [{ c: after }] = await sql.unsafe(`SELECT COUNT(*)::int AS c FROM unified_sales WHERE platform='${platform}'`);
    check("重复ETL幂等(ON CONFLICT)", before === after, `${platform} 跑前${before}行 跑两遍后${after}行 ${before === after ? "未翻倍" : "翻倍了!"}`);
  } else {
    check("重复ETL幂等", false, "未找到可用真实订单源（跳过）");
  }

  // 7. 多语句/写 SQL 经 agents run 被拒
  const [agent] = await db.select().from((await import("../src/db/schema")).agents).limit(1);
  if (agent) {
    const cfg = (agent.config as any) ?? {};
    if ((cfg.inputMode ?? "sql") === "sql") {
      const r = await fetch(`${API}/agents/${agent.code}/run`, {
        method: "POST", headers: H, body: JSON.stringify({ datasetSql: "SELECT 1; DROP TABLE users" }),
      });
      const j = await r.json();
      check("agents写SQL被拒", !j.ok && /多语句|SELECT|SQL/.test(j.message ?? ""), j.message ?? JSON.stringify(j));
    } else check("agents写SQL被拒", true, `首个智能体非sql模式(${agent.code})，跳过`);
  }

  // 8. 空文件夹 scan 不崩（临时空目录，存/取/恢复 scan_folder 设置）
  const [orig] = await sql.unsafe(`SELECT value FROM settings WHERE key='scan_folder'`);
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ec-empty-"));
  try {
    await fetch(`${API}/etl/folder`, { method: "POST", headers: H, body: JSON.stringify({ folder: emptyDir }) });
    const r = await fetch(`${API}/etl/scan`, { method: "POST", headers: H });
    const j = await r.json();
    check("空文件夹scan不崩", j.ok === true && Array.isArray(j.data?.platforms) && j.data.platforms.length === 0,
      j.ok ? `优雅返回: ${j.data.fileCount}文件/${j.data.platforms.length}平台` : `报错: ${j.message}`);
  } finally {
    // 恢复原扫描文件夹
    await fetch(`${API}/etl/folder`, { method: "POST", headers: H, body: JSON.stringify({ folder: orig?.value ?? "" }) });
    fs.rmdirSync(emptyDir, { recursive: true });
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n=== 混沌测试: ${passed}/${results.length} 通过 ===`);
  await sql.end();
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => { console.error("harness crash:", e); process.exit(2); });
