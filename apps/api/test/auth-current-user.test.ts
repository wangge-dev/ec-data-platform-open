import { beforeEach, describe, expect, test, vi } from "vitest";
import { Hono } from "hono";
import jwt from "jsonwebtoken";

const mocks = vi.hoisted(() => ({
  sqlUnsafe: vi.fn(),
}));

vi.mock("../src/db/client.js", () => ({
  sql: { unsafe: mocks.sqlUnsafe },
}));

import {
  authMiddleware,
  JWT_SECRET,
  sign,
  type AuthPayload,
} from "../src/lib/auth.js";
import { adminGuard } from "../src/lib/admin-guard.js";

function app() {
  const route = new Hono<{ Variables: { user: AuthPayload } }>();
  route.use("*", authMiddleware);
  route.get("/who", (c) => c.json(c.get("user")));
  route.get("/admin", adminGuard, (c) => c.json({ ok: true }));
  return route;
}

function authorization(isAdmin = true, tokenVersion = 3) {
  return {
    Authorization: `Bearer ${sign({ uid: 7, username: "stale-name", isAdmin, tokenVersion })}`,
  };
}

describe("request-time JWT authority", () => {
  beforeEach(() => {
    mocks.sqlUnsafe.mockReset();
  });

  test("rejects a valid token immediately after its user is deleted", async () => {
    mocks.sqlUnsafe.mockResolvedValueOnce([]);

    const response = await app().request("/who", {
      headers: authorization(),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      message: "账号已失效，请重新登录",
    });
    expect(mocks.sqlUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("FROM public.users"),
      [7],
    );
  });

  test("uses the current database role instead of a stale admin claim", async () => {
    mocks.sqlUnsafe.mockResolvedValueOnce([
      { uid: "7", username: "current-name", isAdmin: false, tokenVersion: 3 },
    ]);

    const response = await app().request("/admin", {
      headers: authorization(true),
    });

    expect(response.status).toBe(403);
  });

  test("exposes the current database identity to downstream handlers", async () => {
    mocks.sqlUnsafe.mockResolvedValueOnce([
      { uid: "7", username: "current-name", isAdmin: true, tokenVersion: 3 },
    ]);

    const response = await app().request("/who", {
      headers: authorization(false),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      uid: 7,
      username: "current-name",
      isAdmin: true,
      tokenVersion: 3,
    });
  });

  test("rejects a JWT immediately after the password token version changes", async () => {
    mocks.sqlUnsafe.mockResolvedValueOnce([
      { uid: "7", username: "current-name", isAdmin: true, tokenVersion: 4 },
    ]);

    const response = await app().request("/who", {
      headers: authorization(true, 3),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      message: "账号已失效，请重新登录",
    });
  });

  test("fails closed for a pre-upgrade JWT without a token version", async () => {
    const legacyToken = jwt.sign(
      { uid: 7, username: "legacy-name", isAdmin: true },
      JWT_SECRET,
      { expiresIn: "7d" },
    );

    const response = await app().request("/who", {
      headers: { Authorization: `Bearer ${legacyToken}` },
    });

    expect(response.status).toBe(401);
    expect(mocks.sqlUnsafe).not.toHaveBeenCalled();
  });
});
