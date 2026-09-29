// ETL fixture 测试（V0.27：连 DB 验证 statusFilter 实际过滤效果）
// 动态找阿里健康 source（shiporder），验证 buildStatusWhere 排除无效状态
import { describe, it, expect, afterAll } from "vitest";
import { config } from "dotenv";
import postgres from "postgres";
import { buildStatusWhere } from "../src/services/etl";
import { resolveIsolatedTestDatabase } from "./helpers/isolated-database.js";

config({ path: "../../.env" });
const TEST_DATABASE_URL = resolveIsolatedTestDatabase(process.env);
const hasIsolatedTestDatabase = Boolean(TEST_DATABASE_URL);
const s = hasIsolatedTestDatabase
  ? postgres(TEST_DATABASE_URL!, { connect_timeout: 5 })
  : null;

// 阿里健康 statusFilter 配置（与 orders.json 一致）
const sf = {
  statusColumn: "发货状态",
  excludeStatus: ["已废弃(关闭)", "待接单(待下发仓库)"],
  refundColumn: "是否退款",
  refundExclude: ["已退款"],
};

async function findAliHealthSource(): Promise<{ id: number; cols: any[] } | null> {
  const rows = await s!`
    SELECT id, config FROM data_sources
    WHERE name LIKE '%shiporder%' OR config->>'originalFileName' LIKE '%shiporder%'
    ORDER BY id LIMIT 1
  `;
  if (!rows.length) return null;
  return { id: rows[0].id as number, cols: (rows[0].config as any).columns };
}

describe.skipIf(!hasIsolatedTestDatabase)("ETL statusFilter fixture", () => {
  it("阿里健康 statusFilter 排除无效状态后行数减少", async () => {
    const src = await findAliHealthSource();
    if (!src) {
      console.warn("无阿里健康 source（shiporder），跳过");
      return;
    }
    const table = `uf_${src.id}`;
    const [exists] = await s!`SELECT 1 AS hit FROM information_schema.tables WHERE table_name = ${table}`;
    if (!exists) return;

    const { clause, params } = buildStatusWhere(src.cols, sf);
    expect(clause).not.toBe("");
    expect(params).toEqual(["已废弃(关闭)", "待接单(待下发仓库)", "已退款"]);

    const [{ total }] = await s!`SELECT count(*)::int AS total FROM ${s!(table)}`;
    const filtered = (await s!.unsafe(
      `SELECT count(*)::int AS n FROM "${table}" o ${clause}`,
      params,
    )) as any[];

    expect(filtered[0].n).toBeGreaterThan(0);
    expect(filtered[0].n).toBeLessThan(total);
    console.log(`${table} 总 ${total} 行 → 过滤后 ${filtered[0].n} 行（已发货+无退款）`);
  });

  it("过滤后剩余行都是已发货且未退款", async () => {
    const src = await findAliHealthSource();
    if (!src) return;
    const table = `uf_${src.id}`;
    const [exists] = await s!`SELECT 1 AS hit FROM information_schema.tables WHERE table_name = ${table}`;
    if (!exists) return;

    const { clause, params } = buildStatusWhere(src.cols, sf);
    const statusCol = src.cols.find((c: any) => c.raw === "发货状态")?.name;
    const refundCol = src.cols.find((c: any) => c.raw === "是否退款")?.name;
    if (!statusCol || !refundCol) return;

    const bad = (await s!.unsafe(
      `SELECT count(*)::int AS n FROM "${table}" o ${clause}
       AND (o."${statusCol}" IN ('已废弃(关闭)', '待接单(待下发仓库)')
            OR o."${refundCol}" = '已退款')`,
      params,
    )) as any[];
    expect(bad[0].n).toBe(0);
  });
  afterAll(async () => {
    await s!.end();
  });
});
