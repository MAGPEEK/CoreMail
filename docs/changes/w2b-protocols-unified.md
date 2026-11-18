# w2b-protocols-unified — changelog text (Keep a Changelog)

SemVer: MINOR (new read endpoint, additive API field, BCP presentation change). No endpoint, field
or setting is removed or changes meaning; listener and protocol-access writes use the existing
routes. `coremail protocol show` without `--scope` now prints the combined view (and `--json` the
overview answer) instead of the server level; `--scope global` prints the server level as before —
the `protocol` command is new in 9.4 (unreleased), so this is no breaking change of a released CLI.

### Added
- `GET /api/v1/admin/protocol-access/overview` (area *servers*): one model of both things that
  switch a protocol — per access protocol the server-level switch, its ports (listeners with TLS
  mode, legacy TLS, address), how many domains and mailboxes set it differently (with the first 25
  names), and consistency warnings: protocol allowed but no active port (`no-active-port`), port
  active but nobody may log in (`port-open-access-off`), MAPI on while HTTPS (port 443) is off or
  has no trusted certificate (`mapi-https`). SMTP on port 25 (and every non-submission SMTP port) is
  listed separately as inbound transport, not user access.
- The level answers of `/api/v1/admin/protocol-access[/domains/:id|/users/:id]` carry
  `inheritedFrom` (`default` | `server` | `domain`): where `inherit` takes its value from.
- `coremail protocol show` prints the combined view: access, active ports, differing domains /
  mailboxes per protocol, the SMTP inbound ports, the HTTPS state and the warnings.

### Changed
- BCP → Services is one page „Protokolle“: per protocol (SMTP-Versand, IMAP, POP3, ActiveSync,
  JMAP, CalDAV/CardDAV, Webmail, MAPI) the server-wide access switch, its ports (port on/off, TLS
  mode, „Ältere Clients erlauben“, add / edit / delete address and port as before; HTTP-based
  protocols say they run on the HTTP/HTTPS server), a summary line („aktiv auf 993 · 2 Domains
  abweichend · 1 Benutzer abweichend“) whose counts open the list of those domains / mailboxes with
  links to the filtered domain / mailbox list, and the warnings. SMTP-Empfang (port 25) is shown as
  transport, HTTPS (Port 443) with its legacy-TLS switch below. A short box explains ports vs.
  access. The separate listener pages (SMTP Inbound, IMAP, POP3) and the separate server-level
  „Protokollzugriff“ editor are gone.
- Domain and mailbox dialogs show the effective value with the level that decides it, e.g.
  „aus (Domain)“, „an (serverweit)“, „an (Postfach)“.
- The domain and mailbox lists accept `?q=` to start with a search.
- „HTTPS-Proxy“ wording on the Server and Services pages is „HTTPS (Port 443)“.
- BCP → SSL/TLS (and the dashboard): a wrong certificate on HTTPS (self-signed, name mismatch,
  expired) raises a warning banner like the mail ports do; the green „HTTPS aktiv“ banner is gone
  — the HTTPS status chip in the certificate row shows it.
