# First-run setup wizard

A fresh installation (no setup completed, no user) sends every web request to the setup
wizard at `/setup` (webmail; the BCP at `/bcp/` forwards there). The wizard creates the
installation and the first administrator; for a **public** host name it also obtains a Let's
Encrypt certificate (10.6, step "Zertifikat" below). DNS records are set up afterwards in the BCP
(**Domains**); a local host name keeps its self-signed certificate and the dashboard card
([certificates.md](certificates.md#dashboard-card-zertifikat-einrichten)).
Code: `packages/web-client/src/pages/SetupPage.tsx`, step logic
`packages/web-client/src/lib/setupWizard.ts` and `lib/setupCertificate.ts`, the certificate step
`components/setup/CertificateStep.tsx`, server `packages/api-gateway/src/routes/setup.ts`
and `packages/api-gateway/src/routes/setup-followup.ts` (+ `lib/setup-certificate.ts`,
`lib/acme-order.ts`).

## Steps

| # | Step | What happens |
|---|------|--------------|
| 1 | Willkommen | Short explanation and the one-time **setup token**. "Weiter" checks the token with `POST /api/v1/setup/verify-token` (read-only). The hint names `./secrets/setup-token` when the server reports a secrets file (`secretsFile` in the status), otherwise the container log command and `SETUP_TOKEN`. |
| 2 | Domain und Hostname | Primary mail domain, prefilled with the local domain `example.local` (10.5, see below); public host name (prefilled `mail.example.local`, follows the domain until edited); organisation name (optional and empty, `ServerSettings.orgName`). An info box explains: "CoreMail startet mit einer lokalen Domain und einem selbstsignierten Zertifikat. Deine echte Domain fügst du danach im BCP unter Domains hinzu und machst sie zur primären." (the product name follows the branding). For a local host name the hint under the field says that no public DNS record is needed. |
| 3 | Admin-Konto | Name, address in the chosen domain (local part + fixed `@domain`, suggested `admin@example.local`), password with a strength meter (at least 8 characters, like the server). For a local domain an info box says that mail from outside cannot be delivered to that address (signing in works). Two-factor sign-in is explained, not set up here: the box says it is required for the BCP (10.5) and is set up in the webmail right after the wizard (Settings → Security; the last step links there). |
| – | *Einrichten* | Leaving the admin step runs `POST /api/v1/setup/complete` and signs in with the new account through the normal `/auth/login` (refresh cookie, same lockout and audit rules as the login page). The password and the token are dropped from the page afterwards. |
| 4 | Secrets sichern | Only when the status reports `secretsGenerated: true`. Button **Secrets herunterladen** downloads the secrets file as `coremail-secrets-<host>-<YYYY-MM-DD>.env` (`GET /api/v1/setup/secrets-download`, below). Next to it, when the page was not loaded over HTTPS (`secureConnection: false` in the status), one line: "Die Verbindung ist unverschlüsselt — lade die Datei nur im lokalen Netz herunter." — the download still works. The warning that no password works without the PEPPER stays, plus one line where the file lives on the server (`secretsFile`, default `./secrets/coremail.env`, next to the Compose file). No shell commands, never secret values on the page. "Weiter" only after the checkbox "Ich habe die Datei gesichert"; the checkbox may be ticked without downloading (some admins copy the file on the server themselves). |
| 5 | Zertifikat | 10.6, only for a **public** host name (`showCertificateStep`: not `isLocalHostname` — `mail.example.local`, `.lan`, IPs, … skip it) and only with the admin session. See "Certificate step" below. |
| 6 | Fertig | Summary (domain, host name, admin; "Zertifikat: Let's Encrypt (aktiv)" when the certificate step issued one), the line "DNS-Einträge und Zertifikat richtest du im BCP unter Domains und Zertifikate ein" with both names linking to `/bcp/domains` and `/bcp/certificates`, an info box (10.5) "Das BCP öffnet sich erst, wenn die Zwei-Faktor-Anmeldung eingerichtet ist …", and links: webmail, BCP (new tab), mail client setup (Settings → External clients), two-factor sign-in. Reaching this step calls `POST /api/v1/setup/finish`, which closes the secrets download. |

"Schritt x von n" counts the shown steps (4 to 6: the secrets and the certificate step are optional).
Before the commit the typed host name decides whether the certificate step is counted; after it
the stored decision (public host name and a working admin session).

### Certificate step (10.6)

For a public host name the wizard tries to obtain a Let's Encrypt certificate right after the
admin step (and after "Secrets sichern" when shown):

- **Names**: the host name plus `autodiscover.<domain>` / `autoconfig.<domain>` of the primary
  domain **only when their DNS points to this server** — decided by the server with the same helper
  as the certificates dialog and the dashboard card (`suggestAdditionalSans` →
  `lib/acme-order.ts orderDomains`). A name that is left out is named with the reason.
- **Kontakt-E-Mail für Let's Encrypt**: prefilled with `ServerSettings.adminEmail`, else the admin
  address of the wizard; checked as an e-mail address (same rule as the server). The note says that
  Let's Encrypt sends expiry notices there. Stored as `Certificate.acmeEmail` — the contact of
  the ACME account registration (`mailto:`) and of every later renewal.
- **Terms of service**: a required checkbox linking to the CA's current terms
  (`meta.termsOfService` of the production ACME directory, cached for an hour; when the directory
  cannot be read: `https://letsencrypt.org/repository/`). The server refuses an order without
  `termsAccepted: true`.
- **„Zertifikat anfordern“** runs the BCP pre-flight (DNS A/AAAA, IPv6, same address as the host
  name, CAA, the validation file locally and over the public name, and the Let's Encrypt staging
  test over port 80) and shows every check with its status and a plain explanation. Only when it
  passes is the certificate ordered (production, with SMTP/IMAP/POP3 — the issuance assigns them,
  `afterAcmeIssued`); the wizard shows the phases and polls the order. Once issued the server
  also serves it on HTTPS (`activateHttpsCertificate`, the same as the dashboard card's last
  step); the step reports done only when HTTPS serves it.
- **Failure**: the reason in plain German (per failed check, or per classified ACME error code such
  as `connection`, `dns`, `caa`, `rate-limited`), the server's message under "Technische
  Details", plus **„Erneut prüfen“** (runs the pre-flight again; a failed order is retried on the
  same certificate row and ACME account with the current names and contact) and **„Später“** (to
  the summary — the BCP dashboard card stays until a trusted certificate covers the host name).
  "Später" also works while Let's Encrypt validates; the order then finishes on the server.
- **Local host names** (`example.local` default) have no certificate step — unchanged 10.5
  behaviour (self-signed certificate, dashboard card "Eigene Domain hinzufügen").

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
the run and its checkbox, 10.6: whether the certificate step is part of the run — no password,
no token, no secret). A reload of `/setup` in that tab resumes the post-commit step as long as
the admin session is valid; otherwise it goes to the sign-in page. A reload of the certificate step
finds the running order again (`GET /setup/certificate/status`) and keeps waiting for it. A
marker of 10.4.0/10.4.1 (DNS or certificate step, without `withCertificate`) resumes at the
summary. Other tabs see a completed setup and are sent to `/login` as before.

