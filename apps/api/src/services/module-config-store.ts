import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, sql as drizzleSql } from "drizzle-orm";
import {
  moduleConfigs,
  moduleConfigVersions,
  moduleSchemaDecisions,
} from "../db/schema.js";
import { getModule } from "../modules/loader.js";
import {
  validateModuleConfig,
  type ColumnDef,
  type ModuleDef,
} from "../modules/schema.js";
import {
  assertFrontProfitModuleContractPreserved,
  assertFrontProfitModuleContractValid,
} from "./front-profit-standard.js";
import {
  VerticalSolutionManifestError,
  type VerticalSolutionManifest,
} from "./vertical-solution-manifest.js";
import {
  assertSolutionVersionExpectations,
  assertVerticalSolutionModuleUpgradeCompatible,
  planVerticalSolutionApplication,
  portableModuleFingerprint,
  type SolutionModuleVersionExpectation,
  type VerticalSolutionApplicationPlan,
} from "./vertical-solution-lifecycle.js";

export type StoredModuleConfig = {
  code: string;
  name: string;
  category: string | null;
  description: string;
  config: ModuleDef;
  version: number;
  origin: "user" | "builtin_overlay";
  status: "active" | "archived";
  createdBy: number;
};

export type CreateStoredModuleInput = {
  config: ModuleDef;
  actorId: number;
  origin: StoredModuleConfig["origin"];
};

export type StoredModuleVersion = {
  moduleCode: string;
  version: number;
  config: ModuleDef;
  createdBy: number;
  createdAt: string;
};

export type StoredSchemaDecision = {
  moduleCode: string;
  sourceField: string;
  decision: "add" | "alias" | "ignore";
  targetField?: string;
  dataType?: ColumnDef["type"];
  createdBy: number;
};

export type ModuleConfigPersistenceAdapter = {
  transaction<T>(
    work: (adapter: ModuleConfigPersistenceAdapter) => Promise<T>,
  ): Promise<T>;
  lockModule(code: string): Promise<void>;
  listActiveRows(): Promise<StoredModuleConfig[]>;
  findCurrent(code: string): Promise<StoredModuleConfig | null>;
  insertCurrent(module: StoredModuleConfig): Promise<StoredModuleConfig>;
  updateCurrent(
    code: string,
    update: Pick<
      StoredModuleConfig,
      "name" | "category" | "description" | "config" | "version" | "status"
    >,
  ): Promise<StoredModuleConfig | null>;
  updateCurrentIfVersion(
    code: string,
    expectedVersion: number,
    update: Pick<
      StoredModuleConfig,
      "name" | "category" | "description" | "config" | "version" | "status"
    >,
  ): Promise<StoredModuleConfig | null>;
  insertVersion(
    version: Omit<StoredModuleVersion, "createdAt">,
  ): Promise<void>;
  listVersionRows(code: string): Promise<StoredModuleVersion[]>;
  findVersion(
    code: string,
    version: number,
  ): Promise<StoredModuleVersion | null>;
  archiveCurrent(
    code: string,
    version: number,
  ): Promise<StoredModuleConfig | null>;
  upsertDecision(decision: StoredSchemaDecision): Promise<void>;
  listDecisionRows(code: string): Promise<StoredSchemaDecision[]>;
};

