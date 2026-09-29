import jwt from "jsonwebtoken";
import { createMiddleware } from "hono/factory";
import { resolveCurrentAuthUser } from "./current-auth-user.js";

export type AuthPayload = {
  uid: number;
  username: string;
  isAdmin?: boolean; // V0.27：RBAC，admin 才能管用户/外部SQL等敏感操作
  tokenVersion: number;
  exp?: number;
};

const DEFAULT_SECRET = "dev_secret_change_me";
// 生产环境必须显式配置 JWT_SECRET，否则用默认弱密钥可被伪造 token 越权——直接拒绝启动。
if (process.env.NODE_ENV === "production" && (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEFAULT_SECRET)) {
  throw new Error("生产环境必须配置强随机的 JWT_SECRET 环境变量");
}
if (!process.env.JWT_SECRET) {
  console.warn("[auth] 未配置 JWT_SECRET，使用开发默认密钥（仅限本地开发，勿用于生产）");
}

export const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_SECRET;

export function sign(payload: Omit<AuthPayload, "exp">): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

export function verify(token: string): AuthPayload | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (
      typeof payload === "string" ||
      !Number.isSafeInteger(payload.uid) ||
      Number(payload.uid) <= 0 ||
      typeof payload.username !== "string" ||
      payload.username.length === 0 ||
      !Number.isSafeInteger(payload.tokenVersion) ||
      Number(payload.tokenVersion) < 0
    ) {
      return null;
    }
    return payload as AuthPayload;
  } catch {
    return null;
  }
}

export type CurrentAuthUserResolver = (
  payload: AuthPayload,
) => Promise<AuthPayload | null>;

export function createAuthMiddleware(
  resolveUser: CurrentAuthUserResolver = resolveCurrentAuthUser,
) {
  return createMiddleware<{
    Variables: { user: AuthPayload };
  }>(async (c, next) => {
    const auth = c.req.header("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return c.json({ ok: false, message: "未登录" }, 401);
    const payload = verify(token);
    if (!payload) return c.json({ ok: false, message: "登录已过期" }, 401);

    const currentUser = await resolveUser(payload);
    if (!currentUser) {
      return c.json({ ok: false, message: "账号已失效，请重新登录" }, 401);
    }
    c.set("user", currentUser);
    await next();
  });
}

export const authMiddleware = createAuthMiddleware();
