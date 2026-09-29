import { describe, expect, test, vi } from "vitest";
import type { LoadedModule } from "../modules/loader.js";
import { resolveFileAttribution } from "./file-attribution.js";

function moduleDef(overrides: Partial<LoadedModule> = {}): LoadedModule {
  return {
    code: "pinduoduo",
    name: "拼多多测试",
    category: "shop_ops",
    enabled: true,
    columns: [],
    platforms: [
      {
        code: "generic",
        name: "通用",
        filePattern: "商品id",
        patternFlags: "i",
        enabled: true,
      },
    ],
    usages: [],
    configurable: true,
    origin: "user",
    ...overrides,
  } as LoadedModule;
}

describe("resolveFileAttribution", () => {
  test("uses the stored module assignment even when its filename keyword does not match", async () => {
    const getModule = vi.fn(async () => moduleDef());
    const matchFileToPlatform = vi.fn(async () => null);

    const result = await resolveFileAttribution(
      {
        name: "01_拼多多订单_DIY模拟_第一批",
        config: {
          originalFileName: "01_拼多多订单_DIY模拟_第一批.xlsx",
          moduleCode: "pinduoduo",
        },
      },
      { getModule, matchFileToPlatform },
    );

    expect(result).toMatchObject({
      kind: "module",
      moduleCode: "pinduoduo",
      moduleName: "拼多多测试",
    });
    expect(matchFileToPlatform).not.toHaveBeenCalled();
  });

  test("keeps filename matching as the fallback for an unassigned file", async () => {
    const matchedModule = moduleDef({ code: "orders", name: "销售订单" });
    const platform = matchedModule.platforms[0]!;

    const result = await resolveFileAttribution(
      { name: "商品id_202608.xlsx", config: {} },
      {
        getModule: vi.fn(async () => undefined),
        matchFileToPlatform: vi.fn(async () => ({
          module: matchedModule,
          platform,
        })),
      },
    );

    expect(result).toMatchObject({
      kind: "module",
      moduleCode: "orders",
      moduleName: "销售订单",
    });
  });
});
