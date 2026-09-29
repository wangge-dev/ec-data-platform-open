export type SemanticRole =
  | "time"
  | "amount"
  | "quantity"
  | "product_id"
  | "product_name"
  | "order_id"
  | "status"
  | "sku"
  | "shop"
  | "dimension";

export type ModuleColumnType =
  | "text"
  | "int"
  | "numeric"
  | "timestamp"
  | "date"
  | "boolean";

export type ColumnType = ModuleColumnType;

export type SchemaDiff = {
  added: string[];
  missingRequired: string[];
  missingOptional: string[];
  missingRequiredFields?: Array<{
    name: string;
    label: string;
    compatibleSources?: string[];
  }>;
  missingOptionalFields?: Array<{
    name: string;
    label: string;
    compatibleSources?: string[];
  }>;
  aliasCandidates: Array<{ source: string; target: string; score: number }>;
  typeChanges: Array<{
    source: string;
    target?: string;
    label?: string;
    expected: ColumnType;
    required?: boolean;
    blocking?: boolean;
    compatibleSources?: string[];
    failures: number;
    samples: string[];
  }>;
  expectedVersion?: number;
  operationId?: string;
  sourceIds?: number[];
  schemaFingerprints?: Record<string, string>;
  files?: Array<{ sourceId: number; fileName: string }>;
  reviewStatus?: "pending" | "awaiting_retry";
  stagedDecisions?: Array<{
    sourceField: string;
    decision: "add" | "alias" | "ignore";
    targetField?: string;
    dataType?: ColumnType;
    label?: string;
  }>;
  retryMessage?: string;
};

export type SchemaDecision =
  | { source: string; action: "add"; label: string; type: ColumnType }
  | { source: string; action: "alias"; target: string }
  | { source: string; action: "ignore" };

export function summarizePendingSchemaFiles<T>(
  files: T[],
  visibleLimit = 3,
): { visible: T[]; remaining: number } {
  return {
    visible: files.slice(0, visibleLimit),
    remaining: Math.max(0, files.length - visibleLimit),
  };
}

export type FieldMapping = {
  source: string;
  label: string;
  type: ModuleColumnType;
  required: boolean;
};

export type AdditionalFieldMapping = {
  source: string;
  label: string;
  type: ModuleColumnType;
};

export type CalculatedFieldOperation = "add" | "subtract" | "multiply" | "ratio";

export type CalculatedField = {
  label: string;
  operation: CalculatedFieldOperation;
  leftSource: string;
  rightSource: string;
  unit: "number" | "currency" | "percent" | "quantity";
};

export type BuilderStep =
  | "basic"
  | "mapping"
  | "status"
  | "review"
  | "result";

export type ModuleBuilderState = {
  sourceIds: number[];
  name: string;
  category: string;
  filenamePhrase: string;
  filenamePhraseOrigin: "auto" | "manual";
  headers: string[];
  samples: Record<string, unknown>[];
  mappings: Record<SemanticRole, FieldMapping | null>;
  additionalFields: AdditionalFieldMapping[];
  calculatedFields: CalculatedField[];
  includedStatuses: string[];
  step: BuilderStep;
  idempotencyKey: string;
};

export type CreateModuleRequest = {
  name: string;
  category?: string;
  sourceIds: number[];
  filenamePhrase: string;
  mappings: Array<FieldMapping & { semanticRole: SemanticRole }>;
  additionalFields: AdditionalFieldMapping[];
  calculatedFields?: CalculatedField[];
  inclusion?: {
    statusSource: string;
    includedValues: string[];
  };
  idempotencyKey: string;
};

export const SEMANTIC_ROLES: SemanticRole[] = [
  "time",
  "amount",
  "quantity",
  "product_id",
  "product_name",
  "order_id",
  "status",
  "sku",
  "shop",
  "dimension",
];

export function emptyMappings(): ModuleBuilderState["mappings"] {
  return Object.fromEntries(
    SEMANTIC_ROLES.map((role) => [role, null]),
  ) as ModuleBuilderState["mappings"];
}

export function createInitialBuilderState(
  sourceIds: number[],
  idempotencyKey: string,
): ModuleBuilderState {
  return {
    sourceIds: [...sourceIds],
    name: "",
    category: "shop_ops",
    filenamePhrase: "",
    filenamePhraseOrigin: "auto",
    headers: [],
    samples: [],
    mappings: emptyMappings(),
    additionalFields: [],
    calculatedFields: [],
    includedStatuses: [],
    step: "basic",
    idempotencyKey,
  };
}

