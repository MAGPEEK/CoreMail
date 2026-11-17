# Device relay (Geräte-Relay)

Scanners, printers, monitoring systems and other devices often send mail (scan-to-mail, alerts)
without SMTP authentication. The device relay lets such devices send to **external** recipients
through CoreMail — without ever becoming an open relay.

Configured in **BCP → SMTP-Konfiguration → Geräte-Relay** (default: off).

| Setting | Meaning |
|---|---|
| Geräte-Relay aktiv | Master switch. Off = port 25 behaves as before (local recipients only). |
| Erlaubte Netze | IP addresses / CIDR ranges of the devices, one per line. Ranges broader than `/8` (IPv4) or `/32` (IPv6) are refused (`0.0.0.0/0` would be the whole internet). An IPv4-mapped IPv6 range (`::ffff:c0a8:a00/120`) is stored as the IPv4 range it denotes (`192.168.10.0/24`) and checked against the IPv4 limit; an IPv6 range never matches IPv4 clients. The SMTP server ignores a too broad entry as well, should one reach the database by another way. |
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
   message is deferred with `451`, never relayed unchecked);
6. the malware checks pass (security-filter `POST /check/malware`): the **attachment filter** and
   **ClamAV** with the settings of BCP → Schutzfilter — blocked attachment → `550 5.7.1`; virus →
   the configured ClamAV action (quarantine — the message is held in the quarantine with its
   full envelope and can be released from the BCP — or `550` reject); scanner failure → the
   configured failure policy (`451` defer, or delivered with an `X-CoreMail-Virus-Scan` header);
   security filter unreachable → `451`. Spam scoring (rspamd) and SPF/DKIM/DMARC do not apply.

Everything else keeps the normal port-25 behaviour:

* a client outside the networks, or on another port → external recipients are refused
  (`550 5.1.1`, exactly as without the relay);
* a configured device with another sender domain → `550 5.7.1 Relaying denied: sender domain not
  permitted for device relay`;
* a forged `From:` header → `550 5.7.1 Relaying denied: header sender …`;
* over the limit → `451 4.7.1 Device relay rate limit exceeded`.

Messages from a device that only go to local mailboxes follow the normal inbound path (spam and
virus filter, greylisting). A relayed message (at least one external recipient) is handled like a
submission of a trusted device: internal CoreMail headers and `Authentication-Results` fields
naming this server are removed (the device is not authenticated), `Date:`/`Message-ID:` are added
when missing, a `Received:` header is added, the malware checks above run, then local recipients
are delivered directly and external recipients go through the outbound queue (DKIM signing by the
envelope sender domain, DSNs, retries).

## The client address must be the device's own address

The networks are matched against the TCP source address the SMTP server sees. Anything that
rewrites that address in front of CoreMail turns its own address into "a device":

* **Docker** userland proxy (e.g. IPv6 clients on a host without container IPv6, or connections to
  a published port on the host's loopback) — the connection appears to come from the Docker
  network gateway (`172.17.0.1`, `172.18.0.1`, …);
* **Kubernetes** Services with `externalTrafficPolicy: Cluster` — the source is a node address;
* load balancers or TCP proxies that do not preserve the client address.

Never list the Docker network, the cluster/node network or a proxy address as a device network:
every connection through that path could relay. Check the source addresses in the message flow
(`ip`) after enabling the relay, and prefer host routes (`/32`) for single devices.

The BCP warns (the API returns `warnings`) when an allowed network overlaps a typical
container/cluster NAT range — the Docker default bridge `172.17.0.0/16` and pool `172.16.0.0/12`,
the Kubernetes pod/service default `10.0.0.0/8`, `100.64.0.0/10` and the IPv6 ULA range `fd00::/8`.
The configuration is still saved (these ranges are also ordinary LANs); behind such NAT use host
networking, `externalTrafficPolicy: Local`, or a proxy that preserves the client address.

## Logging and audit

* Every relayed message is logged (service log `smtp:device-relay`) and appears in the message
  flow (`MAIL_FLOW`, `relay: device`, source IP).
* Every configuration change is written to the audit log as `settings.device-relay.updated` with
  the old and the new configuration (always recorded, even with the audit log toggle off).
* Refused relay attempts are logged as warnings with IP, sender and recipient.

## API

* `GET /api/v1/admin/smtp-config/device-relay` → `{ enabled, allowedNetworks, senderDomains, port,
  maxMessagesPerMinute, listenerActive, warnings }` — `warnings`: German texts, e.g. allowed
  networks inside container/cluster NAT ranges (empty when none)
* `PUT /api/v1/admin/smtp-config/device-relay` (same fields without `listenerActive` / `warnings`; answers like `GET`) — area
  `servers`, write roles only; invalid input → `400` with a German message.

The legacy `SmtpSettings.relaying*` fields are never evaluated: stale values from old installs
cannot open a relay on upgrade.
