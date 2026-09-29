// 简易 cron 下次触发时间计算（5 字段：分 时 日 月 周）
// 仅用于前端展示"下次跑"。生产语义以后端 node-cron 为准。
// 支持：* / */N / N / N-M / N,M
type Field = { values: Set<number> };

function parseField(expr: string, min: number, max: number): Field {
  const out = new Set<number>();
  for (const part of expr.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) out.add(i);
      continue;
    }
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    let base = part;
    let step = 1;
    if (stepMatch) {
      base = stepMatch[1];
      step = parseInt(stepMatch[2], 10);
    }
    let lo = min;
    let hi = max;
    if (base === "*") {
      // nothing
    } else if (base.includes("-")) {
      const [a, b] = base.split("-").map((s) => parseInt(s, 10));
      lo = a;
      hi = b;
    } else {
      const v = parseInt(base, 10);
      lo = v;
      hi = v;
    }
    for (let i = lo; i <= hi; i += step) out.add(i);
  }
  return { values: out };
}

export function nextCronTime(expr: string, from = new Date()): Date | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  try {
    const minute = parseField(parts[0], 0, 59);
    const hour = parseField(parts[1], 0, 23);
    const dom = parseField(parts[2], 1, 31);
    const month = parseField(parts[3], 1, 12);
    const dow = parseField(parts[4], 0, 6); // 0=Sun

    // 从 from + 1 分钟开始，最多扫 4 年的分钟（防死循环）
    const start = new Date(from.getTime() + 60_000);
    start.setSeconds(0, 0);
    const MAX = 60 * 24 * 366 * 4;
    const cur = new Date(start);
    for (let i = 0; i < MAX; i++) {
      if (
        minute.values.has(cur.getMinutes()) &&
        hour.values.has(cur.getHours()) &&
        dom.values.has(cur.getDate()) &&
        month.values.has(cur.getMonth() + 1) &&
        dow.values.has(cur.getDay())
      ) {
        return cur;
      }
      cur.setMinutes(cur.getMinutes() + 1);
    }
    return null;
  } catch {
    return null;
  }
}

export function humanCron(expr: string): string {
  if (!expr) return "";
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [m, h, dom, mon, dow] = parts;
  // 一些常见模式给人话
  if (expr === "* * * * *") return "每分钟";
  if (m.startsWith("*/") && h === "*" && dom === "*" && mon === "*" && dow === "*")
    return `每 ${m.slice(2)} 分钟`;
  if (h.startsWith("*/") && m === "0" && dom === "*" && mon === "*" && dow === "*")
    return `每 ${h.slice(2)} 小时整点`;
  if (m === "0" && h === "*" && dom === "*" && mon === "*" && dow === "*")
    return "每小时整点";
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === "*" && mon === "*" && dow === "*")
    return `每天 ${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  return expr;
}
