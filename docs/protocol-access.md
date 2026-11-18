# Protocol access (per-protocol switches)

Since 9.4 an administrator decides per protocol which client access an account may use — on
the server, per domain and per mailbox.

| Switch       | Covers                                                                                  |
|--------------|-----------------------------------------------------------------------------------------|
| `imap`       | IMAP (143 STARTTLS, 993)                                                                |
| `pop3`       | POP3 (110 STLS, 995)                                                                    |
| `smtp`       | authenticated mail submission (`AUTH` on 587 / 465); inbound mail on port 25 is not affected |
| `activesync` | ActiveSync (`/Microsoft-Server-ActiveSync`)                                             |
| `jmap`       | JMAP (`/jmap/*`, `/.well-known/jmap`, WebSocket)                                       |
| `dav`        | CalDAV and CardDAV (`/dav/*`)                                                           |
| `webmail`    | web login (password, MFA, SSO, token refresh) and the webmail / user REST API          |
| `mapi`       | MAPI over HTTP (`/mapi/emsmdb`, `/mapi/nspi`, classic Outlook — see [mapi.md](mapi.md)), off by default |

## Ports vs. Zugriff

Two different things decide whether a client can use a protocol, and the BCP shows both on one
page (*Protokolle & Dienste*, `/services`; the old sub-page links `/services/imap`, `/services/pop3`,
`/services/smtp-receive` redirect to the matching protocol card, e.g. `/services#protocol-imap`):

| | Port (listener) | Access (protocol switch) |
|---|---|---|
| Decides | whether the server listens on an address/port at all — no active port, no connection | whether an account may use the protocol **after** a successful login |
| Scope | the whole server | server → domain → mailbox (this document) |
| Applies to | IMAP, POP3, SMTP (submission 465/587 and inbound 25); HTTP-based protocols (ActiveSync, JMAP, CalDAV/CardDAV, Webmail, MAPI) share the HTTP/HTTPS server and have no ports of their own | every protocol in the table above; SMTP inbound on port 25 is transport from other servers, nobody logs in there, so no switch applies |
| Stored in | `service_listeners` (`/api/v1/admin/services/listeners/*`) | `protocol_policies` (`/api/v1/admin/protocol-access/*`) |

A port that listens while the protocol is off for everyone accepts connections and refuses every
login after the password ("Port offen, Anmeldung für alle gesperrt"); a protocol that is allowed
without an active port cannot be reached at all. The page warns about both, and about MAPI being on
while HTTPS (Port 443) is off or has no trusted certificate (Outlook connects over HTTPS only,
unless a reverse proxy in front provides it). A port that listens while the protocol is off on the
server but on for some domains or mailboxes is consistent; the page says so in a softer notice
("Port offen; Anmeldung nur für abweichende Domains/Benutzer") that is not counted as an
inconsistency.

Per protocol the page shows the server-wide access switch, its ports (port on/off, TLS mode
implicit TLS / STARTTLS, "Ältere Clients erlauben", address and port — add, edit, delete), and a
summary line such as "aktiv auf 993 · 2 Domains abweichend · 1 Benutzer abweichend". The counts
open the list of those domains / mailboxes; each links to the domain or mailbox list filtered to it
(`/domains?q=…`, `/mailboxes?q=…`), where the override is edited. "Abweichend" counts the explicit
settings whose value differs from what that level would inherit; a setting equal to the inherited
value is listed as "wie geerbt".

The page reads `GET /api/v1/admin/protocol-access/overview` (area *servers*, read-only):

```
{ protocols: [ { protocol, transport: 'listener'|'http', listenerService, server: 'on'|'off',
                 ports: [ { id, service, address, port, ssl, tlsMode, active, allowLegacyTls } ],
                 activePorts, enabledAnywhere,
                 overrides: { domains: { total, differing, entries: [ { id, name, setting, differs } ] },
                              users:   { … } },            // entries: first 25 by name
                 warnings: [ { code, protocol, ports? } ],
                 notices:  [ { code, protocol, ports } ] } ],
  smtpInbound: { ports, activePorts },                      // SMTP on non-submission ports (25)
  https: { active, port, cert: { id, name, trusted } | null },
  warnings: [ … ], notices: [ … ] }                         // all protocols
```

Warning codes: `no-active-port` (allowed for someone, no active port), `port-open-access-off`
(active port, off on the server and on for no domain or mailbox), `mapi-https` (MAPI on for
someone, HTTPS not active or its certificate not trusted — self-signed, staging, expired or not
covering the public host name). Notice code: `port-open-access-limited` (active port, off on the
server, on for at least one domain or mailbox). The names in `entries` need read access to the
area *domains* (domain names) or *recipients* (mailbox addresses); without it the group keeps
`total` / `differing`, `entries` is empty and `namesHidden: true` (SERVER_MANAGEMENT sees the
domains but only the number of mailboxes). SMTP submission ports are 465 and 587 (`SMTP_PORT_465`,
`SMTP_PORT_587`); every other SMTP port is inbound. Writes go through the existing routes — the
level routes below and `/api/v1/admin/services/listeners/*`.

