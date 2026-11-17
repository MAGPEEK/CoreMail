# w1-legacy-clients — changelog text

SemVer: MINOR (new opt-in features, additive schema; no endpoint, config or protocol default removed).
Behaviour changes worth noting in the release notes are listed under "Changed".

### Added
- **TLS 1.0/1.1 for old clients (opt-in)**: per listener (BCP → Dienste → Listener bearbeiten →
  „Ältere Clients erlauben (TLS 1.0/1.1)") and for the integrated HTTPS proxy (Dienste → Übersicht →
  HTTPS), default off. SMTP (implicit TLS + STARTTLS), IMAP (993 + STARTTLS), POP3 (995 + STLS) and
  the HTTPS proxy apply a vetted legacy cipher list (forward-secret AES first; never RC4, 3DES, DES,
  NULL, EXPORT, MD5, PSK, SRP, DHE) with `@SECLEVEL=0` encapsulated in one helper
  (`@coremail/core` `tlsProtocolOptions`). Hot reload (the listener restarts, certificate rotation
  keeps the policy), warning + badge in the BCP, audit entries `settings.legacy-tls.enabled|disabled`.
  New API `GET/PUT /api/v1/admin/services/https-tls`; listeners accept `allowLegacyTls`. Docs
  `docs/legacy-tls.md`.
- **Device relay (Geräte-Relay)**: unauthenticated SMTP relay for scanners/printers/monitoring only
  from configured networks (CIDR, nothing broader than /8 resp. /32), on a chosen inbound listener
  port (25 or a dedicated port), only for configured hosted sender domains (envelope and
  From:/Sender: header), rate-limited per source IP (fails closed). Default off; never an open relay.
  BCP → SMTP-Konfiguration → Geräte-Relay, API `GET/PUT /api/v1/admin/smtp-config/device-relay`,
  audited as `settings.device-relay.updated`, relayed messages in the message flow. Docs
  `docs/device-relay.md`.
- **Autodiscover**: client test matrix (Outlook 2010/2013/2016/2019/2021/Microsoft 365 classic, iOS
  Mail, Android ActiveSync), `docs/autodiscover.md` (DNS incl. `_autodiscover._tcp` SRV, request
  handling, old Outlook profiles), `docs/outlook-caldav.md` (classic Outlook with IMAP/SMTP and
  CalDAV/CardDAV sync add-ins, app passwords with MFA).
- e2e step `legacy-clients`.

### Changed
- Autodiscover v1 always describes the account by its **primary** address (`LoginName`,
  `AutoDiscoverSMTPAddress`, mobilesync `EMailAddress`), also when an alias was requested — the mail
  protocols only accept the primary address as login.
- Autodiscover v1 adds an explicit IMAP `<Encryption>` (`SSL` for implicit TLS, `TLS` for STARTTLS).
- Autodiscover (v1, v2, autoconfig) announces IMAP/POP3/SMTP endpoints that match the enabled
  listeners: a configured port whose listener is switched off is replaced by an active listener
  (implicit TLS preferred); ports without any listener row (NAT mappings) are unchanged.
- Plain-HTTP Autodiscover probes get `302` to the HTTPS endpoint (gateway redirect for
  `/autodiscover/autodiscover.xml` uses 302 instead of 308; the autodiscover service redirects an
  unauthenticated plain-HTTP GET when the configured Autodiscover URL is HTTPS) instead of a Basic
  challenge.
- Autodiscover v1 reads the POST body whatever its Content-Type (max 64 KiB).

### Security
- The legacy `SmtpSettings.relaying*` fields stay unevaluated; the device relay uses its own
  settings row, so stale values cannot open a relay on upgrade.

Schema (additive): `ServiceListener.allowLegacyTls` (default false), `ServerSettings.httpsAllowLegacyTls`
(default false), new model `DeviceRelaySettings` (`device_relay_settings`).
`@coremail/core`: `applyTlsToListeners()` lost its unused third parameter (`minVersion`) — the policy
is per entry now (`allowLegacyTls`); internal API, all callers updated.
