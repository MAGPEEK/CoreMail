FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY packages/core/package.json ./packages/core/
COPY packages/storage/package.json ./packages/storage/
COPY packages/activesync/package.json ./packages/activesync/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/core ./packages/core
COPY packages/storage ./packages/storage
COPY packages/activesync ./packages/activesync

RUN pnpm --filter @coremail/storage prisma:generate
RUN pnpm --filter @coremail/core build
RUN pnpm --filter @coremail/storage build
RUN pnpm --filter @coremail/activesync build


# ── Runner ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/.npmrc ./
COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages/core/package.json       ./packages/core/
COPY --from=builder /app/packages/core/dist               ./packages/core/dist
COPY --from=builder /app/packages/storage/package.json    ./packages/storage/
COPY --from=builder /app/packages/storage/dist            ./packages/storage/dist
COPY --from=builder /app/packages/storage/prisma          ./packages/storage/prisma
COPY --from=builder /app/packages/activesync/package.json ./packages/activesync/
COPY --from=builder /app/packages/activesync/dist         ./packages/activesync/dist

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @coremail/storage exec prisma generate

EXPOSE 3005
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3005/health || exit 1

CMD ["node", "packages/activesync/dist/server.js"]
