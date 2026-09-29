# ec-data-platform

面向电商运营的本地数据中台：上传 Excel/CSV，自动识别或自助创建业务模块，完成 ETL、未匹配追溯、跨模块分析和真实数据看板。

## 当前能力

- 数据源：普通用户可上传、预览新的经营 Excel/CSV；同名覆盖、维护字典、删除、外部 SQL 和数据源配置由管理员执行。普通上传支持整本拆分、显式指定 1～3 层表头起始行、日期宽表转长表和空行门禁；整本工作簿另有 20 万数据行、400 万单元格和 128MiB 解析估算预算。管理员可在 Web 使用 raw CSV 流式入口，独立支持最多 1,000,000 行，但不能绕过前台利润或字典业务合同。
- 模块：内置订单/广告/成本/库存/字典模块，以及普通用户可完成的四步“新建模块”向导；管理员可在“方案交付”页把多个纯配置模块及连接器版本要求导出为 `vertical-solution/v1`，并在另一套实例校验后原子安装。同一方案的兼容更新会校验配置指纹和模块乐观锁，在一个事务中升级；本地定制不会被覆盖，成功升级可立即整组回滚。
- ETL：上传后自动归入并处理；支持有效状态筛选、未匹配原因、字段变化确认和配置版本恢复。普通 DIY ETL 按“模块 + 来源”串行，并在一个事务内完成清旧、写入、字典补全和计算；字典缺失、关联键重复、JOIN 或计算失败都会整体回滚。
- 看板与指标：新图表、AI 出图和模块对比统一使用版本化 `semantic-manifest/v1` 的指标/维度 ID，返回模型版本、血缘和查询预算；升级前的 SQL/表数据集只保留受限服务端聚合和只读渲染兼容。当前是内部 DIY 语义层，不是通用 BI 语义模型。
- 演示运维：API runtime 提供 `demo:rebuild`、`demo:clear` 和显式的一次性 `demo:migrate-legacy`；只处理带内部标记或完整旧版多信号的合成演示对象，不按文件名删除，也不替代真实数据清理。
- 前台利润预生产骨架：人工 28 字段标准结果接入仍可用；自动链路已覆盖六类业务来源、七个输入角色、L1/L3/L4、DQ/对账、草稿、发布、回滚和管理员 UI。当前只有确定性合成证据，尚未通过真实样本和生产发布验收。
- AI：DeepSeek 驱动的出图和业务智能体；未配置 API Key 时，非 AI 能力仍可使用。

## 源码首次启动：Docker

本仓库作为公开开源版发布，项目自有代码采用 [GNU GPL v3.0（仅此版本）](LICENSE)；第三方组件和示例素材保留各自许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)。公开源码不包含业务数据库、真实经营报表或密钥。当前支持本地或可信单租户部署，不是可直接对公网开放的多租户 SaaS。

要求 Docker Desktop 已启动。Compose 为保证离线包不意外联网，将五个服务固定为 `pull_policy: never`；因此源码仓库第一次启动必须先显式取得基础镜像并构建应用镜像。

```powershell
Copy-Item deploy/.env.example deploy/.env
# 编辑 deploy/.env，替换所有 change_me 值并设置唯一强密码
Set-Location deploy
docker pull postgres:16
docker pull redis:7-alpine
docker compose build --pull api web
docker compose up -d
docker compose ps -a
```

收到离线运行包时不要执行上述源码构建命令；请按包内说明运行 `start.bat` 或 `start.sh`，由启动器核验并导入随包镜像。

打开：

- Web：<http://localhost:3997>
- API 健康检查：<http://localhost:4000/api/health>

首次创建 `admin` 时，登录密码取自 `deploy/.env` 的 `ADMIN_PASSWORD`。它不会重置已有 `admin` 账号的密码；修改 `.env` 或重启也不会恢复密码。不要使用示例值，也不要提交 `.env`。

## 本地开发

要求 Node.js 20+、pnpm 9+ 和 Docker Desktop。

