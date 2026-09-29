export function buildSourceSampleSql(sourceId: number): string {
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0) {
    throw new Error("请选择有效的数据文件");
  }
  return `SELECT * FROM "user_data"."uf_${sourceId}" LIMIT 30`;
}
