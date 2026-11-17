# Autodiscover

CoreMail answers the automatic account setup of Outlook, iOS Mail, Android ActiveSync clients,
Thunderbird and Apple devices. Package `packages/autodiscover` (port 8081, loopback); the
api-gateway proxies the public paths. The behaviour follows the public Microsoft Open
Specifications MS-OXDSCLI (Outlook), MS-OXDISCO (discovery order) and MS-ASCMD (ActiveSync
Autodiscover).

| Endpoint | Clients | Auth |
|---|---|---|
| `POST`/`GET /autodiscover/autodiscover.xml` (v1, POX) | Outlook 2010–2021, Microsoft 365 classic, iOS Mail, Android EAS | Basic |
| `GET /autodiscover/autodiscover.json/v1.0/<email>?Protocol=…` and `GET /autodiscover/autodiscover.json?Email=…&Protocol=…` (v2, JSON) | Outlook 2016+ | none |
| `GET /.well-known/autoconfig/mail/config-v1.1.xml`, `GET /mail/config-v1.1.xml` | Thunderbird, eM Client | none |
| `GET /api/v1/user/apple-profile` | Apple devices (`.mobileconfig`) | MWA session |

Paths are case-insensitive (`/Autodiscover/Autodiscover.xml`, `/autodiscover/autodiscover.xml`,
`/AutoDiscover/AutoDiscover.xml` …).

## DNS

Outlook tries, in this order (MS-OXDISCO):

1. `https://<domain>/autodiscover/autodiscover.xml`
2. `https://autodiscover.<domain>/autodiscover/autodiscover.xml`
3. `http://autodiscover.<domain>/autodiscover/autodiscover.xml` — "HTTP redirect method", see below
4. DNS SRV `_autodiscover._tcp.<domain>`

Recommended records (BCP → SMTP-Konfiguration → DNS-Einträge shows the values):

```
autodiscover.example.com.          CNAME  mail.example.com.
_autodiscover._tcp.example.com.    SRV    0 0 443 mail.example.com.
```

The certificate served for `autodiscover.<domain>` must cover that name (BCP → SSL/TLS; the HTTPS
proxy selects the certificate by SNI). With the SRV record Outlook asks the user once whether
`mail.example.com` may configure the account — expected behaviour.

## v1 (POX) — request handling

1. **Plain-HTTP probe.** An unauthenticated `GET` that arrived over plain HTTP is answered with
   `302 Found` to the HTTPS endpoint — never with a password challenge. The gateway does this
   itself while the integrated HTTPS proxy is active (`302` for the Autodiscover XML path, `308`
   elsewhere — older Outlook builds do not follow `308`); behind an external TLS terminator with
   `TRUST_PROXY` the autodiscover service does it from `X-Forwarded-Proto` when the configured
   Autodiscover URL (BCP → Server) is `https://`. It only does so when the gateway marks the
   scheme as known (`X-CoreMail-Proto-Verified`: TLS socket, trusted proxy or a direct client).
   Behind a reverse proxy **without** `TRUST_PROXY` the gateway cannot tell HTTP from HTTPS
   clients — a redirect would loop — so the probe gets the `401` challenge as before; set
   `TRUST_PROXY` to the proxy address to get the redirect.
2. **Challenge.** Any request without `Authorization: Basic …` (no header, `Negotiate`, `NTLM`,
   `Bearer`) gets `401` with `WWW-Authenticate: Basic realm="CoreMail Autodiscover"`, without any
   database access. The scheme is case-insensitive.
3. **Credentials** are verified by the shared mail-protocol check (MFA users need an app password,
   shared lockout → `429`, database error → `503`). An unknown account and a wrong password get the
   identical `401` — the answer does not reveal whether an account exists.
4. **Address.** `EMailAddress` (POST body) or `emailaddress` (GET query) must be the caller's own
   primary address or one of its aliases. Any other address — another user, an unknown address, a
   foreign domain — gets the same `Error 500` ("The e-mail address cannot be found"), with no name
   or id.
5. **Schema.** `AcceptableResponseSchema` `…/outlook/responseschema/2006a` (default) → IMAP + SMTP
   account; `…/mobilesync/responseschema/2006` → ActiveSync URL; anything else → `Error 601`.

The body is read as text whatever the `Content-Type` says (some device clients send none or
`application/xml`), limited to 64 KiB; namespace prefixes and XML entities are understood.

### Response (Outlook schema)

* `<User>`: display name, `LegacyDN`, `AutoDiscoverSMTPAddress` = the **primary** address.
* One `<Account>` (`AccountType email`, `Action settings`) with an IMAP and an SMTP `<Protocol>`:
  `LoginName` = primary address (the mail protocols log in with it; an alias request is answered
  for the primary account, no `redirectAddr` round trip), `SSL` plus an explicit `<Encryption>`
  (`SSL` = implicit TLS, `TLS` = STARTTLS; CoreMail refuses a login before TLS, so plain is never
  announced for IMAP).
* No `EXCH`, `EXPR`, `EXHTTP`, MAPI or EWS blocks — those would make Outlook attempt an Exchange
  RPC connection. CoreMail never sends `redirectUrl` either (single server, no foreign Autodiscover
  endpoint to point at).

### Endpoints follow the enabled listeners

Host names and ports come from BCP → Server (IMAP/SMTP/POP3 host + port + SSL), checked against
the listeners in BCP → Dienste:

* no listener row uses the configured port → announced unchanged (a NAT or port mapping may
  translate it);
* an active listener uses it → its TLS mode is announced;
* only a **disabled** listener uses it → the first active listener of that protocol is announced
  instead (implicit TLS preferred; SMTP considers the submission ports 465/587 only).

The same applies to v2, Thunderbird autoconfig and the values derived from them. If the listener
table cannot be read, the configured values are announced.

## v2 (JSON)

Anonymous by design and identical for every address (no account disclosure).
`Protocol=AutodiscoverV1` → the v1 URL; `IMAP`, `SMTP` → host/port/`SSL`; `ActiveSync` → URL;
`EWS` and unknown protocols → `404 NoSuchProtocol`.

## Client matrix (tests)

`packages/autodiscover/src/client-matrix.test.ts` replays the request shapes of Outlook 2010,
2013, 2016, 2019, 2021 and Microsoft 365 classic, iOS Mail and Android ActiveSync clients (paths,
headers such as `X-MapiHttpCapability`/`X-AnchorMailbox`, bodies, content types) against the app:
challenge first, correct schema afterwards, no RPC blocks, listener-driven endpoints, identical
answers for unknown accounts, the plain-HTTP 302 and the v2 discovery sequence. The e2e step
`legacy-clients` checks the live stack.

## Old Outlook profiles

* Outlook 2010/2013 profiles created against an Exchange server keep failing (they expect
  MAPI/RPC). Create a new profile; Autodiscover now sets up IMAP + SMTP.
* Outlook 2010 on Windows 7 needs TLS 1.2 for HTTPS and the mail ports, or the opt-in
  [TLS 1.0/1.1 switch](legacy-tls.md) on the HTTPS proxy and the IMAP/SMTP listeners it uses.
* Users with MFA enter an app password (MWA → Einstellungen → Sicherheit).
* Calendar and contacts: see [outlook-caldav.md](outlook-caldav.md).
