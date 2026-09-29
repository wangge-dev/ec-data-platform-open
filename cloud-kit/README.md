# 电商数据中台 · 云服务器准备包

项目自有云工具代码随公开仓库按 GPL-3.0-only 提供；公开云工具 ZIP 根目录附带 `LICENSE` 和 `THIRD_PARTY_NOTICES.md`，源码仓库根目录也有同名文件。本工具不携带真实业务数据、密码或已配置的服务器状态。

目标：现在准备好交付工具；有人使用时，由接收方购买服务器、填写自己的域名与实例信息，管理员完成首次安装，运营之后只用浏览器。

本包是现有完整离线 Release 的附属工具，不包含系统镜像、客户数据或固定密码。支持 Ubuntu 24.04 LTS x86_64、一台服务器一个客户/团队。没有购买或连接任何真实云服务器。公网 DNS、TLS 签发、云安全组与异地恢复必须在目标服务器验收。

## 交付方现在准备什么

从同一公开 Release 取得以下成套文件：

1. 已验证的完整离线运行 ZIP（从同一公开 Release 下载，保留原目录名）。
2. 同次 Release 的 `ecommerce-workbench-v1.zip`、`release-manifest.json` 和 `image-provenance.json`。
3. 同次 Release 的 `ec-cloud-kit.zip` 与 `cloud-kit-manifest.json`。云工具独立于离线包，解压在旁边；不要把工具、备份或日志复制进离线包，以免破坏其既有完整性校验。

必须先运行 `sha256sum --check SHA256SUMS.txt`，并确认两个 manifest 的 `sourceRevision` 相同、云工具 manifest 的 `releaseTag` 等于当前 Release 标签。不要跨 Release 混搭应用底包、工作台和云工具。

普通运营人员只需部署好的浏览器地址，不需要使用 GitHub。后续升级应用仍通过同版本 Release 交付；本准备包不自行拉 `main`、构建最新源码或自动升级数据库。

## 接收方购买与填写

| 项目 | 建议 |
|---|---|
| 服务器 | 4核8GB、180GB级 SSD、约12Mbps带宽；一个团队一台 |
| 系统 | Ubuntu 24.04 LTS，x86_64/amd64；不选 Windows/ARM/预装面板 |
| 云厂商 | 腾讯云轻量/阿里云轻量/华为云同档，优先已有账号 |
| 价格 | 云服务器价格与活动随时变化；按购买时官方结算页及续费价核算，不采用旧报价 |
| 域名 | 例如 data.company.com，A记录指向公网IPv4；未配置IPv6时不留错误AAAA记录 |
| 网络 | 公网业务只开放TCP443；SSH仅允许管理员IP。5432/6379/3997/4000/4080不开放 |
| 证书邮箱 | 管理员可接收邮件的地址 |
| 异地备份 | 独立对象存储桶/备份服务器；密钥与恢复密码由接收方保管 |

“买服务器即可用”仍包含一次管理员安装、域名解析与适用备案。大陆部署按云厂商要求备案。证书使用TCP443的TLS-ALPN验证，无须公开80；如另加CDN/反向代理，应重新确认验证方式，本版按域名直接指向服务器设计。

## 首次安装

以下示例路径用于目标服务器，`/opt/ec-data-platform-RELEASE` 必须替换为同次 Release 解压后的实际目录。准备包应位于 `/opt/ec-cloud-kit`，原离线包目录保持原名。所有命令在服务器上执行。

```bash
sudo bash /opt/ec-cloud-kit/install-ubuntu.sh

sudo python3 /opt/ec-cloud-kit/cloud.py prepare \
  --release /opt/ec-data-platform-RELEASE \
  --state /opt/ec-cloud-shop-a \
  --instance shop-a \
  --domain data.company.com \
  --email admin@company.com \
  --local-backup-keep 7

sudo python3 /opt/ec-cloud-shop-a/cloud.py start-local --state /opt/ec-cloud-shop-a
```

`prepare` 只生成配置，不安装或启动服务；自动生成五个独立随机秘密、实例名、仅回环监听端口、HTTPS配置与定时任务。重复执行会拒绝覆盖已有配置/密码。初始管理员用户名为 `admin`，密码在离线包 `deploy/.env` 的 `ADMIN_PASSWORD`，不写进终端日志；由管理员用安全编辑器查看，首次登录后修改。这个环境值只用于初始化，修改它不会重置已有账号密码。

`start-local` 调用原 `start.sh`，原有发布文件、镜像、迁移、健康检查全部保留；运行服务只在本机回环地址可达。若镜像加载/迁移失败，按原错误修复，不能绕过校验。

DNS、备案、现有云部署条件与备份恢复验收完成后，管理员显式启用公网入口：

```bash
sudo python3 /opt/ec-cloud-shop-a/cloud.py enable-https --state /opt/ec-cloud-shop-a
sudo python3 /opt/ec-cloud-shop-a/cloud.py check --state /opt/ec-cloud-shop-a
```

HTTPS入口通过 Caddy 自动签发/续期；Nginx网关提供登录限速、上传限速和大CSV流式转发。应用精确文件大小限制仍由API执行。网关直接转发API，避免旧Web代理100MB上限挡住512MB CSV。网关不记录请求体、查询参数或凭据；应用既有日志继续受原云部署要求约束。多人共用同一公网IP时登录限速会共享配额，遇429稍后重试，不应直接取消限速。

