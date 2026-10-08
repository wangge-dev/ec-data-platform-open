import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const readRoot = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("public documentation contracts", () => {
  test("documents a source bootstrap that acquires fixed Docker images before startup", () => {
    expect(readRoot("README.md")).toContain("docs/TECHNICAL_OVERVIEW.md");
    for (const path of ["docs/TECHNICAL_OVERVIEW.md", "docs/部署指南.md"]) {
      const document = readRoot(path);
      const postgresPull = document.indexOf("docker pull postgres:16");
      const redisPull = document.indexOf("docker pull redis:7-alpine");
      const applicationBuild = document.indexOf("docker compose build --pull api web");
      const startup = document.indexOf("docker compose up -d", applicationBuild);
      expect(postgresPull, path).toBeGreaterThan(-1);
      expect(redisPull, path).toBeGreaterThan(postgresPull);
      expect(applicationBuild, path).toBeGreaterThan(redisPull);
      expect(startup, path).toBeGreaterThan(applicationBuild);
    }
  });

  test("states that ADMIN_PASSWORD initializes but never resets an existing admin", () => {
    const technicalOverview = readRoot("docs/TECHNICAL_OVERVIEW.md");
    const guide = readRoot("docs/部署指南.md");
    const seed = readRoot("apps/api/scripts/seed.ts");
    expect(seed).toMatch(/if \(exists\)[\s\S]*已存在，跳过/);
    expect(technicalOverview).toContain("不会重置已有 `admin` 账号的密码");
    expect(guide).toContain("只在数据库中还没有 `admin` 账号时");
    expect(guide).toContain("修改 `.env` 或重启服务不会重置已有密码");
  });

  test("links public licensing and keeps business data outside the release", () => {
    expect(readRoot("LICENSE")).toContain("MIT License");
    expect(readRoot("LICENSE")).toContain("Copyright (c) 2026 wangge-dev");
    expect(readRoot("LICENSE")).toContain("The above copyright notice and this permission notice shall be included");
    expect(readRoot("README.md")).toContain("MIT");
    expect(readRoot("docs/TECHNICAL_OVERVIEW.md")).toContain("MIT");
    expect(readRoot("docs/README.md")).toContain("MIT");
    expect(readRoot("docs/USER_GUIDE.md")).toContain("公开仓库");
    expect(readRoot("SECURITY.md")).toContain("synthetic or properly sanitized");
    for (const path of ["README.md", "docs/USER_GUIDE.md", "docs/AI_DIY_GUIDE.md", "docs/AI_PROMPTS.md"]) {
      expect(readRoot(path), path).not.toContain("PRIVATE_DELIVERY.md");
    }
  });

  test("keeps front profit and semantic-layer claims bounded", () => {
    const technicalOverview = readRoot("docs/TECHNICAL_OVERVIEW.md");
    const readme = readRoot("README.md");
    const index = readRoot("docs/README.md");
    expect(technicalOverview).toContain("前台利润预生产骨架");
    expect(technicalOverview).toContain("尚未通过真实样本和生产发布验收");
    expect(technicalOverview).toContain("不是通用 BI 语义模型");
    expect(readme).toContain("不代替财务结账");
    expect(index).toContain("前台利润自动归集仍需真实样本和生产发布验收");
  });

  test("ships MIT consistently without stripping upstream notices", () => {
    for (const path of ["package.json", "apps/api/package.json", "apps/web/package.json"]) {
      expect(JSON.parse(readRoot(path)).license, path).toBe("MIT");
    }
    for (const path of ["scripts/package-release.ps1", "scripts/package-release.sh",
      "cloud-kit/README.md", "templates/ecommerce-workbench/README.md"]) {
      expect(readRoot(path), path).toContain("MIT");
      expect(readRoot(path), path).not.toContain("GPL-3.0-only");
      expect(readRoot(path), path).toContain("THIRD_PARTY_NOTICES.md");
    }
    expect(readRoot("README.md")).toContain("无需作者另行批准");
    expect(readRoot("docs/USER_GUIDE.md")).toContain("保留版权与许可声明");
    expect(readRoot("patches/braces.LICENSE")).toContain("Jon Schlinkert");
    for (const path of ["apps/api/Dockerfile", "apps/web/Dockerfile"]) {
      expect(readRoot(path), path).toContain('LABEL org.opencontainers.image.licenses="MIT"');
      expect(readRoot(path), path).toContain("COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/ec-data-platform/");
    }
  });
});
