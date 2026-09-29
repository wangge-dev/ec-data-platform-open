import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z, ZodError } from "zod";
import { db, sql } from "../db/client.js";
import { authMiddleware, type AuthPayload } from "../lib/auth.js";
import { adminGuard } from "../lib/admin-guard.js";
import { runModuleEtl } from "../modules/engine.js";
import {
  invalidateModuleCache,
  loadModules,
  type LoadedModule,
} from "../modules/loader.js";
import { validateModuleConfig } from "../modules/schema.js";
import {
  assignAndRunSources,
  createAndRunUserModule,
  CreateModuleRequestSchema,
  IdempotencyConflictError,
  ModuleBuilderInputError,
  parseIdempotencyClaim,
  type IdempotencyClaim,
  type ModuleBuilderDeps,
  type PendingIdempotencyClaim,
} from "../services/module-builder.js";
import {
  activateSchemaDecisionsInTransaction,
  createModuleConfigStore,
  lockModuleConfigInTransaction,
  listSchemaDecisionsInTransaction,
  ModuleConfigAlreadyExistsError,
  ModuleConfigVersionConflictError,
  type TransactionSqlExecutor,
} from "../services/module-config-store.js";
import {
  diffModuleSchema,
  inspectModuleSources,
  type InspectorOptions,
  type SchemaDiff,
  type SourceInspection,
} from "../services/module-source-inspector.js";
import {
  ensureDefaultModuleCharts,
} from "../services/default-module-charts.js";
import {
  applySchemaDecisions,
  schemaDiffBlocksProcessing,
  sourceSchemaFingerprint,
  unresolvedSchemaDiff,
  validateSchemaDecisionSet,
} from "../services/module-schema-review.js";
import {
  assertSourceSchemaReviewOperation,
  assignSourceToModule,
  clearSourceSchemaReview,
  markSourceSchemaReviewAwaitingRetry,
  readSourceSchemaReview,
  readSourceSchemaReviewOperation,
  SourceSchemaReviewStateError,
  type PendingSourceSchemaReview,
  type SourceSchemaReviewOperation,
  type SourceSchemaReviewExpectation,
} from "../services/source-schema-review-state.js";
import { publicProcessingError } from "../services/public-processing-error.js";
import {
  publicDiyModuleManifest,
  validateDiyModuleManifest,
} from "../services/module-manifest.js";
import { loadConnectorManifests } from "../services/connector-manifest.js";
import {
  assertVerticalSolutionConnectorRequirements,
  buildVerticalSolutionManifest,
  publicVerticalSolutionManifest,
  validateVerticalSolutionManifest,
  VerticalSolutionManifestError,
  type VerticalSolutionManifest,
} from "../services/vertical-solution-manifest.js";
import { planVerticalSolutionApplication } from "../services/vertical-solution-lifecycle.js";

const SourceIdsSchema = z.object({
  sourceIds: z
    .array(z.number().int().positive())
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "sourceIds cannot contain duplicates",
    }),
});

const InspectSourcesSchema = SourceIdsSchema.extend({
  // The builder's status step needs these counts; create and schema-diff paths
  // deliberately keep the inspector's expensive grouped query disabled.
  includeStatusValues: z.boolean().optional().default(true),
  statusSource: z.string().trim().min(1).max(256).optional(),
});

const SolutionExportSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
  version: z.number().int().positive().default(1),
  label: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(500).optional(),
  moduleCodes: z
    .array(z.string().regex(/^[a-z][a-z0-9_]*$/))
    .min(1)
    .max(50)
    .refine((codes) => new Set(codes).size === codes.length, {
      message: "moduleCodes cannot contain duplicates",
    }),
  connectorIds: z
    .array(z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/))
    .max(20)
    .default([])
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "connectorIds cannot contain duplicates",
    }),
});

const SolutionModuleVersionExpectationSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]*$/),
  version: z.number().int().positive(),
}).strict();

const SolutionApplySchema = z.object({
  manifest: z.unknown(),
  expectedModuleVersions: z
    .array(SolutionModuleVersionExpectationSchema)
    .max(50)
    .refine(
      (items) => new Set(items.map((item) => item.code)).size === items.length,
      { message: "expectedModuleVersions cannot contain duplicate codes" },
    ),
}).strict();

const SolutionRollbackSchema = z.object({
  schemaVersion: z.literal("solution-rollback/v1"),
  solutionId: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
  fromSolutionVersion: z.number().int().positive(),
  toSolutionVersion: z.number().int().positive(),
  modules: z
    .array(z.object({
      code: z.string().regex(/^[a-z][a-z0-9_]*$/),
      expectedVersion: z.number().int().positive(),
      restoreVersion: z.number().int().positive(),
    }).strict())
    .min(1)
    .max(50)
    .refine(
      (items) => new Set(items.map((item) => item.code)).size === items.length,
      { message: "rollback modules cannot contain duplicate codes" },
    ),
}).strict().refine(
  (receipt) => receipt.fromSolutionVersion > receipt.toSolutionVersion,
  { message: "rollback source version must be newer than target version" },
);

