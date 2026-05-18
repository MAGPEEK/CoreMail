# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

> **Hinweis:** Aus Übersichtsgründen sind hier nur die drei jüngsten Releases gelistet.
> Die komplette Historie aller älteren Versionen ist über die git history einsehbar:
> `git log -p --follow CHANGELOG.md` oder über das GitHub-Repository.

---

## [Unreleased]

---

## [3.13.1] — 2026-05-18 — Info-Page schlanker (Top-3 + ohne Notes-Subtext)

### Changed

- **Info-Page**: Die „Letzte Versionen"-Karte zeigt jetzt nur noch die drei jüngsten Releases (statt der kompletten Historie). Pro Eintrag bleiben nur Version-Badge, Datum und Titel sichtbar — der ausführliche Notes-Text ist entfernt.
- **CHANGELOG.md**: ebenfalls auf die drei jüngsten Einträge gekürzt; ältere Releases bleiben über die git history erreichbar.
- **Info-Page „Changelog"-Resource-Karte**: Sub-Text „Keep a Changelog Format" entfernt.

### Fixed

- **`getAppVersion()`** liest jetzt `COREMAIL_VERSION`-Env **bevor** das root `package.json` als Fallback — erlaubt Runtime-Override des Version-Labels ohne Image-Rebuild.

---

## [3.13.0] — 2026-05-18 — SMTP-Audit-Fixes + Drag-Reorder + IANA-Zonen + OWA→MWA

### Fixed — 5 kritische Audit-Befunde

- **🐛 ESMTP-Erweiterungen wurden komplett ignoriert** (`packages/smtp-server/src/core/session.ts`, `server.ts`)
  - Frontend persistierte 11 Flags (`extStarttls`, `extAuthPlain`, `extAuthLogin`, `extAuthCramMd5`, `extPipelining`, `extSize`, `ext8bitmime`, `extEnhancedStatus`, `extSmtputf8`, `extDsn`, `extChunking`), Server hardcodete sie
  - **Fix**: `refreshSmtpSettings()` lädt alle Flags aus `SmtpSettings` und macht sie als Getter über `_esmtp` zugänglich; `handleEhlo()` baut die EHLO-Antwort dynamisch (`SIZE`, `PIPELINING`, `8BITMIME`, `SMTPUTF8`, `ENHANCEDSTATUSCODES`, `DSN`, `CHUNKING`, `STARTTLS`, `AUTH PLAIN/LOGIN/CRAM-MD5`)
- **🐛 `maxMessageSizeMb` wurde ignoriert** (`server.ts:146` hardcoded 50MB)
  - **Fix**: jetzt aus `SmtpSettings.maxMessageSizeMb × 1024²` via Getter — `SIZE`-EHLO-Wert und 552-Reject-Check sind live
- **🐛 `localDeliveryEnabled` wurde nie durchgesetzt** (`inbound/handler.ts`)
  - `onRcptTo()` rief nur `verifyRecipient()` auf, ignorierte das Setting
  - **Fix**: bei `localDeliveryEnabled === false` antwortet RCPT-TO mit `5.7.1 Local delivery is disabled by administrator`
- **🐛 Outbound-Smarthost-Cache wurde nach Save nicht invalidiert** (`outbound/relay.ts` 60s TTL)
  - **Fix**: `api-gateway/routes/admin/smtp-config.ts` publisht `CHANNEL_SETTINGS_RELOAD` nach jedem PUT; smtp-server-Subscriber ruft `invalidateOutboundConfigCache()`. Neue Provider-Credentials wirken sofort
- **🐛 Greylisting Wait/TTL waren hardcoded** (`security-filter/src/greylisting/index.ts`)
  - 300s Wait + 4h TTL statt aus `SmtpSettings.greylistWaitSec`/`greylistTtlHours`
  - **Fix**: 60s-Settings-Cache + Whitelist-Bypass (IP, Sender-E-Mail, Sender-Domain, /24-CIDR-Approx) aus `SmtpSettings.greylistWhitelist`

