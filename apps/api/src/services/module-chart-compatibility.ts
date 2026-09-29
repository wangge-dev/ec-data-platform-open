import type {
  ColumnDef,
  ModuleDef,
  SemanticRole,
} from "../modules/schema.js";

const SYSTEM_MODULE_COLUMNS = new Set([
  "id",
  "source_id",
  "included",
  "excluded_reason",
]);

export function isNumericAnalysisColumn(column: ColumnDef): boolean {
  return column.type === "int" || column.type === "numeric";
}

export function isTimeAnalysisColumn(column: ColumnDef): boolean {
  return column.type === "date" || column.type === "timestamp";
}

export function isSystemModuleColumn(column: ColumnDef): boolean {
  return (
    column.name.startsWith("_") ||
    SYSTEM_MODULE_COLUMNS.has(column.name)
  );
}

export function firstColumnByRoles(
  module: ModuleDef,
  roles: SemanticRole[],
  compatible: (column: ColumnDef) => boolean = () => true,
): ColumnDef | undefined {
  return module.columns.find(
    (column) =>
      column.semanticRole !== undefined &&
      roles.includes(column.semanticRole) &&
      compatible(column),
  );
}
