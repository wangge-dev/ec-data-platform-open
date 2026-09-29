# Web 多阶段构建：Vite + React + Tailwind → nginx
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
COPY apps/web/package.json ./apps/web/
COPY scripts/verify-sheetjs-package.mjs ./scripts/verify-sheetjs-package.mjs
RUN pnpm install --frozen-lockfile \
    && node scripts/verify-sheetjs-package.mjs

COPY apps/web/ ./apps/web/
RUN cd apps/web && pnpm build

FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/nginx.conf

HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
