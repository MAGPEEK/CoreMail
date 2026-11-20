# ─────────────────────────────────────────────────────────────────────────────
# CoreMail — Monolithic App Container  (magpeek/coremail-app)
#
# Contains all Node.js services, nginx (reverse proxy + static files)
# and all frontend bundles in a single container.
# Process manager: supervisord
#
# Build (from the repo root):
#   docker build -f infra/docker/Dockerfile.app \
#                -t magpeek/coremail-app:0.9.0 .
#
# Internal ports (all on localhost):
#   80/443  nginx (HTTP/HTTPS)
#   25/465/587  SMTP
#   143/993     IMAP
#   110/995     POP3
#   3000  api-gateway
#   3002  security-filter 3003  auth-service
#   3004  backup-service  3005  activesync
#   8081  autodiscover
#   8082  caldav-server   3006  jmap-server
#   3007  mapi-server
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Build all Node.js packages ──────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
# Skip the Prisma engine binary download in the builder (fails under QEMU).
# Only generate the JS client (for TypeScript types). The real engine is loaded in the runner stage.
ENV PRISMA_CLI_QUERY_ENGINE_TYPE=library
RUN corepack enable && corepack prepare pnpm@11 --activate
RUN apk add --no-cache python3 make g++

# Workspace configuration first (layer caching)
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc tsconfig.base.json ./

# package.json of all services
COPY packages/core/package.json           ./packages/core/
COPY packages/storage/package.json        ./packages/storage/
COPY packages/smtp-server/package.json    ./packages/smtp-server/
COPY packages/imap-server/package.json    ./packages/imap-server/
COPY packages/pop3-server/package.json    ./packages/pop3-server/
COPY packages/autodiscover/package.json   ./packages/autodiscover/
COPY packages/caldav-server/package.json  ./packages/caldav-server/
COPY packages/api-gateway/package.json    ./packages/api-gateway/
COPY packages/auth-service/package.json   ./packages/auth-service/
COPY packages/auth-ldap/package.json      ./packages/auth-ldap/
COPY packages/auth-sso/package.json       ./packages/auth-sso/
COPY packages/backup-service/package.json ./packages/backup-service/
COPY packages/security-filter/package.json ./packages/security-filter/
COPY packages/activesync/package.json     ./packages/activesync/
COPY packages/jmap-server/package.json    ./packages/jmap-server/
COPY packages/mapi-server/package.json    ./packages/mapi-server/
COPY packages/cli/package.json            ./packages/cli/

RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/core          ./packages/core
COPY packages/storage       ./packages/storage
COPY packages/smtp-server   ./packages/smtp-server
COPY packages/imap-server   ./packages/imap-server
COPY packages/pop3-server   ./packages/pop3-server
COPY packages/autodiscover  ./packages/autodiscover
COPY packages/caldav-server ./packages/caldav-server
COPY packages/api-gateway   ./packages/api-gateway
COPY packages/auth-service  ./packages/auth-service
COPY packages/auth-ldap     ./packages/auth-ldap
COPY packages/auth-sso      ./packages/auth-sso
COPY packages/backup-service    ./packages/backup-service
COPY packages/security-filter   ./packages/security-filter
COPY packages/activesync        ./packages/activesync
COPY packages/jmap-server       ./packages/jmap-server
COPY packages/mapi-server       ./packages/mapi-server
COPY packages/cli               ./packages/cli

# Generate Prisma client and build all packages
RUN pnpm --filter @coremail/storage exec prisma generate
RUN pnpm --filter @coremail/core build
RUN pnpm --filter @coremail/storage build
# v6.1: auth-ldap + auth-sso first — api-gateway, auth-service and the mail-protocol
# services (LDAP verifier for verifyMailCredentials) import them
RUN pnpm --filter @coremail/auth-ldap      build \
 && pnpm --filter @coremail/auth-sso       build \
 && pnpm --filter @coremail/smtp-server    build \
 && pnpm --filter @coremail/imap-server    build \
 && pnpm --filter @coremail/pop3-server    build \
 && pnpm --filter @coremail/autodiscover   build \
 && pnpm --filter @coremail/caldav-server  build \
 && pnpm --filter @coremail/api-gateway    build \
 && pnpm --filter @coremail/auth-service   build \
 && pnpm --filter @coremail/backup-service build \
 && pnpm --filter @coremail/security-filter build \
 && pnpm --filter @coremail/activesync     build \
 && pnpm --filter @coremail/jmap-server    build \
 && pnpm --filter @coremail/mapi-server    build \
 && pnpm --filter @coremail/cli            build

