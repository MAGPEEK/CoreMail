# TLS 1.0/1.1 for old clients (opt-in)

By default every CoreMail TLS endpoint — SMTP (465, STARTTLS on 25/587), IMAP (993, STARTTLS
on 143), POP3 (995, STLS on 110) and the integrated HTTPS proxy (443) — accepts **TLS 1.2 and
1.3 only**.

Some old mail programs and devices (for example Outlook 2010 on Windows 7 without the TLS 1.2
update, old multifunction printers, embedded Android builds) cannot negotiate TLS 1.2. For them a
single listener can be opened for TLS 1.0 and 1.1:

* **BCP → Dienste → \<Dienst\> → Listener bearbeiten → „Ältere Clients erlauben (TLS 1.0/1.1)"**
  (per listener, default off)
* **BCP → Dienste → Übersicht → HTTPS → „Ältere Clients erlauben (TLS 1.0/1.1)"** (integrated
  HTTPS proxy: webmail, Autodiscover, ActiveSync, CalDAV/CardDAV)

The BCP shows a warning while the switch is on and marks the listener with a `TLS 1.0/1.1` badge.
Every change is written to the audit log (`settings.legacy-tls.enabled` / `.disabled`, with the
listener and the before/after value) — these entries are recorded even when the audit log toggle
is off.

## What changes on such a listener

* Minimum protocol version TLS 1.0; TLS 1.3 and 1.2 remain preferred by every modern client.
* An explicit, closed cipher list (`@coremail/core` → `tls/legacy-tls.ts`):
  1. TLS 1.2 forward-secret AEAD suites (ECDHE + AES-GCM / ChaCha20-Poly1305),
  2. TLS 1.2 ECDHE + AES-CBC-SHA256/384,
  3. ECDHE + AES-CBC-SHA (the suites TLS 1.0/1.1 clients can negotiate),
  4. plain-RSA AES as the last resort for very old stacks.
* Never negotiated, whatever the client offers: NULL / anonymous, EXPORT, DES, 3DES, RC4, MD5,
  PSK, SRP, DHE.
* OpenSSL 3 refuses TLS < 1.2 at its default security level (SHA-1 handshake signatures), so the
  legacy list ends with `@SECLEVEL=0`. The level is only lowered on listeners with the switch on;
  the explicit list keeps weak suites out.

## Hot reload

Switching it on or off restarts only that listener a moment later (like a changed SSL flag or
bind address) — no container restart. Certificate rotation keeps the policy of each listener.
The HTTPS proxy rebuilds its TLS contexts on the `coremail:tls:reload` signal.

## Recommendation

Use it only as long as the old clients are in use, prefer a dedicated listener (e.g. a second
IMAPS port for the old devices) over opening the standard ports, and switch it off again as soon
as possible. TLS 1.0/1.1 are deprecated; connections using them are weaker even with the vetted
cipher list.
