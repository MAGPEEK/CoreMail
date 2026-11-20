# Versionshistorie

> 🇬🇧 [English version](version-history.md)

Die Höhepunkte jeder CoreMail-Version, neueste zuerst. Jede Änderung steht im [Changelog](../CHANGELOG.md); die Release-Notes liegen in [releases/](releases/).

## Letzte Versionen

- **v10.4.2** — Einrichtungs-Assistent in fünf Schritten mit Secrets-Download, Zertifikat per Klick im Dashboard und ein Neustart-Knopf im Admin-Panel ([Release-Notes](releases/v10.4.2.md)).
- **v10.4.1** — Kein Init-Container mehr: Der Hauptcontainer erzeugt Secrets und Konfiguration selbst, die anderen Container warten auf ihre Dateien ([Release-Notes](releases/v10.4.1.md)).
- **v10.4.0** — Einrichtungs-Assistent: Bereitstellung mit drei Befehlen aus einer einzigen Compose-Datei, automatisch erzeugte Secrets, ein geführter Einrichtungs-Assistent (Domain, Admin, Secrets sichern, DNS, Zertifikat) und Compose-Dateien ohne Pflicht-Parameter ([Release-Notes](releases/v10.4.0.md)).
- **v10.3.0** — Eine MCP-Schnittstelle für Admins (ab Werk aus, persönliche Tokens zum Lesen oder Ändern mit den Rechten des Admins), eine neu geordnete Branding-Seite mit nur einem Logo und daraus erzeugtem Favicon, neutrale Wortwahl überall und eine kürzere README ([Release-Notes](releases/v10.3.0.md)).
- **v10.2.0** — Eine neue Webmail-Oberfläche (eine vereinfachte Befehlsleiste, schwebende Bereiche, Hintergrundbilder, Favoriten, Datumsgruppen, E-Mail-Vorlagen), Suchvorschläge aus dem ganzen Postfach, erweiterbare Tabellen in Mails, Kalendertermine nach „Anzeigen als“ dargestellt, korrigierte Aufbewahrungsrichtlinien und Details in der Nachrichtenablaufverfolgung ([Release-Notes](releases/v10.2.0.md))
- **v10.1.0** — Ein ruhigerer Verfassen-Bereich (abgehobene Karte, „Senden“ als einziger farbiger Split-Button oben links, Formatleiste unten)
- **v10.0.0** — **Raum- und Gerätepostfächer sind entfernt**; stattdessen ein freigegebenes Postfach oder ein freigegebener Kalender. Raumdaten werden beim Start nach einer Pflichtsicherung gelöscht — **Breaking, vor dem Upgrade die [Upgrade-Hinweise](releases/v10.0.0.md) lesen**.
- **v9.5.1** — Korrektur einer falschen MAPI-HTTPS-Warnung ([Release-Notes](releases/v9.5.1.md)).
- **v9.5.0** — ActiveSync-Telefone synchronisieren Kalender, Aufgaben, Notizen und Kontakte in beide Richtungen, eine CalDAV-Aufgabenliste für Apple Erinnerungen / Thunderbird / DAVx⁵, Kontakte mit mehreren Adressen und Telefonnummern sowie Kontaktlisten, Ordnerberechtigungen mit Rollen (auch als IMAP-ACL), auf Domains beschränkte Admin-Rollen, der zwischengespeicherte Modus für Desktop-Clients über MAPI, Profilfotos, ein barrierefreies und responsives Webmail sowie DMARC-Ausrichtung nach der Public Suffix List ([Release-Notes](releases/v9.5.0.md)).
- **v9.4.0** — Desktop-Mailprogramme verbinden sich wieder über **MAPI over HTTP** (Opt-in, Online-Modus), Protokollzugriffs-Schalter pro Server, Domain und Postfach, ActiveSync 12.1/14.0/14.1, Echtzeit-Push mit installierbarem Webmail (PWA, Web Push), ein überarbeitetes Webmail (Verfassen im Lesebereich mit Entwurfs-Tabs, Kalender mit Serienausnahmen und Terminplanungs-Assistent, Aufgaben und Nachverfolgungs-Flags), Postfachverwaltung (Auto-Mapping, Gesendet-Kopien, Mailfluss), mitwandernde persönliche Einstellungen, Webmail-Richtlinien, Absenderlisten und Spoofing-Einstellungen sowie TLS 1.0/1.1 für alte Clients als Opt-in ([Release-Notes](releases/v9.4.0.md)).
- **v9.3.0** — Branding (Name, Farben, Logo, Login-Seite), Let's Encrypt funktioniert hinter NAT und Mail-Zertifikate wirken sofort, freigegebene und delegierte Postfächer im Ordnerbereich des Webmails, Wiederherstellung aus gespeicherten Sicherungen plus empfohlene Sicherung ([Release-Notes](releases/v9.3.0.md)).
- **v9.2.0** — Barrierefreier Dark Mode (WCAG 2.2 AA) in Webmail und Admin-Panel, jede BCP-Funktion geprüft und korrigiert, ClamAV-Einstellungen mit EICAR-Selbsttest ([Release-Notes](releases/v9.2.0.md)).
- **v9.1.0** — Freigegebene und delegierte Postfächer in IMAP-Clients (`Shared/`, `Other Users/`), vollständiges RFC-5256-REFERENCES-Threading, gelöschte Elemente in Shared Mailboxes wiederherstellen, Helm-Chart auf echtem Cluster getestet ([Release-Notes](releases/v9.1.0.md)).
- **v9.0.0** — Sicherheitshärtung nach OWASP (gemeinsame Login-Sperre, HttpOnly-Refresh-Cookies, DMARC-Durchsetzung, ReDoS-/DoS-Grenzen, verschlüsselte Backups, Schema-Sync ohne stillen Datenverlust); erweiterte Mail-Logik (DSN, CHUNKING, SMTPUTF8, QRESYNC, SORT/THREAD, Quota-Stufen, gelöschte Elemente wiederherstellen, Server-Entwürfe mit Rückgängig-Senden); automatische Einrichtung für Thunderbird/Apple; Docker-Compose-Varianten minimal/standard/full; Helm-Chart 2.0.0; Ende-zu-Ende in beiden Speichermodi getestet ([docs/e2e.md](e2e.md)). **Breaking — vor dem Upgrade die [Upgrade-Hinweise](releases/v9.0.0.md) lesen**

