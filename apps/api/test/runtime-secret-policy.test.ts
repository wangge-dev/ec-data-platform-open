import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  RuntimeSecretConfigurationError,
  validateRuntimeSecrets,
} from "../src/lib/runtime-secrets.js";

const validSecrets = {
  POSTGRES_PASSWORD: "unique-postgres-password",
  APP_DB_PASSWORD: "unique-app-db-password",
  ADMIN_PASSWORD: "unique-admin-password",
  JWT_SECRET: "unique-jwt-secret-that-is-longer-than-thirty-two-characters",
};

describe("source runtime secret policy", () => {
  test("accepts the same strong, unique secret contract as the release launchers", () => {
    expect(() => validateRuntimeSecrets(validSecrets)).not.toThrow();
  });

  test.each([
    ["placeholder", { ...validSecrets, ADMIN_PASSWORD: "change_me_admin_password" }],
    ["short value", { ...validSecrets, POSTGRES_PASSWORD: "too-short" }],
    ["URI-unsafe database value", { ...validSecrets, APP_DB_PASSWORD: "unsafe/password-value" }],
    ["duplicate value", { ...validSecrets, ADMIN_PASSWORD: validSecrets.POSTGRES_PASSWORD }],
  ])("rejects %s without exposing a supplied secret", (_label, secrets) => {
    let thrown: unknown;
    try {
      validateRuntimeSecrets(secrets);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RuntimeSecretConfigurationError);
    const message = String(thrown);
    for (const value of Object.values(secrets)) expect(message).not.toContain(value);
  });

  test("makes migration a source-compose startup preflight for all four secrets", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const compose = readFileSync(resolve(root, "deploy/docker-compose.yml"), "utf8");
    const migration = readFileSync(resolve(root, "apps/api/scripts/migrate.ts"), "utf8");
    const migrateBlock = compose.slice(compose.indexOf("  migrate:"), compose.indexOf("\n  api:"));

    for (const name of Object.keys(validSecrets)) expect(migrateBlock).toContain(`${name}:`);
    expect(migration).toContain("validateRuntimeEnvironment(process.env)");
  });

  test("Codespaces supplies complete runtime secrets matching its existing database credentials", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const compose = readFileSync(resolve(root, ".devcontainer/docker-compose.yml"), "utf8");
    const workspace = compose.slice(compose.indexOf("  workspace:"), compose.indexOf("\n  postgres:"));
    const value = (name: string) => workspace.match(new RegExp(`^\\s+${name}: (.+)$`, "m"))?.[1].trim();
    const secrets = {
      POSTGRES_PASSWORD: value("POSTGRES_PASSWORD"), APP_DB_PASSWORD: value("APP_DB_PASSWORD"),
      ADMIN_PASSWORD: value("ADMIN_PASSWORD"), JWT_SECRET: value("JWT_SECRET"),
    };
    expect(() => validateRuntimeSecrets(secrets)).not.toThrow();
    expect(value("DATABASE_URL")).toContain(`ec_app:${secrets.APP_DB_PASSWORD}@postgres`);
    expect(value("MIGRATION_DATABASE_URL")).toContain(`ec:${secrets.POSTGRES_PASSWORD}@postgres`);
    const database = compose.slice(compose.indexOf("\n  postgres:"));
    expect(database).toContain(`POSTGRES_PASSWORD: ${secrets.POSTGRES_PASSWORD}`);
    expect(database).toContain(`APP_DB_PASSWORD: ${secrets.APP_DB_PASSWORD}`);
  });
});
