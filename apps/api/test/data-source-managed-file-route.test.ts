import { beforeEach, describe, expect, test, vi } from "vitest";
import { sign } from "../src/lib/auth.js";

const mocks = vi.hoisted(() => ({
  current: null as null | { id: number; type: string; name: string; config: Record<string, unknown> },
  insert: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  begin: vi.fn(),
  tx: Object.assign(vi.fn(), { unsafe: vi.fn() }),
  publishReferences: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/lib/current-auth-user.js", () => ({
  resolveCurrentAuthUser: vi.fn(async (payload: any) => payload),
}));

vi.mock("../src/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        orderBy: async () => mocks.current ? [mocks.current] : [],
        where: () => ({ limit: async () => mocks.current ? [mocks.current] : [] }),
      }),
    }),
    insert: () => ({
      values: (value: unknown) => ({
        returning: async () => {
          mocks.insert(value);
          return [{ id: 2, ...(value as object) }];
        },
      }),
    }),
    update: () => ({
      set: (value: unknown) => ({
        where: () => ({
          returning: async () => {
            mocks.update(value);
            return mocks.current ? [{ ...mocks.current, ...(value as object) }] : [];
          },
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: async () => {
          mocks.remove();
          return mocks.current ? [mocks.current] : [];
        },
      }),
    }),
  },
  sql: {
    begin: mocks.begin,
  },
}));

import routes from "../src/routes/data-sources.js";

