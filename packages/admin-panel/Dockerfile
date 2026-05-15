FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/admin-panel/package.json ./packages/admin-panel/
RUN corepack enable && pnpm install --frozen-lockfile
COPY packages/admin-panel ./packages/admin-panel
RUN pnpm --filter @coremail/admin-panel build

FROM nginx:alpine AS runner
COPY infra/docker/nginx/ecp.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/packages/admin-panel/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s CMD wget -qO- http://localhost/ || exit 1
