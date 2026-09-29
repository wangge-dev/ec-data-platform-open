import { createMiddleware } from "hono/factory";
import type { AuthPayload } from "./auth.js";

export const adminGuard = createMiddleware<{
  Variables: { user: AuthPayload };
}>(async (c, next) => {
  if (!c.get("user")?.isAdmin) {
    return c.json({ ok: false, message: "需要管理员权限" }, 403);
  }
  await next();
});