## Levels and resolution

There are three levels:

```
server  →  domain  →  mailbox (user)
```

Domain and mailbox switches have the value `inherit`, `on` or `off`; the **most specific value that
is not `inherit` wins**. The server level has nothing to inherit from, so it is **two-state**: `on`
or `off` (`inherit` is refused with 400). A server switch that was never written is the built-in
default — every protocol on, MAPI off — so an installation without any switch behaves exactly as
before 9.4, and the server view always shows the value in force.

The server level of JMAP is the existing JMAP switch (`ServerSettings.jmapEnabled`, BCP → Server →
"JMAP", `coremail connector enable|disable jmap`). Both ways change the same value. While JMAP is off
on the server level and no domain or mailbox switches it on, the JMAP endpoints answer 404 as
before; as soon as one domain or mailbox turns JMAP on, the service answers and checks every
account after authentication (403 for the others).

Storage: table `protocol_policies` (one row per level — id `global`, or `domainId` / `userId`;
deleted together with the domain or user). The schema change is additive.

## Enforcement

The switch is checked **after** a successful authentication, never before: a wrong password always
gets the protocol's normal "invalid credentials" answer, so the switch reveals nothing to someone
without the password. A correct password with the protocol off gets:

| Protocol            | Answer                                                                              |
|---------------------|-------------------------------------------------------------------------------------|
| IMAP                | `NO [AUTHORIZATIONFAILED] IMAP access is disabled for this account`                 |
| POP3                | `-ERR [AUTH] POP3 access is disabled for this account`                              |
| SMTP submission     | `535 5.7.1 Mail submission is disabled for this account` (not counted as an AUTH failure) |
| ActiveSync          | HTTP 403 (no `WWW-Authenticate`, so devices stop syncing instead of asking for a password) |
| JMAP                | HTTP 403 `application/problem+json` (Basic, Bearer, WebSocket upgrade)              |
| MAPI over HTTP      | HTTP 403 (no `WWW-Authenticate`), the session named by the cookie ends             |
| CalDAV / CardDAV    | HTTP 403 (Basic and Bearer)                                                         |
| Web / REST API      | HTTP 403 `{ "code": "PROTOCOL_DISABLED", "protocol": "webmail" }`                  |

The mail protocols share the check in `verifyMailCredentials()` (`@coremail/storage`), which returns
the status `protocol_disabled`; tokens (JMAP/CalDAV Bearer) use `isProtocolAllowed()`, web/API
sessions `webAccessRefusal()` (`@coremail/storage/auth`, used by the api-gateway `requireAuth` and
the auth-service account-security routes). Database errors are temporary failures
(`NO [UNAVAILABLE]`, 503 …), never "allowed" and never a password prompt.

Push channels follow the switches as well: JMAP push subscriptions are only notified for accounts
with JMAP on, Web Push and the mailbox events of the event stream only for accounts with Webmail on.

### Webmail and administrators

`webmail` off refuses the web login and every use of a session on the webmail / user API. Accounts
with an **admin role are never locked out of the BCP** by it: they can still log in to the BCP and
the admin CLI, and their session keeps the admin surface — `/api/v1/admin/*` (whose guards check the
role as before), the event stream `/api/v1/events` (without mailbox events) and their account
security under `/auth/mfa`, `/auth/app-passwords`, `/auth/sessions` (MFA setup is needed for the BCP
when MFA is mandatory for admins). The webmail itself is refused for them as well: its login,
MFA step, SSO exchange and refresh (requests with `X-CoreMail-Client: web` and without
`X-CoreMail-App: bcp`) answer 403, and the webmail API answers 403. The header only selects which
session is asked for; every API request is checked by its path anyway.

The webmail shows "Webmail ist für dieses Konto deaktiviert …" at login and ends a running session
as soon as an API call or a token refresh answers 403 `PROTOCOL_DISABLED`.

Accounts without an admin role lose the account-security routes too, so an MFA account with
Webmail off cannot create new app passwords — the existing ones keep working on the protocols that
are on.

## Changes take effect immediately

A change compares the effective access of every account in scope (one user, the users of a domain,
or all users) before and after the write. Each account whose access changed gets the invalidation
event `protocol-access-change` with the list of protocols that are now off (`disabledProtocols`):

