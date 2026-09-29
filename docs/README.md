# 文档索引

这份公开文档只描述可复现的功能、安装与 DIY 边界。历史本机验收、真实业务截图、私人交付记录和数据库不在公开仓库中。

| 你要做什么 | 从这里开始 |
|---|---|
| 第一次用 GitHub，找安装包并在电脑上启动 | [从 GitHub 下载、首次启动与 DIY](GETTING_STARTED.md) |
| 认识产品、日常上传与看结果 | [给人看的使用手册](USER_GUIDE.md) |
| 从源码用 Docker 安装或升级 | [部署指南](部署指南.md) |
| 看技术实现、开发与交付边界 | [技术与交付说明](TECHNICAL_OVERVIEW.md) |
| 用 Release 离线包在电脑上安装 | [离线包使用说明](离线包使用说明.md) |
| 四步创建普通业务模块 | [自助创建业务模块](SELF_SERVICE_MODULES.md) |
| 用 AI 辅助 DIY，但不泄露业务数据 | [AI 接手与 DIY 指南](AI_DIY_GUIDE.md)、[可复制提示词](AI_PROMPTS.md) |
| 扩展平台、内置模块或语义层 | [新增平台](HOW_TO_ADD_PLATFORM.md)、[新增模块](HOW_TO_ADD_MODULE.md)、[语义层与扩展](DIY_SEMANTIC_EXTENSIONS.md) |
| 准备单租户云服务器 | [云工具包说明](../cloud-kit/README.md) |

公开源码以根目录 [README](../README.md)、[GPL-3.0-only 许可证](../LICENSE)、[第三方说明](../THIRD_PARTY_NOTICES.md)、[安全政策](../SECURITY.md)和当前版本代码为准。不同版本的文档、镜像和数据库备份不可混用。

能力边界：面向可信团队的本地/单租户电商数据工作台，不提供电商平台自动采集、多租户隔离或保证正确的财务结账。前台利润自动归集仍需真实样本和生产发布验收；合成样例、单机容量测试及健康检查不能代替业务验收。
