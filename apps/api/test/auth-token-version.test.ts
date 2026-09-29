import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: null as null | {
    id: number;
    username: string;
    passwordHash: string;
    displayName: string;
    isAdmin: boolean;
    tokenVersion: number;
  },
  select: vi.fn(),
}));

vi.mock("../src/db/client", () => ({
  db: {
    select: mocks.select,
  },
  sql: { unsafe: vi.fn() },
}));

import routes from "../src/routes/auth.js";
import { verify } from "../src/lib/auth.js";

function selectUserChain() {
  return {
    from: () => ({
      where: () => ({
        limit: async () => (mocks.user ? [mocks.user] : []),
      }),
    }),
  };
}

describe("login JWT token version", () => {
  beforeEach(() => {
    mocks.user = {
      id: 7,
      username: "operator",
      passwordHash: bcrypt.hashSync("correct-password", 4),
      displayName: "Operator",
      isAdmin: false,
      tokenVersion: 12,
    };
    mocks.select.mockReset();
    mocks.select.mockImplementation(selectUserChain);
  });

  test("signs the current persisted token version into a new login", async () => {
    const response = await routes.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "operator",
        password: "correct-password",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      data: { token: string };
    };
    expect(verify(body.data.token)).toMatchObject({
      uid: 7,
      username: "operator",
      isAdmin: false,
      tokenVersion: 12,
    });
  });
});
