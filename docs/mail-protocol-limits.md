# Mail protocol limits (IMAP, POP3, shared login lockout)

Resource limits and brute-force protection of the TCP mail protocols (v8.1).
All values are environment variables of the `coremail` app container; a limit of
`0` (or a negative value) disables that check.

## Connection limits

Checked on the raw TCP connection, before the greeting and — on the implicit-TLS
ports 993/995 — before the TLS handshake.

| Variable | Default | Meaning |
|----------|---------|---------|
| `IMAP_MAX_CONNS_PER_IP` | `50` | Concurrent IMAP connections per client IP. Above it: `* BYE [UNAVAILABLE] Too many connections` (port 143) or the connection is dropped (port 993). |
| `IMAP_MAX_CONNS` | `2000` | Concurrent IMAP connections per process (all clients). |
| `IMAP_MAX_CONNS_PER_USER` | `20` | Concurrent authenticated IMAP sessions per user. A login above it is answered with `NO [LIMIT]`. |
| `POP3_MAX_CONNS_PER_IP` | `50` | Concurrent POP3 connections per client IP (`-ERR [SYS/TEMP] too many connections`). |
| `POP3_MAX_CONNS` | `1000` | Concurrent POP3 connections per process. |
| `MAIL_CONN_EXEMPT_CIDRS` | *(empty)* | Comma-separated IPs/CIDRs without the per-IP cap (the global cap still applies). Loopback is always exempt. |

POP3 allows one session per maildrop anyway (RFC 1939 §4 lock, `-ERR [IN-USE]`).

### Offices behind NAT

Behind a NAT gateway or a proxy that does not preserve the client address, every
client shares one IP. A desktop IMAP client keeps 3–10 connections open (one
per watched folder plus IDLE), phones 1–3 — so 10 users behind one office
router can already need 50+ connections. The per-IP default is 50 since 8.1
(was 20). For larger offices:

* list the office's public address in `MAIL_CONN_EXEMPT_CIDRS` (e.g.
  `MAIL_CONN_EXEMPT_CIDRS=203.0.113.10,198.51.100.0/28`) — no per-IP connection
  cap for it, the global cap still applies;
* list it in `MAIL_AUTH_EXEMPT_CIDRS` as well when many users log in from there,
  so one user's typos cannot trip the **per-IP** login-failure counter for the
  whole office (the per-account counter still applies, see below);
* or raise `IMAP_MAX_CONNS_PER_IP` / `POP3_MAX_CONNS_PER_IP`.

## Timeouts and size caps (fixed)

| Protocol | Rule |
|----------|------|
| IMAP | Before authentication a command line and the literals of one command are capped at 8 KiB (`LOGIN`/`AUTHENTICATE` included); larger literals get `NO [TOOBIG]` (synchronizing) or `BYE` + close (non-synchronizing). After login the message-size limit (`maxMessageSizeMb`) applies. |
| IMAP | Idle timeout 60 s before authentication, 30 min afterwards (RFC 9051 §5.4). |
| IMAP / POP3 | A STARTTLS/STLS handshake must complete within 30 s; implicit TLS handshakes likewise. |
| POP3 | Command lines ≤ 512 octets (RFC 2449), autologout after 10 min idle (RFC 1939 §3). |

## Shared login lockout (all mail protocols)

`verifyMailCredentials` (`packages/storage/src/mail-auth-core.ts`) counts failed
logins per client IP and per account in Redis and locks with exponential backoff
(`MAIL_AUTH_IP_*`, `MAIL_AUTH_ACCOUNT_*`, see `mail-auth.ts`).

Since v8.1 **private addresses are counted like public ones**: behind a reverse
proxy or the Docker userland proxy every attacker would otherwise appear as an
exempt private peer. Only loopback is exempt by default.

| Variable | Default | Meaning |
|----------|---------|---------|
| `MAIL_AUTH_EXEMPT_CIDRS` | *(empty)* | Comma-separated IPs/CIDRs exempt from the **per-IP** failure counter (e.g. an internal webmail or monitoring host). The per-account counter always applies. Invalid entries are ignored and logged. |

`MAIL_AUTH_LIMIT_PRIVATE_IPS` (pre-8.1) is obsolete and ignored — counting private
addresses is now the default.
