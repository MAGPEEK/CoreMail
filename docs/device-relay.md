# Device relay (Geräte-Relay)

Scanners, printers, monitoring systems and other devices often send mail (scan-to-mail, alerts)
without SMTP authentication. The device relay lets such devices send to **external** recipients
through CoreMail — without ever becoming an open relay.

Configured in **BCP → SMTP-Konfiguration → Geräte-Relay** (default: off).

| Setting | Meaning |
|---|---|
| Geräte-Relay aktiv | Master switch. Off = port 25 behaves as before (local recipients only). |
| Erlaubte Netze | IP addresses / CIDR ranges of the devices, one per line. Ranges broader than `/8` (IPv4) or `/32` (IPv6) are refused (`0.0.0.0/0` would be the whole internet). |
| Erlaubte Absender-Domains | Domains the devices may send as. Only domains hosted on this server. |
| Listener-Port | `25` or a dedicated port (e.g. `2525`). Not 465/587 — those require SMTP AUTH. A dedicated port needs an SMTP inbound listener (**BCP → Dienste → SMTP Inbound**); the page warns while none is active. |
| Max. Nachrichten pro Minute und Gerät | Rate limit per source IP (default 30). |

The relay is active only when it is switched on **and** at least one network and one sender
domain are configured.

## What is relayed

A message to an external recipient is accepted only when **all** of these hold:

1. the connection arrives on the configured listener port;
2. the client IP lies in one of the configured networks;
3. the envelope sender (`MAIL FROM`) uses a configured sender domain;
4. the message has exactly one `From:` header and every `From:`/`Sender:` address uses a configured
   sender domain;
5. the source IP is within its per-minute limit (Redis counter; if the counter is unavailable the
   message is deferred with `451`, never relayed unchecked).

Everything else keeps the normal port-25 behaviour:

* a client outside the networks, or on another port → external recipients are refused
  (`550 5.1.1`, exactly as without the relay);
* a configured device with another sender domain → `550 5.7.1 Relaying denied: sender domain not
  permitted for device relay`;
* a forged `From:` header → `550 5.7.1 Relaying denied: header sender …`;
* over the limit → `451 4.7.1 Device relay rate limit exceeded`.

Messages from a device that only go to local mailboxes follow the normal inbound path (spam and
virus filter, greylisting). A relayed message (at least one external recipient) is handled like an
authenticated submission of a trusted device: `Date:`/`Message-ID:` are added when missing, a
`Received:` header is added, local recipients are delivered directly, external recipients go
through the outbound queue (DKIM signing by the envelope sender domain, DSNs, retries).

## Logging and audit

* Every relayed message is logged (service log `smtp:device-relay`) and appears in the message
  flow (`MAIL_FLOW`, `relay: device`, source IP).
* Every configuration change is written to the audit log as `settings.device-relay.updated` with
  the old and the new configuration (always recorded, even with the audit log toggle off).
* Refused relay attempts are logged as warnings with IP, sender and recipient.

## API

* `GET /api/v1/admin/smtp-config/device-relay` → `{ enabled, allowedNetworks, senderDomains, port,
  maxMessagesPerMinute, listenerActive }`
* `PUT /api/v1/admin/smtp-config/device-relay` (same fields without `listenerActive`) — area
  `servers`, write roles only; invalid input → `400` with a German message.

The legacy `SmtpSettings.relaying*` fields are never evaluated: stale values from old installs
cannot open a relay on upgrade.
