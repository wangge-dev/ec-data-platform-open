// 对比 tab：复用 compare/controls.tsx 的 ControlsAndChart，但固定本模块
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { ControlsAndChart } from "./compare-controls";
import { api } from "@/lib/api";
import type { ModuleData } from "../types";

export function CompareTab({ mod }: { mod: ModuleData }) {
  const [params] = useSearchParams();
  const urlMetric = params.get("metricId") ?? "";
  const urlDim = params.get("dimensionId") ?? "";
  const urlPeriod = (params.get("period") ?? "") as "" | "dod" | "wow" | "mom" | "yoy";

  const defaultMetric = mod.semanticModel?.metrics[0]?.id ?? "";
  const defaultDim = mod.semanticModel?.dimensions.find((dimension) => dimension.kind === "categorical")?.id ?? "";

  const [metric, setMetric] = useState(urlMetric || defaultMetric);
  const [dim, setDim] = useState(urlDim || defaultDim);
  const [period, setPeriod] = useState<"dod" | "wow" | "mom" | "yoy">(urlPeriod || "dod");
  const [baseDate, setBaseDate] = useState("");

  const { data: dates } = useQuery({
    queryKey: ["metrics-dates", mod.code],
    queryFn: async () => {
      const r: any = await api.get(`/metrics/dates?module=${mod.code}`);
      return r.data as string[];
    },
  });

  useEffect(() => {
    if (dates && dates.length > 0 && !baseDate) {
      setBaseDate(String(dates[0]).slice(0, 10));
    }
  }, [dates, baseDate]);

  const { data: compareData, isLoading, error } = useQuery({
    queryKey: ["metrics-compare", mod.code, metric, dim, period, baseDate],
    queryFn: async () => {
      const params = new URLSearchParams({
        module: mod.code,
        metricId: metric,
        period,
        date: baseDate,
      });
      if (dim) params.set("dimensionId", dim);
      const r: any = await api.get(`/metrics/compare?${params}`);
      return r.data;
    },
    enabled: !!(mod.code && mod.semanticModel && metric && baseDate),
  });

  // 模块下拉只放本模块（伪装成单选）
  const mods = [
    { code: mod.code, name: mod.name, outputTable: mod.outputTable, timeKey: mod.timeKey, columns: mod.columns },
  ];

  if (!mod.semanticModel) {
    return (
      <div className="card p-10 text-center text-sm text-text-muted">
        本模块还没有 semantic-manifest/v1，无法做稳定指标对比
      </div>
    );
  }

  return (
    <ControlsAndChart
      mods={mods as any}
      currentMod={mods[0] as any}
      moduleCode={mod.code}
      setModuleCode={() => {
        /* 本 tab 锁定模块 */
      }}
      metric={metric}
      setMetric={setMetric}
      dim={dim}
      setDim={setDim}
      period={period}
      setPeriod={setPeriod}
      baseDate={baseDate}
      setBaseDate={setBaseDate}
      dates={dates ?? []}
      data={compareData}
      isLoading={isLoading}
      error={error}
    />
  );
}
