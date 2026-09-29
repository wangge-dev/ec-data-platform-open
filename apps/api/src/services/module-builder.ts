import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { LoadedModule } from "../modules/loader.js";
import {
  SemanticRoleSchema,
  validateModuleConfig,
  type ColumnDef,
  type ModuleDef,
  type SemanticMetricDef,
  type SemanticRole,
} from "../modules/schema.js";
import type { EtlReport } from "./etl.js";
import type {
  ModuleConfigStore,
  StoredModuleConfig,
} from "./module-config-store.js";
import type {
  InspectorOptions,
  SourceInspection,
} from "./module-source-inspector.js";
import {
  assertFrontProfitModuleContractValid,
  FrontProfitModuleContractInvalidError,
  FRONT_PROFIT_STANDARD_SCHEMA_VERSION,
  moduleRequiresFrontProfitStandard,
} from "./front-profit-standard.js";
import type {
  DefaultModuleChartResult,
} from "./default-module-charts.js";
import {
  GENERIC_PROCESSING_ERROR,
  publicProcessingError,
} from "./public-processing-error.js";
import {
  firstColumnByRoles,
  isNumericAnalysisColumn,
  isSystemModuleColumn,
  isTimeAnalysisColumn,
} from "./module-chart-compatibility.js";

const ColumnTypeSchema = z.enum([
  "text",
  "int",
  "numeric",
  "timestamp",
  "date",
  "boolean",
]);

const CalculatedFieldSchema = z.object({
  label: z.string().trim().min(1).max(128),
  operation: z.enum(["add", "subtract", "multiply", "ratio"]),
  leftSource: z.string().trim().min(1).max(256),
  rightSource: z.string().trim().min(1).max(256),
  unit: z.enum(["number", "currency", "percent", "quantity"]).default("number"),
}).refine((field) => field.leftSource !== field.rightSource, {
  message: "计算字段的左右两项不能相同",
});

export const CreateModuleRequestSchema = z.object({
  name: z.string().trim().min(1).max(128),
  category: z.string().trim().min(1).max(64).optional(),
  description: z.string().trim().max(2000).optional(),
  sourceIds: z
    .array(z.number().int().positive())
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "sourceIds cannot contain duplicates",
    }),
  filenamePhrase: z.string().trim().min(1).max(256).nullable().optional(),
  mappings: z
    .array(
      z.object({
        semanticRole: SemanticRoleSchema,
        source: z.string().trim().min(1).max(256),
        label: z.string().trim().min(1).max(256),
        type: ColumnTypeSchema,
        required: z.boolean(),
      }),
    )
    .min(1),
  additionalFields: z.array(
    z.object({
      source: z.string().trim().min(1).max(256),
      label: z.string().trim().min(1).max(256),
      type: ColumnTypeSchema,
    }),
  ),
  calculatedFields: z
    .array(CalculatedFieldSchema)
    .max(10)
    .refine(
      (fields) => new Set(fields.map((field) => field.label)).size === fields.length,
      { message: "计算字段名称不能重复" },
    )
    .optional(),
  inclusion: z
    .object({
      statusSource: z.string().trim().min(1).max(256),
      includedValues: z.array(z.string().trim().min(1)).min(1),
    })
    .optional(),
  // Keep durable request keys compact for compatibility with older databases.
  idempotencyKey: z.string().trim().min(1).max(50),
});

export type CreateModuleRequest = z.infer<typeof CreateModuleRequestSchema>;

export type AssignAndRunResult = {
  moduleCode: string;
  files: Array<{
    sourceId: number;
    status: "success" | "failed";
    total: number;
    inserted: number;
    included: number;
    error?: string;
  }>;
  warnings?: string[];
};

const SafeAssignAndRunResultSchema = z.object({
  moduleCode: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64),
  files: z.array(
    z.object({
      sourceId: z.number().int().positive(),
      status: z.enum(["success", "failed"]),
      total: z.number().finite().nonnegative(),
      inserted: z.number().finite().nonnegative(),
      included: z.number().finite().nonnegative(),
      error: z.string().max(512).optional(),
    }),
  ),
  warnings: z.array(z.string().max(512)).max(10).optional(),
});

const PendingIdempotencyClaimSchema = z.object({
  version: z.literal(1),
  state: z.literal("pending"),
  actorId: z.number().int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  moduleCode: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64),
  ownerToken: z.string().uuid(),
  leaseExpiresAt: z.number().int().nonnegative(),
});

const CompletedIdempotencyClaimSchema = PendingIdempotencyClaimSchema.omit({
  state: true,
  leaseExpiresAt: true,
}).extend({
  state: z.literal("completed"),
  result: SafeAssignAndRunResultSchema,
});

