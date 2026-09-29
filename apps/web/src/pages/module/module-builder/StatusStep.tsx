import type { ModuleSourceInspection } from "../types";
import type { ModuleBuilderState } from "./model";

type Props = {
  state: ModuleBuilderState;
  inspection: ModuleSourceInspection;
  onChange: (patch: Partial<ModuleBuilderState>) => void;
};

export function StatusStep({ state, inspection, onChange }: Props) {
  const statusMapping = state.mappings.status;

  if (!statusMapping) {
    return (
      <section aria-labelledby="module-builder-status-heading" className="space-y-3">
        <h3 id="module-builder-status-heading" className="font-medium">
          有效数据范围
        </h3>
        <div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-text-muted">
          未选择状态字段，所有行都会保留并计入统计。
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="module-builder-status-heading" className="space-y-4">
      <div>
        <h3 id="module-builder-status-heading" className="font-medium">
          选择计入统计的状态
        </h3>
        <p className="mt-1 text-xs text-text-muted">
          未勾选的状态仍会保留，只是不计入默认图表和统计。
        </p>
      </div>

      {inspection.statusValues.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-text-muted">
          当前样本没有可选状态。请返回上一步确认状态字段，或取消状态映射。
        </div>
      ) : (
        <fieldset className="space-y-1">
          <legend className="sr-only">计入统计的状态</legend>
          {inspection.statusValues.map((status) => {
            const checked = state.includedStatuses.includes(status.value);
            return (
              <label
                key={status.value}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 hover:bg-bg-subtle"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    onChange({
                      includedStatuses: checked
                        ? state.includedStatuses.filter(
                            (value) => value !== status.value,
                          )
                        : [...state.includedStatuses, status.value],
                    })
                  }
                  className="accent-morandi-3"
                />
                <span className="flex-1 text-sm">{status.value}</span>
                <span className="text-xs text-text-muted">
                  {status.rows.toLocaleString()} 行
                </span>
              </label>
            );
          })}
        </fieldset>
      )}
    </section>
  );
}
