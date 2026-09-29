# DIY 语义层与扩展清单

当前改造目标是内部可维护、可让同事和 AI 安全扩展，不是通用 BI，也不是多租户 SaaS。新建图表、AI 出图和指标对比必须引用版本化 `modelId`、`metricId`、`dimensionId`；物理表名、字段名和聚合函数只存在于服务端语义模型内部。

## 六个稳定合同

- `module-manifest/v1`：普通模块的纯数据安装包。必须包含 `semantic-manifest/v1`，禁止 `hasTransform=true`。
- `semantic-manifest/v1`：模型 ID/版本、指标、维度、单位、聚合方式和跨时间可加性。
- `connector-manifest/v1`：连接器档案。它只能选择已审核的 `pg` 或 `mysql` 只读适配器，不能声明脚本或任意 entrypoint。
- `vertical-solution/v1`：一组可原子安装的普通模块及精确连接器版本要求。配置包必须明确声明不含业务数据、不含密钥。
- `solution-binding/v1`：目标实例内部保存的方案归属、方案版本和模块配置指纹；导出时自动移除，不会把来源实例状态带入交付包。
- `solution-rollback/v1`：一次成功升级返回的无数据、无密钥回滚凭据，用于把整组模块原子恢复到升级前版本。

语义查询返回 `semantic-lineage/v1` 与 `semantic-query-budget/v1`。模型版本不一致、未知指标/维度、库存跨快照直接相加、结果超预算等情况会使用稳定错误码关闭失败。

## 普通模块：不改核心源码

首选现有 Web“新建模块”向导。新模块会自动生成 v1 指标/维度清单，并写入已有 `module_configs` / `module_config_versions` 版本库。

向导现在还支持安全计算字段：业务人员只选择两个已映射的数值字段，以及相加、相减、相乘或相除，不提交 SQL。相除生成“分子汇总 ÷ 分母汇总”的 ratio 指标，避免错误地平均行级比例。任意表达式、窗口函数和跨行计算仍不开放。

需要由同事或 AI 生成完整 JSON 时，以 [`example-sales.module.json`](../apps/api/extensions/modules/example-sales.module.json) 为模板：

```powershell
cd apps/api
pnpm diy:validate extensions/modules/example-sales.module.json
```

管理员可先调用 `POST /api/modules/manifests/validate` 静态验证，再调用 `POST /api/modules/manifests/install` 安装。安装只登记版本化纯配置，不执行 ETL；之后在页面把文件分配给模块并处理。已有模块的升级继续走现有版本更新/恢复流程，提升语义版本时必须同步迁移引用它的图表。

需要用唯一键字典补品牌、店铺等属性时，参考 [`example-sales-enriched.module.json`](../apps/api/extensions/modules/example-sales-enriched.module.json)。配置校验会检查 JOIN 左字段、输出字段名和多 JOIN 重复写入；每次 ETL 还会在写入前检查当前字典关联键唯一，缺字典、重复键、字段无法解析或 JOIN 失败都会整段事务回滚。它防止意外一对多放大，但按时间生效和多事实表 JOIN 仍属于受控开发。

## 连接器：不改核心源码的边界

以 [`warehouse-postgres.example.json`](../apps/api/extensions/connectors/warehouse-postgres.example.json) 为模板，运行同一个验证命令。设置 `DIY_EXTENSIONS_DIR` 指向 `apps/api/extensions`（生产中应指向单独的只读挂载目录），API 会从其 `connectors/` 子目录加载 JSON 档案：

```powershell
$env:DIY_EXTENSIONS_DIR = (Resolve-Path apps/api/extensions)
cd apps/api
pnpm diy:validate extensions/connectors/warehouse-postgres.example.json
```

管理员通过 `GET /api/external-sql/connectors` 查看目录，通过 `POST /api/external-sql/connectors/validate` 验证草稿。保存连接时传 `connectorId`；系统会同时保存连接器版本，但密码仍只按原有加密方式保存和脱敏返回。

纯 JSON 可以新增同一驱动的命名档案、默认端口、TLS 要求和能力说明。以下扩展仍必须修改并审查受控代码：新数据库协议/驱动、跨源 JOIN、任意计算执行器、鉴权策略、迁移和密钥读取。

