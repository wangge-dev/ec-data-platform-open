import { beforeEach, describe, expect, test, vi } from "vitest";
import { sign } from "../src/lib/auth.js";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("../src/lib/current-auth-user.js", () => ({
  resolveCurrentAuthUser: vi.fn(async (payload: unknown) => payload),
}));

vi.mock("../src/db/client", () => ({
  db: { select: mocks.select, delete: mocks.delete },
  sql: { unsafe: vi.fn() },
}));

import routes from "../src/routes/users.js";

const adminToken = sign({ uid: 1, username: "admin", isAdmin: true, tokenVersion: 0 });

function deleteUser() {
  return routes.request("/9", {
    method: "DELETE",
    headers: { Authorization: `Bearer ${adminToken}` },
  });
}

describe("administrator deletes a user with retained business history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.select
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [{ id: 9 }] }) }) })
      .mockReturnValueOnce({ from: async () => [{ count: 2 }] });
  });

  test("returns a conflict instead of a generic server error on foreign-key restriction", async () => {
    mocks.delete.mockReturnValue({
      where: async () => { throw { cause: { code: "23503" } }; },
    });

    const response = await deleteUser();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, code: "USER_HAS_HISTORY" });
  });

  test("still deletes an unreferenced user", async () => {
    mocks.delete.mockReturnValue({ where: async () => undefined });

    const response = await deleteUser();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
