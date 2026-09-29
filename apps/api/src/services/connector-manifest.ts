import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const ConnectorIdSchema = z.string().regex(
  /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/,
  "connector id 必须是 <namespace>.<name>",
);

export const ConnectorManifestSchema = z.object({
  schemaVersion: z.literal("connector-manifest/v1"),
  id: ConnectorIdSchema,
  version: z.number().int().positive(),
  label: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(500),
  adapter: z.enum(["pg", "mysql"]),
  defaultPort: z.number().int().positive().max(65535),
  sslMode: z.enum(["optional", "required", "disabled"]).default("optional"),
  capabilities: z
    .array(z.enum(["test", "list_tables", "query_readonly"]))
    .min(1)
    .default(["test", "list_tables", "query_readonly"]),
}).strict();
export type ConnectorManifest = z.infer<typeof ConnectorManifestSchema>;

export type ConnectorManifestErrorCode =
  | "CONNECTOR_MANIFEST_INVALID"
  | "CONNECTOR_MANIFEST_DUPLICATE"
  | "CONNECTOR_NOT_FOUND"
  | "CONNECTOR_DIALECT_MISMATCH";

export class ConnectorManifestError extends Error {
  constructor(
    readonly code: ConnectorManifestErrorCode,
    readonly publicMessage: string,
    readonly status: 400 | 404 | 409 | 500,
    readonly details?: Record<string, unknown>,
  ) {
    super(publicMessage);
    this.name = "ConnectorManifestError";
  }
}

const BUILTIN_CONNECTORS = [
  {
    schemaVersion: "connector-manifest/v1",
    id: "postgres.readonly",
    version: 1,
    label: "PostgreSQL 只读",
    description: "使用已审核 PostgreSQL 适配器进行连接测试、表发现和有界只读查询。",
    adapter: "pg",
    defaultPort: 5432,
    sslMode: "optional",
    capabilities: ["test", "list_tables", "query_readonly"],
  },
  {
    schemaVersion: "connector-manifest/v1",
    id: "mysql.readonly",
    version: 1,
    label: "MySQL 只读",
    description: "使用已审核 MySQL 适配器进行连接测试、表发现和有界只读查询。",
    adapter: "mysql",
    defaultPort: 3306,
    sslMode: "optional",
    capabilities: ["test", "list_tables", "query_readonly"],
  },
] satisfies unknown[];

function parseManifest(raw: unknown, source: string): ConnectorManifest {
  const parsed = ConnectorManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConnectorManifestError(
      "CONNECTOR_MANIFEST_INVALID",
      "连接器清单格式无效。",
      400,
      {
        source,
        issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      },
    );
  }
  return parsed.data;
}

export function validateConnectorManifest(raw: unknown): ConnectorManifest {
  return parseManifest(raw, "request");
}

export function connectorExtensionDirectory(): string | null {
  const configured = process.env.DIY_EXTENSIONS_DIR?.trim();
  return configured ? path.resolve(configured, "connectors") : null;
}

export function loadConnectorManifests(directory = connectorExtensionDirectory()): ConnectorManifest[] {
  const manifests = BUILTIN_CONNECTORS.map((manifest) => parseManifest(manifest, "builtin"));
  if (directory && existsSync(directory)) {
    const files = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
    for (const filename of files) {
      const filePath = path.resolve(directory, filename);
      const rawText = readFileSync(filePath, "utf8");
      if (Buffer.byteLength(rawText, "utf8") > 64 * 1024) {
        throw new ConnectorManifestError(
          "CONNECTOR_MANIFEST_INVALID",
          "连接器清单超过 64 KiB 限制。",
          400,
          { source: filename },
        );
      }
      let raw: unknown;
      try {
        raw = JSON.parse(rawText);
      } catch {
        throw new ConnectorManifestError(
          "CONNECTOR_MANIFEST_INVALID",
          "连接器清单不是合法 JSON。",
          400,
          { source: filename },
        );
      }
      manifests.push(parseManifest(raw, filename));
    }
  }

  const seen = new Set<string>();
  for (const manifest of manifests) {
    if (seen.has(manifest.id)) {
      throw new ConnectorManifestError(
        "CONNECTOR_MANIFEST_DUPLICATE",
        "连接器 ID 重复，扩展加载已停止。",
        409,
        { connectorId: manifest.id },
      );
    }
    seen.add(manifest.id);
  }
  return manifests;
}

export function resolveConnectorManifest(
  connectorId: string | undefined,
  dialect: "pg" | "mysql",
  manifests = loadConnectorManifests(),
): ConnectorManifest {
  const requestedId = connectorId ?? (dialect === "pg" ? "postgres.readonly" : "mysql.readonly");
  const connector = manifests.find((candidate) => candidate.id === requestedId);
  if (!connector) {
    throw new ConnectorManifestError(
      "CONNECTOR_NOT_FOUND",
      "请求的连接器未安装或未启用。",
      404,
      { connectorId: requestedId },
    );
  }
  if (connector.adapter !== dialect) {
    throw new ConnectorManifestError(
      "CONNECTOR_DIALECT_MISMATCH",
      "连接器与所选数据库类型不匹配。",
      400,
      { connectorId: connector.id, adapter: connector.adapter, dialect },
    );
  }
  return connector;
}

export function publicConnectorManifest(manifest: ConnectorManifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    version: manifest.version,
    label: manifest.label,
    description: manifest.description,
    adapter: manifest.adapter,
    defaultPort: manifest.defaultPort,
    sslMode: manifest.sslMode,
    capabilities: manifest.capabilities,
  };
}
