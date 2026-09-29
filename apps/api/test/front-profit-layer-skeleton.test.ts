import { getTableName } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import {
  frontProfitL1SourceRows,
  frontProfitL3CalcDetails,
  frontProfitL4AggRows,
} from "../src/db/schema.js";
import {
  FRONT_PROFIT_LAYER_TABLES,
  FRONT_PROFIT_LAYER_VERSION,
  frontProfitL4AggRowToCanonicalRow,
  frontProfitL4RowsContract,
} from "../src/services/front-profit-layers.js";
import { FRONT_PROFIT_STANDARD_HEADERS } from "../src/services/front-profit-standard.js";
import {
  syntheticFrontProfitL1SourceRow,
  syntheticFrontProfitL3CalcDetail,
  syntheticFrontProfitL4AggRow,
} from "./fixtures/front-profit-complex-fixtures.js";

describe("front-profit L1/L3/L4 layer skeleton", () => {
  test("pins the three module-layer tables as fixed public tables", () => {
    expect(FRONT_PROFIT_LAYER_VERSION).toBe("front-profit-layers/v1");
    expect(FRONT_PROFIT_LAYER_TABLES).toEqual([
      "front_profit_l1_source_row",
      "front_profit_l3_calc_detail",
      "front_profit_l4_agg_row",
    ]);
    expect([
      getTableName(frontProfitL1SourceRows),
      getTableName(frontProfitL3CalcDetails),
      getTableName(frontProfitL4AggRows),
    ]).toEqual([...FRONT_PROFIT_LAYER_TABLES]);
  });

  test("keeps synthetic L4 rows compatible with the existing 28-field contract", () => {
    const row = syntheticFrontProfitL4AggRow();
    const canonical = frontProfitL4AggRowToCanonicalRow(row);

    expect(canonical).toHaveLength(FRONT_PROFIT_STANDARD_HEADERS.length);
    expect(canonical[23]).toBe(90);
    expect(canonical[24]).toBe(42);
    expect(canonical[25]).toBe(0.05);

    const contract = frontProfitL4RowsContract({ rows: [row] });
    expect(contract.summary).toEqual({
      schemaVersion: "front-profit-standard/v1",
      businessRowCount: 1,
      warningCount: 0,
      warningCodes: [],
    });
    expect(contract.scopeKeys).toEqual(["front_profit:2098-02"]);
  });

  test("models lineage without depending on unresolved business fact tables", () => {
    expect(syntheticFrontProfitL1SourceRow).toMatchObject({
      period: "2098-02",
      sourceFamily: "sales",
      amountKind: "GMV",
      currency: "CNY",
    });
    expect(syntheticFrontProfitL3CalcDetail).toMatchObject({
      period: "2098-02",
      mappingVersionId: 6001,
      ruleVersion: "synthetic-rule/v1",
      jobVersion: "synthetic-job/v1",
    });
  });
});