export function replaceBuilderSources(
  state: ModuleBuilderState,
  sourceIds: number[],
): ModuleBuilderState {
  return {
    ...state,
    sourceIds: [...sourceIds],
    filenamePhrase:
      state.filenamePhraseOrigin === "manual" ? state.filenamePhrase : "",
    headers: [],
    samples: [],
    mappings: emptyMappings(),
    additionalFields: [],
    calculatedFields: [],
    includedStatuses: [],
    step: "basic",
  };
}

export function applyInspectedFilenamePhrase(
  state: ModuleBuilderState,
  filenamePhrase?: string | null,
): ModuleBuilderState {
  if (state.filenamePhraseOrigin === "manual") return state;
  return {
    ...state,
    filenamePhrase: filenamePhrase ?? "",
    filenamePhraseOrigin: "auto",
  };
}

const GENERIC_BUILDER_ERROR = "处理失败，可稍后在数据页重试";
const SAFE_BUILDER_ERRORS = new Set([
  "字段有变化，需确认后重新处理",
  "未导入品牌维护表，请先导入",
  "品牌维护表缺少必要的 ID 字段",
  "品牌维护表缺少必要的商家编码字段",
  "订单文件缺少必要字段，请检查字段对应",
  "输入文件缺少必要字段，请检查字段对应",
  "订单字段映射缺少商品或金额字段，请检查字段对应",
  "必填字段缺失，请检查字段对应",
]);
export function builderFailureMessage(rawError?: unknown): string {
  if (typeof rawError !== "string") return GENERIC_BUILDER_ERROR;
  const message = rawError.trim();
  if (SAFE_BUILDER_ERRORS.has(message)) return message;
  return GENERIC_BUILDER_ERROR;
}

function selectedSources(state: ModuleBuilderState): string[] {
  return [
    ...SEMANTIC_ROLES.flatMap((role) => {
      const mapping = state.mappings[role];
      return mapping ? [mapping.source] : [];
    }),
    ...state.additionalFields.map((field) => field.source),
  ];
}

export function numericBuilderSources(state: ModuleBuilderState): string[] {
  return Array.from(new Set([
    ...SEMANTIC_ROLES.flatMap((role) => {
      const mapping = state.mappings[role];
      return mapping && (mapping.type === "int" || mapping.type === "numeric")
        ? [mapping.source]
        : [];
    }),
    ...state.additionalFields
      .filter((field) => field.type === "int" || field.type === "numeric")
      .map((field) => field.source),
  ]));
}

export function validateBuilderStep(state: ModuleBuilderState): string[] {
  const errors: string[] = [];

  if (state.step === "basic") {
    if (state.sourceIds.length === 0) errors.push("请选择至少一个待归入文件");
    if (!state.name.trim()) errors.push("请填写模块名称");
    if (!state.filenamePhrase.trim()) {
      errors.push("请填写以后自动识别用的文件名关键词");
    }
    return errors;
  }

  if (state.step === "mapping" || state.step === "status" || state.step === "review") {
    const mappings = SEMANTIC_ROLES.flatMap((role) =>
      state.mappings[role] ? [state.mappings[role]!] : [],
    );
    if (mappings.length === 0) errors.push("请至少映射一个字段");

    const sources = selectedSources(state);
    if (new Set(sources).size !== sources.length) {
      errors.push("同一源字段不能重复映射");
    }

    const status = state.mappings.status;
    if (status && state.includedStatuses.length === 0) {
      errors.push("请选择至少一个计入有效数据的状态");
    }

    const numericSources = new Set(numericBuilderSources(state));
    const labels = new Set<string>();
    for (const calculated of state.calculatedFields) {
      const label = calculated.label.trim();
      if (!label) errors.push("请填写计算字段名称");
      if (label && labels.has(label)) errors.push(`计算字段名称「${label}」重复`);
      if (label) labels.add(label);
      if (!numericSources.has(calculated.leftSource) || !numericSources.has(calculated.rightSource)) {
        errors.push(`计算字段「${label || "未命名"}」只能选择已映射的数值字段`);
      } else if (calculated.leftSource === calculated.rightSource) {
        errors.push(`计算字段「${label || "未命名"}」的左右两项不能相同`);
      }
    }
  }

  return errors;
}

export function filenamePhraseCoverage(
  sourceIds: number[],
  sources: Array<{
    id: number;
    name: string;
    config?: { originalFileName?: string };
  }>,
  phrase: string,
): { selected: number; matched: number } {
  const normalizedPhrase = phrase.trim().toLocaleLowerCase("zh-CN");
  const selectedSources = sources.filter((source) => sourceIds.includes(source.id));
  if (!normalizedPhrase) return { selected: selectedSources.length, matched: 0 };

  return {
    selected: selectedSources.length,
    matched: selectedSources.filter((source) => {
      const fileName = source.config?.originalFileName || source.name;
      return fileName.toLocaleLowerCase("zh-CN").includes(normalizedPhrase);
    }).length,
  };
}

