// 外部 SQL 数据源：测连接 / 保存 / 列表 / 跑 SQL
// V0.27：密码 AES 加密存储；保存/删除限 admin（外部 SQL 可探内网，敏感操作）
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { createMiddleware } from "hono/factory";
import { eq, and, desc } from "drizzle-orm";

import { db } from "../db/client";
import { dataSources } from "../db/schema";
import { authMiddleware, type AuthPayload } from "../lib/auth";
import { encrypt, decrypt } from "../lib/crypto";
import { testConnection, listTables, querySql, type SqlConfig } from "../services/sql-connector";
import {
  ConnectorManifestError,
  loadConnectorManifests,
  publicConnectorManifest,
  resolveConnectorManifest,
  validateConnectorManifest,
} from "../services/connector-manifest";

const r = new Hono<{ Variables: { user: AuthPayload } }>();
r.use("*", authMiddleware);

// V0.27：外部 SQL 涉及内网探测/SSRF 风险，保存/删除限 admin
const adminGuard = createMiddleware(async (c, next) => {
  const u = c.get("user");
  if (!u?.isAdmin) return c.json({ ok: false, message: "需要管理员权限" }, 403);
  await next();
});
r.use("*", adminGuard);

const sqlConfigSchema = z.object({
  connectorId: z.string().optional(),
  dialect: z.enum(["pg", "mysql"]),
  host: z.string().min(1),
  port: z.number().int().positive(),
  user: z.string().min(1),
  password: z.string(),
  database: z.string().min(1),
  ssl: z.boolean().optional(),
});

function connectorError(c: any, error: unknown) {
  if (error instanceof ConnectorManifestError) {
    return c.json({
      ok: false,
      code: error.code,
      message: error.publicMessage,
      ...(error.details ? { details: error.details } : {}),
    }, error.status);
  }
  console.error("[external-sql-connectors] failed", error);
  return c.json({
    ok: false,
    code: "CONNECTOR_MANIFEST_INVALID",
    message: "连接器清单加载失败。",
  }, 500);
}

// 把存的 config（密码加密）还原成 sql-connector 可用的 SqlConfig（密码解密）
function decryptConfig(cfg: any): SqlConfig {
  const out = { ...cfg };
  if (out.passwordEnc) {
    out.password = decrypt(out.passwordEnc);
    delete out.passwordEnc;
  }
  return out as SqlConfig;
}

// 列表（仅 external_sql 类型）——密码完全脱敏不返回
r.get("/connectors", (c) => {
  try {
    return c.json({
      ok: true,
      data: {
        schemaVersion: "connector-catalog/v1",
        connectors: loadConnectorManifests().map(publicConnectorManifest),
      },
    });
  } catch (error) {
    return connectorError(c, error);
  }
});

r.post("/connectors/validate", async (c) => {
  try {
    const manifest = validateConnectorManifest(await c.req.json());
    return c.json({ ok: true, data: publicConnectorManifest(manifest) });
  } catch (error) {
    return connectorError(c, error);
  }
});

r.get("/", async (c) => {
  const list = await db
    .select()
    .from(dataSources)
    .where(eq(dataSources.type, "external_sql"))
    .orderBy(desc(dataSources.createdAt));
  const safe = list.map((d) => {
    const cfg = d.config as any;
    return {
      ...d,
      config: { ...cfg, password: "", passwordEnc: undefined, hasPassword: !!cfg.passwordEnc },
    };
  });
  return c.json({ ok: true, data: safe });
});

// 测连接（不保存）
r.post("/test", zValidator("json", sqlConfigSchema), async (c) => {
  const cfg = c.req.valid("json") as SqlConfig;
  try {
    resolveConnectorManifest((cfg as SqlConfig & { connectorId?: string }).connectorId, cfg.dialect);
  } catch (error) {
    return connectorError(c, error);
  }
  const result = await testConnection(cfg);
  return c.json(result.ok ? { ok: true, version: result.version } : { ok: false, message: result.error }, result.ok ? 200 : 400);
});

// 保存连接（admin only；密码加密存储）
r.post(
  "/",
  zValidator(
    "json",
    z.object({ name: z.string().min(1).max(128), config: sqlConfigSchema }),
  ),
  async (c) => {
    const { name, config } = c.req.valid("json");
    let connector;
    try {
      connector = resolveConnectorManifest(config.connectorId, config.dialect);
    } catch (error) {
      return connectorError(c, error);
    }
    // 密码加密后存 passwordEnc，不存明文 password
    const storedConfig: any = { ...config };
    storedConfig.connectorId = connector.id;
    storedConfig.connectorVersion = connector.version;
    storedConfig.passwordEnc = encrypt(config.password);
    delete storedConfig.password;
    const [created] = await db
      .insert(dataSources)
      .values({
        name,
        type: "external_sql",
        platform: config.dialect,
        config: storedConfig,
      })
      .returning();
    const cfg = created.config as any;
    return c.json({ ok: true, data: { ...created, config: { ...cfg, password: "", passwordEnc: undefined, hasPassword: true } } }, 201);
  },
);

r.delete("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const deleted = await db
    .delete(dataSources)
    .where(and(eq(dataSources.id, id), eq(dataSources.type, "external_sql")))
    .returning();
  if (!deleted.length) return c.json({ ok: false, message: "数据源不存在" }, 404);
  return c.json({ ok: true });
});

// 已保存连接的表清单
r.get("/:id{[0-9]+}/tables", async (c) => {
  const id = Number(c.req.param("id"));
  const [src] = await db.select().from(dataSources).where(eq(dataSources.id, id)).limit(1);
  if (!src || src.type !== "external_sql") return c.json({ ok: false, message: "数据源不存在" }, 404);
  try {
    const tables = await listTables(decryptConfig(src.config));
    return c.json({ ok: true, data: tables });
  } catch (e: any) {
    return c.json({ ok: false, message: e.message }, 500);
  }
});

// 跑 SQL
r.post(
  "/:id{[0-9]+}/query",
  zValidator("json", z.object({ sql: z.string().min(1), limit: z.number().int().positive().max(500).optional() })),
  async (c) => {
    const id = Number(c.req.param("id"));
    const { sql, limit = 100 } = c.req.valid("json");
    const [src] = await db.select().from(dataSources).where(eq(dataSources.id, id)).limit(1);
    if (!src || src.type !== "external_sql") return c.json({ ok: false, message: "数据源不存在" }, 404);
    try {
      const result = await querySql(decryptConfig(src.config), sql, limit);
      return c.json({ ok: true, data: result });
    } catch (e: any) {
      return c.json({ ok: false, message: e.message }, 400);
    }
  },
);

export default r;