# ── Stage 2: Frontend build ───────────────────────────────────────────────────
FROM node:22-alpine AS frontend-builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY packages/web-client/package.json  ./packages/web-client/
COPY packages/admin-panel/package.json ./packages/admin-panel/

RUN pnpm install --frozen-lockfile

COPY packages/web-client  ./packages/web-client
COPY packages/admin-panel ./packages/admin-panel

# Build-time arguments (can be overridden during the image build)
ARG VITE_API_BASE_URL=/api/v1

RUN VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    pnpm --filter @coremail/web-client build

RUN VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    pnpm --filter @coremail/admin-panel build

# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# ── System packages ───────────────────────────────────────────────────────────
# libcap: setcap tool — allows the node binary to bind to ports < 1024
#         without root privileges (cap_net_bind_service).
# tini:   init process (PID 1) — clean signal handling, no zombie processes.
# postgresql16-client: pg_dump for the pre-migration dump of schema-sync.sh
#         (matches the bundled postgres:16 — pg_dump must be >= the server).
RUN apk add --no-cache supervisor curl tini netcat-openbsd openssl libcap postgresql16-client

# ── setcap: node may bind privileged ports (25, 110, 143, …) ──────────────────
# cap_net_bind_service=+eip:
#   e (effective)    — capability is active when executing
#   i (inheritable)  — capability is inherited by child processes via setuid()
#   p (permitted)    — capability is in the permitted set
# This lets supervisord child processes (user=node) bind privileged ports
# despite a non-root UID, as long as no-new-privileges is NOT set.
# docker-compose.yml sets no-new-privileges + cap_drop ALL and instead
# net.ipv4.ip_unprivileged_port_start=0; NET_BIND_SERVICE must stay in the
# capability bounding set there, otherwise exec of this binary fails (EPERM).
RUN setcap 'cap_net_bind_service=+eip' /usr/local/bin/node

RUN corepack enable && corepack prepare pnpm@11 --activate

# Workspace configuration
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

# all services
COPY --from=builder /app/packages/smtp-server/package.json    ./packages/smtp-server/
COPY --from=builder /app/packages/smtp-server/dist            ./packages/smtp-server/dist
COPY --from=builder /app/packages/imap-server/package.json    ./packages/imap-server/
COPY --from=builder /app/packages/imap-server/dist            ./packages/imap-server/dist
COPY --from=builder /app/packages/pop3-server/package.json    ./packages/pop3-server/
COPY --from=builder /app/packages/pop3-server/dist            ./packages/pop3-server/dist
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
COPY --from=builder /app/packages/jmap-server/package.json    ./packages/jmap-server/
COPY --from=builder /app/packages/jmap-server/dist            ./packages/jmap-server/dist
COPY --from=builder /app/packages/mapi-server/package.json    ./packages/mapi-server/
COPY --from=builder /app/packages/mapi-server/dist            ./packages/mapi-server/dist
COPY --from=builder /app/packages/cli/package.json            ./packages/cli/
COPY --from=builder /app/packages/cli/dist                    ./packages/cli/dist

# Install production dependencies only.
# python3 + make + g++ are needed for native modules (bcrypt) that have no
# prebuilt binary for alpine/arm64 — they are removed again afterwards.
RUN apk add --no-cache python3 make g++ \
 && pnpm install --frozen-lockfile --prod \
 && apk del python3 make g++ \
 && rm -rf /root/.cache /tmp/pnpm-*
# Delete the old Prisma engine binary so the BuildKit cache does not kick in
RUN find /app/node_modules -path "*/.prisma/client/libquery_engine*" -delete 2>/dev/null || true
RUN pnpm --filter @coremail/storage exec prisma generate
# Symlink: linux-musl → linux-musl-openssl-3.0.x (safeguard Prisma detection fallback)
RUN for f in $(find /app/node_modules -name "libquery_engine-linux-musl.so.node" 2>/dev/null); do \
    t=$(echo "$f" | sed "s/linux-musl\.so/linux-musl-openssl-3.0.x.so/"); \
    [ -f "$t" ] && ln -sf "$t" "$f" && echo "symlinked $f"; \
  done

# Frontend bundles (static files)
RUN mkdir -p /app/www
COPY --from=frontend-builder /app/packages/web-client/dist  /app/www/owa
COPY --from=frontend-builder /app/packages/admin-panel/dist /app/www/bcp

# Release notes for the BCP info page (GET /api/v1/changelog)
COPY CHANGELOG.md /app/CHANGELOG.md
ENV CHANGELOG_PATH=/app/CHANGELOG.md

# Admin CLI: `docker exec coremail coremail --help`
RUN chmod +x /app/packages/cli/dist/index.js \
 && ln -sf /app/packages/cli/dist/index.js /usr/local/bin/coremail

