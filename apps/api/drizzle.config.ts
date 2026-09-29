import { config } from "dotenv";
import path from "node:path";
import { defineConfig } from "drizzle-kit";

// drizzle-kit 跑时 cwd 是 apps/api，根 .env 在 ../../
config({ path: path.resolve(process.cwd(), "../../.env") });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
