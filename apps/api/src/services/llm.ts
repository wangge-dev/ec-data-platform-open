import OpenAI from "openai";

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY missing in env");
  _client = new OpenAI({
    apiKey,
    baseURL: "https://api.deepseek.com/v1",
    // OpenAI SDK 默认 10 分钟超时；这里收紧到 2 分 50 秒（170s），
    // 比前端 apiLong 的 180s 稍短，确保是后端先抛错而不是前端无响应
    timeout: 170_000,
    maxRetries: 1, // 网络抖动时重试 1 次，超时不重试（会重复扣费）
  });
  return _client;
}

export type ModelTier = "flash" | "pro";

const MODEL_MAP: Record<ModelTier, string> = {
  flash: "deepseek-v4-flash",
  pro: "deepseek-v4-pro",
};

export async function chat(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  opts: {
    tier?: ModelTier;
    maxTokens?: number;
    temperature?: number;
    jsonMode?: boolean;
    timeoutMs?: number; // 单次请求自定义超时（默认 170s）
  } = {},
) {
  const { tier = "flash", maxTokens = 4096, temperature = 0.3, jsonMode = false, timeoutMs = 170_000 } = opts;

  // AbortSignal 双保险：到时间强制断开，避免 SDK 自身超时机制失效
  const ctrl = new AbortController();
  const abortTimer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await getClient().chat.completions.create(
      {
        model: MODEL_MAP[tier],
        messages,
        max_tokens: maxTokens,
        temperature,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      },
      { signal: ctrl.signal, timeout: timeoutMs },
    );
    const msg = res.choices[0].message as any;
    return {
      content: msg.content as string,
      reasoning: (msg.reasoning_content as string | undefined) ?? null,
      usage: res.usage,
    };
  } catch (e: any) {
    // 把超时/中断错误转成业务友好的提示
    if (e?.name === "AbortError" || e?.code === "ETIMEDOUT" || /timeout/i.test(e?.message ?? "")) {
      throw new Error(`AI 模型响应超时（>${Math.round(timeoutMs / 1000)}s），请减少输入数据量或换 flash 档位`);
    }
    throw e;
  } finally {
    clearTimeout(abortTimer);
  }
}
