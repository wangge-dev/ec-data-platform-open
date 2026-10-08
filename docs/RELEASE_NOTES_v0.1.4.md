# v0.1.4：MIT 开源，无需作者另行批准商用

项目自有代码从本版起按 MIT 发布：可免费使用、修改、分发、再许可及商用，也允许闭源修改，无需逐次向作者申请。分发时仍须保留版权与 MIT 许可声明；第三方组件保留各自许可证，MIT 不是对客户数据、商标或第三方素材的额外授权。

旧 v0.1.3 及更早版本的 GPL 标签和 Release 附件保留历史状态，不覆盖。本版不改变业务口径、数据库结构或用户已有实例；重建发布只是同步许可证、运行镜像及交付说明。

## 下载与启动

- 平台安装包是 Release Assets 中的 ec-data-platform-20261008.zip。完整解压后先读 README.md 和 docs/GETTING_STARTED.md，再按 USER_GUIDE.md 配置 Docker、密码并运行 start.bat。
- 已有实例先备份，按升级说明操作；不要从新目录随意启动第二套空数据库。本次发布不会自动升级本地实例。
- ecommerce-workbench-v1.zip 是可选配置与合成样例，ec-cloud-kit.zip 是管理员服务器准备工具；都不是平台安装包。
- Source code (zip) 是开发源码，不是离线安装包。复杂 DIY 请拿 v0.1.4 对应源码，再读 AI_DIY_GUIDE.md 和 AI_PROMPTS.md。

## 一致性与验收

源码 LICENSE、三份 package.json、首页、使用手册、AI 指南、打包说明、工作台及云工具说明已同步为 MIT。平台包、工作台包和云工具包都保留 LICENSE 和 THIRD_PARTY_NOTICES.md；原 braces 补丁的上游版权未删除。

API/Web 独立镜像也附带 MIT 和第三方说明（/usr/share/licenses/ec-data-platform/），避免只分发镜像时遗漏许可；镜像的项目许可标签为 MIT，不改变其基础镜像及依赖的上游许可。

正式发布仍须完成既有隔离测试及最终 ZIP 安装、登录、业务模块、图表和备份恢复验收，再公开七项附件。发布后核对匿名下载和包内外来源一致性，不使用旧 GPL 包代替新版。

## 安全边界不变

保留 v0.1.3 的依赖修复：生产扫描 0 条；全量原始扫描仍 1 条 braces high，按已授权单项补丁及实际依赖路径回归标记 MITIGATED。不是零告警或完整安全审计。

公开交付不含本机业务数据库、真实上传文件、密码或 API Key；样例为合成数据。本版支持范围仍为可信团队的本地/单租户 Linux amd64 运行环境，ARM 和接收方公网服务器尚未验收；公网部署仍需 HTTPS、权限、备份恢复验收。
