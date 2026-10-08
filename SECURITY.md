# Security policy

This repository is intended for public source distribution under MIT. Public source visibility does not make a deployment safe for anonymous access or untrusted multi-tenant use.

## Dependency review status (2026-10-08)

The documentation update triggered [CI run 37749193441](https://github.com/wangge-dev/ec-data-platform-open/actions/runs/37749193441), which failed at the existing dependency audit step. A local scan with the project's pinned pnpm reproduced 16 advisories: 9 high and 7 moderate, affecting Axios, Hono, braces, source-map-js, and postcss-selector-parser. This remains the historical pre-fix result.

Current source upgrades Axios to 1.20.0, Hono to 4.13.13, source-map-js to 1.2.2, and postcss-selector-parser to 7.1.6. These remove 15 of the reported findings. The remaining `GHSA-vfj7-8cjw-p6xm` has no upstream fixed release: the source applies a pnpm patch to braces 3.0.3, restricting parsed nesting and recursive AST walkers. See the [remediation record](docs/DEPENDENCY_SECURITY_2026-10-08.md) for paths, limits, proof and release boundaries.

The maintainer explicitly authorized one scoped mitigation rule. `pnpm audit:all` still obtains a real npm audit and prints raw counts (currently one high finding), then verifies the declared patch and runs live regressions against all actual Tailwind dependency paths. Only this advisory, version 3.0.3, and Tailwind web build paths can be classified as mitigated. Missing proof, unknown/new advisories, changed paths or scan errors fail the check. No global advisory ignore list is used. `pnpm audit:prod` has no mitigation exception and currently reports zero findings. Run the unfiltered scanner with `corepack pnpm audit --json --registry=https://registry.npmjs.org/` to view the original result.

The existing `v0.1.1` assets have not been replaced and do not contain these fixes. Source fixes do not patch dependencies embedded in previously published images. A new package must be built and validated before it is presented as a fixed installation release. Passing these checks is not a full application security audit or public-production acceptance.

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

Project-owned source is licensed under [MIT](LICENSE). Third-party licenses remain applicable; see [third-party notices](THIRD_PARTY_NOTICES.md). Public issue reports and PRs must use synthetic or properly sanitized reproduction data.

The current supported boundary is local use or a trusted, isolated single-tenant deployment. Public registration, shared-database multi-tenancy, and use as the sole authoritative financial system are not supported yet.
