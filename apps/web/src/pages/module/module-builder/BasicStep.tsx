import { FileSpreadsheet } from "lucide-react";
import type { BuilderSource } from "../types";
import {
  filenamePhraseCoverage,
  replaceBuilderSources,
  type ModuleBuilderState,
} from "./model";

type Props = {
  state: ModuleBuilderState;
  sources: BuilderSource[];
  allowSourceSelection: boolean;
  sourceLoading?: boolean;
  sourceError?: string | null;
  onChange: (patch: Partial<ModuleBuilderState>) => void;
};

export function BasicStep({
  state,
  sources,
  allowSourceSelection,
  sourceLoading = false,
  sourceError = null,
  onChange,
}: Props) {
  const phraseCoverage = filenamePhraseCoverage(
    state.sourceIds,
    sources,
    state.filenamePhrase,
  );
  function toggleSource(id: number) {
    const sourceIds = state.sourceIds.includes(id)
      ? state.sourceIds.filter((sourceId) => sourceId !== id)
      : [...state.sourceIds, id];
    onChange(replaceBuilderSources(state, sourceIds));
  }

  return (
    <section aria-labelledby="module-builder-basic-heading" className="space-y-4">
      <div>
        <h3 id="module-builder-basic-heading" className="font-medium">
          选择文件并命名
        </h3>
        <p className="mt-1 text-xs text-text-muted">
          同一类业务文件可一起归入，完成后会立即处理。
        </p>
      </div>

      {allowSourceSelection && (
        <fieldset>
          <legend className="mb-2 text-sm font-medium">待归入文件</legend>
          {sourceLoading ? (
            <div role="status" className="rounded-md border px-3 py-5 text-center text-sm text-text-muted">
              正在加载未归入文件…
            </div>
          ) : sourceError ? (
            <div role="alert" className="rounded-md border border-morandi-rose/30 bg-morandi-rose/5 px-3 py-3 text-sm text-morandi-rose">
              {sourceError}
            </div>
          ) : sources.length === 0 ? (
            <div className="rounded-md border border-dashed px-3 py-5 text-center text-sm text-text-muted">
              暂无未归入模块的文件，请先到数据页上传。
            </div>
          ) : (
            <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border p-2">
              {sources.map((source) => (
                <label
                  key={source.id}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-bg-subtle"
                >
                  <input
                    type="checkbox"
                    checked={state.sourceIds.includes(source.id)}
                    onChange={() => toggleSource(source.id)}
                    className="accent-morandi-3"
                  />
                  <FileSpreadsheet size={15} className="shrink-0 text-morandi-3" />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {source.config?.originalFileName || source.name}
                  </span>
                  <span className="shrink-0 text-xs text-text-muted">
                    {(source.config?.rowCount ?? 0).toLocaleString()} 行
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">模块名称</span>
          <input
            value={state.name}
            onChange={(event) => onChange({ name: event.target.value })}
            placeholder="例如：拼多多销售"
            autoFocus
            className="w-full rounded-md border bg-bg-card px-3 py-2 outline-none transition focus:border-morandi-slate focus:ring-2 focus:ring-morandi-slate/20"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">业务分类</span>
          <select
            value={state.category}
            onChange={(event) => onChange({ category: event.target.value })}
            className="w-full rounded-md border bg-bg-card px-3 py-2 outline-none transition focus:border-morandi-slate focus:ring-2 focus:ring-morandi-slate/20"
          >
            <option value="shop_ops">店铺经营</option>
            <option value="warehouse">仓储管理</option>
            <option value="finance">财务分析</option>
            <option value="customer">客户服务</option>
            <option value="other">其他业务</option>
          </select>
        </label>
      </div>

      <label className="block text-sm">
        <span className="mb-1 block font-medium">以后自动识别用的文件名关键词</span>
        <input
          value={state.filenamePhrase}
          onChange={(event) =>
            onChange({
              filenamePhrase: event.target.value,
              filenamePhraseOrigin: "manual",
            })
          }
          placeholder="例如：拼多多订单（不要填商品 ID 等表头字段）"
          className="w-full rounded-md border bg-bg-card px-3 py-2 outline-none transition focus:border-morandi-slate focus:ring-2 focus:ring-morandi-slate/20"
        />
        <span className="mt-1 block text-xs text-text-muted">
          这里只看文件名，不读取 Excel 表头或内容。例如文件名是
          「01_拼多多订单_8月.xlsx」，可填写「拼多多订单」。以后文件名包含这段文字时，会自动归入本模块。
        </span>
        {state.filenamePhrase.trim() &&
          phraseCoverage.selected > 0 &&
          phraseCoverage.matched === 0 && (
            <span
              role="status"
              className="mt-2 block rounded-md border border-morandi-3/30 bg-morandi-3/5 px-3 py-2 text-xs leading-5 text-text-secondary"
            >
              当前选中的文件名都不包含「{state.filenamePhrase.trim()}」。本次文件仍会归入模块，
              但以后无法靠这个词自动识别。建议改成文件名里稳定出现的文字。
            </span>
          )}
      </label>
    </section>
  );
}
