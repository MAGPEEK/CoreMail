FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/web-client/package.json ./packages/web-client/
RUN corepack enable && pnpm install --frozen-lockfile
COPY packages/web-client ./packages/web-client
RUN pnpm --filter @coremail/web-client build

FROM nginx:alpine AS runner
COPY infra/docker/nginx/owa.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/packages/web-client/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s CMD wget -qO- http://localhost/healthz || exit 1
