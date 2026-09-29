import { describe, expect, test } from "vitest";
import {
  buildCreateModuleRequest,
  buildSchemaDecisionRequest,
  builderFailureMessage,
  createInitialBuilderState,
  filenamePhraseCoverage,
  applyInspectedFilenamePhrase,
  replaceBuilderSources,
  summarizePendingSchemaFiles,
  validateSchemaDecisions,
  validateBuilderStep,
  type ModuleBuilderState,
  type SchemaDecision,
  type SchemaDiff,
  type SemanticRole,
} from "./model";

test("pending schema file summary reports files hidden behind the first three", () => {
  expect(summarizePendingSchemaFiles([1, 2, 3, 4, 5])).toEqual({
    visible: [1, 2, 3],
    remaining: 2,
  });
});

test("schema retry request always submits the complete durable operation group", () => {
  const request = buildSchemaDecisionRequest({
    added: ["新金额"],
    missingRequired: [],
    missingOptional: [],
    aliasCandidates: [],
    typeChanges: [],
    expectedVersion: 2,
    operationId: "11111111-1111-4111-8111-111111111111",
    sourceIds: [162, 161, 162],
    schemaFingerprints: { "161": "a".repeat(64), "162": "b".repeat(64) },
    reviewStatus: "awaiting_retry",
    retryMessage: "文件处理失败，请稍后重试",
  }, [{
    source: "新金额",
    action: "alias",
    target: "amount",
  }]);

  expect(request).toMatchObject({
    sourceIds: [161, 162],
    operationId: "11111111-1111-4111-8111-111111111111",
    decisions: [{
      sourceField: "新金额",
      decision: "alias",
      targetField: "amount",
    }],
  });
  expect(JSON.stringify(request)).not.toContain("password=");
});

const roles: SemanticRole[] = [
  "time",
  "amount",
  "quantity",
  "product_id",
  "product_name",
  "sku",
  "status",
  "order_id",
  "shop",
  "dimension",
];

function builderState(
  overrides: Partial<ModuleBuilderState> = {},
): ModuleBuilderState {
  const initial = createInitialBuilderState([161, 162], "request-key");
  return {
    ...initial,
    name: "拼多多销售",
    category: "shop_ops",
    filenamePhrase: "orders_export",
    headers: ["支付时间", "商品金额", "订单状态", "商品名称", "备注"],
    samples: [],
    mappings: Object.fromEntries(
      roles.map((role) => [role, null]),
    ) as ModuleBuilderState["mappings"],
    ...overrides,
  };
}

function mappingsWithDuplicateSource(): ModuleBuilderState["mappings"] {
  return {
    ...builderState().mappings,
    time: {
      source: "支付时间",
      label: "支付时间",
      type: "timestamp",
      required: true,
    },
    amount: {
      source: "支付时间",
      label: "商品金额",
      type: "numeric",
      required: true,
    },
    status: {
      source: "订单状态",
      label: "订单状态",
      type: "text",
      required: false,
    },
  };
}

function confirmedPinduoduoState(): ModuleBuilderState {
  return builderState({
    mappings: {
      ...builderState().mappings,
      time: {
        source: "支付时间",
        label: "支付时间",
        type: "timestamp",
        required: true,
      },
      amount: {
        source: "商品金额",
        label: "商品金额",
        type: "numeric",
        required: true,
      },
      status: {
        source: "订单状态",
        label: "订单状态",
        type: "text",
        required: false,
      },
      product_name: {
        source: "商品名称",
        label: "商品名称",
        type: "text",
        required: false,
      },
    },
    additionalFields: [
      { source: "备注", label: "备注", type: "text" },
    ],
    includedStatuses: ["已发货，待收货", "已收货"],
    step: "review",
  });
}

