// scripts/test-llm.ts
// 验证 DeepSeek V4 调通（pnpm tsx scripts/test-llm.ts）
import { config } from "dotenv";
import path from "node:path";
config({ path: path.resolve(process.cwd(), "../../.env") });

import { chat } from "../src/services/llm";

(async () => {
  console.log("→ DeepSeek V4 flash 测试");
  const r1 = await chat(
    [{ role: "user", content: "用一句话回答：你是哪个版本的 DeepSeek？" }],
    { tier: "flash", maxTokens: 200 },
  );
  console.log("content:", r1.content);
  console.log("reasoning:", r1.reasoning?.slice(0, 100), "...");
  console.log("usage:", r1.usage);
  console.log("");

  console.log("→ DeepSeek V4 pro 测试");
  const r2 = await chat(
    [{ role: "user", content: "5 个 SKU 的售价分别是 199 / 299 / 159 / 399 / 89，给一句话定价洞察。" }],
    { tier: "pro", maxTokens: 500 },
  );
  console.log("content:", r2.content);
  console.log("usage:", r2.usage);
  process.exit(0);
})();