const IdempotencyClaimSchema = z.discriminatedUnion("state", [
  PendingIdempotencyClaimSchema,
  CompletedIdempotencyClaimSchema,
]);

export type PendingIdempotencyClaim = z.infer<
  typeof PendingIdempotencyClaimSchema
>;
export type CompletedIdempotencyClaim = z.infer<
  typeof CompletedIdempotencyClaimSchema
>;
export type IdempotencyClaim =
  | PendingIdempotencyClaim
  | CompletedIdempotencyClaim;

export type ModuleBuilderDeps = {
  store: ModuleConfigStore;
  inspectSources(
    sourceIds: number[],
    options: InspectorOptions,
  ): Promise<SourceInspection>;
  assignSource(sourceId: number, moduleCode: string): Promise<void>;
  runEtl(
    sourceId: number,
    options: {
      moduleCode: string;
      moduleOverride?: LoadedModule;
      manageSchemaReviewState?: boolean;
      executor?: {
        unsafe(query: string, parameters?: unknown[]): PromiseLike<any[]>;
      };
    },
  ): Promise<EtlReport | null>;
  ensureDefaultModuleCharts(
    module: ModuleDef,
  ): Promise<DefaultModuleChartResult>;
  insertIdempotencyClaim(
    key: string,
    claim: PendingIdempotencyClaim,
    leaseDurationMs: number,
  ): Promise<boolean>;
  readIdempotencyClaim(key: string): Promise<IdempotencyClaim | null>;
  replaceIdempotencyClaim(
    key: string,
    expectedOwnerToken: string,
    claim: IdempotencyClaim,
    leaseDurationMs?: number,
  ): Promise<boolean>;
  renewIdempotencyClaim(
    key: string,
    expectedOwnerToken: string,
    leaseDurationMs: number,
  ): Promise<PendingIdempotencyClaim | null>;
  idempotencyNow?: () => number;
  idempotencyWait?: (milliseconds: number) => Promise<void>;
  idempotencyHeartbeatMs?: number;
  loadModules(force?: boolean): Promise<LoadedModule[]>;
  invalidateModuleCache(): void;
};

export class ModuleBuilderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModuleBuilderInputError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key is already bound to another request");
    this.name = "IdempotencyConflictError";
  }
}