describe("module builder model", () => {
  test("requires unique source fields and an included status when status is mapped", () => {
    const state = builderState({
      mappings: mappingsWithDuplicateSource(),
      includedStatuses: [],
      step: "mapping",
    });

    expect(validateBuilderStep(state)).toEqual([
      "同一源字段不能重复映射",
      "请选择至少一个计入有效数据的状态",
    ]);
  });

  test("builds the confirmed Pinduoduo request without implementation fields", () => {
    const request = buildCreateModuleRequest(confirmedPinduoduoState());

    expect(request).toMatchObject({
      name: "拼多多销售",
      sourceIds: [161, 162],
      filenamePhrase: "orders_export",
      inclusion: {
        statusSource: "订单状态",
        includedValues: ["已发货，待收货", "已收货"],
      },
      idempotencyKey: "request-key",
    });
    expect(Object.keys(request)).not.toContain("headers");
    expect(Object.keys(request)).not.toContain("samples");
    expect(request.mappings).toHaveLength(4);
  });

  test("builds safe calculated fields from already mapped numeric sources", () => {
    const state = confirmedPinduoduoState();
    state.headers.push("商品成本");
    state.additionalFields.push({ source: "商品成本", label: "商品成本", type: "numeric" });
    state.calculatedFields = [{
      label: "毛利",
      operation: "subtract",
      leftSource: "商品金额",
      rightSource: "商品成本",
      unit: "currency",
    }];

    expect(validateBuilderStep(state)).toEqual([]);
    expect(buildCreateModuleRequest(state).calculatedFields).toEqual([{
      label: "毛利",
      operation: "subtract",
      leftSource: "商品金额",
      rightSource: "商品成本",
      unit: "currency",
    }]);
  });

  test("blocks formulas that reference nonnumeric or identical fields", () => {
    const state = confirmedPinduoduoState();
    state.calculatedFields = [{
      label: "错误公式",
      operation: "subtract",
      leftSource: "商品金额",
      rightSource: "商品名称",
      unit: "number",
    }, {
      label: "相同字段",
      operation: "ratio",
      leftSource: "商品金额",
      rightSource: "商品金额",
      unit: "percent",
    }];

    expect(validateBuilderStep(state)).toEqual([
      "计算字段「错误公式」只能选择已映射的数值字段",
      "计算字段「相同字段」的左右两项不能相同",
    ]);
  });

  test("creates a fresh clean state for each dialog opening", () => {
    expect(createInitialBuilderState([9, 10], "another-key")).toMatchObject({
      sourceIds: [9, 10],
      filenamePhraseOrigin: "auto",
      idempotencyKey: "another-key",
      step: "basic",
      mappings: expect.objectContaining({
        time: null,
        amount: null,
        status: null,
      }),
    });
  });

  test("recomputes an untouched automatic filename phrase when sources change", () => {
    const changed = applyInspectedFilenamePhrase(
      replaceBuilderSources(
        confirmedPinduoduoState(),
        [163],
      ),
      "new_orders",
    );

    expect(changed).toMatchObject({
      sourceIds: [163],
      filenamePhrase: "new_orders",
      filenamePhraseOrigin: "auto",
      headers: [],
      samples: [],
      additionalFields: [],
      calculatedFields: [],
      includedStatuses: [],
      step: "basic",
      idempotencyKey: "request-key",
    });
    expect(Object.values(changed.mappings).every((mapping) => mapping === null)).toBe(true);
  });

  test("preserves a manually edited filename phrase when same-family sources change", () => {
    const manual = builderState({
      filenamePhrase: "pdd-order",
      filenamePhraseOrigin: "manual",
    });

    const changed = applyInspectedFilenamePhrase(
      replaceBuilderSources(manual, [161, 162, 163]),
      "orders_export",
    );

    expect(changed.filenamePhrase).toBe("pdd-order");
    expect(changed.filenamePhraseOrigin).toBe("manual");
  });

  test("never exposes a raw processing error to the builder UI", () => {
    const message = builderFailureMessage(
      "password=top-secret SQL relation user_data.uf_161 failed",
    );

    expect(message).toBe("处理失败，可稍后在数据页重试");
    expect(message).not.toContain("top-secret");
    expect(message).not.toContain("user_data");
  });

  test("keeps only known actionable processing errors in the builder UI", () => {
    expect(builderFailureMessage("未导入品牌维护表，请先导入")).toBe(
      "未导入品牌维护表，请先导入",
    );
    expect(builderFailureMessage("订单文件缺少必要字段，请检查字段对应")).toBe(
      "订单文件缺少必要字段，请检查字段对应",
    );
  });

  test("validates the active step without blocking optional roles", () => {
    expect(
      validateBuilderStep(
        builderState({ name: "", filenamePhrase: "", step: "basic" }),
      ),
    ).toEqual(["请填写模块名称", "请填写以后自动识别用的文件名关键词"]);

    expect(
      validateBuilderStep(
        builderState({
          mappings: {
            ...builderState().mappings,
            amount: {
              source: "商品金额",
              label: "商品金额",
              type: "numeric",
              required: true,
            },
          },
          step: "mapping",
        }),
      ),
    ).toEqual([]);
  });
});