const token = sign({ uid: 7, username: "tester", isAdmin: true, tokenVersion: 0 });
const nonAdminToken = sign({ uid: 8, username: "operator", isAdmin: false, tokenVersion: 0 });
const request = (path: string, method: string, body?: unknown) => routes.request(path, {
  method,
  headers: {
    Authorization: `Bearer ${token}`,
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe("generic data-source CRUD managed-source boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.publishReferences = [];
    mocks.begin.mockImplementation(async (fn: any) => fn(mocks.tx));
    mocks.tx.mockImplementation(async () => {
      mocks.remove();
      return mocks.current ? [{ id: mocks.current.id }] : [];
    });
    mocks.tx.unsafe.mockImplementation(async () => mocks.publishReferences);
    mocks.current = {
      id: 1,
      type: "file",
      name: "validated-profit.xlsx",
      config: { frontProfitValidation: { schemaVersion: "front-profit-standard/v1" } },
    };
  });

  test("refuses to modify a managed file source", async () => {
    const response = await request("/1", "PUT", { name: "tampered" });
    expect(response.status).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  test.each([
    ["POST", "/", { name: "shop", type: "shop_account", config: {} }],
    ["PUT", "/1", { name: "renamed" }],
    ["DELETE", "/1", undefined],
  ])("requires an administrator for %s mutations", async (method, path, body) => {
    const response = await routes.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${nonAdminToken}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status).toBe(403);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  test("refuses generic deletion so the file cascade cannot be bypassed", async () => {
    const response = await request("/1", "DELETE");
    expect(response.status).toBe(409);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  test("refuses generic creation of a file source", async () => {
    const response = await request("/", "POST", {
      name: "forged file",
      type: "file",
      config: {},
    });
    expect(response.status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  test("refuses generic creation of an external SQL source", async () => {
    const response = await request("/", "POST", {
      name: "untrusted connection",
      type: "external_sql",
      config: { host: "127.0.0.1", password: "plaintext" },
    });
    expect(response.status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  test("refuses to modify an external SQL source", async () => {
    mocks.current = {
      id: 3,
      type: "external_sql",
      name: "managed connection",
      config: { encrypted: true },
    };
    const response = await request("/3", "PUT", {
      config: { host: "127.0.0.1", password: "plaintext" },
    });
    expect(response.status).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  test("refuses generic deletion of an external SQL source", async () => {
    mocks.current = {
      id: 3,
      type: "external_sql",
      name: "managed connection",
      config: { encrypted: true },
    };
    const response = await request("/3", "DELETE");
    expect(response.status).toBe(409);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  test("deletes an unreferenced shop account through the guarded transaction", async () => {
    mocks.current = {
      id: 4,
      type: "shop_account",
      name: "shop",
      config: {},
    };

    const response = await request("/4", "DELETE");

    expect(response.status).toBe(200);
    expect(mocks.begin).toHaveBeenCalledOnce();
    expect(mocks.tx.unsafe.mock.calls[0]).toEqual([
      expect.stringContaining("FOR UPDATE"),
      [4],
    ]);
    expect(mocks.tx.unsafe).toHaveBeenCalledWith(
      expect.stringContaining("FROM public.publish_version_source"),
      [4],
    );
    expect(mocks.remove).toHaveBeenCalledOnce();
  });

  test("blocks deletion of a shop account referenced by a published version", async () => {
    mocks.current = {
      id: 4,
      type: "shop_account",
      name: "shop",
      config: {},
    };
    mocks.publishReferences = [{
      publish_version_id: 3,
      module_code: "front_profit",
      scope_key: "front_profit:2098-02",
      version_no: 1,
    }];

    const response = await request("/4", "DELETE");
    const payload = await response.json() as any;

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      ok: false,
      code: "DATA_SOURCE_REFERENCED_BY_PUBLISHED_VERSION",
      sourceId: 4,
      references: [{
        publishVersionId: 3,
        moduleCode: "front_profit",
        scopeKey: "front_profit:2098-02",
        versionNo: 1,
      }],
    });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  test("recursively masks encrypted and nested credentials in generic reads", async () => {
    mocks.current = {
      id: 3,
      type: "external_sql",
      name: "managed connection",
      config: {
        host: "database.example",
        passwordEnc: "ciphertext-must-not-leave-server",
        Authorization: "Bearer hidden",
        credential: "hidden-credential",
        passwd: "hidden-passwd",
        session: "hidden-session",
        nested: { accessToken: "nested-secret", visible: "kept" },
      },
    };
    const response = await request("/3", "GET");
    const payload = await response.json() as any;
    expect(response.status).toBe(200);
    expect(payload.data.config).toEqual({
      host: "database.example",
      passwordEnc: "******",
      Authorization: "******",
      credential: "******",
      passwd: "******",
      session: "******",
      nested: { accessToken: "******", visible: "kept" },
    });
  });

  test("hides external SQL sources from an ordinary user's generic list", async () => {
    mocks.current = {
      id: 3,
      type: "external_sql",
      name: "managed connection",
      config: { host: "database.example", database: "analytics" },
    };
    const response = await routes.request("/", {
      headers: { Authorization: `Bearer ${nonAdminToken}` },
    });
    const payload = await response.json() as any;

    expect(response.status).toBe(200);
    expect(payload.data).toEqual([]);
  });

  test("does not disclose an external SQL source through ordinary-user detail lookup", async () => {
    mocks.current = {
      id: 3,
      type: "external_sql",
      name: "managed connection",
      config: { host: "database.example", database: "analytics" },
    };
    const response = await routes.request("/3", {
      headers: { Authorization: `Bearer ${nonAdminToken}` },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ ok: false, message: "数据源不存在" });
  });

  test("keeps non-sensitive shared file sources visible to ordinary users", async () => {
    mocks.current = {
      id: 1,
      type: "file",
      name: "validated-profit.xlsx",
      config: {
        group: "shared-label",
        Authorization: "Bearer must-not-leak",
        customHeader: "must-not-leak",
      },
    };
    const response = await routes.request("/1", {
      headers: { Authorization: `Bearer ${nonAdminToken}` },
    });
    const payload = await response.json() as any;

    expect(response.status).toBe(200);
    expect(payload.data.name).toBe("validated-profit.xlsx");
    expect(payload.data.config).toEqual({});
    expect(JSON.stringify(payload)).not.toContain("must-not-leak");
  });

  test("does not echo shop-account credentials after generic creation", async () => {
    const response = await request("/", "POST", {
      name: "synthetic shop",
      type: "shop_account",
      config: { cookie: "private-cookie", nested: { apiKey: "private-key" } },
    });
    const payload = await response.json() as any;
    expect(response.status).toBe(201);
    expect(payload.data.config).toEqual({
      cookie: "******",
      nested: { apiKey: "******" },
    });
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({
      config: { cookie: "private-cookie", nested: { apiKey: "private-key" } },
    }));
  });
});
