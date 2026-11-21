# Certificates (SSL/TLS)

BCP → **Server → SSL/TLS** manages every certificate of the server: Let's Encrypt (ACME
HTTP-01), uploaded (PEM + chain) and self-signed ones. Two independent bindings exist:

| Binding | Used by | How it is set |
|---|---|---|
| **Mail protocols** | SMTP (25 / 465 / 587), IMAP (993 / 143), POP3 (995 / 110) | assigning the services **SMTP / IMAP / POP3** to a certificate |
| **HTTPS proxy** | port 443 (web client, BCP, ActiveSync, DAV, JMAP, autodiscover) | lock icon; every valid certificate is additionally served by SNI |

## Mail protocols — the services are the switch (9.3)

Assigning SMTP/IMAP/POP3 to a certificate (edit dialog, upload, self-signed form,
`PUT /api/v1/admin/certificates/:id` with `services`) **applies it immediately**: the
certificate becomes the protocol certificate (`isActiveProtocol`), its full chain is written to
`server_settings.tlsCert`, the previous protocol certificate is released and SMTP/IMAP/POP3
reload their TLS context (Redis `settings:reload`, plus `coremail:tls:reload` for the HTTPS proxy).
Every switch is written to the audit log as `certificate.protocol.switch` (who, from, to, why).

- SMTP, IMAP and POP3 always share **one** certificate. The BCP dialogs (order, upload, self-signed,
  edit) show them as one switch **Mail-Protokolle (SMTP · IMAP · POP3)**; the API still accepts a
  `services` array — any mail service assigns all three.
