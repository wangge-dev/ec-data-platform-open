# 前台利润真实样本授权验收模板

- 状态：template
- 日期：2026-08-10
- 用途：真实业务样本进入隔离 dry run 前的授权、盘点、脱敏、验收和清理记录

> 本模板只记录授权和验收证据，不保存真实样本内容。真实文件、脱敏副本、数据库 URL、账号密码和导出明细不得写入本文档、Git 或 CI。

首次准备机器可校验 JSON 时，运行：

```powershell
pnpm --filter @ec/api run front-profit:acceptance-init
```

该命令只复制 template JSON 到被 Git 忽略的位置，不读取真实样本；若目标文件已存在会拒绝覆盖。

随时检查当前卡在哪一步：

```powershell
pnpm --filter @ec/api run front-profit:acceptance-status
```

该命令默认只检查 JSON/gate 状态，不读取脱敏 CSV；需要连同 CSV 表头/行数门槛一起检查时，显式加 `--run-file-gates`。

机器可校验的授权信息从 [`front-profit-acceptance-manifest.example.json`](front-profit-acceptance-manifest.example.json) 复制到被 Git 忽略的位置后填写，例如 `front-profit-acceptance/manifest.json`。填完后先运行：

```powershell
pnpm --filter @ec/api run front-profit:acceptance-preflight -- --manifest front-profit-acceptance/manifest.json
```

该 preflight 只读取 manifest，不读取样本内容；它用于阻断未授权、仍含模板占位、路径未被 Git 忽略或 dry run 门槛缺失的验收。
正式验收命令默认也会阻断 `synthetic` / `placeholder` / `not-real` 等占位标记；`--allow-synthetic` 只允许用于本地 smoke/rehearsal。凡输出 `syntheticRehearsal=allowed` 或 `stage=synthetic_rehearsal_gate_passed` 的运行都不得作为真实样本验收证据。

脱敏 CSV 副本放入 manifest 声明的 `sanitizedPath` 后，再运行只读文件核验：

```powershell
pnpm --filter @ec/api run front-profit:acceptance-preflight -- --manifest front-profit-acceptance/manifest.json --check-files
```

`--check-files` 只检查参与来源的 CSV 文件是否存在、表头是否包含 manifest 声明字段、行数是否等于 `rowCount`；输出不会打印样本行内容。

进入隔离 dry run 前，运行最终组合门槛：

```powershell
pnpm --filter @ec/api run front-profit:acceptance-readiness -- --manifest front-profit-acceptance/manifest.json
```

隔离 dry run 完成后，把结构化验收结果从 [`front-profit-acceptance-result.example.json`](front-profit-acceptance-result.example.json) 复制到被 Git 忽略的位置填写，例如 `front-profit-acceptance/result.json`，再运行：

```powershell
pnpm --filter @ec/api run front-profit:acceptance-result -- --result front-profit-acceptance/result.json
```

result manifest 只记录 DQ、recon、diff、publish 幂等、rollback、清理和结论摘要，不保存真实样本行；即使通过，也不代表生产发布已授权。

非模板 result manifest 的 `evidenceArtifacts` 必须包含 `dq_summary`、`recon_summary`、`diff_summary`、`publish_smoke` 和 `rollback_smoke`。这些 `path` 必须是实际存在的 Git-ignored JSON/Markdown/Text 证据文件，不能指向 CSV/XLSX、原始样本行或凭据。

manifest 的 `sources` 必须盘点全部来源族：`operator_assignment`、`sales_fact`、`cost_period`、`cost_usage`、`rebate`、`fee_fact`、`promotion_spend` 和 `manual_baseline`。本轮不参与的来源也要保留一条记录并说明 `participating=false` 与 `nonParticipationReason`，避免真实 dry run 前漏盘来源。

不参与来源的最小写法：

```json
{
  "family": "promotion_spend",
  "participating": false,
  "alias": "promotion-spend-not-in-scope",
  "rowCount": 0,
  "sourceSystem": "not_provided",
  "sensitiveFields": [],
  "nonParticipationReason": "not included in this authorized dry run"
}
```

## 1. 授权记录

