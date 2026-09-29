// reload 测试（V0.27：连 API 验证热重载模块配置）
import { describe, it, expect, beforeAll } from "vitest";

const API = process.env.LIVE_API_BASE_URL || "http://localhost:4000";
const ADMIN_PASSWORD = process.env.LIVE_API_ADMIN_PASSWORD?.trim();
let TOKEN: string;

const describeLive = ADMIN_PASSWORD ? describe : describe.skip;

describeLive("真实 API 模块热重载", () => {
  beforeAll(async () => {
    const r = await fetch(`${API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD }),
    });
    const d = await r.json();
    TOKEN = d.data.token;
  });

  describe("POST /api/modules/reload", () => {
    it("热重载返回当前模块列表", async () => {
      const r = await fetch(`${API}/api/modules/reload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const d = await r.json();
      expect(d.ok).toBe(true);
      expect(d.reloaded).toBeGreaterThan(0);
      expect(Array.isArray(d.modules)).toBe(true);
      expect(d.modules).toContain("orders");
      expect(d.modules).not.toContain("shopee_sales");
      expect(d.modules).not.toContain("shopee_ads");
    }, 20000);
  });

  describe("GET /api/modules", () => {
    it("列出模块且不包含已退役模块", async () => {
      const r = await fetch(`${API}/api/modules`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const d = await r.json();
      expect(d.ok).toBe(true);
      expect(d.data.length).toBeGreaterThan(0);
      expect(
        d.data.some((m: any) =>
          ["shopee_sales", "shopee_ads"].includes(m.code),
        ),
      ).toBe(false);
    });
  });
});