const solutionPackageBodyLimit = bodyLimit({
  maxSize: 2 * 1024 * 1024,
  onError: (c) => c.json({
    ok: false,
    code: "SOLUTION_PACKAGE_TOO_LARGE",
    message: "方案包超过 2 MiB 限制。",
  }, 413),
});

const SchemaDecisionsSchema = z.object({
  decisions: z
    .array(
      z
        .object({
          sourceField: z.string().trim().min(1).max(256),
          decision: z.enum(["add", "alias", "ignore"]),
          targetField: z.string().trim().min(1).max(64).optional(),
          dataType: z
            .enum(["text", "int", "numeric", "timestamp", "date", "boolean"])
            .optional(),
          label: z.string().trim().min(1).max(256).optional(),
        })
        .superRefine((decision, ctx) => {
          if (decision.decision === "alias" && !decision.targetField) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["targetField"],
              message: "alias decisions require targetField",
            });
          }
          if (decision.decision === "add" && !decision.dataType) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["dataType"],
              message: "add decisions require dataType",
            });
          }
        }),
    )
    .min(1),
  sourceIds: z.array(z.number().int().positive()).min(1),
  expectedVersion: z.number().int().positive(),
  operationId: z.string().uuid(),
  schemaFingerprints: z.record(z.string().regex(/^[a-f0-9]{64}$/)),
});

export type ModuleBuilderRouteDeps = ModuleBuilderDeps & {
  diffSchema(module: LoadedModule, inspection: SourceInspection): SchemaDiff;
  readSourceSchemaReview(
    sourceId: number,
  ): Promise<{ moduleCode?: string; schemaReview?: PendingSourceSchemaReview } | null>;
  markSourceSchemaReviewAwaitingRetry: typeof markSourceSchemaReviewAwaitingRetry;
  clearSourceSchemaReview(
    sourceId: number,
    moduleCode: string,
    executor?: TransactionSqlExecutor,
  ): Promise<void>;
  readSourceSchemaReviewOperation(
    sourceId: number,
    moduleCode: string,
    executor?: TransactionSqlExecutor,
    options?: { forUpdate?: boolean; expectedSourceIds?: number[] },
  ): Promise<SourceSchemaReviewOperation>;
  withSchemaReviewTransaction<T>(
    work: (executor: TransactionSqlExecutor) => Promise<T>,
  ): Promise<T>;
  inspectSourcesWithExecutor(
    sourceIds: number[],
    executor: TransactionSqlExecutor,
  ): Promise<SourceInspection>;
};

type ModuleBuilderRouteEnv = { Variables: { user: AuthPayload } };
type ModuleBuilderRouteContext = Context<ModuleBuilderRouteEnv>;

function jsonValue(value: unknown): string {
  return JSON.stringify(value);
}

