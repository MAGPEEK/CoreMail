# ─────────────────────────────────────────────────────────────────────────────
# CoreMail — Monolithic App Container  (magpeek/coremail-app)
#
# Enthält alle Node.js-Services, nginx (Reverse Proxy + Static Files)
# und alle Frontend-Bundles in einem einzigen Container.
# Process-Manager: supervisord
#
# Build (aus dem Repo-Root):
#   docker build -f infra/docker/Dockerfile.app \
#                -t magpeek/coremail-app:0.9.0 .
#
# Interne Ports (alle auf localhost):
#   80/443  nginx (HTTP/HTTPS)
#   25/465/587  SMTP
#   143/993     IMAP
#   110/995     POP3
#   3000  api-gateway     3001  storage-api
#   3002  security-filter 3003  auth-service
#   3004  backup-service  3005  activesync
#   8080  ews-server      8081  autodiscover
#   8082  caldav-server
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Build aller Node.js-Pakete ──────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

# Workspace-Konfiguration zuerst (Layer-Caching)
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc tsconfig.base.json ./

# package.json aller Services
COPY packages/core/package.json           ./packages/core/
COPY packages/storage/package.json        ./packages/storage/
COPY packages/smtp-server/package.json    ./packages/smtp-server/
COPY packages/imap-server/package.json    ./packages/imap-server/
COPY packages/pop3-server/package.json    ./packages/pop3-server/
COPY packages/ews-server/package.json     ./packages/ews-server/
COPY packages/autodiscover/package.json   ./packages/autodiscover/
COPY packages/caldav-server/package.json  ./packages/caldav-server/
COPY packages/api-gateway/package.json    ./packages/api-gateway/
COPY packages/auth-service/package.json   ./packages/auth-service/
COPY packages/auth-ldap/package.json      ./packages/auth-ldap/
COPY packages/auth-sso/package.json       ./packages/auth-sso/
COPY packages/backup-service/package.json ./packages/backup-service/
COPY packages/security-filter/package.json ./packages/security-filter/
COPY packages/activesync/package.json     ./packages/activesync/

RUN pnpm install --frozen-lockfile

# Quellcode kopieren
COPY packages/core          ./packages/core
COPY packages/storage       ./packages/storage
COPY packages/smtp-server   ./packages/smtp-server
COPY packages/imap-server   ./packages/imap-server
COPY packages/pop3-server   ./packages/pop3-server
COPY packages/ews-server    ./packages/ews-server
COPY packages/autodiscover  ./packages/autodiscover
COPY packages/caldav-server ./packages/caldav-server
COPY packages/api-gateway   ./packages/api-gateway
COPY packages/auth-service  ./packages/auth-service
COPY packages/auth-ldap     ./packages/auth-ldap
COPY packages/auth-sso      ./packages/auth-sso
COPY packages/backup-service    ./packages/backup-service
COPY packages/security-filter   ./packages/security-filter
COPY packages/activesync        ./packages/activesync

# Prisma-Client generieren und alle Pakete bauen
RUN pnpm --filter @coremail/storage exec prisma generate
RUN pnpm --filter @coremail/core build
RUN pnpm --filter @coremail/storage build
RUN pnpm --filter @coremail/smtp-server    build \
 && pnpm --filter @coremail/imap-server    build \
 && pnpm --filter @coremail/pop3-server    build \
 && pnpm --filter @coremail/ews-server     build \
 && pnpm --filter @coremail/autodiscover   build \
 && pnpm --filter @coremail/caldav-server  build \
 && pnpm --filter @coremail/api-gateway    build \
 && pnpm --filter @coremail/auth-service   build \
 && pnpm --filter @coremail/auth-ldap      build \
 && pnpm --filter @coremail/auth-sso       build \
 && pnpm --filter @coremail/backup-service build \
 && pnpm --filter @coremail/security-filter build \
 && pnpm --filter @coremail/activesync     build

# ── Stage 2: Frontend-Build ───────────────────────────────────────────────────
FROM node:22-alpine AS frontend-builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY packages/web-client/package.json  ./packages/web-client/
COPY packages/admin-panel/package.json ./packages/admin-panel/

RUN pnpm install --frozen-lockfile

COPY packages/web-client  ./packages/web-client
COPY packages/admin-panel ./packages/admin-panel

# Build-Zeit-Argumente (können beim Image-Build überschrieben werden)
ARG VITE_API_BASE_URL=/api/v1
ARG VITE_EWS_URL=/EWS/Exchange.asmx

RUN VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_EWS_URL=${VITE_EWS_URL} \
    pnpm --filter @coremail/web-client build

RUN VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    pnpm --filter @coremail/admin-panel build

# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# supervisord für Process-Management (kein nginx — api-gateway übernimmt HTTP-Routing)
RUN apk add --no-cache supervisor curl tini netcat-openbsd openssl

RUN corepack enable && corepack prepare pnpm@latest --activate

