# 如何新增业务模块

普通用户不需要管理员权限，也不需要修改 JSON、写代码或重启服务。

正常使用方式是：

1. 在「数据」页勾选未匹配文件，点击「创建模块」；或在「模块管理」页点击「新建模块」。
2. 按页面向导填写模块名称，逐项选择日期、金额、数量、商品、状态等字段。
3. 如有订单状态，选择哪些状态计入有效数据。
4. 点击「保存并处理」。系统会保存配置、归入所选文件并立即执行处理。
5. 处理完成后，可从模块工作台查看数据，在「看板」按模块筛选自动生成的基础图表。

完整操作说明见 [SELF_SERVICE_MODULES.md](./SELF_SERVICE_MODULES.md)。

## 高级开发方式

以下内容只面向需要复杂 JOIN、计算字段、预警或自定义转换的开发人员。普通业务模块请优先使用页面向导。

### 适用场景

- 需要关联多张字典表；
- 需要复杂 SQL 计算或外部接口；
- 需要声明预警、场景预设或定时任务；
- 需要内置模块级别的受控发布。

### JSON 配置

内置模块配置位于：

```text
apps/api/src/modules/
```

建议复制最接近的现有模块 JSON，再按
[`apps/api/src/modules/schema.ts`](../apps/api/src/modules/schema.ts)
的约束调整。下面是一个可以直接校验和加载的最小示例：

```json
{
  "code": "inventory_daily",
  "name": "库存日报",
  "category": "warehouse",
  "description": "按日期查看商品库存",
  "columns": [
    {
      "name": "snapshot_date",
      "source": "统计日期",
      "label": "统计日期",
      "type": "date",
      "required": true,
      "semanticRole": "time"
    },
    {
      "name": "product_id",
      "source": "商品编码",
      "label": "商品编码",
      "type": "text",
      "required": true,
      "semanticRole": "product_id"
    },
    {
      "name": "stock_qty",
      "source": "库存数量",
      "label": "库存数量",
      "type": "int",
      "required": true,
      "semanticRole": "quantity"
    },
    {
      "name": "stock_status",
      "source": "库存状态",
      "label": "库存状态",
      "type": "text",
      "required": true,
      "semanticRole": "status"
    }
  ],
  "platforms": [
    {
      "code": "manual_upload",
      "name": "手动上传",
      "filePattern": "inventory_report|库存日报",
      "patternFlags": "i",
      "enabled": true,
      "columnOverrides": {}
    }
  ],
  "timeKey": "snapshot_date",
  "inclusionRule": {
    "field": "stock_status",
    "includedValues": ["正常", "在库"]
  },
  "usages": ["summary", "ai_chart", "ai_analysis"],
  "enabled": true,
  "hasTransform": false,
  "isDict": false
}
```

关键约束：

- `code` 和 `columns[].name` 使用英文小写与下划线；
- `source` 写上传文件中的原始表头；
- `filePattern` 使用受限匹配语法：优先写稳定文字；只允许顶层 `|`、`^`/`$`、每分支一个 `.*`、每分支一个单字符 `?` 和转义标点，不允许括号、字符类、`+`、`{}` 或回溯引用；
- `inclusionRule.field` 写输出字段名，不是原始表头；
- 不同来源列名不一致时，用 `platforms[].columnOverrides` 覆盖。

用户在页面创建的模块会持久化到数据库，不应再手工复制为 JSON。

### 自定义转换

只有声明式字段映射无法满足时，才创建同名的
`<code>.transform.ts`，并把 JSON 中的 `hasTransform` 设为 `true`。
钩子的最小契约如下：

```typescript
import type { TransformContext } from "./loader.js";
import type { EtlReport } from "../services/etl.js";

export default async function transform(
  ctx: TransformContext,
): Promise<EtlReport> {
  const sourceId = Number(ctx.extra?.sourceId);
  const platform = String(
    ctx.extra?.platformName ?? ctx.platform,
  ) as EtlReport["platform"];

  // 使用 ctx.sql 读取 uf_<sourceId>，自行完成转换和写入。
  // SQL 值必须参数化；动态表名和列名必须经过项目的安全引用工具。

  return {
    platform,
    sourceId,
    fileName: ctx.rawFileName ?? "",
    total: 0,
    inserted: 0,
    matched: 0,
    matchRate: 0
  };
}
```

自定义钩子必须自行完成 SQL、输出表写入、按来源重跑幂等处理，并返回
`EtlReport`。不要依赖 `ctx.rawRows` 或 `ctx.mappedRows`；运行时不保证填充。
可参考 `orders.transform.ts`。

页面创建的用户模块禁止加载自定义转换，避免把配置入口变成代码执行入口。

### 发布与重载

只修改已挂载的内置 JSON 时，使用登录令牌调用重载接口：

```powershell
$token = "<登录后取得的 JWT>"
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:4000/api/modules/reload" `
  -Headers @{ Authorization = "Bearer $token" }
```

修改 TypeScript、数据库迁移或镜像内文件时，在项目根目录执行正式部署：

```powershell
Set-Location deploy
docker compose --env-file .env build api web
docker compose --env-file .env up -d --force-recreate migrate
docker compose --env-file .env up -d --force-recreate api web
docker compose --env-file .env ps -a
```

确认 `migrate` 退出码为 0，API、Web、PostgreSQL 健康，Redis 正常运行。
上述命令仅供有部署权限的开发人员使用。
不要让普通用户执行命令行、复制代码或重启容器。
