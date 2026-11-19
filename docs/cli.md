# CoreMail Admin CLI `coremail` (since v5.8.0)

The CLI manages users, mailboxes, Shared Mailboxes, connectors, the
SMTP banner and TLS certificates through the same REST admin API that the
admin panel (BCP) uses. The same roles (`ORGANIZATION_MANAGEMENT`,
`SERVER_MANAGEMENT`), the same validations and the same audit log therefore apply.

## Invocation

The CLI is included in the app image:

```bash
docker exec -it coremail coremail --help
docker exec -it coremail coremail user list
```

Tip: create an alias on the host:

```bash
alias coremail='docker exec -it coremail coremail'
```

Outside the container (e.g. from the admin workstation) the CLI works against any
reachable CoreMail instance:

```bash
coremail --server https://mail.example.com login -u admin@example.com
```

All commands support `--json` for machine-readable output
(`coremail --json user list | jq`).

## Login

| Method | Description |
|-----|--------------|
| `coremail login` | prompts for email, password and, if required, MFA code (TOTP or backup code); the session is stored in `~/.config/coremail/credentials.json` (mode 0600) and renewed automatically via refresh token |
| `COREMAIL_ADMIN_EMAIL` + `COREMAIL_ADMIN_PASSWORD` (+ `COREMAIL_ADMIN_TOTP`) | login without a prompt, e.g. in scripts |
| `COREMAIL_TOKEN` | use a ready-made admin access token (JWT) directly |
| `COREMAIL_API_URL` | base URL of the API (default `http://localhost:3000`, correct inside the container) |
| `COREMAIL_CLI_CREDENTIALS` | alternative path for the session file |

Inside the container, `localhost:3000` is the api-gateway, so no URL is needed there.
For accounts with WebAuthn-only MFA, please set up TOTP in addition or use `COREMAIL_TOKEN`.

```bash
coremail login -u admin@example.com          # interactive
coremail whoami                              # show the stored session
coremail logout
```

## Users (`user`)

Each user owns exactly one mailbox; `user create` creates both.

```bash
coremail user list [--domain example.com] [--inactive]
coremail user show john@example.com          # including folder overview
coremail user create john@example.com --name "John Doe" [--password …] [--role USER] [--quota 5GB] [--domain example.com]
coremail user update john@example.com [--name …] [--role SERVER_MANAGEMENT] [--quota 20GB] [--enable|--disable]
coremail user set-password john@example.com [--password …] [--revoke-app-passwords]
coremail user delete john@example.com [--yes]
```

Without `--password` the CLI prompts interactively (without echo); alternatively `COREMAIL_NEW_PASSWORD`.
`set-password` ends all web/API sessions of the user; app passwords stay valid unless
`--revoke-app-passwords` is given (API: `revokeAppPasswords: true` next to `password` in
`PUT /api/v1/admin/mailboxes/:id`) — use it when the account may be compromised.
Roles: `USER, HELP_DESK, RECIPIENT_MANAGEMENT, COMPLIANCE_MANAGEMENT, HYGIENE_MANAGEMENT,
SERVER_MANAGEMENT, VIEW_ONLY_ORG, ORGANIZATION_MANAGEMENT`.

## Mailboxes (`mailbox`)

View of usage and folders of the user mailboxes.

```bash
coremail mailbox list [--sort used|quota|email]
coremail mailbox show john@example.com       # folders with counters
coremail mailbox quota john@example.com 10GB
coremail mailbox recalculate [john@example.com]   # recalculate usage (one or all)
```

## Shared Mailboxes (`shared`)

Team mailboxes with permissions `FULL_ACCESS`, `SEND_AS`, `SEND_ON_BEHALF`, `READ_ONLY`.

```bash
coremail shared list
coremail shared show team@example.com
coremail shared create team@example.com --name "Sales Team" [--quota 20GB]
coremail shared grant team@example.com john@example.com FULL_ACCESS SEND_AS   # replaces the user's existing rights
coremail shared grant team@example.com john@example.com READ_ONLY --no-automap  # 9.4: john adds it himself
coremail shared sent-copy team@example.com --send-as on --on-behalf off        # 9.4: Sent copy in the shared mailbox
coremail shared flow team@example.com --accept-from example.com --max-receive 20
coremail shared revoke team@example.com john@example.com
coremail shared delete team@example.com [--yes]
```

