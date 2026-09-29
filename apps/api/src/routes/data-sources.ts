import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, desc } from "drizzle-orm";

import { db, sql } from "../db/client";
import { dataSources } from "../db/schema";
import { authMiddleware, type AuthPayload } from "../lib/auth";
import { adminGuard } from "../lib/admin-guard";
import {
  DataSourceDeleteBlockedError,
  assertDataSourceNotReferencedByPublishedVersion,
} from "../services/import-excel";

const r = new Hono<{ Variables: { user: AuthPayload } }>();
r.use("*", authMiddleware);

const userWritableConfigSchema = z.record(z.any()).superRefine((config, ctx) => {
  if (Object.prototype.hasOwnProperty.call(config, "frontProfitValidation")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "frontProfitValidation is server-managed and cannot be supplied",
    });
  }
});

export const dataSourceMutationSchema = z.object({
  name: z.string().min(1).max(128),
  // File sources own dynamic tables, datasets and derived rows, while external
  // SQL sources contain privileged connection details. Those types are managed
  // only by their dedicated routes. Generic CRUD is limited to shop accounts.
  type: z.literal("shop_account"),
  platform: z.string().max(32).nullable().optional(),
  config: userWritableConfigSchema,
  status: z.enum(["active", "disabled"]).optional(),
});

r.get("/", async (c) => {
  const list = await db.select().from(dataSources).orderBy(desc(dataSources.createdAt));
  const visible = c.get("user").isAdmin
    ? list
    : list.filter((source) => source.type !== "external_sql");
  const isAdmin = c.get("user").isAdmin;
  // Connection/account configuration is operational metadata, not shared
  // analytics data.  Ordinary users may discover visible source records but
  // never receive arbitrary config keys; administrators still get a recursively
  // redacted view.
  const safe = visible.map((d) => ({
    ...d,
    config: isAdmin ? maskSecrets(d.config as Record<string, any>) : {},
  }));
  return c.json({ ok: true, data: safe });
});

r.get("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const [item] = await db.select().from(dataSources).where(eq(dataSources.id, id)).limit(1);
  if (!item || (item.type === "external_sql" && !c.get("user").isAdmin)) {
    return c.json({ ok: false, message: "数据源不存在" }, 404);
  }
  return c.json({
    ok: true,
    data: {
      ...item,
      config: c.get("user").isAdmin
        ? maskSecrets(item.config as Record<string, any>)
        : {},
    },
  });
});

r.post("/", adminGuard, zValidator("json", dataSourceMutationSchema), async (c) => {
  const body = c.req.valid("json");
  const [created] = await db
    .insert(dataSources)
    .values({
      name: body.name,
      type: body.type,
      platform: body.platform ?? null,
      config: body.config,
      status: body.status ?? "active",
    })
    .returning();
  return c.json({
    ok: true,
    data: { ...created, config: maskSecrets(created.config as Record<string, any>) },
  }, 201);
});

r.put("/:id{[0-9]+}", adminGuard, zValidator("json", dataSourceMutationSchema.partial()), async (c) => {
  const id = Number(c.req.param("id"));
  const body = c.req.valid("json");
  const [existing] = await db.select().from(dataSources).where(eq(dataSources.id, id)).limit(1);
  if (!existing) return c.json({ ok: false, message: "数据源不存在" }, 404);
  if (existing.type === "file" || existing.type === "external_sql") {
    return c.json({
      ok: false,
      message: "文件数据源由文件上传入口管理，不能通过通用接口修改",
    }, 409);
  }
  const [updated] = await db
    .update(dataSources)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(dataSources.id, id))
    .returning();
  if (!updated) return c.json({ ok: false, message: "数据源不存在" }, 404);
  return c.json({
    ok: true,
    data: { ...updated, config: maskSecrets(updated.config as Record<string, any>) },
  });
});

r.delete("/:id{[0-9]+}", adminGuard, async (c) => {
  const id = Number(c.req.param("id"));
  const [existing] = await db.select().from(dataSources).where(eq(dataSources.id, id)).limit(1);
  if (!existing) return c.json({ ok: false, message: "数据源不存在" }, 404);
  if (existing.type === "file" || existing.type === "external_sql") {
    return c.json({
      ok: false,
      message: "文件数据源必须从文件入口删除，以保证级联清理完整",
    }, 409);
  }
  let deleted: any[] = [];
  try {
    await sql.begin(async (tx) => {
      // Serialize every deletion path with publish provenance's FOR KEY SHARE
      // existence check. Without this row lock, a publish could attach the
      // source after the reference query but before DELETE.
      await tx.unsafe(
        "SELECT id FROM public.data_sources WHERE id = $1 FOR UPDATE",
        [id],
      );
      await assertDataSourceNotReferencedByPublishedVersion(tx, id);
      deleted = await tx`DELETE FROM public.data_sources WHERE id = ${id} RETURNING id`;
    });
  } catch (e) {
    if (e instanceof DataSourceDeleteBlockedError) {
      return c.json({
        ok: false,
        code: e.code,
        message: e.message,
        sourceId: e.sourceId,
        references: e.references,
      }, 409);
    }
    throw e;
  }
  if (!deleted.length) return c.json({ ok: false, message: "数据源不存在" }, 404);
  return c.json({ ok: true });
});

function maskSecrets(value: any): any {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, any> = {};
  for (const [key, nested] of Object.entries(value)) {
    out[key] = /(authorization|cookie|credential|passwd|password|secret|session|token|api[_-]?key|access[_-]?key|private[_-]?key)/i.test(key)
      ? "******"
      : maskSecrets(nested);
  }
  return out;
}

export default r;
