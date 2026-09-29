// V0.27：敏感数据加密（外部 SQL 密码等）
// AES-256-GCM，密钥从 ENCRYPTION_KEY env（32 字节），没有则用 JWT_SECRET 派生
// 加密结果含 iv + tag + 密文，base64 编码存储，解密时校验 tag 防篡改
import crypto from "node:crypto";

const ALGO = "aes-256-gcm";

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || "dev_secret_change_me";
  return crypto.createHash("sha256").update(raw).digest(); // 32 字节
}

/**
 * 加密明文，返回 base64(iv|tag|ciphertext)
 */
export function encrypt(plain: string): string {
  if (!plain) return "";
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/**
 * 解密 base64(iv|tag|ciphertext)，返回明文。失败返回空串（不抛，调用方按空密码处理）
 */
export function decrypt(b64: string): string {
  if (!b64) return "";
  try {
    const buf = Buffer.from(b64, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}