export type ModuleConfigStore = {
  listActive(): Promise<StoredModuleConfig[]>;
  create(input: CreateStoredModuleInput): Promise<StoredModuleConfig>;
  createMany(inputs: CreateStoredModuleInput[]): Promise<StoredModuleConfig[]>;
  applySolution(input: {
    manifest: VerticalSolutionManifest;
    actorId: number;
    expectedModuleVersions: SolutionModuleVersionExpectation[];
  }): Promise<{
    plan: VerticalSolutionApplicationPlan;
    modules: StoredModuleConfig[];
  }>;
  rollbackSolution(input: {
    solutionId: string;
    fromSolutionVersion: number;
    toSolutionVersion: number;
    modules: Array<{
      code: string;
      expectedVersion: number;
      restoreVersion: number;
    }>;
    actorId: number;
  }): Promise<StoredModuleConfig[]>;
  update(
    code: string,
    config: ModuleDef,
    actorId: number,
  ): Promise<StoredModuleConfig>;
  listVersions(
    code: string,
  ): Promise<Array<{ version: number; config: ModuleDef; createdAt: string }>>;
  restore(
    code: string,
    version: number,
    actorId: number,
  ): Promise<StoredModuleConfig>;
  archive(code: string, actorId: number): Promise<void>;
  upsertSchemaDecisions(
    code: string,
    decisions: Array<{
      sourceField: string;
      decision: "add" | "alias" | "ignore";
      targetField?: string;
      dataType?: ColumnDef["type"];
    }>,
    actorId: number,
  ): Promise<void>;
  listSchemaDecisions(code: string): Promise<StoredSchemaDecision[]>;
  activateSchemaDecisions(input: {
    code: string;
    config: ModuleDef;
    decisions: Array<{
      sourceField: string;
      decision: "add" | "alias" | "ignore";
      targetField?: string;
      dataType?: ColumnDef["type"];
    }>;
    actorId: number;
    expectedVersion: number;
  }): Promise<StoredModuleConfig>;
};

export class ModuleConfigVersionConflictError extends Error {
  constructor() {
    super("模块配置已更新，请刷新后重试");
    this.name = "ModuleConfigVersionConflictError";
  }
}

export class ModuleConfigAlreadyExistsError extends Error {
  constructor(readonly code: string) {
    super(`Module config already exists: ${code}`);
    this.name = "ModuleConfigAlreadyExistsError";
  }
}

export type TransactionSqlExecutor = {
  unsafe(query: string, parameters?: unknown[]): PromiseLike<any[]>;
};

export async function lockModuleConfigInTransaction(
  executor: TransactionSqlExecutor,
  code: string,
): Promise<StoredModuleConfig> {
  await executor.unsafe(
    "SELECT pg_advisory_xact_lock(hashtext($1))",
    [`module-config:${code}`],
  );
  const rows = await executor.unsafe(
    `SELECT code, name, category, description, config, version, origin,
            status, created_by AS "createdBy"
     FROM public.module_configs
     WHERE code = $1
     LIMIT 1
     FOR UPDATE`,
    [code],
  );
  if (!rows[0]) throw new Error(`Module config not found: ${code}`);
  return rowToStored(rows[0]);
}

export async function activateSchemaDecisionsInTransaction(
  executor: TransactionSqlExecutor,
  input: Parameters<ModuleConfigStore["activateSchemaDecisions"]>[0],
  locked?: StoredModuleConfig,
): Promise<StoredModuleConfig> {
  const inputConfig = validateModuleConfig(clone(input.config));
  const current = locked ?? await lockModuleConfigInTransaction(executor, input.code);
  const config = current.config.solutionBinding
    ? preserveSolutionBinding(
        inputConfig,
        current.config.solutionBinding,
      )
    : portableModuleConfig(inputConfig);
  assertFrontProfitModuleContractPreserved(current.config, config);
  if (
    config.code !== input.code ||
    current.origin !== "user" ||
    current.status !== "active" ||
    current.version !== input.expectedVersion
  ) {
    throw new ModuleConfigVersionConflictError();
  }
  const version = current.version + 1;
  const rows = await executor.unsafe(
    `UPDATE public.module_configs
     SET name = $1, category = $2, description = $3, config = $4::jsonb,
         version = $5, status = 'active', updated_at = NOW()
     WHERE code = $6 AND version = $7
     RETURNING code, name, category, description, config, version, origin,
               status, created_by AS "createdBy"`,
    [
      config.name,
      config.category ?? null,
      config.description,
      JSON.stringify(config),
      version,
      input.code,
      input.expectedVersion,
    ],
  );
  if (!rows[0]) throw new ModuleConfigVersionConflictError();
  await executor.unsafe(
    `INSERT INTO public.module_config_versions
       (module_code, version, config, created_by)
     VALUES ($1, $2, $3::jsonb, $4)`,
    [input.code, version, JSON.stringify(config), input.actorId],
  );
  for (const decision of input.decisions) {
    await executor.unsafe(
      `INSERT INTO public.module_schema_decisions
         (module_code, source_field, decision, target_field, data_type, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (module_code, source_field) DO UPDATE
       SET decision = EXCLUDED.decision,
           target_field = EXCLUDED.target_field,
           data_type = EXCLUDED.data_type,
           created_by = EXCLUDED.created_by,
           updated_at = NOW()`,
      [
        input.code,
        decision.sourceField,
        decision.decision,
        decision.targetField ?? null,
        decision.dataType ?? null,
        input.actorId,
      ],
    );
  }
  return rowToStored(rows[0]);
}

