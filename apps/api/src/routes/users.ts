// 用户管理：多用户登录（数据共享，非多租户隔离）——让同事能各自登录使用
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, sql as dsql } from "drizzle-orm";

import { db } from "../db/client";
import { users } from "../db/schema";
import { authMiddleware } from "../lib/auth";

const r = new Hono<{ Variables: { user: { uid: number; username: string; isAdmin?: boolean } } }>();
r.use("*", authMiddleware);

const SALT_ROUNDS = 10;

// V0.27 RBAC：写操作（新建/改/删用户）限 admin。读（列表）所有登录用户可用——看同事是谁
const adminGuard = createMiddleware(async (c, next) => {
  const u = c.get("user");
  if (!u?.isAdmin) return c.json({ ok: false, message: "需要管理员权限" }, 403);
  await next();
});

// 列出全部用户（不含 password_hash）
r.get("/", async (c) => {
  const list = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      isAdmin: users.isAdmin,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(users.id);
  return c.json({ ok: true, data: list });
});

const createSchema = z.object({
  username: z
    .string()
    .min(2, "用户名至少 2 位")
    .max(64)
    .regex(/^[A-Za-z0-9_.-]+$/, "用户名只能是字母/数字/_.-"),
  password: z.string().min(6, "密码至少 6 位").max(128),
  displayName: z.string().max(64).optional(),
});

// 新建用户（admin only）
r.post("/", adminGuard, zValidator("json", createSchema), async (c) => {
  const { username, password, displayName } = c.req.valid("json");
  const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
  if (exists) return c.json({ ok: false, message: "用户名已存在" }, 409);
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const [created] = await db
    .insert(users)
    .values({ username, passwordHash, displayName: displayName || username })
    .returning({ id: users.id, username: users.username, displayName: users.displayName });
  return c.json({ ok: true, data: created }, 201);
});

const updateSchema = z
  .object({
    displayName: z.string().max(64).optional(),
    password: z.string().min(6, "密码至少 6 位").max(128).optional(),
  })
  .refine((v) => v.displayName !== undefined || v.password !== undefined, {
    message: "无可更新字段",
  });

// 更新昵称 / 重置密码（admin only）
r.patch("/:id{[0-9]+}", adminGuard, zValidator("json", updateSchema), async (c) => {
  const id = Number(c.req.param("id"));
  const { displayName, password } = c.req.valid("json");
  const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
  if (!target) return c.json({ ok: false, message: "用户不存在" }, 404);

  const patch: {
    displayName?: string;
    passwordHash?: string;
    tokenVersion?: ReturnType<typeof dsql>;
  } = {};
  if (displayName !== undefined) patch.displayName = displayName;
  if (password !== undefined) {
    patch.passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    // 密码与版本号在同一条 UPDATE 中提交，任何已签发的旧 JWT 会在下一请求立即失效。
    patch.tokenVersion = dsql`${users.tokenVersion} + 1`;
  }

  const [updated] = await db
    .update(users)
    .set(patch)
    .where(eq(users.id, id))
    .returning({ id: users.id, username: users.username, displayName: users.displayName });
  return c.json({ ok: true, data: updated });
});

// 删除用户（admin only；禁止删自己；禁止删到一个不剩）
r.delete("/:id{[0-9]+}", adminGuard, async (c) => {
  const id = Number(c.req.param("id"));
  const me = c.get("user");
  if (id === me.uid) return c.json({ ok: false, message: "不能删除当前登录的自己" }, 400);

  const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
  if (!target) return c.json({ ok: false, message: "用户不存在" }, 404);

  const [{ count }] = await db.select({ count: dsql<number>`count(*)::int` }).from(users);
  if (count <= 1) return c.json({ ok: false, message: "至少保留一个用户" }, 400);

  await db.delete(users).where(eq(users.id, id));
  return c.json({ ok: true });
});

export default r;
