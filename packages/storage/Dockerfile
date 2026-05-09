FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY pnpm-workspace.yaml package.json ./
COPY packages/core/package.json     ./packages/core/
COPY packages/storage/package.json  ./packages/storage/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/core    ./packages/core
COPY packages/storage ./packages/storage

# Generate Prisma client before building
RUN pnpm --filter @coremail/storage prisma:generate
RUN pnpm --filter @coremail/core build
RUN pnpm --filter @coremail/storage build

# ── Runner ──────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages/core/package.json      ./packages/core/
COPY --from=builder /app/packages/core/dist              ./packages/core/dist
COPY --from=builder /app/packages/storage/package.json   ./packages/storage/
COPY --from=builder /app/packages/storage/dist           ./packages/storage/dist
# Include prisma schema + migrations for migrate deploy at runtime
COPY --from=builder /app/packages/storage/prisma         ./packages/storage/prisma

RUN pnpm install --prod --frozen-lockfile
# Re-generate Prisma client in runner (needs schema + @prisma/client)
RUN cd packages/storage && npx prisma generate

EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "packages/storage/dist/server.js"]
