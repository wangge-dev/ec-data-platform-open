import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";

import { db } from "./db/client";
import { settings } from "./db/schema";
import authRoutes from "./routes/auth";
import usersRoutes from "./routes/users";
import dataSourcesRoutes from "./routes/data-sources";
import filesRoutes from "./routes/files";
import boardRoutes from "./routes/board";
import agentsRoutes from "./routes/agents";
import systemRoutes from "./routes/system";
import externalSqlRoutes from "./routes/external-sql";
import etlRoutes from "./routes/etl";
import moduleBuilderRoutes from "./routes/module-builder";
import modulesRoutes from "./routes/modules";
import metricsRoutes from "./routes/metrics";
import alertsRoutes from "./routes/alerts";
import analyticsRoutes from "./routes/analytics";
import frontProfitRoutes from "./routes/front-profit";
import semanticRoutes from "./routes/semantic";
import { configureRuntimeModuleLoader } from "./modules/runtime-loader";
import { shouldBypassDefaultBodyLimit } from "./services/large-csv-import";

// 先接入数据库活动模块，再开放任何会调用 loadModules() 的路由或调度器。
configureRuntimeModuleLoader(db);

// CORS 来源 env 化：CORS_ORIGIN 逗号分隔，未配置时默认本地开发地址
function corsOrigins(): string[] {
  const env = process.env.CORS_ORIGIN?.trim();
  if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
  return ["http://localhost:5173"];
}

const app = new Hono();

app.use("*", logger());
app.use("*", cors({ origin: corsOrigins(), credentials: true }));
// 全局请求体兜底上限（50MB）。管理员专用的大 CSV 路由直接消费原始流，并在
// 流中执行独立的 512MB/100 万行硬限制，因此只对这个精确路径绕开通用上限。
const defaultBodyLimit = bodyLimit({ maxSize: 50 * 1024 * 1024 });
app.use("*", async (c, next) => {
  if (shouldBypassDefaultBodyLimit(c.req.method, c.req.path)) return next();
  return defaultBodyLimit(c, next);
});

// 全局错误处理：未捕获异常统一返回 {ok:false}，隐藏内部栈，详细信息只记服务端
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ ok: false, message: err.message }, err.status);
  }
  console.error("[unhandled]", c.req.method, c.req.path, err);
  return c.json({ ok: false, message: "服务器内部错误" }, 500);
});

app.get("/", (c) => c.json({ name: "ec-data-platform api", version: "0.1.0" }));

const api = new Hono();

api.get("/health", async (c) => {
  try {
    await db.select().from(settings).limit(1);
    return c.json({ ok: true, db: "connected", time: new Date().toISOString() });
  } catch (e: any) {
    console.error("[health] database check failed", e);
    return c.json({ ok: false, db: "error", message: "数据库健康检查失败" }, 500);
  }
});

api.route("/auth", authRoutes);
api.route("/users", usersRoutes);
api.route("/data-sources", dataSourcesRoutes);
api.route("/files", filesRoutes);
api.route("/board", boardRoutes);
api.route("/agents", agentsRoutes);
api.route("/system", systemRoutes);
api.route("/external-sql", externalSqlRoutes);
api.route("/etl", etlRoutes);
// Builder-specific paths must be registered before modulesRoutes /:code.
api.route("/modules", moduleBuilderRoutes);
api.route("/modules", modulesRoutes);
api.route("/metrics", metricsRoutes);
api.route("/alerts", alertsRoutes);
api.route("/analytics", analyticsRoutes);
api.route("/front-profit", frontProfitRoutes);
api.route("/semantic", semanticRoutes);

app.route("/api", api);

const port = Number(process.env.PORT) || 4000;
serve({ fetch: app.fetch, port });
console.log(`✓ api running at http://localhost:${port}`);

// 启动预警调度器（V0.20+）：扫描所有模块的 schedule 字段，按 cron 注册
import("./modules/scheduler.js").then((m) => m.startScheduler()).catch((e) => {
  console.error("[scheduler] 启动失败：", e.message);
});
