/**
 * 模块化 ETL 引擎（D 方案阶段 2）
 *
 * 流程：
 *   1. 给一个 sourceId（已上传文件的 data_source.id）
 *   2. 按文件名匹配模块和平台
 *   3. 有 transform 钩子 → 调钩子（订单走这条）
 *   4. 无钩子 → 默认行映射 + 类型 CAST + 写入 unified_<code>
 *
 * 阶段 2 范围：跑通订单（走钩子），保证回归一字不差。
 * 阶段 3 范围：默认行映射路径（给库存/流量这种简单模块用），下个迭代实现。
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, sql } from "../db/client";
import { dataSources } from "../db/schema";
import {
  loadModules,
  matchFileToPlatform,
  getModule,
  type LoadedModule,
  type TransformContext,
} from "./loader.js";
import { runDefaultTransform } from "./default-transform.js";
import type { EtlReport } from "../services/etl.js";
import { ensureDefaultOrderCharts } from "../services/default-order-charts.js";
import { createModuleConfigStore } from "../services/module-config-store.js";
import { compileSafeFilePattern } from "../lib/file-pattern.js";
import {
  diffModuleSchema,
  inspectModuleSources,
} from "../services/module-source-inspector.js";
import {
  schemaDiffBlocksProcessing,
  sourceSchemaFingerprint,
  unresolvedSchemaDiff,
} from "../services/module-schema-review.js";
import {
  clearSourceSchemaReview,
  markSourceSchemaReviewAwaitingRetry,
  markSourceSchemaReviewPending,
  type PendingSourceSchemaReview,
} from "../services/source-schema-review-state.js";
import { publicProcessingError } from "../services/public-processing-error.js";
import {
  isValidatedFrontProfitSourceConfig,
  moduleRequiresFrontProfitStandard,
} from "../services/front-profit-standard.js";

/**
 * 给一个已上传文件，跑模块化 ETL
 * 返回 EtlReport 兼容旧格式（前端汇总页直接用）
 */
