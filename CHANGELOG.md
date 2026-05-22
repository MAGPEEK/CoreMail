# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

> **Hinweis:** Aus Übersichtsgründen sind hier nur die drei jüngsten Releases gelistet.
> Die komplette Historie aller älteren Versionen ist über die git history einsehbar:
> `git log -p --follow CHANGELOG.md` oder über das GitHub-Repository.

---

## [Unreleased]

---

## [3.17.37] — 2026-05-22 — BCP SSL/TLS: Banner entfernt, Services auf SMTP/IMAP/POP3 reduziert

### Changed

- **BCP → SSL/TLS → Zertifikate**: Grauer Info-Banner bei fehlendem HTTPS-Zertifikat entfernt —
  die Seite zeigt keinen Banner wenn kein Cert aktiv ist (grüner Banner bleibt bei aktivem HTTPS).

- **Service-Auswahl in Zertifikat-Formularen** (Let's Encrypt, Upload, Self-Signed): Reduziert
  auf `SMTP`, `IMAP`, `POP3` — Web-Services (MWA, BCP, EWS, CalDAV, Autodiscover) entfernt,
  da HTTPS ausschließlich über das Schloss-Symbol aktiviert wird und nicht über die Services-Liste.

---

## [3.17.36] — 2026-05-22 — HTTPS_PROXY_ENABLED entfernt — integrierter Proxy immer aktiv

### Removed

- **`HTTPS_PROXY_ENABLED`-Umgebungsvariable** vollständig entfernt aus `tls-proxy.ts`,
  `routes/admin/certificates.ts`, `docker-compose.yml` und `docker-compose.synology.yml`.
  Der integrierte HTTPS-Proxy ist immer aktiv — er startet Port 443 nur wenn ein
  Zertifikat mit `isActiveHttps: true` vorhanden ist, ansonsten bleibt Port 443 geschlossen.
  Kein Konfigurations-Toggle mehr nötig.

- **`isTlsProxyEnabled()`-Export** aus `tls-proxy.ts` entfernt.

- **`enabled`-Feld** aus der `/tls-proxy-info`-API-Response entfernt.

- **„Integrierter HTTPS-Proxy deaktiviert"-Banner** aus BCP → SSL/TLS entfernt.
  Der Banner zeigt jetzt nur noch zwei Zustände: HTTPS aktiv (grün) oder kein
  HTTPS-Zertifikat aktiv (grau mit Hinweis).

---

## [3.17.35] — 2026-05-22 — Zertifikat-Logik: Vollständige Entkopplung HTTPS/Protokoll + Self-Signed-Default

### Changed

- **Zertifikat-Aktivierung entkoppelt** (`api-gateway` → `routes/admin/certificates.ts`):
  HTTPS-Proxy (Schloss-Symbol) und Protokoll-TLS (Server-Symbol) für SMTP/IMAP/POP3 sind
  vollständig **unabhängig** — ein Zertifikat kann nur für HTTPS, nur für Protokolle, oder
  für beides aktiv sein. `activate-https` berührt `isActiveProtocol` nicht mehr.

- **Self-Signed-Standard**: `server_settings.tlsCert/tlsKey = NULL` ist der Normalzustand.
  SMTP/IMAP/POP3 generieren automatisch ein Self-Signed-Cert aus `publicHostname` wenn
  keine explizite Aktivierung erfolgt ist. Kein implizites Auto-Aktivieren beim Erstellen
  oder Hochladen eines Zertifikats.

- **Startup-Sync** (`syncProtocolCertState()`): Ersetzt die alte `migrateCertProtocolBinding()`
  — prüft beim Container-Start ob `server_settings.tlsCert` vorhanden aber kein
  `isActiveProtocol: true`-Cert in der DB existiert (verwaistes Cert) und bereinigt dies.

- **Zertifikat löschen — vollständige Bereinigung**: Wird ein Zertifikat gelöscht das
  `isActiveProtocol: true` ist, werden `server_settings.tlsCert/tlsKey` auf NULL gesetzt
  und SMTP/IMAP/POP3 laden sofort das Self-Signed-Fallback. War das Cert für HTTPS aktiv,
  wird der HTTPS-Proxy ebenfalls deaktiviert.

- **BCP — Zertifikate-Seite** (`admin-panel` → `CertificatesPage.tsx`):
  Server-Symbol (SMTP/IMAP/POP3) ist jetzt **immer** für alle ACTIVE/EXPIRING-Certs
  sichtbar — unabhängig vom HTTPS-Status. Toast-Meldungen und Tooltips korrekt getrennt.
  Lösch-Bestätigung warnt wenn das Cert für HTTPS oder Protokoll-TLS aktiv ist.
  Info-Banner erklärt die Unabhängigkeit beider Aktivierungsarten.

---

## [3.17.34] — 2026-05-22 — DNS-Check: Lokaler Resolver, kein Resolver-Banner/Badges/Details

### Changed

- **DNS-Eintragscheck** (`api-gateway` → `routes/admin/domains.ts`): Verwendet jetzt den
  **lokalen DNS-Resolver** des Servers (`dns.promises`) statt drei externen Resolvern
  (Google/Cloudflare/Quad9). API-Response vereinfacht: nur noch `ok`, `found`, `warning?`
  pro Eintrag — kein `resolvers[]`, `consistent`, `checkedAt`, `resolversUsed` mehr.

### Removed

- **Externe-Resolver-Banner** (BCP → SMTP & Routing → DNS-Einträge): Der blaue
  Info-Banner „Externe Resolver: Google (8.8.8.8) Cloudflare (1.1.1.1) Quad9 (9.9.9.9)"
  wurde entfernt.

- **Per-Resolver-Badges**: Die farbigen Google/Cloudflare/Quad9-Badges mit Latenzanzeige
  unter jedem DNS-Eintrag wurden entfernt.

- **Aufklappbare Resolver-Detailansicht**: Der „▼ Resolver-Details anzeigen"-Link mit
  IP, Latenz und gefundenem Wert pro Resolver wurde entfernt.

- **Inkonsistenz-Warnung**: Der orangene „Resolver-Inkonsistenz"-Hinweis wurde entfernt
  (nicht mehr relevant ohne Multi-Resolver-Abfrage).

- **„Geprüft um HH:MM:SS"-Zeitstempel** im DNS-Header entfernt (keine `checkedAt`-
  Information mehr in der API-Antwort).

---

## [3.17.33] — 2026-05-22 — Fix: Redis-Kanal in Startup-Migration (CHANNEL_SETTINGS_RELOAD)

### Fixed

- **🔧 Startup-Migration `migrateCertProtocolBinding()`**: Falsche Redis-Channel-
  Bezeichnung `'coremail:settings:reload'` wurde durch die korrekte Konstante
  `CHANNEL_SETTINGS_RELOAD` (`'settings:reload'`) aus `@coremail/core` ersetzt.
  Ohne diesen Fix wurden SMTP/IMAP/POP3-Server beim ersten Container-Start nach
  dem Upgrade nicht über das neue TLS-Zertifikat informiert — die Protokoll-Server
  liefen trotz korrekter DB-Einträge weiter mit dem alten selbstsignierten Cert.

---

## [3.17.32] — 2026-05-22 — Fix: TLS-Cert Logik — ein Cert für alle Protokolle (SMTP 503 behoben)

### Fixed

- **🔒 503 5.5.1 Bad sequence of commands — Root Cause behoben**: Das Zertifikat
  für `mail.stefanwuestner.de` wurde NUR für den HTTPS-Proxy (MWA/BCP) aktiviert,
  SMTP/IMAP/POP3 nutzten weiterhin das alte selbstsignierte Zertifikat aus
  `ServerSettings.tlsCert/tlsKey`. Externe MTAs (Google, Outlook) lehnten den
  STARTTLS-Handshake ab → 503.

- **🏗️ `activate-https` aktiviert jetzt IMMER auch SMTP/IMAP/POP3**: Wenn das
  Schloss-Symbol angeklickt wird, schreibt der Server das Zertifikat ATOMAR in
  `ServerSettings.tlsCert/tlsKey` UND sendet `CHANNEL_SETTINGS_RELOAD` — alle
  Mail-Protokoll-Server laden das neue Cert sofort ohne Neustart.

- **🛑 Entfernt: MWA+BCP Services-Pflicht für Schloss-Button**: Der Lock-Button
  war bisher nur sichtbar wenn das Cert explizit die Services `MWA` und `BCP`
  hatte — eine willkürliche Hürde ohne technischen Grund. Jetzt zeigt jedes
  gültige Zertifikat (ACTIVE/EXPIRING) den Lock-Button.

### Added

- **`isActiveProtocol` Feld** (`Certificate`-Prisma-Modell): Zeigt im BCP an welches
  Zertifikat aktuell für SMTP/IMAP/POP3 (Ports 465/993/995) aktiv ist —
  unabhängig vom HTTPS-Proxy-Status.

- **`POST /admin/certificates/:id/activate-protocol`**: Neuer Endpunkt für Setups
  mit externem Reverse Proxy (Traefik, Caddy, Synology DSM) wo der integrierte
  HTTPS-Proxy deaktiviert ist, aber der Mailserver ein CA-signiertes Cert für
  SMTP/IMAP/POP3 benötigt.

- **Server-Icon im BCP** (`CertificatesPage`): Neues <Server>-Symbol neben dem
  Schloss — klickt man darauf, wird das Cert nur für Protokoll-TLS aktiviert
  (ohne HTTPS-Proxy). Zeigt blaue Farbe wenn `isActiveProtocol: true`.

- **Detail-Ansicht** (aufgeklappte Zeile): Zeigt jetzt BEIDE Status separat —
  _HTTPS-Proxy (Port 443)_ und _Protokoll-TLS (SMTP/IMAP/POP3)_ mit eigenem
  Icon, damit der Admin sofort sieht was wo aktiv ist.

### Changed

- **`deactivate-https`**: Stoppt nur den HTTPS-Proxy, berührt `isActiveProtocol`
  NICHT — SMTP/IMAP/POP3 laufen mit dem gleichen Cert weiter wenn der Admin
  von integriertem Proxy auf externen Traefik/Caddy wechselt.

---

## [3.17.31] — 2026-05-22 — DNS-Prüfung: Echte Multi-Resolver-Verifikation

### Added

- **🔍 Echte DNS-Verifikation via externe Resolver** (`api-gateway` → `routes/admin/domains.ts`):
  Anstatt den Docker-internen Resolver (127.0.0.11, oft gecacht/veraltet) zu befragen,
  werden MX, SPF, DKIM, DMARC, Autodiscover und PTR/FCrDNS jetzt direkt bei
  **Google (8.8.8.8)**, **Cloudflare (1.1.1.1)** und **Quad9 (9.9.9.9)** geprüft.
  `dns.promises.Resolver.setServers()` — kein Umweg über das System-DNS.

- **🌐 PTR / FCrDNS-Prüfung**: Reverse-DNS `A → PTR → Rück-A` wird automatisch auf
  echten öffentlichen Resolvern verifiziert. Status grün nur wenn PTR zum eigenen
  Hostnamen auflöst (Forward-confirmed, Pflicht für Gmail).

- **⚠️ SPF-Mehrfach-Record-Erkennung**: RFC 7208 §3.2 erlaubt genau einen SPF-TXT-
  Record. Wenn zwei vorhanden sind → `permerror` bei allen Empfängern. Das BCP
  zeigt jetzt eine explizite rote Warnung + Korrekturhinweis.