## Domains (`domain`)

```bash
coremail domain list
```

## Connectors (`connector`)

| Name | Meaning |
|------|-----------|
| `smtp` (`smtp-receive`) | SMTP receive: listeners 25, 465 (TLS), 587 |
| `smtp-send` | SMTP submission |
| `imap` | IMAP 143 / IMAPS 993 |
| `pop3` | POP3 110 / POP3S 995 |
| `jmap` | JMAP (`/jmap`, `/.well-known/jmap`) — switch in the server settings |

The `ews` connector (and its deprecated `mapi` alias) was removed in v7.0.0 together with Exchange Web Services.

```bash
coremail connector status                    # all services, ports, TLS, state
coremail connector disable pop3              # all POP3 listeners off
coremail connector enable pop3 --port 995    # a single port only
coremail connector disable jmap              # JMAP off (enable jmap: back on)

coremail connector listener list [imap]
coremail connector listener add imap --port 1143 [--address 0.0.0.0] [--ssl false] [--inactive]
coremail connector listener set <id> [--port 1143] [--address …] [--ssl true|false] [--active true|false]
coremail connector listener delete <id>
coremail connector listener restore-defaults smtp
```

Listener changes take effect immediately via the Redis signal; the container port mappings
in `docker-compose.yml` must match the port.

## SMTP banner (`smtp banner`)

```bash
coremail smtp banner                         # show
coremail smtp banner set "mail.example.com ESMTP"
coremail smtp banner reset                   # back to default (220 <hostname> ESMTP CoreMail)
```

## Certificates (`cert`)

```bash
coremail cert list
coremail cert show mail.example.com          # ID, name or domain
coremail cert self-signed --domains mail.example.com,imap.example.com [--services SMTP,IMAP,POP3] [--days 365]
coremail cert letsencrypt --domains mail.example.com,autodiscover.example.com --email admin@example.com \
    [--services SMTP,IMAP,POP3] [--no-auto-renew] [--staging]
coremail cert activate mail.example.com --https --protocol   # HTTPS proxy (443) and/or SMTP/IMAP/POP3
coremail cert deactivate-https mail.example.com
coremail cert renew mail.example.com
coremail cert delete <id|name|domain> [--yes]
```

Let's Encrypt uses HTTP-01: port 80 of the host must point to CoreMail
(`"80:3000"` in the Compose file) and the domains must point to the server via DNS.
Issuance runs asynchronously; `cert show` shows the status and, if applicable, the last error.

## Mail storage (`storage`, v8.0, ORGANIZATION_MANAGEMENT)

```bash
coremail storage status                      # driver, location, startup-check result, last migration
coremail storage check                       # run the startup check now (exit 1 while it blocks)
coremail storage migrate --from minio --to filesystem [--dry-run] [--verify-existing] [--no-wait]
coremail storage migrate-status
coremail storage migrate-cancel
```

The migration runs as a background job in the api-gateway (`/api/v1/admin/storage/migrate`);
the command polls and prints progress. It streams and verifies every object (sha256 + size),
skips objects already present (run it again to resume) and never deletes the source.
Procedure and backups: [storage.md](storage.md).

## Audit log (`audit`, v9.0, compliance area)

```bash
coremail audit verify audit-log-2026-11-15.csv --signature 'hmac-sha256=<hex>'
```

Checks a downloaded audit-log export (CSV, JSON or PDF, unchanged) against the
`X-CoreMail-Signature` header of the export response
(`POST /api/v1/admin/audit-log/verify-export`). Prints `VALID` (exit 0) or
`INVALID` (exit 1). Exports signed before a key rotation (`AUDIT_EXPORT_SIGNING_KEY`,
or `JWT_SECRET`/`PEPPER` without it) are reported as invalid.

## Branding (`branding`, v9.3, organisation area)