test("filename keyword coverage checks filenames instead of spreadsheet headers", () => {
  const sources = [
    {
      id: 166,
      name: "第一批",
      config: { originalFileName: "01_拼多多订单_DIY模拟_第一批.xlsx" },
    },
    {
      id: 167,
      name: "第二批",
      config: { originalFileName: "02_拼多多订单_DIY模拟_第二批.xlsx" },
    },
  ];

  expect(filenamePhraseCoverage([166, 167], sources, "商品id")).toEqual({
    selected: 2,
    matched: 0,
  });
  expect(filenamePhraseCoverage([166, 167], sources, "拼多多订单")).toEqual({
    selected: 2,
    matched: 2,
  });
});

function evolvingSchemaDiff(
  overrides: Partial<SchemaDiff> = {},
): SchemaDiff {
  return {
    added: ["店铺名称", "商品总额"],
    missingRequired: ["支付时间"],
    missingOptional: ["备注"],
    missingRequiredFields: [
      { name: "pay_time", label: "支付时间", compatibleSources: ["商品总额"] },
    ],
    missingOptionalFields: [
      { name: "remark", label: "备注", compatibleSources: [] },
    ],
    aliasCandidates: [
      { source: "商品总额", target: "amount", score: 0.92 },
    ],
    typeChanges: [
      {
        source: "商品总额",
        target: "amount",
        label: "商品金额",
        expected: "numeric",
        required: false,
        blocking: false,
        compatibleSources: ["店铺名称"],
        failures: 8,
        samples: ["待客服确认", "金额见备注", "非常长的原始值".repeat(20)],
      },
    ],
    ...overrides,
  };
}

describe("schema-change decision model", () => {
  test("requires one decision for every added field and blocks unresolved required fields", () => {
    expect(
      validateSchemaDecisions(evolvingSchemaDiff(), [
        {
          source: "店铺名称",
          action: "add",
          label: "店铺名称",
          type: "text",
        },
      ]),
    ).toEqual([
      "新增字段「商品总额」尚未选择处理方式",
      "必要字段「支付时间」尚未对应",
    ]);
  });

  test("accepts an alias that resolves a required field and keeps optional missing fields nonblocking", () => {
    const decisions: SchemaDecision[] = [
      {
        source: "店铺名称",
        action: "add",
        label: "店铺名称",
        type: "text",
      },
      { source: "商品总额", action: "alias", target: "pay_time" },
    ];

    expect(validateSchemaDecisions(evolvingSchemaDiff(), decisions)).toEqual([]);
  });

  test("rejects duplicate, unknown, and incomplete decisions", () => {
    expect(
      validateSchemaDecisions(evolvingSchemaDiff({ missingRequired: [], missingRequiredFields: [] }), [
        { source: "店铺名称", action: "add", label: "", type: "text" },
        { source: "店铺名称", action: "ignore" },
        { source: "商品总额", action: "alias", target: "" },
        { source: "内部字段", action: "ignore" },
      ]),
    ).toEqual([
      "新增字段「店铺名称」只能选择一种处理方式",
      "请填写「店铺名称」的显示名称",
      "请选择「商品总额」要对应的已有字段",
      "字段「内部字段」不在本次变化中",
    ]);
  });

  test("blocks a required type change until a compatible replacement is mapped", () => {
    const diff = evolvingSchemaDiff({
      added: ["新实付金额"],
      missingRequired: [],
      missingRequiredFields: [],
      typeChanges: [
        {
          source: "商品总额",
          target: "amount",
          label: "商品金额",
          expected: "numeric",
          required: true,
          blocking: true,
          compatibleSources: ["新实付金额"],
          failures: 3,
          samples: ["待确认"],
        },
      ],
    });

    expect(
      validateSchemaDecisions(diff, [
        { source: "新实付金额", action: "ignore" },
      ]),
    ).toContain("字段「商品金额」格式不兼容，请选择可用字段重新对应");
    expect(
      validateSchemaDecisions(diff, [
        { source: "新实付金额", action: "alias", target: "amount" },
      ]),
    ).toEqual([]);
  });

  test("gives correction guidance when a blocking field has no compatible replacement", () => {
    const diff = evolvingSchemaDiff({
      added: [],
      missingRequired: [],
      missingRequiredFields: [],
      typeChanges: [
        {
          source: "商品总额",
          target: "amount",
          label: "商品金额",
          expected: "numeric",
          required: true,
          blocking: true,
          compatibleSources: [],
          failures: 3,
          samples: ["待确认"],
        },
      ],
    });

    expect(validateSchemaDecisions(diff, [])).toEqual([
      "字段「商品金额」格式不兼容，请修正源文件后重新上传",
    ]);
  });
});