function productionDeps(): ModuleBuilderRouteDeps {
  const store = createModuleConfigStore(db);
  return {
    store,
    inspectSources(sourceIds: number[], options: InspectorOptions) {
      return inspectModuleSources(sourceIds, undefined, options);
    },
    diffSchema: diffModuleSchema,
    async assignSource(sourceId, moduleCode) {
      await assignSourceToModule(sourceId, moduleCode);
    },
    runEtl: runModuleEtl,
    readSourceSchemaReview,
    readSourceSchemaReviewOperation(sourceId, moduleCode, executor, options) {
      return readSourceSchemaReviewOperation(
        sourceId,
        moduleCode,
        executor,
        options,
      );
    },
    withSchemaReviewTransaction(work) {
      return sql.begin((tx) =>
        work(tx as unknown as TransactionSqlExecutor),
      ) as Promise<any>;
    },
    inspectSourcesWithExecutor(sourceIds, executor) {
      return inspectModuleSources(
        sourceIds,
        { sql: executor },
        { includeStatusValues: false },
      );
    },
    markSourceSchemaReviewAwaitingRetry,
    clearSourceSchemaReview,
    ensureDefaultModuleCharts,
    async insertIdempotencyClaim(
      key: string,
      claim: PendingIdempotencyClaim,
      leaseDurationMs: number,
    ) {
      const rows = await sql.unsafe(
        `INSERT INTO public.settings(key, value, updated_at)
         VALUES(
           $1,
           jsonb_set(
             $2::jsonb,
             '{leaseExpiresAt}',
             to_jsonb(
               (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
                 + $3::bigint
             )
           )::text,
           NOW()
         )
         ON CONFLICT(key) DO NOTHING
         RETURNING key`,
        [`module_create:${key}`, jsonValue(claim), leaseDurationMs],
      );
      return rows.length === 1;
    },
    async readIdempotencyClaim(key) {
      const rows = await sql.unsafe(
        "SELECT value FROM public.settings WHERE key = $1 LIMIT 1",
        [`module_create:${key}`],
      );
      if (!rows[0]?.value) return null;
      try {
        return parseIdempotencyClaim(JSON.parse(String(rows[0].value)));
      } catch {
        // Legacy/unparseable values cannot be safely associated with this actor
        // and request, so never replay them.
        throw new IdempotencyConflictError();
      }
    },
    async replaceIdempotencyClaim(
      key: string,
      expectedOwnerToken: string,
      claim: IdempotencyClaim,
      leaseDurationMs?: number,
    ) {
      const storedValue =
        leaseDurationMs === undefined
          ? "$3"
          : `jsonb_set(
               $3::jsonb,
               '{leaseExpiresAt}',
               to_jsonb(
                 (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
                   + $4::bigint
               )
             )::text`;
      const expiredLeaseGuard =
        leaseDurationMs === undefined
          ? ""
          : `AND (value::jsonb ->> 'leaseExpiresAt')::bigint
                   <= (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint`;
      const rows = await sql.unsafe(
        `UPDATE public.settings
         SET value = ${storedValue}, updated_at = NOW()
         WHERE key = $1
           AND value::jsonb ->> 'state' = 'pending'
           AND value::jsonb ->> 'ownerToken' = $2
           ${expiredLeaseGuard}
         RETURNING key`,
        [
          `module_create:${key}`,
          expectedOwnerToken,
          jsonValue(claim),
          ...(leaseDurationMs === undefined ? [] : [leaseDurationMs]),
        ],
      );
      return rows.length === 1;
    },
    async renewIdempotencyClaim(
      key: string,
      expectedOwnerToken: string,
      leaseDurationMs: number,
    ) {
      const rows = await sql.unsafe(
        `UPDATE public.settings
         SET value = jsonb_set(
               value::jsonb,
               '{leaseExpiresAt}',
               to_jsonb(
                 GREATEST(
                   (value::jsonb ->> 'leaseExpiresAt')::bigint,
                   (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
                     + $3::bigint
                 )
               )
             )::text,
             updated_at = NOW()
         WHERE key = $1
           AND value::jsonb ->> 'state' = 'pending'
           AND value::jsonb ->> 'ownerToken' = $2
           AND (value::jsonb ->> 'leaseExpiresAt')::bigint
                 > (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
         RETURNING value`,
        [
          `module_create:${key}`,
          expectedOwnerToken,
          leaseDurationMs,
        ],
      );
      if (!rows[0]?.value) return null;
      try {
        const claim = parseIdempotencyClaim(
          JSON.parse(String(rows[0].value)),
        );
        return claim.state === "pending" ? claim : null;
      } catch {
        return null;
      }
    },
    loadModules,
    invalidateModuleCache,
  };
}

function errorResponse(c: ModuleBuilderRouteContext, error: unknown) {
  if (error instanceof VerticalSolutionManifestError) {
    return c.json({
      ok: false,
      code: error.code,
      message: error.publicMessage,
      ...(error.details ? { details: error.details } : {}),
    }, error.status);
  }
  if (error instanceof ModuleConfigAlreadyExistsError) {
    return c.json({
      ok: false,
      code: "MODULE_CONFIG_ALREADY_EXISTS",
      message: error.message,
      details: { moduleCode: error.code },
    }, 409);
  }
  if (
    error instanceof IdempotencyConflictError ||
    error instanceof ModuleConfigVersionConflictError
  ) {
    return c.json({ ok: false, message: error.message }, 409);
  }
  if (error instanceof SourceSchemaReviewStateError) {
    return c.json({ ok: false, message: error.message }, error.status);
  }
  const message =
    error instanceof ZodError
      ? error.issues.map((issue) => issue.message).join("; ")
      : error instanceof Error
        ? error.message
        : String(error);
  const isSafeConfigError =
    error instanceof Error &&
    (/^\[模块配置错误\]/.test(error.message) ||
      /^Invalid built-in overlay:/.test(error.message) ||
      /^Built-in module origin collision:/.test(error.message) ||
      /^DIY 模块清单/.test(error.message) ||
      /^Module config (?:not found|is archived|version not found):/.test(
        error.message,
      ));
  if (
    error instanceof ZodError ||
    error instanceof ModuleBuilderInputError ||
    isSafeConfigError
  ) {
    return c.json({ ok: false, message }, 400);
  }
  console.error("[module-builder]", error);
  return c.json({ ok: false, message: "服务器内部错误" }, 500);
}

