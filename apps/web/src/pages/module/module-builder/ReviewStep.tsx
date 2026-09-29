import type { BuilderSource } from "../types";
import { SEMANTIC_ROLES, type ModuleBuilderState, type SemanticRole } from "./model";

const OPERATION_SYMBOL = {
  add: "+",
  subtract: "−",
  multiply: "×",
  ratio: "÷",
} as const;

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

export function ReviewStep({
  state,
  sources,
}: {
  state: ModuleBuilderState;
  sources: BuilderSource[];
}) {
  const selected = sources.filter((source) => state.sourceIds.includes(source.id));
  const mappings = SEMANTIC_ROLES.flatMap((role) =>
    state.mappings[role] ? [{ role, mapping: state.mappings[role]! }] : [],
  );

  return (
    <section aria-labelledby="module-builder-review-heading" className="space-y-4">
      <div>
        <h3 id="module-builder-review-heading" className="font-medium">
          确认并开始处理
        </h3>
        <p className="mt-1 text-xs text-text-muted">
          保存后会自动归入所选文件并立即处理，无需额外设置。
        </p>
      </div>

      <dl className="grid gap-3 rounded-md border p-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-text-muted">模块名称</dt>
          <dd className="mt-0.5 font-medium">{state.name}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-muted">自动识别关键词</dt>
          <dd className="mt-0.5 font-medium">{state.filenamePhrase}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-muted">本次文件</dt>
          <dd className="mt-0.5 font-medium">
            {selected.length || state.sourceIds.length} 个
          </dd>
        </div>
        <div>
          <dt className="text-xs text-text-muted">业务字段</dt>
          <dd className="mt-0.5 font-medium">
            {mappings.length + state.additionalFields.length} 个原始字段
            {state.calculatedFields.length > 0 && `，${state.calculatedFields.length} 个计算字段`}
          </dd>
        </div>
      </dl>

      <div>
        <h4 className="mb-2 text-sm font-medium">字段对应</h4>
        <div className="divide-y rounded-md border">
          {mappings.map(({ role, mapping }) => (
            <div
              key={role}
              className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[8rem_1fr]"
            >
              <span className="text-text-muted">{ROLE_LABELS[role]}</span>
              <span className="break-words">{mapping.source}</span>
            </div>
          ))}
        </div>
      </div>

      {state.calculatedFields.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-medium">安全计算字段</h4>
          <div className="divide-y rounded-md border">
            {state.calculatedFields.map((field, index) => (
              <div
                key={`${field.label}-${index}`}
                className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[8rem_1fr]"
              >
                <span className="text-text-muted">{field.label}</span>
                <span className="break-words">
                  {field.leftSource} {OPERATION_SYMBOL[field.operation]} {field.rightSource}
                  {field.operation === "ratio" && "（汇总后再相除）"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {state.mappings.status && (
        <div>
          <h4 className="mb-2 text-sm font-medium">计入统计的状态</h4>
          <div className="flex flex-wrap gap-1.5">
            {state.includedStatuses.map((status) => (
              <span
                key={status}
                className="rounded bg-morandi-2/20 px-2 py-1 text-xs text-morandi-3"
              >
                {status}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
