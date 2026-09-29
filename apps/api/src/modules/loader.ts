/**
 * 模块加载器（D 方案阶段 1）
 *
 * 启动时扫描 modules/*.json，validate + 加载钩子，缓存到内存。
 * 后续 ETL/路由/前端都从这里拿模块定义。
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateModuleConfig, type ModuleDef, type ColumnDef, type PlatformDef } from "./schema.js";
import type { StoredModuleConfig } from "../services/module-config-store.js";
import { compileSafeFilePattern } from "../lib/file-pattern.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Transform 钩子的上下文：模块自定义处理时拿到的所有素材
 */
export type TransformContext = {
  /** 当前模块定义 */
  module: ModuleDef;
  /** 当前平台代号 */
  platform: string;
  /** 从 Excel/CSV 读出来的原始行（中文列名）。简单模块路径会塞数据，订单模块走 SQL 不用这个 */
  rawRows?: Record<string, any>[];
  /** 按 schema 映射后的行（英文列名，类型已 CAST）。订单模块也不用 */
  mappedRows?: Record<string, any>[];
  /** 原始文件名（订单模块走 SQL 时用，简单模块也可用） */
  rawFileName?: string;
  /** 数据库连接（postgres 客户端），可执行 SELECT */
  sql?: any;
  /** 额外参数（订单钩子需要 sourceId 等），调用方按需塞 */
  extra?: Record<string, any>;
};

/**
 * Transform 钩子签名：模块的 transform.ts 必须 default export 这个函数
 * 返回值类型由模块自定决定（订单返回 EtlReport，简单模块返回行数组）
 */
export type TransformFn = (ctx: TransformContext) => Promise<any>;

/**
 * 加载后的模块（合并了 JSON 配置 + 钩子函数）
 */
export type LoadedModule = ModuleDef & {
  /** 如果 hasTransform=true，这里是已 import 的钩子函数；否则 undefined */
  transform?: TransformFn;
  /** 配置来自代码内置模块还是数据库用户模块 */
  origin: "builtin" | "user";
  /** 数据库存储版本；纯代码内置模块没有版本 */
  version?: number;
  /** 是否允许通过模块配置流程调整 */
  configurable: boolean;
};

let _modules: LoadedModule[] | null = null;
// 退役模块只从运行时隐藏；历史表、迁移和数据库配置保留，不做破坏性清理。
const RETIRED_MODULE_CODES = new Set(["shopee_ads", "shopee_sales"]);
let _deps: {
  listStoredModules: () => Promise<StoredModuleConfig[]>;
} = {
  listStoredModules: async () => [],
};

export function configureModuleLoader(deps: {
  listStoredModules: () => Promise<StoredModuleConfig[]>;
}): void {
  _deps = deps;
  invalidateModuleCache();
}

export function invalidateModuleCache(): void {
  _modules = null;
}

function attachRuntimeMetadata(
  module: ModuleDef,
  metadata: {
    transform?: TransformFn;
    origin: LoadedModule["origin"];
    version?: number;
    configurable: boolean;
  },
): LoadedModule {
  const loaded = { ...module, transform: metadata.transform } as LoadedModule;
  Object.defineProperties(loaded, {
    origin: {
      value: metadata.origin,
      enumerable: false,
      writable: false,
    },
    version: {
      value: metadata.version,
      enumerable: false,
      writable: false,
    },
    configurable: {
      value: metadata.configurable,
      enumerable: false,
      writable: false,
    },
  });
  return loaded;
}

/**
 * 扫描 modules/ 目录，仅加载代码内置模块及其 transform 钩子。
 */
async function loadBuiltInModules(): Promise<LoadedModule[]> {
  const dir = __dirname;
  const jsonFiles = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
  const loaded: LoadedModule[] = [];

  for (const filename of jsonFiles) {
    const filepath = path.join(dir, filename);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filepath, "utf-8"));
    } catch (e: any) {
      console.error(`[modules] ${filename} JSON 解析失败：${e.message}`);
      continue;
    }

    // validate（schema.ts 里写错就抛错）
    let mod: ModuleDef;
    try {
      mod = validateModuleConfig(raw, filename);
    } catch (e: any) {
      console.error(`[modules] ${filename} 配置校验失败：\n${e.message}`);
      throw e; // 配置错误直接拒绝启动，避免坏配置进生产
    }

    if (RETIRED_MODULE_CODES.has(mod.code)) continue;

    // 加载钩子（如果有）
    let transform: TransformFn | undefined;
    if (mod.hasTransform) {
      const hookCandidates = [
        filename.replace(/\.json$/, ".transform.ts"),
        filename.replace(/\.json$/, ".transform.js"),
      ];
      let hookFile: string | null = null;
      for (const candidate of hookCandidates) {
        const fullPath = path.join(dir, candidate);
        if (existsSync(fullPath)) {
          hookFile = fullPath;
          break;
        }
      }
      if (!hookFile) {
        console.warn(`[modules] ${filename} 声明 hasTransform=true 但没找到 transform 文件，按默认逻辑走`);
      } else {
        try {
          // 动态 import 钩子。tsx 跑源码时 .ts 可直接 import，编译后是 .js
          const mod_ = await import(/* @vite-ignore */ hookFile.replace(/\\/g, "/"));
          transform = mod_.default as TransformFn;
          if (typeof transform !== "function") {
            console.error(`[modules] ${hookFile} 没有 default export 函数`);
            transform = undefined;
          }
        } catch (e: any) {
          console.error(`[modules] 加载 ${hookFile} 失败：${e.message}`);
        }
      }
    }

    loaded.push(
      attachRuntimeMetadata(mod, {
        transform,
        origin: "builtin",
        configurable: true,
      }),
    );
  }

  return loaded;
}