## 垂直方案：跨实例复制配置

[`ecommerce-starter.solution.json`](../apps/api/extensions/solutions/ecommerce-starter.solution.json) 是一个自包含示例：它把销售、库存两个普通模块和 `warehouse.postgres@1` 连接器要求放在同一个 `vertical-solution/v1` 文件中，不携带连接密码、上传文件或业务数据。

```powershell
cd apps/api
pnpm diy:validate extensions/solutions/ecommerce-starter.solution.json
```

管理员可直接打开 Web 侧栏的“方案交付”页面：

1. 在“导出方案”选择无 transform、带语义合同的用户模块，并按需勾选连接器要求，生成和下载 `.solution.json`。
2. 在目标实例的“校验并应用”选择文件。页面先做本地格式和 2 MiB 大小检查，再由服务端判断这是首次安装还是同一方案的兼容升级。
3. 首次安装会记录方案归属和配置指纹；升级要求方案版本递增、模块集合不变、语义合同不变，并拒绝覆盖本地定制。
4. 安装或升级的全部模块在一个数据库事务中写入。升级成功后页面提供本次升级的原子回滚按钮，模块历史版本继续单调递增。

需要自动化时，可使用同一组管理员接口：

- `POST /api/modules/solutions/export`：从当前实例选择多个用户模块和连接器 ID，导出规范配置包。
- `POST /api/modules/solutions/validate`：在目标实例返回 `install` / `upgrade` 计划和当前模块乐观锁版本；连接器漂移、非本方案同名模块、本地定制、降级包或破坏性合同变化会稳定拒绝。
- `POST /api/modules/solutions/apply`：携带校验返回的模块版本执行首次安装或兼容升级；执行时在同一事务内重新加锁和校验，任一并发变化或写入失败时全部回滚。
- `POST /api/modules/solutions/rollback`：使用本次升级返回的 `solution-rollback/v1`，在一个事务中恢复所有模块。凭据不能重复使用，目标模块变化后会拒绝回滚。
- `POST /api/modules/solutions/install`：保留给旧客户端的首次安装兼容入口，不允许借此覆盖或升级已有方案。

浏览器和服务端都把单个方案包限制在 2 MiB；单包最多 50 个模块、20 个连接器要求。目标是交付清晰的小型行业方案，不是把整个实例数据库塞入 JSON。

方案应用只复制模块定义和语义合同，不复制账号、数据源密码、上传文件、数据库数据、图表实例或看板布局。首次安装后，目标实例管理员仍需配置自己的连接、分配本地文件并运行 ETL；升级若改变导入映射或新增字段，也需要重新运行 ETL。这一边界保证配置可复制，但客户数据不会混入交付包。

## 已验证的通用性样本

- `front_profit.performance`：GMV、真实营业额、利润、推广费及“分子分母分别求和”的付费占比。
- `orders.analysis`：订单销售额/销量/订单行数，默认订单图表已改用指标 ID。
- `inventory.analysis`：库存快照不可跨时间直接求和，缺少快照日期时稳定拒绝。
- `ads.analysis`：CTR/CPC 从声明的分子分母重新计算，不平均行级比例。

这四类模型分别覆盖财务派生指标、普通可加总事实、半可加总快照和比率，足以验证当前内部 DIY 语义层；尚不代表已具备自由建模、跨模块关系图或 SaaS 租户隔离能力。

## 兼容与回滚

升级前已经保存的 `sql` / `table` 数据集只保留只读渲染兼容，不能从新建接口继续创建。新图表必须通过语义数据集和图表原子接口创建。

`vertical-solution/v1` 的自动升级故意限定为兼容更新：目标模块必须带有同一 `solution-binding/v1`，方案版本必须递增，模块集合、输出表、已有输出字段和完整语义模型必须保持不变。安装时记录的 SHA-256 模块指纹与当前配置不一致，就视为客户现场定制并拒绝覆盖。若确实需要删除字段、改变指标口径或升级语义版本，应先设计图表引用迁移和数据重算流程，不能借方案包静默更新。成功的兼容升级可用返回的 `solution-rollback/v1` 整组回滚；页面刷新后仍可在模块版本历史中逐项恢复，但持久化的方案升级审计/回滚记录尚未实现。