async function parseJson(c: ModuleBuilderRouteContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ModuleBuilderInputError("Request body must be valid JSON");
  }
}

function actor(c: ModuleBuilderRouteContext): AuthPayload {
  return c.get("user");
}

async function findModule(
  deps: ModuleBuilderRouteDeps,
  code: string,
): Promise<LoadedModule | null> {
  return (await deps.loadModules()).find((module) => module.code === code) ?? null;
}

async function reload(deps: ModuleBuilderRouteDeps): Promise<void> {
  deps.invalidateModuleCache();
  await deps.loadModules(true);
}

async function inspectOperation(
  deps: ModuleBuilderRouteDeps,
  sourceIds: number[],
  executor?: TransactionSqlExecutor,
): Promise<{
  inspection: SourceInspection;
  fingerprints: Record<string, string>;
}> {
  const inspect = (ids: number[]) =>
    executor
      ? deps.inspectSourcesWithExecutor(ids, executor)
      : deps.inspectSources(ids, { includeStatusValues: false });
  const inspection = await inspect(sourceIds);
  const entries = await Promise.all(
    sourceIds.map(async (sourceId) => [
      String(sourceId),
      sourceSchemaFingerprint(await inspect([sourceId])),
    ] as const),
  );
  return { inspection, fingerprints: Object.fromEntries(entries) };
}

function sameRecord(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  return JSON.stringify(Object.entries(left).sort()) ===
    JSON.stringify(Object.entries(right).sort());
}

function schemaReviewExpectation(
  moduleCode: string,
  body: z.infer<typeof SchemaDecisionsSchema>,
): SourceSchemaReviewExpectation {
  return {
    moduleCode,
    operationId: body.operationId,
    sourceIds: [...new Set(body.sourceIds)].sort((left, right) => left - right),
    moduleVersion: body.expectedVersion,
    schemaFingerprints: body.schemaFingerprints,
    allowedStatuses: ["pending", "awaiting_retry"],
    stagedDecisions: body.decisions,
  };
}

class SchemaReviewEtlFailure extends Error {
  constructor(
    readonly rawError: unknown,
    readonly files: Array<{
      sourceId: number;
      status: "success" | "failed";
      total: number;
      inserted: number;
      included: number;
      error?: string;
    }>,
    readonly context: {
      operation: SourceSchemaReviewOperation;
      diff: SchemaDiff;
      decisions: z.infer<typeof SchemaDecisionsSchema>["decisions"];
      fingerprints: Record<string, string>;
    },
  ) {
    super("schema review ETL failed");
  }
}