## Hinweise

**Hinweis zu Desktop-Clients** (seit v9.4.0): Desktop-Mailprogramme können sich über **MAPI over HTTP** verbinden — Opt-in (Protokollschalter `mapi`, **standardmäßig aus**), Online- und **zwischengespeicherter Modus** (zwischengespeichert seit v9.5.0), Basic-Authentifizierung über HTTPS (kein NTLM; bei aktivem MFA ein App-Passwort), Anleitung in [docs/mapi.md](mapi.md). EWS bleibt entfernt. Alternativ wird der Client als **IMAP**-Konto eingerichtet, Kalender + Kontakte via CalDAV/CardDAV (ein CalDAV-Synchronizer-Plugin; oder Apple Kalender, Thunderbird Lightning).

**Hinweis (seit v5.6.0)**: Der OAuth2-Authorization-Server unter `/oauth2/*` wurde komplett entfernt — XOAUTH2 hat in der Praxis keine Mainstream-Client-UI-Unterstützung für Server anderer Anbieter. JWT läuft jetzt wieder mit HS256 (`JWT_SECRET`). REST-API + MWA/BCP nutzen Session-JWTs über `/auth/login`, Mail-Clients App-Passwörter.

**Hinweis (seit v5.6.1)**: Verteilergruppen wurden entfernt — moderne Teams nutzen Shared Mailboxes (mit Aliasen) für Team-Postfächer oder externe Listserv-Tools (Mailman, listmonk) für reine Outbound-Verteiler.

## Höhepunkte je Versionslinie

### v10.x

