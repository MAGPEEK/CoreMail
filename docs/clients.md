# Client setup (automatic configuration)

CoreMail lets mail, calendar and contacts clients configure themselves from the e-mail
address. This page explains, per client, which mechanism is used and which DNS records
make it work.

All hostnames and ports announced by these mechanisms come from **BCP → Server**
(`ServerSettings`: public hostname, IMAP/POP3/SMTP host + port + TLS, HTTPS port) — the
same source as Autodiscover and the MWA page **Settings → External clients**.

> **Passwords and MFA.** None of the mechanisms transports a password. With MFA enabled
> a user must log in to IMAP/POP3/SMTP/CalDAV/CardDAV/ActiveSync with an **app password**
> (MWA → Settings → App passwords), never with the login password.

## Mechanisms

| Mechanism | URL | Used by | Auth |
|-----------|-----|---------|------|
| Mozilla autoconfig (ISPDB `config-v1.1.xml`) | `https://autoconfig.<domain>/mail/config-v1.1.xml?emailaddress=…` and `https://<domain>/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=…` | Thunderbird, Thunderbird for Android / K-9 Mail, FairEmail, Evolution, KMail, eM Client | none |
| Autodiscover v1 (POX) | `https://autodiscover.<domain>/Autodiscover/Autodiscover.xml` | Outlook (IMAP/SMTP profile), ActiveSync clients | Basic |
| Autodiscover v2 (JSON) | `https://autodiscover.<domain>/autodiscover/autodiscover.json/v1.0/<email>?Protocol=…` | Outlook 2019/2021/365 | none |
| RFC 6186 / RFC 8314 SRV records | `_submissions._tcp`, `_imaps._tcp`, … | Thunderbird (fallback), some mobile clients | — |
| RFC 6764 CalDAV/CardDAV discovery | `_caldavs._tcp` / `_carddavs._tcp` SRV + TXT `path=/dav/`, `/.well-known/caldav`, `/.well-known/carddav` | Apple Calendar/Contacts, DAVx⁵, Thunderbird, eM Client | Basic |
| Apple configuration profile (`.mobileconfig`) | MWA → Settings → External clients → "Profil für iPhone/iPad/Mac laden" (`GET /api/v1/user/apple-profile`) | iOS, iPadOS, macOS | MWA session |

### Mozilla autoconfig

* Served by the autodiscover service; the api-gateway proxies `/.well-known/autoconfig/*`
  and `/mail/config-v1.1.xml`.
* Content: IMAP 993 (SSL) + 143 (STARTTLS), POP3 995 (SSL) + 110 (STARTTLS), SMTP
  submission 465 (SSL) + 587 (STARTTLS); the configured host/port from BCP → Server is
  listed first for each protocol. Authentication `password-cleartext` (always inside TLS —
  plaintext connections are never offered), username `%EMAILADDRESS%`. Thunderbird 102+
  additionally reads the `<addressBook type="carddav">` / `<calendar type="caldav">`
  elements (server URL `https://<public hostname>/dav/`).
* **No user enumeration**: the answer depends only on the domain. Every address of a
  served (active) domain gets byte-identical XML; the local part is never looked up or
  echoed. Unknown/inactive domains and malformed input get `404`.
* Without `emailaddress` the domain is taken from the host name (`autoconfig.<domain>`).
* `Cache-Control: public, max-age=3600` (404: 5 minutes). The served-domain list is cached
  for 60 s and refreshed immediately on a BCP settings change.
* Rate limit: `AUTOCONFIG_RATE_LIMIT` requests per minute and client IP (default **60**),
  answered with `429` + `Retry-After` beyond that. The api-gateway's global per-IP limit
  applies as well.

### Apple configuration profile

* `GET /api/v1/user/apple-profile` (Bearer token; the MWA downloads it with `fetch`, never
  with a token in the URL) → `application/x-apple-aspen-config`.
* Payloads: `com.apple.mail.managed` (IMAP + SMTP), `com.apple.caldav.account`,
  `com.apple.carddav.account` (principal URL `/dav/principals/<user id>/`).
  `?type=eas` returns a single `com.apple.eas.account` payload (Exchange ActiveSync for
  mail, calendar and contacts) — install only one of the two variants.
* The account address is pre-filled; the profile contains **no password** — the device
  asks for it during installation (app password with MFA; the profile description says so).
* Payload UUIDs and identifiers are derived from the user id, so a newer download
  replaces the installed profile instead of adding a second account.
