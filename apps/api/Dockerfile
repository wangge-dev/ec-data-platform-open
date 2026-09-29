# API: production-only deploy assembled in a separate builder stage.
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder
WORKDIR /app

ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV NPM_CONFIG_REGISTRY=$NPM_REGISTRY \
    PNPM_CONFIG_REGISTRY=$NPM_REGISTRY \
    PNPM_CONFIG_FETCH_RETRIES=6 \
    PNPM_CONFIG_FETCH_RETRY_MINTIMEOUT=10000 \
    PNPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    PNPM_CONFIG_NETWORK_CONCURRENCY=4

RUN corepack enable \
    && corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY scripts/verify-sheetjs-package.mjs ./scripts/verify-sheetjs-package.mjs

# Install only the API production dependency closure.  tsx is intentionally a
# production dependency because runtime module hooks and migration scripts are
# TypeScript source files.
RUN pnpm --filter @ec/api install --prod --frozen-lockfile

COPY apps/api/ ./apps/api/

RUN pnpm --filter @ec/api --prod deploy /prod/apps/api \
    && mkdir -p /prod/scripts \
    && cp pnpm-lock.yaml /prod/pnpm-lock.yaml \
    && cp scripts/verify-sheetjs-package.mjs /prod/scripts/verify-sheetjs-package.mjs \
    && node /prod/scripts/verify-sheetjs-package.mjs \
    && node /prod/apps/api/scripts/verify-runtime-package.mjs /prod/apps/api \
    && node -e 'const fs = require("node:fs"); const target = process.argv[1]; const bom = Buffer.from([0xef, 0xbb, 0xbf]); let bytes = fs.readFileSync(target); if (bytes.subarray(0, bom.length).equals(bom)) bytes = bytes.subarray(bom.length); const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); fs.writeFileSync(target, text.replace(/\r\n?/g, "\n"), "utf8"); const normalized = fs.readFileSync(target); if (normalized.subarray(0, bom.length).equals(bom) || normalized.includes(0x0d)) throw new Error("entrypoint normalization failed");' /prod/apps/api/docker-entrypoint.sh \
    && chmod +x /prod/apps/api/docker-entrypoint.sh

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runtime
WORKDIR /app/apps/api

ENV NODE_ENV=production

COPY --from=builder --chown=node:node /prod/apps/api/ ./

# Re-run the runtime-closure assertion after the final-stage copy.  This makes
# accidental dev/test additions fail the image build itself.
RUN node scripts/verify-runtime-package.mjs /app/apps/api

USER node

EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --retries=10 --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
