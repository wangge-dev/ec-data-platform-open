export const GENERIC_PROCESSING_ERROR = "文件处理失败，请稍后重试";

const SAFE_PUBLIC_ERRORS = new Set([
  "未导入品牌维护表，请先导入",
  "品牌维护表缺少必要的 ID 字段",
  "品牌维护表缺少必要的商家编码字段",
  "订单文件缺少必要字段，请检查字段对应",
  "输入文件缺少必要字段，请检查字段对应",
  "订单字段映射缺少商品或金额字段，请检查字段对应",
  "必填字段缺失，请检查字段对应",
  "必要字段存在无法读取的值，请修正源文件后重新上传",
  "字段有变化，需确认后重新处理",
  "字段设置待重试，请从字段确认入口重新处理",
]);
const ORDER_MAPPING_PREFIX = "订单模块「";

function messageOf(error: unknown): string {
  if (typeof error === "string") return error.trim();
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message.trim();
  }
  return "";
}

function isKnownOrderMappingError(message: string): boolean {
  const suffix =
    "的 columnOverrides 缺 product_id 或 amount，请在 orders.json 补全该平台的列映射";
  return message.startsWith(ORDER_MAPPING_PREFIX) && message.endsWith(suffix);
}

export function publicProcessingError(error: unknown): string {
  const message = messageOf(error);
  if (SAFE_PUBLIC_ERRORS.has(message)) return message;
  if (message === "未导入维护表(品牌字典)，请先导入") {
    return "未导入品牌维护表，请先导入";
  }
  if (message.startsWith("订单表缺列: ")) {
    return "订单文件缺少必要字段，请检查字段对应";
  }
  if (message.startsWith("输入文件缺少必填列: ")) {
    return "输入文件缺少必要字段，请检查字段对应";
  }
  if (message === "维护表缺少id列") {
    return "品牌维护表缺少必要的 ID 字段";
  }
  if (message === "维护表缺少商家编码列") {
    return "品牌维护表缺少必要的商家编码字段";
  }
  if (isKnownOrderMappingError(message)) {
    return "订单字段映射缺少商品或金额字段，请检查字段对应";
  }
  if (
    message === "全部行因 required 字段缺失被丢弃，请检查列名映射"
  ) {
    return "必填字段缺失，请检查字段对应";
  }
  return GENERIC_PROCESSING_ERROR;
}