export function createModuleBuilderRoutes(
  injectedDeps?: ModuleBuilderRouteDeps,
) {
  const deps = injectedDeps ?? productionDeps();
  const r = new Hono<ModuleBuilderRouteEnv>();
  r.use("*", authMiddleware);

  // Specific routes intentionally precede every parameterized root operation.
  r.post("/inspect-sources", async (c) => {
    try {
      const body = InspectSourcesSchema.parse(await parseJson(c));
      const result = await deps.inspectSources(body.sourceIds, {
        includeStatusValues: body.includeStatusValues,
        ...(body.statusSource ? { statusSource: body.statusSource } : {}),
      });
      return c.json({ ok: true, data: result });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  r.post("/manifests/validate", adminGuard, async (c) => {
    try {
      const manifest = validateDiyModuleManifest(await parseJson(c));
      return c.json({ ok: true, data: publicDiyModuleManifest(manifest) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  r.post("/manifests/install", adminGuard, async (c) => {
    try {
      const manifest = validateDiyModuleManifest(await parseJson(c));
      const existing = await findModule(deps, manifest.module.code);
      if (existing) {
        throw new ModuleBuilderInputError(`Module already exists: ${manifest.module.code}`);
      }
      const stored = await deps.store.create({
        config: manifest.module,
        actorId: actor(c).uid,
        origin: "user",
      });
      await reload(deps);
      return c.json({
        ok: true,
        data: {
          schemaVersion: manifest.schemaVersion,
          moduleCode: stored.code,
          moduleVersion: stored.version,
          semanticModelId: manifest.module.semanticModel!.id,
          semanticModelVersion: manifest.module.semanticModel!.version,
        },
      }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  r.post("/solutions/export", adminGuard, async (c) => {
    try {
      const body = SolutionExportSchema.parse(await parseJson(c));
      const storedModules = await deps.store.listActive();
      const modulesByCode = new Map(
        storedModules
          .filter((module) => module.origin === "user")
          .map((module) => [module.code, module.config]),
      );
      const missingModuleCodes = body.moduleCodes.filter(
        (code) => !modulesByCode.has(code),
      );
      if (missingModuleCodes.length > 0) {
        throw new ModuleBuilderInputError(
          `User module not found: ${missingModuleCodes.join(", ")}`,
        );
      }

      const connectors = loadConnectorManifests();
      const connectorById = new Map(
        connectors.map((connector) => [connector.id, connector]),
      );
      const missingConnectorIds = body.connectorIds.filter(
        (id) => !connectorById.has(id),
      );
      if (missingConnectorIds.length > 0) {
        throw new VerticalSolutionManifestError(
          "SOLUTION_CONNECTOR_REQUIREMENT_UNMET",
          "垂直方案依赖的连接器未安装。",
          409,
          { connectorIds: missingConnectorIds },
        );
      }

      const manifest = buildVerticalSolutionManifest({
        id: body.id,
        version: body.version,
        label: body.label,
        ...(body.description ? { description: body.description } : {}),
        modules: body.moduleCodes.map((code) => modulesByCode.get(code)!),
        requiredConnectors: body.connectorIds.map((id) => ({
          id,
          version: connectorById.get(id)!.version,
        })),
      });
      return c.json({ ok: true, data: publicVerticalSolutionManifest(manifest) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  r.post("/solutions/validate", adminGuard, solutionPackageBodyLimit, async (c) => {
    try {
      const manifest = validateVerticalSolutionManifest(await parseJson(c));
      assertVerticalSolutionConnectorRequirements(
        manifest,
        loadConnectorManifests(),
      );
      const plan = planVerticalSolutionApplication(
        manifest,
        await deps.store.listActive(),
      );
      return c.json({
        ok: true,
        data: {
          manifest: publicVerticalSolutionManifest(manifest),
          readiness: {
            installable: true,
            ...plan,
          },
        },
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  r.post("/solutions/install", adminGuard, solutionPackageBodyLimit, async (c) => {
    try {
      const manifest = validateVerticalSolutionManifest(await parseJson(c));
      assertVerticalSolutionConnectorRequirements(
        manifest,
        loadConnectorManifests(),
      );
      const result = await deps.store.applySolution({
        manifest,
        actorId: actor(c).uid,
        expectedModuleVersions: [],
      });
      if (result.plan.operation !== "install") {
        throw new VerticalSolutionManifestError(
          "SOLUTION_VERSION_CONFLICT",
          "该目标实例需要执行方案升级，不能通过旧版安装接口覆盖。",
          409,
        );
      }
      // Persistence is already committed. Invalidate synchronously and let the
      // next module read reload lazily so a transient reload failure cannot be
      // reported as an installation failure after the modules were installed.
      deps.invalidateModuleCache();
      return c.json({
        ok: true,
        data: {
          schemaVersion: manifest.schemaVersion,
          solutionId: manifest.id,
          solutionVersion: manifest.version,
          operation: result.plan.operation,
          modules: result.modules.map((module) => ({
            code: module.code,
            version: module.version,
            semanticModelId: module.config.semanticModel!.id,
            semanticModelVersion: module.config.semanticModel!.version,
          })),
        },
      }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  r.post("/solutions/apply", adminGuard, solutionPackageBodyLimit, async (c) => {
    try {
      const body = SolutionApplySchema.parse(await parseJson(c));
      const manifest = validateVerticalSolutionManifest(body.manifest);
      assertVerticalSolutionConnectorRequirements(
        manifest,
        loadConnectorManifests(),
      );
      const result = await deps.store.applySolution({
        manifest,
        actorId: actor(c).uid,
        expectedModuleVersions: body.expectedModuleVersions,
      });
      deps.invalidateModuleCache();
      const modules = result.modules.map((module) => ({
        code: module.code,
        version: module.version,
        semanticModelId: module.config.semanticModel!.id,
        semanticModelVersion: module.config.semanticModel!.version,
      }));
      const rollback = result.plan.operation === "upgrade"
        ? {
            schemaVersion: "solution-rollback/v1" as const,
            solutionId: manifest.id,
            fromSolutionVersion: manifest.version,
            toSolutionVersion: result.plan.currentSolutionVersion!,
            modules: result.plan.expectedModuleVersions.map((previous) => ({
              code: previous.code,
              expectedVersion: modules.find((module) => module.code === previous.code)!.version,
              restoreVersion: previous.version,
            })),
          }
        : undefined;
      return c.json({
        ok: true,
        data: {
          schemaVersion: manifest.schemaVersion,
          solutionId: manifest.id,
          solutionVersion: manifest.version,
          operation: result.plan.operation,
          modules,
          ...(rollback ? { rollback } : {}),
        },
      }, result.plan.operation === "install" ? 201 : 200);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  r.post("/solutions/rollback", adminGuard, async (c) => {
    try {
      const receipt = SolutionRollbackSchema.parse(await parseJson(c));
      const stored = await deps.store.rollbackSolution({
        solutionId: receipt.solutionId,
        fromSolutionVersion: receipt.fromSolutionVersion,
        toSolutionVersion: receipt.toSolutionVersion,
        modules: receipt.modules,
        actorId: actor(c).uid,
      });
      deps.invalidateModuleCache();
      return c.json({
        ok: true,
        data: {
          schemaVersion: receipt.schemaVersion,
          solutionId: receipt.solutionId,
          solutionVersion: receipt.toSolutionVersion,
          modules: stored.map((module) => ({
            code: module.code,
            version: module.version,
            semanticModelId: module.config.semanticModel!.id,
            semanticModelVersion: module.config.semanticModel!.version,
          })),
        },
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  r.get("/:code/schema-diff", async (c) => {
    try {
      const sourceId = z.coerce
        .number()
        .int()
        .positive()
        .parse(c.req.query("sourceId"));
      const module = await findModule(deps, c.req.param("code"));
      if (!module) {
        return c.json({ ok: false, message: "模块不存在" }, 404);
      }
      const operation = assertSourceSchemaReviewOperation(
        await deps.readSourceSchemaReviewOperation(sourceId, module.code),
      );
      if (Number(module.version ?? 1) !== operation.review.moduleVersion) {
        throw new ModuleConfigVersionConflictError();
      }
      const { inspection: sourceInspection, fingerprints } =
        await inspectOperation(deps, operation.review.sourceIds);
      if (
        operation.review.schemaFingerprints &&
        !sameRecord(fingerprints, operation.review.schemaFingerprints)
      ) {
        throw new SourceSchemaReviewStateError(
          "文件字段已变化，请刷新后重试",
          409,
        );
      }
      const storedDecisions =
        await deps.store.listSchemaDecisions(module.code);
      return c.json({
        ok: true,
        data: {
          ...unresolvedSchemaDiff(
            deps.diffSchema(module, sourceInspection),
            storedDecisions,
          ),
          expectedVersion: Number(module.version ?? 1),
          operationId: operation.review.operationId,
          sourceIds: operation.review.sourceIds,
          schemaFingerprints: fingerprints,
          files: operation.sources.map((source) => ({
            sourceId: source.id,
            fileName:
              source.config.originalFileName ?? source.name,
          })),
          reviewStatus: operation.review.status,
          stagedDecisions: operation.review.stagedDecisions ?? [],
          retryMessage: operation.review.retryMessage,
        },
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  r.post("/:code/schema-decisions", async (c) => {
    try {
      const code = c.req.param("code");
      const module = await findModule(deps, code);
      if (!module) {
        return c.json({ ok: false, message: "模块不存在" }, 404);
      }
      if (module.origin !== "user") {
        throw new ModuleBuilderInputError("仅自建模块支持确认字段变化");
      }
      const body = SchemaDecisionsSchema.parse(await parseJson(c));
      const expectation = schemaReviewExpectation(code, body);
      const anchorId = expectation.sourceIds[0];
      assertSourceSchemaReviewOperation(
        await deps.readSourceSchemaReviewOperation(anchorId, code),
        expectation,
      );

      const transactionResult = await deps.withSchemaReviewTransaction(
        async (executor) => {
          const locked = await lockModuleConfigInTransaction(executor, code);
          if (
            locked.version !== body.expectedVersion ||
            locked.origin !== "user"
          ) {
            throw new ModuleConfigVersionConflictError();
          }
          const operation = assertSourceSchemaReviewOperation(
            await deps.readSourceSchemaReviewOperation(
              anchorId,
              code,
              executor,
              {
                forUpdate: true,
                expectedSourceIds: expectation.sourceIds,
              },
            ),
            expectation,
          );
          const { inspection, fingerprints } = await inspectOperation(
            deps,
            operation.review.sourceIds,
            executor,
          );
          if (
            !sameRecord(fingerprints, body.schemaFingerprints) ||
            !sameRecord(fingerprints, operation.review.schemaFingerprints)
          ) {
            throw new SourceSchemaReviewStateError(
              "文件字段已变化，请刷新后重试",
              409,
            );
          }
          const active = {
            ...locked.config,
            origin: "user" as const,
            version: locked.version,
            configurable: true,
          } as LoadedModule;
          const storedDecisions = await listSchemaDecisionsInTransaction(
            executor,
            code,
          );
          const currentDiff = unresolvedSchemaDiff(
            deps.diffSchema(active, inspection),
            storedDecisions,
          );
          const validationErrors = validateSchemaDecisionSet(
            currentDiff,
            body.decisions,
          );
          if (validationErrors.length > 0) {
            throw new ModuleBuilderInputError(validationErrors.join("；"));
          }
          const updatedConfig = applySchemaDecisions(active, body.decisions);
          const projectedDiff = unresolvedSchemaDiff(
            deps.diffSchema(updatedConfig as LoadedModule, inspection),
            [...storedDecisions, ...body.decisions],
          );
          if (schemaDiffBlocksProcessing(projectedDiff)) {
            throw new ModuleBuilderInputError("仍有必要字段尚未对应");
          }
          const candidate = {
            ...updatedConfig,
            origin: "user" as const,
            version: body.expectedVersion,
            configurable: true,
          } as LoadedModule;
          const files: SchemaReviewEtlFailure["files"] = [];
          const failureContext = {
            operation,
            diff: currentDiff,
            decisions: body.decisions,
            fingerprints,
          };
          try {
            for (const sourceId of operation.review.sourceIds) {
              let report;
              try {
                report = await deps.runEtl(sourceId, {
                  moduleCode: code,
                  moduleOverride: candidate,
                  manageSchemaReviewState: false,
                  executor,
                });
              } catch (error) {
                files.push({
                  sourceId,
                  status: "failed",
                  total: 0,
                  inserted: 0,
                  included: 0,
                  error: publicProcessingError(error),
                });
                throw new SchemaReviewEtlFailure(
                  error,
                  files,
                  failureContext,
                );
              }
              files.push({
                sourceId,
                status: report && !report.error ? "success" : "failed",
                total: Number(report?.total ?? 0),
                inserted: Number(report?.inserted ?? 0),
                included: Number(report?.included ?? report?.inserted ?? 0),
                ...(report?.error
                  ? { error: publicProcessingError(report.error) }
                  : {}),
              });
              if (!report || report.error) {
                throw new SchemaReviewEtlFailure(
                  report?.error ?? "missing ETL report",
                  files,
                  failureContext,
                );
              }
            }
            await activateSchemaDecisionsInTransaction(
              executor,
              {
                code,
                config: updatedConfig,
                decisions: body.decisions.map(
                  ({ label: _label, ...decision }) => decision,
                ),
                actorId: actor(c).uid,
                expectedVersion: body.expectedVersion,
              },
              locked,
            );
            await Promise.all(
              operation.review.sourceIds.map((sourceId) =>
                deps.clearSourceSchemaReview(sourceId, code, executor),
              ),
            );
            return { operation, files, candidate };
          } catch (error) {
            if (
              error instanceof SchemaReviewEtlFailure ||
              error instanceof ModuleConfigVersionConflictError ||
              error instanceof SourceSchemaReviewStateError ||
              error instanceof ModuleBuilderInputError
            ) {
              throw error;
            }
            throw new SchemaReviewEtlFailure(
              error,
              files,
              failureContext,
            );
          }
        },
      );
      try {
        await reload(deps);
      } catch (cacheError) {
        console.error("[module-builder:schema-review] cache reload failed", {
          moduleCode: code,
          error: cacheError,
        });
      }
      const activatedModule =
        await findModule(deps, code).catch(() => null) ??
        transactionResult.candidate;
      const result = { moduleCode: code, files: transactionResult.files };
      if (activatedModule) {
        try {
          await deps.ensureDefaultModuleCharts(activatedModule);
        } catch {
          // ETL and configuration activation succeeded; charts can be retried.
        }
      }
      return c.json({ ok: true, data: result });
    } catch (error) {
      if (error instanceof SchemaReviewEtlFailure) {
        const {
          operation,
          diff,
          decisions,
          fingerprints,
        } = error.context;
        const rawError = error.rawError;
        const files = error.files;
        console.error("[module-builder:schema-review] transaction rolled back", {
          moduleCode: c.req.param("code"),
          operationId: operation.review.operationId,
          error: rawError,
        });
        const retryMessage = publicProcessingError(rawError);
        let awaitingRetry = false;
        try {
          awaitingRetry = await deps.withSchemaReviewTransaction(
            async (executor) => {
              const locked = await lockModuleConfigInTransaction(
                executor,
                c.req.param("code"),
              );
              if (
                locked.origin !== "user" ||
                locked.version !== operation.review.moduleVersion
              ) {
                return false;
              }
              let current: SourceSchemaReviewOperation;
              try {
                current = assertSourceSchemaReviewOperation(
                  await deps.readSourceSchemaReviewOperation(
                    operation.review.sourceIds[0],
                    c.req.param("code"),
                    executor,
                    {
                      forUpdate: true,
                      expectedSourceIds: operation.review.sourceIds,
                    },
                  ),
                  {
                    moduleCode: c.req.param("code"),
                    operationId: operation.review.operationId,
                    sourceIds: operation.review.sourceIds,
                    moduleVersion: operation.review.moduleVersion,
                    schemaFingerprints: fingerprints,
                    allowedStatuses: ["pending", "awaiting_retry"],
                    stagedDecisions: decisions,
                  },
                );
              } catch (stateError) {
                if (stateError instanceof SourceSchemaReviewStateError) {
                  return false;
                }
                throw stateError;
              }
              await Promise.all(
                current.review.sourceIds.map((sourceId) =>
                  deps.markSourceSchemaReviewAwaitingRetry(
                    sourceId,
                    c.req.param("code"),
                    diff,
                    {
                      moduleVersion: current.review.moduleVersion,
                      schemaFingerprint: fingerprints[String(sourceId)],
                      schemaFingerprints: fingerprints,
                      sourceIds: current.review.sourceIds,
                      operationId: current.review.operationId,
                      stagedDecisions: decisions,
                      retryMessage,
                    },
                    executor,
                  ),
                ),
              );
              return true;
            },
          );
        } catch (markerError) {
          console.error(
            "[module-builder:schema-review] retry marker transaction failed",
            {
              moduleCode: c.req.param("code"),
              operationId: operation.review.operationId,
              error: markerError,
            },
          );
        }
        return c.json({
          ok: true,
          data: {
            moduleCode: c.req.param("code"),
            files,
            awaitingRetry,
          },
        });
      }
      return errorResponse(c, error);
    }
  });

  r.get("/:code/versions", async (c) => {
    try {
      const code = c.req.param("code");
      const module = await findModule(deps, code);
      if (!module) {
        return c.json({ ok: false, message: "模块不存在" }, 404);
      }
      return c.json({
        ok: true,
        data: await deps.store.listVersions(code),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  r.post("/:code/versions/:version{[0-9]+}/restore", adminGuard, async (c) => {
    try {
      const code = c.req.param("code");
      const module = await findModule(deps, code);
      if (!module) {
        return c.json({ ok: false, message: "模块不存在" }, 404);
      }
      const version = z.coerce
        .number()
        .int()
        .positive()
        .parse(c.req.param("version"));
      const stored = await deps.store.restore(code, version, actor(c).uid);
      await reload(deps);
      return c.json({
        ok: true,
        data: { moduleCode: stored.code, version: stored.version },
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  r.post("/:code/archive", adminGuard, async (c) => {
    try {
      const code = c.req.param("code");
      const module = await findModule(deps, code);
      if (!module) {
        return c.json({ ok: false, message: "模块不存在" }, 404);
      }
      if (module.origin !== "user") {
        throw new ModuleBuilderInputError("Built-in modules cannot be archived");
      }
      await deps.store.archive(code, actor(c).uid);
      await reload(deps);
      return c.json({ ok: true, data: { moduleCode: code, archived: true } });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  r.post("/:code/assign-and-run", async (c) => {
    try {
      const code = c.req.param("code");
      const module = await findModule(deps, code);
      if (!module) {
        return c.json({ ok: false, message: "模块不存在" }, 404);
      }
      const body = SourceIdsSchema.parse(await parseJson(c));
      return c.json({
        ok: true,
        data: await assignAndRunSources(code, body.sourceIds, deps, { module }),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  r.post("/", async (c) => {
    try {
      const body = CreateModuleRequestSchema.parse(await parseJson(c));
      const created = await createAndRunUserModule(body, actor(c).uid, deps);
      return c.json(
        { ok: true, data: created.result },
        created.replayed ? 200 : 201,
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  r.patch("/:code", adminGuard, async (c) => {
    try {
      const code = c.req.param("code");
      const existing = await findModule(deps, code);
      if (!existing) {
        return c.json({ ok: false, message: "模块不存在" }, 404);
      }
      const config = validateModuleConfig({
        ...(await parseJson(c) as object),
        code,
      });
      if (existing.origin === "user" && config.hasTransform) {
        throw new ModuleBuilderInputError(
          "User modules cannot enable transform hooks",
        );
      }
      const stored =
        existing.origin === "builtin" && existing.version === undefined
          ? await deps.store.create({
              config,
              actorId: actor(c).uid,
              origin: "builtin_overlay",
            })
          : await deps.store.update(code, config, actor(c).uid);
      await reload(deps);
      return c.json({
        ok: true,
        data: { moduleCode: stored.code, version: stored.version },
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  return r;
}

export default createModuleBuilderRoutes();
