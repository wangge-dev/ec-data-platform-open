import { Hono } from "hono";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";

import { db } from "../db/client";
import { users } from "../db/schema";
import { sign, verify } from "../lib/auth";
import { resolveCurrentAuthUser } from "../lib/current-auth-user";

const auth = new Hono();

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});

auth.post("/login", zValidator("json", loginSchema), async (c) => {
  const { username, password } = c.req.valid("json");
  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (!user) return c.json({ ok: false, message: "用户名或密码错误" }, 401);
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return c.json({ ok: false, message: "用户名或密码错误" }, 401);
  const token = sign({
    uid: user.id,
    username: user.username,
    isAdmin: user.isAdmin,
    tokenVersion: user.tokenVersion,
  });
  return c.json({
    ok: true,
    data: {
      token,
      user: { id: user.id, username: user.username, displayName: user.displayName, isAdmin: user.isAdmin },
    },
  });
});

auth.get("/me", async (c) => {
  const authHeader = c.req.header("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return c.json({ ok: false, message: "未登录" }, 401);
  const payload = verify(token);
  if (!payload) return c.json({ ok: false, message: "登录已过期" }, 401);
  const currentUser = await resolveCurrentAuthUser(payload);
  if (!currentUser) return c.json({ ok: false, message: "账号已失效，请重新登录" }, 401);
  const [user] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, currentUser.uid))
    .limit(1);
  if (!user) return c.json({ ok: false, message: "账号已失效，请重新登录" }, 401);
  return c.json({
    ok: true,
    data: {
      id: currentUser.uid,
      username: currentUser.username,
      displayName: user.displayName,
      isAdmin: currentUser.isAdmin,
    },
  });
});

export default auth;