```bash
coremail branding show                       # product name, colours, switches, asset URLs, version
coremail branding set --name "Acme Mail" --color "#0a5bd3" --header-color none \
  --allow-user-accent false --powered-by true --login-text "Welcome to Acme"
coremail branding upload logoLight ./logo.svg  # slots: logoLight, logoDark, favicon, loginBackground
coremail branding remove favicon             # back to the built-in default for that slot
coremail branding reset --yes                # everything back to the defaults (images deleted)
```

`set` sends only the options given (`PUT /api/v1/admin/branding`); `--name default` /
`--color default` return to `BRANDING_NAME` / `BRANDING_COLOR` (else "CoreMail" / `#0078d4`),
`--header-color none` uses the primary colour. A colour below 3:1 contrast on the light or dark
surface is saved but printed as a warning with a suggested colour. `upload` takes PNG, WebP or SVG
(≤ 512 KB; `loginBackground` also JPEG, ≤ 2 MB; favicon square); the content type comes from the
file extension and the server checks the bytes. Changes need ORGANIZATION_MANAGEMENT; `show` also
works for SERVER_MANAGEMENT and VIEW_ONLY_ORG. Details: [branding.md](branding.md).

## Protocol access (`protocol`, v9.4)

```bash
coremail protocol show                                         # server level
coremail protocol show --scope domain example.com              # domain level
coremail protocol show --scope user alice@example.com          # mailbox level
coremail protocol set --scope user alice@example.com --imap off --webmail inherit
```

Switches: `--imap --pop3 --smtp --activesync --jmap --dav --webmail --mapi`, each `on`, `off` or
`inherit` (the server level is `on` / `off` only); only the given ones change. The table shows the
setting (`inherit (on)` = what inherit resolves to) and the effective value. Server and domain level need
SERVER_MANAGEMENT (or ORGANIZATION_MANAGEMENT), the mailbox level RECIPIENT_MANAGEMENT. The server
level of `--jmap` is the same switch as `connector enable|disable jmap`. Details:
[protocol-access.md](protocol-access.md).

## Webmail policies (`policy`, v9.4)

```bash
coremail policy show                                           # server level
coremail policy show --scope domain example.com                # domain level
coremail policy set --scope user alice@example.com --calendar off --external-images block
coremail policy set --blocked-extensions exe,js,bat --save-only-extensions pdf --max-upload-mb 20
```

Modules: `--calendar --contacts --tasks --notes --rules --signatures --categories --recover-items
--change-password --themes --external-clients --app-passwords --shared-mailboxes --profile-photo`, each `on`, `off`
or `inherit` (the server level is `on` / `off` only). Values: `--blocked-extensions` and
`--save-only-extensions` (comma-separated list, `none` or `inherit`), `--max-upload-mb` (MB, `none` =
no own limit on the server level, `inherit` below), `--external-images ask|contacts|block|inherit`.
Only the given ones change. The table shows the setting, the effective value and its source
(`default`, `global`, `domain`, `user`). RBAC as for `protocol`. Details:
[webmail-policies.md](webmail-policies.md).

## Admin roles and management scopes (`role`, v9.5)

```bash
coremail role list --admins                                    # accounts with role and scope
coremail role set helpdesk@example.com HELP_DESK               # = user update --role
coremail role scope helpdesk@example.com example.com           # limit the role to domains
coremail role scope helpdesk@example.com --organisation        # organisation-wide again
coremail role me                                               # own role, areas and scope
```

`role set` and `role scope` are ORGANIZATION_MANAGEMENT only (the API refuses everyone else); a
change is audited and ends the web sessions of that account. Scopable roles: HELP_DESK,
RECIPIENT_MANAGEMENT, COMPLIANCE_MANAGEMENT, HYGIENE_MANAGEMENT, VIEW_ONLY_ORG. A scoped admin's CLI
sees only its domains. Details: [rbac.md](rbac.md).

## Behavior and exit codes

- Destructive commands ask for confirmation unless `--yes` is given; without a terminal (script) `--yes` is mandatory.
- Exit code 0 on success, 1 on error (message on stderr, with HTTP status for API errors).
- Every change appears in the BCP audit log with the logged-in admin as the actor.
