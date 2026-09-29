// ETL 集成测试（V0.27：真正跑 runModuleEtl 后断言 unified_sales）
// 比 etl-fixture 更进一步：调完整 ETL 引擎（engine + transform + etlOrderSource），
// 验证 statusFilter 在真实链路里生效——unified_sales 只含已发货未退款行
import { describe, it, expect, afterAll } from "vitest";
import { config } from "dotenv";
import postgres from "postgres";
import { resolveIsolatedTestDatabase } from "./helpers/isolated-database.js";

config({ path: "../../.env" });
const TEST_DATABASE_URL = resolveIsolatedTestDatabase(process.env);
const hasIsolatedTestDatabase = Boolean(TEST_DATABASE_URL);
const s = hasIsolatedTestDatabase
  ? postgres(TEST_DATABASE_URL!, { connect_timeout: 5 })
  : null;

async function findAliHealthSource(): Promise<number | null> {
  const rows = await s!`
    SELECT id FROM data_sources
    WHERE name LIKE '%shiporder%' OR config->>'originalFileName' LIKE '%shiporder%'
    ORDER BY id LIMIT 1
  `;
  return rows.length ? (rows[0].id as number) : null;
}

describe.skipIf(!hasIsolatedTestDatabase)(
  "runModuleEtl 集成（阿里健康 → unified_sales）",
  () => {
  let sourceId: number | null;

  it("跑完整 ETL，unified_sales 只含已发货未退款", async () => {
    // 只有显式配置隔离测试库时才加载应用 DB 客户端。
    // 禁止该测试复用正常应用/现网 DATABASE_URL。
    process.env.DATABASE_URL = TEST_DATABASE_URL!;
    const { runModuleEtl } = await import("../src/modules/engine");
    sourceId = await findAliHealthSource();
    if (!sourceId) {
      console.warn("无阿里健康 source，跳过");
      return;
    }

    // 先清掉该 source 旧的 unified 行（避免 ON CONFLICT 跳过干扰断言）
    await s!`DELETE FROM unified_sales WHERE source_file LIKE '%shiporder%'`;

    // 跑完整 ETL 引擎（matchFileToPlatform → orders.transform → etlOrderSource + statusFilter）
    const report = await runModuleEtl(sourceId);
    expect(report).not.toBeNull();
    expect(report!.error).toBeUndefined();
    expect(report!.inserted).toBeGreaterThan(0);
    expect(report!.total).toBeGreaterThan(0);
    console.log(`runModuleEtl(阿里健康 ${sourceId}): total=${report!.total} inserted=${report!.inserted} matched=${report!.matched}`);

    // statusFilter 生效性【真验证】（核验校正：旧断言 inserted<=total 恒真，等于没测）。
    // report.total 已是过滤后口径（etlOrderSource 的 totalSql 自带 statusWhere），
    // 所以这里独立数一遍 uf_ 源表的"原始总行数"和"被排除行数"，证明过滤真的动了。
    const uf = `uf_${sourceId}`;
    const [{ rawTotal }] = (await s!.unsafe(
      `SELECT COUNT(*)::int AS "rawTotal" FROM "${uf}"`,
    )) as any[];
    const [{ excluded }] = (await s!.unsafe(
      `SELECT COUNT(*)::int AS excluded FROM "${uf}"
       WHERE "发货状态" IN ('已废弃(关闭)','待接单(待下发仓库)') OR "是否退款" = '已退款'`,
    )) as any[];
    // 原始总数 = 有效总数(report.total) + 被排除数——三者自洽，证明 statusFilter 精确生效
    expect(rawTotal).toBe(report!.total + excluded);
    console.log(`statusFilter 校验: raw=${rawTotal} 有效=${report!.total} 排除=${excluded}`);

    // 验证 unified_sales 里该 source 的行金额都 > 0（已发货订单有金额）
    const rows = (await s!.unsafe(
      `SELECT count(*)::int AS n, COALESCE(SUM(amount),0)::numeric AS sum FROM unified_sales WHERE source_file LIKE '%shiporder%'`,
    )) as any[];
    expect(rows[0].n).toBeGreaterThan(0);
    expect(Number(rows[0].sum)).toBeGreaterThan(0);
  });

  afterAll(async () => {
    // 清理隔离测试库中的测试写入。
    await s!`DELETE FROM unified_sales WHERE source_file LIKE '%shiporder%'`;
    await s!.end();
  });
});
