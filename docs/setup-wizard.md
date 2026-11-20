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
| 2 | Domain und Hostname | Primary mail domain, prefilled with the local domain `example.local` (10.5, see below); public host name (prefilled `mail.example.local`, follows the domain until edited); organisation name (optional and empty, `ServerSettings.orgName`). An info box explains: "CoreMail startet mit einer lokalen Domain und einem selbstsignierten Zertifikat. Deine echte Domain fügst du danach im BCP unter Domains hinzu und machst sie zur primären." (the product name follows the branding). For a local host name the hint under the field says that no public DNS record is needed. |
| 3 | Admin-Konto | Name, address in the chosen domain (local part + fixed `@domain`, suggested `admin@example.local`), password with a strength meter (at least 8 characters, like the server). For a local domain an info box says that mail from outside cannot be delivered to that address (signing in works). Two-factor sign-in is explained, not set up here: the box says it is required for the BCP (10.5) and is set up in the webmail right after the wizard (Settings → Security; the last step links there). |
| – | *Einrichten* | Leaving the admin step runs `POST /api/v1/setup/complete` and signs in with the new account through the normal `/auth/login` (refresh cookie, same lockout and audit rules as the login page). The password and the token are dropped from the page afterwards. |
| 4 | Secrets sichern | Only when the status reports `secretsGenerated: true`. Button **Secrets herunterladen** downloads the secrets file as `coremail-secrets-<host>-<YYYY-MM-DD>.env` (`GET /api/v1/setup/secrets-download`, below). Next to it, when the page was not loaded over HTTPS (`secureConnection: false` in the status), one line: "Die Verbindung ist unverschlüsselt — lade die Datei nur im lokalen Netz herunter." — the download still works. The warning that no password works without the PEPPER stays, plus one line where the file lives on the server (`secretsFile`, default `./secrets/coremail.env`, next to the Compose file). No shell commands, never secret values on the page. "Weiter" only after the checkbox "Ich habe die Datei gesichert"; the checkbox may be ticked without downloading (some admins copy the file on the server themselves). |
| 5 | Fertig | Summary (domain, host name, admin), the line "DNS-Einträge und Zertifikat richtest du im BCP unter Domains und Zertifikate ein" with both names linking to `/bcp/domains` and `/bcp/certificates`, an info box (10.5) "Das BCP öffnet sich erst, wenn die Zwei-Faktor-Anmeldung eingerichtet ist …", and links: webmail, BCP (new tab), mail client setup (Settings → External clients), two-factor sign-in. Reaching this step calls `POST /api/v1/setup/finish`, which closes the secrets download. |

"Schritt x von n" counts the shown steps (4 without, 5 with the secrets step).

### Local domain first (10.5)

The wizard always sets CoreMail up with a **local domain and a self-signed certificate** first;
the real public domain is added afterwards in the BCP. The domain step is prefilled with
`example.local` / `mail.example.local` (`SUGGESTED_DOMAIN`, `INITIAL_FORM` in
`lib/setupWizard.ts`), so the wizard completes without any DNS record. A real domain may still be
typed in — the input checks are the same for public and private names.

- **Private / local names** (shared pure helper `isLocalHostname`, three identical copies kept in
  step by a parity test: `packages/api-gateway/src/lib/local-hostname.ts`,
  `packages/web-client/src/lib/localHostname.ts`, `packages/admin-panel/src/lib/localHostname.ts`):
  names under `.local`, `.lan`, `.internal`, `.home.arpa`, `.test`, `.localdomain`, `.localhost`,
  single labels, and bare IPv4 / IPv6 addresses.
- **`POST /api/v1/setup/complete`** accepts these suffixes like any domain. The domain still gets
  its DKIM key; the host name gets the self-signed certificate (assigned to SMTP/IMAP/POP3 and
  stored in `ServerSettings.tlsCert`); the HTTPS server is told to reload (`coremail:tls:reload`)
  and then serves that certificate for the host name. Nothing in the setup needs public DNS.
