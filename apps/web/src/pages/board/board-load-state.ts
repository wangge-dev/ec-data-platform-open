type BoardLoadInput = {
  chartsPending: boolean;
  modulesPending: boolean;
  chartsError: unknown;
  modulesError: unknown;
};

export type BoardLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready" };

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  return typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : undefined;
}

export function boardLoadErrorMessage(error: unknown): string {
  const record = errorRecord(error);
  const response = errorRecord(record?.response);
  const status = record?.status ?? response?.status;
  const code = record?.code;
  const message = typeof record?.message === "string" ? record.message : "";

  if (status === 401) return "登录状态已失效，请重新登录后再试。";
  if (status === 502 || status === 503 || status === 504) {
    return "看板服务暂时无法连接，请稍后重试。";
  }
  if (code === "ECONNABORTED" || /timeout/i.test(message)) {
    return "看板请求超时，请检查服务状态后重试。";
  }
  return "看板数据加载失败，请检查服务状态后重试。";
}

export function buildBoardLoadState(input: BoardLoadInput): BoardLoadState {
  const error = input.chartsError ?? input.modulesError;
  if (error) return { status: "error", message: boardLoadErrorMessage(error) };
  if (input.chartsPending || input.modulesPending) return { status: "loading" };
  return { status: "ready" };
}

export async function retryBoardQueries(
  refetchCharts: () => Promise<unknown>,
  refetchModules: () => Promise<unknown>,
): Promise<void> {
  await Promise.all([refetchCharts(), refetchModules()]);
}