export async function listSchemaDecisionsInTransaction(
  executor: TransactionSqlExecutor,
  code: string,
): Promise<StoredSchemaDecision[]> {
  const rows = await executor.unsafe(
    `SELECT module_code AS "moduleCode", source_field AS "sourceField",
            decision, target_field AS "targetField", data_type AS "dataType",
            created_by AS "createdBy"
     FROM public.module_schema_decisions
     WHERE module_code = $1
     ORDER BY source_field`,
    [code],
  );
  return rows.map((row) => ({
    moduleCode: row.moduleCode,
    sourceField: row.sourceField,
    decision: row.decision,
    ...(row.targetField ? { targetField: row.targetField } : {}),
    ...(row.dataType ? { dataType: row.dataType } : {}),
    createdBy: Number(row.createdBy),
  }));
}

const BUILTIN_OVERLAY_KEYS = new Set(["platforms"]);
const BUILTIN_PLATFORM_OVERLAY_KEYS = new Set([
  "filePattern",
  "patternFlags",
  "columnOverrides",
]);

const clone = <T>(value: T): T => structuredClone(value);

function portableModuleConfig(config: ModuleDef): ModuleDef {
  const { solutionBinding: _solutionBinding, ...portable } = config;
  return validateModuleConfig(clone(portable));
}

function bindModuleToSolution(
  config: ModuleDef,
  solutionId: string,
  solutionVersion: number,
): ModuleDef {
  const portable = portableModuleConfig(config);
  return validateModuleConfig({
    ...portable,
    solutionBinding: {
      schemaVersion: "solution-binding/v1",
      solutionId,
      solutionVersion,
      moduleFingerprint: portableModuleFingerprint(portable),
    },
  });
}

function preserveSolutionBinding(
  config: ModuleDef,
  solutionBinding: NonNullable<ModuleDef["solutionBinding"]>,
): ModuleDef {
  return validateModuleConfig({
    ...portableModuleConfig(config),
    solutionBinding: clone(solutionBinding),
  });
}

function isPersistenceAdapter(
  value: unknown,
): value is ModuleConfigPersistenceAdapter {
  return (
    typeof value === "object" &&
    value !== null &&
    "listActiveRows" in value &&
    "insertCurrent" in value &&
    "insertVersion" in value
  );
}

function rowToStored(row: any): StoredModuleConfig {
  return {
    code: row.code,
    name: row.name,
    category: row.category ?? null,
    description: row.description,
    config: clone(row.config as ModuleDef),
    version: row.version,
    origin: row.origin,
    status: row.status,
    createdBy: Number(row.createdBy),
  };
}