| Version | Highlights |
|---------|-----------|
| **v10.4.2** | **Schlankerer Assistent und Neustart-Knopf.** Secrets-Download statt Befehlen, DNS- und Zertifikatsschritt ins Admin-Panel verlegt, Let's-Encrypt-Karte im Dashboard, "CoreMail neu starten" unter Server & Health — [Release-Notes](releases/v10.4.2.md) |
| **v10.4.1** | **Kein Init-Container mehr.** Der coremail-Container erzeugt ./secrets und die mitgelieferte Konfiguration beim ersten Start; PostgreSQL, Redis und optionale Dienste warten auf ihre Dateien. Update mit --remove-orphans — [Release-Notes](releases/v10.4.1.md) |
| **v10.4.0** | **Einrichtungs-Assistent.** Drei Befehle zum Bereitstellen (eine Compose-Datei laden, `docker compose up -d`), Secrets automatisch in `./secrets`, Setup-Token in einer Datei, geführter Assistent mit DNS-Prüfung und Zertifikat, alle Compose-Varianten ohne `.env`, Helm-Chart erzeugt fehlende Secrets — [Release-Notes](releases/v10.4.0.md) |
| **v10.3.0** | **MCP-Schnittstelle für Admins und Branding-Seite.** `/mcp` für MCP-Clients (Schalter unter Infrastruktur, ab Werk aus; persönliche Tokens zum Lesen oder Ändern, dieselbe Rolle und Domain-Beschränkung wie im Admin-Panel, jeder Aufruf im Audit-Log), Branding-Seite mit nur einem Logo, daraus erzeugtem Favicon und einer Speicherleiste, Karte für veraltete TLS-Versionen umbenannt, neutrale Wortwahl in Texten und Doku — [Release-Notes](releases/v10.3.0.md) |
| **v10.2.0** | **Neue Webmail-Oberfläche.** Eine vereinfachte Befehlsleiste für Mail, Kalender und Kontakte, schwebende Bereiche über optionalen Hintergrundbildern, Favoriten und Datumsgruppen, E-Mail-Vorlagen, Suchvorschläge aus dem ganzen Postfach (Trigramm-Index), Tabellengröße wählen und Tabellen per „+“ erweitern, Kalendertermine nach „Anzeigen als“ (Abwesend lila), Terminplanungs-Assistent entfernt, Korrekturen an den Aufbewahrungsrichtlinien, Detailansicht der Nachrichtenablaufverfolgung (Verarbeitung, MX-Route, Hops) — [Release-Notes](releases/v10.2.0.md) |
| **v10.1.0** | **Neuer Verfassen-Bereich.** Abgehobene Karte, „Senden“ als einziger farbiger Split-Button oben links (Später senden, Wichtigkeit, Optionen), ruhige Symbole, Adresszeilen mit Avatar-Chips, Text mit höchstens 72 Zeichen pro Zeile, Formatleiste unten (ein-/ausblendbar, wird gemerkt). |
| **v10.0.0** | **Raum- und Gerätepostfächer entfernt** (Breaking). Raum- und Gerätepostfächer, ihre Buchungen und ihre eigenen Postfächer werden beim Start nach einem Pflicht-pg_dump nach `/data/backups` gelöscht (nur die stillgelegten Tabellen; jeder andere Datenverlust wird weiter verweigert); Mail an frühere Raumadressen erhält `550 5.1.1`; Raum-Teilnehmer werden wie Personen eingeladen; `/admin/resources`, EMS `resource-mailboxes` und `/calendar/rooms` antworten mit 404. Stattdessen ein freigegebenes Postfach oder ein freigegebener Kalender. Helm-Chart 3.0.0 (`app.schemaSync.backupClaim` oder `skipBackup` für das Rollout, wenn Räume existieren). |

### v9.x — Sicherheitshärtung & Mail-Logik

