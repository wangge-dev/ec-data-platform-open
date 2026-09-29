import { describe, expect, test } from "vitest";
import type { ModuleDef } from "../src/modules/schema.js";
import type { SchemaDiff } from "../src/services/module-source-inspector.js";
import {
  applySchemaDecisions,
  sourceSchemaFingerprint,
  unresolvedSchemaDiff,
  validateSchemaDecisionSet,
} from "../src/services/module-schema-review.js";

const moduleConfig = (): ModuleDef => ({
  code: "pinduoduo_sales",
  name: "拼多多销售",
  description: "拼多多销售数据",
  columns: [
    {
      name: "pay_time",
      source: "支付时间",
      label: "支付时间",
      type: "timestamp",
      required: true,
      computed: false,
    },
    {
      name: "amount",
      source: "商品金额",
      label: "商品金额",
      type: "numeric",
      required: true,
      computed: false,
    },
  ],
  platforms: [
    {
      code: "generic",
      name: "通用",
      filePattern: "orders_export",
      patternFlags: "i",
      enabled: true,
    },
  ],
  usages: ["summary"],
  enabled: true,
  hasTransform: false,
  isDict: false,
});

const diff = (): SchemaDiff => ({
  added: ["下单时间", "渠道备注", "内部标记"],
  missingRequired: ["支付时间"],
  missingOptional: [],
  missingRequiredFields: [{ name: "pay_time", label: "支付时间" }],
  missingOptionalFields: [],
  aliasCandidates: [
    { source: "下单时间", target: "pay_time", score: 0.8 },
  ],
  typeChanges: [],
});

describe("module schema review", () => {
  test("requires exactly one decision for every added field", () => {
    expect(
      validateSchemaDecisionSet(diff(), [
        {
          sourceField: "下单时间",
          decision: "alias",
          targetField: "pay_time",
        },
      ]),
    ).toEqual([
      "新增字段「渠道备注」尚未选择处理方式",
      "新增字段「内部标记」尚未选择处理方式",
    ]);
  });

  test("applies add and alias decisions while keeping ignored fields out of the module", () => {
    const decisions = [
      {
        sourceField: "下单时间",
        decision: "alias" as const,
        targetField: "pay_time",
      },
      {
        sourceField: "渠道备注",
        decision: "add" as const,
        dataType: "text" as const,
        label: "渠道备注",
      },
      { sourceField: "内部标记", decision: "ignore" as const },
    ];

    const updated = applySchemaDecisions(moduleConfig(), decisions);
    expect(updated.columns.find((column) => column.name === "pay_time")?.source).toEqual([
      "下单时间",
      "支付时间",
    ]);
    expect(updated.columns).toContainEqual(
      expect.objectContaining({
        source: "渠道备注",
        label: "渠道备注",
        type: "text",
        required: false,
      }),
    );
    expect(updated.columns.some((column) => column.source === "内部标记")).toBe(false);
    expect(unresolvedSchemaDiff(diff(), decisions)).toMatchObject({
      added: ["下单时间", "渠道备注"],
      missingRequired: ["支付时间"],
    });
  });

  test("historical add and alias decisions do not hide fields absent from the active restored config", () => {
    const restoredDiff: SchemaDiff = {
      ...diff(),
      added: ["旧新增字段", "旧别名字段", "永久忽略字段"],
      missingRequired: [],
      missingRequiredFields: [],
    };

    expect(
      unresolvedSchemaDiff(restoredDiff, [
        {
          moduleCode: "pinduoduo_sales",
          sourceField: "旧新增字段",
          decision: "add",
          dataType: "text",
          createdBy: 7,
        },
        {
          moduleCode: "pinduoduo_sales",
          sourceField: "旧别名字段",
          decision: "alias",
          targetField: "amount",
          createdBy: 7,
        },
        {
          moduleCode: "pinduoduo_sales",
          sourceField: "永久忽略字段",
          decision: "ignore",
          createdBy: 7,
        },
      ]),
    ).toMatchObject({
      added: ["旧新增字段", "旧别名字段"],
    });
  });

  test("rejects aliases to unknown fields and add decisions without a type", () => {
    expect(() =>
      applySchemaDecisions(moduleConfig(), [
        {
          sourceField: "下单时间",
          decision: "alias",
          targetField: "missing_target",
        },
      ]),
    ).toThrow("对应的已有字段不存在");
    expect(() =>
      applySchemaDecisions(moduleConfig(), [
        { sourceField: "渠道备注", decision: "add" },
      ]),
    ).toThrow("选择字段类型");
  });

  test("builds a deterministic schema fingerprint independent of header order", () => {
    const left = sourceSchemaFingerprint({
      sourceIds: [161],
      compatible: true,
      headers: ["金额", "时间"],
      samples: [],
      filenamePhrase: null,
      statusValues: [],
      inferredTypes: { 金额: "numeric", 时间: "timestamp" },
      differences: [],
    });
    const right = sourceSchemaFingerprint({
      sourceIds: [999],
      compatible: true,
      headers: ["时间", "金额"],
      samples: [],
      filenamePhrase: null,
      statusValues: [],
      inferredTypes: { 时间: "timestamp", 金额: "numeric" },
      differences: [],
    });

    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
  });
});
