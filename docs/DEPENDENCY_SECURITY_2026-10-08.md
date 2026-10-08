# 依赖安全修复说明（2026-10-08）

## 目标与结论范围

处理当前锁文件复现的 16 条告警，保持现有产品、统计口径和界面；不做 Tailwind 大版本迁移，不修改业务数据库，不删除安全检查。告警数量是依赖数据库的报告数量，不是已证实的应用攻击入口数量。

15 条通过修复版本升级消除；最后 1 条使用本地补丁及维护者明确授权的单项验证规则。原始 npm 全量扫描仍报告 1 条 high，项目审计明确标记为 MITIGATED，不称“原始扫描零告警”。生产依赖扫描当前为 0 条。旧 v0.1.1 安装包不含本次修复。

## 修改与真实路径

| 依赖 | 原版本 → 修复版本/措施 | 项目路径及影响 |
|---|---|---|
| Axios | 1.18.0 → 1.20.0 | Web 的 `src/lib/api.ts` 请求客户端；多数告警涉及 Node 适配器，并非本项目浏览器入口已经证实可被利用；升级消除相关 12 条报告 |
| Hono | 4.13.5 → 4.13.13 | API HTTP 框架；当前应用未使用 hono/jsx 边界组件，仍升级消除对应 1 条报告 |
| source-map-js | 1.2.1 → 1.2.2 | Web CSS 构建依赖，经定向 override 升级；消除 1 条报告 |
| postcss-selector-parser | 6.1.4 → 7.1.6 | Tailwind/PostCSS 构建依赖，经定向 override 升级；不扩大成整个 CSS 框架迁移；消除 1 条报告 |
| braces | 3.0.3 + 本地 pnpm 补丁 | 仅在 Web 的 Tailwind 开发/构建链，经 chokidar、fast-glob/micromatch 和直接 micromatch 引入；应用上传/API 不调用此库，最终 Web 是静态构建产物 |

版本、原始告警详情以当前 `pnpm-lock.yaml` 和当日 registry 结果为准。补丁见 `patches/braces@3.0.3.patch`，pnpm 的既有补丁清单和锁文件机制负责安装应用补丁；两份 Dockerfile 在安装依赖前复制该目录。

## braces 为什么不能只升级

[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) 与[上游问题 #70](https://github.com/micromatch/braces/issues/70)记录了深嵌套输入导致递归栈耗尽，当前上游没有修复版本。仅有字符长度限制不足：数千层嵌套可以低于原来的 10,000 字符上限。

补丁在解析器处限制大括号/圆括号总嵌套深度为 100，并为 compile、expand、stringify 的递归 AST 遍历设置 128 层保护。超限产生明确的 SyntaxError，而不是继续递归直到栈耗尽；引用和转义的分隔符不错误计入真实嵌套。正常多选、数字范围和项目的 `./src/**/*.{ts,tsx}` 保持原行为。该补丁针对这条递归告警，不保证库中没有其他未知缺陷。

## 单项处理规则及证据

原始 npm 扫描只检查版本，不能判断 pnpm 已应用的代码补丁。因此既有扫描机制单独无法区分受影响的原版与已限制递归的版本；新增的补丁回归用于防止未应用补丁却错误通过发布检查这一具体事故。

`pnpm audit:all` 的处理顺序：

1. 调用真实 npm audit，打印原始数量；网络/格式/扫描失败不通过。
2. 检查已声明的 braces 3.0.3 补丁，然后对安装后的真实 Tailwind 依赖执行回归，不依赖文字声明代替运行。
3. 只对 `GHSA-vfj7-8cjw-p6xm`、braces 3.0.3 和 Web Tailwind 构建路径标注 MITIGATED。新告警、新版本、新模块、空路径或转入 API/生产依赖不继承该规则。
4. 其他 moderate/high/critical 报告继续阻断全量检查。生产检查维持原有 high 阈值，且不采用本项处理规则。

`scripts/braces-depth-regression.test.mjs` 覆盖正常模式、100/101 层边界、4,500 层恶意大括号/圆括号、混合/未闭合输入、转义/引用、外部 AST，以及三条真实依赖路径都加载同一受保护实现。

`scripts/audit-dependencies.test.mjs` 覆盖没有补丁验证、新告警、新版本、错误模块、非构建路径、生产模式、未知严重程度和不完整扫描响应不会被放行。

## 复核命令与交付边界

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test:dependency-security
corepack pnpm audit:all
corepack pnpm audit:prod
# 查看不带处理规则的原始告警；当前预计有 1 条并返回非零
corepack pnpm audit --json --registry=https://registry.npmjs.org/
```

上游发布修复版后，应优先替换为官方版本并移除本地补丁和单项规则。本次源码变更必须重新构建镜像，验证新离线包空库安装后再发布新版本；不能改写旧 Release 的内容，也不能声称旧镜像或本地运行实例已经自动升级。CI 通过不等于完整安全审计。
