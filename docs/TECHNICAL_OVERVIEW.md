# 技术实现、源码启动与交付说明

根目录 [README](../README.md) 只负责介绍产品和选择入口。本文保留技术人员需要的能力边界、源码启动、开发与交付方式；普通使用者先看[新手使用手册](USER_GUIDE.md)，具体安装和升级以[部署指南](部署指南.md)为准。

## 能力与边界

- 数据源：普通用户可上传、预览经营 Excel/CSV；同名覆盖、维护字典、删除、外部 SQL 和数据源配置由管理员执行。普通上传支持整本拆分、显式指定 1～3 层表头起始行、日期宽表转长表和空行门禁。整本工作簿另有 20 万数据行、400 万单元格和 128 MiB 解析估算预算。管理员 Web 中另有原样 CSV 流式入口，最多 100 万行，不能绕过前台利润或字典业务合同。
- 模块：内置订单、广告、成本、库存和字典等模块；普通用户可用四步向导创建单表模块。管理员可在“方案交付”页导出多个纯配置模块及连接器版本要求；目标实例先校验再原子安装。兼容更新校验配置指纹和模块乐观锁，在一个事务中升级；本地定制不会被静默覆盖，成功升级可立即整组回滚。
- ETL：上传后按已确认规则归入并处理；支持有效状态筛选、未匹配原因、字段变化确认和配置版本恢复。普通 DIY ETL 按“模块 + 来源”串行，在事务中完成清旧、写入、字典补全和计算；字典缺失、关联键重复、JOIN 或计算失败会整体回滚。
- 图表与指标：新图表、AI 出图和模块对比使用版本化 `semantic-manifest/v1` 的指标/维度 ID，返回模型版本、血缘和查询预算。旧 SQL/表数据集只保留受限服务端聚合与只读渲染兼容。这是项目内部 DIY 语义层，不是通用 BI 语义模型。
- 演示运维：API runtime 提供 `demo:rebuild`、`demo:clear` 和显式的一次性 `demo:migrate-legacy`。只处理带内部标记或完整旧版多信号的合成演示对象，不按文件名删除，也不替代真实数据清理。
- 前台利润：人工 28 字段标准结果接入仍可用；自动链路是前台利润预生产骨架，覆盖六类业务来源、七个输入角色、L1/L3/L4、DQ/对账、草稿、发布、回滚和管理员 UI。目前只有确定性合成证据，尚未通过真实样本和生产发布验收。
- AI：配置模型后可使用业务智能体和辅助出图；未配置 API Key 时非 AI 能力仍可用。外部 PostgreSQL/MySQL 数据库入口是管理员受限只读查询，不是自动同步。

普通单表每张最多 5 万数据行；多工作表整本最多 20 万、每张最多 5 万；管理员原样 CSV 流式入口最多 100 万。三种入口不可混写成“Excel 支持百万行”，还受文件大小、格式与业务规则限制。页面提示与当前代码限制优先于旧文档。

## 从公开源码首次启动

本仓库自有代码使用 [MIT](../LICENSE)，第三方组件和示例素材保留各自许可，见[第三方说明](../THIRD_PARTY_NOTICES.md)。公开源码不包含业务数据库、真实经营报表或密钥。正式入口是 Docker Compose；它面向本地或可信单租户部署，不是直接对公网开放的多租户 SaaS。

要求 Docker Desktop 已启动。Compose 为避免离线包意外联网，把五个服务固定为 `pull_policy: never`；所以从源码第一次启动时，需要先取得基础镜像并构建应用镜像。

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

默认 Web 位于 <http://localhost:3997>，API 健康检查位于 <http://localhost:4000/api/health>。空库首次创建 `admin` 时，密码来自 `deploy/.env` 的 `ADMIN_PASSWORD`；它不会重置已有 `admin` 账号的密码。不要提交填写后的 `.env`。

收到正式离线包时**不要**执行上面的源码构建命令；按包内 `start.bat` 或 `start.sh`，由启动器核验并导入随包镜像。详见[离线包使用说明](离线包使用说明.md)。

## 本地开发与 Codespaces

本地开发要求 Node.js 20+、pnpm 9+ 和 Docker Desktop。先复制根目录 `.env.example` 为 `.env`，替换全部占位密钥，再运行：

```powershell
pnpm install --frozen-lockfile
pnpm dev:db
pnpm dev:api
pnpm dev:web
```

开发前端默认位于 <http://localhost:5173>，容器化 Web 位于 <http://localhost:3997>。提交或打包前按变更范围运行 `pnpm typecheck`、`pnpm test`、`pnpm build`；公开边界另运行 `pnpm repo:check:public`，并按 [AGENTS.md](../AGENTS.md) 检查完整 Git 历史与真实数据边界。

[GitHub Codespaces 入口](https://codespaces.new/wangge-dev/ec-data-platform-open?quickstart=1) 适合开发和隔离验收；本机不必为它安装 Docker Desktop。Codespace 中运行 `bash .devcontainer/scripts/start-dev.sh`，具体说明看 [Codespaces 文档](../.devcontainer/README.md)。Codespaces 不承载真实业务数据库或正式服务。

## 目录

```text
apps/api/       Hono + Drizzle + PostgreSQL 后端
apps/web/       Vite + React + Tailwind + ECharts 前端
deploy/         Docker Compose、环境变量模板和数据库初始化
docs/           使用、部署、DIY 和技术文档
scripts/        离线发布、发布验收和开发换机工具
templates/      脱敏或固定合成的业务模板
```

## 四类交付物不能混用

它们用途不同，不能互相替代。

| 交付物 | 用途与边界 |
|---|---|
| 离线运行包 | `scripts/package-release.ps1` 生成不含密钥和业务数据的运行包。默认先跑前台利润本地合成预检；`syntheticRehearsal=allowed` 只说明合成演练，不代表真实业务验收或生产授权。分发时提供对应源码、MIT 与第三方许可信息。 |
| 电商工作台配置包 | `scripts/package-ecommerce-workbench.ps1` 生成七表四入口的纯配置与固定合成样例，不是平台离线运行底包，也不含原始导出转换器。 |
| 实例备份 | 源码树使用 `scripts/instance-backup.*` / `scripts/instance-restore.*`，离线包使用根目录 `backup.*` / `restore.*`。备份含真实业务数据和敏感信息，需限权、加密、异机保存，并实际演练恢复；绝不能上传仓库、Issue 或 Release。 |
| 换机开发包 | `scripts/package-development-handoff.ps1` 生成 Git bundle；只有显式加 `-IncludeDatabaseBackup` 才会包含数据库备份。 |

发布标签与公开源码修订必须和离线包 `release-manifest.json` 一致。真正的安全与运行边界以当前代码、[部署指南](部署指南.md)、[离线包说明](离线包使用说明.md)及[安全政策](../SECURITY.md)为准；CI 成功不等于完整安全审计，真实云服务器仍需目标机验收。
