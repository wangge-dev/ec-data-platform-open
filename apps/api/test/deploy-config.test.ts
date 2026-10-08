import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { SQL, getTableName } from "drizzle-orm";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import * as schema from "../src/db/schema.js";

const root = resolve(import.meta.dirname, "../../..");
const readRoot = (path: string) => readFileSync(resolve(root, path), "utf8");
const windowsTest = process.platform === "win32" ? test : test.skip;
const dockerComposeTest = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0
  ? test
  : test.skip;
const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
const hostBash = process.platform === "win32" ? gitBash : "bash";
const bashTest = spawnSync(hostBash, ["--version"], { stdio: "ignore" }).status === 0 ? test : test.skip;
const windowsBashTest = process.platform === "win32" &&
  spawnSync(gitBash, ["--version"], { stdio: "ignore" }).status === 0
  ? test
  : test.skip;
const hostPowerShell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const powerShellTest = spawnSync(hostPowerShell, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
  stdio: "ignore",
}).status === 0 ? test : test.skip;
const invalidUtf8 = Buffer.from([0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e, 0x2f, 0x73, 0x68, 0x0a, 0xc3, 0x28]);
const releaseFileRecord = (releaseRoot: string, relative: string) => {
  const bytes = readFileSync(join(releaseRoot, relative));
  return {
    path: relative.replaceAll("\\", "/"),
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};
const releaseFileRecords = (releaseRoot: string, relatives: string[]) =>
  relatives.map((relative) => releaseFileRecord(releaseRoot, relative)).sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
const releaseDocAllowlist = [
  "GETTING_STARTED.md",
  "DEPENDENCY_SECURITY_2026-10-08.md",
  "HOW_TO_ADD_MODULE.md",
  "HOW_TO_ADD_PLATFORM.md",
  "SELF_SERVICE_MODULES.md",
  "DIY_SEMANTIC_EXTENSIONS.md",
  "USER_GUIDE.md",
  "AI_DIY_GUIDE.md",
  "AI_PROMPTS.md",
  "加模块_给人看.md",
  "部署指南.md",
  "离线包使用说明.md",
];
const frontProfitWorkbookAllowlist = [
  "01-电商前台利润单表上传模板.xlsx",
  "02-电商前台利润数据准备与映射模板.xlsx",
];
const frontProfitTemplateAllowlist = [
  ...frontProfitWorkbookAllowlist,
  "README-前台利润模板使用说明.md",
  "SHA256SUMS.txt",
  "template-manifest.json",
];

const toGitBashPath = (path: string): string =>
  path.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replaceAll("\\", "/");
const toHostBashPath = (path: string): string => process.platform === "win32" ? toGitBashPath(path) : path;

const prepareMinimalReleaseSource = (sourceRoot: string, packager: string) => {
  for (const directory of [
    "scripts",
    "deploy",
    "docs",
    "apps/api/src/modules",
    "apps/api/extensions/connectors",
    "apps/api/extensions/modules",
    "apps/api/extensions/solutions",
    "templates/front-profit",
  ]) {
    mkdirSync(join(sourceRoot, directory), { recursive: true });
  }
  copyFileSync(resolve(root, `scripts/${packager}`), join(sourceRoot, `scripts/${packager}`));
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    copyFileSync(resolve(root, name), join(sourceRoot, name));
  }
  copyFileSync(resolve(root, "scripts/sha256.ps1"), join(sourceRoot, "scripts/sha256.ps1"));
  for (const launcher of [
    "release-start.ps1",
    "release-start.sh",
    "release-start.bat",
    "instance-backup.ps1",
    "instance-restore.ps1",
    "instance-backup.sh",
    "instance-restore.sh",
  ]) {
    copyFileSync(resolve(root, `scripts/${launcher}`), join(sourceRoot, `scripts/${launcher}`));
  }
  writeFileSync(join(sourceRoot, "deploy/.env.example"), "EXAMPLE=true\n", "utf8");
  writeFileSync(join(sourceRoot, "apps/api/src/modules/fixture.ts"), "export {};\n", "utf8");
  for (const extension of [
    "connectors/warehouse-postgres.example.json",
    "modules/example-sales.module.json",
    "solutions/ecommerce-starter.solution.json",
  ]) {
    copyFileSync(
      resolve(root, "apps/api/extensions", extension),
      join(sourceRoot, "apps/api/extensions", extension),
    );
  }
  for (const doc of releaseDocAllowlist) {
    writeFileSync(join(sourceRoot, "docs", doc), `recipient guide: ${doc}\n`, "utf8");
  }
  for (const template of frontProfitTemplateAllowlist) {
    copyFileSync(
      resolve(root, "templates/front-profit", template),
      join(sourceRoot, "templates/front-profit", template),
    );
  }
  mkdirSync(join(sourceRoot, "docs/superpowers/plans"), { recursive: true });
  writeFileSync(join(sourceRoot, "docs/internal-evaluation.md"), "internal only\n", "utf8");
  writeFileSync(join(sourceRoot, "docs/superpowers/plans/internal-plan.md"), "internal only\n", "utf8");
};

const assertFrontProfitTemplatePackage = (templateRoot: string) => {
  expect(readdirSync(templateRoot).sort()).toEqual([...frontProfitTemplateAllowlist].sort());
  const manifest = JSON.parse(readFileSync(join(templateRoot, "template-manifest.json"), "utf8"));
  expect(manifest.containsRealBusinessData).toBe(false);
  expect(manifest.files.map((entry: { name: string }) => entry.name).sort()).toEqual(
    [...frontProfitWorkbookAllowlist].sort(),
  );
  for (const entry of manifest.files as Array<{ name: string; sha256: string; businessDataRows: number }>) {
    expect(entry.businessDataRows).toBe(0);
    const actualHash = createHash("sha256")
      .update(readFileSync(join(templateRoot, entry.name)))
      .digest("hex")
      .toUpperCase();
    expect(actualHash).toBe(entry.sha256);
  }
};

const findFiles = (directory: string, suffix: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? findFiles(path, suffix) : path.endsWith(suffix) ? [path] : [];
  });

