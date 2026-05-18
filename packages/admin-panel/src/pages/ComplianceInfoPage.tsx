import { ExternalLink, Tag, Clock, GitBranch, BookOpen, Shield, Github, HardDriveDownload } from 'lucide-react';

const VERSION        = '3.13.1';
const BUILD_DATE     = '2026-05-18';
const GITHUB_URL     = 'https://github.com/MAGPEEK/CoreMail';
const CHANGELOG_URL  = `${GITHUB_URL}/blob/main/CHANGELOG.md`;
const DOCKERHUB_URL  = 'https://hub.docker.com/r/magpeek/coremail-app';

const HIGHLIGHTS = [
  { version: '3.13.1', date: '2026-05-18', title: 'Info-Page schlanker — nur Top-3-Changelogs + Notes-Subtext entfernt',
    notes: 'Die „Letzte Versionen"-Karte zeigt jetzt nur noch die drei jüngsten Releases (statt der kompletten Historie). Pro Eintrag werden nur Version-Badge, Datum und Titel angezeigt — der ausführliche Notes-Text ist gestrichen. Die volle Historie bleibt im GitHub-CHANGELOG. Außerdem: kleiner Sub-Text „Keep a Changelog Format" unter dem Changelog-Link entfernt.' },
  { version: '3.13.0', date: '2026-05-18', title: 'SMTP/Greylisting/Cert-Audit: 5 kritische Bugs gefixt + Drag-Reorder + alle IANA-Zonen + OWA→MWA',
    notes: '5 parallele Code-Audits + 6 echte Bugfixes + 3 UX-Features. SMTP-Audit: alle 11 ESMTP-Flags (extStarttls, extAuth*, extPipelining, extSize, ext8bitmime, extEnhancedStatus, extSmtputf8, extDsn, extChunking) waren in der DB persistiert aber im SMTP-Server hardcodiert — jetzt werden sie via `refreshSmtpSettings()` geladen und in `handleEhlo()` korrekt angeboten oder unterdrückt. Banner, maxSize und maxRcpt sind ebenfalls Live-getter — Settings-Save invalidiert den Cache via Redis-CHANNEL_SETTINGS_RELOAD. Lokale-Zustellung-Audit: `maxMessageSizeMb` wurde ignoriert (hardcoded 50MB), `localDeliveryEnabled` wurde nicht in RCPT-TO-Verifikation durchgesetzt — beides gefixt. Ausgehende-Zustellung-Audit: Outbound-Smarthost-Cache (60s TTL) wurde nach Settings-Save nicht invalidiert — jetzt via Redis-Pub/Sub sofort wirksam. Greylisting-Audit: `greylistWaitSec` und `greylistTtlHours` waren hardcoded (300s/4h) statt aus `SmtpSettings` zu lesen — jetzt mit 60s-Settings-Cache; zusätzlich wird `greylistWhitelist` (IP/Sender/Domain) für Bypass berücksichtigt. UI-Features: OWA-URL-Label in „Server-Einstellungen" zu MWA (Mail Web Access) umbenannt — der Begriff OWA war in v3.5.5 schon weg, blieb aber im Servers-Page-Label. Globale Zeitzone-Auswahl jetzt mit allen ~400 IANA-Zonen aus `Intl.supportedValuesOf("timeZone")`, sortiert mit UTC oben + Live-UTC-Offset-Anzeige pro Zone. Dashboard-Drag-Reorder: neuer Drag-Handle (GripVertical) in „Anzeige"-Popover — User kann Widgets per Drag verschieben, Reihenfolge persistiert im localStorage mit Migrations-Logik. KPI-Strip und Server-Sektion werden jetzt im User-`order` gerendert (sortByOrder-Helper).' },
  { version: '3.12.0', date: '2026-05-18', title: 'Journaling Exchange-2019-konform: BCC-Auflösung, .eml-Attachment, Retry, Fallback-Postfach, Submission-Queue-Hold',
    notes: 'Journal-Pipeline komplett überarbeitet nach Exchange-2019-Spec. Transport-Agent-Logik: journalMessage() hängt sich in den SMTP-Pfad ein (post-Inbound, pre-Outbound) und nutzt die Envelope-Empfänger (RCPT TO) — damit sind expandierte Verteiler und BCC-Adressen automatisch enthalten. Journal-Report (RFC 3462) komplett neu: Teil 1 mit Human-Readable Summary inkl. expliziter BCC-Erkennung (Envelope-Empfänger, die NICHT in To/Cc-Headern stehen, werden als BCC ausgewiesen), Teil 2 als message/delivery-status mit Original-Envelope-From/-To + Direction/Timestamp/Reporting-MTA, Teil 3 die unveränderte Original-Mail mit Content-Disposition: attachment; filename="original.eml". Queue-Sicherung (Non-Repudiation): bei Sink-Fehler werden Reports in JournalingFailure-Tabelle persistiert + Original-Mail in MinIO als .eml gespeichert, Retry-Loop läuft alle 60s mit exponentiellem Backoff (Settings.initialRetryDelaySec × 2^n × Settings.maxRetries). Alternative Journaling Mailbox: globales JournalingSettings.alternativeJournalAddress als Fallback bei primärem Fehlschlag, automatisch versucht. Submission-Queue-Hold (Settings.holdOnFailure): wenn aktiviert und alle Wege scheitern, wirft die Engine JournalingHoldError und stoppt den eingehenden Mailfluss — Non-Repudiation-Garantie (Default OFF). Neue Modelle: JournalingSettings (Singleton), JournalingFailure (mit Status PENDING/RETRYING/ALTERNATIVE/RESOLVED/ABANDONED). Settings-Cache mit 60s TTL über Redis-CHANNEL_SETTINGS_RELOAD invalidiert. Neue Admin-Routen: GET/PUT /admin/compliance/journaling/settings, GET /admin/compliance/journaling/failures?status=…, POST /failures/:id/retry, DELETE /failures/:id. UI komplett überarbeitet: 3 Tabs (Regeln/Einstellungen/Fehler) mit Live-Refresh-Counter im Fehler-Tab (Badge mit offenen Fehlern), Einstellungs-Panel mit ausführlicher Erklärung zu Hold-on-Failure-Konsequenzen, Failures-Tabelle mit Status-Filter + Manual-Retry-Button + Dismiss-Button.' },
  { version: '3.11.1', date: '2026-05-18', title: 'UX-Fixes: Shared-Mailbox-Form, Heap-Anzeige, Widget-Labels',
    notes: '3 kleine, aber sichtbare Korrekturen. Shared Mailbox „Invalid Input" beim Anlegen behoben: alte UI hatte E-Mail-Feld und Domain-Dropdown als zwei getrennte Felder — der User tippte oft nur den Local-Part und das Backend lehnte mit z.string().email() ab. Neu: ein zusammengesetztes Feld mit „localPart @ domain"-Dropdown, Live-Vorschau der vollständigen E-Mail in Monospace, Frontend-Validierung des Local-Parts, automatische Vorauswahl der ersten Domain. Node-Heap-Balken war fälschlich rot: alte Anzeige nutzte heapUsed/heapTotal (V8s aktuell allokierte Heap-Größe — von Natur aus ~90% voll bevor V8 expandiert), korrekt ist heapUsed/heap_size_limit (--max-old-space-size, default ~4 GB). Jetzt zeigt der Balken realistisch ~3% grün statt 92% rot, der allokierte Wert wandert in die graue Detail-Zeile. „KPI:"-Präfix aus den vier oberen Widget-Labels im Anzeige-Popover entfernt.' },
  { version: '3.11.0', date: '2026-05-18', title: 'Aufbewahrungsrichtlinien Exchange-2019-konform: Tags (DPT/RPT/Personal) + MFA + Recoverable Items',
    notes: 'Komplett-Umbau der Aufbewahrungsrichtlinien nach Exchange-2019-Architektur. NEU: Retention Tags als eigene Entität — drei Typen (DPT = Default Policy Tag, gilt fürs ganze Postfach · RPT = Retention Policy Tag, bindet an Standardordner Inbox/Sent/Deleted/Junk/Drafts/Outbox/Archive · PERSONAL = User-zuweisbar). Tags werden separat verwaltet und in Policies hineingebündelt (n:m). Vier konfigurierbare Aktionen pro Tag: MOVE_TO_ARCHIVE / DELETE_AND_ALLOW_RECOVERY (Soft Delete) / PERMANENTLY_DELETE / MARK_AS_PAST_RETENTION_LIMIT. NEU: Managed Folder Assistant (MFA) als Worker — Tag-Hierarchie pro Item (Personal-on-Item → Personal-on-Folder → RPT → DPT), Work-Cycle-Throttle (Standard 24h, Env RETENTION_WORK_CYCLE_SEC), Run-Historie in Tabelle managed_folder_runs. NEU: Recoverable Items Non-IPM Subtree — beim ersten MFA-Run werden pro Mailbox die versteckten Ordner „Recoverable Items", „Recoverable Items/Deletions", „Recoverable Items/Purges" angelegt. Soft-Delete schiebt nach Deletions, nach 14 Tagen (Env RETENTION_DELETIONS_TTL_DAYS) wandern Items nach Purges, dort werden sie endgültig aus der DB entfernt (außer Legal Hold aktiv → Items bleiben für eDiscovery erreichbar). Schema: neue Modelle RetentionTag, RetentionPolicyTag, ManagedFolderRun + Felder Message.retentionTagId/retentionExpiresAt/softDeletedAt und Folder.retentionTagId. Backwards-Compat: alte v3.10-Policies ohne Tags wirken als synthetischer DPT. UI komplett überarbeitet: zwei Tabs (Richtlinien / Tags), Policy-Modal mit Tag-Picker (gruppiert nach DPT/RPT/Personal, DPT-Max-1-Warnung), eigenes Tag-Modal mit Typ-Auswahl + RPT-Ordner-Dropdown, MFA-Run-Historie-Modal mit Postfächer/Items/Archiviert/Soft-Del/Hard-Del/Hold-Skip, „MFA jetzt"-Button für Ad-hoc-Lauf. Routes neu: GET/POST/PUT/DELETE /admin/compliance/retention/tags, POST/DELETE /admin/compliance/retention/:id/tags/:tagId, GET /admin/compliance/retention/runs.' },
  { version: '3.10.0', date: '2026-05-18', title: 'eDiscovery komplett umgebaut: Empfänger-Filter, Anhang-Filter, De-Duplizierung, MBOX-Export',
    notes: 'eDiscovery & Legal Hold gemäß Exchange-2019-Standard ausgebaut. Backend-Bugs behoben: `recipientAddresses` aus der Suchmaske wurde komplett ignoriert (jetzt: To/Cc/Bcc via `hasSome`), `hasAttachment` wurde ignoriert (jetzt: Prisma-Relation `some/none`), die Filter-Logik war im Run- und Results-Endpoint dupliziert und drifte (jetzt: zentrale `buildMessageWhere()`-Helper). De-Duplizierung neu: Erkennung doppelter Mails über RFC-822-Message-ID — wenn dieselbe Mail an mehrere interne User ging, taucht sie pro Postfach einzeln in der DB auf; Dedupe behält nur die älteste Kopie. Preview-Endpoint (`/searches/:id/preview`) ohne RUN-Pflicht zeigt Top-N-Sample mit Dedupe-Toggle. Echter Export neu: MBOX-Stream via `GET /searches/:id/export?dedupe=1` (mboxo-Format mit „From "-Quoting), gestreamt in 1000er-Batches, Hard-Cap 50k Mails, Content-Disposition setzt Dateinamen. UI komplett überarbeitet: Mailbox-Multi-Picker (Suche + Checkbox-Liste statt komma-getrennter cuid-Eingabe), Vorschau-Modal mit Tabelle (Betreff/Von/An/Postfach/Datum/Größe) + Dedup-Toggle + Download-Button, Anhang-Filter als Tri-State-Button (Egal/Mit/Ohne), neue Hilfs-Route `/admin/ediscovery/mailboxes` für den Picker.' },
  { version: '3.9.0', date: '2026-05-18', title: 'Übersicht ausgebaut: konfigurierbare Widgets + Server-Info + Uptime',
    notes: 'Systemübersicht komplett überarbeitet. Neuer „Anzeige"-Button öffnet Popover mit Checkboxen für jedes Widget — User entscheidet selbst, was sichtbar ist (in 4 Gruppen: Kennzahlen, Diagramme & Queue, Listen, Server). Auswahl wird in localStorage persistiert (Key coremail-dashboard-v1). „Alle / Keine / Standard"-Buttons als Schnellaktionen. 3 neue Server-Widgets: (1) Server-Info — Uptime in Tagen/Stunden, Start-Zeitstempel, Coremail-Version, Hostname, Plattform/Arch, Node-Version, PID, aktive Sessions; (2) Ressourcen — CPU-Last (1/5/15 min mit Cores), System-RAM, Node-Heap, RSS, jeweils mit Fortschrittsbalken (grün/gelb/rot); (3) Sicherheit (24h) — DNSBL-Treffer-Counter. Plus „Letzte Anmeldungen" mit IP + User-Agent. Backend (/admin/dashboard): liefert jetzt zusätzlich server{uptime,hostname,memory,cpu,…}, activeSessions, recentLogins, securityHits24h.' },
  { version: '3.8.0', date: '2026-05-18', title: 'Öffentliche Ordner: Crash behoben + ACL vereinheitlicht',
    notes: 'Öffentliche Ordner — Page warf "Cannot read properties of undefined" beim Laden. Ursache: Backend lieferte `_count.messages` und nur 3 Tree-Ebenen, Frontend erwartete aber `messageCount` und beliebig tiefe `children`-Arrays. Fix: Backend baut den Baum jetzt aus Flat-Fetch (alle Folder + _count) zusammen, garantiert `messageCount: number` und `children: []` auf jeder Ebene. ACL vereinheitlicht: Backend speicherte `READ/POST/OWNER`, Frontend zeigte `READ/WRITE/FULL` (Labels „Lesen / Lesen & Schreiben / Vollzugriff"). Komplette Migration auf READ/WRITE/FULL inkl. user-facing Permission-Check. GET /acl liefert jetzt `{id, userId, userEmail, permission}` mit aufgelöster E-Mail. POST /acl akzeptiert `{userEmail, permission}` (User-Lookup serverseitig). Bonus: Build-Failure 3.7.9 in mailboxes.ts behoben (alter `sharedMailboxId_userId`-Upsert nach Schema-Wechsel ungültig — auf Replace-Strategie umgestellt).' },
  { version: '3.7.9', date: '2026-05-18', title: 'Admin-Panel-Audit: Pfad-Doppel-Bug + Exchange-2019-Permissions',
    notes: 'Systemischer /api/v1-Doppel-Prefix-Bug in 5 Admin-Pages behoben (SharedMailboxes, TransportRules, Organisation, Certificates, Connectors) — Anlegen funktioniert wieder. Audit zeigt: Greylisting, Message-Trace, Transport-Rules, Verteilergruppen, Ressourcenpostfächer alle funktional. Freigegebene Postfächer: Mehrere Berechtigungen pro User möglich (Exchange-2019-Style FULL_ACCESS+SEND_AS+SEND_ON_BEHALF+READ_ONLY kombinierbar). Prisma-Unique-Constraint erweitert auf (sharedMailboxId, userId, permission). Backend akzeptiert Array {permissions:[...]}. UI: PermissionsModal mit Multi-Checkboxen + Beschreibungen + Konflikt-Warnung bei SEND_AS+SEND_ON_BEHALF.' },
  { version: '3.7.0', date: '2026-05-18', title: 'DNSBL-Modul ausgebaut: Zonen, Aktionen, Score, IPv6, Cache, Statistik',
    notes: 'Eigene DNSBL-Zonen-Verwaltung mit Prisma-Modell DnsblZone statt String-Array. Pro Zone: host, name, description, enabled, action (REJECT/TAG/SCORE_ONLY), weight (0-100), isWhitelist, sortOrder. Built-in-Flag schützt Standard-Provider. Whitelist-Support (DNSWL) — Treffer überspringt alle weiteren Filter. Stärkste Aktion gewinnt bei mehreren Treffern. In-Memory-DNS-Cache (1h TTL) reduziert DNS-Last. IPv6-Support im DNSBL-Lookup. Hit-Logging in DnsblHit-Tabelle asynchron. 8 Built-in-Presets (Spamhaus ZEN, SpamCop, Barracuda, SORBS, Manitu, UCEPROTECT, PSBL, DNSWL.org). Routen: GET/POST/PATCH/DELETE /admin/security/dnsbl, /test (Live-Lookup), /stats (Top-Zonen + Recent-Liste). Admin-Panel: 3 Tabs (Zonen-Karten mit Toggle/Action/Score, Test-Tool mit IP-Eingabe, Statistik mit 24h/7d/30d und Balkendiagramm).' },
  { version: '3.6.9', date: '2026-05-18', title: 'Calendar weiße Seite — FullCalendar-Crash behoben',
    notes: '/calendar zeigte weiße Seite. Ursache: FullCalendar 6.x crasht in React-19, wenn datesSet-Callback setState im Render-Cycle aufruft. Fix: datesSet entfernt (Mini ist Single-Source-of-Truth), hiddenDays + fcLocale in useMemo (verhindert Re-Mount), useRef<FullCalendar | null> mit explizitem null-Type. Variable api in fcApi umbenannt um Shadowing zu vermeiden.' },
  { version: '3.6.8', date: '2026-05-18', title: 'BulkToolbar Outlook-Style + Positions-Fix',
    notes: 'Fix: BulkToolbar überdeckte fälschlich Teile des Readers (left-80 right-0). Korrigiert auf left-52 w-80 — liegt jetzt exakt über der MessageList-Filter-Zeile. Outlook-typisches Design: heller Hintergrund mit Akzent-Border unten statt vollflächig grell akzent-grün. Schrift in normaler Farbe, nur Counter akzent-gefärbt. Aktions-Buttons als Icon-only mit Hover-Akzent.' },
  { version: '3.6.7', date: '2026-05-18', title: 'Mini-Kalender + Filter-Panel + Toolbar-Polish',
    notes: 'Mini-Kalender in der Kalender-Sidebar oben (wie Outlook): Monatsraster mit Wochentag-Headern, KW-Spalte, Heute mit Ring, ausgewählter Tag mit Akzent-Kreis, Navigation per Pfeile, Klick navigiert Hauptkalender. Hauptkalender-Navigation synct MiniCalendar zurück. Neues Filter-Panel im Toolbar: 8 Outlook-Filter (Termine, Besprechungen, Kalendereinträge für Abstimmungen, Reservierungen, Kategorien, Anzeigen als, Wiederholung, Persönlich) mit Checkboxen + Submenu-Pfeile + Filter-löschen-Button. Counter im Toolbar zeigt Anzahl abweichender Filter. Neuer-Termin-Button aus Sidebar entfernt (war doppelt mit Toolbar). RibbonBtn-Layout 80x62 fix für saubere Ausrichtung; line-clamp-2 für lange Labels; Section-Header uppercase tracking-wide.' },
  { version: '3.6.6', date: '2026-05-18', title: 'Kalender-Toolbar (Outlook-Ribbon) + Farbgrid-Picker',
    notes: 'Neue Ribbon-Toolbar über dem Kalender mit 4 Sections (Neu / Anordnen / Filter / Teilen) und Icon+Label-Buttons im Office-Stil. Buttons: Neues Ereignis (Dropdown), Tag/Arbeitswoche/Woche/Monat/Geteilte Ansicht, Filter, Kalender teilen, Drucken. Aktiver View mit Akzent-Ring. Arbeitswoche versteckt Sa/So. Fix: Farb-Submenu zeigte vorher Hex-Codes neben Farbpunkten — jetzt kompaktes 8x2-Grid via neuem ContextMenu type color-grid (aktive Farbe mit Ring, Hover-Scale).' },
  { version: '3.6.5', date: '2026-05-18', title: 'Kalender-Verwaltung (Outlook-Style) + Folder-Selection-Fix',
    notes: 'Kalender-Sidebar komplett ausgebaut wie Outlook. "+ Kalender hinzufügen"-Button über "Meine Kalender". Farb-Checkbox pro Kalender für Ein-/Ausblenden (persistent). 3-Punkte-Menü beim Hover: Nur dies anzeigen, Teilen, Farbe (16 Farben), Symbol (35 Lucide-Icons in Grid), Nach oben/unten, Umbenennen, Löschen (geschützt für Standard-Kalender). Backend: Calendar.icon + sortOrder, POST/PATCH/DELETE Routen, POST /calendar/reorder. Versteckte Kalender werden in allen FullCalendar-Ansichten ausgeblendet. Fix: Ein Ordner, der gleichzeitig als Favorit eingerichtet ist, wurde nach Klick sowohl im Favoriten-Bereich als auch im Tree markiert — selectedFolderSource (fav | tree) koppelt die Selection-Markierung an den Render-Kontext.' },
  { version: '3.5.6', date: '2026-05-18', title: 'Kalender-Verwaltung · Mehrere Kalender · Farben · Symbole · Sortierung',
    notes: 'Kalender-Sidebar komplett ausgebaut wie Outlook. "+ Kalender hinzufügen"-Button über "Meine Kalender". Farb-Checkbox pro Kalender für Ein-/Ausblenden (persistent). 3-Punkte-Menü beim Hover: Nur dies anzeigen, Teilen, Farbe (16 Farben), Symbol (35 Lucide-Icons in Grid), Nach oben/unten, Umbenennen, Löschen (geschützt für Standard-Kalender). Backend: Calendar.icon + sortOrder, POST/PATCH/DELETE Routen, POST /calendar/reorder. Versteckte Kalender werden in allen FullCalendar-Ansichten ausgeblendet.' },
  { version: '3.5.5', date: '2026-05-18', title: 'OWA jetzt direkt unter `/` (statt `/owa/`)',
    notes: 'OWA-Frontend läuft jetzt unter Root-URL statt unter /owa/. Alle SPA-Routen direkt erreichbar (/login, /mail, /settings). Behebt 404 beim direkten Aufruf von /login. Vite-Base /owa/ → /. React-Router basename entfernt. API-Gateway: OWA mit express.static unter Root, SPA-Catch-All mit API-Prefix-Filter (schützt /api/, /auth/, /EWS, /mapi, /OAB, /Autodiscover, /Microsoft-Server-ActiveSync, /dav, /PowerShell, /bcp). BCP bleibt unter /bcp/. 301-Redirect von /owa/* → entsprechender Pfad ohne Prefix (Backwards-Compat).' },
  { version: '3.5.4', date: '2026-05-18', title: 'App-Passwörter-UI + kritischer Pepper-Bug-Fix',
    notes: 'Kritisch: App-Passwörter funktionierten nie bei SMTP/IMAP/POP3 — auth-service hashte ohne Pepper, Verifier verglich mit Pepper. Fix: auth-service nutzt jetzt hashPassword() aus @coremail/core. Bestehende App-Passwörter müssen einmalig neu erstellt werden. Neue UI in OWA → Einstellungen → Konto → App-Passwörter: Liste mit Name/Erstellt/Letzte-Benutzung, "Neu erstellen"-Button mit Inline-Editor, einmalige Passwort-Anzeige mit Copy-Button (Clipboard + ✓-Animation), Widerruf-Button beim Hover. 4 Sprachen (DE/EN/ES/IT).' },
  { version: '3.5.3', date: '2026-05-18', title: 'Mail-Kategorien (Outlook-Style) · Folder-Color-Fix · ContextMenu-Submenu-Bug',
    notes: 'Neue Mail-Kategorien wie in Outlook: Tags mit Name, Farbe, Favorit-Flag. Vollständiges CRUD in Einstellungen → Konto → Kategorien (Inline-Editor mit 14-Farben-Palette). Kategorisieren via Rechtsklick auf Mail (Submenu mit Toggle-Check). Kategorie-Pills in der Nachrichtenliste unter Subject. Volltextsuche mit ?categoryId=…-Filter. Backend-Routen: GET/POST/PATCH/DELETE /api/v1/categories, POST /categories/messages/:id und /messages/bulk. Prisma: Category + MessageCategory n:m. Fix: Ordner-Farbe-Picker reagierte nicht — ContextMenu-Submenu-Bug behoben (mousedown im Hauptmenü schloss das Menü beim Klick auf ein Submenu-Item, das im Portal lebt). Lösung: data-coremail-contextmenu Marker auf allen Roots, outside-Check ignoriert Klicks innerhalb. Folder-Color zeigt jetzt zusätzlich einen farbigen Dot. ContextMenu öffnet mit animate-fly-in.' },
  { version: '3.4.3', date: '2026-05-18', title: 'OWA: Microinteractions · Counter-Animationen · TopBar-Polish · Halo-Pulse',
    notes: 'Halo-Pulse am Neue-Mail-Button (box-shadow alle 3s), Plus-Icon rotiert 90° beim Hover. Checkbox-Bounce beim Auswählen (scale 0.5→1.15→1.0, cubic-bezier overshoot 240ms). AnimatedCounter-Komponente für Unread-Counts (FolderTree), Liste-Header und BulkToolbar — Scale + Akzent-Farbblitz beim Wert-Wechsel. BulkToolbar slide-down (200ms ease-out) statt abrupt. Subject-Underline-on-hover zusätzlich zur Akzent-Färbung. Folder-Drop-Pulse: kontinuierlicher box-shadow-Pulse beim Drag-Over. Compose-Send-Button: Loader2-Spinner während Versendung; Send-Icon translate-x-0.5 beim Hover. TopBar-Polish: App-Switcher mit hover:translate-y-[-1px], aktiv mit shadow-sm; Suchfeld bei Focus weiß mit dunkler Schrift + shadow-md; Glocke hover:rotate-12, Zahnrad hover:rotate-45; Avatar mit Avatar-Komponente (hash-Farbe), ring-white/40 beim Hover; Chevron flippt 180°; Profile-Dropdown mit fly-in. Komplette Umsetzung von Phase-1 (Quick Wins) + Phase-2 (Microinteractions) aus dem UX-Polish-Plan.' },
  { version: '3.2.3', date: '2026-05-18', title: 'OWA-Polish · gröberes Compose · Settings-Konsolidierung · DnD-Fix',
    notes: 'Phase-1 Microinteractions: globale .btn-Klassen mit transition-all 150ms ease-out, active:scale-95, sichtbarer Focus-Ring, Disabled-Stil; hover:shadow-md auf btn-primary, hover:border + shadow-sm auf btn-secondary. CSS-Keyframes pulse-soft (sanft pulsierender Unread-Dot) und slide-in-left (Akzent-Balken). MessageList-Rows mit Hover-Shadow, linker Akzent-Border für Ungelesene, Subject färbt sich akzent beim Hover, Quick-Actions faden+sliden rein, Datum fadet aus, Flag-/Checkbox-Icons mit subtilen Scale-Effekten. FolderTree mit animiertem Akzentbalken, hover:translate-x-0.5, Icon-Scale beim Hover, Unread-Count tabular-nums. KW-Toggle umgezogen von Kalender-Sidebar → Einstellungen → Allgemein → Kalender (Settings-Konsolidierung). Compose-Fenster vergrößert (880×78vh, Editor min 360px). Folder-DnD-Bug behoben (dnd-kit-ID-Kollision durch contextKey, separate Drop/Drag-Refs). "Ordner öffnen" aus Rechtsklick entfernt. UI-Strings ECP→BCP umbenannt (29 Vorkommen).' },
  { version: '3.2.2', date: '2026-05-18', title: 'OWA: 4 Sprachen · Folder-Hierarchie · Kalenderwochen · Dialog-Fixes',
    notes: '4-Sprachen-Switch im OWA (Deutsch/Englisch/Spanisch/Italienisch) unter Einstellungen → "Sprache & Region" mit Flag-Buttons; i18n-Infrastruktur (translations.ts, language-Store, useT()-Hook). Folder-Hierarchie: rekursiver Baum mit Indentation und Expand/Collapse; Drag&Drop-Reparent für Custom-Ordner (Cycle-Check verhindert Ordner-in-eigenen-Subordner); System-Ordner sind Drop-Target aber keine Drag-Source. Neuer Ordner über "+" defaultet jetzt auf Posteingang als Parent. Kalenderwochen-Toggle (KW) in der Kalender-Sidebar mit ISO-Wochenberechnung; FullCalendar-Locale folgt der OWA-Sprache. PromptDialog-Komponente ersetzt window.prompt (war im OWA-Frame teils blockiert) — alle Folder-Mutations zeigen jetzt onSuccess/onError-Toasts. Backend-Regex-Fix: NUL-Byte aus Folder-Validierung entfernt (Synology-Sync-Schaden), Leerzeichen in Ordnernamen jetzt erlaubt.' },
  { version: '3.0.0', date: '2026-05-18', title: 'OWA Major Upgrade · Rechtsklick-Menüs · Favoriten · Drag&Drop · Bulk-Actions',
    notes: 'Major-Sprung 2.x → 3.0.0. End-User-OWA bekommt vollständige Gmail/Outlook.com-typische Interaktion. Rechtsklick auf Ordner: alle gelesen, Favorit, Unterordner, umbenennen, Farbe, löschen, Papierkorb/Junk leeren. Rechtsklick auf Mail: Antworten/Allen/Weiterleiten, Read/Flag/Pin, Schlummern (1h/3h/morgen/Montag), Verschieben, Junk-Toggle, Quelltext, EML-Download. Favoriten-Sektion oben in Sidebar. Mehrfachauswahl mit Shift/Cmd + BulkToolbar. Drag&Drop via @dnd-kit. Hover-Quick-Actions (Archive/Delete/Read). Filter-Tabs (Alle/Ungelesen/Markiert/Anhang). Undo-Toast (5s). ReplyAll/Forward jetzt verdrahtet mit zitiertem Vortext. Backend: neue Routen POST/PATCH/DELETE /mail/folders, POST /folders/:id/empty, POST /messages/bulk, POST|DELETE /messages/:id/snooze, GET /messages/:id/raw. Prisma: Folder.isFavorite/sortOrder/color, Message.pinnedAt/snoozeUntil.' },
  { version: '2.1.44', date: '2026-05-18', title: 'Global Einstellungen oben · DE/EN Sprache · Standards entfernt',
    notes: 'Sidebar: "Einstellungen" direkt unter "Übersicht" verschoben und in "Global Einstellungen" umbenannt. Neues TopBar-Sprachmenü (DE 🇩🇪 / EN 🇬🇧) — Wechsel per Speichern-Button, persistiert in localStorage. i18n-Infrastruktur: translations.ts (180+ Keys DE/EN), language-Store (Zustand, pending-Logik), useT()-Hook. Vollständige Übersetzung: Sidebar-Navigation, TopBar, Global Einstellungen (alle 4 Sektionen). Services: "Standards"-Button entfernt (Defaults werden beim Löschen automatisch wiederhergestellt).' },
  { version: '2.1.43', date: '2026-05-17', title: 'Rspamd 4.0 Vollkonfiguration · ClamAV Scan-Optionen · ACME-Fix',
    notes: 'Rspamd 4.0: Bayes Autolearn (mit Spam/Ham-Schwellwerten), E-Mail-Header-Modifikation (X-Spam, X-Rspamd, Betreff-Prefix), Modul-Toggles für Phishing, Fuzzy, URL-Reputation und MX-Check. 19 neue Felder in SecuritySettings. ClamAV: Aktion bei Virenfund (Quarantäne/Ablehnen/Durchlassen), Fail-Closed, Archive/HTML/Encrypted-Archive-Scan, Größenlimits. ACME-Fix: accountKey als Buffer statt String (acme-client v5), verbesserte Fehlerdiagnose mit Port-80-Hinweis.' },
  { version: '2.1.42', date: '2026-05-17', title: 'SMTP-Gateway entfernt · Spam-/Virenfilter für ausgehende Mail',
    notes: 'SMTP-Gateway-Modus vollständig entfernt (GatewayPage, GatewaySettings-Modell, /api/v1/admin/gateway, Sidebar-Eintrag, GATEWAY_*-Env-Vars). Neu in BCP → SMTP & Routing → Ausgehende Mail: Toggle "Spam-/Virenfilter vor Weiterleitung anwenden" — steuert ob rspamd + ClamAV vor dem Versand ausgehender Mails aktiv sind (Standard: aktiviert). SmtpSettings.outboundFilterEnabled in Prisma-Schema und relay.ts.' },
  { version: '2.1.41', date: '2026-05-17', title: 'SMTP-Banner: benutzerdefinierter Text wird jetzt verwendet',
    notes: 'session.ts verwendete immer den hardcodierten Text "220 mail.local ESMTP CoreMail"; SmtpSettings.bannerText/bannerOverride wurde nie gelesen. Fix: bannerText zu SmtpSessionConfig ergänzt, SMTP-Session liest den konfigurierten Text. Live-Update ohne Neustart: Banner als Getter implementiert — Änderung im Admin-Panel wirkt sofort bei der nächsten Verbindung via Redis settings:reload.' },
  { version: '2.1.40', date: '2026-05-17', title: 'Ausgehende Zustellung: MX direkt oder Smarthost',
    notes: 'Outgoing Delivery Settings in BCP → SMTP & Routing → "Ausgehende Mail": Wahl zwischen direkter MX-Zustellung und Smarthost/Relay. Smarthost-Konfiguration: Host, Port, STARTTLS, Implizites TLS, Benutzername, Passwort (maskiert). Port-Schnellauswahl (25/587/465/2525). 9 Provider-Presets: SendGrid, Mailjet, Mailgun, Postmark, Amazon SES, Gmail, Office 365, IONOS, Strato. Verbindungstest POST /api/v1/admin/smtp-config/test-smarthost. relay.ts: 60s Config-Cache, kein DB-Hit pro Mail.' },
  { version: '2.1.39', date: '2026-05-17', title: 'SMTP/IMAP/POP3 TLS-Zertifikat Auto-Generierung',
    notes: 'Fixes: SMTP-Ports 25/465/587 nicht erreichbar (implicitTls ohne Cert brach gesamten Listener ab); IMAP 993 und POP3 995 verwendeten net.createServer() statt tls.createServer() — faktisch Plaintext. Neu: Beim ersten Start wird automatisch ein RSA-2048 Self-Signed-Zertifikat generiert (10 Jahre gültig, SAN: Hostname + localhost) und in ServerSettings.tlsCert/tlsKey gespeichert. generateSelfSignedCert() + tlsPemToBuffers() in @coremail/core. Per-Listener Error-Isolation: ein fehlerhafter Port blockiert nicht mehr andere. TLS-Cert-Reload via CHANNEL_SETTINGS_RELOAD ohne Container-Neustart.' },
  { version: '2.1.38', date: '2026-05-17', title: 'Wartungsmodus: Banner + Login-Enforcement',
    notes: 'Wartungsmodus-Toggle hatte keine Wirkung — jetzt vollständig durchgesetzt. POST /auth/login gibt 503 für Nicht-Admins wenn aktiv. OWA-Login zeigt amber Banner mit dem konfigurierten Wartungstext. Öffentlicher GET /api/v1/maintenance Endpunkt (kein Auth). Admins (ORGANIZATION_MANAGEMENT, SERVER_MANAGEMENT) können sich weiterhin anmelden.' },
  { version: '2.1.37', date: '2026-05-17', title: 'RFC 6749 OAuth 2.0 vollständige Implementierung',
    notes: 'Client Credentials Grant (§4.4), Password Grant (§4.3), Client HTTP-Basic-Auth (§2.3.1), Token Introspection (RFC 7662), OIDC ID Token bei openid-Scope, CORS auf allen OAuth-Endpunkten, Scope-Validierung (§3.3), Consent-Tracking mit OAuthConsent-Modell, pkceRequired-Flag für Public Clients (SPAs/native Apps), BASE_URL aus DB, nonce-Parameter, Token-Rotation bei Refresh.' },
  { version: '2.1.36', date: '2026-05-17', title: 'Hostname aus Admin-Panel (DB) + RFC 8314/6409/1730/1939 Ports',
    notes: 'MAIL_HOSTNAME aus .env entfernt — Hostname wird primär im Admin-Panel (Server-Einstellungen) konfiguriert und in der Datenbank gespeichert. Gilt global für SMTP-EHLO-Banner, IMAP- und POP3-Begrüßung. Live-Update via Redis settings:reload Channel — kein Neustart nötig. Received:-Header bei Submission (RFC 6409 §6.1). Compose-Dateien bereinigt.' },
  { version: '2.1.35', date: '2026-05-17', title: 'SMTP: RFC 5321-konformer State Machine (Postfix-Architektur)',
    notes: 'smtp-server npm-Paket ersetzt durch eigene TCP-Implementierung. SmtpSession-Klasse: EHLO/HELO, AUTH PLAIN + LOGIN (RFC 4954), STARTTLS (RFC 3207), MAIL FROM/RCPT TO/DATA mit Dot-Stuffing, RSET/NOOP/VRFY/QUIT, Timeout-Management (RFC §4.5.3.2), Max-Line-Length 1000 Zeichen. Postfix-Architektur: Inbound (Port 25, kein Auth) + Submission (Port 465/587, Auth Pflicht, Anti-Spoofing).' },
  { version: '2.1.34', date: '2026-05-17', title: 'SMTP AUTH: 535 Authentication not implemented behoben',
    notes: 'Neuer Submission-Server (Ports 465/587) mit vollständigem onAuth-Handler: prüft Passwort gegen User.passwordHash (bcrypt + pepper) und App-Passwörter. Anti-Spoofing: FROM-Adresse muss mit authentifiziertem User übereinstimmen (oder Shared-Mailbox-Berechtigung SEND_AS/FULL_ACCESS). Port 25 (Inbound) bleibt authOptional für externe MTAs. Lokale Empfänger werden direkt zugestellt, externe über Outbound-Queue.' },
  { version: '2.1.33', date: '2026-05-17', title: 'Setup: E-Mail-Feld folgt Domain automatisch',
    notes: 'Erstkonfiguration: Administrator-E-Mail wird beim Tippen der Domain durchgehend als „admin@<domain>" synchronisiert (emailEdited-Flag verhindert Überschreiben nach manueller Änderung). Bisherige Logik (!email.includes(\'@\')) brach nach dem ersten Zeichen ab.' },
  { version: '2.1.32', date: '2026-05-17', title: 'Postgres Startup-Fix (Synology) + definitiver Port-Close',
    notes: 'entrypoint: prisma db push Retry-Schleife (60×5s) statt einmaligem Versuch mit ignoriertem Fehler. Port-Close: vollständig synchron — server.close() gibt OS-Port via _handle.close() synchron frei + _handle direkt schließen als Nuklear-Option. Kein Warten auf Callback mehr.' },
  { version: '2.1.31', date: '2026-05-17', title: 'Port-Close Root-Cause-Fix: Socket-Tracking + Reload-Mutex',
    notes: 'net.Server.closeAllConnections() existiert nicht auf net.Server (nur http.Server) — optionales Chaining war ein stiller No-Op. Fix: Sockets manuell in Set<net.Socket> tracken, beim Schließen socket.destroy() auf alle Verbindungen. Reload-Mutex (scheduleReload) verhindert parallele Reload-Aufrufe durch Redis-Signal + 10-s-Poll.' },
  { version: '2.1.30', date: '2026-05-17', title: 'Listener-Reload bei DELETE/PUT/POST + Standards-Button',
    notes: 'DELETE und PUT/POST sendeten kein Redis-Reload-Signal → Ports blieben nach Löschen/Bearbeiten bis zum 10-s-Poll offen. Fix: publishReload() nach jeder DB-Operation. Neuer „Standards"-Button stellt Default-Ports (SMTP 25/465/587, IMAP 143/993, POP3 110/995) sofort wieder her inkl. sofortigem Redis-Signal. Übersicht-Hinweis auf dynamisch aktualisiert.' },
  { version: '2.1.29', date: '2026-05-17', title: 'Services Port-Toggle: Startup liest DB-Zustand',
    notes: 'Startup-Code startete Ports immer hardcodiert — Interval-Poll schloss sie danach wieder weil DB active=false. Fix: Startup liest jetzt zuerst DB-Zustand (reloadListeners). Nur beim allerersten Start werden Defaults geseedet. POP3-Server auf main()-Pattern umgestellt. Geister-Eintrag IMAP Port 994 entfernt.' },
  { version: '2.1.28', date: '2026-05-17', title: 'Postfach anlegen: nur aktive Domains',
    notes: 'Domain-Dropdown beim Anlegen neuer Postfächer zeigt nur noch aktive Domains. Deaktivierte Domains werden ausgeblendet. Hinweistext wenn alle Domains deaktiviert sind.' },
  { version: '2.1.27', date: '2026-05-17', title: 'SMTP/IMAP/POP3 Port-Toggle zuverlässig',
    notes: 'server.close() und closeAllConnections() werden jetzt gleichzeitig aufgerufen statt hintereinander. Port wird sofort aus der Map entfernt (verhindert Doppel-Close bei parallelen Reload-Aufrufen). Timeout nach 3 s als Harter Fallback. Zusätzlich 10-Sekunden-Poll als Fallback falls Redis-Signal verloren geht.' },
  { version: '2.1.26', date: '2026-05-17', title: 'bcryptjs statischer Import + smtp-server Property-Fix',
    notes: 'bcryptjs: dynamischer import() gibt { default: module } zurück (CJS in ESM) → bcrypt.hash is not a function. Fix: statischer import statt dynamic. SMTP Port-Toggle: smtp-server nutzt intern .server (nicht ._server) → closeAllConnections() wurde nie aufgerufen → Port blieb aktiv. Property-Name korrigiert.' },
  { version: '2.1.25', date: '2026-05-17', title: 'bcrypt-Fix + Port-Toggle sofortig wirksam',
    notes: 'bcrypt fehlte als Runtime-Dependency → Postfach anlegen/Login schlug mit "Cannot find package bcrypt" fehl. Auf bcryptjs (pure JS, kein native build) gewechselt. Port-Toggle: server.close() wartete auf bestehende Verbindungen → Port blieb laut netstat aktiv. Jetzt closeAllConnections() vor close() für SMTP/IMAP/POP3.' },
  { version: '2.1.24', date: '2026-05-17', title: 'Postfach-Erstellung Fix + Services Port-Toggle',
    notes: 'Postfach anlegen hatte kein try-catch — Prisma-Fehler hingen in Express v4. Services Port-Toggle sendete jetzt ein Redis-Signal an SMTP/IMAP/POP3-Server, die den Port sofort schließen/öffnen ohne Neustart.' },
  { version: '2.1.23', date: '2026-05-17', title: 'BCP Server-Seite bereinigt',
    notes: 'Mail-Protokolle (IMAP/POP3/SMTP Host, Port, TLS) aus BCP → Server → Virtuelle Verzeichnisse entfernt — gehört zu Services. Organisationsname entfernt — doppeltes Feld.' },
  { version: '2.1.22', date: '2026-05-17', title: 'BCP Theme-Unabhängigkeit + MFA TOTP für OWA',
    notes: 'BCP: Akzentfarbe immer Microsoft-Blau (unabhängig vom OWA-Theme), eigener coremail-ecp-theme Key, kein Cross-Tab-Sync mit OWA. OWA: Zweistufige Anmeldung mit TOTP (RFC 6238), vollständige 2FA-Verwaltung in Einstellungen (QR-Code, Backup-Codes, Deaktivieren). Neuer GET /auth/mfa/status Endpunkt.' },
  { version: '2.1.21', date: '2026-05-17', title: 'BCP TopBar: Angemeldeter User + Theme-Toggle',
    notes: 'Neue TopBar im Admin-Panel: zeigt angemeldeten Benutzer (E-Mail, Rolle) mit Avatar-Dropdown und Abmelden-Button. Theme-Umschalter (System/Hell/Dunkel) direkt in der TopBar. Sidebar-Header und alter Logout-Button entfernt.' },
  { version: '2.1.20', date: '2026-05-17', title: 'Toggle-Fix, Dark Mode BCP, SMTP & Routing',
    notes: 'Schutzfilter-Toggle korrigiert (Knob-Position + Dark-Mode-weiß). Dark Mode im Admin-Panel (BCP) via ThemeApplier + CSS-Overrides. Rspamd-Auth-Fix (secure_ip). Navigation: SMTP-Konfiguration → SMTP & Routing.' },
  { version: '2.1.19', date: '2026-05-17', title: 'Observability-Stack entfernt',
    notes: 'Grafana, Prometheus, Alertmanager, Tempo, Loki und OTEL Collector aus dem Docker-Stack entfernt. docker-compose.yml bereinigt. Synology-Compose (docker-compose.synology.yml) auf 2.1.19 aktualisiert und um rspamd + clamav ergänzt.' },
  { version: '2.0.19', date: '2026-05-16', title: 'Passwort ändern & Design-Einstellungen',
    notes: 'OWA: Passwort-Änderungsformular mit Stärkemeter. Design-Einstellungen mit Hell/Dunkel/System-Farbschema und 6 Akzentfarben (sofortige Anwendung). Persistenz via localStorage. Dark-Mode via Tailwind-Klasse, Accent-Farbe via CSS-Variable.' },
  { version: '1.9.19', date: '2026-05-16', title: 'SSO & LDAP / Active Directory',
    notes: 'BCP-Verwaltung für OIDC/OAuth2-Provider (Azure AD, Google, Keycloak, Authentik, Okta) mit Schnellauswahl und Discovery-URL-Test. SAML 2.0 Referenz. LDAP/AD-Verbindungsverwaltung mit Attributzuordnung, Sync-Steuerung und Verbindungstest. Info ganz unten in der Navigation.' },
  { version: '1.8.19', date: '2026-05-16', title: 'Message Queue Management',
    notes: 'Vollständige SMTP-Queue-Verwaltung mit Sub-Navigation: Übersicht (5 Stat-Cards), Ausgehend, Wiederholung (Retry), Dead Letter (Einzelrestart/Alle wiederholen), Einstellungen (Retention, Backoff, Auto-Flush). BullMQ-native API.' },
  { version: '1.7.19', date: '2026-05-16', title: 'Quarantine Detail-View',
    notes: 'Vollständige Quarantäne-Verwaltung mit Detail-Slide-over, MIME-Vorschau aus MinIO, Massen-Selektion, Bereinigung nach Alter, Nummernpagination.' },
  { version: '1.6.19', date: '2026-05-16', title: 'SMTP-Infrastruktur-Konfiguration',
    notes: 'Neue BCP-Seite: Erlaubte ESMTP-Befehle, lokale Zustellung, SMTP-Banner-Override, Greylisting, Relay-Konfiguration, Verbindungslimits. 27 Einstellungsfelder.' },
  { version: '1.5.19', date: '2026-05-16', title: 'Rspamd 4.0 + ClamAV Integration',
    notes: 'Vollständige Sicherheits- & Filterkonfiguration: Rspamd 4.0-Schwellwerte, ClamAV-Status, DNSBL, Greylisting, Länderfilter, Anhänge-Filter.' },
  { version: '1.4.19', date: '2026-05-16', title: 'OWA: Signaturen · Automatische Antworten · Speicher',
    notes: 'Tiptap-Rich-Text-Signatur mit Auto-Insert (neu/Antworten). Vollständiger Abwesenheitsassistent (OOF): Zeitraum, interne/externe Nachricht, nur-Kontakte-Option. Speicher-Quotaanzeige mit Ordner-Aufschlüsselung und Leeren-Button. 9 neue Felder in UserSettings.' },
  { version: '1.3.19', date: '2026-05-16', title: 'BCP: Send/Receive Connectors entfernt',
    notes: 'Send- und Receive-Connectors vollständig entfernt. ServicesPage übernimmt Listener-Verwaltung. /connectors → Redirect zu /services.' },
  { version: '1.3.18', date: '2026-05-16', title: 'BCP: Services bereinigt (SMTP Sending entfernt)',
    notes: 'SMTP Sending aus Listener-Services entfernt. Services: nur SMTP Inbound (25/465/587), IMAP (143/993), POP3 (110/995).' },
  { version: '1.3.17', date: '2026-05-16', title: 'BCP: Services und Connectors zusammengeführt',
    notes: 'Services-Verwaltung direkt in ConnectorsPage. Sub-Navigation mit Connectors + Services-Bereichen. /services → Redirect zu /connectors.' },
  { version: '1.3.16', date: '2026-05-16', title: 'Bugfix: API-Response-Mismatch domains',
    notes: 'GET /admin/domains gibt paginiertes Objekt zurück, Pages verwendeten Antwort direkt als Array → "N.map is not a function". Alle Queries: .then(r => r.domains).' },
  { version: '1.3.15', date: '2026-05-16', title: 'Bugfix: Null-sichere Filter in MailboxesPage + GroupsPage',
    notes: 'u.displayName.toLowerCase() warf TypeError bei null-Feldern. Alle Filter mit ?? \'\' null-sicher gemacht.' },
  { version: '1.3.14', date: '2026-05-16', title: 'Bugfix: React Error Boundary + Null-sichere MailboxesPage',
    notes: 'ErrorBoundary-Klasse verhindert weiße Seiten. displayName.charAt(0) null-sicher. Logout-Redirect auf /ecp/login korrigiert.' },
  { version: '1.3.13', date: '2026-05-16', title: 'Bugfix: Auth-Middleware 401 + Virtuelle Verzeichnisse',
    notes: 'jwt.verify() außerhalb try-catch → unkontrollierter 500 statt 401. Vollständig abgesichert. Virtuelle Verzeichnisse: Endlos-Spinner durch isError-Behandlung ersetzt. 401-Redirect-Pfad korrigiert.' },
  { version: '1.3.12', date: '2026-05-16', title: 'Bugfix: SMTP-Server-Crash (BullMQ + Thread-Erschöpfung)',
    notes: 'pids_limit: 200 zu niedrig → pthread_create-Fehler, Prisma-Tokio-Panic. Auf 500 erhöht. CAP_KILL ergänzt. BullMQ Worker: maxRetriesPerRequest: null via dedizierte createBullMqConnection().' },
  { version: '1.3.11', date: '2026-05-16', title: 'Bugfix: BullMQ Queue-Name + Prisma $queryRaw',
    notes: '"smtp:outbound" → "smtp-outbound" (BullMQ v5 kein Doppelpunkt). Prisma $queryRaw: "Message" → "messages" (PostgreSQL 42P01).' },
  { version: '1.3.10', date: '2026-05-16', title: 'Bugfix: Multi-Port SMTP/IMAP + Auth-Service Portkonflikt',
    notes: 'Startup-Fehler beim Binden mehrerer Ports behoben. Auth-Service Portkonflikt beseitigt. Redis-Container auf UID/GID 999:999 korrigiert.' },
  { version: '1.3.9', date: '2026-05-16', title: 'Security Hardening: OWASP + Container-Härtung',
    notes: 'Helmet HTTP-Security-Header (CSP, HSTS, X-Frame-Options). Rate-Limiting (global 500/15min, Auth 20/15min). Suspicious-Input-Guard. cap_drop: ALL + cap_add gezielt. Supervisord: alle Services als user=node.' },
  { version: '1.3.8', date: '2026-05-16', title: 'Cleanup + Status & Monitoring',
    notes: 'Neue Sidebar-Gruppe "Status & Monitoring": Warteschlangen (Live-Zähler, Mail-Details, Delete) + Server & Health. README: kein Exchange-Branding mehr. Mobile Geräte entfernt.' },
  { version: '1.3.7', date: '2026-05-16', title: 'Audit-Log · OAuth2-Clients · Öffentliche Ordner · Notizen (OWA)',
    notes: 'Audit-Log: filterbares Admin-Aktionsprotokoll, CSV-Export, Auto-Bereinigung. OAuth2-Clients: CRUD, Secret-Rotation, Token-Übersicht. Öffentliche Ordner: rekursiver Baum mit ACL. OWA Notizen: farbige Sticky-Notes mit Suche.' },
  { version: '1.3.6', date: '2026-05-16', title: 'Externe Kontakte · RBAC · eDiscovery · Journaling · Aufbewahrung',
    notes: 'Externe Kontakte in GAL. RBAC (8 Rollen). eDiscovery Cross-Mailbox-Suche + Legal Hold. Journaling nach RFC 3462. Aufbewahrungsrichtlinien (ARCHIVE/DELETE/MOVE, Legal-Hold-Beachten).' },
  { version: '1.3.5', date: '2026-05-16', title: 'Verteilergruppen + Ressourcenpostfächer im BCP',
    notes: 'Verteilergruppen (statisch/dynamisch, SMTP-Expansion rekursiv, Moderierung). Raum-/Geräte-Verwaltung (Auto-Accept, iCal-Parsing, Konfliktprüfung, Buchungskalender).' },
  { version: '1.3.4', date: '2026-05-16', title: 'Nachrichtenfluss-Connectors · Organisation · Adresslisten',
    notes: 'Send/Receive-Connectors CRUD mit Priorität, TLS. Organisation: Freigaberichtlinien, Adresslisten, GAL-Live-Abfrage.' },
  { version: '1.3.3', date: '2026-05-16', title: 'Shared Mailboxes · Quarantäne · Transportregeln · Mobile · Trace',
    notes: 'Freigegebene Postfächer mit Berechtigungsmanagement. Quarantäne. Transportregeln mit Bedingungen/Aktionen. ActiveSync-Geräteverwaltung. Nachrichtenfluss-Trace mit CSV-Export.' },
  { version: '1.3.2', date: '2026-05-15', title: 'SSL/TLS Zertifikat-Verwaltung',
    notes: 'Let\'s Encrypt (ACME HTTP-01), eigene PEM-Zertifikate, Self-Signed-Generator. Auto-Renew, Status-Badges, ACME-Challenge-Route via Redis (TTL 600s). Prisma Certificate-Modell.' },
  { version: '1.3.1', date: '2026-05-15', title: 'Manage Domains: komplette Überarbeitung',
    notes: 'Primäre Domain (Transaction-atomisch), Status-Toggle, DKIM-Auto-Generierung, DNS-Eintrag kopieren, Paginierung. Domain.primary-Feld in Prisma.' },
  { version: '1.3.0', date: '2026-05-15', title: 'Services-Verwaltung (Listener-Konfiguration)',
    notes: 'BCP Services: SMTP Receiving (25/465/587), IMAP (143/993), POP3 (110/995). Listeners-Tabelle mit ADD/Edit/Delete, Default-Seeding, toggle-API. Prisma ServiceListener + ServiceType-Enum.' },
  { version: '1.2.9', date: '2026-05-15', title: 'Globale Server-Einstellungen (BCP)',
    notes: 'BCP Einstellungen: Organisation, Mail-Limits, Sicherheitsrichtlinien (MFA-Pflicht, Passwortlänge, Session-Timeout), Wartungsmodus mit Live-Banner. 15 neue ServerSettings-Felder.' },
  { version: '1.2.8', date: '2026-05-15', title: 'Erweitertes Admin-Dashboard',
    notes: '4 KPI-Karten, SMTP-Queue-Ampel, E-Mail-Chart (Recharts, 7 Tage), Speicher-Ranking Top 10, Domain-Balkendiagramm, letzte Fehler, Audit-Events. Auto-Refresh 30s.' },
  { version: '1.2.7', date: '2026-05-15', title: 'Dateianhänge beim E-Mail-Versand',
    notes: 'Anhänge im OWA-Compose (max. 25MB/Datei, 20 Dateien, Drag & Drop). multer multipart/form-data. BullMQ-Fix: Mails landen in smtp-outbound-Queue.' },
  { version: '1.2.6', date: '2026-05-15', title: 'Gmail-artiger Rich-Text-Editor im Compose-Fenster',
    notes: 'Formatierungsleiste: Block-Typ, Fett/Kursiv/Unterstrichen, Schrift-/Markierungsfarbe, Links, Ausrichtung, Listen, Blockquote, Inline-Code. BCC-Feld. 660px breit.' },
  { version: '1.2.5', date: '2026-05-15', title: 'Echtzeit-Speicherverbrauch pro Postfach im BCP',
    notes: 'Aufklappbare Detailzeile: Quota-Fortschrittsbalken, Ordner-Tabelle. recalculate-quota + recalculate-all-quotas APIs. usedBytes on-the-fly aus Nachrichtengrößen.' },
  { version: '1.2.4', date: '2026-05-15', title: 'Vollständige Benutzerverwaltung im BCP',
    notes: 'Domain-Filter, Quota-Balken (grün/gelb/rot), Bearbeiten-Dialog (Name/Rolle/Quota), Passwort-Reset. Neuer-Benutzer: Domain + Localpart, auto E-Mail.' },
  { version: '1.2.3', date: '2026-05-15', title: 'Serverkonfiguration im BCP (Outlook Autodiscover)',
    notes: 'Virtuelle Verzeichnisse: Hostname, EWS/OWA/EAS-URL, IMAP/POP3/SMTP-Host+Port. ServerSettings Singleton in DB. Autodiscover liest URLs aus DB (60s-Cache). Outlook-Anleitung im BCP.' },
  { version: '1.2.2', date: '2026-05-15', title: 'Bugfix: BigInt-Serialisierungsfehler nach Login',
    notes: 'quotaBytes/usedBytes (Prisma BigInt) nicht serialisierbar → api-gateway-Crash nach Login. Globaler BigInt.prototype.toJSON-Patch in server.ts.' },
  { version: '1.2.1', date: '2026-05-15', title: 'Bugfix: "Invalid request" beim Login',
    notes: '/auth-Route vor express.json() → req.body immer undefined. Auth-Route nach Body-Parser gemountet.' },
  { version: '1.2.0', date: '2026-05-15', title: 'Fix: Auth direkt im api-gateway (kein Proxy)',
    notes: 'Auth-Routen direkt im api-gateway statt HTTP-Proxy zu auth-service. Eliminiert alle Proxy-NetworkErrors.' },
  { version: '1.1.9', date: '2026-05-15', title: 'Bugfix: Login "Invalid credentials" durch falschen Proxy-Pfad',
    notes: 'http-proxy-middleware strippt Mount-Prefix → /auth/login kam als /login an. proxyReq.path auf req.originalUrl korrigiert.' },
  { version: '1.1.8', date: '2026-05-15', title: 'Bugfix: NetworkError — Proxy vor express.json()',
    notes: 'express.json() konsumiert Body-Stream vor Proxy. Proxy-Routen vor express.json() registriert.' },
  { version: '1.1.7', date: '2026-05-14', title: 'Bugfix: NetworkError beim Login (Proxy ersetzt)',
    notes: 'Custom Node.js HTTP-Proxy durch http-proxy-middleware ersetzt. Body-Streaming, Hop-by-hop-Header korrekt.' },
  { version: '1.1.6', date: '2026-05-14', title: 'Bugfix: Login — Body leer + falscher Proxy-Pfad',
    notes: 'Hop-by-Hop-Header nach RFC 2616 filtern, req.body re-serialisieren, req.originalUrl statt req.path.' },
  { version: '1.1.5', date: '2026-05-14', title: 'Bugfix: OWA/BCP Routing funktioniert nicht',
    notes: 'BrowserRouter basename="/owa" und basename="/ecp" fehlten. React Router erkannte Routen nicht.' },
  { version: '1.1.4', date: '2026-05-14', title: 'Bugfix: OWA Login funktioniert nicht',
    notes: 'fetch("http://localhost:3003/auth/login") → fetch("/auth/login"). Browser schickte Request an eigenen PC.' },
  { version: '1.1.3', date: '2026-05-14', title: 'First-Run Setup Wizard',
    notes: 'Setup-Wizard beim ersten Start. Mail-Domain + Admin-E-Mail + Passwort. Erstellt Domain, Admin-User (ORGANIZATION_MANAGEMENT) + 8 Standard-Ordner. SetupGuard in App.tsx.' },
  { version: '1.0.2', date: '2026-05-14', title: 'Bugfix: OWA/BCP leere Seite',
    notes: 'Vite base path: base: "/owa/" und base: "/ecp/". Assets mit absolutem Pfad /assets/... → nicht gefunden.' },
  { version: '1.0.1', date: '2026-05-14', title: 'Bugfix: Prisma OpenSSL 3.x + Redis Synology',
    notes: 'binaryTargets linux-musl-openssl-3.0.x behebt libssl.so.1.1-Fehler auf Alpine 3.20. prisma db push. Redis: AOF → RDB-Snapshots, user="0:0" für Synology. Entrypoint wartet auf PostgreSQL.' },
  { version: '0.11.0', date: '2026-05-14', title: 'Phase 10: Benutzerverwaltung · Modern Auth · Audit-Log · Push · SMTP-Gateway',
    notes: 'Mailbox-Provisionierung (8 Ordner, idempotent). Audit-Log (Fire-and-forget, CSV-Export). OAuth2 Authorization Code + PKCE (RFC 7636) + OIDC. VAPID Web Push mit Topics. SMTP-Gateway (DB-Config). Changelog-API.' },
  { version: '0.10.0', date: '2026-05-14', title: 'Phase 9: S/MIME Inline · Journaling · Aufbewahrungsrichtlinien',
    notes: 'S/MIME CMS: Sign (RFC 5652 SignedData), Verify, Encrypt (AES-256-CBC), Decrypt via node-forge. Auto-Sign/Encrypt pro User. Journaling-Engine RFC 3462. Retention Worker: ARCHIVE/DELETE/MOVE, Legal-Hold-Beachten, 03:00 UTC.' },
  { version: '0.9.2', date: '2026-05-14', title: 'Kein Proxy: api-gateway übernimmt HTTP-Routing',
    notes: 'nginx entfernt. api-gateway: statische Dateien (/owa/, /ecp/) + interner Proxy zu auth/ews/activesync/caldav. 4-Container-Stack. Nur noch 1 Custom-Image: magpeek/coremail-app.' },
  { version: '0.9.1', date: '2026-05-14', title: '2-Container-Architektur & Docker-Deployment-Dokumentation',
    notes: 'magpeek/coremail-app: alle 13 Node.js-Services + Frontends via supervisord. magpeek/coremail-db: PostgreSQL + Redis + MinIO. 14-Service → 2-Container. Vollständige Deployment-Dokumentation.' },
  { version: '0.9.0', date: '2026-05-13', title: 'Phase 8: EMS REST-Bridge · MAPI over HTTP · eDiscovery · Legal Hold',
    notes: 'EMS REST-Bridge: 20+ Exchange Management Shell Cmdlets. PowerShell-Remoting: SOAP/WSMan-Cmdlet-Routing. MAPI over HTTP: EMSMDB Session-Lifecycle, NSPI Adressbuch (GAL). eDiscovery: Cross-Mailbox-Suche, MBOX-Export, Legal Hold.' },
  { version: '0.8.0', date: '2026-05-13', title: 'Phase 7: Verteilergruppen · Raumverwaltung · Öffentliche Ordner · PowerShell-Stub',
    notes: 'Verteilergruppen (statisch/dynamisch, SMTP-Expansion rekursiv). Raum-/Ressourcenpostfächer (Auto-Accept, Konfliktprüfung). Öffentliche Ordner mit ACL. PowerShell-Remoting-Stub (WSDL + WSMan).' },
  { version: '0.7.0', date: '2026-05-13', title: 'Phase 6: ActiveSync (EAS 14.1) + S/MIME',
    notes: 'EAS-Server Port 3005: WBXML-Codec, Provision, FolderSync, Sync (Delta), SendMail, SmartReply/Forward, Ping (Long-Poll 59 min). S/MIME API: PKCS#12-Verwaltung, Public-Key-Abruf. Autodiscover ActiveSync-Block.' },
  { version: '0.6.1', date: '2026-05-09', title: 'Docker Hub Publishing & CI/CD',
    notes: 'GitHub Actions: alle Service-Images bei push auf main + Git-Tags. Multi-Arch (amd64+arm64) via Buildx/QEMU. Layer-Caching. Semantisches Tagging. docker-push.sh Skript.' },
  { version: '0.6.0', date: '2026-05-09', title: 'Phase 5: Backup · Observability · Kubernetes',
    notes: 'Backup-Service: MBOX/EML-ZIP/S3-Export, tägliches Backup 02:00 UTC, 30-Tage-Retention, Soft-Delete-Restore. OpenTelemetry + Prometheus. Observability-Stack (Prometheus/Grafana/Loki/Tempo). Kubernetes Helm-Chart (CloudNativePG, HPA, PDB).' },
  { version: '0.5.0', date: '2026-05-09', title: 'Phase 4: CalDAV + API-Gateway + Frontend',
    notes: 'CalDAV (RFC 4791) + CardDAV (RFC 6352) Port 8082. REST-API Port 3000: Mail/Calendar/Contacts/Tasks/Notes/Admin + SSE Live-Events. React OWA-Webmail (FullCalendar, Tiptap). React BCP-Admin-Panel.' },
  { version: '0.4.0', date: '2026-04-xx', title: 'Phase 3: EWS + Autodiscover + Auth',
    notes: 'EWS-Server SOAP/XML Port 8080: 13 Operationen inkl. SyncFolderItems, Subscribe, GetStreamingEvents. Autodiscover v1+v2 (Outlook 2010–365). Auth-Service: Local/LDAP/OIDC, TOTP, WebAuthn/FIDO2, App-Passwörter.' },
  { version: '0.3.0', date: '2026-03-xx', title: 'Phase 2: SMTP + IMAP + POP3 + Security',
    notes: 'SMTP (25/465/587): SPF/DKIM/DMARC via mailauth, DKIM-Signing, Redis-Queue mit exponentiellem Backoff. IMAP4rev1 + IDLE + CONDSTORE (143/993). POP3 (110/995). Security-Filter: Greylisting, DNSBL, ClamAV, rspamd.' },
  { version: '0.2.0', date: '2026-02-xx', title: 'Phase 1: Foundation',
    notes: 'packages/core: JWT, Redis-Client, pino-Logger, Shared Types. packages/storage: Prisma ORM (22 Modelle), MinIO-Integration, MIME-Parser. Docker-Compose-Basis: PostgreSQL 16, Redis 7, MinIO, rspamd. pnpm-Monorepo, TypeScript 5.5.' },
];