* The profile is **unsigned** (iOS shows "Not verified"). Signing it with the server
  certificate (CMS/PKCS#7, e.g. `openssl smime -sign -nodetach -outform der`) is possible
  later without changing the payloads.

## Per client

### Thunderbird (desktop)

1. Add mail account → name, address, password → Continue.
2. Thunderbird fetches `autoconfig.<domain>` / `/.well-known/autoconfig` and shows the
   IMAP/SMTP settings; it also offers to add the CalDAV calendar and CardDAV address book
   (Thunderbird 102+).
3. Fallback when autoconfig is unreachable: the RFC 6186 SRV records, then guessing.

### Apple Mail / iOS / iPadOS / macOS

* Recommended: MWA → Settings → External clients → **Profil für iPhone/iPad/Mac laden**.
  On the iPhone open the file in Safari (or AirDrop it), then **Settings → Profile
  Downloaded → Install**; on the Mac **System Settings → General → Device Management**.
* Manual alternative: Settings → Mail → Accounts → Add Account → Other. Calendar and
  Contacts find the DAV server via the RFC 6764 SRV records / `/.well-known/caldav`.

### Outlook (Windows, Mac)

* Outlook uses **IMAP + SMTP**; Autodiscover (v1/v2) answers with the IMAP/SMTP settings
  (`autodiscover.<domain>` CNAME or the `_autodiscover._tcp` SRV record).
* Calendar/contacts: Outlook has no CalDAV/CardDAV support — use the free *Outlook CalDav
  Synchronizer* plugin (guide in the MWA External clients page), or OWA.

### Android

* **Thunderbird for Android / K-9 Mail, FairEmail**: use Mozilla autoconfig (same records
  as Thunderbird); FairEmail also tries the SRV records.
* **DAVx⁵** (calendar + contacts): "Login with e-mail address" → finds the server via
  `_caldavs._tcp` / `_carddavs._tcp` SRV + TXT `path=/dav/` (RFC 6764).
* **Exchange ActiveSync** clients (Gmail app, Samsung Mail, Nine): Autodiscover v1.

### eM Client

* Enter the e-mail address → eM Client tries Autodiscover and Mozilla autoconfig and sets
  up IMAP/SMTP; CalDAV/CardDAV via the RFC 6764 records.

## DNS records

The BCP shows these records in **Domains → Edit → Check DNS setup** under
"Recommended — automatic client setup" with copyable values (missing ones yellow, not
red; they are not counted with the required MX/SPF/DKIM/DMARC/Autodiscover/PTR records).
The values are computed from the public hostname (`mail.example.com` below) and the HTTPS
port (443 unless an HTTPS port is configured). SRV values: `priority weight port target`.

| Name (relative to the domain) | Type | Value | Purpose |
|-------------------------------|------|-------|---------|
| `_submissions._tcp` | SRV | `0 1 465 mail.example.com.` | SMTP submission, implicit TLS (RFC 8314) |
| `_submission._tcp` | SRV | `0 1 587 mail.example.com.` | SMTP submission, STARTTLS (RFC 6186) |
| `_imaps._tcp` | SRV | `0 1 993 mail.example.com.` | IMAP, implicit TLS |
| `_imap._tcp` | SRV | `0 1 143 mail.example.com.` | IMAP, STARTTLS |
| `_pop3s._tcp` | SRV | `0 1 995 mail.example.com.` | POP3, implicit TLS |
| `_autodiscover._tcp` | SRV | `0 0 443 mail.example.com.` | Outlook Autodiscover |
| `autodiscover` | CNAME | `mail.example.com` | Outlook Autodiscover (required list) |
| `autoconfig` | CNAME (or A to the server IP) | `mail.example.com` | Mozilla autoconfig |
| `_caldavs._tcp` | SRV | `0 1 443 mail.example.com.` | CalDAV (RFC 6764) |
| `_caldavs._tcp` | TXT | `path=/dav/` | CalDAV context path |
| `_carddavs._tcp` | SRV | `0 1 443 mail.example.com.` | CardDAV (RFC 6764) |
| `_carddavs._tcp` | TXT | `path=/dav/` | CardDAV context path |

### Certificates

Clients fetch Autodiscover and autoconfig over HTTPS. The certificate served by the
integrated HTTPS proxy (or your reverse proxy) must cover **`mail.<domain>`,
`autodiscover.<domain>` and `autoconfig.<domain>`** as SANs (BCP → SSL/TLS; the TLS proxy
picks the certificate per SNI name). Without a matching certificate Thunderbird falls back
to plain HTTP lookups or guessing, and Outlook shows a certificate warning.
