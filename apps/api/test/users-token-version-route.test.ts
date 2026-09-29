import { sql as dsql } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { users } from "../src/db/schema.js";
import { sign } from "../src/lib/auth.js";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
}));

vi.mock("../src/lib/current-auth-user.js", () => ({
  resolveCurrentAuthUser: vi.fn(async (payload: unknown) => payload),
}));

vi.mock("../src/db/client", () => ({
  db: {
    select: mocks.select,
    update: mocks.update,
  },
  sql: { unsafe: vi.fn() },
}));

import routes from "../src/routes/users.js";

const adminToken = sign({
  uid: 1,
  username: "admin",
  isAdmin: true,
  tokenVersion: 0,
});

function request(body: unknown) {
  return routes.request("/9", {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("administrator password reset token revocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: 9 }],
        }),
      }),
    });
    mocks.set.mockImplementation(() => ({
      where: () => ({
        returning: async () => [{ id: 9, username: "operator", displayName: "Operator" }],
      }),
    }));
    mocks.update.mockReturnValue({ set: mocks.set });
  });

  test("updates the password hash and increments token_version in one DB update", async () => {
    const response = await request({ password: "new-password" });

    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenCalledTimes(1);
    const patch = mocks.set.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.passwordHash).toEqual(expect.any(String));
    expect(patch.passwordHash).not.toBe("new-password");
    expect(patch.tokenVersion).toEqual(dsql`${users.tokenVersion} + 1`);
  });

  test("does not revoke sessions for a display-name-only update", async () => {
    const response = await request({ displayName: "Renamed Operator" });

    expect(response.status).toBe(200);
    const patch = mocks.set.mock.calls[0][0] as Record<string, unknown>;
    expect(patch).toEqual({ displayName: "Renamed Operator" });
  });
});