| Version | Highlights |
|---------|-----------|
| **v9.5.1** | **Fehlerbehebung.** „Protokolle & Dienste“ zeigt keine falsche MAPI-HTTPS-Warnung mehr, wenn Port 443 ein gültiges Zertifikat per SNI ausliefert; klarere Beschriftung des optionalen Schalters für TLS 1.0/1.1. |
| **v9.5.0** | **ActiveSync-Kalender / -Aufgaben / -Notizen / -Kontakte, Ordnerberechtigungen, auf Domains beschränkte Admins, zwischengespeicherter MAPI-Modus.** ActiveSync-Klassen Kalender, Aufgaben, Notizen und Kontakte in beide Richtungen (EAS 12.1–14.1); CalDAV-Aufgabenliste (VTODO); Kontakte mit mehreren Werten und Kontaktlisten (CardDAV), Kategorien für Notizen; Berechtigungen pro Ordner (Webmail, BCP, REST, IMAP-ACL); auf Domains beschränkte Admin-Rollen mit Schwärzung anderer Domains; zwischengespeicherter MAPI-Modus (ICS-Download / -Upload, Client-IDs bleiben, Konflikterkennung); Profilfotos; Räume beantworten Einladungen per Mail, Serieneinladungen für Räume pro Termin geprüft; barrierefreies und responsives Webmail; BCP-Bearbeitungsbereich, IDN-Anzeige; Backups mit Kontaktlisten, Wiederherstellung behält das Empfangsdatum; DMARC-Ausrichtung nach der Public Suffix List. Helm-Chart 2.3.0. |
| **v9.4.0** | **Überarbeitetes Webmail, MAPI over HTTP, Protokollzugriffs-Schalter.** MAPI over HTTP für Desktop-Mailprogramme (Opt-in, Online-Modus, Basic über TLS); Protokollzugriffs-Schalter pro Server / Domain / Postfach; ActiveSync 12.1 / 14.0 / 14.1; Echtzeit-Ereignisse (IMAP IDLE, JMAP-Push, Webmail-Live-Aktualisierung, Web Push, installierbares Webmail); Webmail mit App-Leiste, Befehlsleiste, Verfassen im Lesebereich mit Entwurfs-Tabs, schlankes Verfassen (Formatierungsleiste, Namen prüfen, Barrierefreiheitsprüfung, Vertraulichkeit); Kalender (Serienausnahmen, Terminplanungs-Assistent, Räume, Anzeigen als, Erinnerungen), Aufgaben und Nachverfolgungs-Flags; Postfachverwaltung (Auto-Mapping, Gesendet-Kopien, Mailfluss, Zugriffs-Audit); mitwandernde persönliche Einstellungen; Webmail-Richtlinien; Absenderlisten, Spoofing- und API-Ratenbegrenzungs-Einstellungen; TLS 1.0/1.1 für alte Clients (Opt-in) und Geräte-Relay; Zertifikats-Schlüssel verschlüsselt gespeichert. Das Empfängerlimit von Webmail / REST folgt jetzt der SMTP-Einstellung „max. Empfänger" (Standard 100). |
| **v9.3.0** | Branding (Produktname, Farben, Logos, Favicon, Login-Seite; SVG-Bereinigung); Let's Encrypt repariert (kein Hairpin-NAT nötig, echte Fehlergründe, Vorabprüfung, Staging) und Mail-Zertifikate wirken bei Zuweisung, mit Startreparatur und Anzeige je Port; freigegebene/delegierte Postfächer im Ordnerbereich des Webmails; Wiederherstellung aus gespeicherten Sicherungen, Systemsicherung (pg_dump), empfohlene Zeitpläne; Scanner-Erkennung blendet rspamd/ClamAV-Einstellungen aus, wenn nicht bereitgestellt. 2.462 Tests; e2e MinIO 166/166, Dateisystem 153/153. |
| **v9.2.0** | WCAG-2.2-AA-Farbtokens für Hell/Dunkel in Webmail und BCP (Theme-Guard-Test); jede BCP-Funktion live geprüft und korrigiert (SMTP-Verbindungslimits wirksam, Schutz des letzten Admins, Backup-Aufbewahrung, Teil-Speichern der Einstellungen); ClamAV-Richtlinien, Status und EICAR-Selbsttest; Release-Notes aus CHANGELOG.md. 2.176 Tests; e2e MinIO 135/135, Dateisystem 130/130. |
| **v9.1.0** | Shared Mailboxes und delegierte Postfächer per IMAP (Namespaces `Shared/`, `Other Users/`, echte ACL-Rechte, sofortiger Rechteentzug); References-Header gespeichert + vollständiges RFC-5256-THREAD=REFERENCES; gelöschte Elemente in freigegebenen/delegierten Postfächern wiederherstellen; Quota der Shared Mailbox; Apple-Profil-Ticket für iOS; Helm-Chart 2.0.1 auf kind getestet (`scripts/k8s-e2e.sh`); Backup-Rechte gehärtet. 2.021 Tests; e2e MinIO 135/135, Dateisystem 130/130. |
| **v9.0.0** | **OWASP-Härtung + erweiterte Mail-Logik** (Breaking). OWASP/ASVS-Audit in vier Bereichen und zwei Review-Runden, alle Befunde mit Tests behoben. Gemeinsame Login-Sperre für Web und Mail, HttpOnly-Refresh-Cookies, SSE-Tickets, DMARC/SPF auf der echten Sitzung mit Schutz der eigenen Domain, ReDoS-sichere Regeln, DoS-Grenzen vor der Anmeldung, SSRF-Schutz, HMAC-signierte Audit-Exporte, verschlüsselte Backups, Schema-Sync ohne stillen Datenverlust, gehärtete Container, signierte CI-Images. SMTP DSN/CHUNKING/SMTPUTF8, 48 h Zustellversuche mit Verzögerungsmeldung; IMAP QRESYNC/SORT/THREAD/ACL/COMPRESS; Quota-Stufen, gelöschte Elemente wiederherstellen (30 Tage), Abwesenheitsnotiz einmal pro Zeitraum, Server-Entwürfe + Rückgängig-Senden; Webmail-Tastenkürzel, Rückgängig, Suchoperatoren; BCP-Rechte-Tabelle + einheitliche Listen; Thunderbird-Autoconfig + Apple-Profil; Compose-Varianten minimal/full; Helm 2.0.0. 1.894 Tests; e2e MinIO 135/135, Dateisystem 130/130. |