/**
 * 加载数据库活动配置。数据库配置始终是纯数据，不解析任何 transform 文件。
 */
async function loadStoredModules(): Promise<LoadedModule[]> {
  const storedModules = await _deps.listStoredModules();
  return storedModules
    .filter((stored) => !RETIRED_MODULE_CODES.has(stored.code))
    .map((stored) => {
      const module = validateModuleConfig(
        { ...stored.config, code: stored.code },
        `database:${stored.code}@${stored.version}`,
      );
      const origin = stored.origin === "user" ? "user" : "builtin";

      if (stored.origin === "user" && module.hasTransform) {
        throw new Error(`用户模块 ${stored.code} 不能加载 transform`);
      }

      return attachRuntimeMetadata(module, {
        origin,
        version: stored.version,
        configurable: true,
      });
    });
}

/**
 * 数据库覆盖项只替换经过持久化层保护的配置字段，transform 始终沿用代码内置实现。
 */
function applyBuiltinOverlay(
  base: LoadedModule,
  overlay: ModuleDef,
): LoadedModule {
  return attachRuntimeMetadata(
    { ...base, ...overlay },
    {
      transform: base.transform,
      origin: "builtin",
      version: (overlay as LoadedModule).version,
      configurable: true,
    },
  );
}

/**
 * 合并代码内置模块、数据库用户模块和数据库内置覆盖项。幂等：多次调用只加载一次（缓存）。
 */
export async function loadModules(force = false): Promise<LoadedModule[]> {
  if (_modules && !force) return _modules;

  const builtIns = await loadBuiltInModules();
  const stored = await loadStoredModules();
  const builtInIndexes = new Map(
    builtIns.map((module, index) => [module.code, index]),
  );
  const userModules: LoadedModule[] = [];

  for (const module of stored.filter((candidate) => candidate.origin === "user")) {
    if (builtInIndexes.has(module.code)) {
      throw new Error(`用户模块不能覆盖内置模块 ${module.code}`);
    }
    userModules.push(module);
  }

  for (const overlay of stored.filter(
    (candidate) => candidate.origin === "builtin",
  )) {
    const index = builtInIndexes.get(overlay.code);
    if (index === undefined) {
      throw new Error(`内置模块覆盖项找不到目标模块 ${overlay.code}`);
    }
    builtIns[index] = applyBuiltinOverlay(builtIns[index], overlay);
  }

  const loaded = [...builtIns, ...userModules];
  _modules = loaded;
  console.log(
    `[modules] loaded ${loaded.length} module(s): ${loaded.map((m) => m.code).join(", ") || "(none)"}`,
  );
  return loaded;
}

/**
 * 按 code 取单个模块
 */
export async function getModule(code: string): Promise<LoadedModule | undefined> {
  const mods = await loadModules();
  return mods.find((m) => m.code === code);
}

/**
 * 取所有启用的模块
 */
export async function getEnabledModules(): Promise<LoadedModule[]> {
  const mods = await loadModules();
  return mods.filter((m) => m.enabled);
}

/**
 * 工具函数：给定模块和平台代号，算出该平台对每个 column 的实际源列名候选
 *
 * 优先级：platform.columnOverrides[col.name] > column.source
 * 返回数组（用户在 columnOverrides 里可以指定多个候选）
 */
export function resolveSourceColumns(
  module: ModuleDef,
  platformCode: string,
  column: ColumnDef,
): string[] {
  const platform = module.platforms.find((p) => p.code === platformCode);
  const override = platform?.columnOverrides?.[column.name];
  const raw = override ?? column.source;
  // source 是 optional，可能 undefined；统一成数组并过滤掉空候选
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.filter((s): s is string => typeof s === "string");
}

/**
 * 工具函数：模块的输出表名
 * - 默认 unified_<code>
 * - 配置里指定 outputTable 则用指定的（例订单模块=unified_sales 保持数据连续性）
 */
export function moduleTableName(module: ModuleDef): string {
  return module.outputTable ?? `unified_${module.code}`;
}

/**
 * 找到匹配文件名的（模块 + 平台）。一个文件名通常只匹配一个平台。
 */
export async function matchFileToPlatform(filename: string): Promise<
  { module: LoadedModule; platform: PlatformDef } | null
> {
  const mods = await getEnabledModules();
  for (const mod of mods) {
    for (const p of mod.platforms) {
      if (!p.enabled) continue;
      try {
        const re = compileSafeFilePattern(p.filePattern, p.patternFlags ?? "i");
        if (re.test(filename)) return { module: mod, platform: p };
      } catch {
        console.warn(`[modules] ${mod.code}/${p.code} filePattern 非法正则，跳过：${p.filePattern}`);
      }
    }
  }
  return null;
}
