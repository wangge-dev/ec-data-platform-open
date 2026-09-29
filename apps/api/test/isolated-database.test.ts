import { describe, expect, test } from 'vitest';
import { resolveIsolatedTestDatabase } from './helpers/isolated-database.js';

const application = 'postgres://app:synthetic-password@localhost/production';

describe('isolated database test configuration', () => {
  test('does not fall back to the application database', () => {
    expect(resolveIsolatedTestDatabase({ DATABASE_URL: application })).toBeUndefined();
    expect(() => resolveIsolatedTestDatabase({ DATABASE_URL: application }, true)).toThrow('explicit isolated TEST_DATABASE_URL');
  });
  test('rejects an explicitly enabled run with a blank test URL', () => {
    expect(() => resolveIsolatedTestDatabase({ TEST_DATABASE_URL: '  ' }, true)).toThrow('explicit isolated TEST_DATABASE_URL');
  });
  test.each([
    application,
    'postgresql://other:other-password@127.0.0.1:5432/production',
    'postgres://other:other-password@[::1]:5432/%70roduction?sslmode=disable',
  ])('rejects the application database even when credentials or URL spelling differ', (testUrl) => {
    expect(() => resolveIsolatedTestDatabase({ DATABASE_URL: application, TEST_DATABASE_URL: testUrl }, true)).toThrow('different database');
  });
  test.each([
    'postgres://test:synthetic@localhost/test_database',
    'postgres://test:synthetic@127.0.0.1:55499/production',
  ])('accepts an explicitly isolated database endpoint', (testUrl) => {
    expect(resolveIsolatedTestDatabase({ DATABASE_URL: application, TEST_DATABASE_URL: testUrl }, true)).toBe(testUrl);
  });
  test('accepts the CI test-only URL without an application URL', () => {
    const testUrl = 'postgres://test:synthetic@127.0.0.1:5432/ci_database';
    expect(resolveIsolatedTestDatabase({ TEST_DATABASE_URL: testUrl }, true)).toBe(testUrl);
  });
  test.each(['not-a-url', 'https://localhost/test', 'postgres://localhost/', 'postgres://localhost/test?host=other', 'postgres://localhost/test?dbname=production'])('rejects invalid or overridden endpoints', (testUrl) => {
    expect(() => resolveIsolatedTestDatabase({ TEST_DATABASE_URL: testUrl }, true)).toThrow();
  });
  test('does not leak supplied credentials in errors', () => {
    try { resolveIsolatedTestDatabase({ TEST_DATABASE_URL: 'invalid://user:do-not-print@host/db' }, true); }
    catch (error) { expect(String(error)).not.toContain('do-not-print'); }
  });
});
