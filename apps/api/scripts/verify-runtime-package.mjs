import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(process.argv[2] ?? path.join(scriptDirectory, ".."));
const requireFromRuntime = createRequire(path.join(packageRoot, "package.json"));

function fail(message) {
  throw new Error(`API runtime package gate failed: ${message}`);
}

for (const dependency of ["xlsx", "tsx", "postgres"]) {
  try {
    requireFromRuntime.resolve(dependency);
  } catch {
    fail(`required production dependency is missing: ${dependency}`);
  }
}

for (const dependency of [
  "vite",
  "vitest",
  "drizzle-kit",
  "typescript",
  "postcss",
  "nanoid",
  "react",
  "react-dom",
  "echarts",
]) {
  try {
    requireFromRuntime.resolve(dependency);
    fail(`development/Web dependency is resolvable: ${dependency}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("API runtime package gate failed:")) {
      throw error;
    }
  }
}

for (const required of [
  "src/index.ts",
  "src/modules/orders.json",
  "src/modules/orders.transform.ts",
  "extensions/connectors/warehouse-postgres.example.json",
  "extensions/modules/example-sales.module.json",
  "extensions/solutions/ecommerce-starter.solution.json",
  "scripts/migrate.ts",
  "scripts/migration-schema.ts",
  "scripts/seed.ts",
  "scripts/demo-maintenance.ts",
  "drizzle/meta/_journal.json",
  "docker-entrypoint.sh",
]) {
  if (!existsSync(path.join(packageRoot, required))) {
    fail(`required runtime path is missing: ${required}`);
  }
}

for (const forbidden of [
  "test",
  "scripts/seed-demo.ts",
  "scripts/test-chaos.mts",
  "scripts/e2e-etl-truncate.mts",
  "../web",
]) {
  if (existsSync(path.resolve(packageRoot, forbidden))) {
    fail(`forbidden runtime path is present: ${forbidden}`);
  }
}

console.log("Verified minimal API runtime package: production dependencies and files only");