- A certificate that is not usable yet (Let's Encrypt still pending) keeps the assignment; it is
  applied as soon as the issuance succeeds (the mail ports keep their current certificate until then).
- **Removing** the services from the protocol certificate switches SMTP/IMAP/POP3 back to the
  **self-signed default** for the public host name (an existing self-signed certificate for that
  name is reused, otherwise one is generated). The self-signed default itself cannot be left
  without the services (`409 PROTOCOL_CERT_REQUIRED`) — assign them to another certificate instead.
- Deleting the protocol certificate also falls back to the self-signed default.
- Assigning the services to an issued certificate whose PEM is expired or not yet valid is refused
  (`400 CERT_NOT_VALID`) instead of storing a label the servers never serve.
- A Let's Encrypt certificate stays issued (ACTIVE) even when applying it to SMTP/IMAP/POP3 fails
  afterwards (logged as error; assign it again or restart — the startup reconciliation repairs it).
- **Let's Encrypt staging** certificates (test, untrusted) never serve SMTP/IMAP/POP3:
  assigning mail services to one is refused (`409 STAGING_NO_MAIL_SERVICES`, `400` when ordering
  a staging certificate with mail services).
- `POST /api/v1/admin/certificates/:id/activate-protocol` still works (CLI, older clients) and is
  the same switch — it also sets SMTP/IMAP/POP3 as the certificate's services.

Before 9.3 the edit dialog only moved the `services` label: the BCP showed SMTP/IMAP/POP3 on a
Let's Encrypt certificate while 993/465/587 kept serving the self-signed `CN=mail.localhost`
certificate, and desktop and iOS mail clients refused to connect ("certificate unknown").

### Startup reconciliation

At every api-gateway start the protocol TLS state is checked and repaired (idempotent, logged
as `Protocol TLS cert state reconciled at startup`). It runs under the Redis lock
`cert:protocol:reconcile:lock` (TTL 2 min): with several api-gateway instances only one repairs,
the others skip silently — no duplicate self-signed rows.

1. Let's Encrypt staging certificates lose any mail services / protocol flag.
2. The usable certificate that holds the mail services wins ("services win" — that is what the
   BCP shows). When `server_settings.tlsCert`, `isActiveProtocol` or the services disagree with it,
   it is applied. This repairs installations that were affected by the bug above on upgrade.
3. No certificate holds mail services: a usable protocol certificate activated before 9.3 keeps
   serving and gets the services; otherwise the self-signed default is applied.
4. When the active protocol certificate is the self-signed default for `mail.localhost` and a real
   public host name is configured, it is regenerated for that host name. A trusted certificate is
   never replaced.

### Self-signed default

Setup and the fallback generate the self-signed certificate for the **public host name**
(`mail.<domain>`) instead of `mail.localhost`, so clients at least see the right name. It is only
meant until a trusted certificate exists.

## Let's Encrypt for the public host name

The order form is prefilled with the public host name and the mail services. It offers
`autodiscover.<domain>` and `autoconfig.<domain>` as additional names (Autodiscover / autoconfig clients fetch
them over HTTPS); they are checked by default when their DNS points to this server
(`GET /api/v1/admin/certificates/acme-suggestions`). **Check prerequisites** runs the DNS / CAA /
port-80 checks for every selected name.

When a Let's Encrypt certificate whose domains include the public host name is issued while the
mail protocols still use the self-signed default, it is assigned to SMTP/IMAP/POP3
automatically — and activated for the HTTPS proxy when no trusted HTTPS certificate is active.

## Setup wizard (10.5 → 10.6)

10.6: for a **public** host name the setup wizard's step "Zertifikat" orders the Let's Encrypt
certificate itself — the same flow as the dashboard card below (host name + `autodiscover.` /
`autoconfig.` only when their DNS points here, pre-flight incl. the staging test, order with
SMTP/IMAP/POP3, then HTTPS), plus the **ACME contact e-mail** (prefilled with
`ServerSettings.adminEmail`, else the admin address; stored as `Certificate.acmeEmail`, the
account contact for the registration and every renewal) and the required acceptance of the CA's
terms of service (link from the ACME directory's `meta.termsOfService`). Because fresh
installations require admin MFA, the wizard does not use `/api/v1/admin/certificates/*` (which
answers `MFA_REQUIRED` to its session) but the setup-window routes
`/api/v1/setup/certificate/{status,preflight,issue}` — admin session from the wizard, only until the
wizard is finished and at most 24 h, rate limited, audited as `setup.certificate.*`. Both call the
shared functions in `packages/api-gateway/src/lib/acme-order.ts` (also used by the admin routes
`/acme-suggestions`, `/preflight`, `/letsencrypt`, `/:id/activate-https`). Details:
[setup-wizard.md](setup-wizard.md#certificate-step-106).

"Später" in the wizard, a failed order or a local host name leave the dashboard card in place.

**Testing without the real CA**: the repository has no local ACME server (no pebble); the tests use
the seams `globalThis.__acmeClientFactory` (fake CA, `src/test-support/fake-acme.ts`),
`__acmeChallengeServing`, `__acmeResolver` and in-memory Redis/Prisma. An issuance from the real
Let's Encrypt (production or staging) needs a public host name whose A record points at the server
and port 80 forwarded to it — not verifiable on a development machine.

## Dashboard card „Zertifikat einrichten“

10.4.2 (replaced the 10.4 wizard's certificate step and its "later" hint; 10.6 brings a
certificate step back to the wizard for public host names, see above). The BCP dashboard
shows the card while **no trusted certificate covers the public host name** — "trusted" is the
certificate the integrated HTTPS server serves for that name (`servedProxyCert`, SNI exact →
wildcard → default) and `isTrustedHttpsCert` (CA-issued, not staging, currently valid, covers
the name); shared helper `packages/api-gateway/src/lib/served-https-cert.ts`. It is shown only to
roles that may manage certificates (area `servers`, write) and only for a configured host name
(not the schema defaults `mail.local` / `mail.localhost` / `localhost`).

10.5: for a **local / private host name** (`mail.example.local` from the setup wizard, `.lan`,
`.internal`, `.home.arpa`, `.test`, `.localdomain`, `.localhost`, single labels, bare IPs —
`lib/local-hostname.ts`) the card has no Let's Encrypt button: it is **„Eigene Domain
hinzufügen“** with three steps (Domain anlegen → als primär festlegen → Zertifikat anfordern) and a
link to **Domains**. `GET /admin/setup-state` then answers `publicHostname: null` (nothing a public
CA issues for) and `hostname: "<local name>"`. Making a public domain primary replaces the local
host name and clears "Später" ([setup-wizard.md](setup-wizard.md#local-domain-first-105)).

- One button, **„Let's-Encrypt-Zertifikat für &lt;host&gt; anfordern“**, runs the order form's
  flow (`packages/admin-panel/src/lib/certificateCard.ts`): `acme-suggestions` (the public host
  name plus `autodiscover.` / `autoconfig.` of the primary domain only when their DNS points
  here) → `preflight` → `letsencrypt` with the mail services (the issuance assigns
  SMTP/IMAP/POP3 as above) → polls the certificate → on success
  `POST /admin/certificates/:id/activate-https` (the same as the lock action on the SSL/TLS
  page), so HTTPS serves it as well. Progress is shown per phase.
- Problems of the preflight, a failed issuance (the CA's message) or a timeout are shown in the
  card with a link to **Zertifikate**; nothing is assigned to HTTPS unless the certificate was
  issued.
- **„Später“** hides the card for every admin (`POST /api/v1/admin/setup-state/certificate-hint/dismiss`,
  stored in `ServerSettings.setupCertificateHintDismissedAt`). Without dismissal it disappears by
  itself once a trusted certificate covers the host name.
- API: `GET /api/v1/admin/setup-state` → `{ certificateCard, publicHostname, acmeEmail }`
  (`acmeEmail` = `ServerSettings.adminEmail`, else the viewer's own address — the ACME account
  contact). Area `servers`; read-only roles always get `certificateCard: false`.

## What the ports really serve

`GET /api/v1/admin/certificates/served` connects to every active SMTP/IMAP/POP3 listener on the
server itself (implicit TLS, or STARTTLS / STLS on the plain ports) with SNI = public host name
and reports subject, issuer, expiry, SHA-256 fingerprint, the matching certificate row, whether it
is self-signed, matches the host name and is trusted by the CA bundle. Each probe is bounded
(`SERVED_CERT_PROBE_TIMEOUT_MS`, default 4 s, at most 16 listeners). Only wildcard, loopback and
the server's own interface addresses are connected to — a listener row with any other address
(or a host name) is reported as not probed. The integrated HTTPS server is probed the same way
(implicit TLS on `HTTPS_PORT`, handshake only) and reported as `https` — `null` while it does not
listen; the top-level `problem` flag keeps covering the mail ports only.

In the certificate list of the SSL/TLS page the row that holds a service shows a status chip per
service (SMTP, IMAP, POP3, HTTPS): **OK** when every reachable port of the service serves this
certificate, a warning when a port serves another, self-signed, name-mismatched or expired
certificate (or the HTTPS server does not run) — the chip's tooltip lists the ports. Unreachable
ports are listed but do not turn a chip into a warning. The SSL/TLS page and the dashboard show a
warning banner only when a mail port serves a self-signed, name-mismatched or expired certificate,
with **Jetzt zuweisen** (assigns the newest trusted certificate covering the public host name);
the same action appears next to a warning chip.

## Private keys at rest

The private key of every certificate (`Certificate.keyPem`), the copy the mail servers read
(`ServerSettings.tlsKey`) and the Let's Encrypt account key (`Certificate.acmeAccount`) are stored
encrypted with AES-256-GCM (`enc:v1:…`). The key is derived
from **`MFA_ENCRYPTION_KEY`** — the same master key that protects the 2FA (TOTP) secrets — or,
when that variable is not set, from `JWT_SECRET` + `PEPPER`.

- Private keys are never returned by the API (no `keyPem` in any response) and never logged.
- Upgrades need no action: keys stored as plain PEM by an earlier version are still read, and the
  api-gateway encrypts them once at startup (Redis lock `cert:private-key-encryption:lock`,
  idempotent; log line `Stored certificate private keys encrypted at rest`). Every new or renewed
  certificate is written encrypted.
- Introducing `MFA_ENCRYPTION_KEY` later is safe: keys encrypted with the `JWT_SECRET` + `PEPPER`
  fallback stay readable and are re-encrypted with the new key at the next start.

**Key loss.** If `MFA_ENCRYPTION_KEY` changes or is lost — or, without it, `JWT_SECRET` or
`PEPPER` change — the stored private keys can no longer be decrypted (just like the 2FA secrets).
The consequences:

- the HTTPS proxy leaves the affected certificates out (log `Private key of certificate "<name>"
  is unreadable — certificate not served on HTTPS …`); when no readable certificate is left it
  serves the self-signed replacement (below), so port 443 keeps TLS (no HTTP → HTTPS redirect to it);
- SMTP, IMAP and POP3 log `Private key of certificate "<name>" is unreadable — … serves the
  self-signed replacement certificate …` and keep TLS on with the **self-signed replacement** for
  the public host name: the self-signed default row of the certificates table when its key is
  readable, else a certificate generated in memory (nothing is written to the database). The
  implicit-TLS ports 465/993/995 never fall back to plaintext;
- BCP → SSL/TLS and the dashboard show „Privater Schlüssel von <Name> nicht lesbar — Mail-Protokolle
  nutzen das selbstsignierte Ersatzzertifikat; Zertifikat neu ausstellen oder hochladen"
  (`GET /api/v1/admin/certificates/served` → `unreadableKeys: [{ id, name, services, https }]`);
- a Let's Encrypt account key that cannot be decrypted is replaced by a new one at the next
  issuance or renewal (a new account at Let's Encrypt; the certificates are not affected);
- the startup migration reports them (`… cannot be decrypted with the configured key`) and leaves
  them unchanged.

Recovery: restore the previous key, or re-issue the Let's Encrypt certificates / upload the
certificates again (BCP → SSL/TLS) and create a new self-signed default. Keep
`MFA_ENCRYPTION_KEY` in the same place as your database backups — a database backup restored
without it contains unusable private keys. Set `MFA_ENCRYPTION_KEY` explicitly before rotating
`JWT_SECRET` or `PEPPER` (see `docs/deployment-security.md`).

## Logs

IMAP, POP3 and SMTP log the client IP on login success / failure and on TLS errors. A client that
aborts the handshake because it does not trust the certificate (TLS alert `certificate unknown`,
`bad certificate`, `unknown CA`) is logged as **warn** with the hint
`client does not trust the served certificate …` instead of an error.

## DNS

The domain DNS check (BCP → Domains → Check DNS setup) reports an MX record that is an IP address
or a CNAME as an error with the suggestion `mail.<domain>` (an MX must name a host with an A
record; mail clients and senders validate the certificate against that name).
