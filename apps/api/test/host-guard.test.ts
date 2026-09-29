// host-guard 单元测试（核验补）：SSRF 内网/元数据地址拦截
import { describe, it, expect } from "vitest";
import { isBlockedIp, assertHostAllowed } from "../src/lib/host-guard";

describe("isBlockedIp", () => {
  it("拦截 IPv4 私网/保留/元数据段", () => {
    for (const ip of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255",
      "192.168.0.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1",
      "192.0.2.10", "198.51.100.10", "203.0.113.10", "255.255.255.255",
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("放行公网 IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "11.0.0.1"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("拦截 IPv6 loopback/link-local/ULA 及 v4-mapped 内网", () => {
    for (const ip of [
      "::1", "fe80::1", "fe90::1", "febf::1", "fc00::1", "fd12::1", "ff02::1",
      "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe",
      "2001:db8::1", "2002:7f00:1::",
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows globally routable IPv6", () => {
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
  });
});

describe("assertHostAllowed", () => {
  it("拒绝 localhost 及内网后缀", async () => {
    for (const h of ["localhost", "db.internal", "svc.local"]) {
      await expect(assertHostAllowed(h)).rejects.toThrow();
    }
  });

  it("拒绝内网 IP 字面量", async () => {
    await expect(assertHostAllowed("169.254.169.254")).rejects.toThrow();
    await expect(assertHostAllowed("192.168.1.1")).rejects.toThrow();
  });

  it("放行公网 IP 字面量", async () => {
    await expect(assertHostAllowed("8.8.8.8")).resolves.toBe("8.8.8.8");
  });

  it("pins a domain to the validated numeric address", async () => {
    const lookup = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ];
    await expect(assertHostAllowed("database.example", lookup)).resolves.toBe("93.184.216.34");
  });

  it("rejects a domain when any resolved address is private", async () => {
    const lookup = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    await expect(assertHostAllowed("database.example", lookup)).rejects.toThrow();
  });
});