## Server

| Endpoint | Before completion | After completion |
|---|---|---|
| `GET /api/v1/setup/status` | `{ setupRequired, setupTokenRequired, secretsFile, secretsGenerated, secureConnection }` (`secureConnection` = `req.secure`: TLS socket or `X-Forwarded-Proto` from a `TRUST_PROXY`-trusted proxy; the wizard tolerates missing fields of older servers) | `setupRequired: false` (other fields as before) |
| `POST /api/v1/setup/verify-token` | setup token required (`setupToken` in the body or `X-Setup-Token`); `200 { valid: true }` / `403 SETUP_TOKEN_INVALID`; changes nothing, never echoes the token | `409` |
| `POST /api/v1/setup/complete` | setup token required; one atomic, one-time claim; optional fields `hostname`, `organizationName`, `displayName`; answers `{ success, email, domain, hostname }` | `409` |
| `GET /api/v1/setup/secrets-download` | `401` (no session yet) | see below |
| `POST /api/v1/setup/finish` | `401` | admin session (ORGANIZATION_MANAGEMENT); sets `ServerSettings.setupWizardFinishedAt` once (idempotent), deletes the staged copy; `204` |
| `GET /api/v1/setup/certificate/status` | `401` | 10.6, see "Certificate endpoints" |
| `POST /api/v1/setup/certificate/preflight` | `401` | 10.6 |
| `POST /api/v1/setup/certificate/issue` | `401` | 10.6 |

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

### Certificate endpoints (10.6)

`routes/setup-followup.ts`, same guard and window as the secrets download:
`requireRoleInSetupWindow()` (ORGANIZATION_MANAGEMENT, organisation-wide, current role from the
database, **without** the admin-MFA rule) and only while the setup window is open (completed,
wizard not finished, ≤ 24 h) — otherwise `404`. The admin certificate API
(`/api/v1/admin/certificates/*`) keeps the admin-MFA rule and answers `403 MFA_REQUIRED` to the
wizard's session; these routes call the same functions instead (`lib/acme-order.ts`:
`acmeSuggestions`, `preflightForServer`, `requestLetsEncryptCertificate`,
`activateHttpsCertificate` → `lib/cert-renewal.ts startRenewal` → `lib/cert-acme.ts
runAcmeIssuance`) — no second ACME implementation.