| 项目 | 填写 |
|---|---|
| 授权日期 |  |
| 授权人 |  |
| 执行人 |  |
| 样本来源系统 |  |
| 允许用途 | 前台利润自动归集隔离 dry run |
| 允许期间 |  |
| 允许保留时长 |  |
| 隔离环境标识 |  |
| 禁止事项确认 | 不进 Git、不进 CI、不进普通 artifacts、不连接生产库 |

授权确认：

- [ ] 授权人确认样本可用于本次隔离验收。
- [ ] 执行人确认只使用脱敏副本执行 dry run。
- [ ] 执行人确认验收结束会删除临时 DB、临时上传文件和临时导出。

## 2. 只读盘点

| 来源族 | 文件/表别名 | 行数 | 日期字段 | 日期范围 | 来源系统 | 敏感字段 | 备注 |
|---|---|---:|---|---|---|---|---|
| operator_assignment |  |  |  |  |  |  |  |
| sales_fact |  |  |  |  |  |  |  |
| cost_period |  |  |  |  |  |  |  |
| cost_usage |  |  |  |  |  |  |  |
| rebate |  |  |  |  |  |  |  |
| fee_fact |  |  |  |  |  |  |  |
| promotion_spend |  |  |  |  |  |  |  |
| manual_baseline |  |  | 日期 |  |  |  |  |

盘点门槛：

- [ ] 只读盘点完成，未修改原始样本。
- [ ] 每个来源族明确是否参与本次 dry run。
- [ ] manual baseline 为现有 28 字段标准结果，后续必须通过 `canonicalRowsContract`。

## 3. 字段映射与脱敏

| 来源族 | 真实表头 | 脱敏合同字段 | 脱敏方式 | 负责人 | 必填 | 异常策略 |
|---|---|---|---|---|---|---|
| operator_assignment |  |  |  |  |  |  |
| sales_fact |  |  |  |  |  |  |
| cost_period |  |  |  |  |  |  |
| cost_usage |  |  |  |  |  |  |
| rebate |  |  |  |  |  |  |
| fee_fact |  |  |  |  |  |  |
| promotion_spend |  |  |  |  |  |  |
| manual_baseline |  |  |  |  |  |  |

填写 `manifest.json` 时，优先按下面的字段参考补齐 `fieldMappings`。真实表头可以不同，但脱敏后的 CSV 必须保留这些合同语义；同一个真实实体在不同来源族里必须稳定替换成同一个 join key。

| 来源族 | 建议覆盖的合同字段 | 真实替换要求 |
|---|---|---|
| operator_assignment | `effective_from`, `authority_key`, `shop_key`, `authority_type`, `authority_value`, `operator_key`, `effective_to`, `source_batch` | `shop_key`、`authority_value`、`operator_key` 稳定哈希；有效期窗口不能重叠到无法判定权威运营。 |
| sales_fact | `sale_date`, `sale_key`, `platform`, `business_mode`, `group_name`, `shop_key`, `shop_normalized`, `sku_key`, `ad_account_key`, `quantity`, `gmv`, `shipment_value`, `source_batch` | `sale_key` 唯一且稳定；`shop_key`、`sku_key`、`ad_account_key` 要能与运营、成本、推广和费用来源 join。 |
| cost_period | `effective_from`, `sku_key`, `effective_to`, `cost_basis`, `unit_cost`, `currency`, `source_batch` | `sku_key` 与销售/成本用量/补单一致；同一 SKU 的成本生效期不能冲突。 |
| cost_usage | `shipment_date`, `sale_key`, `sku_key`, `quantity`, `matched_cost_basis`, `matched_unit_cost`, `source_batch` | `shipment_date` 是当前成本匹配日期；`sale_key` 和 `sku_key` 必须与销售事实稳定关联。 |
| rebate | `rebate_event_date`, `rebate_key`, `sale_key`, `sku_key`, `rebate_amount`, `rebate_reason`, `source_batch` | `rebate_key` 是补单业务键；补单按 `rebate_event_date` 归属 period。 |
| fee_fact | `fee_date`, `fee_key`, `sale_key`, `fee_type`, `authority_source`, `fee_amount`, `source_batch` | `authority_source` 只能按 `settlement > platform_bill > rate_rule > manual_estimate` 优先级参与判定。 |
| promotion_spend | `promotion_date`, `promotion_key`, `ad_account_key`, `shop_key`, `campaign_key`, `spend_amount`, `allocation_policy`, `source_batch` | 推广费用优先按广告账号再按店铺分配；孤儿费用不静默丢弃，保留诊断。 |
| manual_baseline | `date`, `record_id`, `platform`, `business_mode`, `group_name`, `shop`, `shop_normalized`, `operator`, `quantity`, `gmv`, `shipment_value`, `front_profit`, `source_batch` | 这是现有 28 字段 manual 01 对账基线，必须能通过 `canonicalRowsContract`，不能手写可信摘要。 |

