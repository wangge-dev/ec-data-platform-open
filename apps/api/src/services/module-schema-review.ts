import { createHash } from "node:crypto";
import type { ColumnDef, ModuleDef } from "../modules/schema.js";
import type {
  SchemaDiff,
  SourceInspection,
} from "./module-source-inspector.js";

export type SchemaReviewDecision = {
  sourceField: string;
  decision: "add" | "alias" | "ignore";
  targetField?: string;
  dataType?: ColumnDef["type"];
  label?: string;
};

export function sourceSchemaFingerprint(
  inspection: SourceInspection,
): string {
  const shape = [...inspection.headers]
    .sort((left, right) => left.localeCompare(right))
    .map((header) => [
      header,
      inspection.inferredTypes[header] ?? "text",
    ]);
  return createHash("sha256")
    .update(JSON.stringify(shape))
    .digest("hex");
}

function decisionGroups(decisions: SchemaReviewDecision[]) {
  const groups = new Map<string, SchemaReviewDecision[]>();
  for (const decision of decisions) {
    const group = groups.get(decision.sourceField) ?? [];
    group.push(decision);
    groups.set(decision.sourceField, group);
  }
  return groups;
}

export function validateSchemaDecisionSet(
  diff: SchemaDiff,
  decisions: SchemaReviewDecision[],
): string[] {
  const errors: string[] = [];
  const added = new Set(diff.added);
  const groups = decisionGroups(decisions);

  for (const source of diff.added) {
    const matches = groups.get(source) ?? [];
    if (matches.length === 0) {
      errors.push(`新增字段「${source}」尚未选择处理方式`);
    } else if (matches.length > 1) {
      errors.push(`新增字段「${source}」只能选择一种处理方式`);
    }
  }
  for (const decision of decisions) {
    if (!added.has(decision.sourceField)) {
      errors.push(`字段「${decision.sourceField}」不在本次变化中`);
    }
  }
  return errors;
}

function addedColumnName(source: string, existing: Set<string>): string {
  const digest = createHash("sha256").update(source).digest("hex");
  for (let length = 10; length <= digest.length; length += 2) {
    const candidate = `field_${digest.slice(0, length)}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error("无法生成新的分析字段，请稍后重试");
}

function sourceList(source: string | string[] | undefined): string[] {
  if (!source) return [];
  return Array.isArray(source) ? source : [source];
}

export function applySchemaDecisions(
  module: ModuleDef,
  decisions: SchemaReviewDecision[],
): ModuleDef {
  const next = structuredClone(module);
  const existingNames = new Set(next.columns.map((column) => column.name));

  for (const decision of decisions) {
    if (decision.decision === "ignore") continue;
    if (decision.decision === "alias") {
      const target = next.columns.find(
        (column) => column.name === decision.targetField && !column.computed,
      );
      if (!target) {
        throw new Error(`「${decision.sourceField}」对应的已有字段不存在`);
      }
      target.source = [
        ...new Set([decision.sourceField, ...sourceList(target.source)]),
      ];
      continue;
    }
    if (!decision.dataType) {
      throw new Error(`请为「${decision.sourceField}」选择字段类型`);
    }
    const name = addedColumnName(decision.sourceField, existingNames);
    existingNames.add(name);
    next.columns.push({
      name,
      source: decision.sourceField,
      label: decision.label?.trim() || decision.sourceField,
      type: decision.dataType,
      required: false,
      computed: false,
    });
  }

  return next;
}

export function unresolvedSchemaDiff(
  diff: SchemaDiff,
  decisions: SchemaReviewDecision[],
): SchemaDiff {
  const ignoredSources = new Set(
    decisions
      .filter((decision) => decision.decision === "ignore")
      .map((decision) => decision.sourceField),
  );
  const requiredFields =
    diff.missingRequiredFields ??
    diff.missingRequired.map((label) => ({
      name: label,
      label,
      compatibleSources: [],
    }));
  const optionalFields =
    diff.missingOptionalFields ??
    diff.missingOptional.map((label) => ({
      name: label,
      label,
      compatibleSources: [],
    }));

  return {
    ...diff,
    added: diff.added.filter((source) => !ignoredSources.has(source)),
    missingRequired: requiredFields.map((field) => field.label),
    missingOptional: optionalFields.map((field) => field.label),
    missingRequiredFields: requiredFields,
    missingOptionalFields: optionalFields,
  };
}

export function schemaDiffBlocksProcessing(diff: SchemaDiff): boolean {
  return (
    diff.added.length > 0 ||
    diff.missingRequired.length > 0 ||
    diff.typeChanges.some((change) => change.blocking)
  );
}
