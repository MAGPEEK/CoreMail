# First-run setup wizard

A fresh installation (no setup completed, no user) sends every web request to the setup
wizard at `/setup` (webmail; the BCP at `/bcp/` forwards there). The wizard walks the
administrator through the whole setup. Code: `packages/web-client/src/pages/SetupPage.tsx`,
step logic `packages/web-client/src/lib/setupWizard.ts`, server `packages/api-gateway/src/routes/setup.ts`
and `packages/api-gateway/src/routes/admin/setup-state.ts`.

## Steps

| # | Step | What happens |
|---|------|--------------|
| 1 | Willkommen | Short explanation and the one-time **setup token**. "Weiter" checks the token with `POST /api/v1/setup/verify-token` (read-only). The hint names `./secrets/setup-token` when the server reports a secrets file (`secretsFile` in the status), otherwise the container log command and `SETUP_TOKEN`. |
| 2 | Domain und Hostname | Primary mail domain, public host name (default `mail.<domain>`, follows the domain until edited), organisation name (optional, `ServerSettings.orgName`). |
| 3 | Admin-Konto | Name, address in the chosen domain (local part + fixed `@domain`), password with a strength meter (at least 8 characters, like the server). Two-factor sign-in is only offered: a note that it can be set up later under Settings → Security; the last step links there. |
| 4 | Secrets sichern | Only when the status reports `secretsGenerated: true`. Shows the path of the secrets file (`secretsFile`, default `./secrets/coremail.env`), a copyable `cp` and `tar` command and the warning that no password works without the PEPPER. Never shows secret values. "Weiter" only after the checkbox "Ich habe die Datei gesichert". |
| – | *Einrichten* | Leaving the last of the steps above runs `POST /api/v1/setup/complete` and signs in with the new account through the normal `/auth/login` (refresh cookie, same lockout and audit rules as the login page). The password and the token are dropped from the page afterwards. |
| 5 | DNS | The records of the new domain from the BCP domain DNS check (`GET /api/v1/admin/domains/:id/dns-check`): required A (host name), MX, SPF, DKIM (the key exists now), recommended DMARC and PTR, plus a note on AAAA. Per record: name and value to copy, status found / missing / different. "Erneut prüfen" repeats the check; the primary button reads "Später" while required records are missing. |
| 6 | Zertifikat | (a) **Let's Encrypt** — offered only when the A and MX checks passed; runs the BCP flow: `GET /admin/certificates/acme-suggestions` → `POST /admin/certificates/preflight` (up to 90 s, problems are listed) → `POST /admin/certificates/letsencrypt` → polls `GET /admin/certificates/:id`. Ordered without mail services, so the issued certificate for the public host name takes over SMTP/IMAP/POP3 and HTTPS automatically while the self-signed default is in use. (b) **TLS macht mein Reverse Proxy** — nothing is activated (the integrated HTTPS server keeps no certificate; mail ports keep the self-signed certificate until one is assigned in the BCP). (c) **Später** — the BCP dashboard shows a dismissible hint. Every choice is stored with `PUT /api/v1/admin/setup-state/certificate-choice`. |
| 7 | Fertig | Summary (domain, host name, admin, DNS state, certificate choice) and links: webmail, BCP (new tab), mail client setup (Settings → External clients), two-factor sign-in. |

"Schritt x von n" counts the shown steps (6 without, 7 with the secrets step).

### Order decisions

- The domain and its DKIM key are created by `setup/complete`, so the commit happens **before**
  the DNS step — the DNS step always shows real records (including the DKIM key) and the live
  check runs with the admin session.
- The secrets backup comes **before** the commit: the backup is confirmed before anything is
  stored that depends on the PEPPER.
- After the commit, "Zurück" never leads into the steps before it (the token is spent). DNS,
  certificate and the summary can be revisited.
- If the automatic sign-in fails after the commit, the wizard goes straight to the summary with
  a note to finish DNS and the certificate in the BCP.

### Reload

After the commit the wizard keeps a per-tab marker in `sessionStorage`
(`coremail:setup-wizard`: step, domain, host name, address, certificate choice — no password,
no token). A reload of `/setup` in that tab resumes the post-commit step as long as the admin
session is valid; otherwise it goes to the sign-in page. Other tabs see a completed setup and
are sent to `/login` as before.

## Server

| Endpoint | Before completion | After completion |
|---|---|---|
| `GET /api/v1/setup/status` | `{ setupRequired, setupTokenRequired }` (+ `secretsFile`, `secretsGenerated` when the secrets bootstrap provides them; the wizard tolerates their absence) | `setupRequired: false` |
| `POST /api/v1/setup/verify-token` | setup token required (`setupToken` in the body or `X-Setup-Token`); `200 { valid: true }` / `403 SETUP_TOKEN_INVALID`; changes nothing, never echoes the token | `409` |
| `POST /api/v1/setup/complete` | setup token required; one atomic, one-time claim (unchanged); new optional fields `hostname`, `organizationName`, `displayName`; answers `{ success, email, domain, hostname }` | `409` |
| `GET /api/v1/admin/setup-state` | — | admin session, area `servers` read: `{ certificateChoice, certificateHint }` |
| `PUT /api/v1/admin/setup-state/certificate-choice` | — | area `servers` write: `{ choice: letsencrypt \| proxy \| later }` (idempotent; a new choice shows the hint again) |
| `POST /api/v1/admin/setup-state/certificate-hint/dismiss` | — | area `servers` write: hides the dashboard hint |

Every POST under `/api/v1/setup` shares the setup rate limit (5 per hour and client IP); the
admin routes use the admin session, the admin mutation limit and the admin audit log. The
dashboard hint (`certificateHint`) shows only after "Später", until a trusted certificate
(not self-signed, not Let's Encrypt staging, active) exists or an admin dismisses it.

Schema (additive): `ServerSettings.setupCertificateChoice` (`String?`, null = never asked,
e.g. installations from before 10.4) and `ServerSettings.setupCertificateHintDismissedAt`
(`DateTime?`).

## Tests

- `packages/web-client/src/lib/setupWizard.test.ts` — which steps show, "Weiter" gating,
  navigation after the commit, input checks, password meter, request body, DNS / Let's Encrypt
  gating, resume marker.
- `packages/api-gateway/src/routes/setup.test.ts` — token required, read-only token check,
  closed after completion, new fields, no password / token in answers, one-time claim.
- `packages/api-gateway/src/routes/admin/setup-state.test.ts` — RBAC, validation, idempotence,
  hint logic.