购买新服务器时需可访问 Docker 官方软件源、镜像仓库与证书服务。若国内网络受限，可由管理员采用官方离线deb包并用 `docker save/load` 转交本包引用的两个网关镜像；不内置未知第三方镜像源。应用镜像本身来自完整离线包。

## 备份、监控与恢复

先执行一次本地备份：

```bash
sudo python3 /opt/ec-cloud-shop-a/cloud.py backup --state /opt/ec-cloud-shop-a
```

本地数据库备份复用 `instance-backup/v1`，含业务和敏感数据。自动任务以0700目录、0600文件保存，但本地目录本身不是加密磁盘。配置异地加密副本：复制 `restic.env.example` 为同目录 `restic.env`（权限0600），填入接收方的 RESTIC_REPOSITORY、RESTIC_PASSWORD_FILE 和对象存储凭据。格式只支持逐行NAME=VALUE，不加shell引号，不执行文件内容。密码文件放在独立安全路径，至少生成32字节随机值，并另行安全托管；不要只保存在这台服务器上。

首次由管理员初始化远端空仓库，例：

```bash
sudo python3 /opt/ec-cloud-shop-a/cloud.py init-backup --state /opt/ec-cloud-shop-a
sudo python3 /opt/ec-cloud-shop-a/cloud.py backup --state /opt/ec-cloud-shop-a
sudo python3 /opt/ec-cloud-shop-a/cloud.py install-timers --state /opt/ec-cloud-shop-a
```

自动备份先生成原生数据库备份，再用restic加密上传备份目录、实例信息、环境密钥和证书数据；任一步失败都会让systemd任务失败。未配置restic时会明确标为“只有本机副本”，健康检查不会把它判为异地备份成功。

每天服务器本地时间03:15执行备份；每次本地备份成功后，只保留 `prepare` 指定的最近若干份（默认7份，允许2—90份）。清理器只删除名称、manifest、实例ID和转储文件均符合当前实例合同的旧备份；不处理其他目录或不完整/异实例备份。每5分钟检查本机API、公网HTTPS/TLS、磁盘85%阈值及26小时内本机/异地备份成功记录。首次无备份时检查失败是预期行为。日志查看：

```bash
sudo systemctl list-timers 'ec-shop-a-*'
sudo journalctl -u ec-shop-a-backup.service -u ec-shop-a-check.service --since today
```

外部告警渠道需部署方接入云监控；本包提供非零退出状态/systemd记录，不会自行发送短信、飞书或邮件。云监控还需观察API/Web/数据库的CPU、内存与容器错误。建议远端保留7个日快照和4个周快照；本版只自动限制本机备份数量，不自动执行远端 restic `forget/prune`。管理员确认远端可恢复后再配置远端保留策略。

恢复时先从restic恢复至新的独立目录，确认备份与源实例ID和版本。数据库写入仍使用原脚本，保持已有显式覆盖确认：

```bash
sudo bash /opt/ec-data-platform-RELEASE/restore.sh \
  --backup-path /secure/restored/ec-data-instance-backup-shop-a-TIMESTAMP \
  --confirm-instance-id shop-a --acknowledge-data-overwrite
```

换机还需恢复 `deploy/.env`（尤其ENCRYPTION_KEY、JWT_SECRET和数据库密码）、实例配置与证书数据。不能只恢复数据库却生成新加密密钥。先在隔离目标完成恢复演练，再接真实流量。备份后新增的用户、规则和业务数据不在旧备份内。

## 升级与故障处理

- 保留旧离线包和数据库备份，按原发布流程验证新包；新旧版本不能同时使用同一数据卷启动。
- 本版安装向导仅支持新实例。升级须保留INSTANCE_ID、COMPOSE_PROJECT_NAME、全部秘密和卷名，更新instance.json/systemd中的路径后重新验证，不要对已有实例重跑prepare。
- 数据库迁移不一定可逆；应用回滚遇不兼容迁移时应在维护窗口恢复对应数据库备份，不能只换旧镜像。
- 证书失败：核对DNS、安全组443、系统时间、出站网络和错误AAAA记录。Caddy启动不等于证书已签发。
- 502：检查 `start-local` 是否通过、3997/4000是否监听和API数据库健康。
- 429：登录/上传触发限速，先检查客户端重试或同IP人数。
- 不向他人发送真实数据库备份、自己的 `.env`、cloud-state 目录或管理员密码；公开下载仅限未配置的原始交付包。

## 当前完成与待部署时验证

已提供：Ubuntu依赖安装器、新实例配置器、原发布启动复用、443 HTTPS网关、限速/大文件代理、备份调度、restic适配、健康检查、显式恢复步骤与独立打包器。

必须到目标服务器才能完成：真实 DNS/适用备案、公网证书签发续期、实际云安全组、restic 远端凭据与恢复演练、外部告警渠道、真实负载容量。本包只完成前期工具准备，不代表已通过真实利润模板验收或已经公网生产就绪；使用前按 [SECURITY.md](../SECURITY.md) 的可信单租户边界评估。

官方参考：[Docker Ubuntu安装](https://docs.docker.com/engine/install/ubuntu/)、[Caddy自动HTTPS](https://caddyserver.com/docs/automatic-https)、[腾讯云轻量](https://cloud.tencent.com/product/lighthouse)、[restic文档](https://restic.readthedocs.io/en/stable/)。
