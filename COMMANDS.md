# CoreMail — Befehlsreferenz

Schnellreferenz für den Betrieb des CoreMail-Stacks über die Kommandozeile.  
Alle `curl`-Befehle setzen einen laufenden Stack voraus und benötigen einen Admin-Token.

---

## Inhalt

1. [Container & Dienste](#1-container--dienste)
2. [Admin-Token holen](#2-admin-token-holen)
3. [Benutzer verwalten](#3-benutzer-verwalten)
4. [Domains verwalten](#4-domains-verwalten)
5. [Warteschlangen (SMTP-Queue)](#5-warteschlangen-smtp-queue)
6. [Logs & Diagnose](#6-logs--diagnose)
7. [Nachrichtenablaufverfolgung (Message Trace)](#7-nachrichtenablaufverfolgung-message-trace)
8. [Datenbank direkt abfragen](#8-datenbank-direkt-abfragen)
9. [Redis abfragen](#9-redis-abfragen)
10. [SMTP testen](#10-smtp-testen)
11. [Backup & Wiederherstellung](#11-backup--wiederherstellung)
12. [Updates](#12-updates)

---

## 1. Container & Dienste

### Stack-Status

```bash
# Alle Container und ihr Gesundheitsstatus
docker compose ps

# Ressourcenverbrauch live (CPU, RAM, Netz)
docker stats

# Nur CoreMail-Container
docker stats coremail
```

### Health-Check

```bash
# Gibt {"ok":true} zurück wenn der Stack bereit ist
curl -s http://localhost:3000/healthz | jq
```

### Alle internen Dienste prüfen (supervisord)

```bash
# Status aller Prozesse im Container
docker exec coremail supervisorctl status
```

Erwartete Ausgabe:
```
api-gateway                      RUNNING   pid 42, uptime 0:12:33
auth-service                     RUNNING   pid 43, uptime 0:12:33
autodiscover                     RUNNING   pid 44, uptime 0:12:33
backup-service                   RUNNING   pid 45, uptime 0:12:33
caldav-server                    RUNNING   pid 46, uptime 0:12:33
ews-server                       RUNNING   pid 47, uptime 0:12:33
imap-server                      RUNNING   pid 48, uptime 0:12:33
pop3-server                      RUNNING   pid 49, uptime 0:12:33
security-filter                  RUNNING   pid 50, uptime 0:12:33
smtp-server                      RUNNING   pid 51, uptime 0:12:33
storage-api                      RUNNING   pid 52, uptime 0:12:33
```

### Einzelnen Dienst neu starten

```bash
docker exec coremail supervisorctl restart smtp-server
docker exec coremail supervisorctl restart imap-server
docker exec coremail supervisorctl restart api-gateway
docker exec coremail supervisorctl restart ews-server
```

### Alle Dienste neu starten (Container bleibt laufen)

```bash
docker exec coremail supervisorctl restart all
```

---

## 2. Admin-Token holen

Für alle API-Befehle wird ein JWT-Token benötigt. Einmal speichern, dann für alle weiteren Befehle verwenden:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@meinedomain.de","password":"mein-passwort"}' \
  | jq -r '.accessToken')

echo $TOKEN
```

> Den Token als Shell-Variable `$TOKEN` setzen — alle Befehle unten nutzen diese Variable.

---

## 3. Benutzer verwalten

### Alle Benutzer auflisten

```bash
curl -s http://localhost:3000/api/v1/admin/mailboxes \
  -H "Authorization: Bearer $TOKEN" | jq '.users[] | {email, displayName, role, usedBytes}'
```

### Bestimmten Benutzer suchen

```bash
curl -s "http://localhost:3000/api/v1/admin/mailboxes?search=max.mustermann" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Neuen Benutzer erstellen

```bash
curl -s -X POST http://localhost:3000/api/v1/admin/mailboxes \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "max.mustermann@meinedomain.de",
    "displayName": "Max Mustermann",
    "password": "sicheres-passwort",
    "quotaBytes": 10737418240
  }' | jq
```

> `quotaBytes`: 1 GB = 1073741824, 5 GB = 5368709120, 10 GB = 10737418240

### Benutzer-Passwort ändern

```bash
# Benutzer-ID zuerst herausfinden
USER_ID=$(curl -s "http://localhost:3000/api/v1/admin/mailboxes?search=max.mustermann" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.users[0].id')

curl -s -X PUT "http://localhost:3000/api/v1/admin/mailboxes/$USER_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"password": "neues-passwort"}' | jq
```

### Benutzer-Quota ändern

```bash
curl -s -X PUT "http://localhost:3000/api/v1/admin/mailboxes/$USER_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"quotaBytes": 21474836480}' | jq   # 20 GB
```

### Benutzer-Rolle ändern

```bash
# Verfügbare Rollen:
# USER | HELP_DESK | RECIPIENT_MANAGEMENT | COMPLIANCE_MANAGEMENT
# HYGIENE_MANAGEMENT | SERVER_MANAGEMENT | VIEW_ONLY_ORG | ORGANIZATION_MANAGEMENT

curl -s -X PUT "http://localhost:3000/api/v1/admin/mailboxes/$USER_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role": "ORGANIZATION_MANAGEMENT"}' | jq
```

### Benutzer löschen

```bash
curl -s -X DELETE "http://localhost:3000/api/v1/admin/mailboxes/$USER_ID" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Mailbox manuell provisionieren (Ordner anlegen)

```bash
curl -s -X POST "http://localhost:3000/api/v1/admin/mailboxes/$USER_ID/provision" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Quota aller Benutzer neu berechnen

```bash
curl -s -X POST http://localhost:3000/api/v1/admin/mailboxes/recalculate-all-quotas \
  -H "Authorization: Bearer $TOKEN" | jq
```

---

## 4. Domains verwalten

### Alle Domains auflisten

```bash
curl -s http://localhost:3000/api/v1/admin/domains \
  -H "Authorization: Bearer $TOKEN" | jq '.[] | {name, primary, active}'
```

### Neue Domain hinzufügen

```bash
curl -s -X POST http://localhost:3000/api/v1/admin/domains \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "neuedomain.de"}' | jq
```

### DKIM-Record abrufen (für DNS-Eintrag)

```bash
DOMAIN_ID=$(curl -s http://localhost:3000/api/v1/admin/domains \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')

curl -s "http://localhost:3000/api/v1/admin/domains/$DOMAIN_ID/dkim-record" \
  -H "Authorization: Bearer $TOKEN" | jq
```

---

## 5. Warteschlangen (SMTP-Queue)

Die SMTP-Queue verwendet **BullMQ v5**. Queue-Name: `smtp-outbound` (kein Doppelpunkt — BullMQ v5 verbietet Doppelpunkte in Queue-Namen).

### Queue-Übersicht (Anzahl je Status)

```bash
curl -s http://localhost:3000/api/v1/admin/queues \
  -H "Authorization: Bearer $TOKEN" | jq '.[] | {name, count}'
```

### Nachrichten in der ausgehenden Queue anzeigen

```bash
# Ausgehende Queue (aktive Jobs)
curl -s "http://localhost:3000/api/v1/admin/queues/smtp-outbound/jobs?limit=20" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.jobs[] | {index, from: .data.envelope.from, to: .data.envelope.to, subject: .data.subject}'

# Fehlgeschlagene Jobs (Dead Letter)
curl -s "http://localhost:3000/api/v1/admin/queues/smtp-outbound/jobs?state=failed&limit=20" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Einzelne Nachricht aus Queue löschen

```bash
# Index aus der Jobsliste entnehmen
curl -s -X DELETE "http://localhost:3000/api/v1/admin/queues/smtp-outbound/jobs/0" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Queue leeren (alle fehlgeschlagenen Nachrichten löschen)

```bash
curl -s -X POST "http://localhost:3000/api/v1/admin/queues/smtp-outbound/flush" \
  -H "Authorization: Bearer $TOKEN" | jq
```

---

## 6. Logs & Diagnose

### Container-Logs (alle Dienste)

```bash
# Live-Stream
docker logs -f coremail

# Letzte 100 Zeilen
docker logs --tail 100 coremail

# Nur Fehlermeldungen
docker logs coremail 2>&1 | grep -i "error\|fatal\|ERR"
```

### Logs eines bestimmten Dienstes

```bash
# supervisord leitet alle Logs nach stdout
docker exec coremail supervisorctl tail -f smtp-server
docker exec coremail supervisorctl tail -f imap-server
docker exec coremail supervisorctl tail -f api-gateway
```

### Netzwerkverbindungen im Container prüfen

```bash
# Welche Ports lauschen?
docker exec coremail ss -tlnp

# Aktive SMTP-Verbindungen
docker exec coremail ss -tnp | grep :25
```

### Audit-Log der letzten Admin-Aktionen

```bash
curl -s "http://localhost:3000/api/v1/admin/audit-log?limit=20" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.entries[] | {timestamp, actorEmail, action, targetName, success}'
```

### Dashboard-Statistiken

```bash
curl -s http://localhost:3000/api/v1/admin/dashboard \
  -H "Authorization: Bearer $TOKEN" | jq
```

---

## 7. Nachrichtenablaufverfolgung (Message Trace)

Die Nachrichtenablaufverfolgung (Message Trace) protokolliert den vollständigen Weg jeder E-Mail durch den CoreMail-Stack — von der SMTP-Annahme über Spam-/Virenfilter bis zur Zustellung oder Ablehnung.

### Nachrichten suchen

```bash
# Alle Filter sind optional — kombinierbar nach Bedarf

# Nach Absender filtern
curl -s "http://localhost:3000/api/v1/admin/message-trace?sender=absender@domain.de" \
  -H "Authorization: Bearer $TOKEN" | jq

# Nach Empfänger filtern
curl -s "http://localhost:3000/api/v1/admin/message-trace?recipient=empfaenger@domain.de" \
  -H "Authorization: Bearer $TOKEN" | jq

# Nach Status filtern (DELIVERED | REJECTED | SPAM | QUARANTINED | FAILED | DEFERRED)
curl -s "http://localhost:3000/api/v1/admin/message-trace?status=REJECTED" \
  -H "Authorization: Bearer $TOKEN" | jq

# Zeitraum eingrenzen (ISO 8601)
curl -s "http://localhost:3000/api/v1/admin/message-trace?from=2026-05-01T00:00:00Z&to=2026-05-20T23:59:59Z" \
  -H "Authorization: Bearer $TOKEN" | jq

# Kombination: Absender + Status + Zeitraum
curl -s "http://localhost:3000/api/v1/admin/message-trace?sender=absender@domain.de&status=DELIVERED&from=2026-05-01T00:00:00Z" \
  -H "Authorization: Bearer $TOKEN" | jq '.messages[] | {timestamp, sender, recipient, subject, status, reason}'
```

### Verfügbare Filterparameter

| Parameter | Beschreibung | Beispiel |
|-----------|-------------|---------|
| `sender` | Absender-Adresse (exakt oder Partial-Match) | `sender=user@domain.de` |
| `recipient` | Empfänger-Adresse | `recipient=user@domain.de` |
| `status` | Zustellstatus | `status=DELIVERED` |
| `from` | Zeitraum von (ISO 8601) | `from=2026-05-01T00:00:00Z` |
| `to` | Zeitraum bis (ISO 8601) | `to=2026-05-31T23:59:59Z` |
| `limit` | Maximale Anzahl Treffer | `limit=100` |
| `offset` | Pagination | `offset=100` |

### CSV-Export

```bash
# Vollständiger Export (alle Felder) als CSV-Datei
curl -s "http://localhost:3000/api/v1/admin/message-trace/export?sender=absender@domain.de" \
  -H "Authorization: Bearer $TOKEN" \
  -o "message-trace-$(date +%Y%m%d).csv"

# Export mit Zeitraum
curl -s "http://localhost:3000/api/v1/admin/message-trace/export?from=2026-05-01T00:00:00Z&to=2026-05-31T23:59:59Z" \
  -H "Authorization: Bearer $TOKEN" \
  -o "message-trace-mai-2026.csv"
```

---

## 8. Datenbank direkt abfragen

```bash
# PostgreSQL-Shell öffnen
docker exec -it coremail-postgres psql -U coremail -d coremail

# Oder einzelnen Befehl ausführen
docker exec coremail-postgres psql -U coremail -d coremail -c "<SQL>"
```

### Nützliche SQL-Abfragen

```bash
# Alle Benutzer mit Quota-Auslastung
docker exec coremail-postgres psql -U coremail -d coremail -c \
  "SELECT email, display_name, role, used_bytes/1024/1024 AS used_mb, quota_bytes/1024/1024 AS quota_mb FROM users ORDER BY used_bytes DESC;"

# Anzahl Mails pro Benutzer
docker exec coremail-postgres psql -U coremail -d coremail -c \
  "SELECT u.email, COUNT(m.id) AS mails FROM users u LEFT JOIN mailboxes mb ON mb.user_id = u.id LEFT JOIN folders f ON f.mailbox_id = mb.id LEFT JOIN messages m ON m.folder_id = f.id GROUP BY u.email ORDER BY mails DESC;"

# Größte Anhänge
docker exec coremail-postgres psql -U coremail -d coremail -c \
  "SELECT filename, size/1024 AS size_kb, mime_type FROM attachments ORDER BY size DESC LIMIT 20;"

# Alle Domains
docker exec coremail-postgres psql -U coremail -d coremail -c \
  "SELECT name, is_primary, active, created_at FROM domains;"

# Letzte 20 Audit-Log-Einträge
docker exec coremail-postgres psql -U coremail -d coremail -c \
  "SELECT created_at, actor_email, action, target_name, success FROM audit_logs ORDER BY created_at DESC LIMIT 20;"
```

---

## 9. Redis abfragen

```bash
# Redis-CLI öffnen (Passwort aus .env)
docker exec -it coremail-redis redis-cli -a "${REDIS_PASSWORD}"

# Oder einzelnen Befehl
docker exec coremail-redis redis-cli -a "${REDIS_PASSWORD}" <BEFEHL>
```

### Nützliche Redis-Befehle

```bash
# BullMQ Queue-Längen (Queue-Name: smtp-outbound)
# BullMQ v5 speichert Jobs unter: bull:{queuename}:*
docker exec coremail-redis redis-cli -a "${REDIS_PASSWORD}" \
  KEYS "bull:smtp-outbound:*" | wc -l

# Wartende Jobs zählen
docker exec coremail-redis redis-cli -a "${REDIS_PASSWORD}" \
  LLEN "bull:smtp-outbound:wait"

# Fehlgeschlagene Jobs zählen
docker exec coremail-redis redis-cli -a "${REDIS_PASSWORD}" \
  ZCARD "bull:smtp-outbound:failed"

# Aktive Sessions zählen
docker exec coremail-redis redis-cli -a "${REDIS_PASSWORD}" KEYS "session:*" | wc -l

# Greylisting-Einträge zählen
docker exec coremail-redis redis-cli -a "${REDIS_PASSWORD}" KEYS "grey:*" | wc -l

# Greylisting-Whitelist anzeigen
docker exec coremail-redis redis-cli -a "${REDIS_PASSWORD}" KEYS "grey:white:*"

# Speicherverbrauch Redis
docker exec coremail-redis redis-cli -a "${REDIS_PASSWORD}" INFO memory | grep used_memory_human
```

---

## 10. SMTP testen

### Einfacher Verbindungstest (ohne Tool)

```bash
# Testet ob Port 25 antwortet
docker exec coremail nc -z localhost 25 && echo "SMTP Port 25: OK" || echo "SMTP Port 25: FEHLER"
docker exec coremail nc -z localhost 587 && echo "SMTP Port 587: OK" || echo "SMTP Port 587: FEHLER"
docker exec coremail nc -z localhost 993 && echo "IMAP Port 993: OK" || echo "IMAP Port 993: FEHLER"
```

### SMTP-Handshake manuell testen

```bash
# Verbindung zu Port 587 (Submission)
docker exec -it coremail openssl s_client -connect localhost:587 -starttls smtp
```

### Testmail senden (mit swaks — außerhalb des Containers)

```bash
# swaks installieren: brew install swaks (macOS) oder apt install swaks (Linux)
swaks \
  --to   empfaenger@externe-domain.de \
  --from absender@meinedomain.de \
  --server localhost \
  --port 587 \
  --tls \
  --auth-user absender@meinedomain.de \
  --auth-password "passwort" \
  --header "Subject: Testmail von CoreMail" \
  --body "Dieser Test wurde erfolgreich zugestellt."
```

### DKIM-Signierung prüfen (gesendete Mail)

```bash
# Prüft ob ausgehende Mails korrekt signiert werden
docker exec coremail-postgres psql -U coremail -d coremail -c \
  "SELECT dkim_selector, LEFT(dkim_private_key, 40) AS key_preview FROM domains WHERE is_primary = true;"
```

---

## 11. Backup & Wiederherstellung

### Datenbankbackup manuell erstellen

```bash
# PostgreSQL-Dump
docker exec coremail-postgres pg_dump -U coremail coremail | gzip \
  > coremail-db-$(date +%Y%m%d-%H%M).sql.gz

echo "Backup erstellt: coremail-db-$(date +%Y%m%d-%H%M).sql.gz"
```

### Datenbankbackup einspielen

```bash
# Stack stoppen, Daten wiederherstellen, Stack neu starten
docker compose down

gunzip -c coremail-db-20260516-0200.sql.gz \
  | docker exec -i coremail-postgres psql -U coremail -d coremail

docker compose up -d
```

### MinIO-Inhalte auflisten (Anhänge)

```bash
# MinIO Client (mc) installieren: https://min.io/docs/minio/linux/reference/minio-mc.html
mc alias set coremail http://localhost:9000 minioadmin "${MINIO_ROOT_PASSWORD}"
mc ls coremail/mail-attachments
mc du coremail/mail-attachments
```

### Admin-Backup über API auslösen

```bash
curl -s -X POST http://localhost:3000/api/v1/admin/backup/trigger \
  -H "Authorization: Bearer $TOKEN" | jq
```

---

## 12. Updates

### Auf neue Version aktualisieren

```bash
# 1. Neue Images laden
docker compose pull

# 2. Stack neu starten (Downtime < 30 Sekunden)
docker compose up -d

# 3. Versionen prüfen
docker images | grep magpeek
docker compose ps
curl -s http://localhost:3000/healthz | jq
```

### Bestimmte Version einsetzen

```bash
# In docker-compose.yml die Image-Zeile anpassen:
#   image: magpeek/coremail-app:3.17.8
# Dann:
docker compose up -d --pull always
```

### Vollständige Neuinstallation (Daten behalten)

```bash
# Alte Container entfernen (Volumes bleiben!)
docker compose down

# Neueste Images laden
docker compose pull

# Stack neu starten
docker compose up -d
```

---

## Spickzettel

```bash
# Stack starten / stoppen
docker compose up -d
docker compose down

# Health-Check
curl -s http://localhost:3000/healthz | jq

# Dienste im Container
docker exec coremail supervisorctl status

# Logs live
docker logs -f coremail

# Admin-Token
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ADMIN@DOMAIN","password":"PASSWORT"}' | jq -r '.accessToken')

# Benutzer anlegen
curl -s -X POST http://localhost:3000/api/v1/admin/mailboxes \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"email":"user@domain.de","displayName":"Name","password":"pw","quotaBytes":5368709120}' | jq

# Queue-Status
curl -s http://localhost:3000/api/v1/admin/queues -H "Authorization: Bearer $TOKEN" | jq

# Message Trace
curl -s "http://localhost:3000/api/v1/admin/message-trace?sender=user@domain.de&status=REJECTED" \
  -H "Authorization: Bearer $TOKEN" | jq '.messages[] | {timestamp, recipient, subject, reason}'

# Datenbank-Shell
docker exec -it coremail-postgres psql -U coremail -d coremail

# BullMQ Queue-Länge (smtp-outbound)
docker exec coremail-redis redis-cli -a "${REDIS_PASSWORD}" LLEN "bull:smtp-outbound:wait"

# Update
docker compose pull && docker compose up -d
```
