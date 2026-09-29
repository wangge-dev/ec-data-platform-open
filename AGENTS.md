# ec-data-platform agent guide

本项目是以 Docker Compose 为正式运行入口的电商数据中台，业务主流程是“上传文件 → 模块识别/自助创建 → ETL → 追溯 → 看板”。GitHub Codespaces 仅用于空数据库开发与验收，不是普通用户的生产入口。

## 启动与门禁

- 本地开发需要 Node.js 20+、pnpm 9+、Docker Desktop；Codespaces 的环境要求和启动方式以 `.devcontainer/README.md` 为准。
- 首次开发先复制 `.env.example` 为 `.env` 并替换所有示例值。
- 开发数据库：`pnpm dev:db`（读取根目录 `.env`）。
- API：`pnpm dev:api`；Web：`pnpm dev:web`。
- 通用门禁：`pnpm typecheck`、`pnpm test:api`、`pnpm test:web`、`pnpm build`。本地 Docker 可用且变更涉及代码、配置、迁移或发布时，再运行包含隔离迁移烟测的 `pnpm test`；仅文档变更至少运行通用门禁和 `git diff --check`。
- 首次推送与发布 tag 前运行：`pnpm repo:check:public`，并使用专用工具扫描此公开仓库的完整 Git 历史。
- 正式容器验收：`docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps -a`。根目录 `.env` 只供本地开发命令读取，不能替代 `deploy/.env`。

## 技术栈与目录

- `apps/api/`：Hono、Drizzle、PostgreSQL、Vitest。
- `apps/web/`：Vite、React、Tailwind、ECharts、Vitest。
- `apps/api/src/modules/`：内置模块 JSON/转换；普通用户创建的模块保存在数据库。
- `deploy/`：Compose、迁移和环境变量模板。
- `docs/README.md`：当前权威文档索引；带日期的验收/计划文档只作历史证据。

## 约束

- 不提交 `.env`、业务 Excel/CSV、数据库备份、密钥、`node_modules`、`dist` 或本地验收截图。
- 本公开仓库只能接收已审计的源码、合成示例和公开文档；不得用未经复核的 `git add .`。不得把旧私有仓库的提交、标签、Release、验收截图或备份导入这里。
- 不对真实数据库运行需要写入的测试；数据库集成测试必须使用独立 `TEST_DATABASE_URL` 或隔离 Compose 项目。
- 不执行 `docker compose down -v`，除非用户明确授权删除对应实例的数据卷。
- SQL 值参数化；动态标识符必须走项目安全引用工具；应用运行时使用非超级用户 `ec_app`。
- 内置复杂模块可用 JSON/transform；普通业务优先使用 UI“新建模块”，不要要求用户改代码。

## 发布与换机

- 给使用者：`scripts/package-release.ps1`，产物不得包含业务数据或密钥，并须包含 GPL 与第三方许可说明；发布标签与公开源码修订必须和离线包清单一致。
- 换机开发：`scripts/package-development-handoff.ps1`；数据库备份属于敏感资产，只能显式选择。
- 当前发布事实以 `release-manifest.json`、验证器结果和当前 Git 提交为准，不以旧验收记录代替。
- GitHub Actions/GHCR 不得包含业务数据库或真实上传文件；单租户云部署须按 `cloud-kit/README.md` 完成目标机安全、备份与恢复验收，不能把本机测试当公网生产验收。