# supervisord configuration
COPY infra/docker/supervisord-app.conf /etc/supervisord.conf
COPY infra/docker/entrypoint-app.sh /entrypoint.sh
# Schema sync: used by the entrypoint and the Helm init container
COPY infra/docker/schema-sync.sh /usr/local/bin/coremail-schema-sync
# Classifies Prisma's data-loss warnings (new unique constraints are applied automatically)
COPY infra/docker/schema-sync-classify.mjs /usr/local/lib/coremail/schema-sync-classify.mjs
# Backup decryption without a running CoreMail (node built-ins only):
# `docker exec coremail coremail-decrypt-backup --help` (docs/deployment-security.md).
# Kept as .mjs behind a symlink: node resolves the link, so the file stays an ES module.
COPY scripts/decrypt-backup.mjs /usr/local/lib/coremail/decrypt-backup.mjs
# 10.4: secrets generator — an internal library of the entrypoint, not a command.
# The image deliberately has NO /secrets directory: secrets are generated only
# into a mounted directory, never into the container layer (docs/setup.md).
COPY infra/docker/init-secrets.mjs /usr/local/lib/coremail/init-secrets.mjs
# 10.4: configuration the infrastructure containers need, so deploy/docker-compose.yml
# works without a repository checkout. The entrypoint of the coremail container
# copies it into the mounted config volumes on every start (init-config.mjs, an
# internal library like init-secrets.mjs; docs/deploy.md).
COPY infra/docker/init-config.mjs /usr/local/lib/coremail/init-config.mjs
COPY infra/docker/postgres/init.sql /usr/share/coremail/config/postgres/01-init.sql
COPY infra/docker/postgres/02-app-role.sh /usr/share/coremail/config/postgres/02-app-role.sh
COPY infra/docker/rspamd/local.d/ /usr/share/coremail/config/rspamd/local.d/
COPY infra/docker/pg-backup/pg-backup.sh /usr/share/coremail/config/pg-backup/pg-backup.sh
# Strip CR in case the build context comes from a Windows checkout with CRLF line
# endings — a "#!/bin/sh\r" shebang makes tini fail with "No such file or directory".
RUN sed -i 's/\r$//' /entrypoint.sh /etc/supervisord.conf /usr/local/bin/coremail-schema-sync /usr/local/lib/coremail/schema-sync-classify.mjs /usr/local/lib/coremail/decrypt-backup.mjs /usr/local/lib/coremail/init-secrets.mjs /usr/local/lib/coremail/init-config.mjs \
 && find /usr/share/coremail/config -type f -exec sed -i 's/\r$//' {} + \
 && find /usr/share/coremail/config -type d -exec chmod 755 {} + \
 && find /usr/share/coremail/config -type f -exec chmod 644 {} + \
 && chmod 755 /usr/share/coremail/config/postgres/02-app-role.sh \
 && chmod +x /entrypoint.sh /usr/local/bin/coremail-schema-sync /usr/local/lib/coremail/decrypt-backup.mjs /usr/local/lib/coremail/init-secrets.mjs /usr/local/lib/coremail/init-config.mjs \
 && ln -sf /usr/local/lib/coremail/decrypt-backup.mjs /usr/local/bin/coremail-decrypt-backup

# ── Directories + permissions ─────────────────────────────────────────────────
# All runtime directories belong to the node user (uid 1000, gid 1000).
# supervisord starts as root (PID 1 via tini) and switches to node via user=node
# for every child process — this requires the SETUID/SETGID capability.
# /data/objects: filesystem object storage (v8.0, volume coremail-data:/data) —
# a fresh named volume copies this directory incl. owner/mode on first use.
RUN mkdir -p /var/log/supervisor /var/run/supervisor /tmp/coremail /data/objects \
 && chown -R node:node /app /var/log/supervisor /var/run/supervisor /tmp/coremail /data \
 && chmod 750 /var/log/supervisor /var/run/supervisor /data /data/objects

# Ports:
#   3000 — HTTP (MWA, BCP, API, Auth, JMAP, ActiveSync, CalDAV, Autodiscover proxy)
#         → TLS termination external (Traefik, Caddy, DSM Application Portal …)
#   25/465/587 — SMTP
#   143/993    — IMAP
#   110/995    — POP3
EXPOSE 3000 25 465 587 143 993 110 995

HEALTHCHECK --interval=30s --timeout=10s --retries=5 --start-period=60s \
  CMD curl -sf http://localhost:3000/healthz || exit 1

# tini as init process (clean signal handling)
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/entrypoint.sh", "/usr/bin/supervisord", "-c", "/etc/supervisord.conf", "-n"]
