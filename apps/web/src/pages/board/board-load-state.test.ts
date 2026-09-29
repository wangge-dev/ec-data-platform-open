import { describe, expect, test, vi } from "vitest";
import {
  boardLoadErrorMessage,
  buildBoardLoadState,
  retryBoardQueries,
} from "./board-load-state";

describe("board loading and failure state", () => {
  test.each([
    [{ status: 401 }, "登录状态已失效，请重新登录后再试。"],
    [{ status: 502 }, "看板服务暂时无法连接，请稍后重试。"],
    [{ code: "ECONNABORTED", message: "timeout of 30000ms exceeded" }, "看板请求超时，请检查服务状态后重试。"],
  ])("turns %j into an actionable message", (error, expected) => {
    expect(boardLoadErrorMessage(error)).toBe(expected);
  });

  test("does not keep reporting loading after either required query fails", () => {
    expect(buildBoardLoadState({
      chartsPending: true,
      modulesPending: false,
      chartsError: { status: 502 },
      modulesError: null,
    })).toEqual({
      status: "error",
      message: "看板服务暂时无法连接，请稍后重试。",
    });
  });

  test("waits for both required queries before rendering the dashboard", () => {
    expect(buildBoardLoadState({
      chartsPending: false,
      modulesPending: true,
      chartsError: null,
      modulesError: null,
    })).toEqual({ status: "loading" });
    expect(buildBoardLoadState({
      chartsPending: false,
      modulesPending: false,
      chartsError: null,
      modulesError: null,
    })).toEqual({ status: "ready" });
  });

  test("retries both lists so a partial recovery cannot leave stale loading state", async () => {
    const refetchCharts = vi.fn().mockResolvedValue(undefined);
    const refetchModules = vi.fn().mockResolvedValue(undefined);

    await retryBoardQueries(refetchCharts, refetchModules);

    expect(refetchCharts).toHaveBeenCalledOnce();
    expect(refetchModules).toHaveBeenCalledOnce();
  });
});
