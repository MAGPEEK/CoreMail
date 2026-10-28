# CoreMail Admin-CLI `coremail` (seit v5.8.0)

Die CLI verwaltet Benutzer, Postfächer, Shared Mailboxes, Konnektoren, das
SMTP-Banner und TLS-Zertifikate über dieselbe REST-Admin-API, die auch das
Admin-Panel (BCP) nutzt. Damit gelten dieselben Rollen (`ORGANIZATION_MANAGEMENT`,
`SERVER_MANAGEMENT`), dieselben Validierungen und derselbe Audit-Log.

## Aufruf

Die CLI ist im App-Image enthalten:

```bash
docker exec -it coremail coremail --help
docker exec -it coremail coremail user list
```

Tipp: Alias auf dem Host anlegen:

```bash
alias coremail='docker exec -it coremail coremail'
```

Außerhalb des Containers (z. B. vom Admin-Rechner) funktioniert die CLI gegen jede
erreichbare CoreMail-Instanz:

```bash
coremail --server https://mail.example.de login -u admin@example.de
```

Alle Befehle unterstützen `--json` für maschinenlesbare Ausgabe
(`coremail --json user list | jq`).

## Anmeldung

| Weg | Beschreibung |
|-----|--------------|
| `coremail login` | fragt E-Mail, Passwort und ggf. MFA-Code (TOTP oder Backup-Code) ab; Sitzung wird in `~/.config/coremail/credentials.json` (Rechte 0600) gespeichert und per Refresh-Token automatisch verlängert |
| `COREMAIL_ADMIN_EMAIL` + `COREMAIL_ADMIN_PASSWORD` (+ `COREMAIL_ADMIN_TOTP`) | Login ohne Prompt, z. B. in Skripten |
| `COREMAIL_TOKEN` | fertiges Admin-Access-Token (JWT) direkt verwenden |
| `COREMAIL_API_URL` | Basis-URL der API (Default `http://localhost:3000`, im Container richtig) |
| `COREMAIL_CLI_CREDENTIALS` | anderer Pfad für die Sitzungsdatei |

Im Container ist `localhost:3000` der api-gateway, deshalb ist dort keine URL nötig.
Bei Konten mit WebAuthn-only-MFA bitte TOTP zusätzlich einrichten oder `COREMAIL_TOKEN` nutzen.

```bash
coremail login -u admin@example.de          # interaktiv
coremail whoami                              # gespeicherte Sitzung anzeigen
coremail logout
```

## Benutzer (`user`)

Jeder Benutzer besitzt genau ein Postfach; `user create` legt beides an.

```bash
coremail user list [--domain example.de] [--inactive]
coremail user show max@example.de            # inkl. Ordnerübersicht
coremail user create max@example.de --name "Max Muster" [--password …] [--role USER] [--quota 5GB] [--domain example.de]
coremail user update max@example.de [--name …] [--role SERVER_MANAGEMENT] [--quota 20GB] [--enable|--disable]
coremail user set-password max@example.de [--password …]
coremail user delete max@example.de [--yes]
```

Ohne `--password` fragt die CLI interaktiv (ohne Echo); alternativ `COREMAIL_NEW_PASSWORD`.
Rollen: `USER, HELP_DESK, RECIPIENT_MANAGEMENT, COMPLIANCE_MANAGEMENT, HYGIENE_MANAGEMENT,
SERVER_MANAGEMENT, VIEW_ONLY_ORG, ORGANIZATION_MANAGEMENT`.

## Postfächer (`mailbox`)

Sicht auf Belegung und Ordner der Benutzerpostfächer.

```bash
coremail mailbox list [--sort used|quota|email]
coremail mailbox show max@example.de         # Ordner mit Zählern
coremail mailbox quota max@example.de 10GB
coremail mailbox recalculate [max@example.de]   # Belegung neu berechnen (ein oder alle)
```

## Shared Mailboxes (`shared`)

Team-Postfächer mit Berechtigungen `FULL_ACCESS`, `SEND_AS`, `SEND_ON_BEHALF`, `READ_ONLY`.

```bash
coremail shared list
coremail shared show team@example.de
coremail shared create team@example.de --name "Team Vertrieb" [--quota 20GB]
coremail shared grant team@example.de max@example.de FULL_ACCESS SEND_AS   # ersetzt bestehende Rechte des Benutzers
coremail shared revoke team@example.de max@example.de
coremail shared delete team@example.de [--yes]
```

## Domains (`domain`)

```bash
coremail domain list
```

## Konnektoren (`connector`)

| Name | Bedeutung |
|------|-----------|
| `smtp` (`smtp-receive`) | SMTP-Empfang: Listener 25, 465 (TLS), 587 |
| `smtp-send` | SMTP Submission |
| `imap` | IMAP 143 / IMAPS 993 |
| `pop3` | POP3 110 / POP3S 995 |
| `jmap` | JMAP (`/jmap`, `/.well-known/jmap`) — Schalter in den Server-Einstellungen |
| `mapi` | MAPI over HTTP + EWS (`/mapi`, `/EWS`) — Schalter in den Server-Einstellungen |

```bash
coremail connector status                    # alle Dienste, Ports, TLS, Zustand
coremail connector disable pop3              # alle POP3-Listener aus
coremail connector enable pop3 --port 995    # nur einen Port
coremail connector enable jmap | disable mapi

coremail connector listener list [imap]
coremail connector listener add imap --port 1143 [--address 0.0.0.0] [--ssl false] [--inactive]
coremail connector listener set <id> [--port 1143] [--address …] [--ssl true|false] [--active true|false]
coremail connector listener delete <id>
coremail connector listener restore-defaults smtp
```

Listener-Änderungen greifen über das Redis-Signal sofort; die Container-Port-Freigaben
in `docker-compose.yml` müssen zum Port passen.

## SMTP-Banner (`smtp banner`)

```bash
coremail smtp banner                         # anzeigen
coremail smtp banner set "mail.example.de ESMTP"
coremail smtp banner reset                   # zurück auf Standard (220 <Hostname> ESMTP CoreMail)
```

## Zertifikate (`cert`)

```bash
coremail cert list
coremail cert show mail.example.de           # ID, Name oder Domain
coremail cert self-signed --domains mail.example.de,imap.example.de [--services SMTP,IMAP,POP3] [--days 365]
coremail cert letsencrypt --domains mail.example.de,autodiscover.example.de --email admin@example.de \
    [--services SMTP,IMAP,POP3] [--no-auto-renew] [--staging]
coremail cert activate mail.example.de --https --protocol   # HTTPS-Proxy (443) und/oder SMTP/IMAP/POP3
coremail cert deactivate-https mail.example.de
coremail cert renew mail.example.de
coremail cert delete <id|name|domain> [--yes]
```

Let's Encrypt nutzt HTTP-01: Port 80 des Hosts muss auf CoreMail zeigen
(`"80:3000"` in der Compose) und die Domains müssen per DNS auf den Server zeigen.
Die Ausstellung läuft asynchron; `cert show` zeigt Status und ggf. den letzten Fehler.

## Verhalten und Exit-Codes

- Löschende Befehle fragen nach, außer mit `--yes`; ohne Terminal (Skript) ist `--yes` Pflicht.
- Exit-Code 0 bei Erfolg, 1 bei Fehler (Meldung auf stderr, bei API-Fehlern mit HTTP-Status).
- Jede Änderung erscheint im BCP-Audit-Log mit dem angemeldeten Admin als Akteur.
