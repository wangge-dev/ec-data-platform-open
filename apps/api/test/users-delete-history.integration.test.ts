import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, test } from "vitest";
import { resolveIsolatedTestDatabase } from "./helpers/isolated-database.js";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1";
const databaseUrl = runDatabaseTests ? resolveIsolatedTestDatabase(process.env, true) : undefined;
const describeDatabase = runDatabaseTests ? describe : describe.skip;

if (runDatabaseTests && databaseUrl) process.env.DATABASE_URL = databaseUrl;

describeDatabase("delete-user foreign-key feedback", () => {
  test("returns 409 and keeps a user referenced by module history", async () => {
    const [{ default: routes }, { sign }] = await Promise.all([
      import("../src/routes/users.js"),
      import("../src/lib/auth.js"),
    ]);
    const verifier = postgres(databaseUrl!, { max: 1, connect_timeout: 5 });
    const suffix = randomUUID().replaceAll("-", "");
    let adminId: number | undefined;
    let targetId: number | undefined;
    let moduleId: number | undefined;

    try {
      const [admin] = await verifier.unsafe(
        "INSERT INTO public.users (username, password_hash, is_admin) VALUES ($1, $2, true) RETURNING id",
        [`audit_admin_${suffix}`, "synthetic-hash"],
      );
      adminId = Number(admin.id);
      const [target] = await verifier.unsafe(
        "INSERT INTO public.users (username, password_hash, is_admin) VALUES ($1, $2, false) RETURNING id",
        [`audit_operator_${suffix}`, "synthetic-hash"],
      );
      targetId = Number(target.id);
      const [module] = await verifier.unsafe(
        `INSERT INTO public.module_configs (code, name, description, config, origin, created_by)
         VALUES ($1, $2, $3, $4::jsonb, 'user', $5) RETURNING id`,
        [`audit_${suffix}`, "合成历史模块", "仅用于隔离数据库回归", "{}", targetId],
      );
      moduleId = Number(module.id);

      const token = sign({ uid: adminId, username: `audit_admin_${suffix}`, isAdmin: true, tokenVersion: 0 });
      const response = await routes.request(`/${targetId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ ok: false, code: "USER_HAS_HISTORY" });
      const [retained] = await verifier.unsafe("SELECT id FROM public.users WHERE id = $1", [targetId]);
      expect(Number(retained?.id)).toBe(targetId);
    } finally {
      if (moduleId !== undefined) await verifier.unsafe("DELETE FROM public.module_configs WHERE id = $1", [moduleId]);
      if (targetId !== undefined) await verifier.unsafe("DELETE FROM public.users WHERE id = $1", [targetId]);
      if (adminId !== undefined) await verifier.unsafe("DELETE FROM public.users WHERE id = $1", [adminId]);
      await verifier.end({ timeout: 1 });
    }
  });
});