function StatBadge({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 min-w-[120px]">
      <span className="text-xs text-gray-500 mb-0.5">{label}</span>
      <span className="text-base font-semibold text-gray-900">{value}</span>
    </div>
  );
}


export function ComplianceInfoPage() {
  return (
    <div className="p-6 max-w-3xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Shield size={20} className="text-accent" />
        <h1 className="text-xl font-semibold text-gray-900">System-Informationen</h1>
      </div>

      {/* Version card */}
      <div className="card p-5 flex items-start gap-5">
        <div className="w-14 h-14 rounded-xl bg-accent/10 flex items-center justify-center shrink-0">
          <Tag size={24} className="text-accent" />
        </div>
        <div className="flex-1">
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-0.5">Aktuelle Version</p>
          <p className="text-3xl font-bold text-gray-900">v{VERSION}</p>
          <p className="text-sm text-gray-500 mt-0.5">CoreMail — Open-Source Mailserver</p>
        </div>
        <div className="flex gap-3">
          <StatBadge label="Build" value={BUILD_DATE} />
          <StatBadge label="Lizenz" value="MIT" />
        </div>
      </div>

      {/* Links */}
      <div className="card p-5 space-y-3">
        <p className="text-sm font-semibold text-gray-700">Ressourcen</p>
        <div className="grid grid-cols-2 gap-3">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 border border-gray-200 rounded-lg px-4 py-3 hover:bg-gray-50 transition-colors group"
          >
            <Github size={18} className="text-gray-600 group-hover:text-gray-900 shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-800">GitHub Repository</p>
              <p className="text-xs text-gray-400">MAGPEEK/CoreMail</p>
            </div>
            <ExternalLink size={13} className="ml-auto text-gray-400 group-hover:text-gray-600" />
          </a>
          <a
            href={CHANGELOG_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 border border-gray-200 rounded-lg px-4 py-3 hover:bg-gray-50 transition-colors group"
          >
            <BookOpen size={18} className="text-gray-600 group-hover:text-gray-900 shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-800">Changelog</p>
            </div>
            <ExternalLink size={13} className="ml-auto text-gray-400 group-hover:text-gray-600" />
          </a>
          <a
            href={`${GITHUB_URL}/releases`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 border border-gray-200 rounded-lg px-4 py-3 hover:bg-gray-50 transition-colors group"
          >
            <GitBranch size={18} className="text-gray-600 group-hover:text-gray-900 shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-800">Releases</p>
              <p className="text-xs text-gray-400">GitHub Releases</p>
            </div>
            <ExternalLink size={13} className="ml-auto text-gray-400 group-hover:text-gray-600" />
          </a>
          <a
            href={`${GITHUB_URL}/issues`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 border border-gray-200 rounded-lg px-4 py-3 hover:bg-gray-50 transition-colors group"
          >
            <Shield size={18} className="text-gray-600 group-hover:text-gray-900 shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-800">Issues &amp; Support</p>
              <p className="text-xs text-gray-400">Bugs &amp; Feature Requests</p>
            </div>
            <ExternalLink size={13} className="ml-auto text-gray-400 group-hover:text-gray-600" />
          </a>
          <a
            href={DOCKERHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 border border-gray-200 rounded-lg px-4 py-3 hover:bg-gray-50 transition-colors group"
          >
            <HardDriveDownload size={18} className="text-gray-600 group-hover:text-gray-900 shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-800">Docker Hub</p>
              <p className="text-xs text-gray-400">magpeek/coremail-app</p>
            </div>
            <ExternalLink size={13} className="ml-auto text-gray-400 group-hover:text-gray-600" />
          </a>
        </div>
      </div>

      {/* Recent changelog */}
      <div className="card p-5 space-y-4">
        <p className="text-sm font-semibold text-gray-700">Letzte Versionen</p>
        <div className="space-y-4">
          {HIGHLIGHTS.slice(0, 3).map((h, i, arr) => (
            <div key={h.version} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                  i === 0 ? 'bg-accent/15 text-accent' : 'bg-gray-100 text-gray-400'
                }`}>
                  <Tag size={12} />
                </div>
                {i < arr.length - 1 && <div className="w-px flex-1 bg-gray-200 mt-1" />}
              </div>
              <div className="pb-4">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                    i === 0 ? 'bg-accent/10 text-accent' : 'bg-gray-100 text-gray-600'
                  }`}>
                    v{h.version}
                  </span>
                  <span className="text-xs text-gray-400 flex items-center gap-1">
                    <Clock size={10} />
                    {h.date}
                  </span>
                </div>
                <p className="text-sm font-medium text-gray-800">{h.title}</p>
              </div>
            </div>
          ))}
        </div>
        <a
          href={CHANGELOG_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline"
        >
          Vollständiger Changelog auf GitHub
          <ExternalLink size={11} />
        </a>
      </div>

      {/* Stack */}
      <div className="card p-5 space-y-3">
        <p className="text-sm font-semibold text-gray-700">Technologie-Stack</p>
        <div className="flex flex-wrap gap-2">
          {[
            'Node.js 22', 'TypeScript 5.5', 'React 19', 'Vite', 'TailwindCSS',
            'Prisma 5', 'PostgreSQL 16', 'Redis 7', 'Rspamd 4.0', 'ClamAV',
            'Docker', 'pnpm Workspaces',
          ].map(t => (
            <span key={t} className="bg-gray-100 text-gray-700 text-xs px-2.5 py-1 rounded-full font-medium">
              {t}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