### v8.x — Protokoll-Konformität

| Version | Highlights |
|---------|-----------|
| **v8.0.0** | **Protokoll-Konformität** (Breaking). Alle Protokolle gegen RFC/MS-Spezifikation und Clean Code geprüft; alle Befunde mit Tests behoben. SMTP-Ergebnisse pro Empfänger, geprüftes Smarthost-TLS, RFC-3464-Bounces; IMAP-Sequenznummern pro Sitzung, modified UTF-7; POP3 atomares QUIT + Maildrop-Sperre; JMAP vollständige Absender-Policy, seitenweises `/changes`; CalDAV/CardDAV-Discovery + Filter; ActiveSync 14.1 (AirSyncBase, ItemOperations, Search, MeetingResponse, Pflicht-Policy-Key, Remote-Wipe). Lokaler Speicher auf Docker-Volume, S3 mit TLS, `coremail storage migrate`. Geänderte Zugangsdaten schließen offene Sitzungen sofort. Neues Helm-Chart 1.0.0. Ende-zu-Ende getestet (MinIO 131/131, Dateisystem 126/126). |

### v7.x — Sicher ab Werk

| Version | Highlights |
|---------|-----------|
| **v7.0.0** | **Sicher ab Werk** (Breaking). Mailprogramme: App-Passwörter bei Zwei-Faktor-Anmeldung Pflicht, Zugangsdaten nur nach TLS (IMAP STARTTLS, POP3 STLS, SMTP 587), gemeinsame Brute-Force-Sperre. Web/Admin: gehashte, rotierende Sessions mit Widerruf, gehärtete MFA (Backup-Codes, WebAuthn, verschlüsselte TOTP-Secrets), RBAC pro Bereich, Setup-Token, `TRUST_PROXY`, keine Abstürze durch fehlerhafte Requests. Originalmails gespeichert und byte-genau ausgeliefert, atomare UID/modSeq-Vergabe. Neu: OIDC-SSO, LDAP/AD-Login + Sync, automatische Zertifikatserneuerung, Abwesenheitsnotiz, S/MIME-Prüfung, IMAP SEARCH/Literale, CalDAV REPORT + Serientermine, Quarantäne-Freigabe. Entfernt: EWS. MinIO-Image jetzt `pgsty/minio` (gepinnt). Ende-zu-Ende getestet (95/95). |