export async function runModuleEtl(
  sourceId: number,
  opts?: {
    moduleCode?: string;
    moduleOverride?: LoadedModule;
    manageSchemaReviewState?: boolean;
    executor?: {
      unsafe(query: string, parameters?: unknown[]): PromiseLike<any[]>;
    };
  },
): Promise<EtlReport | null> {
  const [src] = opts?.executor
    ? await opts.executor.unsafe(
        "SELECT * FROM public.data_sources WHERE id = $1 LIMIT 1",
        [sourceId],
      )
    : await db.select().from(dataSources).where(eq(dataSources.id, sourceId)).limit(1);
  if (!src) {
    return {
      platform: "(未知)",
      sourceId,
      fileName: "",
      total: 0,
      inserted: 0,
      matched: 0,
      matchRate: 0,
      error: "数据源不存在",
    };
  }

  const fileName = ((src.config as any)?.originalFileName ?? src.name) as string;

  // V0.27：支持用户上传时手动指定 moduleCode（跳过全局 filePattern 自动匹配）
  // 用途：用户明确知道文件归哪个模块时，不靠文件名猜；选"自动识别"则不传，走原逻辑
  let mod: LoadedModule | undefined;
  let platform: { code: string; name: string } | undefined;
  if (opts?.moduleCode) {
    mod = opts.moduleOverride?.code === opts.moduleCode
      ? opts.moduleOverride
      : await getModule(opts.moduleCode);
    if (!mod) return null; // 指定了不存在的模块，按未匹配处理
    // 在指定模块内按文件名匹配平台；匹配不上用第一个启用平台兜底
    const re = (p: any) => {
      try {
        return compileSafeFilePattern(p.filePattern, p.patternFlags ?? "i");
      } catch {
        return null;
      }
    };
    platform = (mod.platforms as any[])
      .filter((p) => p.enabled !== false)
      .find((p) => {
        const r = re(p);
        return r && r.test(fileName);
      });
    if (!platform) platform = (mod.platforms as any[]).find((p) => p.enabled !== false);
  } else {
    const match = await matchFileToPlatform(fileName);
    if (!match) return null; // 不属于任何模块（如未匹配文件）
    mod = match.module;
    platform = match.platform;
  }
  if (!mod || !platform) return null;

  if (
    moduleRequiresFrontProfitStandard(mod)
    && !isValidatedFrontProfitSourceConfig(src.config)
  ) {
    return {
      platform: platform.name,
      sourceId,
      fileName,
      total: Number((src.config as any)?.rowCount ?? 0),
      inserted: 0,
      matched: 0,
      matchRate: 0,
      error: "前台利润模块只接受已通过标准合同校验的数据源",
    };
  }

  const existingReview = (src.config as any)?.schemaReview as
    | PendingSourceSchemaReview
    | undefined;
  if (
    mod.origin === "user" &&
    opts?.manageSchemaReviewState !== false &&
    existingReview?.moduleCode === mod.code &&
    existingReview.status === "awaiting_retry"
  ) {
    return {
      platform: platform.name,
      sourceId,
      fileName,
      total: Number((src.config as any)?.rowCount ?? 0),
      inserted: 0,
      matched: 0,
      matchRate: 0,
      error: "字段设置待重试，请从字段确认入口重新处理",
      schemaReview: existingReview,
    };
  }

  // V0.25+：字典模块不跑 unified ETL，role 在上传路由已经标好
  // 这里只返回一个简短报告说明"已识别为字典"
  if (mod.isDict) {
    return {
      platform: mod.name,
      sourceId,
      fileName,
      total: 0,
      inserted: 0,
      matched: 0,
      matchRate: 0,
    };
  }

  // 走钩子（订单模块走这条）
  if (mod.hasTransform && mod.transform) {
    const ctx: TransformContext = {
      module: mod,
      platform: platform.code,
      rawFileName: fileName,
      sql,
      extra: { sourceId, platformName: platform.name },
    };
    const report = (await mod.transform(ctx)) as EtlReport;
    if (mod.code === "orders" && !report.error) {
      try {
        report.defaultCharts = await ensureDefaultOrderCharts();
      } catch (error: any) {
        console.error("[default-order-charts] seed failed", error);
        report.defaultCharts = {
          status: "error",
          created: 0,
          message: error?.message ?? "默认图表创建失败",
        };
      }
    }
    return report;
  }

  // 默认路径（简单模块用）：无钩子，走声明式行映射
  let reviewContext: {
    diff: ReturnType<typeof unresolvedSchemaDiff>;
    moduleVersion: number;
    schemaFingerprint: string;
    previous?: PendingSourceSchemaReview;
  } | null = null;
  if (mod.origin === "user") {
    const inspection = await inspectModuleSources(
      [sourceId],
      opts?.executor ? { sql: opts.executor } : undefined,
      { includeStatusValues: false },
    );
    const storedDecisions = await createModuleConfigStore(db)
      .listSchemaDecisions(mod.code);
    const reviewDiff = unresolvedSchemaDiff(
      diffModuleSchema(mod, inspection),
      storedDecisions,
    );
    reviewContext = {
      diff: reviewDiff,
      moduleVersion: Number(mod.version ?? 1),
      schemaFingerprint: sourceSchemaFingerprint(inspection),
      previous: existingReview,
    };
    if (schemaDiffBlocksProcessing(reviewDiff)) {
      const schemaReview = opts?.manageSchemaReviewState === false
        ? {
            status: "pending" as const,
            operationId: existingReview?.operationId ?? randomUUID(),
            sourceIds: existingReview?.sourceIds ?? [sourceId],
            moduleCode: mod.code,
            moduleVersion: reviewContext.moduleVersion,
            schemaFingerprint: reviewContext.schemaFingerprint,
            schemaFingerprints:
              existingReview?.schemaFingerprints ?? {
                [sourceId]: reviewContext.schemaFingerprint,
              },
            diff: reviewDiff,
            detectedAt: new Date().toISOString(),
          }
        : await markSourceSchemaReviewPending(
            sourceId,
            mod.code,
            reviewDiff,
            {
              moduleVersion: reviewContext.moduleVersion,
              schemaFingerprint: reviewContext.schemaFingerprint,
              operationId: existingReview?.operationId,
              sourceIds: existingReview?.sourceIds,
              schemaFingerprints: existingReview?.schemaFingerprints,
            },
          );
      return {
        platform: platform.name,
        sourceId,
        fileName,
        total: Number((src.config as any)?.rowCount ?? 0),
        inserted: 0,
        included: 0,
        excluded: 0,
        matched: 0,
        matchRate: 0,
        error: "字段有变化，需确认后重新处理",
        schemaReview,
      };
    }
  }
  try {
    const report = await runDefaultTransform({
      module: mod,
      platform: platform.code,
      rawFileName: fileName,
      ...(opts?.executor ? { sql: opts.executor } : {}),
      extra: {
        sourceId,
        platformName: platform.name,
        sourceColumns: (src.config as any)?.columns,
      },
    });
    if (reviewContext && opts?.manageSchemaReviewState !== false) {
      if (report.error) {
        const rawError = report.error;
        console.error("[module-engine] ETL report error", {
          moduleCode: mod.code,
          sourceId,
          error: rawError,
        });
        report.error = publicProcessingError(rawError);
        if (reviewContext.previous?.moduleCode === mod.code) {
          report.schemaReview = await markSourceSchemaReviewAwaitingRetry(
            sourceId,
            mod.code,
            reviewContext.diff,
            {
              moduleVersion: reviewContext.moduleVersion,
              schemaFingerprint: reviewContext.schemaFingerprint,
              stagedDecisions:
                reviewContext.previous.stagedDecisions ?? [],
              retryMessage: report.error,
              operationId: reviewContext.previous.operationId,
              sourceIds: reviewContext.previous.sourceIds,
              schemaFingerprints:
                reviewContext.previous.schemaFingerprints,
            },
          );
        }
      } else {
        await clearSourceSchemaReview(sourceId, mod.code);
      }
    }
    return report;
  } catch (error: any) {
    if (
      reviewContext &&
      reviewContext.previous?.moduleCode === mod.code &&
      opts?.manageSchemaReviewState !== false
    ) {
      await markSourceSchemaReviewAwaitingRetry(
        sourceId,
        mod.code,
        reviewContext.diff,
        {
          moduleVersion: reviewContext.moduleVersion,
          schemaFingerprint: reviewContext.schemaFingerprint,
          stagedDecisions: reviewContext.previous.stagedDecisions ?? [],
          retryMessage: "处理失败，请重试",
          operationId: reviewContext.previous.operationId,
          sourceIds: reviewContext.previous.sourceIds,
          schemaFingerprints: reviewContext.previous.schemaFingerprints,
        },
      );
    }
    throw error;
  }
}

/**
 * 取所有启用的模块（给路由/前端用）
 */
export async function listEnabledModules() {
  const mods = await loadModules();
  return mods.filter((m) => m.enabled);
}

/**
 * 给一个模块代号，返回它的输出表名（汇总页/AI 出图调用）
 */
export async function getModuleOutputTable(code: string): Promise<string | null> {
  const mods = await loadModules();
  const m = mods.find((mod) => mod.code === code);
  if (!m) return null;
  return m.outputTable ?? `unified_${m.code}`;
}