```powershell
Copy-Item .env.example .env
# 编辑 .env，替换全部 change_me 值
pnpm install --frozen-lockfile
pnpm dev:db
pnpm dev:api
pnpm dev:web
```

开发前端默认位于 <http://localhost:5173>；容器化 Web 位于 <http://localhost:3997>。

### 浏览器开发：GitHub Codespaces

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/wangge-dev/ec-data-platform-open?quickstart=1)

[公开仓库的 Codespaces 入口](https://codespaces.new/wangge-dev/ec-data-platform-open?quickstart=1)适合开发和隔离验收，本机无需安装 Docker Desktop。创建 Codespace 后运行：

```bash
bash .devcontainer/scripts/start-dev.sh
```

具体启动步骤、开发账号和数据安全边界见 [`.devcontainer/README.md`](.devcontainer/README.md)。Codespaces 仅用于开发，不承载真实业务数据库或正式服务。

提交或打包前运行：

```powershell
pnpm typecheck
pnpm test
pnpm build
```

## 目录

```text
apps/api/       Hono + Drizzle + PostgreSQL 后端
apps/web/       Vite + React + Tailwind + ECharts 前端
deploy/         Docker Compose、环境变量模板和数据库初始化
docs/           当前使用、部署、分享和历史验收文档
scripts/        离线发布、发布验收和开发换机工具
templates/      经脱敏或固定合成、通过发布检查后可分享的业务模板
```

## 新用户从哪里开始

1. 想了解适用范围和日常功能：读[给人看的使用手册](docs/USER_GUIDE.md)。
2. 从公开源码自行安装：按本页“源码首次启动”及[部署指南](docs/部署指南.md)操作；要先安装并启动 Docker。`git clone` 本身不能运行服务。
3. 下载正式 Release 离线包：仅从本仓库对应版本的 Release Assets 下载完整 ZIP，按包内 `start.bat`/`start.sh` 与[离线包说明](docs/离线包使用说明.md)操作；GitHub 自动生成的“Source code (zip)”不是离线安装包。离线包和同标签源码应相互对应。
4. 想 DIY：先试[页面自助建模块](docs/SELF_SERVICE_MODULES.md)；复杂规则看[给 AI 的接手指南](docs/AI_DIY_GUIDE.md)和[提示词](docs/AI_PROMPTS.md)。

完整入口见[文档索引](docs/README.md)。漏洞请按[安全政策](SECURITY.md)私下报告；贡献代码前请看[贡献指南](CONTRIBUTING.md)。

## 四类交付物

- 给别人使用：运行 `scripts/package-release.ps1`，生成不含源码历史、密钥和业务数据的离线运行包；打包默认会先跑 `front-profit:local-release-precheck`，确认前台利润发布前置工具链仍可用且不使用真实样本。该自检成功会输出 `syntheticRehearsal=allowed`，只代表合成演练通过，不代表真实验收或生产授权。分发二进制时应一并提供与之对应的公开源码、GPL 许可证及第三方许可信息。
- 复用电商工作台配置：运行 `scripts/package-ecommerce-workbench.ps1`，生成七表四入口的纯配置与固定合成样例 ZIP。它只适用于包含对应模块、四入口和图表修复的平台版本，不是离线运行底包，也不包含原始导出转换器。
- 实例数据保护：源码树使用 `scripts/instance-backup.*` / `scripts/instance-restore.*`，离线运行包使用根目录 `backup.*` / `restore.*`。备份带实例 ID、敏感性声明和 SHA-256 清单；源码工作树不干净时拒绝生成带提交号的备份，恢复到不干净源码树时则按无法证明同修订处理。恢复要求明确确认目标实例与覆盖动作，跨修订还需额外确认兼容风险。它们不替代生产环境的定时、保留、加密、异机副本、告警和恢复演练。
- 换电脑开发：运行 `scripts/package-development-handoff.ps1`，生成 Git bundle；如需带走当前模块、图表和上传数据，再显式加 `-IncludeDatabaseBackup`。

这四类交付物用途不同，不能互相替代。备份含真实业务数据，不属于公开 Release，绝不能上传到 Issue、仓库或 Release。
