import { describe, expect, test, vi } from "vitest";
import { Hono } from "hono";
import { sign, authMiddleware, type AuthPayload } from "../src/lib/auth.js";
import { adminGuard } from "../src/lib/admin-guard.js";

vi.mock("../src/lib/current-auth-user.js", () => ({
  resolveCurrentAuthUser: vi.fn(async (payload: any) => payload),
}));

import etlRoutes from "../src/routes/etl.js";
import systemRoutes from "../src/routes/system.js";
import filesRoutes from "../src/routes/files.js";
import alertsRoutes from "../src/routes/alerts.js";
import modulesRoutes from "../src/routes/modules.js";

const nonAdminToken = sign({ uid: 41, username: "operator", isAdmin: false, tokenVersion: 0 });

function request(
  routes: { request: (path: string, init?: RequestInit) => Promise<Response> },
  method: string,
  path: string,
) {
  return routes.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${nonAdminToken}`,
      "Content-Type": "application/json",
    },
    ...(["POST", "PUT", "PATCH"].includes(method)
      ? { body: JSON.stringify({}) }
      : {}),
  });
}

describe("administrator policy for destructive and global routes", () => {
  test.each([
    ["ETL clear", etlRoutes, "DELETE", "/clear"],
    ["ETL rerun-all", etlRoutes, "POST", "/rerun-all"],
    ["ETL folder read", etlRoutes, "GET", "/folder"],
    ["ETL folder write", etlRoutes, "POST", "/folder"],
    ["ETL server-folder scan", etlRoutes, "POST", "/scan"],
    ["settings list", systemRoutes, "GET", "/kv"],
    ["settings write", systemRoutes, "PUT", "/kv/scan_folder"],
    ["file batch delete", filesRoutes, "POST", "/batch-delete"],
    ["file delete", filesRoutes, "DELETE", "/123"],
    ["alert clear", alertsRoutes, "DELETE", "/clear"],
    ["module cache reload", modulesRoutes, "POST", "/reload"],
  ])("rejects a non-admin before handling %s", async (_name, routes, method, path) => {
    const response = await request(routes as any, method as string, path as string);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      message: "需要管理员权限",
    });
  });

  test("shared guard admits the current administrator", async () => {
    const app = new Hono<{ Variables: { user: AuthPayload } }>();
    app.use("*", authMiddleware);
    app.post("/", adminGuard, (c) => c.json({ ok: true }));
    const token = sign({ uid: 1, username: "admin", isAdmin: true, tokenVersion: 0 });

    const response = await app.request("/", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
  });
});
