type DatabaseEnvironment = { TEST_DATABASE_URL?: string; DATABASE_URL?: string };

function databaseIdentity(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid PostgreSQL test database configuration"); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length <= 1) {
    throw new Error("A PostgreSQL database name and host are required for database tests");
  }
  // Connection routing parameters can override the endpoint being compared.
  for (const key of url.searchParams.keys()) {
    if (['host', 'hostaddr', 'port', 'dbname', 'database', 'service'].includes(key.toLowerCase())) {
      throw new Error("Database tests must specify the endpoint in the URL authority and path");
    }
  }
  let host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (['localhost', '127.0.0.1', '::1'].includes(host)) host = 'loopback';
  let name: string;
  try { name = decodeURIComponent(url.pathname.slice(1)); } catch { throw new Error("Invalid database name encoding"); }
  return JSON.stringify([host, url.port || '5432', name]);
}

/** Validate before creating a client; credentials never appear in errors. */
export function resolveIsolatedTestDatabase(env: DatabaseEnvironment, required = false): string | undefined {
  const testUrl = env.TEST_DATABASE_URL?.trim();
  if (!testUrl) {
    if (required) throw new Error("RUN_DB_TESTS=1 requires an explicit isolated TEST_DATABASE_URL; DATABASE_URL is never used as a fallback");
    return undefined;
  }
  const identity = databaseIdentity(testUrl);
  const applicationUrl = env.DATABASE_URL?.trim();
  if (applicationUrl && identity === databaseIdentity(applicationUrl)) {
    throw new Error("TEST_DATABASE_URL must identify a different database from DATABASE_URL");
  }
  return testUrl;
}