class IdempotencyOwnershipLostError extends Error {
  constructor() {
    super("Module creation ownership was superseded");
    this.name = "IdempotencyOwnershipLostError";
  }
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CHINESE_NAME_TOKENS: Array<[RegExp, string]> = [
  [/拼多多/g, "pinduoduo"],
  [/销售/g, "sales"],
  [/订单/g, "orders"],
  [/库存/g, "inventory"],
  [/成本/g, "cost"],
  [/广告/g, "ads"],
  [/流量/g, "traffic"],
  [/商品/g, "product"],
  [/店铺/g, "shop"],
  [/财务/g, "finance"],
];

function stableHash(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function baseModuleSlug(name: string): string {
  let translated = name.normalize("NFKC").toLowerCase();
  for (const [pattern, replacement] of CHINESE_NAME_TOKENS) {
    translated = translated.replace(pattern, ` ${replacement} `);
  }
  const slug = translated
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  if (/^[a-z]/.test(slug)) return slug.slice(0, 56);
  return `module_${stableHash(name)}`;
}

export function uniqueModuleCode(
  name: string,
  existingCodes: Iterable<string> = [],
): string {
  const existing = new Set(existingCodes);
  const base = baseModuleSlug(name);
  if (!existing.has(base)) return base;
  for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const candidate = `${base.slice(0, 60 - String(suffix).length)}_${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error("Unable to allocate a unique module code");
}

const ROLE_COLUMN_NAMES: Record<SemanticRole, string> = {
  time: "time",
  amount: "amount",
  quantity: "quantity",
  product_id: "product_id",
  product_name: "product_name",
  order_id: "order_id",
  status: "status",
  sku: "sku",
  shop: "shop",
  dimension: "dimension",
};

function asciiFieldSlug(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function uniqueColumnName(
  preferred: string,
  used: Set<string>,
  fallbackIndex: number,
): string {
  const rawBase = asciiFieldSlug(preferred) || `field_${fallbackIndex}`;
  const base = /^[a-z]/.test(rawBase) ? rawBase : `field_${rawBase}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function assertSourcesBelongToInspection(
  input: CreateModuleRequest,
  inspection: SourceInspection,
): void {
  const headers = new Set(inspection.headers);
  for (const mapping of [...input.mappings, ...input.additionalFields]) {
    if (!headers.has(mapping.source)) {
      throw new ModuleBuilderInputError(
        `Mapped source field does not exist: ${mapping.source}`,
      );
    }
  }
  for (const calculated of input.calculatedFields ?? []) {
    for (const source of [calculated.leftSource, calculated.rightSource]) {
      if (!headers.has(source)) {
        throw new ModuleBuilderInputError(
          `Calculated source field does not exist: ${source}`,
        );
      }
    }
  }
  if (
    input.inclusion &&
    !input.mappings.some(
      (mapping) =>
        mapping.semanticRole === "status" &&
        mapping.source === input.inclusion?.statusSource,
    )
  ) {
    throw new ModuleBuilderInputError(
      "inclusion.statusSource must map to the status semantic role",
    );
  }
}

export function buildModuleDef(
  rawInput: CreateModuleRequest,
  inspection: SourceInspection,
  existingCodes: Iterable<string> = [],
  predeterminedCode?: string,
): ModuleDef {
  const input = CreateModuleRequestSchema.parse(rawInput);
  if (!inspection.compatible) {
    throw new ModuleBuilderInputError(
      `Selected source headers are incompatible: ${JSON.stringify(inspection.differences)}`,
    );
  }
  assertSourcesBelongToInspection(input, inspection);

  const usedNames = new Set<string>();
  const roleCounts = new Map<SemanticRole, number>();
  const columns: ColumnDef[] = input.mappings.map((mapping) => {
    const count = (roleCounts.get(mapping.semanticRole) ?? 0) + 1;
    roleCounts.set(mapping.semanticRole, count);
    const roleName = ROLE_COLUMN_NAMES[mapping.semanticRole];
    const name = uniqueColumnName(
      count === 1 ? roleName : `${roleName}_${count}`,
      usedNames,
      usedNames.size + 1,
    );
    return {
      name,
      source: mapping.source,
      label: mapping.label,
      type: mapping.type,
      required: mapping.required,
      computed: false,
      semanticRole: mapping.semanticRole,
    };
  });
  for (const [index, field] of input.additionalFields.entries()) {
    columns.push({
      name: uniqueColumnName(
        field.label || field.source,
        usedNames,
        input.mappings.length + index + 1,
      ),
      source: field.source,
      label: field.label,
      type: field.type,
      required: false,
      computed: false,
    });
  }

  const sourceColumns = new Map(
    columns.flatMap((column) => {
      if (column.computed || !column.source) return [];
      const sources = Array.isArray(column.source) ? column.source : [column.source];
      return sources.map((source) => [source, column] as const);
    }),
  );
  const calculatedContracts: Array<{
    column: ColumnDef;
    input: z.infer<typeof CalculatedFieldSchema>;
    left: ColumnDef;
    right: ColumnDef;
  }> = [];
  for (const [index, calculated] of (input.calculatedFields ?? []).entries()) {
    const left = sourceColumns.get(calculated.leftSource);
    const right = sourceColumns.get(calculated.rightSource);
    if (!left || !right) {
      throw new ModuleBuilderInputError(
        `计算字段「${calculated.label}」只能引用已经映射或保留的字段`,
      );
    }
    if (!["int", "numeric"].includes(left.type) || !["int", "numeric"].includes(right.type)) {
      throw new ModuleBuilderInputError(
        `计算字段「${calculated.label}」只能引用整数或数值字段`,
      );
    }
    const expression = {
      add: `"${left.name}" + "${right.name}"`,
      subtract: `"${left.name}" - "${right.name}"`,
      multiply: `"${left.name}" * "${right.name}"`,
      ratio: `"${left.name}" / NULLIF("${right.name}", 0)`,
    }[calculated.operation];
    const column: ColumnDef = {
      name: uniqueColumnName(
        calculated.label,
        usedNames,
        input.mappings.length + input.additionalFields.length + index + 1,
      ),
      label: calculated.label,
      hint: `${calculated.leftSource} ${calculated.operation} ${calculated.rightSource}`,
      type: "numeric",
      required: false,
      computed: true,
      expression,
    };
    columns.push(column);
    calculatedContracts.push({ column, input: calculated, left, right });
  }

  const timeKey = columns.find(
    (column) => column.semanticRole === "time",
  )?.name;
  const statusColumn = columns.find(
    (column) =>
      column.semanticRole === "status" &&
      column.source === input.inclusion?.statusSource,
  );
  const moduleCode =
    predeterminedCode ?? uniqueModuleCode(input.name, existingCodes);
  const filenamePhrase =
    input.filenamePhrase ?? inspection.filenamePhrase ?? moduleCode;

  const semanticDimensions = columns
    .filter((column) =>
      column.semanticRole === "time"
      || column.semanticRole === "product_id"
      || column.semanticRole === "product_name"
      || column.semanticRole === "status"
      || column.semanticRole === "sku"
      || column.semanticRole === "shop"
      || column.semanticRole === "dimension"
      || (["text", "date", "timestamp", "boolean"] as string[]).includes(column.type)
    )
    .map((column) => ({
      id: `${moduleCode}.dim_${column.name}`,
      label: column.label ?? column.name,
      field: column.name,
      kind: column.semanticRole === "time" || column.type === "date" || column.type === "timestamp"
        ? "time" as const
        : "categorical" as const,
    }));
  if (semanticDimensions.length === 0) {
    const fallback = columns[0];
    semanticDimensions.push({
      id: `${moduleCode}.dim_${fallback.name}`,
      label: fallback.label ?? fallback.name,
      field: fallback.name,
      kind: "categorical",
    });
  }
  const semanticMetrics: SemanticMetricDef[] = columns
    .filter((column) => column.semanticRole === "amount" || column.semanticRole === "quantity")
    .map((column) => ({
      id: `${moduleCode}.metric_${column.name}`,
      label: column.label ?? column.name,
      aggregation: "sum" as const,
      field: column.name,
      unit: column.semanticRole === "amount" ? "currency" as const : "quantity" as const,
      additiveAcrossTime: true,
    }));
  for (const calculated of calculatedContracts) {
    semanticMetrics.push(calculated.input.operation === "ratio"
      ? {
          id: `${moduleCode}.metric_${calculated.column.name}`,
          label: calculated.input.label,
          aggregation: "ratio",
          numeratorField: calculated.left.name,
          denominatorField: calculated.right.name,
          unit: calculated.input.unit,
          additiveAcrossTime: false,
        }
      : {
          id: `${moduleCode}.metric_${calculated.column.name}`,
          label: calculated.input.label,
          aggregation: "sum",
          field: calculated.column.name,
          unit: calculated.input.unit,
          additiveAcrossTime: true,
        });
  }
  if (semanticMetrics.length === 0) {
    const countField = columns.find((column) => column.semanticRole === "order_id")?.name;
    semanticMetrics.push({
      id: `${moduleCode}.metric_rows`,
      label: "记录数",
      aggregation: "count",
      ...(countField ? { field: countField } : {}),
      unit: "number",
      additiveAcrossTime: true,
    });
  }

  const module = validateModuleConfig({
    code: moduleCode,
    name: input.name,
    category: input.category,
    description: input.description ?? `${input.name}数据`,
    dataContract:
      inspection.dataContract === FRONT_PROFIT_STANDARD_SCHEMA_VERSION
        ? FRONT_PROFIT_STANDARD_SCHEMA_VERSION
        : undefined,
    columns,
    platforms: [
      {
        code: "generic",
        name: "通用",
        filePattern: escapeRegExp(filenamePhrase),
        patternFlags: "i",
        enabled: true,
      },
    ],
    timeKey,
    inclusionRule:
      input.inclusion && statusColumn
        ? {
            field: statusColumn.name,
            includedValues: input.inclusion.includedValues,
          }
        : undefined,
    usages: ["summary", "ai_chart", "ai_analysis"],
    semanticModel: {
      schemaVersion: "semantic-manifest/v1",
      id: `${moduleCode}.analysis`,
      version: 1,
      dimensions: semanticDimensions,
      metrics: semanticMetrics,
    },
    enabled: true,
    hasTransform: false,
    isDict: false,
  });
  try {
    assertFrontProfitModuleContractValid(module);
  } catch (error) {
    if (error instanceof FrontProfitModuleContractInvalidError) {
      throw new ModuleBuilderInputError(error.message);
    }
    throw error;
  }
  return module;
}

function unmappedInspectionHeaders(
  config: ModuleDef,
  inspection: SourceInspection,
): string[] {
  const recognized = new Set<string>();
  for (const column of config.columns) {
    const sources = Array.isArray(column.source)
      ? column.source
      : column.source
        ? [column.source]
        : [];
    for (const source of sources) recognized.add(source);
  }
  for (const platform of config.platforms) {
    for (const override of Object.values(platform.columnOverrides ?? {})) {
      const sources = Array.isArray(override) ? override : [override];
      for (const source of sources) recognized.add(source);
    }
  }
  return inspection.headers.filter((header) => !recognized.has(header));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, nested]) =>
          `${JSON.stringify(key)}:${canonicalJson(nested)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalPersistedModule(config: ModuleDef): string {
  const persisted = JSON.parse(JSON.stringify(config)) as unknown;
  return canonicalJson(validateModuleConfig(persisted));
}

export function moduleCreateFingerprint(input: CreateModuleRequest): string {
  const { idempotencyKey: _idempotencyKey, ...request } =
    CreateModuleRequestSchema.parse(input);
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

function sanitizeText(value: unknown): string {
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 512);
}

const SAFE_CHART_WARNING = "数据已处理，但基础看板初始化失败，可稍后重试";
const SAFE_GENERIC_WARNING = "部分辅助功能暂未完成，可稍后重试";

export function sanitizeAssignAndRunResult(
  result: AssignAndRunResult,
): AssignAndRunResult {
  const warnings = result.warnings
    ? [
        ...new Set(
          result.warnings.map((warning) =>
            sanitizeText(warning) === SAFE_CHART_WARNING
              ? SAFE_CHART_WARNING
              : SAFE_GENERIC_WARNING,
          ),
        ),
      ]
    : [];
  return SafeAssignAndRunResultSchema.parse({
    moduleCode: result.moduleCode,
    files: result.files.map((file) => ({
      sourceId: file.sourceId,
      status: file.status,
      total: Number.isFinite(file.total) && file.total >= 0 ? file.total : 0,
      inserted:
        Number.isFinite(file.inserted) && file.inserted >= 0
          ? file.inserted
          : 0,
      included:
        Number.isFinite(file.included) && file.included >= 0
          ? file.included
          : 0,
      ...(file.status === "failed"
        ? { error: publicProcessingError(file.error) }
        : {}),
    })),
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}

export function parseIdempotencyClaim(value: unknown): IdempotencyClaim {
  return IdempotencyClaimSchema.parse(value);
}

const IDEMPOTENCY_LEASE_MS = 60_000;
const IDEMPOTENCY_POLL_MS = 10;

type AcquiredClaim =
  | { status: "owner"; claim: PendingIdempotencyClaim }
  | { status: "replay"; claim: CompletedIdempotencyClaim };

async function acquireIdempotencyClaim(
  input: {
    key: string;
    actorId: number;
    fingerprint: string;
    proposedModuleCode: string;
  },
  deps: Pick<
    ModuleBuilderDeps,
    | "insertIdempotencyClaim"
    | "readIdempotencyClaim"
    | "replaceIdempotencyClaim"
    | "idempotencyNow"
    | "idempotencyWait"
  >,
): Promise<AcquiredClaim> {
  const now = deps.idempotencyNow ?? Date.now;
  const wait =
    deps.idempotencyWait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const candidate = (): PendingIdempotencyClaim => ({
    version: 1,
    state: "pending",
    actorId: input.actorId,
    fingerprint: input.fingerprint,
    moduleCode: input.proposedModuleCode,
    ownerToken: randomUUID(),
    leaseExpiresAt: now() + IDEMPOTENCY_LEASE_MS,
  });

  const initial = candidate();
  if (
    await deps.insertIdempotencyClaim(
      input.key,
      initial,
      IDEMPOTENCY_LEASE_MS,
    )
  ) {
    return { status: "owner", claim: initial };
  }

  while (true) {
    const existing = await deps.readIdempotencyClaim(input.key);
    if (!existing) {
      const replacement = candidate();
      if (
        await deps.insertIdempotencyClaim(
          input.key,
          replacement,
          IDEMPOTENCY_LEASE_MS,
        )
      ) {
        return { status: "owner", claim: replacement };
      }
      continue;
    }
    if (
      existing.actorId !== input.actorId ||
      existing.fingerprint !== input.fingerprint
    ) {
      throw new IdempotencyConflictError();
    }
    if (existing.state === "completed") {
      return { status: "replay", claim: existing };
    }
    if (existing.leaseExpiresAt > now()) {
      await wait(IDEMPOTENCY_POLL_MS);
      continue;
    }

    const takeover: PendingIdempotencyClaim = {
      ...candidate(),
      // A claim permanently owns its first allocated module identity.
      moduleCode: existing.moduleCode,
    };
    if (
      await deps.replaceIdempotencyClaim(
        input.key,
        existing.ownerToken,
        takeover,
        IDEMPOTENCY_LEASE_MS,
      )
    ) {
      return { status: "owner", claim: takeover };
    }
    // The database may still consider the lease live even when the process
    // clock is ahead. Avoid a hot CAS loop and let DB-side time arbitrate.
    await wait(IDEMPOTENCY_POLL_MS);
  }
}

async function abandonIdempotencyClaim(
  key: string,
  claim: PendingIdempotencyClaim,
  deps: Pick<ModuleBuilderDeps, "replaceIdempotencyClaim">,
): Promise<void> {
  try {
    await deps.replaceIdempotencyClaim(key, claim.ownerToken, {
      ...claim,
      leaseExpiresAt: 0,
    });
  } catch {
    // A process crash has the same effect once the durable lease expires.
  }
}

type IdempotencyFence = {
  assertOwnership(): Promise<void>;
  stop(): Promise<void>;
};

function startIdempotencyFence(
  key: string,
  claim: PendingIdempotencyClaim,
  deps: Pick<
    ModuleBuilderDeps,
    "renewIdempotencyClaim" | "idempotencyHeartbeatMs"
  >,
): IdempotencyFence {
  let stopped = false;
  let lost: IdempotencyOwnershipLostError | null = null;
  let inFlight: Promise<void> | null = null;

  const renewSingleFlight = (): Promise<void> => {
    if (lost) return Promise.reject(lost);
    if (stopped) {
      return Promise.reject(new IdempotencyOwnershipLostError());
    }
    if (!inFlight) {
      inFlight = deps
        .renewIdempotencyClaim(
          key,
          claim.ownerToken,
          IDEMPOTENCY_LEASE_MS,
        )
        .then((renewed) => {
          if (!renewed) {
            lost = new IdempotencyOwnershipLostError();
          }
        })
        .catch(() => {
          // A failed renewal cannot prove ownership, so it is fenced exactly
          // like an owner-token mismatch.
          lost = new IdempotencyOwnershipLostError();
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight.then(() => {
      if (lost) throw lost;
    });
  };

  const timer = setInterval(() => {
    // renewSingleFlight returns the current promise when a renewal is already
    // active. This catch is attached immediately, preventing an unhandled
    // rejection while preserving the lost-ownership state for stage checks.
    void renewSingleFlight().catch(() => undefined);
  }, deps.idempotencyHeartbeatMs ?? Math.floor(IDEMPOTENCY_LEASE_MS / 3));
  timer.unref?.();

  return {
    async assertOwnership() {
      await renewSingleFlight();
    },
    async stop() {
      if (stopped) {
        if (lost) throw lost;
        return;
      }
      stopped = true;
      clearInterval(timer);
      const active = inFlight;
      if (active) await active.catch(() => undefined);
      if (lost) throw lost;
    },
  };
}

async function runOneSource(
  sourceId: number,
  moduleCode: string,
  deps: Pick<ModuleBuilderDeps, "runEtl">,
): Promise<AssignAndRunResult["files"][number]> {
  try {
    const report = await deps.runEtl(sourceId, { moduleCode });
    if (!report) {
      console.error("[module-builder:etl] no report", {
        sourceId,
        moduleCode,
      });
      return {
        sourceId,
        status: "failed",
        total: 0,
        inserted: 0,
        included: 0,
        error: GENERIC_PROCESSING_ERROR,
      };
    }
    const total = Number(report.total ?? 0);
    const inserted = Number(report.inserted ?? 0);
    const included = Number(
      (report as EtlReport & { included?: number }).included ?? inserted,
    );
    if (report.error) {
      console.error("[module-builder:etl] report failure", {
        sourceId,
        moduleCode,
        error: report.error,
      });
    }
    return {
      sourceId,
      status: report.error ? "failed" : "success",
      total,
      inserted,
      included,
      ...(report.error ? { error: publicProcessingError(report.error) } : {}),
    };
  } catch (error: any) {
    console.error("[module-builder:etl] exception", {
      sourceId,
      moduleCode,
      error,
    });
    return {
      sourceId,
      status: "failed",
      total: 0,
      inserted: 0,
      included: 0,
      error: GENERIC_PROCESSING_ERROR,
    };
  }
}

export async function assignAndRunSources(
  moduleCode: string,
  sourceIds: number[],
  deps: Pick<ModuleBuilderDeps, "assignSource" | "runEtl"> &
    Partial<
      Pick<
        ModuleBuilderDeps,
        "ensureDefaultModuleCharts" | "inspectSources" | "loadModules"
      >
    >,
  options?: {
    beforeIrreversible?: () => Promise<void>;
    module?: ModuleDef;
  },
): Promise<AssignAndRunResult> {
  const uniqueSourceIds = z
    .array(z.number().int().positive())
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length)
    .parse(sourceIds);
  if (options?.module && moduleRequiresFrontProfitStandard(options.module)) {
    if (!deps.inspectSources) {
      throw new ModuleBuilderInputError(
        "前台利润模块分配前必须复核标准数据合同",
      );
    }
    const inspection = await deps.inspectSources(uniqueSourceIds, {
      includeStatusValues: false,
    });
    if (inspection.dataContract !== FRONT_PROFIT_STANDARD_SCHEMA_VERSION) {
      throw new ModuleBuilderInputError(
        "前台利润模块只接受已通过 28 列、公式与唯一性校验的标准表",
      );
    }
  }
  const assignmentErrors = new Set<number>();

  // Complete the ownership phase before running any ETL.
  for (const sourceId of uniqueSourceIds) {
    await options?.beforeIrreversible?.();
    try {
      await deps.assignSource(sourceId, moduleCode);
    } catch (error: any) {
      console.error("[module-builder:assignment] failure", {
        sourceId,
        moduleCode,
        error,
      });
      assignmentErrors.add(sourceId);
    }
  }

  const files: AssignAndRunResult["files"] = [];
  for (const sourceId of uniqueSourceIds) {
    if (assignmentErrors.has(sourceId)) {
      files.push({
        sourceId,
        status: "failed",
        total: 0,
        inserted: 0,
        included: 0,
        error: GENERIC_PROCESSING_ERROR,
      });
      continue;
    }
    await options?.beforeIrreversible?.();
    files.push(await runOneSource(sourceId, moduleCode, deps));
  }
  const result: AssignAndRunResult = { moduleCode, files };
  if (
    files.some((file) => file.status === "success") &&
    deps.ensureDefaultModuleCharts
  ) {
    const module =
      options?.module ??
      (deps.loadModules
        ? (await deps.loadModules()).find(
            (candidate) => candidate.code === moduleCode,
          )
        : undefined);
    if (
      module &&
      (module as Partial<LoadedModule>).origin !== "builtin"
    ) {
      await options?.beforeIrreversible?.();
      try {
        await deps.ensureDefaultModuleCharts(module);
      } catch {
        result.warnings = [
          SAFE_CHART_WARNING,
        ];
      }
    }
  }
  return result;
}

export async function createAndRunUserModule(
  rawInput: CreateModuleRequest,
  actorId: number,
  deps: ModuleBuilderDeps,
): Promise<{
  replayed: boolean;
  stored: StoredModuleConfig | null;
  result: AssignAndRunResult;
}> {
  if (!Number.isSafeInteger(actorId) || actorId <= 0) {
    throw new ModuleBuilderInputError("A valid authenticated actor is required");
  }
  const input = CreateModuleRequestSchema.parse(rawInput);
  const existing = await deps.loadModules();
  const fingerprint = moduleCreateFingerprint(input);
  const proposedModuleCode = uniqueModuleCode(
    input.name,
    existing.map((module) => module.code),
  );

  while (true) {
    const acquired = await acquireIdempotencyClaim(
      {
        key: input.idempotencyKey,
        actorId,
        fingerprint,
        proposedModuleCode,
      },
      deps,
    );
    if (acquired.status === "replay") {
      return {
        replayed: true,
        stored: null,
        result: sanitizeAssignAndRunResult(acquired.claim.result),
      };
    }

    const claim = acquired.claim;
    const fence = startIdempotencyFence(
      input.idempotencyKey,
      claim,
      deps,
    );
    try {
      // The durable claim exists before source inspection or persistence.
      const sourceInspection = await deps.inspectSources(input.sourceIds, {
        includeStatusValues: false,
      });
      if (!sourceInspection.compatible) {
        throw new ModuleBuilderInputError(
          `Selected source headers are incompatible: ${JSON.stringify(sourceInspection.differences)}`,
        );
      }
      const config = buildModuleDef(
        input,
        sourceInspection,
        [],
        claim.moduleCode,
      );

      // Fence the persisted-module recovery decision.
      await fence.assertOwnership();
      const alreadySaved = (await deps.store.listActive()).find(
        (module) => module.code === claim.moduleCode,
      );
      if (
        alreadySaved &&
        (alreadySaved.origin !== "user" ||
          alreadySaved.createdBy !== actorId ||
          canonicalPersistedModule(alreadySaved.config) !==
            canonicalPersistedModule(config))
      ) {
        throw new ModuleBuilderInputError(
          `Claimed module code is already in use: ${claim.moduleCode}`,
        );
      }

      let stored = alreadySaved;
      if (!stored) {
        await fence.assertOwnership();
        stored = await deps.store.create({
          config,
          actorId,
          origin: "user",
        });
      }

      const initiallyIgnored = unmappedInspectionHeaders(
        config,
        sourceInspection,
      );
      if (initiallyIgnored.length > 0) {
        await deps.store.upsertSchemaDecisions(
          config.code,
          initiallyIgnored.map((sourceField) => ({
            sourceField,
            decision: "ignore" as const,
          })),
          actorId,
        );
      }

      deps.invalidateModuleCache();
      await deps.loadModules(true);

      const result = sanitizeAssignAndRunResult(
        await assignAndRunSources(config.code, input.sourceIds, deps, {
          beforeIrreversible: () => fence.assertOwnership(),
          module: config,
        }),
      );
      const completed: CompletedIdempotencyClaim = {
        version: 1,
        state: "completed",
        actorId,
        fingerprint,
        moduleCode: claim.moduleCode,
        ownerToken: claim.ownerToken,
        result,
      };

      // Assert immediately before the durable completed-result write, then
      // quiesce the heartbeat so no renewal can overlap completion.
      await fence.assertOwnership();
      await fence.stop();
      if (
        !(await deps.replaceIdempotencyClaim(
          input.idempotencyKey,
          claim.ownerToken,
          completed,
        ))
      ) {
        throw new IdempotencyOwnershipLostError();
      }
      return { replayed: false, stored, result };
    } catch (error) {
      let cleanupError: unknown;
      try {
        await fence.stop();
      } catch (stopError) {
        cleanupError = stopError;
      }
      if (
        error instanceof IdempotencyOwnershipLostError ||
        cleanupError instanceof IdempotencyOwnershipLostError
      ) {
        // Wait for the superseding owner and replay its completed result. If
        // that owner later expires, the normal acquisition loop can take over.
        continue;
      }
      await abandonIdempotencyClaim(input.idempotencyKey, claim, deps);
      throw error;
    }
  }
}

export type FieldSuggestion = {
  key: string;
  label: string;
  chartType: "bar" | "line" | "pie";
  dimension: string;
  metric: string;
};

type FieldSuggestionModule = ModuleDef & {
  origin?: "builtin" | "user";
};

export function moduleFieldSuggestions(
  module: FieldSuggestionModule,
): FieldSuggestion[] {
  if (module.origin !== "user") return [];

  const ordinaryColumns = module.columns.filter(
    (column) =>
      !column.semanticRole &&
      !column.computed &&
      !isSystemModuleColumn(column),
  );
  const roleTime = firstColumnByRoles(
    module,
    ["time"],
    isTimeAnalysisColumn,
  );
  const roleAmount = firstColumnByRoles(
    module,
    ["amount"],
    isNumericAnalysisColumn,
  );
  const roleDimension = firstColumnByRoles(module, [
    "product_name",
    "product_id",
    "sku",
    "status",
    "shop",
    "dimension",
  ]);
  const ordinaryTime = ordinaryColumns.find(isTimeAnalysisColumn);
  const ordinaryDimension = ordinaryColumns.find(
    (column) =>
      !isTimeAnalysisColumn(column) &&
      !isNumericAnalysisColumn(column),
  );
  const label = (column: ColumnDef) => column.label ?? column.name;

  return ordinaryColumns.flatMap((column): FieldSuggestion[] => {
    if (isNumericAnalysisColumn(column)) {
      const time = roleTime ?? ordinaryTime;
      if (time && time.name !== column.name) {
        return [{
          key: `field_${column.name}`,
          label: `${label(column)}趋势`,
          chartType: "line",
          dimension: time.name,
          metric: column.name,
        }];
      }
      const dimension = roleDimension ?? ordinaryDimension;
      if (dimension && dimension.name !== column.name) {
        return [{
          key: `field_${column.name}`,
          label: `按${label(dimension)}查看${label(column)}`,
          chartType: "bar",
          dimension: dimension.name,
          metric: column.name,
        }];
      }
      return [];
    }

    if (isTimeAnalysisColumn(column)) {
      return [{
        key: `field_${column.name}`,
        label: roleAmount
          ? `${label(roleAmount)}按${label(column)}趋势`
          : `${label(column)}记录趋势`,
        chartType: "line",
        dimension: column.name,
        metric: roleAmount?.name ?? "count",
      }];
    }

    return [{
      key: `field_${column.name}`,
      label: roleAmount
        ? `按${label(column)}查看${label(roleAmount)}`
        : `${label(column)}分布`,
      chartType: column.type === "boolean" && !roleAmount ? "pie" : "bar",
      dimension: column.name,
      metric: roleAmount?.name ?? "count",
    }];
  });
}