- **📊 Per-Resolver-Badges im BCP** (`admin-panel` → `SmtpConfigPage.tsx`):
  Jede DNS-Zeile zeigt farbige Badges für Google/Cloudflare/Quad9 mit Latenz
  (grün = gefunden, rot = nicht gefunden/Fehler). Aufklappbare Detailansicht
  pro Resolver mit exaktem Befund und Fehlermeldung.

- **🔄 Konsistenz-Warnung**: Wenn zwei Resolver unterschiedliche Werte zurückgeben
  (z. B. frisch propagierende Einträge) → orangene „Inkonsistenz"-Warnung.

- **🕐 Zeitstempel + Resolver-Info-Banner**: DNS-Ergebnis zeigt Prüfzeitpunkt und
  welche öffentlichen Resolver befragt wurden.

### Fixed

- **Docker-DNS-Phantom**: Interne DNS-Ergebnisse stimmten nicht mit dem überein,
  was externe MTAs (Gmail, Outlook) tatsächlich sehen. Die neue Multi-Resolver-
  Prüfung spiegelt die Realität der öffentlichen DNS-Infrastruktur wider.

---

## [3.17.30] — 2026-05-22 — Outbound E-Mail-Pipeline komplett neu gebaut (Google-konform)

### Changed

- **🏗️ Strukturierter BullMQ-Job statt base64-Blob**: `POST /api/v1/mail/send` übergibt
  ab sofort eine strukturierte Nachricht (`StructuredMessage`) an den Worker — kein
  `rawMessage: base64`-Feld mehr. Das entlastet Redis erheblich (keine großen Blobs mehr).

- **📎 Anhänge via MinIO**: Hochgeladene Anhänge werden sofort in MinIO gespeichert
  (`outbound-queue/{jobId}/{filename}`). Der Worker lädt sie beim MIME-Aufbau herunter
  und bereinigt sie nach erfolgreicher Zustellung automatisch.

- **✍️ DKIM jetzt via nodemailer Transport-Option** (nicht mehr manuelles mailauth-Prepend):
  ```typescript
  nodemailer.createTransport({ host, ..., dkim: { domainName, keySelector, privateKey } })
  ```
  Das ist die robustere und von nodemailer empfohlene Methode. Die Signatur wird korrekt
  über den gesamten Message-Stream gebildet — kein Fehler durch nachträgliches
  Header-Einfügen mehr möglich.

- **🗂️ Sent-Kopie sauber getrennt**: Der RFC-5322-Buffer für den „Gesendete Elemente"-
  Ordner wird weiterhin in-memory aufgebaut (mit den bereits im RAM befindlichen Anhängen)
  — unabhängig vom Queue-Worker.

- **🧹 relay.ts bereinigt**: `ensureRfc5322Headers()` und `signMessage()` (mailauth) entfernt.
  RFC-5322-Pflicht-Header (From, Message-ID, Date) werden von api-gateway und SMTP-
  Submission-Handler garantiert; die Safety-Net-Funktion ist nicht mehr nötig.

- **📦 SMTP-Submission-Pfad kompatibel**: `OutboundJob.rawMessage` (base64) bleibt für
  den SMTP-Submission-Pfad (Ports 465/587) erhalten — E-Mail-Clients liefern vollständige
  RFC-5322-Nachrichten, keine Strukturierung nötig.

### Fixed

- **Order-Bug**: DKIM-Signierung und Header-Sicherheits-Check waren in der falschen
  Reihenfolge — Headers wurden nach der Signierung eingefügt, was die DKIM-Signatur
  ungültig gemacht hätte. Mit Transport-DKIM entfällt dieses Problem komplett.

---

## [3.17.29] — 2026-05-22 — Fix: RFC 5322 Compliance — From & Message-ID Header

### Fixed

- **🎯 Gmail 550 5.7.1 — From Header & Message-ID Header missing**: Ausgehende
  E-Mails wurden von Gmail mit folgenden Fehlern abgelehnt:
  - `550 5.7.1 ... 'From' header is missing`
  - `550 5.7.1 Messages missing a valid Message-ID header are not accepted`

  **Root Cause (api-gateway `routes/mail.ts`)**: Der `From`-Header wurde als
  Template-Literal gebaut: `"${user.displayName}" <${user.email}>`.
  - Wenn `displayName = null` → `"null" <email>` (ungültige Anzeige-Name-Zeichenfolge)
  - Wenn `displayName = ""` → `"" <email>` — leerer Quoted-String verletzt RFC 5322
    §3.4 (quoted-string MUSS mindestens ein Zeichen enthalten). Strenge Parser
    wie Gmail werten das als „From-Header fehlt".

  **Fix 1 — `api-gateway/routes/mail.ts`**: Wechsel auf Nodemailer-Objekt-Format:
  ```
  from: displayName ? { name: displayName, address: user.email } : { address: user.email }
  ```
  Nodemailer kodiert den Anzeige-Namen korrekt per RFC 2047 (falls Non-ASCII)
  und lässt ihn weg wenn er leer ist → `From: <email>` (sauber und gültig).
  Außerdem `date: new Date()` explizit gesetzt (RFC 5322 §3.6.1 Pflicht-Header).

  **Fix 2 — `smtp-server/outbound/relay.ts`**: Neue `ensureRfc5322Headers()`-
  Funktion als Sicherheitsnetz: Prüft vor jeder MX-/Smarthost-Zustellung ob
  `From`, `Message-ID` und `Date` im Header-Block vorhanden sind. Fehlen sie,
  werden sie automatisch vorangestellt und der Vorgang wird als WARN geloggt.
  Schützt alle Outbound-Pfade (REST-API + SMTP-Submission).

---

## [3.17.28] — 2026-05-21 — Fix: Self-Signed-Cert mit falscher CN (Outlook 503 root cause)

### Fixed

- **🎯 Outlook-365 503-Bounce — root cause gefunden**: Das gespeicherte self-signed
  Zertifikat hatte `CN=mail.localhost` statt `CN=mail.stefanwuestner.de`. Beim
  ersten Container-Start war `publicHostname` in der DB noch leer, also wurde das
  Cert mit Default-`mail.localhost` generiert und gespeichert. Spätere Restarts
  haben dieses Cert wiederverwendet → ewiger CN-Mismatch.

  TLS-Handshake klappte (OpenSSL bestätigt das), aber Outlook 365 validiert die
  **CN gegen den verbundenen Hostname** und lehnt bei Mismatch ab → ECONNRESET
  → NDR mit „503 5.5.1 Bad sequence of commands".

  **Fix in `smtp-server/src/server.ts`** `refreshTlsConfig()`:
  - Beim Cert-Load wird `certMatchesHostname()` geprüft (neue Helper-Funktion)
  - Self-signed Cert mit Mismatch → automatisch neu generiert mit aktuellem
    `_hostname` und in DB gespeichert
  - CA-signierte Certs (LE/Custom) werden NICHT neu generiert (könnten gültige
    SAN-Listen für mehrere Domains haben)

  Beim nächsten Container-Restart (oder Hostname-Änderung via BCP) wird das
  Cert automatisch korrigiert.

- **STARTTLS auf Port 25 wieder aktiviert**: Da das Cert jetzt die korrekte CN
  hat, akzeptieren auch Outlook 365 / strikte MTAs den TLS-Handshake. MX-Tools
  zeigt „Supports TLS" ✅.

### Removed

- **Auto-Let's-Encrypt-Bootstrap aus v3.17.27 entfernt**: Admin fordert LE
  manuell via BCP → SSL/TLS → „Let's Encrypt anfordern" an. Datei
  `packages/api-gateway/src/lib/auto-letsencrypt.ts` gelöscht.

### Hinweis: Self-Signed vs. Let's Encrypt

Das self-signed Cert ist jetzt **kompatibel** (korrekte CN/SAN). Aber:
- MTAs die **strict cert chain validation** machen (manche Banken) lehnen
  weiterhin ab — die brauchen einen vertrauenswürdigen Issuer
- Für 100% MTA-Kompatibilität: Let's Encrypt-Cert in BCP manuell anfordern

---

## [3.17.27] — 2026-05-21 — Auto-Let's-Encrypt beim Container-Start + STARTTLS-Revert

### Fixed

- **Outlook 365 lieferte wieder 503 mit v3.17.26**: Das STARTTLS-Advertise mit
  self-signed Cert hatte Outlook-365-Bounces erneut ausgelöst. Self-signed +
  STARTTLS ist NICHT kompatibel mit strikten MTAs — kein graceful Plain-Fallback.
  Fix: Self-signed → STARTTLS auf Port 25 wieder OFF (Verhalten von v3.17.19).

### Added

- **Automatische Let's Encrypt-Anforderung beim Container-Start**:
  Neuer Helper `packages/api-gateway/src/lib/auto-letsencrypt.ts`.
  30 Sekunden nach Server-Start wird geprüft:
  1. `ServerSettings.publicHostname` ist gesetzt UND nicht-lokal (kein `*.local`/`*.lan`/`localhost`)
  2. Kein aktives `LETSENCRYPT`- oder `CUSTOM`-Cert deckt den Hostname ab
  3. Email aus `ServerSettings.adminEmail` ODER Fallback `admin@{root-domain}`

  Wenn alle Bedingungen erfüllt → ACME HTTP-01 Challenge gestartet (production,
  nicht staging). Bei Erfolg: Cert wird ACTIVE, `ServerSettings.tlsCert`/`tlsKey`
  werden gesetzt, `CHANNEL_SETTINGS_RELOAD` wird gepublisht — alle Protokolle
  (SMTP/IMAP/POP3) laden den neuen Cert. **STARTTLS wird automatisch aktiviert**
  weil `isCertSelfSigned()` nun `false` zurückgibt.

  Bei Fehler: Log-Warning, kein Crash. Manuelle Anforderung via
  BCP → SSL/TLS → „Let's Encrypt anfordern" weiterhin möglich.

  **Voraussetzungen für Erfolg:**
  - Port 80 von außen erreichbar (HTTP-01 Challenge)
  - DNS-A-Record für `publicHostname` zeigt auf Server-IP
  - Keine Let's-Encrypt-Rate-Limit-Sperre (50 Certs/Domain/Woche)

### Refactored

- `runAcmeIssuance()` in `routes/admin/certificates.ts` als `export` markiert
  damit sie auch vom Auto-LE-Bootstrap genutzt werden kann

---

## [3.17.26] — 2026-05-21 — Fix: MX-Tools "Does not support TLS" — STARTTLS wieder aktiv

### Fixed

- **MX-Tools-Warnung „SMTP TLS Warning - Does not support TLS"**:
  In v3.17.19 wurde STARTTLS auf Port 25 für self-signed Certs hart deaktiviert
  um Outlook-365-Handshake-Fehler zu vermeiden. Resultat: MX-Tools sah kein TLS
  → Warning. Auch wenn die meisten MTAs (Gmail, Apple, ProtonMail, AOL …)
  Opportunistic TLS mit self-signed Certs akzeptieren.

  **Korrekter Trade-off**: Opportunistic TLS ist **immer besser** als kein TLS:
  - ~95% der MTAs akzeptieren self-signed im opportunistic-Modus
  - Strikte MTAs (Microsoft 365) fallen auf Plain zurück bei TLS-Handshake-Fehler
    (kein Bounce, nur kein TLS für diese Verbindung)
  - MX-Tools-Scoring belohnt TLS-Verfügbarkeit

  Fix: `advertiseStarttls: true` immer (statt `!_tlsCertSelfSigned`).
  STARTTLS wird jetzt auch mit self-signed Cert in EHLO beworben.

### Dauerhafte Lösung für Outlook-365-Kompatibilität

