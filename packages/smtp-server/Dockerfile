FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY pnpm-workspace.yaml package.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/storage/package.json ./packages/storage/
COPY packages/smtp-server/package.json ./packages/smtp-server/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/core ./packages/core
COPY packages/storage ./packages/storage
COPY packages/smtp-server ./packages/smtp-server

RUN pnpm --filter @coremail/core build
RUN pnpm --filter @coremail/storage build
RUN pnpm --filter @coremail/smtp-server build

FROM node:20-alpine AS runner
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/storage/package.json ./packages/storage/
COPY --from=builder /app/packages/storage/dist ./packages/storage/dist
COPY --from=builder /app/packages/smtp-server/package.json ./packages/smtp-server/
COPY --from=builder /app/packages/smtp-server/dist ./packages/smtp-server/dist

RUN pnpm install --prod --frozen-lockfile

EXPOSE 25 465 587
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD nc -z localhost 25 || exit 1

CMD ["node", "packages/smtp-server/dist/server.js"]
