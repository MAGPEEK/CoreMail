FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc tsconfig.base.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/storage/package.json ./packages/storage/
COPY packages/api-gateway/package.json ./packages/api-gateway/

RUN pnpm install --frozen-lockfile

COPY packages/core ./packages/core
COPY packages/storage ./packages/storage
COPY packages/api-gateway ./packages/api-gateway

RUN pnpm --filter @coremail/storage prisma:generate
RUN pnpm --filter @coremail/core build
RUN pnpm --filter @coremail/storage build
RUN pnpm --filter @coremail/api-gateway build

# ── Runner ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/.npmrc ./
COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages/core/package.json      ./packages/core/
COPY --from=builder /app/packages/core/dist              ./packages/core/dist
COPY --from=builder /app/packages/storage/package.json   ./packages/storage/
COPY --from=builder /app/packages/storage/dist           ./packages/storage/dist
COPY --from=builder /app/packages/storage/prisma         ./packages/storage/prisma
COPY --from=builder /app/packages/api-gateway/package.json ./packages/api-gateway/
COPY --from=builder /app/packages/api-gateway/dist       ./packages/api-gateway/dist

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @coremail/storage exec prisma generate

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

CMD ["node", "packages/api-gateway/dist/server.js"]
