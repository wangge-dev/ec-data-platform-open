// ③ AI 能力质量实测：AI 出图(NL→SQL) + 三智能体，喂真实业务问题，看准确率/合理性/成本。
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

async function main() {
  const token = await login();
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  // ===== A. AI 出图：6 个真实业务问题 =====
  const questions = [
    "各品牌的销售额对比",
    "各平台销售额占比",
    "每个月的销售额趋势",
    "销售额排名前十的运营",
    "销售额最高的5个店铺",
    "各品类的销售总额对比",
  ];
  console.log("===== A. AI 出图 NL→SQL =====");
  let totalCost = 0, aiPass = 0;
  for (const q of questions) {
    const t0 = Date.now();
    const r = await fetch(`${API}/board/ai-chart`, { method: "POST", headers: H, body: JSON.stringify({ question: q }) });
    const j = await r.json();
    const ms = Date.now() - t0;
    if (j.ok) {
      aiPass++;
      totalCost += Number(j.data.costCny || 0);
      const sql1 = (j.data.spec.sql || "").replace(/\s+/g, " ").slice(0, 90);
      console.log(`\n❓ ${q}`);
      console.log(`   图型=${j.data.spec.chartType} x=${j.data.spec.xField} y=${j.data.spec.yFields.join(",")} 行数=${j.data.rows.length} ${ms}ms ¥${j.data.costCny}`);
      console.log(`   SQL: ${sql1}...`);
      console.log(`   对齐: ${j.data.warning ? "⚠️ " + j.data.warning : "✅ 字段对齐"}`);
      // 抽样首行结果
      if (j.data.rows[0]) console.log(`   首行: ${JSON.stringify(j.data.rows[0]).slice(0, 120)}`);
    } else {
      console.log(`\n❓ ${q}\n   ❌ 失败: ${j.message} ${ms}ms`);
    }
  }
  console.log(`\nAI 出图: ${aiPass}/${questions.length} 成功，合计 ¥${totalCost.toFixed(4)}`);

  // ===== B. 三智能体 =====
  console.log("\n\n===== B. 智能体 =====");
  const agents = (await (await fetch(`${API}/agents`, { headers: H })).json()).data as any[];
  console.log(`已注册 ${agents.length} 个: ${agents.map((a) => a.code).join(", ")}`);

  const inputs: Record<string, any> = {
    // sql 模式（竞品）：喂 unified_sales 各品牌销售汇总
    competitor: { datasetSql: "SELECT brand, COUNT(*) AS orders, ROUND(SUM(amount::numeric),2) AS sales, ROUND(AVG(amount::numeric),2) AS avg_price FROM unified_sales WHERE brand IS NOT NULL GROUP BY brand ORDER BY sales DESC LIMIT 8" },
    // text 模式
    detail_page_copy: { inputText: "为一款女性私护洁阴洗液写电商详情页文案，主打温和无刺激、弱酸性配方、植物成分，目标人群25-40岁women。" },
    cs_script: { inputText: "顾客咨询：你们这个私护洗液孕妇能用吗？会不会有副作用？请给出专业、安抚的客服回复话术。" },
  };

  for (const a of agents) {
    const inp = inputs[a.code];
    if (!inp) { console.log(`\n🤖 ${a.code}: 无预设输入，跳过`); continue; }
    const t0 = Date.now();
    const r = await fetch(`${API}/agents/${a.code}/run`, { method: "POST", headers: H, body: JSON.stringify(inp) });
    const j = await r.json();
    const ms = Date.now() - t0;
    if (j.ok) {
      const out = j.data.outputs?.content || "";
      console.log(`\n🤖 ${a.code} (${a.name}) — ✅ ${ms}ms ¥${j.data.costCny} 输出${out.length}字`);
      console.log(`   预览: ${out.replace(/\n+/g, " ").slice(0, 200)}...`);
    } else {
      console.log(`\n🤖 ${a.code} — ❌ ${j.message} ${ms}ms`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error("crash:", e); process.exit(2); });