### v6.x — Sicherheit & Aufräumen

| Version | Highlights |
|---------|-----------|
| **v6.0.0** | **Sicherheits- und Aufräum-Release** nach vollständigem Code-Review. Behoben: Token-Prüfung (Refresh-Tokens nicht mehr als Access-Token gültig, ungültige Tokens bringen keine Dienste mehr zum Absturz), JMAP-Prototype-Pollution, Bcc-Leck und Delegationsrechte, XSS in Shared Mailboxes, Zugriff auf fremde Postfächer (Posteingangsregeln, EWS ResolveNames), SMTP-Befehlsinjektion nach zu großem DATA, IMAP UID FETCH/STORE/EXPUNGE, verlorene ActiveSync-/EWS-Mails, DKIM für Port 465/587, Spamfilter-Verbindungsprüfung, Aufbewahrung nach Zustellzeit. Entfernt: ungenutzte storage-api, PowerShell-Stub, tote BCP-Seiten, OpenTelemetry-Module. EWS hat einen eigenen Schalter. Automatisierte Tests für jeden Fix. |

### v5.x — IMAP4rev2 + RFC-Compliance + Stack-Slim-down

| Version | Highlights |
|---------|-----------|
| **v5.9.0** | **Repository komplett auf Englisch**: README, CHANGELOG, Doku, Code- und Infra-Kommentare, CLI-Ausgaben; deutsches README bleibt als `README.de.md`. Enthält die v5.8.0-Features als erstes veröffentlichtes Image (`magpeek/coremail-app:5.9.0`). |
| **v5.8.0** | **Admin-CLI `coremail`** (neues Paket `cli`, im Image unter `/usr/local/bin/coremail`): Benutzer/Postfächer/Shared Mailboxes anzeigen, anlegen, löschen; Konnektoren SMTP/IMAP/POP3/JMAP/EWS ein-/ausschalten, Listener-Ports/TLS; SMTP-Banner; Zertifikate (Self-Signed, Let's Encrypt, aktivieren, erneuern). **Neue `docker-compose.yml`**: nur die nötigen Parameter, Pflichtwerte mit Startabbruch-Prüfung, `setup.sh` erzeugt die `.env`. |
| **v5.7.1** | **JMAP-Server** — neues Paket `jmap-server` (Port 3006): RFC 8620 Core, 8621 Mail (Mailbox/Email/Thread/Identity/EmailSubmission/SearchSnippet/VacationResponse), 8887 WebSocket, 9404 Blob, 9425 Quota, 9670 Principals/Sharing, 9749 VAPID. Discovery `/.well-known/jmap`, Push via EventSource + WebSocket, Schalter im BCP (Default an). Siehe [docs/jmap.md](jmap.md). |
| **v5.7.0** | Build-Härtung: pnpm auf 11 gepinnt, 70 veraltete `src/*.js`-Artefakte entfernt, `noEmit` in Frontend-tsconfigs. |
| **v5.6.1** | **Verteilergruppen (DistributionGroups) komplett entfernt** — selten genutzt, Use-Case besser mit Shared Mailboxes (Team-Postfächer) oder externem Listserv-Tool gelöst. Schema-Drop von 2 Tabellen + Enum, BCP-Page entfernt, EMS-Cmdlets entfernt. |
| **v5.6.0** | **OAuth2 / Modern Auth komplett aus dem Stack entfernt** (~970 LOC + 4 Prisma-Tabellen). XOAUTH2 hat keine Mainstream-Client-UI für Server anderer Anbieter. JWT zurück auf HS256 (`JWT_SECRET`). Mail-Clients nutzen App-Passwörter, MWA/BCP Session-JWTs. |
| **v5.5.0** | **IMAP4rev2** (RFC 9051) compliance: STARTTLS + AUTHENTICATE SASL + UNSELECT + ID. Entscheidung gegen XOAUTH2 dokumentiert. |
| **v5.4.0** | Einrichtung von Desktop-Clients vereinfacht: IMAP-Konto, Kalender/Kontakte via CalDAV/CardDAV. |
| **v5.3.5** | IMAP FETCH komplett rewritten: ENVELOPE-Bug fixed (NIL-Listen RFC 3501 §7.4.2), echte BODYSTRUCTURE statt BODY[TEXT], INTERNALDATE, BODY[]/BODY[HEADER]/BODY.PEEK[*]/RFC822-Varianten |
| **v5.3.1** | IMAP vollständige Command-Suite: CREATE, DELETE, RENAME, APPEND, COPY, UID COPY, MOVE, UID MOVE, SEARCH, UID SEARCH, CLOSE, CHECK. UID-Compound-Dispatcher-Bug fixed. POP3 App-Password + Byte-Stuffing fix. |
| **v5.2.19** | parseLine empty-quoted-string fix (`LIST "" "*"`) — Mac Mail/iOS Mail/Thunderbird konnten ihre Ordnerliste nie über LIST holen |
| **v5.2.18** | IMAP SPECIAL-USE + LSUB + NAMESPACE + STATUS für Mac Mail / iOS Mail |

### v3.18.x — Feature-Polish & Production-Hardening

| Version | Highlights |
|---------|-----------|
| **v3.18.40** | Setup-Seite für externe Clients im Webmail (CalDAV-Synchronizer-Anleitung) |
| **v3.18.36** | Hostname-Auto-Derive für alle Domains generisch + Bilder-Privacy-Banner gehärtet |
| **v3.18.30** | BigInt-Crash-Fix + Audit-Toggle + Audit-Translations |
| **v3.18.25** | Calendar-Invitations iMIP/iTIP (RFC 6047/5546) — Annehmen/Ablehnen-Buttons in gängigen Mail-Clients |
| **v3.18.18** | CalDAV-URL-Anzeige im Share-Dialog + Toolbar-Share-Button |
| **v3.18.14** | Kalender teilen mit READ/WRITE-Permission + Sidebar-Sektion „Geteilt mit mir" |
| **v3.18.11** | MWA Globales Adressbuch (GAL-Browser) mit Tabs „Mein/Globales Adressbuch" |
| **v3.18.10** | Bilder-Privacy-Banner — externe `<img>` blockiert bis Bestätigung |
| **v3.18.7** | Audit-Log v2: Filter + PDF + SHA-256 + Stats + Anomalien + Meta-Logging |
| **v3.18.5** | eDiscovery & Legal Hold komplett entfernt |
| **v3.18.4** | Signaturen Rich-Text-Editor (Tiptap) mit Bildern/Links/Schriften (10 Fonts) |
| **v3.18.0** | Posteingangsregeln mit Bedingungen, Aktionen und Ausnahmen — Forward/Redirect via BullMQ |

### v3.17.x — Infrastruktur-Festigung

| Version | Highlights |
|---------|-----------|
| **v3.17.0** | Integrierter HTTPS-Proxy (Port 443, Hot-Reload via Redis, BCP → SSL/TLS-Verwaltung) |
| **v3.16.6** | Empfänger-Autocomplete im Compose + Resizable Panels + Ansicht-Einstellungen |
| **v3.15.0** | DNS-Hardening: trusted Resolver (8.8.8.8/1.1.1.1/9.9.9.9) + Cross-Validation |
| **v3.14.0** | Pentest-Fixes: SMTP Brute-Force-Schutz + Rate-Limiting + Fail2Ban + Firewall |
| **v3.13.0** | SMTP-Audit: 5 kritische Bugs gefixt + IANA-Zeitzonen + Webmail in MWA umbenannt |
| **v3.11.0** | Aufbewahrungsrichtlinien: DPT/RPT/Personal-Tags + Aufbewahrungs-Hintergrunddienst |
| **v3.5.5** | MWA jetzt direkt unter `/` (statt `/owa/`) |
| **v3.2.3** | Admin-Panel umbenannt: ECP → BCP, Pfad `/ecp/` → `/bcp/` |
| **v2.1.19** | Grafana + Prometheus aus Stack entfernt; Synology-Compose um rspamd + clamav ergänzt |
