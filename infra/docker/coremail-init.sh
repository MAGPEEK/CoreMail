#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# CoreMail — one-shot init step (installed as /usr/local/bin/coremail-init).
# The Compose files no longer have an init service: the entrypoint of the
# coremail container does both steps itself on every start. This command stays
# for `docker run` setups and for a 10.4.0 Compose file run with a newer image:
#   1. coremail-init-secrets  create / extend the secrets in /secrets
#   2. coremail-init-config   copy the configuration bundled in the image
#                             (PostgreSQL init scripts, rspamd local.d, the
#                             pg-backup script) into the mounted config volumes
# Arguments go to coremail-init-secrets. Exit code 2 = unsafe secrets directory.
# ─────────────────────────────────────────────────────────────────────────────
set -e
/usr/local/bin/coremail-init-secrets "$@"
exec /usr/local/bin/coremail-init-config
