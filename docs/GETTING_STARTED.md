# 从 GitHub 下载、首次启动与 DIY

这页给第一次使用 GitHub 的读者。当前示例对应 `v0.1.3`；仅在该版本正式 Release 的七项附件全部发布后下载。后续版本的文件名和操作以其 Release 页面及包内说明为准。完整安装、虚拟机、备份与升级细节见[给人看的使用手册](USER_GUIDE.md)。

## 先选对入口

| 你的目标 | 拿什么 | 下一步 |
|---|---|---|
| 在自己电脑运行 | 正式 Release 中的 `ec-data-platform-20261008.zip` | 按下文首次启动；需要 Docker Desktop |
| 只使用团队已经装好的中台 | 管理员给的网页地址和账号 | 浏览器登录；自己的电脑不必安装 Docker |
| 在页面增加普通单表模块 | 已运行的中台和脱敏样表 | 看[自助建模块说明](SELF_SERVICE_MODULES.md)，先不用改源码 |
| 让 Codex 修改复杂模块或程序 | 与运行版本对应的完整公开源码 | 看[给 AI 的接手与 DIY 指南](AI_DIY_GUIDE.md)及[可复制提示词](AI_PROMPTS.md) |

## 不想自己研究？让 AI 带你开始

把下面整段复制给 ChatGPT 或 Codex；已有具体目标时，在末尾加一句说明。

```text
请帮我使用 https://github.com/wangge-dev/ec-data-platform-open 。
先读取 docs/AI_PROMPTS.md 的「0. 把仓库交给 AI」，按其中说明接手。
默认先帮我安装正式版本并用合成样例验证，再按我的报表做 DIY。
先确认你的操作能力、我的电脑环境和已有实例；没有本机工具就分步指导我。
无法读取仓库就请我提供文档，不要猜测；不要索要密码或真实业务数据。
```

[完整提示词](AI_PROMPTS.md#0-把仓库交给-ai直接复制)可直接复制，不需要先填技术参数。网页版 AI 只能在具备相应工具时读取网页，不能代替本机安装；能操作本机的 Codex 也需要你授权具体任务。先分清自己要安装、使用还是开发，不把仓库地址当成已经运行的服务地址。

## 一、找到真正的安装包

1. 打开[公开仓库](https://github.com/wangge-dev/ec-data-platform-open)，点击首页的“下载最新版离线包”；也可以直接打开 [Releases 页面](https://github.com/wangge-dev/ec-data-platform-open/releases/latest)。
2. 在最新正式版本下展开 **Assets**。`v0.1.3` 的平台安装包名为 [`ec-data-platform-20261008.zip`](https://github.com/wangge-dev/ec-data-platform-open/releases/download/v0.1.3/ec-data-platform-20261008.zip)。下载到电脑后完整解压到一个固定目录，不要在压缩包预览窗口里运行。
3. **不要误选**仓库绿色 **Code → Download ZIP**，也不要把 Release 页面自动生成的 **Source code (zip)** 当成安装包：它们是源码，缺少离线运行包自带的镜像和启动器。

`ecommerce-workbench-v1.zip` 是另外一份可选的电商方案与合成样例，不是平台安装包。全新安装没有他人的真实经营数据，部分图表为空是正常现象。其余校验清单和云工具文件供核对或管理员使用，不需要逐个打开安装。公开包不含真实业务数据库、密码或 API Key。

平台 ZIP 解压后的 `docs` 目录已有这份下载导航和三份分工明确的说明：`USER_GUIDE.md` 给人看，讲安装、日常使用和备份；`AI_DIY_GUIDE.md` 给接手项目的开发 AI 看；`AI_PROMPTS.md` 放可复制的任务提示词。这些也在同标签的公开源码中，普通使用者不需要先读开发说明。本版依赖修复及尚存上游告警见[依赖安全说明](DEPENDENCY_SECURITY_2026-10-08.md)，不要把安装验收等同于完整安全审计。

## 二、Windows 空环境第一次启动

以下仅适用于**没有旧实例的 Windows x64 电脑**；如果已经装过，先看[备份与升级章节](USER_GUIDE.md#10-停止备份升级)，不要从新目录再启动一套空库。

1. 按 [Docker 官方说明](https://docs.docker.com/desktop/setup/install/windows-install/)安装并启动 Docker Desktop；确认 WSL 2、硬件虚拟化和 Linux 容器模式可用。Docker 没有启动成功时，平台也不能运行。
2. 在解压目录的 `deploy` 文件夹中，把 `.env.example` 复制一份并命名为 `.env`；用文本编辑器替换所有 `change_me` 占位值。请按[使用手册的密码规则](USER_GUIDE.md#5-第一次安装仅限空环境)设置，不要把填好的 `.env` 发给群聊或 AI。
3. 返回解压目录，双击 `start.bat`。首次导入镜像可能需要等待；看到健康提示后，在浏览器打开 `http://localhost:3997`。
4. 空数据库首次登录，账号是 `admin`，密码是刚才在 `.env` 中设置的 `ADMIN_PASSWORD`。界面能打开后，先用脱敏小样核对上传行数和统计结果，再放正式数据。

不需要额外安装 VMware/VirtualBox；Docker Desktop 使用自己的运行环境。Linux 虚拟机、Mac、团队服务器、已有实例升级和故障排查分别按[完整使用手册](USER_GUIDE.md)处理。`v0.1.3` 的镜像按 Linux amd64 构建，不能把 Apple Silicon/其他 ARM 设备视为已验收。

## 三、想自己改功能，从哪里开始

- **先看页面能否完成**：普通单表可按“选样表 → 对字段 → 选有效状态 → 查看结果”创建模块，并用第二批同类文件复核规则。复杂跨表关联和特殊计算仍需开发。
- **要改程序再拿源码**：到 [v0.1.3 对应源码](https://github.com/wangge-dev/ec-data-platform-open/tree/v0.1.3)下载或克隆。正式运行包不是完整开发仓库；不要让 AI 在缺源码的包里假装能重建前端。开发环境与源码启动看[技术与交付说明](https://github.com/wangge-dev/ec-data-platform-open/blob/v0.1.3/docs/TECHNICAL_OVERVIEW.md)。
- **交给 Codex 时**：先给它完整源码位置、[AI 接手指南](AI_DIY_GUIDE.md)、[任务提示词](AI_PROMPTS.md)和脱敏样表；说明你的业务口径与人工正确答案。先确认材料和版本，再决定复用模块、页面 DIY 或改代码。不要上传真实报表、密钥或数据库备份到公开仓库或 AI 会话。

项目自有代码采用 [GPL-3.0-only](../LICENSE)；第三方组件另见[许可说明](../THIRD_PARTY_NOTICES.md)。这是本地/可信单租户工作台，不是打开网页就能注册的公共云服务；目标服务器公网部署还需管理员做 HTTPS、备份和恢复验收。