本地 `front-profit-acceptance/source-inventory.md` 是 synthetic 演练包说明；它可以作为替换示例，但凡含 `synthetic`、`mock`、`placeholder`、`rehearsal` 或 `stable_hash_mock` 的内容都不能作为真实样本验收证据。

脱敏确认：

- [ ] 客户、账号、手机号、订单号、广告账号等可识别字段已替换或哈希。
- [ ] 脱敏后仍保留 join key 稳定性、日期分布、金额分布和重复/缺失样例。
- [ ] 脱敏副本文件名不含客户、员工、账号或业务敏感信息。

## 4. 业务口径确认

| 口径 | 本次 dry run 取值 | 负责人 | 例外处理 |
|---|---|---|---|
| period 口径 | 自然月 |  |  |
| 关账日 | 次月第 5 日 |  |  |
| 补单业务键 | `rebate_key` |  |  |
| 补单归属日期 | `rebate_event_date` |  |  |
| 费用权威优先级 | `settlement > platform_bill > rate_rule > manual_estimate` |  |  |
| 运营权威键优先级 | `sku > ad_account > product_owner > order_owner > manual_mapping` |  |  |
| 成本匹配日期 | `shipment_date` |  |  |
| 推广孤儿费用 | 保留并参与利润，可产生负利润 |  |  |

## 5. Dry Run 执行记录

| 步骤 | 证据 |
|---|---|
| 临时 DB/隔离实例创建 |  |
| 迁移执行 |  |
| 上传脱敏样本 sourceId |  |
| source family 标记 |  |
| draft/shadow runId |  |
| DQ 结果 |  |
| recon 结果 |  |
| publish version |  |
| publish 幂等重试 |  |
| rollback 演练 |  |
| 清理临时资源 |  |
| result manifest 路径与校验结果 |  |

必须记录的查询结果：

- `job_run.status`
- `dq_event` 未解决 BLOCK 数
- `recon_result` 失败项
- `publish_version` 当前 `published/superseded/rolled_back` 状态
- `front_profit_publish_row` 当前 published 行数

## 6. 验收判定

| 门槛 | 判定 | 证据 |
|---|---|---|
| 聚合键覆盖率 100% |  |  |
| 金额差异均 <= 0.01 |  |  |
| 未解决 BLOCK = 0 |  |  |
| 必须 warning 已解释 |  |  |
| publish 重试不新增版本 |  |  |
| rollback 可恢复上一版本 |  |  |
| 临时资源已清理 |  |  |

结论：

- [ ] 通过，可进入小范围发布授权讨论。
- [ ] 不通过，需补字段映射/业务口径/异常处理后重跑。

## 7. 生产发布授权占位

真实样本 dry run 通过不等于生产发布授权。生产发布需另行确认：

- 发布 period：
- 发布平台/范围：
- 发布窗口：
- 观察窗口：
- 回退负责人：
- 备份位置：
- 镜像 tag/digest：
- 回滚目标版本：

机器可校验的发布授权信息从 [`front-profit-production-release.example.json`](front-profit-production-release.example.json) 复制到被 Git 忽略的位置后填写，例如 `front-profit-production-release/release.json`：

```powershell
pnpm --filter @ec/api run front-profit:production-release-gate -- --release front-profit-production-release/release.json
```

第一版生产 gate 要求至少 2 个完整 dry-run period 通过，首次发布只切 1 个 period + 1 个平台，并保留观察窗口和回滚负责人。
