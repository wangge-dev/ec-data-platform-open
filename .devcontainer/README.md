# GitHub Codespaces 开发环境

该配置面向开发者：Node.js、pnpm 和 PostgreSQL 全部运行在 GitHub Codespaces 的云端开发环境中，本机不需要安装 Docker Desktop。

## 首次启动

1. 在公开仓库 `wangge-dev/ec-data-platform-open` 中选择 **Code → Codespaces → Create codespace on main**。
2. 等待终端中的 `postCreateCommand` 完成依赖安装；PostgreSQL、迁移和初始化会自动准备。
3. 在 Codespaces 终端运行：

   ```bash
   bash .devcontainer/scripts/start-dev.sh
   ```

4. Codespaces/VS Code 会自动转发并打开 5173 端口。首次登录使用：

   - 用户名：`admin`
   - 密码：`codespaces_dev_admin_only`

这些固定值只用于空的 Codespaces 开发数据库，不得用于云部署或生产环境。

## 数据和密钥边界

- 环境首次创建时使用空数据库，只写入项目自带的迁移和基础初始化数据。
- 不要上传、恢复或提交真实数据库 dump、业务 Excel/CSV、`.env` 或本机验收输出。
- AI 功能默认关闭。如确需联调，在仓库或个人的 **Codespaces secrets** 中配置 `DEEPSEEK_API_KEY`，不要把值写进仓库文件。
- Codespace 被删除后，其数据库卷也会随开发环境删除；需要保留的代码必须先提交并推送。

## 为什么没有 Redis

当前 `@ec/api` 没有声明 Redis 客户端依赖，也没有 Redis 运行时调用。因此 Codespaces 只启动实际需要的 PostgreSQL，减少启动时间和资源占用。正式发布所用的 `deploy/docker-compose.yml` 保持不变；未来若代码开始依赖 Redis，必须同步更新本配置并增加相应验证。

## 常用命令

```bash
# 同时启动 API 和 Web
bash .devcontainer/scripts/start-dev.sh

# 仅启动 API 或 Web
pnpm dev:api
pnpm --dir apps/web exec vite --host 0.0.0.0

# 提交前检查
pnpm typecheck
pnpm test:api
pnpm test:web
pnpm build
```

API 和 Web 启动后，可在另一个终端运行以下命令验证 PostgreSQL、API、Web 和 admin 登录：

```bash
bash .devcontainer/scripts/smoke-test.sh
```

仓库的 `Codespaces Smoke` GitHub Actions 工作流也会在隔离 Linux 环境中构建同一 devcontainer，并执行这套验证。

完整 `pnpm test` 还包含基于 Docker 的迁移运行时烟测，不属于 Codespaces 日常开发门禁。迁移本身会在 Codespace 每次启动时通过 `.devcontainer/scripts/prepare-db.sh` 对隔离数据库执行。