### Added

- **Dashboard-Drag-Reorder** (`packages/admin-panel/src/store/dashboard.ts` + `pages/DashboardPage.tsx`)
  - Neuer Drag-Handle (GripVertical) im „Anzeige"-Popover
  - Native HTML5 Drag-and-Drop — kein @dnd-kit-Dependency nötig
  - Reihenfolge im localStorage persistiert (`order: WidgetId[]`) mit Auto-Migration für neue Widgets
  - `sortByOrder()`-Helper rendert KPI-Strip und Server-Sektion in User-Reihenfolge
- **Alle ~400 IANA-Zeitzonen** in Global-Settings → Zeitzone (`SettingsPage.tsx`)
  - `Intl.supportedValuesOf('timeZone')` als Quelle, UTC oben, sortiert mit Live-UTC-Offset-Anzeige
  - Fallback-Liste für ältere Runtimes (21 wichtigste Zonen)

### Changed

- **Servers-Page**: Label `OWA-URL (Outlook Web Access)` → `MWA-URL (Mail Web Access)`
- **SMTP-Settings-Refresh** (`smtp-server/src/server.ts`): `refreshBanner()` ersetzt durch `refreshSmtpSettings()`, lädt jetzt Banner + 11 ESMTP-Flags + maxSize + maxRcpt in einem Read

### Notes — offene Audit-Befunde aus diesem Release

- **Lokale Zustellung** — Quota-Check ist post-save (Overflow theoretisch möglich)
- **Ausgehende Zustellung** — Outbound-Filter ist Platzhalter (rspamd/ClamAV-Wiring offen)
- **Greylisting/Relaying** — `maxConnectionsPerIp`/`maxRecipients`/`connectionTimeoutSec` weiterhin nicht durchgesetzt (Listener-Refactor nötig)
- **SSL/TLS-Zertifikate** — Cert-Upload publisht keinen Reload, IMAP/POP3 reagiert nicht auf Cert-Rotation, keine Cert↔Key-Pair-Validierung beim Upload

---

## [3.12.0] — 2026-05-18 — Journaling Exchange-2019-konform (BCC · .eml · Retry · Fallback · Hold)

### Added — Exchange-2019-Spec-Konformität

- **Transport-Agent-Logik**: `journalMessage()` ist in den SMTP-Pfad eingehängt — Aufruf erfolgt mit den **Envelope-Empfängern** (RCPT TO), nicht den Header-Empfängern. Damit sind expandierte Verteilerlisten und BCC-Adressen automatisch im Report enthalten
- **BCC-Auflösung im Journal-Report** — Engine vergleicht Envelope-To gegen To/Cc-Header der Original-Mail; alle Envelope-To-Adressen, die NICHT in den Headern stehen, werden explizit als BCC ausgewiesen (im Summary-Teil und mit `(BCC)`-Suffix im `Original-Envelope-To`-Header)
- **Original-Mail als `.eml`-Attachment**: Teil 3 des Reports trägt jetzt `Content-Type: message/rfc822` plus `Content-Disposition: attachment; filename="original.eml"` (vorher inline)
- **Submission-Queue-Hold** (Non-Repudiation):
  - Neue Setting `holdOnFailure: boolean` (Default OFF, in Settings-UI aktivierbar)
  - Wenn aktiv UND primär + Fallback scheitern → Engine wirft `JournalingHoldError` → SMTP-Pipeline blockiert die Mail
  - Bei OFF (Default für KMUs) → Failure persistiert, Mailfluss läuft weiter
- **Alternatives Journal-Postfach** (`alternativeJournalAddress` in den globalen Settings):
  - Wird automatisch versucht wenn primäres Sink-Postfach fehlschlägt
  - Im Retry-Loop kommt es als zweite Adresse zum Einsatz (jeder Failure wird einmal über das Fallback versucht, wenn die primäre Adresse nicht antwortet)