- **Dashboard card**: for a local host name the BCP card shows **„Eigene Domain hinzufügen“**
  instead of a Let's Encrypt button — three steps (Domain anlegen → als primär festlegen →
  Zertifikat anfordern) and a link to **Domains**; "Später" hides it like the certificate card
  ([certificates.md](certificates.md#dashboard-card-zertifikat-einrichten)).
- **Make primary**: `POST /api/v1/admin/domains/:id/make-primary` (and renaming the primary
  domain) replaces a local public host name with `mail.<new domain>` when the new primary domain
  is a public one, re-derives the client URLs (`lib/server-urls.ts primaryDomainHostname`) and
  clears "Später" of the card, which then offers the Let's Encrypt certificate for the new host
  name. A public host name the admin configured stays as before; a local name stays when the new
  primary domain is local too. The self-signed certificate of the local name stays in place until
  the Let's Encrypt certificate takes over SMTP/IMAP/POP3 and HTTPS.

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
  current role from the database; 10.5: `requireRoleInSetupWindow()`, i.e. without the admin-MFA
  rule, see "Admin MFA on fresh installations" below) — otherwise `401` / `403`.
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

## Admin MFA on fresh installations (10.5)

`POST /api/v1/setup/complete` stores `ServerSettings.requireMfaForAdmins = true` together with the
first domain and admin. Only fresh installations pass through it: an existing installation keeps
its stored value on upgrade (schema default `false`; the start-up backfill of pre-v6
installations sets only the setup flags) — no silent lock-out.

The flow after the wizard, without a dead end:

1. The wizard's session (password only) still reaches the secrets download and `/setup/finish`
   (`requireRoleInSetupWindow()`: role checks as usual, no admin-MFA rule; both routes only work
   inside the setup window).
2. The summary says the BCP opens only after the second factor is set up and links to
   Webmail → Settings → Security. The webmail is not affected by `requireMfaForAdmins`, so the
   admin enrols TOTP or a security key there (`/auth/mfa` is outside the admin API).
3. Until then every admin API call answers `403 MFA_REQUIRED` and the BCP shows its MFA page
   (`/bcp/mfa-required`: explanation, a link to the webmail's security settings, "Erneut prüfen",
   sign-out).
4. After the enrolment the BCP session is not MFA-verified (`403 MFA_NOT_VERIFIED`), so the BCP
   asks for a new sign-in, now with the second factor.

The switch stays in BCP → Einstellungen → Sicherheit ("MFA für Administratoren"); every change of
it is audited (`settings.mfa-policy.update`). With Webmail switched off for the admin account
(protocol switches) the webmail sign-in is refused — keep Webmail on for admins until they have
enrolled. The optional "MFA für alle Benutzer erzwingen" is described in
[user-settings.md](user-settings.md#mfa-enforcement-105).

## Tests

- `packages/web-client/src/lib/setupWizard.test.ts` — which steps show, commit step, "Weiter"
  gating (checkbox without download), navigation after the commit, input checks, password
  meter, request body, unencrypted-connection rule, download file name, resume marker.
- `packages/api-gateway/src/routes/setup.test.ts` — token required, read-only token check,
  closed after completion, new fields, `secureConnection`, backfill closes the download, staged
  copy removed at start once the window is closed.
- `packages/api-gateway/src/routes/setup.test.ts` (10.5) — `/complete` sets `requireMfaForAdmins`;
  the backfill of an existing installation leaves the stored value alone; `example.local` gets the
  admin, a DKIM key and the self-signed certificate (SMTP/IMAP/POP3, TLS reload), the other
  private suffixes are accepted.
- `packages/web-client/src/lib/setupWizard.test.ts` (10.5) — `example.local` defaults, private
  suffixes pass the checks, local-domain detection.
- `packages/api-gateway/src/lib/local-hostname.test.ts` — local / private names and the parity of
  the three copies; `src/lib/server-urls.test.ts` and `src/routes/admin/domains-admin.test.ts` —
  make-primary replaces the local host name, keeps an explicit public one;
  `src/routes/admin/setup-state.test.ts` — the card for a local host name;
  `packages/admin-panel/src/lib/certificateCard.test.ts` — card variant.
- `packages/api-gateway/src/routes/setup-followup.test.ts` — (10.5) the wizard session without
  MFA still downloads and finishes with `requireMfaForAdmins` on; session and role required, window
  (24 h, finished, not completed), absent file / symlink, headers, audit without content (also
  with the audit log off), no content in the log, staged copy served and removed (never the real
  file), rate limit.
