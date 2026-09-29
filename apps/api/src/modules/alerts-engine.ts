// 预警引擎执行器（V0.20+）
// 把 runAlerts 抽出独立模块，让 HTTP 路由和定时调度器都能调用
import { db, sql } from "../db/client.js";
import { alerts } from "../db/schema.js";
import { resolveExistingRuntimeTableReferenceFromSql } from "../db/table-scope.js";
import { loadModules, moduleTableName } from "../modules/loader.js";
import { executeLocalReadOnlyQuery } from "../lib/local-readonly-sql.js";
import { ensureReadOnly } from "../lib/sql-guard.js";

export type RunReport = {
  moduleCode: string;
  ruleKey: string;
  ruleLabel: string;
  severity: string;
  triggered: number;
  skipped: boolean;
  error?: string;
};

export type RunResult = {
  ranAt: string;
  moduleFilter: string;
  reports: RunReport[];
  openTotal: number;
};

/**
 * 把 "SKU ${product_id} 库存仅剩 ${stock_qty}" 中的占位符按 row 渲染
 */
function renderMessage(template: string, row: Record<string, any>): string {
  return template.replace(/\$\{([a-z_][a-z0-9_]*)\}/gi, (_m, key) => {
    const v = row[key];
    if (v === null || v === undefined) return "(空)";
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === "number") {
      return Number.isInteger(v) ? String(v) : v.toFixed(4);
    }
    return String(v);
  });
}

/**
 * 只读 SQL 校验：复用全站唯一的 lib/sql-guard.ts，避免黑名单漂移
 * （旧副本缺 merge/copy/into/call/do 等隐式写关键字）
 */

/**
 * 跑一次预警规则
 * @param moduleCode 指定模块，不传则跑全量
 */
export async function runAlerts(moduleCode?: string): Promise<RunResult> {
  const mods = await loadModules();
  const targets = moduleCode ? mods.filter((m) => m.code === moduleCode) : mods;

  const reports: RunReport[] = [];

  for (const mod of targets) {
    const rules = mod.alerts ?? [];
    const tableName = moduleTableName(mod);

    // 表存在校验
    const tableRef = await resolveExistingRuntimeTableReferenceFromSql(tableName, sql);
    if (!tableRef) {
      for (const rule of rules) {
        reports.push({
          moduleCode: mod.code,
          ruleKey: rule.key,
          ruleLabel: rule.label,
          severity: rule.severity,
          triggered: 0,
          skipped: true,
          error: `表 ${tableName} 不存在`,
        });
      }
      continue;
    }

    for (const rule of rules) {
      if (!rule.enabled) {
        reports.push({
          moduleCode: mod.code,
          ruleKey: rule.key,
          ruleLabel: rule.label,
          severity: rule.severity,
          triggered: 0,
          skipped: true,
        });
        continue;
      }

      let ruleSql: string;
      try {
        ruleSql = ensureReadOnly(rule.sql);
      } catch (e: any) {
        reports.push({
          moduleCode: mod.code,
          ruleKey: rule.key,
          ruleLabel: rule.label,
          severity: rule.severity,
          triggered: 0,
          skipped: true,
          error: "SQL 校验失败：" + e.message,
        });
        continue;
      }

      let rows: Record<string, any>[] = [];
      try {
        rows = await executeLocalReadOnlyQuery(ruleSql);
      } catch (e: any) {
        reports.push({
          moduleCode: mod.code,
          ruleKey: rule.key,
          ruleLabel: rule.label,
          severity: rule.severity,
          triggered: 0,
          skipped: true,
          error: "SQL 执行失败：" + e.message,
        });
        continue;
      }

      // 先清掉这条规则的旧 open 事件（同 module+rule 重跑覆盖）
      await sql.unsafe(
        `DELETE FROM public.alerts WHERE module_code = $1 AND rule_key = $2 AND status = 'open'`,
        [mod.code, rule.key],
      );

      let triggered = 0;
      for (const row of rows) {
        const message = renderMessage(rule.message, row);
        await db.insert(alerts).values({
          moduleCode: mod.code,
          ruleKey: rule.key,
          ruleLabel: rule.label,
          severity: rule.severity,
          message,
          detail: row,
          status: "open",
        });
        triggered++;
      }

      reports.push({
        moduleCode: mod.code,
        ruleKey: rule.key,
        ruleLabel: rule.label,
        severity: rule.severity,
        triggered,
        skipped: false,
      });
    }
  }

  const [{ total }] = (await sql.unsafe(
    `SELECT COUNT(*)::int AS total FROM public.alerts WHERE status = 'open'`,
  )) as any[];

  return {
    ranAt: new Date().toISOString(),
    moduleFilter: moduleCode ?? "(全部)",
    reports,
    openTotal: total,
  };
}