### Added — Engine-Resilienz

- **Failure-Persistierung**: nicht zustellbare Reports landen in der Tabelle `journaling_failures` mit Status `PENDING`/`RETRYING`/`ALTERNATIVE`/`RESOLVED`/`ABANDONED`
- **Original-Mail in MinIO**: pro Failure wird die rohe Mail unter `journal-failures/<ruleId>/<id>.eml` gespeichert — der Retry-Worker baut den Report aus der Original-Mail neu (statt nur den Report-Buffer zu speichern, der schon eine Empfänger-Adresse enthält)
- **Exponentielles Backoff** im Retry-Loop: `initialRetryDelaySec × 2^(n-1)` (default 30s, 60s, 120s, …) bis `maxRetries` erreicht → `ABANDONED`
- **Retry-Worker** läuft alle 60 s im SMTP-Server-Prozess (`startJournalingRetryLoop()`), startet auch sofort nach Bootstrap (5 s Delay um Backlog aufzuholen)
- **Settings-Cache** mit 60 s TTL plus Redis-`CHANNEL_SETTINGS_RELOAD`-Invalidierung — nach Settings-Update greifen neue Werte ohne Restart

### Added — Schema (Prisma)

- **Neu**:
  - `model JournalingSettings` (Singleton id="singleton") — `alternativeJournalAddress`, `holdOnFailure`, `maxRetries`, `initialRetryDelaySec`
  - `model JournalingFailure` mit Relation zu `JournalingRule` — speichert Envelope-From/To, Direction, MinIO-Pfad, Target-Address, lastTriedAddress, Status, Attempts, NextAttemptAt, ErrorMessage
  - `enum JournalingFailureStatus { PENDING, RETRYING, ALTERNATIVE, RESOLVED, ABANDONED }`
- **Erweitert**:
  - `JournalingRule.failures` Relation

### Added — Backend-Routen

- `GET/PUT /api/v1/admin/compliance/journaling/settings`
- `GET /api/v1/admin/compliance/journaling/failures?status=…`
- `POST /api/v1/admin/compliance/journaling/failures/:id/retry` — sofortigen Retry triggern
- `DELETE /api/v1/admin/compliance/journaling/failures/:id` — Failure aus Log entfernen

### Changed — Admin-UI

- **`JournalingPage.tsx`** komplett überarbeitet, 3 Tabs:
  - **Regeln** — bestehende Tabelle, erweitert um Empfänger-Count
  - **Einstellungen** — Alternativ-Postfach, Hold-on-Failure (mit Amber-Warning bei Aktivierung), Max-Retries + initiales Backoff-Intervall
  - **Fehler** — Failure-Tabelle mit Status-Filter (Alle/Wartend/Wiederholung/Fallback/Zugestellt/Abgebrochen), Manual-Retry- und Dismiss-Aktionen, Live-Refresh alle 15 s
- **Tab-Badge** auf „Fehler" zeigt Anzahl offener Failures (PENDING + RETRYING + ABANDONED) in Rot
- **Rule-Modal** erweitert — `SPECIFIC_USERS` und `DOMAIN` zeigen jetzt das passende komma-getrennte Eingabefeld

### Notes

- Defaults sind so gewählt, dass kein bestehender Mailfluss bricht: `holdOnFailure=false`, `maxRetries=3`, `initialRetryDelaySec=30`. Strict-Compliance-Setups können `holdOnFailure=true` setzen (Banner warnt vor möglichem Mailflow-Stop)
- Engine wirft Fehler nur bei aktivem Hold weiter; sonst ist Journaling sauber „best effort" (Failure-Log gibt Auditspur)

---

> Ältere Releases (v3.11.1 und früher zurück bis v0.1) sind über `git log CHANGELOG.md`
> oder die [GitHub-Releases](https://github.com/MAGPEEK/CoreMail/releases) erreichbar.
