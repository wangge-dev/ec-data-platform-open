const RUNTIME_SECRET_NAMES = [
  "POSTGRES_PASSWORD",
  "APP_DB_PASSWORD",
  "ADMIN_PASSWORD",
  "JWT_SECRET",
] as const;

type RuntimeSecretName = (typeof RUNTIME_SECRET_NAMES)[number];
export type RuntimeSecrets = Record<RuntimeSecretName, string | undefined>;

const minimumLength: Record<RuntimeSecretName, number> = {
  POSTGRES_PASSWORD: 12,
  APP_DB_PASSWORD: 12,
  ADMIN_PASSWORD: 12,
  JWT_SECRET: 32,
};
const safeSecretPattern = /^[A-Za-z0-9._~!%*+,:?@^/=&-]+$/;
const databaseSecretPattern = /^[A-Za-z0-9._~-]+$/;

export class RuntimeSecretConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeSecretConfigurationError";
  }
}

export function validateRuntimeSecrets(secrets: RuntimeSecrets): void {
  for (const name of RUNTIME_SECRET_NAMES) {
    const value = secrets[name];
    if (
      !value
      || value.startsWith("change_me")
      || value.length < minimumLength[name]
      || !safeSecretPattern.test(value)
    ) {
      throw new RuntimeSecretConfigurationError(
        `${name} must be a non-placeholder ASCII token of at least ${minimumLength[name]} characters`,
      );
    }
    if (
      (name === "POSTGRES_PASSWORD" || name === "APP_DB_PASSWORD")
      && !databaseSecretPattern.test(value)
    ) {
      throw new RuntimeSecretConfigurationError(
        `${name} must be safe for direct embedding in a PostgreSQL URI`,
      );
    }
  }

  if (new Set(RUNTIME_SECRET_NAMES.map((name) => secrets[name])).size !== RUNTIME_SECRET_NAMES.length) {
    throw new RuntimeSecretConfigurationError("runtime secrets must use four different values");
  }
}

export function validateRuntimeEnvironment(environment: NodeJS.ProcessEnv): void {
  validateRuntimeSecrets({
    POSTGRES_PASSWORD: environment.POSTGRES_PASSWORD,
    APP_DB_PASSWORD: environment.APP_DB_PASSWORD,
    ADMIN_PASSWORD: environment.ADMIN_PASSWORD,
    JWT_SECRET: environment.JWT_SECRET,
  });
}