# Workspace-Konfiguration
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/.npmrc ./
COPY --from=builder /app/package.json ./

# core
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/core/dist          ./packages/core/dist

# storage
COPY --from=builder /app/packages/storage/package.json ./packages/storage/
COPY --from=builder /app/packages/storage/dist         ./packages/storage/dist
COPY --from=builder /app/packages/storage/prisma       ./packages/storage/prisma

# alle Services
COPY --from=builder /app/packages/smtp-server/package.json    ./packages/smtp-server/
COPY --from=builder /app/packages/smtp-server/dist            ./packages/smtp-server/dist
COPY --from=builder /app/packages/imap-server/package.json    ./packages/imap-server/
COPY --from=builder /app/packages/imap-server/dist            ./packages/imap-server/dist
COPY --from=builder /app/packages/pop3-server/package.json    ./packages/pop3-server/
COPY --from=builder /app/packages/pop3-server/dist            ./packages/pop3-server/dist
COPY --from=builder /app/packages/ews-server/package.json     ./packages/ews-server/
COPY --from=builder /app/packages/ews-server/dist             ./packages/ews-server/dist
COPY --from=builder /app/packages/autodiscover/package.json   ./packages/autodiscover/
COPY --from=builder /app/packages/autodiscover/dist           ./packages/autodiscover/dist
COPY --from=builder /app/packages/caldav-server/package.json  ./packages/caldav-server/
COPY --from=builder /app/packages/caldav-server/dist          ./packages/caldav-server/dist
COPY --from=builder /app/packages/api-gateway/package.json    ./packages/api-gateway/
COPY --from=builder /app/packages/api-gateway/dist            ./packages/api-gateway/dist
COPY --from=builder /app/packages/auth-service/package.json   ./packages/auth-service/
COPY --from=builder /app/packages/auth-service/dist           ./packages/auth-service/dist
COPY --from=builder /app/packages/auth-ldap/package.json      ./packages/auth-ldap/
COPY --from=builder /app/packages/auth-ldap/dist              ./packages/auth-ldap/dist
COPY --from=builder /app/packages/auth-sso/package.json       ./packages/auth-sso/
COPY --from=builder /app/packages/auth-sso/dist               ./packages/auth-sso/dist
COPY --from=builder /app/packages/backup-service/package.json ./packages/backup-service/
COPY --from=builder /app/packages/backup-service/dist         ./packages/backup-service/dist
COPY --from=builder /app/packages/security-filter/package.json ./packages/security-filter/
COPY --from=builder /app/packages/security-filter/dist         ./packages/security-filter/dist
COPY --from=builder /app/packages/activesync/package.json     ./packages/activesync/
COPY --from=builder /app/packages/activesync/dist             ./packages/activesync/dist

# Nur Produktions-Abhängigkeiten installieren
RUN pnpm install --frozen-lockfile --prod
# Altes Prisma-Engine-Binary löschen damit BuildKit-Cache nicht greift
RUN find /app/node_modules -path "*/.prisma/client/libquery_engine*" -delete 2>/dev/null || true
RUN pnpm --filter @coremail/storage exec prisma generate
# Symlink: linux-musl → linux-musl-openssl-3.0.x (Prisma Detection-Fallback absichern)
RUN for f in $(find /app/node_modules -name "libquery_engine-linux-musl.so.node" 2>/dev/null); do \
    t=$(echo "$f" | sed "s/linux-musl\.so/linux-musl-openssl-3.0.x.so/"); \
    [ -f "$t" ] && ln -sf "$t" "$f" && echo "symlinked $f"; \
  done

# Frontend-Bundles (statische Dateien)
RUN mkdir -p /app/www
COPY --from=frontend-builder /app/packages/web-client/dist  /app/www/owa
COPY --from=frontend-builder /app/packages/admin-panel/dist /app/www/ecp

# supervisord-Konfiguration
COPY infra/docker/supervisord-app.conf /etc/supervisord.conf
COPY infra/docker/entrypoint-app.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Verzeichnisse für supervisord
RUN mkdir -p /var/log/supervisor \
 && chown -R node:node /app/www

# Ports:
#   3000 — HTTP (OWA, ECP, API, Auth, EWS-Proxy, ActiveSync-Proxy)
#         → TLS-Terminierung extern (Traefik, Caddy, DSM Application Portal …)
#   8080 — EWS/MAPI/Autodiscover (direkter Zugriff optional)
#   25/465/587 — SMTP
#   143/993    — IMAP
#   110/995    — POP3
EXPOSE 3000 8080 25 465 587 143 993 110 995

HEALTHCHECK --interval=30s --timeout=10s --retries=5 --start-period=60s \
  CMD curl -sf http://localhost:3000/healthz || exit 1

# tini als Init-Prozess (sauberes Signal-Handling)
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/entrypoint.sh", "/usr/bin/supervisord", "-c", "/etc/supervisord.conf", "-n"]
