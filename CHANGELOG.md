# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

> **Hinweis:** Aus Übersichtsgründen sind hier nur die drei jüngsten Releases gelistet.
> Die komplette Historie aller älteren Versionen ist über die git history einsehbar:
> `git log -p --follow CHANGELOG.md` oder über das GitHub-Repository.

---

## [Unreleased]

---

## [3.13.2] — 2026-05-19 — Dashboard-Drag&Drop direkt auf den Karten + Bugfixes

### Fixed

- **🐛 `moveWidget` Index-Shift-Bug** (`packages/admin-panel/src/store/dashboard.ts`)
  - Wenn `from < to`, schiebt `splice(from, 1)` alle nachfolgenden Indices um 1 runter — beim anschließenden `splice(to, 0, …)` wurde das Item dann eine Position zu weit hinten eingefügt
  - Fix: `insertAt = from < to ? to - 1 : to` korrigiert die Verschiebung. „Drop-vor-Index"-Semantik ist jetzt konsistent
- **🐛 Firefox-Drag brach sofort ab** — ohne `e.dataTransfer.setData(...)` in `dragStart` ignoriert Firefox den Drag
  - Fix: `setData('text/plain', widgetId)` + `effectAllowed = 'move'` gesetzt
- **🐛 Checkbox triggerte Drag** im Popover — Klick wurde als dragStart interpretiert
  - Fix: `onClick={(e) => e.stopPropagation()}` + `draggable={false}` an der Checkbox

### Added — Drag-and-Drop direkt auf den Dashboard-Karten

- **Karten in der Übersicht sind jetzt selber draggable** (`packages/admin-panel/src/pages/DashboardPage.tsx`)
  - Neue Hüllen-Komponente `DraggableCard` umschließt jede KPI- und Server-Widget-Karte
  - Drag-Cursor (`cursor-move`) + Tooltip „Per Drag verschieben"
  - Visuelles Feedback: Quelle wird halb-transparent + leicht skaliert (`opacity-40 scale-[0.98]`), Drop-Target bekommt Akzent-Ring (`ring-2 ring-accent ring-offset-2`)
  - Ring-Highlight erscheint nur bei Same-Group-Drops (KPI ↔ KPI, Server ↔ Server) — Cross-Group-Drag ist technisch erlaubt, modifiziert aber nur die relative Reihenfolge in der eigenen Section
- **End-of-list Drop-Zone im Popover** — ermöglicht „ans Ende ziehen" durch eine 12 px hohe Drop-Zone unter dem letzten Listenelement

### Changed

- **`moveWidget(from, to)`**: Drop-Semantik dokumentiert. `to === length` ist erlaubt = „ans Ende anhängen". Adjacent-No-Op (`from + 1 === to`) wird sauber abgefangen
- **`onDragOver`-Handler**: dropEffect explizit auf `'move'` gesetzt für korrekten Cursor

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

---

> Ältere Releases (v3.12.0 und früher zurück bis v0.1) sind über `git log CHANGELOG.md`
> oder die [GitHub-Releases](https://github.com/MAGPEEK/CoreMail/releases) erreichbar.
