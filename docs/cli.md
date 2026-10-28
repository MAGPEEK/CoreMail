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
coremail user set-password john@example.com [--password …]
coremail user delete john@example.com [--yes]
```

Without `--password` the CLI prompts interactively (without echo); alternatively `COREMAIL_NEW_PASSWORD`.
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
| `mapi` | MAPI over HTTP + EWS (`/mapi`, `/EWS`) — switch in the server settings |

```bash
coremail connector status                    # all services, ports, TLS, state
coremail connector disable pop3              # all POP3 listeners off
coremail connector enable pop3 --port 995    # a single port only
coremail connector enable jmap | disable mapi

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

## Behavior and exit codes

- Destructive commands ask for confirmation unless `--yes` is given; without a terminal (script) `--yes` is mandatory.
- Exit code 0 on success, 1 on error (message on stderr, with HTTP status for API errors).
- Every change appears in the BCP audit log with the logged-in admin as the actor.
