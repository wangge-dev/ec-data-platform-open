// crypto 单元测试（V0.27：外部 SQL 密码 AES 加密往返）
import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "../src/lib/crypto";

describe("crypto encrypt/decrypt", () => {
  it("encrypt 后 decrypt 还原原文", () => {
    const plain = "my_db_password_123!@#";
    const enc = encrypt(plain);
    expect(enc).not.toBe(plain);
    expect(enc.length).toBeGreaterThan(0);
    expect(decrypt(enc)).toBe(plain);
  });

  it("空字符串往返", () => {
    expect(encrypt("")).toBe("");
    expect(decrypt("")).toBe("");
  });

  it("中文/特殊字符往返", () => {
    const plain = "密码p@ss含中文";
    expect(decrypt(encrypt(plain))).toBe(plain);
  });

  it("篡改密文解密返回空（不抛）", () => {
    const enc = encrypt("secret");
    const tampered = enc.slice(0, -4) + "AAAA";
    expect(decrypt(tampered)).toBe("");
  });

  it("每次加密结果不同（随机 iv）", () => {
    const a = encrypt("same");
    const b = encrypt("same");
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe("same");
    expect(decrypt(b)).toBe("same");
  });
});
