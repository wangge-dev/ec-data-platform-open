# Third-party components and sample data

The `LICENSE` file covers this project's own code only. Dependencies, base Docker images, fonts, browser databases and bundled examples retain their respective upstream terms. Do not remove their copyright or license notices when redistributing a build.

The dependency inventory for the lockfile in this release was generated with `corepack pnpm@9.15.9 licenses list --json`. It reported MIT, Apache-2.0, ISC, BSD-3-Clause, BSD-2-Clause, 0BSD, Unlicense and CC-BY-4.0 packages. In particular:

| Component | Declared license | Upstream |
|---|---|---|
| SheetJS Community Edition (`xlsx` 0.20.3, pinned CDN tarball) | Apache-2.0 | <https://sheetjs.com/> |
| `caniuse-lite` browser-compatibility data | CC-BY-4.0 | <https://github.com/browserslist/caniuse-lite> |
| `braces` 3.0.3 local depth-protection patch (build dependency) | MIT; upstream notice preserved in [source patch license](https://github.com/wangge-dev/ec-data-platform-open/blob/main/patches/braces.LICENSE) | <https://github.com/micromatch/braces>; modification and validation described in [dependency remediation](https://github.com/wangge-dev/ec-data-platform-open/blob/main/docs/DEPENDENCY_SECURITY_2026-10-08.md) |
| PostgreSQL 16 and Redis 7 Alpine base images | Upstream image/component licenses | <https://hub.docker.com/_/postgres>, <https://hub.docker.com/_/redis> |

The seven workbench spreadsheets under `templates/ecommerce-workbench/samples/` are fixed synthetic examples. The front-profit spreadsheets under `templates/front-profit/` are empty/formula templates, not customer exports. Their provenance and checks are described in the template directories. No real customer, order or financial export is licensed for redistribution by this repository.

This summary is not a substitute for the upstream license texts. Before publishing a new build, review the installed packages and image layers for changed licenses and notices, and preserve required attribution in the distributed artifact. A package-manager vulnerability audit is not a license audit.