Für vollständige TLS-Validierung in strikten MTAs (Microsoft 365, manche
Banken) ein **Let's Encrypt-Zertifikat** über BCP → SSL/TLS → Zertifikate →
„Let's Encrypt anfordern" für `mail.{domain}` ausstellen. Sobald aktiv:
- MX-Tools: ✅ TLS-Score voll
- Outlook 365: ✅ akzeptiert Cert ohne Probleme
- Self-signed Fallback wird nicht mehr genutzt

**Voraussetzungen für Let's Encrypt**:
- Port 80 von außen erreichbar (HTTP-01 Challenge)
- DNS-A-Record `mail.{domain}` zeigt auf Server-IP

---

## [3.17.25] — 2026-05-21 — MWA: Aufbewahrungsrichtlinien per Rechtsklick

### Added

- **MWA → Settings → Aufbewahrungsrichtlinien** (neue Sektion unter „Konto"):
  Zeigt alle vom Administrator aktivierten PERSONAL-Aufbewahrungstags mit Name,
  Beschreibung, Aufbewahrungstagen und Aktion. Read-only — Tags werden vom Admin
  in BCP angelegt; User wählen sie per Rechtsklick auf Ordner aus.

- **MWA → Ordnerbaum Rechtsklick → „Aufbewahrungsrichtlinie zuweisen"**:
  Submenu mit allen verfügbaren PERSONAL-Tags. Aktuell zugewiesener Tag
  bekommt ✓-Häkchen. Unten „Entfernen"-Eintrag um Zuweisung zu löschen.
  Funktioniert für System- UND Custom-Ordner (Exchange-Verhalten).

- **🕒-Badge** im Ordnerbaum: Ordner mit aktiver Aufbewahrungsrichtlinie zeigen
  ein kleines Uhr-Icon nach dem Ordnernamen — Tooltip mit Tag-Name + Tagen.

### Backend

- **`GET /api/v1/retention-tags`** (neu, `requireAuth`): Listet aktivierte
  PERSONAL-Tags sortiert nach Aufbewahrungstagen.
- **`PATCH /api/v1/mail/folders/:id/retention-tag`** (neu): Body `{ tagId: string | null }`.
  Owner-Verifikation; Tag muss PERSONAL und enabled sein.
- **`PATCH /api/v1/mail/messages/:id/retention-tag`** (neu): Wie oben für Messages.
- **`GET /api/v1/mail/folders`** erweitert: Liefert jetzt `retentionTagId` +
  `retentionTag { id, name, retentionDays, action }` Relation mit.

### Frontend

- 11 neue i18n-Keys (`retention_*`) in DE/EN/ES/IT
- `Folder`-Type um `retentionTagId` + `retentionTag` erweitert
- ContextMenu unterstützte bereits Submenus — nur Nutzung erweitert

---

## [3.17.24] — 2026-05-21 — BCP Compliance-Info-Seite aktualisiert

### Changed

- **BCP → Compliance → Info**: Highlights-Liste um v3.17.12 bis v3.17.23
  ergänzt (12 neue Einträge mit detaillierten Beschreibungen jeder Version).
  Version-Anzeige im Header aktualisiert (3.17.23 → 3.17.24).

---

## [3.17.23] — 2026-05-21 — Audit-Log: Komplettüberarbeitung mit PDF-Export + Statistik

### Fixed

- **CSV-Export schlug mit 401 fehl**: `window.open(…/export…)` öffnete neuen Tab
  ohne `Authorization`-Header. Fix: neuer Helper `exportUrl()` in api/client.ts
  hängt `?token=…` an die URL — `requireAuth` akzeptiert Token via Query bereits
  seit v3.17.18 (SSE-Fix).

- **Datums-Filter zeigte keine Daten**: `new Date('2026-05-20T23:59:59')` wurde
  als **lokale Zeit** interpretiert → in Berlin CEST (UTC+2) lag der UTC-Wert
  vor dem Tagesbeginn des From-Datums. Fix: explizit UTC mit
  `…T00:00:00.000Z` / `…T23:59:59.999Z`.

- **Purge-Route inkonsistent**: Frontend sendete `?olderThanDays=`, Backend las
  `req.body.before` — `400 Bad Request` bei jeder Bereinigung. **Komplett entfernt**
  — Audit-Logs sind per Compliance schreibgeschützt (siehe „Removed").

- **React Fragment key-Warning**: `<>...</>` ohne key bei Listen-Render durch
  `<React.Fragment key={e.id}>` ersetzt.

### Added

- **PDF-Export** (`GET /api/v1/admin/audit-log/export.pdf`): A4 quer mit Header,
  Filter-Zusammenfassung, Tabelle (Zeitpunkt/Akteur/Aktion/Ziel/Status),
  Seitennummern. Cap 1000 Einträge (größere Mengen → CSV). Verwendet `pdfkit`.

- **Statistik-Dashboard** (oben auf der Audit-Log-Seite, auto-refresh 30s):
  - 4 KPI-Karten: Gesamt-Einträge, letzte 24h, letzte 7 Tage, Fehlerquote
  - Top-10 Akteure (Balkendiagramm)
  - Top-10 Aktionen (Balkendiagramm)
  - Neuer Endpunkt: `GET /api/v1/admin/audit-log/stats`

- **Erweiterte Filter**:
  - `actorEmail` (Substring-Suche)
  - `ipAddress` (exakt)
  - `searchText` (durchsucht `action`, `targetName`, `errorMsg`)
  - 2-zeilen-Layout im Frontend mit Reset-Button

- **CSV-Export mit allen Spalten + UTF-8-BOM** (Excel-kompatibel):
  timestamp, actorId, actorEmail, action, targetType, targetId, targetName,
  ipAddress, userAgent, success, errorMsg, changes (JSON)

- **Schreibgeschützt-Banner** im BCP (dismissible, persistiert in localStorage):
  „Audit-Log ist schreibgeschützt — Einträge können auch von Admins nicht gelöscht
  oder verändert werden (Compliance-Anforderung)"

- **userAgent in Detail-Ansicht** der ausgeklappten Zeile

### Removed

- **`DELETE /api/v1/admin/audit-log/purge`**: Audit-Logs sind **immutable**
  (DSGVO, SOX, HIPAA, ISO 27001 Anforderung — Non-Repudiation).
  Frontend „Bereinigen"-Button entfernt. Bei späteren Retention-Bedürfnissen
  läuft das über die System-`RetentionPolicy` (außerhalb Admin-API).

### Auditlog — Kernfunktionen (siehe BCP → Compliance → Audit-Log):

| Säule | Umsetzung |
|---|---|
| **Accountability** | `actorId` + `actorEmail` + `ipAddress` + `userAgent` pro Eintrag |
| **Forensik** | Volltext-Suche, Zeitraum-Filter, JSON-`changes`-Diff |
| **Compliance** | Schreibgeschützt, kein Delete-Endpoint, CSV/PDF-Export |
| **Systemüberwachung** | Live-Statistik (24h/7d), Top-Akteure + Top-Aktionen |

---

## [3.17.22] — 2026-05-21 — Fix: Lokale Zustellung — Aliase, Verteilergruppen + SharedMailbox

### Fixed

Audit der lokalen Zustellung (Outbound-Queue + Submission-Port) deckte zwei
strukturelle Bugs auf. Mails an lokale Adressen wurden in mehreren Fällen
**silent verworfen** ohne Bounce-Nachricht oder Logging über „Mailbox not found".

- **Outbound-Queue (`smtp-server/outbound/queue.ts`) löste keine Aliase auf**:
  Beim Versand aus der MWA (POST /api/v1/mail/send) ging die Mail in die BullMQ-
  Queue. Der Worker prüfte zwar die Domain (local vs. external) aber rief
  `storeInboundMessage()` direkt mit der Original-Adresse auf. Bei einem
  E-Mail-Alias (z.B. `vertrieb@stefanwuestner.de` → `info@stefanwuestner.de`)
  oder einer Verteilergruppe konnte storeInboundMessage den User nicht finden
  → "Mailbox not found — dropping message".

- **Submission-Handler (Port 587/465) hatte denselben Bug**:
  Mail-Clients (Thunderbird/Apple Mail) die direkt an die Submission-Ports
  senden umgingen ebenfalls die Alias-Auflösung.

- **`storeInboundMessage()` kannte nur User-Postfächer, keine SharedMailbox**:
  Selbst nach Alias-Auflösung: wenn der Alias auf eine SharedMailbox zeigt,
  wurde die Mail verworfen weil die Funktion nur `prisma.user.findFirst(...)`
  abfragte. Jetzt parallel auch `prisma.sharedMailbox.findFirst(...)`.

### Changed

- **`expandRecipients()` aus `inbound/handler.ts` in `handlers/expand.ts` extrahiert**
  damit alle drei Eintrittspfade (Port 25 inbound, Port 587/465 submission,
  BullMQ outbound queue) dieselbe Logik nutzen
- **SharedMailbox-Quota** wird jetzt auch bei lokaler Zustellung inkrementiert
- **SSE `mail:new`-Event** wird bei SharedMailbox an alle User mit
  `FULL_ACCESS` oder `READ_ONLY` Permission publiziert → Live-Update im
  Posteingang aller Berechtigten

---

## [3.17.21] — 2026-05-21 — ESMTP-Audit: Stub-only Extensions entfernt

### Removed

Audit aller ESMTP-Erweiterungen — entfernt wurden alle die in EHLO beworben aber
**nicht implementiert** waren (Server hätte gegen die jeweilige RFC verstoßen):

- **AUTH CRAM-MD5 (RFC 4954/2195)** — `handleAuth` erkennt nur `PLAIN` und `LOGIN`,
  CRAM-MD5-Anfragen wurden mit `504 Unrecognized authentication type` abgewiesen.
  Toggle aus BCP entfernt, Default hardcoded `false`.

- **SMTPUTF8 (RFC 6531)** — UTF-8 in Envelope-Adressen wurde nicht gesondert behandelt
  (kein puny-Code-Mapping, kein Unicode-Normalization). Wenn beworben, hätten internationale
  Adressen (z.B. `用户@例子.公司`) zu inkonsistentem Verhalten geführt.

- **CHUNKING / BDAT (RFC 3030)** — Der Befehl `BDAT` wurde vom Command-Parser nicht
  erkannt und mit `500 Command not recognized: BDAT` abgewiesen.

### Verifizierte Implementierungen (bleiben aktiv)

| Extension | RFC | Status |
|---|---|---|
| STARTTLS | 3207 | ✅ Voll funktional, TLS-Upgrade implementiert |
| AUTH PLAIN | 4954 | ✅ `handleAuthPlain` |
| AUTH LOGIN | 4954 | ✅ `handleAuthLoginStart` |
| PIPELINING | 2920 | ✅ Buffer-basiertes Parsing (`lineBuffer`-Schleife in `onData`) |
| SIZE | 1870 | ✅ `SIZE=` Parameter geparst + `maxSize`-Check |
| 8BITMIME | 6152 | ✅ Buffer-basiert (binary encoding) — kein 7-bit-Downgrade |
| ENHANCEDSTATUSCODES | 2034 | ✅ Alle Codes folgen `x.y.z`-Format |

DB-Felder `extAuthCramMd5`, `extSmtputf8`, `extDsn`, `extChunking` bleiben aus
Backwards-Compat in der Datenbank, werden aber im Server hardcoded ignoriert.

---

## [3.17.20] — 2026-05-21 — Remove: DSN-Werbung entfernt (war ungenutzt)

### Removed

- **DSN (Delivery Status Notifications, RFC 3461)**: Der SMTP-Server hat DSN
  in der EHLO-Antwort beworben aber NICHT implementiert:
  - Keine Verarbeitung von `NOTIFY=`, `ORCPT=`, `ENVID=`, `RET=` Parametern
    in MAIL FROM / RCPT TO (wurden vom Regex stillschweigend weggeworfen)
  - Keine `multipart/report` + `message/delivery-status` Generierung beim Bounce
  - Keine SUCCESS/FAILURE/DELAY-Reports

  RFC 3461 verbietet das Bewerben einer Capability ohne Implementierung.
  Entfernt:
  - `DSN` aus EHLO-Response (`packages/smtp-server/src/core/session.ts`)
  - `DEFAULT_ESMTP_EXTENSIONS.dsn` jetzt `false` (Standard hard-codiert)
  - Toggle aus BCP → SMTP & Routing → ESMTP-Erweiterungen entfernt
  - Zod-Schema für `extDsn` in `routes/admin/smtp-config.ts` entfernt
  - DB-Feld `extDsn` bleibt erhalten (Backwards-Compat, wird aber ignoriert)

  Wenn DSN in einer späteren Version implementiert wird, kann der Toggle
  zurückkommen — solange aber stub-only: weg.

---

## [3.17.19] — 2026-05-21 — Fix: STARTTLS auf Port 25 mit self-signed Cert (Outlook 503)

### Fixed

- **Mails von Microsoft Outlook / Exchange werden mit `503 5.5.1 Bad sequence
  of commands` abgewiesen**: Der SMTP-Server bewarb STARTTLS auf Port 25 mit
  einem self-signed Zertifikat. Strikte MTAs wie Microsoft Exchange initiieren
  daraufhin den TLS-Handshake, lehnen das self-signed Cert ab (ECONNRESET) und
  geben einen 503-Fehler zurück.

  Fix: Self-signed Erkennung via `X509Certificate.issuer === subject`. Auf
  **Port 25 (Inbound)** wird STARTTLS NICHT mehr beworben wenn Cert self-signed
  ist — MTAs stellen dann in Plain zu (immer noch RFC-konform, opportunistic
  TLS wird übersprungen). Submission-Ports (465/587) bewerben STARTTLS weiterhin
  (eigene Clients akzeptieren self-signed mit `tls.rejectUnauthorized: false`).

  Nach Installation eines CA-signed Zertifikats (z.B. Let's Encrypt über BCP →
  SSL/TLS) wird STARTTLS auf Port 25 automatisch aktiviert.

---

## [3.17.18] — 2026-05-21 — Posteingang Auto-Refresh + manueller Refresh-Button

### Fixed

- **SSE-Events kamen nie an** (Posteingang aktualisierte sich nicht selbst):
  EventSource kann keine `Authorization`-Header senden, der api-gateway hat aber
  nur Bearer-Token aus dem Header gelesen → SSE-Verbindung schlug 401 fehl.
  Fix: `requireAuth`-Middleware akzeptiert jetzt zusätzlich `?token=…` als
  Query-Parameter (Fallback nur wenn kein Header). Frontend übergibt Token
  als Query in der EventSource-URL.

### Added

- **Live-Aktualisierung im Posteingang**: Sobald eine neue Mail eingeht
  (SSE-Event `mail:new` aus Redis-Channel `mail:new`), wird die Folder- und
  Messages-Liste automatisch neu geladen. Dezenter Toast zeigt
  Absender + Betreff der neuen Nachricht.
- **Manueller Refresh-Button**: Neben „Neue E-Mail" im Ordnerbaum erscheint
  ein 🔄 Icon-Button (mit Tooltip „Ordner aktualisieren") der Folders +
  Messages sofort neu lädt (`refetchQueries`, kein Hintergrund-Refetch)
- i18n-Keys `refresh_folders` / `refresh_done` in DE/EN/ES/IT

---

## [3.17.17] — 2026-05-21 — Fix: Autodiscover-URL nutzt jetzt eigene CNAME

### Fixed

- **Autodiscover-URL nutzte denselben Hostnamen wie alle anderen Pfade**:
  Bei `mail.stefanwuestner.de` als Hostname generierte „URLs ableiten" auch
  `http://mail.stefanwuestner.de:8080` für Autodiscover. Outlook erwartet aber
  nach **Microsoft Exchange Spec** IMMER `autodiscover.{primary-domain}` zuerst —
  also `http://autodiscover.stefanwuestner.de:8080`.

  Fix in `routes/admin/servers.ts` `/settings/derive`-Endpoint:
  - Hostname mit ≥ 3 Labels (z.B. `mail.stefanwuestner.de`) → erste Subdomain
    abschneiden → `autodiscover.stefanwuestner.de`
  - Hostname mit 2 Labels (z.B. `stefanwuestner.de`) → `autodiscover.stefanwuestner.de`
  - Hostname beginnt bereits mit `autodiscover.` → unverändert (kein Doppel-Präfix)

  DNS-Hinweis im BCP (Outlook-Anleitung) verwendet jetzt dieselbe Logik:
  zeigt `autodiscover.{root-domain} CNAME {publicHostname}` korrekt an

---

## [3.17.16] — 2026-05-21 — Fix: Login schlägt fehl (api-gateway hatte Duplikat-Auth mit altem Pepper-Bug)

### Fixed

- **Login funktioniert immer noch nicht** trotz Fix in v3.17.13: Der `api-gateway`
  hat eine EIGENE `/auth/login`-Route (`packages/api-gateway/src/routes/auth.ts`),
  die NICHT zum auth-service proxyed wird. Diese Route hatte exakt denselben
  Pepper-Bug: `bcrypt.compare(password + pepper, hash)` statt sha256+pepper.
  Damit verifizierte die Login-Route am Port 3000 niemals korrekt — am Port 3003
  direkt (auth-service) funktioniert es bereits seit v3.17.13.

  Fix: `verifyPassword()` und `hashPassword()` aus `@coremail/core` verwendet in:
  - `routes/auth.ts` — Login + Passwort-Reset
  - `routes/setup.ts` — Initial-Setup Admin-User
  - `routes/user.ts` — Passwort-Änderung (current + new password)

  Alle bcrypt-Direktimporte in diesen Dateien entfernt.

---

## [3.17.15] — 2026-05-21 — Verteilergruppen-Fix, Token-Refresh, BCP-Bereinigung

### Fixed

- **Verteilergruppen „Invalid request"**: Formular sendete komplette E-Mail-Adresse
  als Freitext (z.B. nur „verteilung" ohne @domain) → Zod-Validierung scheiterte.
  Formular jetzt wie Benutzerverwaltung: lokaler Teil + `@` + Domain-Dropdown nebeneinander.
  E-Mail wird aus `localPart@domain.name` zusammengesetzt bevor sie ans Backend geht

- **Auto-Logout trotz aktiver Nutzung**: JWT Access Token hat 15 Minuten TTL.
  BCP und MWA speicherten nur das Access Token, nie das Refresh Token.
  Bei 401 wurde sofort zur Login-Seite weitergeleitet.
  Fix in `admin-panel/src/api/client.ts` und `web-client/src/api/client.ts`:
  - Refresh Token wird bei Login in localStorage gespeichert
  - Proaktive Erneuerung wenn Token < 120s vor Ablauf steht (JWT exp dekodiert ohne Library)
  - Bei 401 wird erst einmal Refresh versucht + Request wiederholt, nur bei erneutem Fehler → Login

### Added

- **Verteilergruppen in MWA Empfänger-Autocomplete**: Beim Tippen einer Adresse im
  Compose-Fenster werden jetzt auch Verteilergruppen vorgeschlagen (via `GET /admin/groups/gal`),
  parallel zu Kontakten. Gruppen werden mit lila Avatar und `[Gruppe]`-Badge angezeigt

### Removed

- **BCP → Ressourcenpostfächer** (`/resources`): Seite und Navigation entfernt
- **BCP → Organisation** (`/organisation`): Seite und Navigation entfernt
- Beide zugehörigen Page-Dateien gelöscht (`ResourcesPage.tsx`, `OrganisationPage.tsx`)

---

## [3.17.14] — 2026-05-21 — Mailbox-Delegierung + User aktiv/inaktiv

### Added

- **Mailbox-Delegierung (Delegate Access)**: User B kann auf das Postfach von User A zugreifen —
  analog zur Shared-Mailbox-Logik (Exchange Delegate Access):
  - Neues Prisma-Modell `MailboxDelegate` mit `SharedMailboxPermType`-Enum:
    `FULL_ACCESS` / `READ_ONLY` / `SEND_AS` / `SEND_ON_BEHALF`
  - Admin-API `GET/POST/DELETE /api/v1/admin/mailboxes/:id/delegates`
  - User-API `GET /api/v1/mail/delegated-mailboxes` — gibt alle Postfächer zurück
    auf die der angemeldete User delegierten Zugriff hat
  - **BCP → Postfächer** — aufgeklappte Zeile zeigt jetzt Abschnitt „Delegate Access":
    bestehende Delegierungen mit Berechtigung + Entziehen-Button,
    Formular zum Gewähren (User-Dropdown + Berechtigungs-Dropdown)

- **User aktiv/inaktiv** (BCP → Postfächer): Bereits implementiert (Toggle-Button
  war schon vorhanden), explizit verifiziert: `active: false` blockiert Login
  in `authenticateLocal()` und `authenticateAppPassword()` vollständig

---

## [3.17.13] — 2026-05-21 — Fix: Login schlägt fehl (Passwort-Pepper-Mismatch)

### Fixed

- **Login schlägt fehl mit „Invalid credentials"** obwohl Passwort korrekt gesetzt ist:
  `auth-service/src/local/index.ts` verwendete eine eigene Pepper-Logik
  (`password + PEPPER` → direkt bcrypt.compare) während `@coremail/core`'s `hashPassword()`
  beim Anlegen des Users `sha256(password + PEPPER)` → bcrypt verwendet.
  Beide Funktionen unterschieden sich → Hash und Verify kamen nie überein.

  Fix: `authenticateLocal()` und `authenticateAppPassword()` nutzen jetzt
  `verifyPassword()` aus `@coremail/core` — dieselbe sha256+pepper Logik wie `hashPassword()`.
  `bcrypt`-Direktimport in `local/index.ts` entfernt.

- **App-Passwörter (IMAP/SMTP/POP3)** waren vom selben Bug betroffen:
  `bcrypt.compare(rawPassword, hash)` statt `verifyPassword()` → IMAP/SMTP-Auth mit
  App-Passwort schlug ebenfalls fehl. Ebenfalls auf `verifyPassword()` umgestellt.

---

## [3.17.12] — 2026-05-21 — BCP Vollständige Übersetzung (EN/DE) + Versionsabgleich

### Changed

- **Alle Package-Versionen synchronisiert**: Alle 17 `packages/*/package.json` hatten
  noch Version `3.7.9` — jetzt einheitlich `3.17.12`. `/healthz`-Endpoint und
  BCP → System-Informationen zeigen jetzt die korrekte Version

- **BCP vollständig übersetzt (Englisch/Deutsch)**: Alle verbleibenden Seiten verwenden jetzt
  `useT()` und `t()`-Keys statt hartkodierten deutschen Strings:
  - **MailboxesPage** — Tabelle, Modals (Neu, Bearbeiten, Löschen), Quota-Balken, Rollen
  - **DomainsPage** — DNS-Einträge, DKIM-Schlüssel-Modal, Domains-Tabelle, alle Aktionen
  - **QueuesPage** — Übersicht, Jobs-Tabelle, Einstellungen, alle Status-Labels
  - **DashboardPage** — KPI-Karten, Widget-Einstellungen, Server-Info, Angriffs-Events-Widget
  - **QuarantinePage** — Statistikkarten, Filter, Tabelle, Detail-Panel, Cleanup-Modal

- **translations.ts** erweitert auf ~1288 Schlüssel (vorher ~350):
  Neue Sektionen für Postfächer, Domains, Logs, Queues, Dashboard, Quarantäne, Schutzfilter

---

## [3.17.11] — 2026-05-21 — Multi-Fix: Mail-Body, lokale Zustellung, MessageTrace, Queue-Refresh, Übersetzungen

### Fixed

- **Mail-Body enthält rohe MIME-Header**: `buildRawMime()` verwendete `newline: 'unix'` (LF-only).
  nodemailer's `smtp-connection` normalisiert Buffer-Inhalte im DATA-Kanal NICHT (nur Strings).
  Der empfangende MTA konnte den Header/Body-Separator `\r\n\r\n` nicht finden → gesamter
  MIME-Inhalt wurde als Klartext-Body angezeigt. Fix: `newline: 'crlf'` (RFC 5321 konform)

- **Mails an lokale Adressen (admin@stefanwuestner.de) kommen nicht an**: MWA-Send-Endpoint
  (`POST /api/v1/mail/send`) schickte ALLE Empfänger in die Outbound-Queue ohne Local-Domain-Check.
  Queue-Worker versuchte MX-Delivery nach außen — scheiterte. Fix: Queue-Worker prüft jetzt
  vor `relayMessage()` ob die Empfänger-Domain in der lokalen Domain-Tabelle ist; lokale
  Empfänger werden direkt via `storeInboundMessage()` ins Postfach geschrieben

- **MessageTrace zeigt nie Ergebnisse**: API-Client fügt `/api/v1` automatisch als Präfix hinzu.
  `MessageTracePage` verwendete als Pfad `/api/v1/admin/message-trace` → doppelter Präfix `/api/v1/api/v1/...`
  → 404. Fix: Pfad korrigiert zu `/admin/message-trace` (ohne Präfix)

- **Queue-Refresh-Button geht nicht**: Page-Level-Button rief `invalidateQueries` (background
  refetch, kein visuelles Feedback) statt `refetchQueries` (sofortiger aktiver Refetch) auf.
  Fix: `qc.refetchQueries({ queryKey: ['admin-queue-jobs'] })` und `['admin-queue-stats']`

- **Spam landet im Posteingang statt im Junk-Ordner**: `storeInboundMessage()` suchte nach
  Ordner `'Junk E-Mail'` (Outlook-Sprache) — der Ordner heißt `'Junk'`. Fallback war INBOX.
  Fix: `'Junk'` und `'INBOX'` als korrekte Ordnernamen

- **MessageTrace: JUNK-Status fehlte** in Statusfilter und Badge-Anzeige. Hinzugefügt.

### Added

- **Gesendete Elemente (Sent-Ordner)**: Beim Senden über MWA wird jetzt automatisch eine Kopie
  im Sent-Ordner des Absenders gespeichert (war bisher nie implementiert). Große Mails (>256 KB)
  werden in MinIO abgelegt, kleine direkt in der DB. Flags: `\\Seen` (bereits gelesen markiert)

- **MessageTrace Auto-Load**: Öffnet jetzt mit den letzten Einträgen — kein manuelles Klicken
  auf "Suchen" mehr nötig. Reset-Button setzt alle Filter zurück und zeigt alle Einträge

- **MAIL_FLOW-Log im API-Gateway**: `POST /api/v1/mail/send` schreibt jetzt sofort einen
  `ACCEPTED`-SystemLog-Eintrag, damit Mails die über MWA gesendet werden sofort in der
  MessageTrace sichtbar sind (auch bevor die Queue sie verarbeitet)

---

## [3.17.10] — 2026-05-21 — Fix: Kopier-Buttons bei DNS-Einträgen

### Fixed

- **BCP → Domains → DKIM DNS-Eintrag / BCP → SMTP & Routing → DNS-Einträge**: Kopier-Buttons
  funktionierten nicht — `navigator.clipboard` ist im HTTP-Kontext (non-secure, z. B. DSM
  Application Portal) `undefined` und wirft einen Fehler.
  - Neuer gemeinsamer Helper `packages/admin-panel/src/utils/clipboard.ts`:
    `copyToClipboard()` versucht zuerst `navigator.clipboard.writeText()` (Secure Context)
    und fällt automatisch auf `document.execCommand('copy')` zurück (HTTP-Kompatibilität)
  - `DomainsPage.tsx`: beide Copy-Buttons (DNS-Name + TXT-Wert) nutzen jetzt `copyToClipboard()`
    mit korrektem `await` und `toast.error('Kopieren fehlgeschlagen')` im Fehlerfall
  - `SmtpConfigPage.tsx`: `CopyBtn`-Komponente nutzt `copyToClipboard()` statt direktem
    `navigator.clipboard.writeText()`; Fehlerfall zeigt Toast statt lautlosem Versagen

---

## [3.17.9] — 2026-05-20 — Fix: DKIM-Record laden schlägt fehl wenn kein Schlüssel vorhanden

### Fixed

- **BCP → Domains → DKIM DNS-Eintrag anzeigen**: Fehler „DKIM-Record konnte nicht geladen werden"
  wenn `dkimPrivateKey` in der Datenbank leer war (Domains die vor der automatischen
  Schlüssel-Generierung angelegt wurden hatten einen leeren Eintrag).
  - Backend `GET /:id/dkim-record` generiert jetzt automatisch ein RSA-2048-Schlüsselpaar
    und speichert es wenn keines vorhanden ist — Fehler tritt nicht mehr auf
  - Backend `GET /:id/dns-check` ist ebenfalls abgesichert (try/catch + `ensureDkimKey`)
  - Neuer Endpoint `POST /:id/regenerate-dkim` — explizites Neu-Generieren des Schlüsselpaares

### Added

- **BCP → Domains → DKIM**: Schaltfläche „Neu generieren" (erscheint nach dem ersten Laden)
  — generiert ein neues RSA-2048-Schlüsselpaar mit Bestätigungsdialog (Warnung: DNS-Eintrag
  muss danach aktualisiert werden); Lade-Spinner während Fetch/Generierung
- Ladeindikator im DKIM-Button („Lädt…") während API-Aufruf

---

## [3.17.8] — 2026-05-20 — Nachrichtenablaufverfolgung fix + RFC 822 Quelltext

### Fixed

- **Nachrichtenablaufverfolgung (Message Trace)**: Suche lieferte keine Ergebnisse, weil der
  SMTP-Server niemals `SystemLog`-Einträge mit `category='MAIL_FLOW'` schrieb.
  - SMTP-Inbound (`handlers/message.ts`): schreibt jetzt `DELIVERED` / `JUNK` nach jeder Zustellung
  - SMTP-Inbound (`inbound/handler.ts`): schreibt `REJECTED` (Spamfilter-Ablehnung) und
    `QUARANTINE` (Virenquarantäne) mit Sender, Empfänger, Betreff, Größe, SpamScore, Grund
  - SMTP-Submission (`submission/handler.ts`): schreibt `ACCEPTED` nach Annahme einer Ausgangsmail
  - SMTP-Outbound (`outbound/queue.ts`): schreibt `DELIVERED` nach erfolgreicher Zustellung,
    `DEFERRED` bei vorübergehendem Fehler (Retry ausstehend), `REJECTED` bei endgültigem Fehlschlag
  - Alle Events sind in BCP → Verwaltung → Nachrichtenablaufverfolgung suchbar und filterbar

### Added

- **RFC 822 Quelltext-Ansicht** in MWA-Nachrichtenleser:
  - „Quelltext anzeigen" öffnet jetzt einen modalen Dialog statt eines neuen Browser-Tabs
  - Zeigt vollständiges RFC 822-konformes MIME-Format (Header + Body) mit Monospace-Schrift
  - Download-Button `.eml herunterladen` direkt im Quelltext-Modal
  - Backend `GET /api/v1/mail/messages/:id/raw`: serviert jetzt das originale RFC 822-Dokument
    aus MinIO wenn vorhanden (grosse Nachrichten); Fallback rekonstruiert `multipart/alternative`
    (Text + HTML) gemäß RFC 2045 korrekt mit MIME-Boundary

---

## [3.17.7] — 2026-05-20 — DNS-Reiter: Tabellen-UI, grüne/gelbe Statusampeln

### Changed

- **BCP → SMTP → DNS-Einträge**: Komplettes UI-Redesign — von Karten zu sauberer Tabellenansicht
  - **● grüner Punkt** = Eintrag im DNS gesetzt (Existenzprüfung)
  - **● gelber Punkt** = Eintrag nicht gefunden
  - **● blauer Punkt** = PTR — manuell beim Hosting-Anbieter zu setzen
  - Legende unten: grün / gelb / blau erklärt
  - Status-Banner: „X von 5 Einträgen gesetzt"
  - Jede Zeile: Name-Feld + Wert-Feld, je mit Kopier-Button
  - Gefundener DNS-Wert wird grün (gesetzt) oder gelb (abweichend) angezeigt
- **Backend `dns-check`**: MX-Check nutzt jetzt reinen Existenzcheck (`records.length > 0`);
  Autodiscover-Check prüft ob CNAME überhaupt vorhanden ist (nicht mehr Hostnamen-Vergleich)

---

## [3.17.6] — 2026-05-20 — DNS-Reiter in SMTP-Konfiguration

### Added

- **BCP → SMTP-Konfiguration → DNS-Einträge**: Neuer Reiter zeigt alle für den Mailbetrieb
  erforderlichen DNS-Records an — MX, SPF, DKIM, DMARC, Autodiscover, PTR.
  - Domain-Auswahl via Pill-Tabs (bei mehreren Domains)
  - Jeder Eintrag zeigt DNS-Typ, erwarteten Wert, Kopier-Button
  - **Live-DNS-Prüfung** via `GET /api/v1/admin/domains/:id/dns-check` — grünes Häkchen wenn
    Eintrag gesetzt, gelbes Warnsymbol wenn fehlend; zeigt aktuell gesetzten Wert aus DNS
  - Status-Zusammenfassung: „X von 5 Einträgen korrekt"
  - Schaltfläche „DNS neu prüfen" für manuelle Aktualisierung
  - PTR-Karte mit Hinweis zum Setzen beim Hosting-Anbieter
- **Backend** `GET /api/v1/admin/domains/:id/dns-check`: Prüft MX, SPF (TXT), DKIM (TXT),
  DMARC (TXT), Autodiscover (CNAME) parallel via Node.js `dns/promises`; generiert je einen
  erwarteten und den tatsächlich gefundenen Wert

---

## [3.17.5] — 2026-05-20 — Fix: BullMQ Queue-Name enthält keinen Doppelpunkt

### Fixed

- **Senden schlägt fehl ("Nachricht konnte nicht in die Warteschlange eingereiht werden")**:
  BullMQ v5 verbietet Doppelpunkte (`:`) in Queue-Namen. Die Outbound-Queue in
  `api-gateway/routes/mail.ts` hieß `'smtp:outbound'` — BullMQ warf sofort beim
  Erstellen des Queue-Objekts `Error: Queue name cannot contain :`.
  Fix: Queue-Name auf `'smtp-outbound'` geändert (wie bereits korrekt im `smtp-server`).

---

## [3.17.4] — 2026-05-20 — Fix: BullMQ-Verbindung in api-gateway (NetworkError beim Senden)

### Fixed

- **Senden schlägt fehl (NetworkError)**: Die Outbound-Queue in `api-gateway/routes/mail.ts` nutzte
  `getRedisClient()` (shared, `maxRetriesPerRequest: 3`) statt `createBullMqConnection()` (`null`).
  BullMQ v5 erfordert `maxRetriesPerRequest: null` für interne Blocking-Befehle — mit der falschen
  Verbindung crashte `queue.add()` den api-gateway-Prozess (Node.js 22: `--unhandled-rejections=throw`),
  was im Browser als `NetworkError when attempting to fetch resource` erschien.
  Fix: `createBullMqConnection()` wie in `smtp-server/outbound/queue.ts` korrekt verwendet.
- **Zusätzlich**: `queue.add()` in try/catch — bei echten Queue-Fehlern gibt der Server jetzt
  `500 { error: '...' }` zurück statt die Verbindung zu droppen.

---

## [3.17.3] — 2026-05-20 — Service-TLS-Binding: SMTP/IMAP/POP3 echte Zertifikate, HTTPS-Proxy nur MWA+BCP

### Added

- **Protokoll-TLS-Binding**: Wenn ein Zertifikat den Services `SMTP`, `IMAP` oder `POP3` zugeordnet wird,
  werden `certPem`/`keyPem` automatisch in `ServerSettings.tlsCert/tlsKey` geschrieben und alle drei
  Protokoll-Server laden das Zertifikat sofort via `CHANNEL_SETTINGS_RELOAD` neu — kein Container-Neustart nötig.
  Gilt für: Let's Encrypt (nach Ausstellung), Upload, Self-Signed, PUT-Services-Änderung.
- **`applyProtocolCert()` Helper** in `certificates.ts` — zentraler Binding-Punkt für SMTP/IMAP/POP3-TLS
- **BCP: Service-Farben** in der Zertifikat-Tabelle — blau: MWA/BCP (HTTPS-Proxy), grün: SMTP/IMAP/POP3 (Protokoll-TLS), grau: EWS/CALDAV/AUTODISCOVER
- **BCP: „Protokoll-TLS"-Zeile** in der Detailansicht — zeigt welche Protokoll-Services aktiv gebunden sind
- **BCP: ServiceSelector-Hinweis** — erklärt MWA+BCP = HTTPS-Proxy vs. SMTP/IMAP/POP3 = Protokoll-TLS

### Changed

- **`activate-https` Guard**: HTTPS-Proxy kann nur aktiviert werden wenn das Zertifikat sowohl `MWA` als
  auch `BCP` im `services`-Array hat — gibt klare 400-Fehlermeldung wenn Services fehlen
- **BCP: LockOpen-Button** erscheint nur noch bei Zertifikaten mit MWA+BCP (vorher bei allen ACTIVE/EXPIRING)
- **BCP: Grauer Status-Banner** erklärt jetzt explizit "MWA + BCP zuweisen" statt nur "Schloss klicken"
- **BCP: HTTPS (Port 443) Detailzeile** zeigt drei Zustände: Aktiv / Bereit (MWA+BCP) / MWA+BCP benötigt

---

## [3.17.2] — 2026-05-20 — HTTPS-Proxy: explizit deaktivierbar für externen Reverse Proxy

### Added

- **`HTTPS_PROXY_ENABLED=false`** — neuer Env-Schalter deaktiviert den integrierten TLS-Proxy vollständig.
  Setzen wenn ein externer Reverse Proxy (Traefik, Caddy, nginx, DSM Application Portal …) TLS terminiert.
  Dann kann Port `443:443` aus `docker-compose.yml` entfernt / auskommentiert werden.
- **`GET /api/v1/admin/certificates/tls-proxy-info`** — neuer Admin-Endpoint gibt `{ enabled, port, activeCert }` zurück
- **`docker-compose.synology.yml`**: `HTTPS_PROXY_ENABLED: "false"` voreingestellt (DSM übernimmt TLS)
- **`.env.example`**: Abschnitt für `HTTPS_PROXY_ENABLED` + `HTTPS_PORT` ergänzt

### Changed

- **BCP Zertifikate — dreizustandiger Status-Banner**:
  - 🟡 Gelb: Proxy deaktiviert (`HTTPS_PROXY_ENABLED=false`) — externer Reverse Proxy aktiv
  - 🟢 Grün: Proxy aktiv + Zertifikat gewählt — zeigt Port + Domain
  - ⬜ Grau: Proxy bereit, aber noch kein Zertifikat aktiviert — mit Hinweis auf `HTTPS_PROXY_ENABLED=false`
- **`docker-compose.yml`**: `HTTPS_PROXY_ENABLED`-Variable und Kommentar „OPTION A / OPTION B" für klare Wahl
- **`tls-proxy.ts`**: `isTlsProxyEnabled()` exportiert; startup-Log bei deaktiviertem Proxy

---

## [3.17.0] — 2026-05-20 — Integrierter HTTPS-Reverse-Proxy (TLS-Termination)

### Added

- **Integrierter HTTPS-Reverse-Proxy (Port 443)**  
  – CoreMail kann HTTPS nun direkt ohne externen Reverse Proxy (Traefik, Caddy, nginx) terminieren  
  – Nach Ausstellung eines Let's Encrypt- oder eigenen Zertifikats in BCP → SSL/TLS: Button
    **„Als HTTPS aktivieren"** (Schloss-Symbol) startet den TLS-Proxy sofort per Hot-Reload  
  – Genau ein Zertifikat kann gleichzeitig aktiv sein; Hot-Swap ohne Container-Neustart via
    Redis-Kanal `coremail:tls:reload`  
  – Deaktivierung durch erneuten Klick auf das grüne Schloss-Symbol  
  – `docker-compose.yml`: Port `443:443` hinzugefügt  
- **BCP Zertifikate — HTTPS-Status-Banner**  
  – Grünes Banner zeigt aktives Zertifikat + Domain; graues Banner wenn kein HTTPS aktiv  
  – Detailzeile (ausgeklappt) zeigt „HTTPS (Port 443): Aktiv / Inaktiv" mit Lock-Icon  
- **`packages/api-gateway/src/tls-proxy.ts`** — neues Modul für HTTPS-Server-Lifecycle
  (start, graceful stop 5 s, hot-reload via Redis-Subscription)  
- **Prisma-Schema**: `Certificate.isActiveHttps Boolean @default(false)`

### Changed

- **BCP Zertifikate**: Aktionen-Spalte zeigt `LockOpen`-Icon (grau) für aktivierbare Certs
  und `Lock`-Icon (grün) für das aktive HTTPS-Zertifikat

---

## [3.16.9] — 2026-05-20 — Bugfix: Let's Encrypt Port 80 + besseres UI-Feedback

### Fixed

- **docker-compose.yml**: Port `80:3000` ergänzt — ACME HTTP-01 Challenge jetzt
  von Let's Encrypt erreichbar (vorher hängte der Prozess bis Timeout)
- **BCP Zertifikate**: Sichtbarer Status-Banner bei PENDING (blau) und ERROR (rot)
  direkt über der Tabelle — kein stilles "nichts passiert" mehr
- **BCP Zertifikate**: Fehlermeldung im Expand-Panel jetzt mit Titel + lesbarem
  `pre`-Block statt rohem Mono-Text
- **certificates.ts**: Log-Hinweis bei ACME-Challenge: "Port 80 must be reachable"

---

## [3.16.8] — 2026-05-20 — Bugfix: MessageList-Panel lässt sich nicht verschieben

### Fixed

- **MWA Mail — Resizable Panel (MessageList)**: `w-80 shrink-0` im Haupt-Return überschrieb
  das `style={{ width }}` des Parent-Div → Panel war nicht verschiebbar und zeigte nur den
  leeren Nachrichtenzähler. Korrigiert auf `w-full h-full overflow-hidden`.

---

## [3.16.7] — 2026-05-20 — BCP: Info-Fenster auf v3.16.6 aktualisiert

### Changed

- **BCP Info-Fenster** — VERSION auf 3.16.6 aktualisiert, BUILD_DATE 2026-05-20  
  – 6 neue HIGHLIGHTS-Einträge (3.16.6 → 3.14.0) mit vollständigen Release-Notes  
  – Zeigt damit alle Releases seit 3.13.12 korrekt an

---

## [3.16.6] — 2026-05-20 — MWA: Empfänger-Autocomplete, resizable Panels, Ansicht-Einstellungen

### Added

- **MWA Compose — Empfänger-Autocomplete (An / CC / BCC)**  
  – Beim Tippen in An-, CC- und BCC-Felder werden passende Kontakte aus dem Adressbuch vorgeschlagen (ab 1 Zeichen, 220 ms Debounce)  
  – Dropdown mit Name, E-Mail-Adresse und Firma; Tastaturnavigation (↑/↓/Enter/Tab/Escape)  
  – Mehrere Empfänger durch Komma getrennt; Auswahl ersetzt den aktuellen Fragment und setzt den Cursor hinter das neue Komma  
  – Suche via `GET /api/v1/contacts?q=...` (serverseitig, max. 8 Treffer angezeigt)
- **MWA Mail — Resizable Panels**  
  – Trennlinien zwischen Ordnerstruktur ↔ Nachrichtenliste ↔ Lesebereich sind per Maus in der Breite anpassbar  
  – Breiten werden in `localStorage` unter `coremail:panel-widths` gespeichert und beim nächsten Laden wiederhergestellt  
  – Standardbreiten: Ordnerstruktur 208 px (w-52), Nachrichtenliste 320 px (w-80); Minima/Maxima verhindert Überschneidungen
- **Einstellungen → Ansicht** (neue Sektion)  
  – **Lesebereich**: Rechts (Standard), Unten (Nachrichtenliste + Reader vertikal geteilt) oder Aus (nur Liste, kein Reader)  
  – **Nachrichtendichte**: Kompakt / Normal / Komfortabel — Zeilenhöhe der Nachrichtenliste  
  – **Konversationen gruppieren**: Toggle für konversationsbasierte Bündelung (Vorbereitung)  
  – Alle Einstellungen persistent via Zustand-Store (`coremail-ui-prefs` in localStorage)

---

## [3.16.1] — 2026-05-20 — Aufgaben-Erinnerung: Kalender-Sync + Echtzeit-Popup

### Added

- **MWA Aufgaben — Erinnerung mit Kalender-Integration**  
  – Beim Erstellen oder Bearbeiten einer Aufgabe mit gesetzter Erinnerung (Datum + Uhrzeit) wird automatisch ein Kalender-Termin angelegt (`🔔 Erinnerung: <Betreff>`, 30 Min. Dauer) via `POST /calendar/events` — best-effort, kein Task-Fehler bei Kalender-Fehler  
  – Gilt sowohl für `createMutation` (neue Aufgabe) als auch für `updateMutation` (Edit-Modal per Doppelklick)
- **MWA Aufgaben — Erinnerungs-Popup zur gesetzten Uhrzeit**  
  – Der 60-Sekunden-Intervall-Check `checkDueDates()` prüft jetzt zusätzlich `task.reminder`: sobald der Zeitstempel ≤ `now`, erscheint ein `toast` „🔔 Erinnerung: <Betreff>" (12 Sek. Anzeigedauer)  
  – Eigene `notifiedReminderIds`-Ref verhindert doppelte Popups je Session (unabhängig von der Fälligkeits-Benachrichtigung)
- **MWA Aufgaben — Erinnerungsfeld visuell hervorgehoben**  
  – Bell-Icon im Formular jetzt amber (`text-amber-400`) statt grau, tooltip erklärt die Doppelfunktion (Kalender + Popup)

---

## [3.16.0] — 2026-05-20 — MWA/BCP Feature-Update (Aufgaben, Kontakte, Suche, Schriftarten, Dashboard)

### Added

- **MWA Aufgaben — Bearbeitung per Doppelklick**  
  – Doppelklick auf eine Aufgabe öffnet ein Modal mit vorausgefüllten Feldern (Betreff, Notizen, Priorität, Fälligkeitsdatum, Erinnerung)  
  – Separates `updateMutation` schreibt vollständige Änderungen via `PUT /tasks/:id`
- **MWA Aufgaben → Kalender-Synchronisation**  
  – Neu erstellte Aufgaben mit Fälligkeitsdatum werden automatisch als Kalender-Termin eingetragen (`POST /calendar/events`)  
  – Invalidiert `calendar-events`-Query; Fehler werden best-effort verschluckt (kein Task-Create-Failure)
- **MWA Aufgaben — Fälligkeitspopup**  
  – `useEffect` prüft alle 60 Sekunden, ob Aufgaben heute fällig sind  
  – Zeigt `toast` mit Aufgabentitel; jede Aufgabe wird nur einmal je Session benachrichtigt (via `useRef<Set>`)
- **MWA Kalender — Aufgaben als Ereignisse**  
  – Aufgaben mit `dueDate` erscheinen im FullCalendar als ganztägige Ereignisse (amber `#f59e0b` / grau für erledigt)  
  – Klick auf Aufgaben-Event zeigt Toast statt Löschdialog; Prefix `📋` / `✓` im Titel
- **MWA Kontakte — Outlook-kompatible Felder**  
  – Neue Felder: `email2`, `mobile`, `department`, `jobTitle`, `notes`  
  – Edit-Formular in Sektionen: „Allgemein" (2-Spalten-Grid), „E-Mail & Telefon" (2-Spalten-Grid), „Notizen" (Textarea)  
  – Detailansicht zeigt alle ausgefüllten Felder mit Icon + Label; Emails/Telefon clickable  
  – Kontaktliste zeigt `jobTitle` als zweite Zeile (statt nur E-Mail)  
  – `Contact`-Interface in `api/types.ts` um alle neuen Felder erweitert
- **MWA E-Mail-Suche — Scope-Auswahl + Typeahead**  
  – Neue Suchleiste oberhalb der Filterliste in `MessageList`  
  – Scope-Umschalter: „Ordner" (client-seitige Filterung) / „Alle" (API-Query `/mail/folders/search?q=...`)  
  – Typeahead: ab 2 Zeichen Eingabe werden bis zu 5 Treffer aus dem geladenen Ordner als Vorschläge angezeigt  
  – Löschen-Button (`×`) leert die Suche; `Alle`-Scope deaktiviert den lokalen Filter
- **MWA E-Mail-Verfassen — Schriftart-Auswahl**  
  – Neues Tiptap-Extension `@tiptap/extension-font-family` (v2.27.2, passt zur bestehenden Tiptap-v2-Stack)  
  – Dropdown mit 8 Schriftarten: Standard, Arial, Calibri, Georgia, Times New Roman, Courier New, Verdana, Trebuchet MS  
  – Dropdown-Label und -Einträge werden jeweils in der entsprechenden Schrift dargestellt  
  – Positioniert zwischen Block-Typ und Fett/Kursiv in der Formatierungsleiste
- **BCP Dashboard — Alle Widgets draggable**  
  – Alle 8 bisher fehlenden Widgets (`queue-status`, `mails-chart`, `storage-ranking`, `domains-chart`, `recent-errors`, `recent-audit`, `recent-logins`, `system-strip`) jetzt in `<DraggableCard>` eingebettet  
  – IIFE-Slot-Pattern für Queue+Mails, Speicher+Domains und Fehler+Audit+Angriff (konsistent mit KPI- und Server-Sektion)  
  – `recent-logins` und `system-strip` als einzelne draggable Einheiten

### Fixed

- **DNS-Hardening Startup-Check**: Integrity-Check-Ziele von `example.com` (IANA-IP nicht mehr gültig, jetzt Cloudflare CDN) auf stabile Infra-Records umgestellt: `one.one.one.one → 1.1.1.1` und `dns.google → 8.8.8.8`

---

## [3.15.0] — 2026-05-20 — Security+ (Passwort-Reset, Angriffserkennung, DNS-Hardening)

### Added

- **Passwort-Selbstzurücksetzung (OWASP A07-konform)**  
  – `POST /auth/forgot-password`: Rate-limitiert (3 req/h pro IP + E-Mail), SHA-256-Hashing, keine User-Enumeration (immer `{ok:true}`)  
  – `POST /auth/reset-password`: Atomare Transaktion (Token markiert + Passwort gesetzt + alle Sessions gelöscht)  
  – `GET /auth/reset-password/verify?token=...`: Schnellprüfung für Frontend  
  – Token-TTL: 15 min; SHA-256-Hash im DB-gespeichert (Klartext nie persistiert)  
  – Admin-Toggle in BCP: Einstellungen → Sicherheit → „Passwort-Selbstzurücksetzung" (de-/aktiviert den Flow global)  
  – MWA Login-Seite: „Passwort vergessen?"-Link (nur sichtbar wenn Feature aktiv)  
  – MWA: `ForgotPasswordPage` + `ResetPasswordPage` mit Passwortstärke-Indikator
- **Angriffserkennung Live-Dashboard (BCP)**  
  – Neues Prisma-Modell `AttackEvent` (ip, type, detail, service, timestamp) — persistent in PostgreSQL  
  – Redis-Kanal `admin:attack` → SSE-Broadcast an alle Admin-Verbindungen in Echtzeit  
  – BCP-Dashboard-Widget „Angriffs-Erkennung (Live)": Zähler letzte 1h/24h, Top-IPs, Top-Angriffstypen, letzte 10 Events, „UNTER ANGRIFF"-Banner bei ≥10 Events/h  
  – Admin-API `GET /api/v1/admin/security/attacks` (paginiert/filterbar), `/summary`, `DELETE` (Purge vor Datum)  
  – `ip-limiter` im SMTP publiziert bei jedem Auth-Fehlschlag und Ban ein Attack-Event
- **DNS-Poisoning-Schutz (MITRE T1584.002)**  
  – Neues Modul `security-filter/src/dns-hardened.ts`: Erzwingt Trusted Resolver (8.8.8.8, 1.1.1.1, 9.9.9.9) statt System-/Container-DNS  
  – Cross-Resolver-Validation: Zwei unabhängige Resolver werden verglichen; Divergenz → Warnung im Log  
  – Startup-Integritäts-Check: Bekannte stable A-Records (example.com) werden gegen hartcodierte Erwartungen validiert  
  – DNSBL-Modul nutzt jetzt `resolveHardened()` statt `dns.promises.resolve4()`  
  – Admin-API `GET /api/v1/admin/security/dns-check` → Echtzeit-Integritätsreport via security-filter-Proxy  
  – Konfigurierbar via `TRUSTED_DNS_SERVERS` (kommagetrennte IP-Liste)
- **Per-User-Inaktivitäts-Timeout (MWA)**  
  – Benutzer können unter MWA → Einstellungen → Allgemein → „Automatischer Logout" einen persönlichen Timeout (Minuten) setzen  
  – Eigene Einstellung überschreibt die globale Admin-Vorgabe; 0 = deaktiviert; null = global übernehmen  
  – Backend: `GET/PUT /api/v1/user/preferences` liefert/speichert `inactivityTimeoutMinutes`  
  – Prisma-Modell `UserSettings.inactivityTimeoutMinutes (Int?)` ergänzt  
  – MWA `useInactivityLogout`-Hook lädt beide Einstellungen parallel und respektiert User-Override

### Security

- **Angriffsereignisse** werden persistent in `AttackEvent`-Tabelle gespeichert (Forensik/Audit-Trail)  
- **Redis-Pub/Sub** für Attack-Events entkoppelt SMTP-Lockout von Dashboard ohne Performance-Impact  
- **Passwort-Reset-Tokens**: Einfacher Rate-Limiter verhindert Token-Flooding; SHA-256 schützt DB vor Plaintext-Leak  
- **SSE-Endpoint** prüft Admin-Rolle bevor Attack-Events gebrodcastet werden (`ORGANIZATION_MANAGEMENT` / `SERVER_MANAGEMENT` / …)

---

## [3.14.0] — 2026-05-20 — Security Hardening (Pentest-Auswertung)

### Security

- **SMTP — Brute-Force-Lockout (OWASP A07 / MITRE T1110)**: Neues `ip-limiter`-Modul  
  – Redis-backed: Nach 5 fehlgeschlagenen Auth-Versuchen in 5 min wird die IP für 10 min gesperrt (421)  
  – Konfigurierbar via Env: `SMTP_AUTH_FAIL_THRESHOLD`, `SMTP_AUTH_WINDOW_S`, `SMTP_AUTH_BAN_S`  
  – Erfolgreicher Login löscht den Fehlzähler
- **SMTP — Per-IP-Verbindungslimit (MITRE T1499)**: Max. 10 gleichzeitige Verbindungen + Max. 30 neue Verbindungen/min pro IP (Sliding Window)  
  – Konfigurierbar via `SMTP_MAX_CONNS_PER_IP`, `SMTP_NEW_CONN_PER_MIN`  
  – Private/Loopback-IPs ausgenommen
- **SMTP — VRFY-Command deaktiviert**: Antwortet jetzt mit `502 5.5.1 VRFY not supported` statt dem mehrdeutigen `252` (verhindert User-Enumeration)
- **MinIO-Konsole (Port 9001) nur noch auf localhost gebunden**: In beiden `docker-compose`-Dateien auf `127.0.0.1:9001:9001` geändert — kein WAN-Zugriff mehr möglich
- **Container-Ressourcenlimits** in `docker-compose.yml` ergänzt: `cpus: 2`, `memory: 2g` (via `deploy.resources.limits`) — DoS-Schutz auf Host-Ebene
- **SMTP-Auth-IP-Weitergabe**: Client-IP wird jetzt an `verifyCredentials` durchgereicht, damit Brute-Force-Zähler korrekt pro IP zählen

### Fixed

- **SMTP-Banner** enthüllt jetzt keine interne Hostname-Fehlkonfiguration mehr (`mail.localhost`) — Hostname wird immer aus DB-`publicHostname` gelesen, Env-Fallback als Seed

---

## [3.13.12] — 2026-05-20 — Tasks-Fehler, doppelte Ordner, SharedMailbox-Sprache

### Fixed

- **Aufgaben — „Invalid"-Fehler beim Erstellen**: Frontend sendete `title`, Backend erwartet `subject` (Prisma-Schema-Feldname). `Task`-Interface in `types.ts` auf `subject`/`body` korrigiert; `TasksPage` sendet jetzt korrekte Felder
- **Posteingang — doppelte Ordner „Aufgaben"/„Task"**: `Notes` und `Tasks` wurden fälschlicherweise als reguläre Mail-Ordner provisioniert. Beide aus `DEFAULT_FOLDERS` in `provision-mailbox.ts` entfernt (sind eigenständige Datenmodelle). `FolderTree` filtert sie für Bestandsbenutzer heraus
- **SharedMailbox — falsche Sprache**: Ordner-Labels waren hardcodiert englisch/deutsch gemischt; jetzt via `useT()` in der vom User eingestellten Sprache (DE/EN/ES/IT)
- **SharedMailbox — Datumformat**: `fmtDate()` nutzt jetzt die Benutzersprache statt hartem `'de-DE'`
- **SharedMailbox — Ordner-Reihenfolge**: Folder-Sidebar folgt jetzt der gleichen Reihenfolge wie die normale Mailbox (`INBOX → Entwürfe → Gesendet → Papierkorb → Junk → Archiv`, dann benutzerdefinierte Ordner) statt nur `sortOrder + displayName`

### Changed

- **Aufgaben-Seite ausgebaut**: Erweitertes Formular mit Priorität, Fälligkeitsdatum, Erinnerung, Notiz-Textfeld; aufklappbare Body-Anzeige pro Aufgabe; Überfällig-Markierung in Rot; Löschen nur mit Bestätigung
- **SharedMailbox-Sidebar-Stil** angepasst: Aktiver Akzentbalken links, Hover-Effekte und Icon-Größen identisch zur normalen FolderTree-Sidebar

---

## [3.13.11] — 2026-05-20 — Automatischer Logout bei Inaktivität

### Added

- **Neues Sicherheitsfeld „Automatischer Logout bei Inaktivität"** in den Global Settings (Sicherheitsrichtlinien-Sektion)
  - Wert in Minuten: `0` = deaktiviert, `1`–`1440` Minuten konfigurierbar
  - Standard: 30 Minuten
  - Schnell-Buttons: Deaktiviert / 5 / 10 / 15 / 30 / 60 / 120 min
  - Warnung bei < 5 Minuten (könnte Benutzer stören)
- **`GET /api/v1/admin/settings/public`** — neuer öffentlicher Endpoint (kein Auth), liefert `orgName`, `logoUrl`, `language`, `inactivityTimeoutMinutes`, `maintenanceMode`, `maintenanceMessage` — für MWA/BCP vor dem Login abrufbar
- **`useInactivityLogout`-Hook** — implementiert Browser-seitige Inaktivitätserkennung in BCP und MWA:
  - Hört auf `mousemove`, `mousedown`, `keydown`, `touchstart`, `scroll`, `visibilitychange`
  - Timer wird bei jeder Aktivität zurückgesetzt
  - 60-Sekunden-Vorwarnung via Toast bevor der Logout ausgelöst wird
  - Automatische Weiterleitung zur Login-Seite nach Ablauf

### Changed

- Session-Timeout-Feld in den Einstellungen in „Session-Timeout (Token)" umbenannt und Hinweistext präzisiert — verdeutlicht den Unterschied zu Inaktivitäts-Timeout

---

## [3.13.10] — 2026-05-20 — Bugfix: Vorlage anwenden schlug fehl (retentionDays-Validierung)

### Fixed

- **Kritischer Bugfix** — „Aus Vorlage"-Button in der Aufbewahrungsrichtlinien-Seite schlug mit `retentionDays must be at least 1` fehl
- Ursache: Im tag-basierten Exchange-2019-System (DPT/RPT/Personal-Tags) hält die **Policy** selbst keine Frist — das machen die Tags. Das Frontend sendet deshalb korrekt `retentionDays: 0` beim Anlegen der Policy
- Die Backend-Validierung in `POST /admin/compliance/retention` und `PUT /admin/compliance/retention/:id` war zu streng (`< 1` statt `< 0`) und blockierte das
- Fix: `0` ist jetzt erlaubt (Bedeutung: Frist wird durch die angehängten Tags gesteuert); negative Werte werden weiterhin abgelehnt
- Alle 8 Vorlage-Szenarien (Papierkorb, Junk, Inbox, Gesendet, Entwürfe, Compliance 7 Jahre, Standard 3 Jahre, 5 Jahre wiederherstellbar) können jetzt per Klick angelegt werden

---

## [3.13.9] — 2026-05-20 — Aufbewahrungsrichtlinien aus Vorlagen + MFA-Buttons entfernt

### Removed — Hauptansicht entrümpelt

- **„MFA jetzt"-Button** aus dem Header der `RetentionPage` entfernt — der Worker läuft automatisch im 24h-Work-Cycle, kein Admin muss manuell triggern
- **„MFA-Historie"-Button** raus + `RunsModal`-Komponente komplett gelöscht — interne Worker-Telemetrie gehört nicht in die Compliance-Konfiguration
- `runNow`-Mutation und `ManagedFolderRun`-Interface aus dem Component-State entfernt

### Added — 1-Klick-Vorlagen

- **„Aus Vorlage"-Button** neben „Neue Richtlinie" (nur im Policies-Tab)
- **`TemplatePickerModal`** mit 8 fertigen Szenarien:

| Szenario | Tag-Typ · Folder · Aktion · Frist |
|---|---|
| Papierkorb nach 30 Tagen leeren | RPT · DELETED_ITEMS · DELETE_AND_ALLOW_RECOVERY · 30 d |
| Junk nach 14 Tagen endgültig löschen | RPT · JUNK_EMAIL · PERMANENTLY_DELETE · 14 d |
| Posteingang nach 1 Jahr archivieren | RPT · INBOX · MOVE_TO_ARCHIVE · 365 d |
| Gesendet nach 2 Jahren archivieren | RPT · SENT_ITEMS · MOVE_TO_ARCHIVE · 730 d |
| Entwürfe nach 90 Tagen löschen | RPT · DRAFTS · DELETE_AND_ALLOW_RECOVERY · 90 d |
| Compliance 7 Jahre (Markierung) | DPT · ALL_OTHER · MARK_AS_PAST_RETENTION_LIMIT · 2555 d |
| Standard 3 Jahre → Archiv | DPT · ALL_OTHER · MOVE_TO_ARCHIVE · 1095 d |
| 5 Jahre wiederherstellbar löschen | DPT · ALL_OTHER · DELETE_AND_ALLOW_RECOVERY · 1825 d |

- Klick auf eine Vorlage löst **atomar** aus (Frontend-Orchestrierung):
  1. `POST /admin/compliance/retention/tags` — Tag anlegen
  2. `POST /admin/compliance/retention` — Policy anlegen (Legacy-Felder leer)
  3. `POST /admin/compliance/retention/:policyId/tags/:tagId` — Tag an Policy hängen
  4. `POST /admin/compliance/retention/:policyId/assignments` — GLOBAL-Zuweisung
- Damit ist eine produktive Regel in **einem Klick** einsatzbereit
- Eigene Regeln „from scratch" weiterhin via „Neue Richtlinie"-Button verfügbar

### Changed — Page-Header

- Subtitle umformuliert: „Definiere, wann E-Mails automatisch archiviert oder gelöscht werden — per Vorlage oder eigener Regel" (vorher: technische Beschreibung mit „Managed Folder Assistant · Recoverable Items")

---

## [3.13.8] — 2026-05-19 — Shared Mailboxes mit voller Ordnerstruktur + User-Folder-CRUD

### Added — Provisioning

- **`ensureSharedMailboxProvisioned(sharedMailboxId)`** in `packages/api-gateway/src/lib/provision-mailbox.ts`
  - Idempotent — analog zur User-Variante
  - Erstellt `Mailbox`-Record (via `sharedBoxId`) und die 8 Default-Folders: `INBOX`, `Drafts`, `Sent`, `Trash`, `Junk`, `Archive`, `Notes`, `Tasks`
  - Backfill: fehlende Standard-Ordner werden bei bestehenden Mailboxen ergänzt
- **Auto-Call** in `POST /admin/shared-mailboxes` — neue Postfächer haben sofort die volle Ordnerstruktur
- **Repair-Endpoint** `POST /admin/shared-mailboxes/:id/provision` — Backfill auf Bestand

### Added — Folder-CRUD für Shared Mailboxes (nur FULL_ACCESS)

In `packages/api-gateway/src/routes/user.ts`:

- `POST   /user/shared-mailboxes/:id/folders` — Ordner anlegen (mit optionalem `parentId` für Unterordner)
- `PATCH  /user/shared-mailboxes/:id/folders/:folderId` — Umbenennen, verschieben (`parentId`), Farbe, Favorit, Sortierung
- `DELETE /user/shared-mailboxes/:id/folders/:folderId` — Löschen (mit Children-Check)
- `POST   /user/shared-mailboxes/:id/folders/:folderId/empty` — alle Nachrichten im Ordner löschen
- Cycle-Check beim Reparenten — Ordner kann nicht in seinen eigenen Subtree verschoben werden
- **Standard-Ordner geschützt**: `INBOX`, `Drafts`, `Sent`, `Trash`, `Junk`, `Outbox` lassen sich nicht umbenennen, verschieben oder löschen (403)

### Added — Web-Client UI (`SharedMailboxPage.tsx`)

- **„+ Neuer Ordner"-Inline-Eingabe** oben in der Folder-Sidebar (nur bei FULL_ACCESS), gestrichelter Akzent-Border
- **Hover-Aktionen** pro User-Folder rechts: Bleistift (Umbenennen) + Mülleimer (Löschen)
- **Inline-Rename** mit Enter/Esc, OK-Button, Validierungs-State
- Standard-Ordner zeigen keine Action-Icons (Frontend + Backend stimmen überein)
- Lösch-Confirm-Dialog mit Datenverlust-Warnung
- `READ_ONLY`-User sehen weder „Neuer Ordner" noch Action-Icons

---

## [3.13.7] — 2026-05-19 — Transportregeln aus Vorlagen (Exchange-2019-Templates)

### Added

- **„Aus Vorlage"-Button** auf `TransportRulesPage` (neben „Neue Regel")
- **`TemplatePickerModal`** mit 9 vorgefertigten Regel-Vorlagen, in 4 Kategorien filterbar
- Pro Vorlage: Icon + Beschreibung + Conditions/Actions vorbefüllt
- Klick auf Vorlage → `RuleModal` öffnet vorbefüllt; Admin passt Platzhalter (`@DEINE-DOMAIN.com`) an und speichert

### Mitgelieferte Vorlagen

| Kategorie | Vorlage | Conditions → Actions |
|---|---|---|
| **Kennzeichnung** | [EXTERN]-Markierung im Betreff | `from notContains @firma.com` → Subject-Präfix |
| **Compliance** | Disclaimer für ausgehende Mails | `to notContains @firma.com` → addDisclaimer |
| **Compliance** | BCC an Compliance-Postfach | `to contains @firma.com` → addRecipient compliance@ |
| **Compliance** | Kreditkarten-Detection (PCI-DSS) | `body regex \b\d{13,16}\b` → quarantine |
| **Sicherheit** | Spam-Score > 5 quarantänieren | `spamScore > 5` → quarantine |
| **Sicherheit** | Malware-Endungen | `subject regex \.(exe|bat|scr|cmd|vbs|js|jar|hta)\b` → quarantine |
| **Sicherheit** | CEO-Phishing-Schutz | `from regex (ceo|geschäftsführer|chef).*@(?!firma)` → Subject-Präfix „⚠ MÖGLICHES PHISHING" |
| **Governance** | Größenlimit 25 MB | `size > 26214400` → reject |
| **Governance** | DLP-Marker für externe Anhänge | `hasAttachment is true` + `to notContains @firma.com` → addHeader X-Coremail-External-Attachment |

### Changed — `RuleModal`

- Neuer optionaler `initial`-Prop: nimmt eine Template-Rule-Struktur und prefilled `name`, `description`, `priority`, `conditions`, `actions`
- Bei `rule`-Prop (Edit-Modus) wird `initial` ignoriert
- Eigene Regeln „from scratch" weiterhin via „Neue Regel"-Button (ohne Template)

---


> Ältere Releases (v3.13.6 und früher zurück bis v0.1) sind über `git log CHANGELOG.md`
> oder die [GitHub-Releases](https://github.com/MAGPEEK/CoreMail/releases) erreichbar.
