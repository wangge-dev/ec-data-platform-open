# Security policy

This repository is intended for public source distribution under GNU GPL-3.0-only. Public source visibility does not make a deployment safe for anonymous access or untrusted multi-tenant use.

## Sensitive material

Never commit or upload:

- `.env` files or API keys;
- database dumps or backups;
- real Excel/CSV exports;
- customer names, order identifiers, sales values, or local acceptance output;
- the ignored `docs/spec/`, `release/`, `data/`, `backups/`, or `outputs/` directories.

Run `pnpm repo:check:public` before every push or release tag. Scan all commits of this new public repository for secrets before first publication; the historical private repository must never be pushed or mirrored here.

Run `pnpm audit:all` to check runtime and development dependencies. Dependency audit results describe known advisories at scan time, not a guarantee that the application has no vulnerabilities. Database tests must use an explicit isolated `TEST_DATABASE_URL`; never point it at a daily-use database or fall back to `DATABASE_URL`. Run API tests via `pnpm test:api`, which preserves the existing serial execution required by shared filesystem fixtures.

## Reporting a vulnerability

Report vulnerabilities through GitHub's private vulnerability reporting feature if enabled, or contact the repository maintainer through a private channel. Do not open a public issue containing credentials, customer data, exploit payloads, or deployment details. If no private reporting channel is available, open a non-sensitive issue requesting one without disclosing the vulnerability.

## Supported deployment boundary

Project-owned source is licensed under [GPL-3.0-only](LICENSE). Third-party licenses remain applicable; see [third-party notices](THIRD_PARTY_NOTICES.md). Public issue reports and PRs must use synthetic or properly sanitized reproduction data.

The current supported boundary is local use or a trusted, isolated single-tenant deployment. Public registration, shared-database multi-tenancy, and use as the sole authoritative financial system are not supported yet.
