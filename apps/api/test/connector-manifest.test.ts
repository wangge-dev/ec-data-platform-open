import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  ConnectorManifestError,
  loadConnectorManifests,
  resolveConnectorManifest,
  validateConnectorManifest,
} from "../src/services/connector-manifest.js";

const tempDirectories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "connector-manifest-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("connector manifests", () => {
  test("loads built-in adapters and a data-only extension profile", () => {
    const directory = tempDirectory();
    writeFileSync(path.join(directory, "warehouse.json"), JSON.stringify({
      schemaVersion: "connector-manifest/v1",
      id: "warehouse.postgres",
      version: 2,
      label: "数仓 PostgreSQL",
      description: "公司数仓的只读连接配置档案。",
      adapter: "pg",
      defaultPort: 5432,
      sslMode: "required",
      capabilities: ["test", "list_tables", "query_readonly"],
    }));

    const manifests = loadConnectorManifests(directory);

    expect(manifests.map((manifest) => manifest.id)).toEqual([
      "postgres.readonly",
      "mysql.readonly",
      "warehouse.postgres",
    ]);
    expect(resolveConnectorManifest("warehouse.postgres", "pg", manifests)).toMatchObject({
      version: 2,
      adapter: "pg",
    });
  });

  test("fails closed for duplicate IDs and adapter mismatch", () => {
    const directory = tempDirectory();
    writeFileSync(path.join(directory, "duplicate.json"), JSON.stringify({
      schemaVersion: "connector-manifest/v1",
      id: "postgres.readonly",
      version: 9,
      label: "重复",
      description: "重复 ID 应阻止扩展目录加载。",
      adapter: "pg",
      defaultPort: 5432,
      capabilities: ["test"],
    }));

    expect(() => loadConnectorManifests(directory)).toThrowError(ConnectorManifestError);
    expect(() => resolveConnectorManifest("postgres.readonly", "mysql")).toThrowError(
      expect.objectContaining({ code: "CONNECTOR_DIALECT_MISMATCH" }),
    );
  });

  test("rejects executable or unknown adapter declarations", () => {
    expect(() => validateConnectorManifest({
      schemaVersion: "connector-manifest/v1",
      id: "custom.unsafe",
      version: 1,
      label: "不安全适配器",
      description: "不得通过 manifest 注入可执行驱动。",
      adapter: "javascript",
      entrypoint: "./driver.js",
      defaultPort: 1,
      capabilities: ["query_readonly"],
    })).toThrowError(expect.objectContaining({ code: "CONNECTOR_MANIFEST_INVALID" }));
    expect(() => validateConnectorManifest({
      schemaVersion: "connector-manifest/v1",
      id: "custom.unsafe",
      version: 1,
      label: "不安全适配器",
      description: "即使复用已审核适配器，也不能声明可执行入口。",
      adapter: "pg",
      entrypoint: "./driver.js",
      defaultPort: 5432,
      capabilities: ["query_readonly"],
    })).toThrowError(expect.objectContaining({ code: "CONNECTOR_MANIFEST_INVALID" }));
  });
});