describe("Docker deployment contract", () => {
  test("runs API and Web quality gates from the repository root", () => {
    const rootPackage = JSON.parse(readRoot("package.json"));
    const webPackage = JSON.parse(readRoot("apps/web/package.json"));

    expect(rootPackage.scripts.typecheck).toContain("@ec/api");
    expect(rootPackage.scripts.typecheck).toContain("@ec/web");
    expect(rootPackage.scripts.test).toContain("test:api");
    expect(rootPackage.scripts.test).toContain("test:web");
    expect(rootPackage.scripts.build).toContain("@ec/api");
    expect(rootPackage.scripts.build).toContain("@ec/web");
    expect(webPackage.scripts.typecheck).toContain("tsc");
  });

  test("keeps local outputs, worktrees, and archives out of the Docker build context", () => {
    const patterns = new Set(
      readRoot(".dockerignore")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")),
    );

    for (const required of [
      ".codegraph/",
      ".worktrees/",
      "outputs/",
      "**/outputs/",
      "*.zip",
      "**/*.zip",
      "*.7z",
      "**/*.7z",
      "*.tar",
      "**/*.tar",
      "*.tgz",
      "**/*.tgz",
    ]) {
      expect(patterns.has(required), `missing Docker context exclusion: ${required}`).toBe(true);
    }
  });

  test("keeps the latest chained snapshot in semantic parity with the current public schema", () => {
    const journal = JSON.parse(readRoot("apps/api/drizzle/meta/_journal.json"));
    expect(journal.entries.length).toBeGreaterThan(0);
    let previousSnapshotId = "00000000-0000-0000-0000-000000000000";
    for (const [index, entry] of journal.entries.entries()) {
      const prefix = entry.tag.match(/^\d+/)?.[0];
      expect(prefix).toBeDefined();
      expect(entry.idx).toBe(index);
      expect(existsSync(resolve(root, `apps/api/drizzle/${entry.tag}.sql`))).toBe(true);
      const entrySnapshotPath = resolve(root, `apps/api/drizzle/meta/${prefix}_snapshot.json`);
      expect(existsSync(entrySnapshotPath)).toBe(true);
      const entrySnapshot = JSON.parse(readFileSync(entrySnapshotPath, "utf8"));
      expect(entrySnapshot.prevId).toBe(previousSnapshotId);
      expect(entrySnapshot.dialect).toBe("postgresql");
      previousSnapshotId = entrySnapshot.id;
    }
    const latestEntry = journal.entries.at(-1);
    const latestPrefix = latestEntry.tag.match(/^\d+/)![0];
    const snapshotPath = resolve(root, `apps/api/drizzle/meta/${latestPrefix}_snapshot.json`);
    const dockerfile = readRoot("apps/api/Dockerfile");

    expect(existsSync(snapshotPath)).toBe(true);

    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    const schemaTables = Object.values(schema);
    const schemaTableNames = schemaTables.map(getTableName).sort();
    const dialect = new PgDialect();
    const schemaDefault = (column: any): unknown => {
      if (column.default === undefined) return undefined;
      if (column.default instanceof SQL) return dialect.sqlToQuery(column.default).sql;
      if (column.getSQLType() === "jsonb") {
        return `'${JSON.stringify(column.default).replaceAll("'", "''")}'::jsonb`;
      }
      if (typeof column.default === "string") return `'${column.default.replaceAll("'", "''")}'`;
      return column.default;
    };

    expect(Object.keys(snapshot.tables).sort()).toEqual(schemaTableNames.map((name) => `public.${name}`));

    for (const table of schemaTables) {
      const config = getTableConfig(table);
      const metadata = snapshot.tables[`public.${config.name}`];

      expect(config.schema).toBe("public");
      expect(metadata.name).toBe(config.name);
      expect(metadata.schema || "public").toBe(config.schema);
      expect(Object.keys(metadata.columns).sort()).toEqual(config.columns.map((column) => column.name).sort());

      for (const column of config.columns) {
        const columnMetadata = metadata.columns[column.name];

        expect(columnMetadata.type).toBe(column.getSQLType());
        expect(columnMetadata.notNull).toBe(column.notNull);
        expect(columnMetadata.primaryKey).toBe(column.primary);
        expect(columnMetadata.default).toBe(schemaDefault(column));
      }

      const schemaUniques = [
        ...config.columns
          .filter((column) => column.isUnique)
          .map((column) => ({
            name: column.uniqueName,
            columns: [column.name],
            nullsNotDistinct: false,
          })),
        ...config.uniqueConstraints.map((constraint) => ({
          name: constraint.getName(),
          columns: constraint.columns.map((column) => column.name),
          nullsNotDistinct: constraint.nullsNotDistinct,
        })),
      ];
      const snapshotUniques = Object.values(metadata.uniqueConstraints).map((constraint: any) => ({
        name: constraint.name,
        columns: constraint.columns,
        nullsNotDistinct: Boolean(constraint.nullsNotDistinct),
      }));
      expect(snapshotUniques).toEqual(schemaUniques);

      const schemaForeignKeys = config.foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();
        const foreignConfig = getTableConfig(reference.foreignTable);
        return {
          name: foreignKey.getName(),
          tableFrom: config.name,
          columnsFrom: reference.columns.map((column) => column.name),
          schemaTo: foreignConfig.schema,
          tableTo: foreignConfig.name,
          columnsTo: reference.foreignColumns.map((column) => column.name),
          onDelete: foreignKey.onDelete ?? "no action",
          onUpdate: foreignKey.onUpdate ?? "no action",
        };
      });
      const snapshotForeignKeys = Object.values(metadata.foreignKeys).map((foreignKey: any) => ({
        name: foreignKey.name,
        tableFrom: foreignKey.tableFrom,
        columnsFrom: foreignKey.columnsFrom,
        schemaTo: foreignKey.schemaTo || "public",
        tableTo: foreignKey.tableTo,
        columnsTo: foreignKey.columnsTo,
        onDelete: foreignKey.onDelete ?? "no action",
        onUpdate: foreignKey.onUpdate ?? "no action",
      }));
      expect(snapshotForeignKeys).toEqual(schemaForeignKeys);

      const schemaIndexes = config.indexes.map((index) => ({
        name: index.config.name,
        isUnique: Boolean(index.config.unique),
        method: index.config.method ?? "btree",
        columns: index.config.columns.map((column: any) => ({
          expression: column.name,
          isExpression: false,
          asc: column.indexConfig?.asc !== false,
          nulls: column.indexConfig?.nulls,
          opclass: column.indexConfig?.opClass,
        })),
      }));
      const snapshotIndexes = Object.values(metadata.indexes).map((index: any) => ({
        name: index.name,
        isUnique: index.isUnique,
        method: index.method,
        columns: index.columns,
      }));
      expect(snapshotIndexes).toEqual(schemaIndexes);
    }

    expect(dockerfile).toContain("COPY apps/api/ ./apps/api/");
    expect(dockerfile).toMatch(/FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder/);
    expect(dockerfile).toMatch(/FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runtime/);
    expect(readRoot("apps/web/Dockerfile")).toMatch(/FROM nginx:1\.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10/);
    expect(dockerfile).toContain("corepack prepare pnpm@9.15.9 --activate");
    expect(dockerfile).toContain("pnpm --filter @ec/api install --prod --frozen-lockfile");
    expect(dockerfile).toContain("pnpm --filter @ec/api --prod deploy /prod/apps/api");
    expect(dockerfile).toContain("COPY --from=builder --chown=node:node /prod/apps/api/ ./");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).not.toContain("COPY apps/web/package.json");
  });

  test("defines a production-only API deploy allowlist and runtime verifier", () => {
    const apiPackage = JSON.parse(readRoot("apps/api/package.json"));
    const expectedFiles = [
      "src",
      "extensions",
      "scripts/migrate.ts",
      "scripts/migration-schema.ts",
      "scripts/seed.ts",
      "scripts/demo-maintenance.ts",
      "scripts/ecommerce-intake/pdd-standardize.mjs",
      "scripts/ecommerce-intake/sycm-standardize.mjs",
      "scripts/verify-runtime-package.mjs",
      "drizzle",
      "docker-entrypoint.sh",
      "tsconfig.json",
    ];

    expect(apiPackage.dependencies.tsx).toBe("4.22.4");
    expect(apiPackage.devDependencies).not.toHaveProperty("tsx");
    expect(apiPackage.files).toEqual(expectedFiles);
    expect(apiPackage.files).not.toContain("test");
    const runtimeVerifier = readRoot("apps/api/scripts/verify-runtime-package.mjs");
    expect(runtimeVerifier).toContain("development/Web dependency is resolvable");
    expect(runtimeVerifier).toContain("extensions/solutions/ecommerce-starter.solution.json");
  });

  test("gates API startup on a journaled owner migration and least-privilege grants", () => {
    const compose = readRoot("deploy/docker-compose.yml");
    const entrypoint = readRoot("apps/api/docker-entrypoint.sh");
    const roleInit = readRoot("deploy/init-app-role.sh");
    const gitignore = readRoot(".gitignore");
    const migratePath = resolve(root, "apps/api/scripts/migrate.ts");
    const migrationSchemaPath = resolve(root, "apps/api/scripts/migration-schema.ts");

    expect(existsSync(migratePath)).toBe(true);
    expect(existsSync(migrationSchemaPath)).toBe(true);
    const migrateScript = readFileSync(migratePath, "utf8");
    const migrationSchema = readFileSync(migrationSchemaPath, "utf8");
    const migrateService = compose.match(/\n  migrate:\r?\n([^]*?)\n  api:/)?.[1];
    const apiService = compose.match(/\n  api:\r?\n([^]*?)\n  web:/)?.[1];

    expect(migrateService).toBeDefined();
    expect(migrateService).toContain("image: deploy-api:latest");
    expect(migrateService).toContain("MIGRATION_DATABASE_URL: postgres://ec:");
    expect(migrateService).toContain("condition: service_healthy");
    expect(migrateService).toContain('restart: "no"');
    expect(apiService).toContain("DATABASE_URL: postgres://ec_app:");
    expect(apiService).not.toContain("MIGRATION_DATABASE_URL");
    expect(apiService).toContain("ENCRYPTION_KEY: ${ENCRYPTION_KEY:-}");
    expect(apiService).toContain("ALLOW_PRIVATE_SQL_HOST: ${ALLOW_PRIVATE_SQL_HOST:-0}");
    expect(apiService).toContain("DIY_EXTENSIONS_DIR: /app/apps/api/extensions");
    expect(apiService).toContain("../apps/api/extensions:/app/apps/api/extensions:ro");
    expect(apiService).toMatch(/migrate:\s+condition: service_completed_successfully/);

    expect(migrateScript).toContain('from "drizzle-orm/postgres-js/migrator"');
    expect(migrateScript).toContain('from "./migration-schema.js"');
    expect(migrateScript).toMatch(/await migrate\([\s\S]+migrationsFolder,/);
    expect(migrateScript).not.toContain("0000_init.sql");
    expect(migrateScript).toContain("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    expect(migrateScript).toContain("REVOKE CREATE ON SCHEMA public FROM ${quoteIdentifier(APP_ROLE)}");
    expect(migrateScript).toContain("GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO ec_app");
    expect(migrateScript).toContain("GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA ${quoteIdentifier(USER_SCHEMA)} TO ec_app");
    expect(migrateScript).toContain("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${quoteIdentifier(USER_SCHEMA)} TO ec_app");
    expect(migrateScript).toContain("ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerIdentifier} IN SCHEMA public");
    expect(migrateScript).toContain("postgres(migrationUrl, { max: 1");
    expect(migrateScript).toContain("pg_advisory_lock");
    expect(migrateScript).toContain("pg_advisory_unlock");
    expect(migrationSchema).toContain("legacy schema validation failed");
    expect(migrationSchema).toContain("foreign_schema");
    expect(migrationSchema).toContain("indnkeyatts");
    expect(migrationSchema).toContain("seqincrement");
    expect(migrateScript).toContain('const USER_SCHEMA = "user_data"');
    expect(migrateScript).toContain("CREATE SCHEMA IF NOT EXISTS ${schema}");
    expect(migrateScript).toContain("GRANT USAGE, CREATE ON SCHEMA ${quoteIdentifier(USER_SCHEMA)} TO ${quoteIdentifier(APP_ROLE)}");
    expect(migrateScript).toContain("SET search_path TO public, ${quoteIdentifier(USER_SCHEMA)}");
    expect(migrateScript).toContain("createUserSchema(client, identity.database_owner)");
    expect(migrateScript).toContain("[identity.database_owner, identity.current_user]");
    expect(migrateScript).toContain(
      "applyApplicationGrants(client, identity.database_name, identity.database_owner)",
    );
    expect(migrateScript).toMatch(/ALTER TABLE[\s\S]+OWNER TO/);
    expect(migrateScript).toContain("SET SCHEMA ${quoteIdentifier(USER_SCHEMA)}");
    expect(migrateScript).toContain("adopted existing dynamic table ${USER_SCHEMA}.${table}");

    expect(entrypoint).not.toMatch(/0000_init|TABLE_EXISTS|drizzle\/|\|\||\|\s*tail/);
    expect(entrypoint).toContain("./node_modules/.bin/tsx scripts/seed.ts");
    expect(roleInit).not.toMatch(/GRANT\s+USAGE\s*,\s*CREATE/i);
    expect(roleInit).toContain("REVOKE CREATE ON SCHEMA public FROM ec_app");
    expect(gitignore).not.toMatch(/^apps\/api\/drizzle\/?$/m);

    const futureMigration = spawnSync("git", ["check-ignore", "apps/api/drizzle/9999_future.sql"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(futureMigration.status, futureMigration.stdout + futureMigration.stderr).toBe(1);
  });

  test("provides repeatable two-schema migration runtime coverage", () => {
    const smokePath = resolve(root, "apps/api/test/migration-runtime-smoke.ps1");
    const rootPackage = JSON.parse(readRoot("package.json"));
    expect(existsSync(smokePath)).toBe(true);
    expect(rootPackage.scripts.test).toContain("test:migration-runtime");
    expect(rootPackage.scripts["test:migration-runtime"]).toContain("migration-runtime-smoke.ps1");
    const smoke = readFileSync(smokePath, "utf8");
    expect(smoke).toContain("Invoke-FreshSmoke");
    expect(smoke).toContain("Invoke-LegacySmoke");
    expect(smoke).toContain("Invoke-DriftSmoke");
    expect(smoke).toContain("run --rm --no-deps migrate");
    expect(smoke).toContain("importExcel");
    expect(smoke).toContain("runDefaultTransform");
    expect(smoke).toContain("Remove-IsolatedProject");
    expect(smoke).toContain("com.docker.compose.project=$project");
    expect(smoke).toContain("AggregateException");
    expect(smoke).toContain("user_data.users");
    expect(smoke).toContain("user_data.unified_sales");
    expect(smoke).toContain("user_data.settings");
    expect(smoke).toContain("user_data.alerts");
    expect(smoke).toContain("user_data.runtime_dynamic");
    expect(smoke).toContain("runtime_visible");
    expect(smoke).toContain("legacy_runtime");
    expect(smoke).toContain("false|public,user_data");
    expect(smoke).toContain("public.settings");
    expect(smoke).toContain("/api/etl/folder");
    expect(smoke).toContain("/api/alerts");
    expect(smoke).toContain("public-folder");
    expect(smoke).toContain("shadow-alert");
  });

  test("normalizes the API entrypoint to BOM-free LF UTF-8 before chmod", () => {
    const dockerfile = readRoot("apps/api/Dockerfile");
    const normalizer = dockerfile.match(
      /node -e '([^']+)' \/prod\/apps\/api\/docker-entrypoint\.sh/s,
    )?.[1];
    const sandbox = mkdtempSync(join(tmpdir(), "ec-api-entrypoint-"));
    const entrypoint = join(sandbox, "docker-entrypoint.sh");

    try {
      expect(normalizer).toBeDefined();

      writeFileSync(entrypoint, Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("#!/bin/sh\r\necho ready\r\n", "utf8"),
      ]));
      const normalized = spawnSync(process.execPath, ["-e", normalizer!, entrypoint], {
        encoding: "utf8",
      });

      expect(normalized.status, normalized.stderr).toBe(0);
      expect(readFileSync(entrypoint)).toEqual(Buffer.from("#!/bin/sh\necho ready\n", "utf8"));

      writeFileSync(entrypoint, invalidUtf8);
      const rejected = spawnSync(process.execPath, ["-e", normalizer!, entrypoint], {
        encoding: "utf8",
      });
      expect(rejected.status).not.toBe(0);

      const copyIndex = dockerfile.indexOf("COPY apps/api/ ./apps/api/");
      const normalizeIndex = dockerfile.indexOf("node -e");
      const chmodIndex = dockerfile.indexOf("chmod +x /prod/apps/api/docker-entrypoint.sh");
      expect([copyIndex < normalizeIndex, normalizeIndex < chmodIndex]).toEqual([true, true]);
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  });

  test("provisions the application database role before the API starts", () => {
    const compose = readRoot("deploy/docker-compose.yml");

    expect(compose).toContain("APP_DB_PASSWORD: ${APP_DB_PASSWORD:?Set APP_DB_PASSWORD in deploy/.env}");
    expect(compose).toContain("./init-app-role.sh:/docker-entrypoint-initdb.d/10-init-app-role.sh:ro");
  });

  test("release package keeps runtime modules and the real web port", () => {
    const script = readRoot("scripts/package-release.sh");
    const powerShell = readRoot("scripts/package-release.ps1");

    expect(script).toContain('cp -r apps/api/src/modules "${DIST_PATH}/apps/api/src/"');
    expect(script).toContain('cp -r apps/api/extensions "${DIST_PATH}/apps/api/"');
    expect(powerShell).toContain("apps\\api\\extensions");
    expect(powerShell).toContain("releaseApiRoot 'extensions'");
    expect(script).toContain('cp -r templates/front-profit "${DIST_PATH}/templates/"');
    expect(script).not.toMatch(/http:\/\/localhost(?!:3997)/);
  });

  test("allows only the audited front-profit workbook package and verifies its hashes", () => {
    const powerShell = readRoot("scripts/package-release.ps1");
    const bash = readRoot("scripts/package-release.sh");

    expect(powerShell).toContain("function Assert-FrontProfitTemplateDirectory");
    expect(powerShell).toContain("Front-profit template SHA-256 mismatch");
    expect(powerShell).toContain("containsRealBusinessData=false");
    expect(powerShell).toContain("templates\\front-profit");
    expect(bash).toContain("assert_front_profit_template_directory");
    expect(bash).toContain("Front-profit template SHA-256 mismatch");
    expect(bash).toContain("containsRealBusinessData=false");
    expect(bash).toContain("templates/front-profit/*.xlsx");
    for (const fileName of frontProfitTemplateAllowlist) {
      expect(existsSync(resolve(root, "templates/front-profit", fileName))).toBe(true);
    }
    assertFrontProfitTemplatePackage(resolve(root, "templates/front-profit"));
  });

  test("provides a Windows packager with two-pass secret auditing", () => {
    const script = readRoot("scripts/package-release.ps1");

    expect(script).toContain("function Assert-ReleaseTree");
    expect(script).toMatch(/Invoke-Native\s+docker\s+\(@\('save'\)/);
    expect(script).toContain("Compress-Archive");
    expect(script).toContain("Expand-Archive");
    expect(script).toContain("release-manifest.json");
    expect(script).toContain("$releaseDocNames");
    expect(script).toContain("*.env");
  });

  test("ships only the explicit recipient-safe documentation allowlist", () => {
    const powerShell = readRoot("scripts/package-release.ps1");
    const bash = readRoot("scripts/package-release.sh");

    expect(powerShell).toContain("HOW_TO_ADD_MODULE.md");
    expect(powerShell).toContain("HOW_TO_ADD_PLATFORM.md");
    expect(powerShell).toContain("SELF_SERVICE_MODULES.md");
    expect(powerShell).toContain("$humanModuleGuideName");
    expect(powerShell).toContain("$deploymentGuideName");
    expect(powerShell).toContain("$offlineGuideName");
    for (const doc of releaseDocAllowlist) expect(bash).toContain(doc);
    expect(powerShell).not.toMatch(/Copy-Item[^\r\n]+['"]docs['"][^\r\n]+-Recurse/);
    expect(bash).not.toContain('cp -r docs "${DIST_PATH}/"');
    expect(powerShell).toContain("Assert-ReleaseManifest");
    expect(bash).toContain("assert_release_manifest");
  });

  test("uses a portable release root and unique staging tree before mutation", () => {
    const script = readRoot("scripts/package-release.ps1");
    const boundaryCall = "$OutputRoot = Resolve-SafeReleaseRoot $OutputRoot";
    const firstMutation = "New-Item -ItemType Directory -Path $OutputRoot";

    expect(script).toContain("if (-not $OutputRoot) { $OutputRoot = Join-Path $RepoRoot 'release' }");
    expect(script).toContain("function Resolve-SafeReleaseRoot");
    expect(script).toContain("[Guid]::NewGuid().ToString('N').Substring(0, 12)");
    expect(script).toContain("('.s-' + $stagingNonce)");
    expect(script).not.toContain("E:\\code\\ec-data-platform\\release");
    expect(script).toContain(boundaryCall);
    expect(script.indexOf(boundaryCall)).toBeLessThan(script.indexOf(firstMutation));
  });

  test("writes generated Windows text as UTF-8 without a BOM", () => {
    const script = readRoot("scripts/package-release.ps1");
    const launcher = readRoot("scripts/release-start.ps1");

    expect(script).toContain("[System.Text.UTF8Encoding]::new($false)");
    expect(script).toContain("[DateTime]::UtcNow.ToString(");
    expect(script).toContain("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
    expect(script).toContain("function Write-Utf8NoBom");
    expect(script).toContain("'scripts\\release-start.ps1'");
    expect(script).toContain("'scripts\\release-start.sh'");
    expect(script).toContain("'scripts\\release-start.bat'");
    expect(script).toContain("Write-Utf8NoBom (Join-Path $distRoot 'release-manifest.json')");
    expect(launcher.indexOf("$expectedImageIds = Read-ExpectedImageIds $ManifestPath $ImageIdContractPath"))
      .toBeLessThan(launcher.indexOf("Get-Command docker"));
    expect(launcher).not.toContain("Get-ChildItem -LiteralPath $releaseRoot -Recurse");
  });

  powerShellTest("uses one .NET SHA-256 helper across every PowerShell release path", () => {
    const helperPath = resolve(root, "scripts/sha256.ps1");
    const helper = readFileSync(helperPath, "utf8");
    const consumers = [
      "scripts/package-release.ps1",
      "scripts/release-start.ps1",
      "scripts/verify-release.ps1",
      "scripts/package-development-handoff.ps1",
      "scripts/instance-backup.ps1",
      "scripts/instance-restore.ps1",
    ];

    expect(helper).toContain("function Get-Sha256Hex");
    expect(helper).toContain("[Security.Cryptography.SHA256]::Create()");
    expect(helper).not.toContain("Get-FileHash");
    for (const scriptPath of consumers) {
      const script = readRoot(scriptPath);
      expect(script).toContain(". (Join-Path $PSScriptRoot 'sha256.ps1')");
      expect(script).toContain("Get-Sha256Hex");
      expect(script).not.toContain("Get-FileHash");
    }
    expect(readRoot("scripts/package-release.ps1")).toContain(
      "Copy-Item -LiteralPath (Join-Path $RepoRoot 'scripts\\sha256.ps1') -Destination (Join-Path $distRoot 'sha256.ps1') -Force",
    );

    const escapedHelperPath = helperPath.replaceAll("'", "''");
    const probe = `
$ErrorActionPreference = 'Stop'
. '${escapedHelperPath}'
$path = [IO.Path]::GetTempFileName()
try {
  [IO.File]::WriteAllBytes($path, [Text.Encoding]::ASCII.GetBytes('abc'))
  $actual = Get-Sha256Hex $path
  if ($actual -cne 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') {
    throw "Unexpected SHA-256: $actual"
  }
  Write-Output 'DOTNET_SHA256_OK'
}
finally { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
`;
    const encoded = Buffer.from(probe, "utf16le").toString("base64");
    const result = spawnSync(
      hostPowerShell,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { encoding: "utf8", timeout: 20_000 },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status, output).toBe(0);
    expect(output).toContain("DOTNET_SHA256_OK");
    // Hosted Linux pwsh cold-start can exceed Vitest's default 5-second budget.
  }, 30_000);

  windowsTest("accepts a successful one-shot migration and still waits for API and Web health", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "ec-launcher-source-"));
    const expandedRoot = join(sourceRoot, "expanded");
    const outputRoot = join(sourceRoot, `.test-launcher-${process.pid}-${Date.now()}`);
    try {
      prepareMinimalReleaseSource(sourceRoot, "package-release.ps1");
      const packageResult = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(sourceRoot, "scripts/package-release.ps1"),
          "-OutputRoot",
          outputRoot,
          "-SkipImageExport",
        ],
        { encoding: "utf8" },
      );
      const packageOutput = `${packageResult.stdout ?? ""}${packageResult.stderr ?? ""}`;
      expect(packageResult.status, packageOutput).toBe(0);

      const [archive] = findFiles(outputRoot, ".zip");
      expect(archive).toBeDefined();
      const expandResult = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `Expand-Archive -LiteralPath '${archive!.replaceAll("'", "''")}' -DestinationPath '${expandedRoot.replaceAll("'", "''")}' -Force`,
        ],
        { encoding: "utf8" },
      );
      expect(expandResult.status, `${expandResult.stdout ?? ""}${expandResult.stderr ?? ""}`).toBe(0);
      const [expandedDistRoot] = readdirSync(expandedRoot).map((name) => join(expandedRoot, name));
      assertFrontProfitTemplatePackage(join(expandedDistRoot!, "templates/front-profit"));
      expect(existsSync(join(
        expandedDistRoot!,
        "apps/api/extensions/solutions/ecommerce-starter.solution.json",
      ))).toBe(true);
      for (const operatorTool of ["backup.ps1", "restore.ps1", "backup.sh", "restore.sh", "sha256.ps1"]) {
        expect(existsSync(join(expandedDistRoot!, operatorTool)), operatorTool).toBe(true);
      }
      const packagedManifest = JSON.parse(
        readFileSync(join(expandedDistRoot!, "release-manifest.json"), "utf8"),
      );
      expect(packagedManifest.createdAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );

      const [launcher] = findFiles(expandedRoot, "start.ps1");
      expect(launcher).toBeDefined();
      const launcherPath = launcher!.replaceAll("'", "''");
      const probe = `
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${launcherPath}', [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
$node = $ast.Find({
  param($candidate)
  $candidate -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $candidate.Name -eq 'Wait-ReleaseHealth'
}, $true)
if (-not $node) { throw 'Missing function: Wait-ReleaseHealth' }
Invoke-Expression $node.Extent.Text

$script:calls = @{ postgres = 0; redis = 0; migrate = 0; api = 0; web = 0 }
$script:states = @{
  postgres = @(
    [pscustomobject]@{ Status = 'running'; ExitCode = 0; Health = 'healthy' },
    [pscustomobject]@{ Status = 'running'; ExitCode = 0; Health = 'healthy' }
  )
  redis = @(
    [pscustomobject]@{ Status = 'running'; ExitCode = 0; Health = 'healthy' },
    [pscustomobject]@{ Status = 'running'; ExitCode = 0; Health = 'healthy' }
  )
  migrate = @(
    [pscustomobject]@{ Status = 'running'; ExitCode = 0; Health = '' },
    [pscustomobject]@{ Status = 'exited'; ExitCode = 0; Health = '' }
  )
  api = @(
    [pscustomobject]@{ Status = 'running'; ExitCode = 0; Health = 'starting' },
    [pscustomobject]@{ Status = 'running'; ExitCode = 0; Health = 'healthy' }
  )
  web = @(
    [pscustomobject]@{ Status = 'running'; ExitCode = 0; Health = 'healthy' },
    [pscustomobject]@{ Status = 'running'; ExitCode = 0; Health = 'healthy' }
  )
}
$reader = {
  param($service)
  $index = [Math]::Min($script:calls[$service], $script:states[$service].Count - 1)
  $script:calls[$service]++
  return $script:states[$service][$index]
}
Wait-ReleaseHealth -GetServiceState $reader -Delay { } -TimeoutSeconds 5
if ($script:calls.postgres -lt 2 -or $script:calls.redis -lt 2 -or
    $script:calls.api -lt 2 -or $script:calls.web -lt 2) {
  throw 'Service health was not awaited.'
}

$failed = $false
try {
  Wait-ReleaseHealth -GetServiceState {
    param($service)
    if ($service -eq 'migrate') { return [pscustomobject]@{ Status = 'exited'; ExitCode = 42; Health = '' } }
    return [pscustomobject]@{ Status = 'running'; ExitCode = 0; Health = 'healthy' }
  } -Delay { } -TimeoutSeconds 1
}
catch {
  if ($_.Exception.Message -notmatch 'exit code 42') { throw }
  $failed = $true
}
if (-not $failed) { throw 'Nonzero migration exit was accepted.' }

$missing = $false
try {
  Wait-ReleaseHealth -GetServiceState { param($service) return $null } -Delay { } -TimeoutSeconds 1
}
catch {
  if ($_.Exception.Message -notmatch 'Required Compose service is missing') { throw }
  $missing = $true
}
if (-not $missing) { throw 'Missing Compose service was accepted.' }
Write-Output 'GENERATED_LAUNCHER_BEHAVIOR_OK'
`;
      const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", probe], {
        encoding: "utf8",
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.status, output).toBe(0);
      expect(output).toContain("GENERATED_LAUNCHER_BEHAVIOR_OK");
    } finally {
      rmSync(sourceRoot, { force: true, recursive: true });
      rmSync(outputRoot, { force: true, recursive: true });
    }
  }, 15_000);

  powerShellTest("executes recipient PowerShell parsing with stderr separated from image IDs", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ec-release-ps-contract-"));
    try {
      const images = ["postgres:16", "redis:7-alpine", "deploy-api:latest", "deploy-web:latest"];
      const imageIds = Object.fromEntries(
        images.map((image, index) => [image, `sha256:${String(index + 1).repeat(64)}`]),
      );
      const manifestPath = join(sandbox, "release-manifest.json");
      const contractPath = join(sandbox, "release-image-ids.txt");
      const validEnvironmentPath = join(sandbox, "valid.env");
      const duplicateEnvironmentPath = join(sandbox, "duplicate.env");
      const quotedEnvironmentPath = join(sandbox, "quoted.env");
      const interpolatedEnvironmentPath = join(sandbox, "interpolated.env");
      const uriUnsafeEnvironmentPath = join(sandbox, "uri-unsafe.env");
      const validEnvironment = [
        "POSTGRES_PASSWORD=unique-postgres-password",
        "APP_DB_PASSWORD=unique-application-password",
        "ADMIN_PASSWORD=unique-admin-password",
        "JWT_SECRET=unique-jwt-secret-that-is-longer-than-thirty-two-characters",
        "",
      ].join("\n");
      const manifestFiles = [
        "duplicate.env",
        "invalid-manifests.json",
        "interpolated.env",
        "quoted.env",
        "release-image-ids.txt",
        "uri-unsafe.env",
        "valid.env",
      ];
      const manifestBase = {
        name: basename(sandbox),
        createdAt: "2026-08-08T00:00:00.000Z",
        sourceRevision: "a".repeat(40),
        imageSource: "local-build",
        images,
        imageIds,
        files: manifestFiles.map((path) => ({ path, size: 0, sha256: "0".repeat(64) })),
      };
      const duplicateManifest = `{"name":${JSON.stringify(manifestBase.name)},"createdAt":${JSON.stringify(manifestBase.createdAt)},"sourceRevision":${JSON.stringify(manifestBase.sourceRevision)},"imageSource":"local-build","images":${JSON.stringify(images)},"imageIds":${JSON.stringify(imageIds)},"imageIds":${JSON.stringify(imageIds)},"files":${JSON.stringify(manifestBase.files)}}\n`;
      const { files: _omittedFiles, ...manifestWithoutFiles } = manifestBase;
      const invalidManifestCases = [
        {
          label: "duplicate imageIds",
          pattern: "exactly one property named imageIds",
          json: duplicateManifest,
        },
        {
          label: "missing files",
          pattern: "exactly one property named files",
          json: `${JSON.stringify(manifestWithoutFiles)}\n`,
        },
        {
          label: "files is not an array",
          pattern: "images/files must be arrays",
          json: `${JSON.stringify({ ...manifestBase, files: { 0: manifestFiles[0] } })}\n`,
        },
        {
          label: "images is not an array",
          pattern: "images/files must be arrays",
          json: `${JSON.stringify({ ...manifestBase, images: 123 })}\n`,
        },
        {
          label: "missing payload entry",
          pattern: "does not exactly match the extracted payload",
          json: `${JSON.stringify({ ...manifestBase, files: manifestBase.files.slice(1) })}\n`,
        },
        {
          label: "invented payload entry",
          pattern: "does not exactly match the extracted payload",
          json: `${JSON.stringify({ ...manifestBase, files: [...manifestBase.files, { path: "ghost.txt", size: 0, sha256: "0".repeat(64) }] })}\n`,
        },
        {
          label: "unsafe payload path",
          pattern: "contains an unsafe path",
          json: `${JSON.stringify({ ...manifestBase, files: [{ path: "../escape", size: 0, sha256: "0".repeat(64) }, ...manifestBase.files.slice(1)] })}\n`,
        },
        {
          label: "non-canonical timestamp",
          pattern: "createdAt must be a canonical timestamp",
          json: `${JSON.stringify({ ...manifestBase, createdAt: "2026-08-08T08:00:00.000+08:00" })}\n`,
        },
        {
          label: "invalid calendar timestamp",
          pattern: "createdAt must be a canonical timestamp",
          json: `${JSON.stringify({ ...manifestBase, createdAt: "2026-02-30T00:00:00.000Z" })}\n`,
        },
      ];
      const invalidManifestsPath = join(sandbox, "invalid-manifests.json");
      writeFileSync(invalidManifestsPath, JSON.stringify(invalidManifestCases), "utf8");
      writeFileSync(
        contractPath,
        images.map((image) => `${image}=${imageIds[image]}`).join("\n") + "\n",
        "utf8",
      );
      writeFileSync(validEnvironmentPath, validEnvironment, "utf8");
      writeFileSync(
        duplicateEnvironmentPath,
        `${validEnvironment}ADMIN_PASSWORD=change_me_admin_password\n`,
        "utf8",
      );
      writeFileSync(
        quotedEnvironmentPath,
        validEnvironment.replace("ADMIN_PASSWORD=unique-admin-password", 'ADMIN_PASSWORD="change_me_admin_password"'),
        "utf8",
      );
      writeFileSync(
        interpolatedEnvironmentPath,
        validEnvironment.replace(
          "JWT_SECRET=unique-jwt-secret-that-is-longer-than-thirty-two-characters",
          "JWT_SECRET=${UNSET:-x}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
        "utf8",
      );
      writeFileSync(
        uriUnsafeEnvironmentPath,
        validEnvironment.replace("APP_DB_PASSWORD=unique-application-password", "APP_DB_PASSWORD=aaaaaaaaaaaa@"),
        "utf8",
      );
      manifestBase.files = releaseFileRecords(sandbox, manifestFiles);
      writeFileSync(manifestPath, `${JSON.stringify(manifestBase)}\n`, "utf8");
      const launcherPath = resolve(root, "scripts/release-start.ps1").replaceAll("'", "''");
      const sha256HelperPath = resolve(root, "scripts/sha256.ps1").replaceAll("'", "''");
      const escapedManifest = manifestPath.replaceAll("'", "''");
      const escapedContract = contractPath.replaceAll("'", "''");
      const escapedInvalidManifests = invalidManifestsPath.replaceAll("'", "''");
      const escapedValidEnvironment = validEnvironmentPath.replaceAll("'", "''");
      const escapedDuplicateEnvironment = duplicateEnvironmentPath.replaceAll("'", "''");
      const escapedQuotedEnvironment = quotedEnvironmentPath.replaceAll("'", "''");
      const escapedInterpolatedEnvironment = interpolatedEnvironmentPath.replaceAll("'", "''");
      const escapedUriUnsafeEnvironment = uriUnsafeEnvironmentPath.replaceAll("'", "''");
      const probe = `
$ErrorActionPreference = 'Stop'
. '${sha256HelperPath}'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${launcherPath}', [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
foreach ($functionName in @('Invoke-NativeCapture', 'Get-UniqueNativeLine', 'Read-StrictReleaseSecret', 'Assert-ReleaseEnvironment', 'Read-ImageIdContract', 'Test-CanonicalUtcJsonTimestamp', 'Read-ExpectedImageIds')) {
  $node = $ast.Find({
    param($candidate)
    $candidate -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $candidate.Name -eq $functionName
  }, $true)
  if (-not $node) { throw "Missing function: $functionName" }
  Invoke-Expression $node.Extent.Text
}
$Images = @('postgres:16', 'redis:7-alpine', 'deploy-api:latest', 'deploy-web:latest')
if ('${process.platform}' -eq 'win32') {
  $capture = Invoke-NativeCapture -File $env:ComSpec -Arguments @('/d', '/c', 'echo sha256:${"1".repeat(64)} & echo harmless warning 1>&2')
}
else {
  $capture = Invoke-NativeCapture -File '/bin/sh' -Arguments @('-c', 'echo sha256:${"1".repeat(64)}; echo "harmless warning" >&2')
}
if ($capture.ExitCode -ne 0) { throw 'Native probe failed.' }
if (@($capture.StdOut).Count -ne 1 -or @($capture.StdErr).Count -lt 1 -or ($capture.StdErr -join ' ') -notmatch 'harmless warning') {
  throw "stdout/stderr were not separated: stdout=$(@($capture.StdOut).Count) [$($capture.StdOut -join '|')], stderr=$(@($capture.StdErr).Count) [$($capture.StdErr -join '|')]"
}
$id = Get-UniqueNativeLine $capture.StdOut '^sha256:[0-9a-f]{64}$' 'probe image'
if ($id -cne 'sha256:${"1".repeat(64)}') { throw 'Image ID was contaminated.' }
$validManifestJson = [IO.File]::ReadAllText('${escapedManifest}', [Text.UTF8Encoding]::new($false, $true))
$expected = Read-ExpectedImageIds '${escapedManifest}' '${escapedContract}'
if ([string]$expected['deploy-web:latest'] -cne 'sha256:${"4".repeat(64)}') { throw 'Contract cross-check failed.' }
$invalidManifestCases = [IO.File]::ReadAllText('${escapedInvalidManifests}', [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json
foreach ($case in $invalidManifestCases) {
  [IO.File]::WriteAllText('${escapedManifest}', [string]$case.json, [Text.UTF8Encoding]::new($false))
  $manifestRejected = $false
  try { Read-ExpectedImageIds '${escapedManifest}' '${escapedContract}' | Out-Null }
  catch {
    if ($_.Exception.Message -notmatch [string]$case.pattern) { throw }
    $manifestRejected = $true
  }
  if (-not $manifestRejected) { throw "Unsafe manifest case was accepted: $($case.label)" }
}
[IO.File]::WriteAllText('${escapedManifest}', $validManifestJson, [Text.UTF8Encoding]::new($false))
$unexpectedPayload = Join-Path '${sandbox.replaceAll("'", "''")}' 'unexpected-payload.txt'
[IO.File]::WriteAllText($unexpectedPayload, 'tampered payload', [Text.UTF8Encoding]::new($false))
$unexpectedPayloadRejected = $false
try { Read-ExpectedImageIds '${escapedManifest}' '${escapedContract}' | Out-Null }
catch {
  if ($_.Exception.Message -notmatch 'does not exactly match the extracted payload') { throw }
  $unexpectedPayloadRejected = $true
}
Remove-Item -LiteralPath $unexpectedPayload -Force
if (-not $unexpectedPayloadRejected) { throw 'Unexpected extracted payload file was accepted.' }
if ('${process.platform}' -eq 'win32') {
  $junctionTarget = Join-Path '${sandbox.replaceAll("'", "''")}' 'junction-target'
  $junctionPath = Join-Path '${sandbox.replaceAll("'", "''")}' 'junction-link'
  New-Item -ItemType Directory -Path $junctionTarget | Out-Null
  New-Item -ItemType Junction -Path $junctionPath -Target $junctionTarget | Out-Null
  $junctionRejected = $false
  try { Read-ExpectedImageIds '${escapedManifest}' '${escapedContract}' | Out-Null }
  catch {
    if ($_.Exception.Message -notmatch 'contains a reparse point') { throw }
    $junctionRejected = $true
  }
  Remove-Item -LiteralPath $junctionPath -Force
  Remove-Item -LiteralPath $junctionTarget -Force
  if (-not $junctionRejected) { throw 'Directory junction in extracted payload was accepted.' }
}
Assert-ReleaseEnvironment '${escapedValidEnvironment}'
foreach ($invalidEnvironment in @(
  '${escapedDuplicateEnvironment}',
  '${escapedQuotedEnvironment}',
  '${escapedInterpolatedEnvironment}',
  '${escapedUriUnsafeEnvironment}'
)) {
  $environmentRejected = $false
  try { Assert-ReleaseEnvironment $invalidEnvironment }
  catch { $environmentRejected = $true }
  if (-not $environmentRejected) { throw "Unsafe environment syntax was accepted: $invalidEnvironment" }
}
Write-Output 'RELEASE_START_PS_CONTRACT_OK'
`;
      const encoded = Buffer.from(probe, "utf16le").toString("base64");
      const result = spawnSync(
        hostPowerShell,
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        { encoding: "utf8" },
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.status, output).toBe(0);
      expect(output).toContain("RELEASE_START_PS_CONTRACT_OK");
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  }, 15_000);

  powerShellTest("uses strict culture-independent UTC timestamps in every PowerShell release gate", () => {
    const scriptPaths = [
      "scripts/release-start.ps1",
      "scripts/verify-release.ps1",
      "scripts/package-release.ps1",
    ];
    const helperCall = "Test-CanonicalUtcJsonTimestamp -Json $manifestJson -PropertyName 'createdAt'";
    for (const scriptPath of scriptPaths) {
      const script = readRoot(scriptPath);
      expect(script).toContain("function Test-CanonicalUtcJsonTimestamp");
      expect(script).toContain("[Globalization.CultureInfo]::InvariantCulture");
      expect(script).toContain("[DateTimeOffset]::TryParseExact");
      expect(script).toContain(helperCall);
    }
    expect(readRoot("scripts/package-release.ps1")).toContain(
      "$requiredManifestProperties = @('name', 'createdAt', 'sourceRevision', 'imageSource', 'images', 'imageIds', 'files')",
    );

    const escapedPaths = scriptPaths.map((scriptPath) => resolve(root, scriptPath).replaceAll("'", "''"));
    const probe = `
$ErrorActionPreference = 'Stop'
$timestampCases = @(
  [pscustomobject]@{ Label = 'canonical UTC'; Json = '{"createdAt":"2026-08-08T00:00:00.000Z"}'; Expected = $true },
  [pscustomobject]@{ Label = 'offset'; Json = '{"createdAt":"2026-08-08T08:00:00.000+08:00"}'; Expected = $false },
  [pscustomobject]@{ Label = 'invalid calendar date'; Json = '{"createdAt":"2026-02-30T00:00:00.000Z"}'; Expected = $false },
  [pscustomobject]@{ Label = 'escaped UTC marker'; Json = '{"createdAt":"2026-08-08T00:00:00.000\\u005A"}'; Expected = $false },
  [pscustomobject]@{ Label = 'missing milliseconds'; Json = '{"createdAt":"2026-08-08T00:00:00Z"}'; Expected = $false },
  [pscustomobject]@{ Label = 'duplicate property'; Json = '{"createdAt":"2026-08-08T00:00:00.000Z","createdAt":"2026-08-08T00:00:00.000Z"}'; Expected = $false }
)
$currentThread = [Threading.Thread]::CurrentThread
$previousCulture = $currentThread.CurrentCulture
try {
  $currentThread.CurrentCulture = [Globalization.CultureInfo]::GetCultureInfo('fr-FR')
  foreach ($scriptPath in @('${escapedPaths.join("', '")}')) {
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { throw ($errors | Out-String) }
    $node = $ast.Find({
      param($candidate)
      $candidate -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $candidate.Name -eq 'Test-CanonicalUtcJsonTimestamp'
    }, $true)
    if (-not $node) { throw "Missing timestamp helper: $scriptPath" }
    Invoke-Expression $node.Extent.Text
    foreach ($case in $timestampCases) {
      $actual = Test-CanonicalUtcJsonTimestamp -Json ([string]$case.Json) -PropertyName 'createdAt'
      if ($actual -ne [bool]$case.Expected) {
        throw "Timestamp case '$($case.Label)' returned $actual in $scriptPath."
      }
    }
  }
}
finally {
  $currentThread.CurrentCulture = $previousCulture
}
Write-Output 'RELEASE_TIMESTAMP_CONTRACT_OK'
`;
    const encoded = Buffer.from(probe, "utf16le").toString("base64");
    const result = spawnSync(hostPowerShell, ["-NoProfile", "-EncodedCommand", encoded], {
      encoding: "utf8",
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status, output).toBe(0);
    expect(output).toContain("RELEASE_TIMESTAMP_CONTRACT_OK");
  });

  windowsTest("rejects unexpected or tampered front-profit template files before packaging", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "ec-template-allowlist-"));
    const outputRoot = join(sourceRoot, "release-output");
    const invokePackager = () =>
      spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(sourceRoot, "scripts/package-release.ps1"),
          "-OutputRoot",
          outputRoot,
          "-SkipImageExport",
        ],
        { encoding: "utf8" },
      );

    try {
      prepareMinimalReleaseSource(sourceRoot, "package-release.ps1");
      const unexpectedPath = join(sourceRoot, "templates/front-profit/unexpected.xlsx");
      writeFileSync(unexpectedPath, "unexpected", "utf8");
      const unexpected = invokePackager();
      const unexpectedOutput = `${unexpected.stdout ?? ""}${unexpected.stderr ?? ""}`;
      expect(unexpected.status, unexpectedOutput).not.toBe(0);
      expect(unexpectedOutput).toContain("Front-profit templates do not match the exact allowlist");

      rmSync(unexpectedPath, { force: true });
      const workbookPath = join(sourceRoot, "templates/front-profit", frontProfitWorkbookAllowlist[0]!);
      writeFileSync(workbookPath, Buffer.concat([readFileSync(workbookPath), Buffer.from("tampered")]));
      const tampered = invokePackager();
      const tamperedOutput = `${tampered.stdout ?? ""}${tampered.stderr ?? ""}`;
      expect(tampered.status, tamperedOutput).not.toBe(0);
      expect(tamperedOutput).toContain("Front-profit template SHA-256 mismatch");
      expect(findFiles(outputRoot, ".zip")).toHaveLength(0);
    } finally {
      rmSync(sourceRoot, { force: true, recursive: true });
    }
  }, 15_000);

  windowsTest("normalizes every staged shell script to UTF-8 without BOM and LF", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "ec-release-source-"));
    const expandedRoot = join(sourceRoot, "expanded");
    const outputRoot = mkdtempSync(join(tmpdir(), "ec-release-output-"));
    try {
      prepareMinimalReleaseSource(sourceRoot, "package-release.ps1");
      const roleExpected = Buffer.from(
        "#!/usr/bin/env bash\nprintf 'role \u2713'\nprintf 'tail'\n",
        "utf8",
      );
      writeFileSync(
        join(sourceRoot, "deploy/init-app-role.sh"),
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from("#!/usr/bin/env bash\r\nprintf 'role \u2713'\rprintf 'tail'\r\n", "utf8"),
        ]),
      );
      writeFileSync(
        join(sourceRoot, "deploy/setup.sh"),
        Buffer.from("#!/usr/bin/env bash\r\nprintf 'setup'\r\n", "utf8"),
      );

      const packageResult = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(sourceRoot, "scripts/package-release.ps1"),
          "-OutputRoot",
          outputRoot,
          "-SkipImageExport",
        ],
        { encoding: "utf8" },
      );
      const packageOutput = `${packageResult.stdout ?? ""}${packageResult.stderr ?? ""}`;
      expect(packageResult.status, packageOutput).toBe(0);

      const archives = findFiles(outputRoot, ".zip");
      expect(archives).toHaveLength(1);
      const expandResult = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `Expand-Archive -LiteralPath '${archives[0]!.replaceAll("'", "''")}' -DestinationPath '${expandedRoot.replaceAll("'", "''")}' -Force`,
        ],
        { encoding: "utf8" },
      );
      const expandOutput = `${expandResult.stdout ?? ""}${expandResult.stderr ?? ""}`;
      expect(expandResult.status, expandOutput).toBe(0);

      const shellScripts = findFiles(expandedRoot, ".sh");
      expect(shellScripts).toHaveLength(5);
      for (const shellScript of shellScripts) {
        const bytes = readFileSync(shellScript);
        expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), shellScript).toBe(false);
        expect(bytes.includes(Buffer.from("\r\n")), shellScript).toBe(false);
      }
      const packagedRole = shellScripts.find((path) => path.endsWith("init-app-role.sh"));
      expect(packagedRole).toBeDefined();
      expect(readFileSync(packagedRole!)).toEqual(roleExpected);
    } finally {
      rmSync(sourceRoot, { force: true, recursive: true });
      rmSync(outputRoot, { force: true, recursive: true });
    }
  }, 15_000);

  windowsTest("rejects invalid UTF-8 before Windows shell normalization rewrites content", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "ec-release-invalid-"));
    const outputRoot = mkdtempSync(join(tmpdir(), "ec-release-invalid-output-"));
    const validInput = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("#!/usr/bin/env bash\r\nprintf 'unchanged'\r\n", "utf8"),
    ]);
    try {
      prepareMinimalReleaseSource(sourceRoot, "package-release.ps1");
      const validPath = join(sourceRoot, "deploy/a-valid.sh");
      const invalidPath = join(sourceRoot, "deploy/z-invalid.sh");
      writeFileSync(validPath, validInput);
      writeFileSync(invalidPath, invalidUtf8);

      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(sourceRoot, "scripts/package-release.ps1"),
          "-OutputRoot",
          outputRoot,
          "-SkipImageExport",
        ],
        { encoding: "utf8" },
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      expect(result.status, output).not.toBe(0);
      expect(output).toContain("Shell script is not valid UTF-8");
      expect(output).toContain("z-invalid.sh");
      expect(readFileSync(validPath)).toEqual(validInput);
      expect(readFileSync(invalidPath)).toEqual(invalidUtf8);
    } finally {
      rmSync(sourceRoot, { force: true, recursive: true });
      rmSync(outputRoot, { force: true, recursive: true });
    }
  });

  windowsTest("validates every staged Windows shell script before writing any of them", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ec-windows-staged-"));
    const validPath = join(sandbox, "a-valid.sh");
    const invalidPath = join(sandbox, "z-invalid.sh");
    const validInput = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("#!/usr/bin/env bash\r\nprintf 'unchanged'\r\n", "utf8"),
    ]);
    try {
      writeFileSync(validPath, validInput);
      writeFileSync(invalidPath, invalidUtf8);
      const packagerPath = resolve(root, "scripts/package-release.ps1").replaceAll("'", "''");
      const stagedPath = sandbox.replaceAll("'", "''");
      const probe = `
$ErrorActionPreference = 'Stop'
$script:Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$script:StrictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${packagerPath}', [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
foreach ($functionName in @('Write-Utf8NoBom', 'Convert-StagedShellScriptsToUtf8Lf')) {
  $node = $ast.Find({
    param($candidate)
    $candidate -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $candidate.Name -eq $functionName
  }, $true)
  if (-not $node) { throw "Missing function: $functionName" }
  Invoke-Expression $node.Extent.Text
}
Convert-StagedShellScriptsToUtf8Lf '${stagedPath}'
`;
      const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", probe], {
        encoding: "utf8",
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      expect(result.status, output).not.toBe(0);
      expect(output).toContain("Shell script is not valid UTF-8");
      expect(output).toContain("z-invalid.sh");
      expect(readFileSync(validPath)).toEqual(validInput);
      expect(readFileSync(invalidPath)).toEqual(invalidUtf8);
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  });

  windowsBashTest("executes Bash normalization without changing valid UTF-8 content", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ec-bash-normalize-"));
    try {
      const targetRoot = join(sandbox, "target");
      mkdirSync(targetRoot, { recursive: true });
      const packager = readRoot("scripts/package-release.sh");
      const functionStart = packager.indexOf("normalize_staged_shell_scripts() {");
      const functionEnd = packager.indexOf("\nDIST_NAME=", functionStart);
      const harness = join(sandbox, "normalize.sh");
      writeFileSync(
        harness,
        `#!/usr/bin/env bash\nset -e\n${packager.slice(functionStart, functionEnd)}\nnormalize_staged_shell_scripts "$1"\n`,
        "utf8",
      );
      const input = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("#!/usr/bin/env bash\r\nprintf '\u89d2\u8272 \u2713'\rprintf 'tail'\r\n", "utf8"),
      ]);
      const expected = Buffer.from(
        "#!/usr/bin/env bash\nprintf '\u89d2\u8272 \u2713'\nprintf 'tail'\n",
        "utf8",
      );
      const shellPath = join(targetRoot, "valid.sh");
      writeFileSync(shellPath, input);

      const result = spawnSync(gitBash, [toGitBashPath(harness), toGitBashPath(targetRoot)], {
        encoding: "utf8",
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      expect(result.status, output).toBe(0);
      expect(readFileSync(shellPath)).toEqual(expected);
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  });

  windowsBashTest("rejects invalid UTF-8 in Bash packaging without Docker or staged rewrites", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "ec-bash-package-"));
    const releaseRoot = join(sourceRoot, "release-output");
    const validInput = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("#!/usr/bin/env bash\r\nprintf 'unchanged'\r\n", "utf8"),
    ]);
    try {
      prepareMinimalReleaseSource(sourceRoot, "package-release.sh");
      const validPath = join(sourceRoot, "deploy/a-valid.sh");
      const invalidPath = join(sourceRoot, "deploy/z-invalid.sh");
      writeFileSync(validPath, validInput);
      writeFileSync(invalidPath, invalidUtf8);

      const binRoot = join(sourceRoot, "test-bin");
      mkdirSync(binRoot);
      const dockerSentinel = join(binRoot, "docker");
      writeFileSync(dockerSentinel, "#!/usr/bin/env bash\necho DOCKER_CALLED >&2\nexit 99\n", "utf8");
      chmodSync(dockerSentinel, 0o755);
      const harness = join(sourceRoot, "scripts/run-package.sh");
      writeFileSync(
        harness,
        "#!/usr/bin/env bash\nset -e\nexport PATH=\"$1:$PATH\"\nexport RELEASE_ROOT=\"$2\"\nexport SKIP_IMAGE_EXPORT=1\nexec bash \"$3\"\n",
        "utf8",
      );

      const result = spawnSync(
        gitBash,
        [
          toGitBashPath(harness),
          toGitBashPath(binRoot),
          toGitBashPath(releaseRoot),
          toGitBashPath(join(sourceRoot, "scripts/package-release.sh")),
        ],
        { encoding: "utf8" },
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      expect(result.status, output).not.toBe(0);
      expect(output).toContain("Shell script is not valid UTF-8");
      expect(output).not.toContain("DOCKER_CALLED");
      expect(readFileSync(validPath)).toEqual(validInput);
      expect(readFileSync(invalidPath)).toEqual(invalidUtf8);
      const stagedValid = findFiles(releaseRoot, "a-valid.sh");
      const stagedInvalid = findFiles(releaseRoot, "z-invalid.sh");
      expect(stagedValid).toHaveLength(0);
      expect(stagedInvalid).toHaveLength(0);
    } finally {
      rmSync(sourceRoot, { force: true, recursive: true });
    }
  });

  windowsBashTest("preserves the previous Bash ZIP when post-extraction audit is injected to fail", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "ec-bash-atomic-"));
    const releaseRoot = join(sourceRoot, "release-output");
    const binRoot = join(sourceRoot, "fake-bin");
    const previousZip = join(releaseRoot, "ec-data-platform-20990101.zip");
    const previousBytes = Buffer.from("previous-valid-archive", "utf8");
    try {
      prepareMinimalReleaseSource(sourceRoot, "package-release.sh");
      mkdirSync(releaseRoot, { recursive: true });
      mkdirSync(binRoot);
      writeFileSync(previousZip, previousBytes);
      const fakeDate = join(binRoot, "date");
      const fakePowerShell = join(binRoot, "powershell.exe");
      writeFileSync(fakeDate, "#!/usr/bin/env bash\necho 20990101\n", "utf8");
      writeFileSync(
        fakePowerShell,
        `#!/usr/bin/env bash
if [ -f "$PACKAGE_POWERSHELL_STATE" ]; then
  echo INJECTED_POST_EXTRACTION_FAILURE >&2
  exit 91
fi
: > "$PACKAGE_POWERSHELL_STATE"
exec /c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe "$@"
`,
        "utf8",
      );
      chmodSync(fakeDate, 0o755);
      chmodSync(fakePowerShell, 0o755);
      const harness = join(sourceRoot, "scripts/run-atomic-failure.sh");
      writeFileSync(
        harness,
        "#!/usr/bin/env bash\nset -e\nexport PATH=\"$1:$PATH\"\nexport RELEASE_ROOT=\"$2\"\nexport SKIP_IMAGE_EXPORT=1\nexec bash \"$3\"\n",
        "utf8",
      );

      const result = spawnSync(
        gitBash,
        [
          toGitBashPath(harness),
          toGitBashPath(binRoot),
          toGitBashPath(releaseRoot),
          toGitBashPath(join(sourceRoot, "scripts/package-release.sh")),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PACKAGE_POWERSHELL_STATE: toGitBashPath(join(sourceRoot, "powershell.called")),
          },
        },
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.status, output).not.toBe(0);
      expect(output).toContain("INJECTED_POST_EXTRACTION_FAILURE");
      expect(readFileSync(previousZip)).toEqual(previousBytes);
      expect(readdirSync(releaseRoot).sort()).toEqual(["ec-data-platform-20990101.zip"]);
    } finally {
      rmSync(sourceRoot, { force: true, recursive: true });
    }
  }, 60_000);

  test("provides isolated release verification with guaranteed cleanup", () => {
    const script = readRoot("scripts/verify-release.ps1");

    expect(script).toContain("function Get-FreeTcpPort");
    expect(script).toContain("[System.Text.UTF8Encoding]::new($false)");
    expect(script).toContain("[Guid]::NewGuid()");
    expect(script).toContain("docker compose --env-file .env -f docker-compose.yml -p $project");
    expect(script).toContain("POSTGRES_CONTAINER_NAME=${project}-postgres");
    expect(script).toContain("MIGRATE_CONTAINER_NAME=${project}-migrate");
    expect(script).toContain("WEB_CONTAINER_NAME=${project}-web");
    expect(script).toContain("rolcanlogin");
    expect(script).toContain("rolsuper");
    expect(script).toContain("/api/health");
    expect(script).toContain("/api/auth/login");
    expect(script).toContain("/api/modules");
    expect(script).toContain("/api/board/charts");
    expect(script).toContain("/api/board/dashboards");
    expect(script).toContain("Join-Path $releaseRoot 'backup.ps1'");
    expect(script).toContain("Join-Path $releaseRoot 'restore.ps1'");
    expect(script).toContain("function Invoke-InstanceOperatorScript");
    expect(script.match(/Invoke-InstanceOperatorScript `/g)).toHaveLength(2);
    expect(script).toContain("$_.Name -like 'COMPOSE_*' -or $_.Name -like 'DOCKER_*'");
    expect(script).toContain("Restore-ProcessEnvironment -Snapshot $snapshot");
    expect(script).toContain("INSTANCE_ID=$project");
    expect(script).toContain("Backup restore did not recover the module, dashboard, and renderable chart.");
    expect(script).toContain("StatusCode");
    expect(script).toContain("@($modules.data).Count");
    expect(script).toContain("@('down', '-v', '--remove-orphans')");
    expect(script).toContain("Remove-Item -LiteralPath $tempRoot -Recurse -Force");
  });

  powerShellTest("clears process Docker overrides only while instance operator scripts run", () => {
    const verifierPath = resolve(root, "scripts/verify-release.ps1").replaceAll("'", "''");
    const probe = `
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${verifierPath}', [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
foreach ($functionName in @('Save-ProcessEnvironment', 'Restore-ProcessEnvironment', 'Invoke-InstanceOperatorScript')) {
  $node = $ast.Find({
    param($candidate)
    $candidate -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $candidate.Name -eq $functionName
  }, $true)
  if (-not $node) { throw "Missing function: $functionName" }
  Invoke-Expression $node.Extent.Text
}
$env:COMPOSE_PROJECT_NAME = 'probe-project'
$env:DOCKER_HOST = 'probe-host'
$env:KEEP_FOR_OPERATOR_PROBE = 'preserved'
$failedAsPlanned = $false
try {
  Invoke-InstanceOperatorScript -Path 'unused' -Arguments @() -Invoker {
    param($scriptPath, $scriptArguments)
    if (Test-Path Env:COMPOSE_PROJECT_NAME) { throw 'COMPOSE_PROJECT_NAME leaked into operator child.' }
    if (Test-Path Env:DOCKER_HOST) { throw 'DOCKER_HOST leaked into operator child.' }
    if ($env:KEEP_FOR_OPERATOR_PROBE -ne 'preserved') { throw 'Unrelated environment was changed.' }
    throw 'EXPECTED_OPERATOR_PROBE_FAILURE'
  }
}
catch {
  if ($_.Exception.Message -ne 'EXPECTED_OPERATOR_PROBE_FAILURE') { throw }
  $failedAsPlanned = $true
}
if (-not $failedAsPlanned) { throw 'Operator probe did not run.' }
if ($env:COMPOSE_PROJECT_NAME -ne 'probe-project') { throw 'COMPOSE_PROJECT_NAME was not restored.' }
if ($env:DOCKER_HOST -ne 'probe-host') { throw 'DOCKER_HOST was not restored.' }
if ($env:KEEP_FOR_OPERATOR_PROBE -ne 'preserved') { throw 'Unrelated environment changed after operator invocation.' }
Write-Output 'INSTANCE_OPERATOR_ENV_OK'
`;
    const result = spawnSync(hostPowerShell, ["-NoProfile", "-Command", probe], { encoding: "utf8" });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("INSTANCE_OPERATOR_ENV_OK");
  });

  test("uses random acceptance credentials and loopback-only published ports", () => {
    const script = readRoot("scripts/verify-release.ps1");
    const seed = readRoot("apps/api/scripts/seed.ts");
    const compose = readRoot("deploy/docker-compose.yml");
    const envExample = readRoot("deploy/.env.example");

    expect(script).toContain("function New-CryptoSecret");
    expect(script).toContain("[Security.Cryptography.RandomNumberGenerator]::Create()");
    expect(script).toContain("$postgresPassword = New-CryptoSecret");
    expect(script).toContain("$appDbPassword = New-CryptoSecret");
    expect(script).toContain("$jwtSecret = New-CryptoSecret");
    expect(script).toContain("$adminPassword = New-CryptoSecret");
    expect(script).not.toContain("acceptance_super_password");
    expect(script).not.toContain("acceptance_app_password");
    expect(script).toContain("POSTGRES_HOST_PORT=127.0.0.1:$($ports.POSTGRES_HOST_PORT)");
    expect(script).toContain("REDIS_HOST_PORT=127.0.0.1:$($ports.REDIS_HOST_PORT)");
    expect(script).toContain("API_HOST_PORT=127.0.0.1:$($ports.API_HOST_PORT)");
    expect(script).toContain("WEB_HOST_PORT=127.0.0.1:$($ports.WEB_HOST_PORT)");
    expect(seed).toContain('const adminPassword = process.env.ADMIN_PASSWORD?.trim();');
    expect(seed).toContain('throw new Error("ADMIN_PASSWORD is required")');
    expect(seed).not.toContain("123456");
    expect(seed).toContain("bcrypt.hash(adminPassword, 10)");
    expect(seed).not.toContain("(admin / 123456)");
    expect(seed).toContain("读取已上传的竞品标题、价格、评论摘要和卖点数据");
    expect(seed).not.toContain("抓取详情页 + 评论 + 价格");
    expect(seed).toContain(".update(agents)");
    expect(seed).toContain("description: a.description");
    expect(compose).toContain("ADMIN_PASSWORD: ${ADMIN_PASSWORD:?Set ADMIN_PASSWORD in deploy/.env}");
    expect(envExample).toContain("ADMIN_PASSWORD=change_me_admin_password");
    expect(script).toContain("ADMIN_PASSWORD=$AdminPassword");
    expect(script).not.toContain("function Set-AdminPassword");
    expect(script).not.toContain("Set-AdminPassword -Project");
    expect(script).toContain("password = $adminPassword");
  });

  test("documents ADMIN_PASSWORD as the first-login credential", () => {
    const guide = readRoot("docs/部署指南.md");
    const loginPage = readRoot("apps/web/src/pages/login/index.tsx");

    expect(guide).toContain("密码：使用 `deploy/.env` 中设置的 `ADMIN_PASSWORD`");
    expect(guide).toContain("必须显式设置 `ADMIN_PASSWORD`");
    expect(guide).not.toContain("123456");
    expect(loginPage).not.toContain("123456");
    expect(loginPage).toContain('useState("")');
    expect(loginPage).toContain("密码由部署者设置");
  });

  test("keeps the bootstrap fallback inside the two-schema security model", () => {
    const bootstrap = readRoot("deploy/bootstrap-app-role.sql");
    const envExample = readRoot("deploy/.env.example");

    expect(bootstrap).toContain("REVOKE CREATE ON SCHEMA public FROM ec_app");
    expect(bootstrap).toContain("CREATE SCHEMA IF NOT EXISTS user_data");
    expect(bootstrap).toContain("GRANT USAGE, CREATE ON SCHEMA user_data TO ec_app");
    expect(bootstrap).toContain("ALTER ROLE ec_app SET search_path TO public, user_data");
    expect(bootstrap).not.toMatch(/GRANT\s+(?:USAGE\s*,\s*)?CREATE\s+ON\s+SCHEMA\s+public\s+TO\s+ec_app/i);
    expect(bootstrap).not.toMatch(/ALTER\s+(?:TABLE|SEQUENCE)[\s\S]+OWNER\s+TO\s+ec_app/i);
    expect(bootstrap).not.toMatch(/GRANT[\s\S]+ON\s+ALL\s+(?:TABLES|SEQUENCES)\s+IN\s+SCHEMA\s+public/i);
    expect(bootstrap).not.toContain("ec_app_2026");
    expect(envExample).toContain("one-shot `migrate` service");
    expect(envExample).toContain("search_path is public,user_data");
    expect(envExample).not.toContain("bootstrap-app-role.sql");
  });

  test("retries only port-allocation failures with isolated cleanup between attempts", () => {
    const script = readRoot("scripts/verify-release.ps1");
    const retryLoop = script.slice(
      script.indexOf("for ($attempt = 1; $attempt -le $MaxStartAttempts; $attempt++)"),
      script.indexOf("$apiBase ="),
    );

    expect(script).toContain("[Net.IPAddress]::Any");
    expect(script).toContain("$MaxStartAttempts = 3");
    expect(script).toContain("function Test-PortAllocationFailure");
    expect(script).toContain("function Start-IsolatedCompose");
    expect(script).toMatch(/port is already allocated|ports are not available/);
    expect(script).toContain("if (-not (Test-PortAllocationFailure $message))");
    expect(retryLoop.indexOf("Write-AcceptanceEnvironment")).toBeLessThan(
      retryLoop.indexOf("Start-IsolatedCompose"),
    );
    expect(retryLoop).toContain("Invoke-IsolatedDown -Project $project -DeployRoot $deployRoot");
    expect(retryLoop.indexOf("Invoke-IsolatedDown")).toBeLessThan(retryLoop.indexOf("continue"));
  });

  test("routes native stderr capture through a locally scoped PowerShell 5.1 helper", () => {
    const script = readRoot("scripts/verify-release.ps1");

    expect(script).toContain("function Invoke-NativeCapture");
    expect(script).toContain("$previousErrorActionPreference = $ErrorActionPreference");
    expect(script).toContain("$ErrorActionPreference = 'Continue'");
    expect(script).toContain("$ErrorActionPreference = $previousErrorActionPreference");
    expect(script).toContain("Invoke-NativeCapture -File docker");
    expect(script.match(/2>&1/g)).toHaveLength(1);
  });

  windowsTest("classifies captured native stderr under Windows PowerShell 5.1", () => {
    const verifierPath = resolve(root, "scripts/verify-release.ps1").replaceAll("'", "''");
    const probe = `
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${verifierPath}', [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
foreach ($functionName in @('Invoke-NativeCapture', 'Test-PortAllocationFailure', 'Start-IsolatedCompose', 'Get-DockerImageId')) {
  $node = $ast.Find({
    param($candidate)
    $candidate -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $candidate.Name -eq $functionName
  }, $true)
  if (-not $node) { throw "Missing function: $functionName" }
  Invoke-Expression $node.Extent.Text
}

$portCapture = Invoke-NativeCapture -File $env:ComSpec -Arguments @('/d', '/c', 'echo port is already allocated 1>&2 & exit /b 23')
if ($ErrorActionPreference -ne 'Stop') { throw 'ErrorActionPreference was not restored.' }
if ($portCapture.ExitCode -ne 23) { throw "Unexpected port exit: $($portCapture.ExitCode)" }
$started = Start-IsolatedCompose -Project 'probe' -Capture { param($file, $arguments) $portCapture }
if ($started -ne $false) { throw 'Port conflict was not classified for retry.' }

$missingCapture = Invoke-NativeCapture -File $env:ComSpec -Arguments @('/d', '/c', 'echo Error response from daemon: No such image: probe 1>&2 & exit /b 1')
$missingId = Get-DockerImageId -Image 'probe:missing' -Capture { param($file, $arguments) $missingCapture }
if ($null -ne $missingId) { throw 'Absent image did not return null.' }

$otherCapture = Invoke-NativeCapture -File $env:ComSpec -Arguments @('/d', '/c', 'echo authentication failed 1>&2 & exit /b 7')
$threw = $false
try {
  Start-IsolatedCompose -Project 'probe' -Capture { param($file, $arguments) $otherCapture } | Out-Null
}
catch {
  if ($_.Exception.Message -notmatch 'authentication failed') { throw }
  $threw = $true
}
if (-not $threw) { throw 'Non-port compose failure was hidden.' }
Write-Output 'PS51_NATIVE_CAPTURE_OK'
`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", probe], {
      encoding: "utf8",
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("PS51_NATIVE_CAPTURE_OK");
  });

  test("restores the exact pre-verification Docker image tag state during cleanup", () => {
    const script = readRoot("scripts/verify-release.ps1");
    const finalCleanup = script.slice(script.lastIndexOf("finally {"));

    expect(script).toContain("function Get-DockerImageId");
    expect(script).toContain("function Save-ImageTagState");
    expect(script).toContain("function Restore-ImageTags");
    expect(script).toContain("Invoke-Native docker @('image', 'tag', $beforeId, $image)");
    expect(script).toContain("Invoke-Native docker @('image', 'rm', $image)");
    expect(finalCleanup).toContain("Invoke-IsolatedDown -Project $project -DeployRoot $deployRoot");
    expect(finalCleanup).toContain("Restore-ImageTags -Snapshot $imageSnapshot -Images $images");
    expect(finalCleanup).toContain("Remove-Item -LiteralPath $tempRoot -Recurse -Force");
    expect(finalCleanup.indexOf("Invoke-IsolatedDown")).toBeLessThan(finalCleanup.indexOf("Restore-ImageTags"));
    expect(finalCleanup.indexOf("Restore-ImageTags")).toBeLessThan(finalCleanup.indexOf("Remove-Item"));
    expect(finalCleanup).toContain("$cleanupFailures.Add");
  });

  windowsTest("rejects a missing release archive before attempting path resolution", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ec-release-missing-"));
    const missingArchive = join(sandbox, "missing.zip");
    try {
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          resolve(root, "scripts/verify-release.ps1"),
          "-ArchivePath",
          missingArchive,
        ],
        { encoding: "utf8" },
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      const script = readRoot("scripts/verify-release.ps1");
      const existenceCheck = "Test-Path -LiteralPath $ArchivePath -PathType Leaf";
      const resolution = "Resolve-Path -LiteralPath $ArchivePath";

      expect(result.status).not.toBe(0);
      expect(output).toContain(`Release archive was not found: ${missingArchive}`);
      expect(script.indexOf(existenceCheck)).toBeGreaterThanOrEqual(0);
      expect(script.indexOf(existenceCheck)).toBeLessThan(script.indexOf(resolution));
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  });

  test("audits environment filenames case-insensitively in both packagers", () => {
    const powerShell = readRoot("scripts/package-release.ps1");
    const bash = readRoot("scripts/package-release.sh");

    expect(powerShell).toContain("$lowerName = $_.Name.ToLowerInvariant()");
    expect(powerShell).toContain("$lowerName -like '.env.*'");
    expect(powerShell).toContain("$lowerName -like '*.env'");
    expect(bash).toMatch(/case "\$lower_name" in\s+\.env\.example\)/);
    expect(bash).toMatch(/\.env\|\.env\.\*\|\*\.env\)/);
  });

  windowsTest("rejects a filesystem root as the Windows output root", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ec-release-unsafe-"));
    const unsafeRoot = resolve(sandbox).slice(0, 3);
    try {
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          resolve(root, "scripts/package-release.ps1"),
          "-OutputRoot",
          unsafeRoot,
          "-SkipImageExport",
        ],
        { encoding: "utf8" },
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      expect([
        result.status === 0,
        output.includes("OutputRoot cannot be a filesystem root"),
      ]).toEqual([false, true]);
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  });

  test("uses stable images and overridable host resources", () => {
    const compose = readRoot("deploy/docker-compose.yml");
    const envExample = readRoot("deploy/.env.example");
    const verifier = readRoot("scripts/verify-release.ps1");

    expect(compose).toContain("image: deploy-api:latest");
    expect(compose).toContain("image: deploy-web:latest");
    expect(compose).toContain('${POSTGRES_HOST_PORT:-127.0.0.1:5432}:5432');
    expect(compose).toContain('${REDIS_HOST_PORT:-127.0.0.1:6379}:6379');
    expect(compose).toContain('${API_HOST_PORT:-127.0.0.1:4000}:4000');
    expect(compose).toContain('${WEB_HOST_PORT:-127.0.0.1:3997}:80');
    expect(envExample).toContain("# POSTGRES_HOST_PORT=127.0.0.1:5432");
    expect(envExample).toContain("# WEB_HOST_PORT=127.0.0.1:3997");
    expect(compose).toContain('test: ["CMD", "redis-cli", "PING"]');
    expect(compose).toMatch(/redis:\s+condition: service_healthy/);
    expect(compose).toContain('${POSTGRES_CONTAINER_NAME:-ec-data-postgres}');
    expect(compose).toContain('${REDIS_CONTAINER_NAME:-ec-data-redis}');
    expect(compose).toContain('${MIGRATE_CONTAINER_NAME:-ec-data-migrate}');
    expect(compose).toContain('${API_CONTAINER_NAME:-ec-data-api}');
    expect(compose).toContain('${WEB_CONTAINER_NAME:-ec-data-web}');
    expect(envExample).toContain("# MIGRATE_CONTAINER_NAME=ec-data-migrate");
    expect(verifier).toContain("MIGRATE_CONTAINER_NAME=${project}-migrate");
  });

  test("keeps the long-lived Web proxy attached to Docker DNS and healthy API startup", () => {
    const compose = readRoot("deploy/docker-compose.yml");
    const nginx = readRoot("apps/web/nginx.conf");
    const webService = compose.match(/\n  web:\r?\n([^]*?)\nvolumes:/)?.[1];

    expect(webService).toBeDefined();
    expect(webService).toMatch(/api:\s+condition: service_healthy/);
    expect(nginx).toContain("resolver 127.0.0.11");
    expect(nginx).toContain("set $api_upstream api:4000;");
    expect(nginx).toContain("proxy_pass http://$api_upstream;");
    expect(nginx).not.toContain("proxy_pass http://$api_upstream/api/;");
    expect(nginx).not.toContain("proxy_pass http://api:4000/api/;");
  });

  dockerComposeTest("resolves every default published port to loopback only", () => {
    const cleanEnvironment = { ...process.env };
    for (const name of [
      "POSTGRES_HOST_PORT",
      "REDIS_HOST_PORT",
      "API_HOST_PORT",
      "WEB_HOST_PORT",
    ]) {
      delete cleanEnvironment[name];
    }
    const result = spawnSync(
      "docker",
      [
        "compose",
        "--env-file",
        resolve(root, "deploy/.env.example"),
        "-f",
        resolve(root, "deploy/docker-compose.yml"),
        "config",
        "--format",
        "json",
      ],
      { encoding: "utf8", env: cleanEnvironment },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status, output).toBe(0);
    const config = JSON.parse(result.stdout) as {
      services: Record<string, {
        ports?: Array<{ host_ip?: string; published?: string; target?: number }>;
        pull_policy?: string;
      }>;
    };
    const expectedPorts = {
      postgres: ["5432", 5432],
      redis: ["6379", 6379],
      api: ["4000", 4000],
      web: ["3997", 80],
    } as const;
    for (const [service, [published, target]] of Object.entries(expectedPorts)) {
      expect(config.services[service]?.ports).toEqual([
        expect.objectContaining({ host_ip: "127.0.0.1", published, target }),
      ]);
    }
    for (const service of ["postgres", "redis", "migrate", "api", "web"]) {
      expect(config.services[service]?.pull_policy).toBe("never");
    }
  });

  test("documents a project name for isolated parallel deployments", () => {
    const envExample = readRoot("deploy/.env.example");
    const guide = readRoot("docs/部署指南.md");

    expect(envExample).toContain("# COMPOSE_PROJECT_NAME=ec-data-platform-parallel");
    expect(guide).toContain("COMPOSE_PROJECT_NAME=ec-data-platform-parallel");
    expect(guide).toContain("MIGRATE_CONTAINER_NAME=ec-data-parallel-migrate");
    expect(guide).toContain('docker compose --project-name "$COMPOSE_PROJECT_NAME" down -v');
  });

  test("documents the one-shot migration and portable release commands", () => {
    const guide = readRoot("docs/部署指南.md");

    expect(guide).toContain("one-shot `migrate`");
    expect(guide).toContain("`search_path` 固定为 `public,user_data`");
    expect(guide).toContain("docker compose ps -a migrate");
    expect(guide).toContain("Exited (0)");
    expect(guide).toContain("pwsh -NoProfile -File scripts/package-release.ps1");
    expect(guide).toContain("Release ZIP: <当前仓库>\\release\\ec-data-platform-YYYYMMDD.zip");
    expect(guide).toContain("pwsh -NoProfile -File scripts/verify-release.ps1");
    expect(guide).toContain("front-profit user-module creation, rendered chart(s), dashboard, and backup/restore recovery.");
  });

  test("uses an explicit release root when packaging", () => {
    const script = readRoot("scripts/package-release.sh");
    const guide = readRoot("docs/部署指南.md");

    expect(script).toContain('DEFAULT_RELEASE_ROOT="${PROJECT_ROOT}/release"');
    expect(script).toContain('RELEASE_ROOT="${RELEASE_ROOT:-$DEFAULT_RELEASE_ROOT}"');
    expect(script).toContain('mkdir -p "$RELEASE_ROOT"');
    expect(guide).toContain('export RELEASE_ROOT="/path/to/output"');
  });

  test("provides a clean Git-bundle development handoff with optional database backup", () => {
    const script = readRoot("scripts/package-development-handoff.ps1");
    const guide = readRoot("docs/TECHNICAL_OVERVIEW.md");

    expect(script).toContain("Invoke-Native git @('-C', $RepoRoot, 'bundle', 'create'");
    expect(script).toContain("'fsck', '--full'");
    expect(script).toContain("Refusing to create a development handoff from a dirty worktree");
    expect(script).toContain("Current HEAD");
    expect(script).toContain("[switch]$IncludeDatabaseBackup");
    expect(script).toContain("'pg_dump'");
    expect(script).toContain("'--no-owner', '--no-acl'");
    expect(script).toContain("& $File @Arguments *> $null");
    expect(script).toContain("$ErrorActionPreference = 'Continue'");
    expect(script).toContain("$ErrorActionPreference = $previous");
    expect(script).toContain("docker inspect --format '{{.State.Running}}'");
    expect(script).not.toContain("Invoke-Native docker @('inspect'");
    expect(script).toContain("development-handoff-manifest.json");
    expect(guide).toContain("package-development-handoff.ps1");
    expect(guide).toContain("-IncludeDatabaseBackup");
    expect(guide).toContain("不能互相替代");
  });

  test("keeps container shell entrypoints on LF line endings", () => {
    const attributes = readRoot(".gitattributes");
    expect(attributes).toContain("*.sh text eol=lf");
  });
});
