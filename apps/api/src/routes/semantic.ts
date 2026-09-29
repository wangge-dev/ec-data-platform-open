import { Hono } from "hono";

import { authMiddleware } from "../lib/auth.js";
import { executeLocalReadOnlyQueryWithMetadata } from "../lib/local-readonly-sql.js";
import {
  compileSemanticQuery,
  loadSemanticModels,
  publicSemanticModel,
  SemanticQueryError,
} from "../services/semantic-model.js";

const r = new Hono();
r.use("*", authMiddleware);

function errorResponse(c: any, error: unknown) {
  if (error instanceof SemanticQueryError) {
    return c.json(
      {
        ok: false,
        code: error.code,
        message: error.publicMessage,
        ...(error.details ? { details: error.details } : {}),
      },
      error.status,
    );
  }
  console.error("[semantic-query] unexpected failure", error);
  return c.json(
    {
      ok: false,
      code: "SEMANTIC_QUERY_FAILED",
      message: "语义查询失败，请稍后重试。",
    },
    500,
  );
}

r.get("/models", async (c) => {
  try {
    const models = await loadSemanticModels();
    return c.json({
      ok: true,
      data: {
        schemaVersion: "semantic-catalog/v1",
        models: models.map(publicSemanticModel),
      },
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

r.get("/models/:modelId", async (c) => {
  try {
    const modelId = c.req.param("modelId");
    const models = await loadSemanticModels();
    const model = models.find((candidate) => candidate.id === modelId);
    if (!model) {
      throw new SemanticQueryError(
        "SEMANTIC_MODEL_NOT_FOUND",
        "请求的语义模型不存在或尚未启用。",
        404,
        { modelId },
      );
    }
    return c.json({ ok: true, data: publicSemanticModel(model) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

r.post("/query", async (c) => {
  try {
    const payload = await c.req.json();
    const models = await loadSemanticModels();
    const compiled = compileSemanticQuery(payload, models);
    let result;
    try {
      result = await executeLocalReadOnlyQueryWithMetadata(
        compiled.sqlText,
        compiled.parameters,
        { limit: compiled.query.limit },
      );
    } catch (error) {
      console.error("[semantic-query] execution failed", {
        modelId: compiled.lineage.modelId,
        modelVersion: compiled.lineage.modelVersion,
        error,
      });
      throw new SemanticQueryError(
        "SEMANTIC_QUERY_FAILED",
        "语义查询执行失败，请检查模型数据后重试。",
        500,
      );
    }
    if (result.truncated) {
      throw new SemanticQueryError(
        "SEMANTIC_QUERY_INCOMPLETE",
        `查询结果超过 ${result.rowLimit.toLocaleString("zh-CN")} 行，请增加筛选条件或减少维度。`,
        422,
        { rowLimit: result.rowLimit },
      );
    }
    return c.json({
      ok: true,
      data: {
        rows: result.rows,
        columns: compiled.columns,
        complete: true,
        truncated: false,
        lineage: compiled.lineage,
        budget: compiled.budget,
      },
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

export default r;