function createdAtString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function createDrizzleAdapter(
  executor: any,
  root = true,
): ModuleConfigPersistenceAdapter {
  const adapter: ModuleConfigPersistenceAdapter = {
    async transaction<T>(
      work: (tx: ModuleConfigPersistenceAdapter) => Promise<T>,
    ): Promise<T> {
      if (!root) return work(adapter);
      return executor.transaction((tx: any) =>
        work(createDrizzleAdapter(tx, false)),
      );
    },
    async listActiveRows() {
      const rows = await executor
        .select()
        .from(moduleConfigs)
        .where(eq(moduleConfigs.status, "active"))
        .orderBy(asc(moduleConfigs.code));
      return rows.map(rowToStored);
    },
    async lockModule(code) {
      await executor.execute(
        drizzleSql`SELECT pg_advisory_xact_lock(hashtext(${"module-config:" + code}))`,
      );
    },
    async findCurrent(code) {
      const rows = await executor
        .select()
        .from(moduleConfigs)
        .where(eq(moduleConfigs.code, code))
        .limit(1);
      return rows[0] ? rowToStored(rows[0]) : null;
    },
    async insertCurrent(module) {
      const rows = await executor
        .insert(moduleConfigs)
        .values({
          code: module.code,
          name: module.name,
          category: module.category,
          description: module.description,
          config: clone(module.config),
          version: module.version,
          origin: module.origin,
          status: module.status,
          createdBy: module.createdBy,
        })
        .returning();
      return rowToStored(rows[0]);
    },
    async updateCurrent(code, update) {
      const rows = await executor
        .update(moduleConfigs)
        .set({
          name: update.name,
          category: update.category,
          description: update.description,
          config: clone(update.config),
          version: update.version,
          status: update.status,
          updatedAt: new Date(),
        })
        .where(eq(moduleConfigs.code, code))
        .returning();
      return rows[0] ? rowToStored(rows[0]) : null;
    },
    async updateCurrentIfVersion(code, expectedVersion, update) {
      const rows = await executor
        .update(moduleConfigs)
        .set({
          name: update.name,
          category: update.category,
          description: update.description,
          config: clone(update.config),
          version: update.version,
          status: update.status,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(moduleConfigs.code, code),
            eq(moduleConfigs.version, expectedVersion),
          ),
        )
        .returning();
      return rows[0] ? rowToStored(rows[0]) : null;
    },
    async insertVersion(version) {
      await executor.insert(moduleConfigVersions).values({
        moduleCode: version.moduleCode,
        version: version.version,
        config: clone(version.config),
        createdBy: version.createdBy,
      });
    },
    async listVersionRows(code) {
      const rows = await executor
        .select()
        .from(moduleConfigVersions)
        .where(eq(moduleConfigVersions.moduleCode, code))
        .orderBy(asc(moduleConfigVersions.version));
      return rows.map((row: any) => ({
        moduleCode: row.moduleCode,
        version: row.version,
        config: clone(row.config as ModuleDef),
        createdBy: Number(row.createdBy),
        createdAt: createdAtString(row.createdAt),
      }));
    },
    async findVersion(code, version) {
      const rows = await executor
        .select()
        .from(moduleConfigVersions)
        .where(
          and(
            eq(moduleConfigVersions.moduleCode, code),
            eq(moduleConfigVersions.version, version),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row
        ? {
            moduleCode: row.moduleCode,
            version: row.version,
            config: clone(row.config as ModuleDef),
            createdBy: Number(row.createdBy),
            createdAt: createdAtString(row.createdAt),
          }
        : null;
    },
    async archiveCurrent(code, version) {
      const rows = await executor
        .update(moduleConfigs)
        .set({ status: "archived", version, updatedAt: new Date() })
        .where(eq(moduleConfigs.code, code))
        .returning();
      return rows[0] ? rowToStored(rows[0]) : null;
    },
    async upsertDecision(decision) {
      await executor
        .insert(moduleSchemaDecisions)
        .values({
          moduleCode: decision.moduleCode,
          sourceField: decision.sourceField,
          decision: decision.decision,
          targetField: decision.targetField,
          dataType: decision.dataType,
          createdBy: decision.createdBy,
        })
        .onConflictDoUpdate({
          target: [
            moduleSchemaDecisions.moduleCode,
            moduleSchemaDecisions.sourceField,
          ],
          set: {
            decision: decision.decision,
            targetField: decision.targetField,
            dataType: decision.dataType,
            createdBy: decision.createdBy,
            updatedAt: new Date(),
          },
        });
    },
    async listDecisionRows(code) {
      const rows = await executor
        .select()
        .from(moduleSchemaDecisions)
        .where(eq(moduleSchemaDecisions.moduleCode, code))
        .orderBy(asc(moduleSchemaDecisions.sourceField));
      return rows.map((row: any) => ({
        moduleCode: row.moduleCode,
        sourceField: row.sourceField,
        decision: row.decision,
        ...(row.targetField ? { targetField: row.targetField } : {}),
        ...(row.dataType ? { dataType: row.dataType } : {}),
        createdBy: Number(row.createdBy),
      }));
    },
  };
  return adapter;
}

async function assertBuiltinOverlay(config: ModuleDef): Promise<void> {
  const loadedBuiltin = await getModule(config.code);
  if (!loadedBuiltin) {
    throw new Error(
      `Invalid built-in overlay: no built-in module exists for ${config.code}`,
    );
  }
  const { transform: _transform, ...builtin } = loadedBuiltin;

  const topLevelKeys = new Set([
    ...Object.keys(builtin),
    ...Object.keys(config),
  ]);
  for (const key of topLevelKeys) {
    if (BUILTIN_OVERLAY_KEYS.has(key)) continue;
    if (
      !isDeepStrictEqual(
        builtin[key as keyof ModuleDef],
        config[key as keyof ModuleDef],
      )
    ) {
      throw new Error(
        `Invalid built-in overlay: top-level key "${key}" cannot change`,
      );
    }
  }

  const builtinPlatforms = new Map(
    builtin.platforms.map((platform) => [platform.code, platform]),
  );
  const overlayPlatformCodes = new Set(
    config.platforms.map((platform) => platform.code),
  );
  if (
    overlayPlatformCodes.size !== config.platforms.length ||
    builtinPlatforms.size !== builtin.platforms.length ||
    overlayPlatformCodes.size !== builtinPlatforms.size ||
    [...overlayPlatformCodes].some((code) => !builtinPlatforms.has(code))
  ) {
    throw new Error(
      "Invalid built-in overlay: platform membership cannot change",
    );
  }

  for (const platform of config.platforms) {
    const builtinPlatform = builtinPlatforms.get(platform.code)!;
    const platformKeys = new Set([
      ...Object.keys(builtinPlatform),
      ...Object.keys(platform),
    ]);
    for (const key of platformKeys) {
      if (BUILTIN_PLATFORM_OVERLAY_KEYS.has(key)) continue;
      if (
        !isDeepStrictEqual(
          builtinPlatform[key as keyof typeof builtinPlatform],
          platform[key as keyof typeof platform],
        )
      ) {
        throw new Error(
          `Invalid built-in overlay: platform key "${key}" cannot change`,
        );
      }
    }
  }
}

function activeModule(
  config: ModuleDef,
  origin: StoredModuleConfig["origin"],
  version: number,
  createdBy: number,
): StoredModuleConfig {
  return {
    code: config.code,
    name: config.name,
    category: config.category ?? null,
    description: config.description,
    config: clone(config),
    version,
    origin,
    status: "active",
    createdBy,
  };
}

function ensureActive(
  current: StoredModuleConfig | null,
  code: string,
): StoredModuleConfig {
  if (!current) throw new Error(`Module config not found: ${code}`);
  if (current.status !== "active") {
    throw new Error(`Module config is archived: ${code}`);
  }
  return current;
}

export function createModuleConfigStore(
  databaseOrAdapter: unknown,
): ModuleConfigStore {
  const adapter = isPersistenceAdapter(databaseOrAdapter)
    ? databaseOrAdapter
    : createDrizzleAdapter(databaseOrAdapter);

  const persistMany = async (
    inputs: CreateStoredModuleInput[],
    solutionBinding?: { solutionId: string; solutionVersion: number },
  ): Promise<StoredModuleConfig[]> => {
    if (inputs.length === 0) return [];
    const prepared: Array<{
      input: CreateStoredModuleInput;
      config: ModuleDef;
    }> = [];
    const seen = new Set<string>();
    for (const input of inputs) {
      const config = solutionBinding
        ? bindModuleToSolution(
            input.config,
            solutionBinding.solutionId,
            solutionBinding.solutionVersion,
          )
        : portableModuleConfig(input.config);
      assertFrontProfitModuleContractValid(config);
      if (seen.has(config.code)) {
        throw new ModuleConfigAlreadyExistsError(config.code);
      }
      seen.add(config.code);
      if (input.origin === "user") {
        const loaded = await getModule(config.code);
        if (loaded?.origin === "builtin") {
          throw new Error(
            `Built-in module origin collision: ${config.code} cannot be created as a user module`,
          );
        }
      }
      if (input.origin === "builtin_overlay") {
        await assertBuiltinOverlay(config);
      }
      prepared.push({ input, config });
    }

    return adapter.transaction(async (tx) => {
      const orderedCodes = [...seen].sort();
      for (const code of orderedCodes) await tx.lockModule(code);
      for (const code of orderedCodes) {
        if (await tx.findCurrent(code)) {
          throw new ModuleConfigAlreadyExistsError(code);
        }
      }

      const saved: StoredModuleConfig[] = [];
      for (const { input, config } of prepared) {
        const module = activeModule(config, input.origin, 1, input.actorId);
        const current = await tx.insertCurrent(module);
        await tx.insertVersion({
          moduleCode: current.code,
          version: current.version,
          config: current.config,
          createdBy: input.actorId,
        });
        saved.push(clone(current));
      }
      return saved;
    });
  };

  const createMany = async (
    inputs: CreateStoredModuleInput[],
  ): Promise<StoredModuleConfig[]> => persistMany(inputs);

  return {
    async listActive() {
      return clone(await adapter.listActiveRows());
    },
    async create(input) {
      return (await createMany([input]))[0]!;
    },
    createMany,
    async applySolution(input) {
      const prepared = await Promise.all(input.manifest.modules.map(async (item) => {
        const config = bindModuleToSolution(
          item.module,
          input.manifest.id,
          input.manifest.version,
        );
        assertFrontProfitModuleContractValid(config);
        const loaded = await getModule(config.code);
        if (loaded?.origin === "builtin") {
          throw new Error(
            `Built-in module origin collision: ${config.code} cannot be created as a user module`,
          );
        }
        return config;
      }));
      const codes = prepared.map((config) => config.code).sort();

      return adapter.transaction(async (tx) => {
        for (const code of codes) await tx.lockModule(code);
        const plan = planVerticalSolutionApplication(
          input.manifest,
          await tx.listActiveRows(),
        );
        assertSolutionVersionExpectations(
          input.expectedModuleVersions,
          plan.expectedModuleVersions,
        );

        const saved: StoredModuleConfig[] = [];
        if (plan.operation === "install") {
          for (const code of codes) {
            if (await tx.findCurrent(code)) {
              throw new ModuleConfigAlreadyExistsError(code);
            }
          }
          for (const config of prepared) {
            const next = activeModule(config, "user", 1, input.actorId);
            const current = await tx.insertCurrent(next);
            await tx.insertVersion({
              moduleCode: current.code,
              version: current.version,
              config: current.config,
              createdBy: input.actorId,
            });
            saved.push(clone(current));
          }
          return { plan, modules: saved };
        }

        const expectedByCode = new Map(
          input.expectedModuleVersions.map((item) => [item.code, item.version]),
        );
        for (const config of prepared) {
          const current = ensureActive(await tx.findCurrent(config.code), config.code);
          const expectedVersion = expectedByCode.get(config.code);
          if (
            current.origin !== "user"
            || expectedVersion === undefined
            || current.version !== expectedVersion
            || current.config.solutionBinding?.solutionId !== input.manifest.id
            || current.config.solutionBinding.solutionVersion
              !== plan.currentSolutionVersion
          ) {
            throw new ModuleConfigVersionConflictError();
          }
          assertVerticalSolutionModuleUpgradeCompatible(current.config, config);
          assertFrontProfitModuleContractPreserved(current.config, config);
          const next = activeModule(
            config,
            "user",
            current.version + 1,
            current.createdBy,
          );
          const updated = await tx.updateCurrentIfVersion(
            config.code,
            expectedVersion,
            next,
          );
          if (!updated) throw new ModuleConfigVersionConflictError();
          await tx.insertVersion({
            moduleCode: config.code,
            version: next.version,
            config: next.config,
            createdBy: input.actorId,
          });
          saved.push(clone(updated));
        }
        return { plan, modules: saved };
      });
    },
    async rollbackSolution(input) {
      const codes = input.modules.map((module) => module.code);
      if (new Set(codes).size !== codes.length || codes.length === 0) {
        throw new VerticalSolutionManifestError(
          "SOLUTION_ROLLBACK_INVALID",
          "方案回滚凭据中的模块列表无效。",
          400,
        );
      }

      return adapter.transaction(async (tx) => {
        for (const code of [...codes].sort()) await tx.lockModule(code);
        const activeRows = await tx.listActiveRows();
        const boundCodes = activeRows
          .filter((module) => (
            module.config.solutionBinding?.solutionId === input.solutionId
          ))
          .map((module) => module.code)
          .sort();
        if (!isDeepStrictEqual(boundCodes, [...codes].sort())) {
          throw new VerticalSolutionManifestError(
            "SOLUTION_ROLLBACK_INVALID",
            "目标实例当前方案模块集合与回滚凭据不一致。",
            409,
            { boundCodes, receiptCodes: [...codes].sort() },
          );
        }

        const prepared: Array<{
          current: StoredModuleConfig;
          historical: StoredModuleVersion;
        }> = [];
        for (const target of input.modules) {
          const current = ensureActive(await tx.findCurrent(target.code), target.code);
          const historical = await tx.findVersion(target.code, target.restoreVersion);
          if (
            current.origin !== "user"
            || current.version !== target.expectedVersion
            || current.config.solutionBinding?.solutionId !== input.solutionId
            || current.config.solutionBinding.solutionVersion
              !== input.fromSolutionVersion
            || !historical
            || historical.config.solutionBinding?.solutionId !== input.solutionId
            || historical.config.solutionBinding.solutionVersion
              !== input.toSolutionVersion
          ) {
            throw new VerticalSolutionManifestError(
              "SOLUTION_ROLLBACK_INVALID",
              "目标模块已变化或历史快照不匹配，不能执行方案回滚。",
              409,
              { moduleCode: target.code },
            );
          }
          prepared.push({ current, historical });
        }

        const saved: StoredModuleConfig[] = [];
        for (const { current, historical } of prepared) {
          const config = validateModuleConfig(clone(historical.config));
          assertFrontProfitModuleContractPreserved(current.config, config);
          const next = activeModule(
            config,
            "user",
            current.version + 1,
            current.createdBy,
          );
          const updated = await tx.updateCurrentIfVersion(
            current.code,
            current.version,
            next,
          );
          if (!updated) throw new ModuleConfigVersionConflictError();
          await tx.insertVersion({
            moduleCode: current.code,
            version: next.version,
            config: next.config,
            createdBy: input.actorId,
          });
          saved.push(clone(updated));
        }
        return saved;
      });
    },
    async update(code, inputConfig, actorId) {
      const parsedConfig = validateModuleConfig(clone(inputConfig));
      if (parsedConfig.code !== code) {
        throw new Error(`Module code cannot change from ${code} to ${parsedConfig.code}`);
      }

      return adapter.transaction(async (tx) => {
        await tx.lockModule(code);
        const current = ensureActive(await tx.findCurrent(code), code);
        const config = current.config.solutionBinding
          ? preserveSolutionBinding(
              parsedConfig,
              current.config.solutionBinding,
            )
          : portableModuleConfig(parsedConfig);
        assertFrontProfitModuleContractPreserved(current.config, config);
        if (current.origin === "builtin_overlay") {
          await assertBuiltinOverlay(config);
        }
        const next = activeModule(
          config,
          current.origin,
          current.version + 1,
          current.createdBy,
        );
        const saved = await tx.updateCurrent(code, next);
        if (!saved) throw new Error(`Module config not found: ${code}`);
        await tx.insertVersion({
          moduleCode: code,
          version: next.version,
          config: next.config,
          createdBy: actorId,
        });
        return clone(saved);
      });
    },
    async listVersions(code) {
      const versions = await adapter.listVersionRows(code);
      return versions.map(({ version, config, createdAt }) => ({
        version,
        config: clone(config),
        createdAt,
      }));
    },
    async restore(code, version, actorId) {
      return adapter.transaction(async (tx) => {
        await tx.lockModule(code);
        const current = ensureActive(await tx.findCurrent(code), code);
        const historical = await tx.findVersion(code, version);
        if (!historical) {
          throw new Error(`Module config version not found: ${code}@${version}`);
        }
        const config = validateModuleConfig(clone(historical.config));
        assertFrontProfitModuleContractPreserved(current.config, config);
        if (current.origin === "builtin_overlay") {
          await assertBuiltinOverlay(config);
        }
        const next = activeModule(
          config,
          current.origin,
          current.version + 1,
          current.createdBy,
        );
        const saved = await tx.updateCurrent(code, next);
        if (!saved) throw new Error(`Module config not found: ${code}`);
        await tx.insertVersion({
          moduleCode: code,
          version: next.version,
          config: next.config,
          createdBy: actorId,
        });
        return clone(saved);
      });
    },
    async archive(code, actorId) {
      await adapter.transaction(async (tx) => {
        await tx.lockModule(code);
        const current = ensureActive(await tx.findCurrent(code), code);
        const version = current.version + 1;
        const archived = await tx.archiveCurrent(code, version);
        if (!archived) throw new Error(`Module config not found: ${code}`);
        await tx.insertVersion({
          moduleCode: code,
          version,
          config: archived.config,
          createdBy: actorId,
        });
      });
    },
    async upsertSchemaDecisions(code, decisions, actorId) {
      await adapter.transaction(async (tx) => {
        await tx.lockModule(code);
        for (const decision of decisions) {
          await tx.upsertDecision({
            moduleCode: code,
            ...decision,
            createdBy: actorId,
          });
        }
      });
    },
    async listSchemaDecisions(code) {
      return clone(await adapter.listDecisionRows(code));
    },
    async activateSchemaDecisions(input) {
      const parsedConfig = validateModuleConfig(clone(input.config));
      if (parsedConfig.code !== input.code) {
        throw new Error(
          `Module code cannot change from ${input.code} to ${parsedConfig.code}`,
        );
      }
      return adapter.transaction(async (tx) => {
        await tx.lockModule(input.code);
        const current = ensureActive(
          await tx.findCurrent(input.code),
          input.code,
        );
        if (
          current.origin !== "user" ||
          current.version !== input.expectedVersion
        ) {
          throw new ModuleConfigVersionConflictError();
        }
        const config = current.config.solutionBinding
          ? preserveSolutionBinding(
              parsedConfig,
              current.config.solutionBinding,
            )
          : portableModuleConfig(parsedConfig);
        assertFrontProfitModuleContractPreserved(current.config, config);
        const next = activeModule(
          config,
          current.origin,
          current.version + 1,
          current.createdBy,
        );
        const saved = await tx.updateCurrentIfVersion(
          input.code,
          input.expectedVersion,
          next,
        );
        if (!saved) throw new ModuleConfigVersionConflictError();
        await tx.insertVersion({
          moduleCode: input.code,
          version: next.version,
          config: next.config,
          createdBy: input.actorId,
        });
        for (const decision of input.decisions) {
          await tx.upsertDecision({
            moduleCode: input.code,
            ...decision,
            createdBy: input.actorId,
          });
        }
        return clone(saved);
      });
    },
  };
}
