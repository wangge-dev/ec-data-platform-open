// scripts/seed.ts — 初始化数据（admin 用户 + 预置智能体）
import { config } from "dotenv";
import path from "node:path";
config({ path: path.resolve(process.cwd(), "../../.env") });

import bcrypt from "bcryptjs";
import { db, sql } from "../src/db/client";
import { users, agents, platformTemplates } from "../src/db/schema";
import { DEFAULT_TEMPLATES } from "../src/services/etl";
import { eq } from "drizzle-orm";

type AgentSeed = {
  code: string;
  name: string;
  description: string;
  promptTemplate: string;
  model: string;
  config: Record<string, any>;
};

const AGENT_SEEDS: AgentSeed[] = [
  {
    code: "competitor_analysis",
    name: "竞品分析",
    description: "读取已上传的竞品标题、价格、评论摘要和卖点数据，输出差异化分析报告",
    promptTemplate: `你是电商竞品分析专家。给你 N 个竞品 SKU 的结构化数据（标题/价格/评论摘要/卖点关键词），请输出：
1. 价格梯度分析（最低/中位/最高 + 我方建议价位）
2. 卖点矩阵（每家强调什么差异点）
3. 评论痛点提炼（高频负面关键词）
4. 一句话差异化建议

输出 markdown 格式。`,
    model: "deepseek-v4-flash",
    config: { inputMode: "analysis", maxTokens: 4096, temperature: 0.4 },
  },
  {
    code: "detail_page_copy",
    name: "详情页文案",
    description: "输入产品卖点 brief，产出可直接落地的详情页文案结构",
    promptTemplate: `你是资深电商详情页文案策划。用户会给你一段产品 brief（品名、核心卖点、规格、目标人群、价格带、平台）。请产出一套完整的详情页文案，结构如下：

1. **主标题 + 副标题**（3 组备选，突出最强卖点，不超过 20 字）
2. **痛点切入**（场景化描述用户痛点，2-3 句）
3. **核心卖点展开**（3-5 个卖点，每个：卖点标题 + 利益点说明 + 支撑证据/参数）
4. **信任背书**（资质/检测/销量/口碑的呈现建议）
5. **使用场景 / 适用人群**
6. **行动号召（CTA）**（结合平台促销话术）

要求：
- 文案口语化、有画面感，避免空洞形容词堆砌
- 合规：保健/医疗器械类不得出现疗效承诺、绝对化用语（最、第一、根治等）
- 输出 markdown 格式，可直接交付给美工排版`,
    model: "deepseek-v4-flash",
    config: { inputMode: "text", maxTokens: 4096, temperature: 0.6 },
  },
  {
    code: "cs_script",
    name: "客服话术",
    description: "输入咨询/客诉场景，产出标准客服应对话术包",
    promptTemplate: `你是电商金牌客服主管，负责沉淀标准话术。用户会描述一个客服场景（咨询类型、产品、客户情绪、具体问题）。请产出一套可直接复制使用的话术包：

1. **场景判断**（一句话定位这是售前咨询 / 售后处理 / 退换货 / 投诉应对中的哪类）
2. **首次响应话术**（亲切、专业、给安全感，含称呼）
3. **核心应对话术**（针对问题给 2-3 个分支应答，覆盖客户可能的不同反应）
4. **安抚 / 挽留话术**（情绪激动或要退货时使用）
5. **收尾话术 + 转化引导**（引导好评 / 关注店铺 / 二次购买）
6. **禁忌提醒**（这个场景下绝对不能说的话）

要求：
- 话术口语化、可直接发给客户，控制每句长度便于复制
- 语气符合平台调性，不卑不亢
- 输出 markdown 格式`,
    model: "deepseek-v4-flash",
    config: { inputMode: "text", maxTokens: 3072, temperature: 0.5 },
  },
  {
    code: "data_analysis",
    name: "数据分析",
    description: "针对某个上传文件/分组做分析，可自定义维度或让 AI 自动分析，产出洞察报告",
    promptTemplate: `你是资深电商数据分析师。用户会给你一份或多份上传表格的列结构与采样数据（JSON）。请基于这些真实数据做分析，输出一份结构化的 markdown 报告：

- 用数据说话，引用具体数值/占比，不要泛泛而谈；采样数据有限时说明这是基于样本的推断
- 发现异常、机会点、风险，并给出可执行的改进建议
- 报告结构清晰（用 ## 小标题 + 列表/表格），结论先行

如果用户指定了分析维度，请严格围绕这些维度展开；如果没有指定，由你判断这份电商数据最值得看的维度（如价格分布、卖点、销量结构、匹配缺口、改进建议等）。`,
    model: "deepseek-v4-flash",
    config: { inputMode: "analysis", maxTokens: 4096, temperature: 0.5 },
  },
];

async function main() {
  const adminPassword = process.env.ADMIN_PASSWORD?.trim();
  if (!adminPassword) throw new Error("ADMIN_PASSWORD is required");
  console.log("→ 创建默认 admin 用户");
  const [exists] = await db.select().from(users).where(eq(users.username, "admin")).limit(1);
  if (exists) {
    console.log("  已存在，跳过");
  } else {
    const hash = await bcrypt.hash(adminPassword, 10);
    await db.insert(users).values({
      username: "admin",
      passwordHash: hash,
      displayName: "管理员",
      isAdmin: true, // 默认 admin 必须是管理员，否则 RBAC 下管不了用户/外部SQL
    });
    console.log("  ✓ 创建成功");
  }

  console.log("→ 预置智能体");
  for (const a of AGENT_SEEDS) {
    const [found] = await db.select().from(agents).where(eq(agents.code, a.code)).limit(1);
    if (found) {
      // 幂等更新 config / prompt，保证已存在的 competitor 也补上 inputMode
      await db
        .update(agents)
        .set({ promptTemplate: a.promptTemplate, config: a.config, description: a.description })
        .where(eq(agents.code, a.code));
      console.log(`  ↻ ${a.name}（${a.code}）已更新`);
    } else {
      await db.insert(agents).values(a);
      console.log(`  ✓ ${a.name}（${a.code}）已创建`);
    }
  }

  console.log("→ 预置平台模板（多平台订单 ETL 识别+列映射规则）");
  for (const t of DEFAULT_TEMPLATES) {
    const [found] = await db
      .select()
      .from(platformTemplates)
      .where(eq(platformTemplates.platform, t.platform))
      .limit(1);
    if (found) {
      console.log(`  ↻ ${t.platform} 已存在，跳过`);
      continue;
    }
    await db.insert(platformTemplates).values({
      platform: t.platform,
      filePattern: t.filePattern.source,
      patternFlags: t.filePattern.flags || "i",
      joinCol: t.joinCol,
      dictKey: t.dictKey,
      amountCol: t.amountCol,
      qtyCol: t.qtyCol || null,
      payTimeCol: t.payTimeCol || null,
      orderTimeCol: t.orderTimeCol || null,
      mainOrderCol: t.mainOrderCol || null,
      rowKeyCol: t.rowKeyCol || null,
      enabled: true,
      updatedAt: new Date(),
    });
    console.log(`  ✓ ${t.platform} 已创建`);
  }

  console.log("→ 完成");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
