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
certificate, and Outlook / iOS refused to connect ("certificate unknown").

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
`autodiscover.<domain>` and `autoconfig.<domain>` as additional names (Outlook / Thunderbird fetch
them over HTTPS); they are checked by default when their DNS points to this server
(`GET /api/v1/admin/certificates/acme-suggestions`). **Check prerequisites** runs the DNS / CAA /
port-80 checks for every selected name.

When a Let's Encrypt certificate whose domains include the public host name is issued while the
mail protocols still use the self-signed default, it is assigned to SMTP/IMAP/POP3
automatically — and activated for the HTTPS proxy when no trusted HTTPS certificate is active.

## What the ports really serve

`GET /api/v1/admin/certificates/served` connects to every active SMTP/IMAP/POP3 listener on the
server itself (implicit TLS, or STARTTLS / STLS on the plain ports) with SNI = public host name
and reports subject, issuer, expiry, SHA-256 fingerprint, the matching certificate row, whether it
is self-signed, matches the host name and is trusted by the CA bundle. Each probe is bounded
(`SERVED_CERT_PROBE_TIMEOUT_MS`, default 4 s, at most 16 listeners). Only wildcard, loopback and
the server's own interface addresses are connected to — a listener row with any other address
(or a host name) is reported as not probed. The SSL/TLS page shows the result per port; the
SSL/TLS page and the dashboard show a warning when a mail port serves a self-signed,
name-mismatched or expired certificate, with **Jetzt zuweisen** (assigns the newest trusted
certificate covering the public host name).

## Logs

IMAP, POP3 and SMTP log the client IP on login success / failure and on TLS errors. A client that
aborts the handshake because it does not trust the certificate (TLS alert `certificate unknown`,
`bad certificate`, `unknown CA`) is logged as **warn** with the hint
`client does not trust the served certificate …` instead of an error.

## DNS

The domain DNS check (BCP → Domains → Check DNS setup) reports an MX record that is an IP address
or a CNAME as an error with the suggestion `mail.<domain>` (an MX must name a host with an A
record; mail clients and senders validate the certificate against that name).
