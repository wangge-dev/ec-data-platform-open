import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import type { ModuleSourceInspection } from "../types";
import {
  SEMANTIC_ROLES,
  numericBuilderSources,
  type CalculatedFieldOperation,
  type ModuleBuilderState,
  type ModuleColumnType,
  type SemanticRole,
} from "./model";

const ROLE_LABELS: Record<SemanticRole, string> = {
  time: "日期",
  amount: "金额",
  quantity: "数量",
  product_id: "商品编码",
  product_name: "商品名称",
  order_id: "订单编号",
  status: "状态",
  sku: "规格编码",
  shop: "店铺",
  dimension: "其他分析维度",
};

const REQUIRED_ROLES = new Set<SemanticRole>(["time", "amount", "quantity"]);

const OPERATION_LABELS: Record<CalculatedFieldOperation, string> = {
  add: "相加",
  subtract: "相减",
  multiply: "相乘",
  ratio: "相除（按汇总分子/分母计算）",
};

type Props = {
  state: ModuleBuilderState;
  inspection: ModuleSourceInspection;
  onChange: (patch: Partial<ModuleBuilderState>) => void;
};

export function MappingStep({ state, inspection, onChange }: Props) {
  function choose(role: SemanticRole, source: string) {
    if (!source) {
      onChange({
        mappings: { ...state.mappings, [role]: null },
        ...(role === "status" ? { includedStatuses: [] } : {}),
      });
      return;
    }
    const type = inspection.inferredTypes[source] ?? "text";
    onChange({
      mappings: {
        ...state.mappings,
        [role]: {
          source,
          label: source,
          type,
          required: REQUIRED_ROLES.has(role),
        },
      },
      additionalFields: state.additionalFields.filter(
        (field) => field.source !== source,
      ),
      ...(role === "status" &&
      state.mappings.status?.source !== source
        ? { includedStatuses: [] }
        : {}),
    });
  }

  function setType(role: SemanticRole, type: ModuleColumnType) {
    const mapping = state.mappings[role];
    if (!mapping) return;
    onChange({
      mappings: {
        ...state.mappings,
        [role]: { ...mapping, type },
      },
    });
  }

  function addCalculatedField() {
    const sources = numericBuilderSources(state);
    if (sources.length < 2 || state.calculatedFields.length >= 10) return;
    const existing = new Set(state.calculatedFields.map((field) => field.label));
    let index = state.calculatedFields.length + 1;
    let label = "计算字段";
    while (existing.has(label)) {
      label = `计算字段 ${index}`;
      index += 1;
    }
    onChange({
      calculatedFields: [
        ...state.calculatedFields,
        {
          label,
          operation: "subtract",
          leftSource: sources[0],
          rightSource: sources[1],
          unit: "number",
        },
      ],
    });
  }

  const used = new Set(
    SEMANTIC_ROLES.flatMap((role) =>
      state.mappings[role] ? [state.mappings[role]!.source] : [],
    ),
  );
  const remaining = inspection.headers.filter((header) => !used.has(header));
  const conversions = SEMANTIC_ROLES.flatMap((role) => {
    const mapping = state.mappings[role];
    if (!mapping) return [];
    const inferred = inspection.inferredTypes[mapping.source];
    return inferred && inferred !== mapping.type
      ? [`${mapping.source}：识别为${typeLabel(inferred)}，将按${typeLabel(mapping.type)}处理`]
      : [];
  });
  const numericSources = numericBuilderSources(state);

  return (
    <section aria-labelledby="module-builder-mapping-heading" className="space-y-4">
      <div>
        <h3 id="module-builder-mapping-heading" className="font-medium">
          对应业务字段
        </h3>
        <p className="mt-1 text-xs text-text-muted">
          逐项选择日期、金额、数量、商品等字段；不需要的项目可留空。
        </p>
      </div>

      <div className="space-y-2">
        {SEMANTIC_ROLES.map((role) => {
          const mapping = state.mappings[role];
          return (
            <div
              key={role}
              className="grid gap-2 rounded-md border px-3 py-2 sm:grid-cols-[9rem_minmax(0,1fr)_8rem] sm:items-center"
            >
              <label htmlFor={`mapping-${role}`} className="text-sm font-medium">
                {ROLE_LABELS[role]}
              </label>
              <select
                id={`mapping-${role}`}
                value={mapping?.source ?? ""}
                onChange={(event) => choose(role, event.target.value)}
                className="min-w-0 rounded-md border bg-bg-card px-2 py-2 text-sm outline-none focus:border-morandi-slate focus:ring-2 focus:ring-morandi-slate/20"
              >
                <option value="">不使用</option>
                {inspection.headers.map((header) => (
                  <option key={header} value={header}>
                    {header}
                  </option>
                ))}
              </select>
              <select
                aria-label={`${ROLE_LABELS[role]}字段格式`}
                value={mapping?.type ?? "text"}
                disabled={!mapping}
                onChange={(event) =>
                  setType(role, event.target.value as ModuleColumnType)
                }
                className="rounded-md border bg-bg-card px-2 py-2 text-sm outline-none disabled:opacity-40 focus:border-morandi-slate focus:ring-2 focus:ring-morandi-slate/20"
              >
                <option value="text">文字</option>
                <option value="int">整数</option>
                <option value="numeric">数值</option>
                <option value="timestamp">日期时间</option>
                <option value="date">日期</option>
                <option value="boolean">是/否</option>
              </select>
            </div>
          );
        })}
      </div>

      {conversions.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-morandi-rose/30 bg-morandi-rose/5 px-3 py-2 text-xs text-text-secondary">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-morandi-rose" />
          <div>
            <div className="font-medium text-text-primary">字段格式提醒</div>
            {conversions.map((warning) => (
              <div key={warning}>{warning}</div>
            ))}
          </div>
        </div>
      )}

      {remaining.length > 0 && (
        <fieldset>
          <legend className="mb-2 text-sm font-medium">保留其他字段</legend>
          <div className="grid max-h-36 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">
            {remaining.map((header) => {
              const checked = state.additionalFields.some(
                (field) => field.source === header,
              );
              return (
                <label
                  key={header}
                  className="flex min-h-10 cursor-pointer items-center gap-2 rounded px-2 hover:bg-bg-subtle"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const additionalFields = checked
                        ? state.additionalFields.filter(
                            (field) => field.source !== header,
                          )
                        : [
                            ...state.additionalFields,
                            {
                              source: header,
                              label: header,
                              type: inspection.inferredTypes[header] ?? "text",
                            },
                          ];
                      onChange({ additionalFields });
                    }}
                    className="accent-morandi-3"
                  />
                  <span className="min-w-0 truncate text-sm">{header}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      <section aria-labelledby="module-builder-calculated-heading" className="rounded-md border p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h4 id="module-builder-calculated-heading" className="text-sm font-medium">
              安全计算字段（可选）
            </h4>
            <p className="mt-1 text-xs text-text-muted">
              只组合上面已经映射的数值字段；系统生成受限公式，不需要写 SQL。
            </p>
          </div>
          <button
            type="button"
            onClick={addCalculatedField}
            disabled={numericSources.length < 2 || state.calculatedFields.length >= 10}
            className="inline-flex min-h-9 items-center gap-1 rounded-md border px-3 py-1.5 text-xs transition hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus size={14} />
            新增计算字段
          </button>
        </div>

        {numericSources.length < 2 ? (
          <p className="mt-3 rounded bg-bg-subtle px-3 py-2 text-xs text-text-muted">
            先把至少两个字段设置为“整数”或“数值”，再添加公式。
          </p>
        ) : state.calculatedFields.length === 0 ? (
          <p className="mt-3 text-xs text-text-muted">
            可用于销售额－成本、单价×数量、点击量÷曝光量等常见公式。
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {state.calculatedFields.map((field, index) => (
              <div key={`calculated-${index}`} className="rounded-md border bg-bg-subtle/30 p-2.5">
                <div className="grid gap-2 sm:grid-cols-[minmax(8rem,1fr)_auto]">
                  <label className="text-xs text-text-secondary">
                    字段名称
                    <input
                      value={field.label}
                      maxLength={128}
                      onChange={(event) => {
                        const calculatedFields = [...state.calculatedFields];
                        calculatedFields[index] = { ...field, label: event.target.value };
                        onChange({ calculatedFields });
                      }}
                      className="mt-1 min-h-9 w-full rounded-md border bg-bg-card px-2 text-sm outline-none focus:border-morandi-slate focus:ring-2 focus:ring-morandi-slate/20"
                    />
                  </label>
                  <button
                    type="button"
                    aria-label={`删除计算字段 ${field.label}`}
                    onClick={() => onChange({
                      calculatedFields: state.calculatedFields.filter((_, itemIndex) => itemIndex !== index),
                    })}
                    className="mt-5 inline-flex min-h-9 items-center justify-center rounded-md border px-2 text-text-muted transition hover:bg-morandi-rose/10 hover:text-morandi-rose focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  <FormulaSelect
                    label="左侧字段"
                    value={field.leftSource}
                    options={numericSources}
                    onChange={(value) => {
                      const calculatedFields = [...state.calculatedFields];
                      calculatedFields[index] = { ...field, leftSource: value };
                      onChange({ calculatedFields });
                    }}
                  />
                  <label className="text-xs text-text-secondary">
                    运算
                    <select
                      value={field.operation}
                      onChange={(event) => {
                        const operation = event.target.value as CalculatedFieldOperation;
                        const calculatedFields = [...state.calculatedFields];
                        calculatedFields[index] = {
                          ...field,
                          operation,
                          ...(operation === "ratio" && field.unit === "number" ? { unit: "percent" as const } : {}),
                        };
                        onChange({ calculatedFields });
                      }}
                      className="mt-1 min-h-9 w-full rounded-md border bg-bg-card px-2 text-sm outline-none focus:border-morandi-slate focus:ring-2 focus:ring-morandi-slate/20"
                    >
                      {Object.entries(OPERATION_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </label>
                  <FormulaSelect
                    label="右侧字段"
                    value={field.rightSource}
                    options={numericSources}
                    onChange={(value) => {
                      const calculatedFields = [...state.calculatedFields];
                      calculatedFields[index] = { ...field, rightSource: value };
                      onChange({ calculatedFields });
                    }}
                  />
                  <label className="text-xs text-text-secondary">
                    展示单位
                    <select
                      value={field.unit}
                      onChange={(event) => {
                        const calculatedFields = [...state.calculatedFields];
                        calculatedFields[index] = {
                          ...field,
                          unit: event.target.value as typeof field.unit,
                        };
                        onChange({ calculatedFields });
                      }}
                      className="mt-1 min-h-9 w-full rounded-md border bg-bg-card px-2 text-sm outline-none focus:border-morandi-slate focus:ring-2 focus:ring-morandi-slate/20"
                    >
                      <option value="number">数值</option>
                      <option value="currency">金额</option>
                      <option value="percent">百分比</option>
                      <option value="quantity">数量</option>
                    </select>
                  </label>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

function FormulaSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-xs text-text-secondary">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 min-h-9 w-full rounded-md border bg-bg-card px-2 text-sm outline-none focus:border-morandi-slate focus:ring-2 focus:ring-morandi-slate/20"
      >
        {options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

function typeLabel(type: ModuleColumnType): string {
  return {
    text: "文字",
    int: "整数",
    numeric: "数值",
    timestamp: "日期时间",
    date: "日期",
    boolean: "是/否",
  }[type];
}
