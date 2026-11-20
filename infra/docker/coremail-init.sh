#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# CoreMail — one-shot init step (installed as /usr/local/bin/coremail-init),
# the command of the coremail-init service in deploy/docker-compose.yml:
#   1. coremail-init-secrets  create / extend the secrets in /secrets
#   2. coremail-init-config   copy the configuration bundled in the image
#                             (PostgreSQL init scripts, rspamd local.d, the
#                             pg-backup script) into the mounted config volumes
# Arguments go to coremail-init-secrets. Exit code 2 = unsafe secrets directory.
# ─────────────────────────────────────────────────────────────────────────────
set -e
/usr/local/bin/coremail-init-secrets "$@"
exec /usr/local/bin/coremail-init-config
