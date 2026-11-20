# First-run setup wizard

A fresh installation (no setup completed, no user) sends every web request to the setup
wizard at `/setup` (webmail; the BCP at `/bcp/` forwards there). The wizard creates the
installation and the first administrator; DNS records and the TLS certificate are set up
afterwards in the BCP (**Domains**, **Zertifikate** — the dashboard offers a one-click Let's
Encrypt certificate, see [certificates.md](certificates.md#dashboard-card-zertifikat-einrichten)).
Code: `packages/web-client/src/pages/SetupPage.tsx`, step logic
`packages/web-client/src/lib/setupWizard.ts`, server `packages/api-gateway/src/routes/setup.ts`
and `packages/api-gateway/src/routes/setup-followup.ts`.

## Steps

| # | Step | What happens |
|---|------|--------------|
| 1 | Willkommen | Short explanation and the one-time **setup token**. "Weiter" checks the token with `POST /api/v1/setup/verify-token` (read-only). The hint names `./secrets/setup-token` when the server reports a secrets file (`secretsFile` in the status), otherwise the container log command and `SETUP_TOKEN`. |
| 2 | Domain und Hostname | Primary mail domain, public host name (default `mail.<domain>`, follows the domain until edited), organisation name (optional, `ServerSettings.orgName`). |
| 3 | Admin-Konto | Name, address in the chosen domain (local part + fixed `@domain`), password with a strength meter (at least 8 characters, like the server). Two-factor sign-in is only offered: a note that it can be set up later under Settings → Security; the last step links there. |
| – | *Einrichten* | Leaving the admin step runs `POST /api/v1/setup/complete` and signs in with the new account through the normal `/auth/login` (refresh cookie, same lockout and audit rules as the login page). The password and the token are dropped from the page afterwards. |
| 4 | Secrets sichern | Only when the status reports `secretsGenerated: true`. Button **Secrets herunterladen** downloads the secrets file as `coremail-secrets-<host>-<YYYY-MM-DD>.env` (`GET /api/v1/setup/secrets-download`, below). Next to it, when the page was not loaded over HTTPS (`secureConnection: false` in the status), one line: "Die Verbindung ist unverschlüsselt — lade die Datei nur im lokalen Netz herunter." — the download still works. The warning that no password works without the PEPPER stays, plus one line where the file lives on the server (`secretsFile`, default `./secrets/coremail.env`, next to the Compose file). No shell commands, never secret values on the page. "Weiter" only after the checkbox "Ich habe die Datei gesichert"; the checkbox may be ticked without downloading (some admins copy the file on the server themselves). |
| 5 | Fertig | Summary (domain, host name, admin), the line "DNS-Einträge und Zertifikat richtest du im BCP unter Domains und Zertifikate ein" with both names linking to `/bcp/domains` and `/bcp/certificates`, and links: webmail, BCP (new tab), mail client setup (Settings → External clients), two-factor sign-in. Reaching this step calls `POST /api/v1/setup/finish`, which closes the secrets download. |

"Schritt x von n" counts the shown steps (4 without, 5 with the secrets step).

### Order decisions

- The commit happens when leaving the admin step: the secrets download needs the admin session
  the wizard signs in with after `setup/complete`.
- After the commit, "Zurück" never leads into the steps before it (the token is spent), and the
  summary has no way back (the download is closed by then).
- If the automatic sign-in fails after the commit, the secrets step shows no download button
  (only the note to back up the file on the server) and the summary asks to sign in.

### Reload

After the commit the wizard keeps a per-tab marker in `sessionStorage`
(`coremail:setup-wizard`: step, domain, host name, address, whether the secrets step is part of
the run and its checkbox — no password, no token, no secret). A reload of `/setup` in that tab
resumes the post-commit step as long as the admin session is valid; otherwise it goes to the
sign-in page. A marker of 10.4.0/10.4.1 (DNS or certificate step) resumes at the summary. Other
tabs see a completed setup and are sent to `/login` as before.

## Server

| Endpoint | Before completion | After completion |
|---|---|---|
| `GET /api/v1/setup/status` | `{ setupRequired, setupTokenRequired, secretsFile, secretsGenerated, secureConnection }` (`secureConnection` = `req.secure`: TLS socket or `X-Forwarded-Proto` from a `TRUST_PROXY`-trusted proxy; the wizard tolerates missing fields of older servers) | `setupRequired: false` (other fields as before) |
| `POST /api/v1/setup/verify-token` | setup token required (`setupToken` in the body or `X-Setup-Token`); `200 { valid: true }` / `403 SETUP_TOKEN_INVALID`; changes nothing, never echoes the token | `409` |
| `POST /api/v1/setup/complete` | setup token required; one atomic, one-time claim; optional fields `hostname`, `organizationName`, `displayName`; answers `{ success, email, domain, hostname }` | `409` |
| `GET /api/v1/setup/secrets-download` | `401` (no session yet) | see below |
| `POST /api/v1/setup/finish` | `401` | admin session (ORGANIZATION_MANAGEMENT); sets `ServerSettings.setupWizardFinishedAt` once (idempotent), deletes the staged copy; `204` |

### Secrets download

`GET /api/v1/setup/secrets-download` (`routes/setup-followup.ts`):

- **Admin session** with the role ORGANIZATION_MANAGEMENT, organisation-wide (`requireRole()`:
  current role from the database, admin MFA rule) — otherwise `401` / `403`.
- **Only inside the setup window**: setup completed, `setupWizardFinishedAt` not set, and at most
  24 h after `setupCompletedAt` (`lib/setup-secrets.ts secretsDownloadWindowOpen`). Outside it —
  and when there is no readable file — `404 { error: "Not found" }`, like an unknown route.
- **The file**: the image keeps `<COREMAIL_SECRETS_DIR>/coremail.env` (default `/secrets`)
  root-only (0600). When the secrets were generated, the entrypoint stages a byte-identical copy
  owned by user `node` at `/tmp/coremail-setup-secrets/coremail.env` (inside the container, never
  on the host mount) and names it in `COREMAIL_SECRETS_DOWNLOAD_FILE`; the api-gateway deletes
  that copy on `POST /setup/finish`, on any download request outside the window and at every start
  once the window is closed. Without the variable (development, a container running as the file's
  owner) the real file is read — and never deleted. Symlinks are not followed; at most 64 KiB.
- **Answer**: `Content-Type: text/plain; charset=utf-8`,
  `Content-Disposition: attachment; filename="coremail-secrets-<host>-<YYYY-MM-DD>.env"`,
  `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
- **Audit**: every download — and every refused attempt of a signed-in admin (`success: false`)
  — is written as `setup.secrets.download`, also with the audit log switched off (`ALWAYS_AUDIT`).
  Neither the audit entry nor the log contains the file content.
- **Rate limit**: `/secrets-download` and `/finish` have their own limit (10 requests per hour
  and client IP, `setupFollowUpRateLimit`) and are mounted before the setup router, so they never
  use up the budget of `/verify-token` + `/complete` (5 POSTs per hour and client IP).

Schema (additive): `ServerSettings.setupWizardFinishedAt` (`DateTime?`). Installations whose setup
flag is backfilled at start (users from before v6) get it together with `setupCompletedAt`, so
their window never opens. `ServerSettings.setupCertificateChoice` (10.4 certificate step) is
unused since 10.4.2 and kept (additive schema policy);
`setupCertificateHintDismissedAt` now stores "Später" of the dashboard card.

## Tests

- `packages/web-client/src/lib/setupWizard.test.ts` — which steps show, commit step, "Weiter"
  gating (checkbox without download), navigation after the commit, input checks, password
  meter, request body, unencrypted-connection rule, download file name, resume marker.
- `packages/api-gateway/src/routes/setup.test.ts` — token required, read-only token check,
  closed after completion, new fields, `secureConnection`, backfill closes the download, staged
  copy removed at start once the window is closed.
- `packages/api-gateway/src/routes/setup-followup.test.ts` — session and role required, window
  (24 h, finished, not completed), absent file / symlink, headers, audit without content (also
  with the audit log off), no content in the log, staged copy served and removed (never the real
  file), rate limit.