export function buildCreateModuleRequest(
  state: ModuleBuilderState,
): CreateModuleRequest {
  const mappings = SEMANTIC_ROLES.flatMap((semanticRole) => {
    const mapping = state.mappings[semanticRole];
    return mapping ? [{ semanticRole, ...mapping }] : [];
  });
  const status = state.mappings.status;

  return {
    name: state.name.trim(),
    ...(state.category.trim() ? { category: state.category.trim() } : {}),
    sourceIds: [...state.sourceIds],
    filenamePhrase: state.filenamePhrase.trim(),
    mappings,
    additionalFields: state.additionalFields.map((field) => ({ ...field })),
    ...(state.calculatedFields.length > 0
      ? { calculatedFields: state.calculatedFields.map((field) => ({ ...field })) }
      : {}),
    ...(status
      ? {
          inclusion: {
            statusSource: status.source,
            includedValues: [...state.includedStatuses],
          },
        }
      : {}),
    idempotencyKey: state.idempotencyKey,
  };
}

export function validateSchemaDecisions(
  diff: SchemaDiff,
  decisions: SchemaDecision[],
): string[] {
  const errors: string[] = [];
  const added = new Set(diff.added);
  const bySource = new Map<string, SchemaDecision[]>();

  for (const decision of decisions) {
    const group = bySource.get(decision.source) ?? [];
    group.push(decision);
    bySource.set(decision.source, group);
  }

  for (const source of diff.added) {
    const matches = bySource.get(source) ?? [];
    if (matches.length === 0) {
      errors.push(`新增字段「${source}」尚未选择处理方式`);
      continue;
    }
    if (matches.length > 1) {
      errors.push(`新增字段「${source}」只能选择一种处理方式`);
    }
    const decision = matches[0];
    if (decision.action === "add" && !decision.label.trim()) {
      errors.push(`请填写「${source}」的显示名称`);
    }
    if (decision.action === "alias" && !decision.target.trim()) {
      errors.push(`请选择「${source}」要对应的已有字段`);
    }
  }

  for (const decision of decisions) {
    if (!added.has(decision.source)) {
      errors.push(`字段「${decision.source}」不在本次变化中`);
    }
  }

  const requiredFields =
    diff.missingRequiredFields ??
    diff.missingRequired.map((label) => ({
      name: label,
      label,
      compatibleSources: diff.added,
    }));
  for (const field of requiredFields) {
    const compatibleSources = field.compatibleSources ?? diff.added;
    const replacement = decisions.find(
      (decision) =>
        decision.action === "alias" &&
        decision.target === field.name &&
        compatibleSources.includes(decision.source),
    );
    if (!replacement) {
      errors.push(`必要字段「${field.label}」尚未对应`);
    }
  }

  for (const change of diff.typeChanges.filter((candidate) => candidate.blocking)) {
    const target = change.target ?? change.source;
    const label = change.label ?? change.source;
    const compatibleSources = change.compatibleSources ?? [];
    const replacement = decisions.find(
      (decision) =>
        decision.action === "alias" &&
        decision.target === target &&
        compatibleSources.includes(decision.source),
    );
    if (replacement) continue;
    errors.push(
      compatibleSources.length > 0
        ? `字段「${label}」格式不兼容，请选择可用字段重新对应`
        : `字段「${label}」格式不兼容，请修正源文件后重新上传`,
    );
  }

  return errors;
}

export function buildSchemaDecisionRequest(
  diff: SchemaDiff,
  decisions: SchemaDecision[],
) {
  if (
    !diff.expectedVersion ||
    !diff.operationId ||
    !diff.sourceIds?.length ||
    !diff.schemaFingerprints
  ) {
    throw new Error("字段变化信息已过期");
  }
  return {
    sourceIds: [...new Set(diff.sourceIds)].sort((a, b) => a - b),
    expectedVersion: diff.expectedVersion,
    operationId: diff.operationId,
    schemaFingerprints: { ...diff.schemaFingerprints },
    decisions: decisions.map((decision) => {
      if (decision.action === "add") {
        return {
          sourceField: decision.source,
          decision: "add" as const,
          label: decision.label.trim(),
          dataType: decision.type,
        };
      }
      if (decision.action === "alias") {
        return {
          sourceField: decision.source,
          decision: "alias" as const,
          targetField: decision.target,
        };
      }
      return {
        sourceField: decision.source,
        decision: "ignore" as const,
      };
    }),
  };
}