| Endpoint | Answer |
|---|---|
| `GET /certificate/status` | `{ eligible, hostname, domains, sans, contactEmail, termsOfServiceUrl, termsOfServiceFromDirectory, certificate }`; `certificate` is the newest production Let's Encrypt order for the host name created after `setupCompletedAt` (`{ id, status, domains, lastError, lastErrorCode, httpsActive, protocolActive, expiresAt }`) or `null`. `?view=certificate` (polling) answers only `{ eligible, hostname, certificate }` without DNS look-ups. |
| `POST /certificate/preflight` | `{ domains, report }` — the BCP pre-flight report incl. the staging test (`external`). `409 LOCAL_HOSTNAME` for a local / private host name. |
| `POST /certificate/issue` | body `{ email, termsAccepted: true }` (`400 INVALID_EMAIL` / `400 TERMS_REQUIRED`, `409 LOCAL_HOSTNAME`). `202 { certificate }`: a new order (PENDING), a retry of a failed setup order (same row and ACME account, `409 BUSY` when its lock is held) or the running one. Idempotent: for an already issued setup certificate it only makes sure HTTPS serves it (`200`). Once the issuance succeeds the server assigns HTTPS by itself. |

- **Audit** (always, also with the audit log off — `ALWAYS_AUDIT` `setup.certificate.`):
  `setup.certificate.preflight` (names, result), `setup.certificate.issue` (names, contact
  e-mail, retry), `setup.certificate.https` (HTTPS assignment after the issuance); refused
  POSTs outside the window with `success: false`.
- **Rate limits**: pre-flight and order 20 per hour and client IP (`setupCertificateRateLimit` —
  each pre-flight runs a staging validation, failed validations count against Let's Encrypt's
  limit of 5 per host name and hour); status 300 per 15 minutes (`setupCertificateStatusRateLimit`).
- **Not verified live**: the unit tests run the real ACME code path against a fake CA (no
  network); issuing from the real Let's Encrypt needs a public host name with DNS and port 80 —
  see [certificates.md](certificates.md#setup-wizard-105--106).

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
2. The summary says the second factor is required for the BCP and links to
   Webmail → Settings → Security. The webmail is not affected by `requireMfaForAdmins`, so the
   admin enrols TOTP or a security key there (`/auth/mfa` is outside the admin API).
3. 10.6: the admin rule starts with an admin grace period (at most 14 days, default 14 —
   docs/mfa-policy.md): until it ends the BCP works and shows a dismissible prompt
   ("Jetzt einrichten" / "Später"; the webmail shows it too). After the deadline every admin API
   call answers `403 MFA_REQUIRED` and the BCP shows its MFA page (`/bcp/mfa-required`:
   explanation, a link to the webmail's security settings, "Erneut prüfen", sign-out).
4. After the enrolment the BCP session is not MFA-verified (`403 MFA_NOT_VERIFIED`), so the BCP
   asks for a new sign-in, now with the second factor.

10.6: the switch is the admin rule on BCP → Authentifizierung → Mehrstufige Anmeldung (MFA)
("Administratoren: Pflicht"); every change of it is audited (`settings.mfa-policy.update`). With Webmail switched off for the admin account
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
- (10.6) `packages/web-client/src/lib/setupWizard.test.ts` — certificate step order and visibility
  (public vs. local host names), contact e-mail check and terms gating, resume marker;
  `src/lib/setupCertificate.test.ts` — pre-flight before the order (nothing ordered when it
  fails), the order body, done only once HTTPS serves it, failure reasons, HTTPS re-requested after
  a restart, timeout.
- (10.6) `packages/api-gateway/src/routes/setup-certificate.test.ts` — auth (401/403, the
  wizard session without MFA works, the admin certificate API still answers `MFA_REQUIRED`),
  window closed → 404 (audited), local host names → `LOCAL_HOSTNAME`, e-mail / terms validation,
  names (autodiscover. when its DNS points here, not autoconfig. without DNS), the contact on the
  ACME account registration, production directory, SMTP/IMAP/POP3 then HTTPS after the issuance,
  audit, failure + retry on the same row, terms of service from the directory with fallback, rate
  limits — fake CA, resolver and challenge serving.
- `packages/api-gateway/src/routes/setup-followup.test.ts` — (10.5) the wizard session without
  MFA still downloads and finishes with `requireMfaForAdmins` on; session and role required, window
  (24 h, finished, not completed), absent file / symlink, headers, audit without content (also
  with the audit log off), no content in the log, staged copy served and removed (never the real
  file), rate limit.
