FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY packages/storage/package.json packages/storage/tsconfig.json ./packages/storage/
COPY packages/backup-service/package.json packages/backup-service/tsconfig.json ./packages/backup-service/
RUN corepack enable && pnpm install --frozen-lockfile
COPY packages/core/src ./packages/core/src
COPY packages/storage/src ./packages/storage/src
COPY packages/backup-service/src ./packages/backup-service/src
RUN pnpm --filter @coremail/core build && \
    pnpm --filter @coremail/storage build && \
    pnpm --filter @coremail/backup-service build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/storage/package.json ./packages/storage/
COPY packages/backup-service/package.json ./packages/backup-service/
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/storage/dist ./packages/storage/dist
COPY --from=builder /app/packages/backup-service/dist ./packages/backup-service/dist
EXPOSE 3004
HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD wget -qO- http://localhost:3004/healthz || exit 1
CMD ["node", "packages/backup-service/dist/server.js"]