- cached results are dropped in every service (otherwise a 30 s cache applies);
- open connections on a protocol that is now off end at once — IMAP `* BYE IMAP access has been
  disabled …` (also during IDLE), POP3 `-ERR [AUTH] POP3 access is disabled …`, SMTP
  `421 4.7.0 … Mail submission has been disabled …` (after a running DATA transfer), ActiveSync Ping
  → 403, JMAP WebSocket close 1008 / EventSource end, the webmail event stream of non-admin accounts.
  Connections on other protocols and of other users stay open.
- Webmail: access tokens are refused on the next request (403), a refresh is refused (403); the
  event stream of an admin account stays open but carries no more mailbox events, Web Push stops.
- Anonymous lookups (Autodiscover v2, autoconfig) use an in-memory index of the server and domain
  switches (60 s); a change drops it in every service (`CHANNEL_SETTINGS_RELOAD`). A request never
  costs a database query of its own, whatever domain name it sends.

## Autodiscover, autoconfig, Apple profile, external clients page

Only enabled protocols are announced:

- **Autodiscover v1** (authenticated): the account's switches — IMAP, else POP3, plus SMTP; the
  mobilesync answer only with ActiveSync on; the `mapiHttp` block only with `mapi` on (and a client
  asking for it with `X-MapiHttpCapability`, a trusted HTTPS certificate — see [mapi.md](mapi.md));
  nothing left → Error 500 "No client protocol is enabled for this account."
- **Autodiscover v2** and **Thunderbird autoconfig** (anonymous): the switches of the mail
  domain (server + domain level, never a single account, so nothing about an account can be learned).
  A protocol that is off is `404 NoSuchProtocol` (v2) or missing from `config-v1.1.xml`.
- **Apple profile** (`/api/v1/user/apple-profile`): mail via IMAP, else POP3 (the payload format
  requires the outgoing server, so SMTP is part of the mail payload), CalDAV/CardDAV only with `dav`,
  the ActiveSync variant only with `activesync`; nothing to set up → 403 `PROTOCOL_DISABLED`.
- **Webmail → Settings → External clients** (`GET /api/v1/user/client-config`): the answer lists
  the account's switches in `protocols` (`imap`, `pop3`, `smtp`, `activesync`, `dav`); the setup data
  of a protocol that is off is `null`, and the page shows only the enabled parts (mail servers,
  CalDAV/CardDAV with the Outlook hints, the Apple profile variants).

## Administration

**BCP**: server level under *Protokolle & Dienste* (access switch per protocol, next to its
ports), domain level in *Domain bearbeiten*, mailbox level in the mailbox edit dialog (Erben / An /
Aus — "Erben" names what it resolves to, e.g. "Erben (an)"). Every row shows the effective value and
the level that decides it, e.g. "aus (Domain)", "an (serverweit)", "an (Postfach)".

**Admin API**:

```
GET|PUT /api/v1/admin/protocol-access                 server level (on | off)
GET|PUT /api/v1/admin/protocol-access/domains/:id     domain level (inherit | on | off)
GET|PUT /api/v1/admin/protocol-access/users/:id       user level   (inherit | on | off)
PUT body: { "imap": "off", "webmail": "inherit", … }   (only the switches to change)
Answer:   { level, id?, protocols, settings, inherited, inheritedFrom, effective, changedUsers? }
GET     /api/v1/admin/protocol-access/overview        ports + access + overrides + warnings (see "Ports vs. Zugriff")
```

`inherited` is what `inherit` resolves to on that level (on the server level: the built-in
defaults), `inheritedFrom` where it comes from per protocol (`default` on the server level, `server`
on the domain level, `domain` or `server` on the user level). The overview needs read access to the
area *servers*. RBAC: server and domain level need write
access to the area *servers* (SERVER_MANAGEMENT, ORGANIZATION_MANAGEMENT; readers of *domains* may
read the domain level), the user level the area *recipients* (RECIPIENT_MANAGEMENT; HELP_DESK and
VIEW_ONLY_ORG read) — switches of an admin account only ORGANIZATION_MANAGEMENT. Every change is in
the audit log as `settings.protocol-access.update` with the changed switches (before/after) and the
number of affected accounts; `settings.*` actions are logged even with the audit toggle off.

**CLI**:

```bash
coremail protocol show                                   # combined view: access, ports, overrides, warnings
coremail protocol show --scope global                    # server level switches
coremail protocol show --scope domain example.com
coremail protocol set --scope user alice@example.com --imap off --webmail inherit
coremail protocol set --mapi off --pop3 off              # server level
```

Values: `on`, `off`, `inherit` (`inherit` only with `--scope domain|user`). `--json` prints the API
answer.
