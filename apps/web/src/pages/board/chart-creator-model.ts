import type { ModuleChartPrefill } from "./module-groups";

export type ChartCreatorState = {
  modelId: string;
  modelVersion: number | null;
  metricIds: string[];
  dimensionIds: string[];
  datasetName: string;
  chartName: string;
  chartType: string;
  xField: string;
  yFields: string[];
  seriesField: string;
};

export function createChartCreatorInitialState(
  prefill?: ModuleChartPrefill,
): ChartCreatorState {
  return {
    modelId: prefill?.modelId ?? "",
    modelVersion: prefill?.modelVersion ?? null,
    metricIds: prefill ? [...prefill.metricIds] : [],
    dimensionIds: prefill ? [...prefill.dimensionIds] : [],
    datasetName: prefill?.datasetName ?? "数据集 1",
    chartName: prefill?.chartName ?? "图表 1",
    chartType: prefill?.chartType ?? "bar",
    xField: prefill?.xField ?? "",
    yFields: prefill ? [...prefill.yFields] : [],
    seriesField: "",
  };
}

export function buildChartCreatePayload(
  datasetId: number,
  state: Pick<
    ChartCreatorState,
    | "chartName"
    | "chartType"
    | "xField"
    | "yFields"
    | "seriesField"
    | "modelId"
    | "modelVersion"
    | "metricIds"
    | "dimensionIds"
  >,
  prefill?: ModuleChartPrefill,
) {
  return {
    datasetId,
    name: state.chartName,
    chartType: state.chartType,
    config: {
      title: state.chartName,
      xField: state.xField,
      yFields: state.yFields,
      aggregationMode: "none" as const,
      semanticModelId: state.modelId,
      semanticModelVersion: state.modelVersion,
      metricIds: state.metricIds,
      dimensionIds: state.dimensionIds,
      ...(state.seriesField ? { seriesField: state.seriesField } : {}),
    },
    ...(prefill ? { moduleCode: prefill.moduleCode } : {}),
  };
}
