import { Hono } from "hono";
import { beforeAll, describe, expect, test, vi } from "vitest";
import * as XLSX from "xlsx";

vi.mock("../src/lib/current-auth-user.js", () => ({
  resolveCurrentAuthUser: async (payload: unknown) => payload,
}));

let app: Hono;
let token: string;

beforeAll(async () => {
  const [{ default: modulesRoutes }, auth] = await Promise.all([
    import("../src/routes/modules.js"),
    import("../src/lib/auth.js"),
  ]);
  app = new Hono();
  app.route("/modules", modulesRoutes);
  token = auth.sign({ uid: 7, username: "tester", isAdmin: false, tokenVersion: 0 });
});

describe("POST /modules/inspect-excel spreadsheet guard", () => {
  test("rejects an XLSX containing an external hyperlink relationship", async () => {
    const sheet = XLSX.utils.aoa_to_sheet([["字段"], ["值"]]);
    sheet.A1!.l = { Target: "https://example.invalid/remote" };
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "数据");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    const form = new FormData();
    form.set("file", new File([bytes], "external-link.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }));

    const response = await app.request("/modules/inspect-excel", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const body = await response.json() as { ok?: boolean; message?: string };

    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.message).toContain("外部关系");
  });
});
