# CoreMail — Docker-Deployment

> **6-Container-Architektur** — alle CoreMail-Dienste laufen in einem einzigen App-Container (`magpeek/coremail-app`), verwaltet von `supervisord`. Rspamd, ClamAV, PostgreSQL, Redis und MinIO laufen in separaten Standard-Images.

---

## Inhalt

1. [Übersicht](#übersicht)
2. [Voraussetzungen](#voraussetzungen)
3. [Schnellstart](#schnellstart)
4. [Zugriff](#zugriff)
5. [Konfigurationsreferenz (.env)](#konfigurationsreferenz-env)
6. [Datenverwaltung](#datenverwaltung)
7. [Updates](#updates)
8. [Synology NAS](#synology-nas)
9. [Fehlerbehebung](#fehlerbehebung)
10. [Produktion — Checkliste](#produktion--checkliste)

---

## Übersicht

CoreMail verwendet eine **6-Container-Architektur**:

| Container | Image | Aufgabe |
|-----------|-------|---------|
| `coremail` | `magpeek/coremail-app:3.17.8` | Alle Mail-Dienste + Webmail (MWA) + Admin-Panel (BCP) |
| `rspamd` | `rspamd/rspamd:4.0.0` | Anti-Spam Engine (Bayes, DKIM/SPF/DMARC, Fuzzy, URL) |
| `clamav` | `clamav/clamav:stable` | Open-Source Antivirus (GPL), freshclam-Updates |
| `postgres` | `postgres:16-alpine` | Primäre Datenbank (Mails, Benutzer, Kalender, Kontakte) |
| `redis` | `redis:7-alpine` | Sessions, SMTP-Queue (BullMQ), Live-Events via SSE, Greylisting |
| `minio` | `minio/minio` | S3-kompatibler Objektspeicher (Anhänge, Quarantäne, Backups) |

### Was ist im `coremail`-Container?

Der App-Container enthält **alle CoreMail-Dienste**, verwaltet von `supervisord`:

| Dienst | Interner Port | Beschreibung |
|--------|--------------|-------------|
| api-gateway | 3000 | REST API + SSE + HTTP-Routing (Haupteingang) |
| auth-service | 3003 | Authentifizierung (Lokal / LDAP / OIDC / MFA) |
| storage-api | 3001 | Datenbankabstraktion (PostgreSQL + MinIO) |
| security-filter | 3002 | SPF/DKIM/DMARC/ARC + Anti-Spam-Pipeline |
| smtp-server | 25 / 465 / 587 | SMTP Inbound + Outbound |
| imap-server | 143 / 993 | IMAP4rev1 + IDLE + CONDSTORE |
| pop3-server | 110 / 995 | POP3 |
| ews-server | 8080 | Exchange Web Services (SOAP) + MAPI over HTTP |
| autodiscover | 8081 | Autodiscover v1 + v2 |
| caldav-server | 8082 | CalDAV + CardDAV |
| backup-service | 3004 | MBOX/EML-Export + S3-Backup |
| activesync | 3005 | Exchange ActiveSync EAS 14.1 |

Der `api-gateway` übernimmt das gesamte HTTP-Routing ohne nginx:
- `/` und `/bcp/` → statische Frontend-Bundles (MWA/BCP aus `/app/www/`)
- `/auth/` → auth-service (localhost:3003)
- `/EWS/`, `/mapi/`, `/Autodiscover/` → ews-server (localhost:8080)
- `/Microsoft-Server-ActiveSync` → activesync (localhost:3005)
- `/dav/` → caldav-server (localhost:8082)
- `/api/v1/`, `/PowerShell/` → direkte Handler

**TLS** wird entweder vom integrierten HTTPS-Proxy (Port 443, Standard) oder einem externen Reverse Proxy übernommen.

---

## Voraussetzungen

- Docker Engine ≥ 24.0 mit Docker Compose v2
- Freie Ports: `443` (oder `3000` bei externem Proxy), `25`, `465`, `587`, `143`, `993`, `110`, `995`
- Min. 2 GB RAM (empfohlen: 4 GB für komfortablen Betrieb mit allen Diensten)
- Min. 10 GB freier Speicher + Speicherplatz für E-Mails/Anhänge
- Unter Linux: Port 25 muss beim Hosting-Provider freigeschaltet sein

---

## Schnellstart

### 1. Repository klonen

```bash
git clone https://github.com/MAGPEEK/CoreMail.git
cd CoreMail
```

### 2. Konfiguration

```bash
cp .env.example .env
```

Pflichtfelder in `.env` setzen:

```bash
# Starke Passwörter generieren
POSTGRES_PASSWORD=$(openssl rand -hex 20)
REDIS_PASSWORD=$(openssl rand -hex 20)
MINIO_ROOT_PASSWORD=$(openssl rand -hex 20)

# Sicherheitsschlüssel generieren
JWT_SECRET=$(openssl rand -hex 32)
PEPPER=$(openssl rand -hex 32)
```

### 3. TLS konfigurieren

**Option A — Integrierter HTTPS-Proxy (empfohlen für VPS/Dedicated):**

CoreMail terminiert TLS selbst auf Port 443. Port `"443:443"` ist in der `docker-compose.yml` bereits gemappt. Nach dem Start Zertifikat im BCP unter **Server → SSL/TLS** hochladen und aktivieren. Hot-Reload ohne Neustart.

```env
# .env — Standard, kann weggelassen werden
HTTPS_PROXY_ENABLED=true
```

**Option B — Externer Reverse Proxy (Traefik, Caddy, nginx, DSM):**

```env
# .env
HTTPS_PROXY_ENABLED=false
```

In `infra/docker/docker-compose.yml` die Zeile `"443:443"` auskommentieren. CoreMail ist dann nur auf Port 3000 (HTTP) erreichbar — TLS übernimmt der Reverse Proxy.

**Selbstsigniertes Zertifikat für Entwicklung:**

```bash
bash scripts/gen-dev-certs.sh
```

### 4. Stack starten

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

Images werden automatisch von Docker Hub geladen. Nach ca. 60–90 Sekunden sind alle Dienste bereit.

```bash
# Status prüfen
docker compose -f infra/docker/docker-compose.yml ps

# Logs verfolgen
docker compose -f infra/docker/docker-compose.yml logs -f
```

### 5. Ersten Admin-Account anlegen

Beim ersten Aufruf von `https://<hostname>/bcp/` erscheint der Setup-Assistent.

Alternativ per API:

```bash
curl -k -X POST https://<hostname>/api/v1/admin/setup \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "admin@deine-domain.de",
    "password": "SicheresPasswort123!",
    "displayName": "Administrator"
  }'
```

---

## Zugriff

| Oberfläche | URL |
|-----------|-----|
| MWA Webmail | `https://<hostname>/` |
| BCP Admin-Panel | `https://<hostname>/bcp/` |
| MinIO Web-Konsole | `http://localhost:9001` (nur lokal!) |
| EWS (Outlook Desktop) | `https://<hostname>/EWS/Exchange.asmx` |
| ActiveSync (Mobil) | `https://<hostname>/Microsoft-Server-ActiveSync` |
| Autodiscover | `https://<hostname>/Autodiscover/Autodiscover.xml` |

**Mail-Ports:**

| Port | Protokoll | Verschlüsselung |
|------|-----------|----------------|
| 25 | SMTP (eingehend, MTA-zu-MTA) | STARTTLS |
| 465 | SMTPS Submission | Implizites TLS |
| 587 | SMTP Submission | STARTTLS |
| 143 | IMAP | STARTTLS |
| 993 | IMAPS | Implizites TLS |
| 110 | POP3 | STARTTLS |
| 995 | POP3S | Implizites TLS |

---

## Konfigurationsreferenz (.env)

Die vollständige `.env`-Datei mit allen verfügbaren Variablen:

```bash
# ─── Sicherheit ──────────────────────────────────────────────────────────────
# JWT-Signaturschlüssel — mind. 32 Zeichen
# Generieren: openssl rand -hex 32
JWT_SECRET=CHANGE-ME-openssl-rand-hex-32

# bcrypt-Pepper für Passwort-Hashes — mind. 32 Zeichen
# ACHTUNG: Änderung invalidiert alle bestehenden Passwörter!
PEPPER=CHANGE-ME-openssl-rand-hex-32

# ─── Datenbank ───────────────────────────────────────────────────────────────
POSTGRES_PASSWORD=CHANGE-ME-openssl-rand-hex-20

# ─── Redis ───────────────────────────────────────────────────────────────────
REDIS_PASSWORD=CHANGE-ME-openssl-rand-hex-20

# ─── MinIO (S3-kompatibler Objektspeicher) ────────────────────────────────────
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=CHANGE-ME-openssl-rand-hex-20

# ─── Betrieb ─────────────────────────────────────────────────────────────────
NODE_ENV=production
LOG_LEVEL=info                  # error | warn | info | debug

# ─── Backup ──────────────────────────────────────────────────────────────────
BACKUP_SCHEDULE=0 2 * * *       # täglich 02:00 UTC
BACKUP_RETENTION_DAYS=30
RETENTION_SCHEDULE=0 3 * * *    # Managed Folder Assistant, täglich 03:00 UTC

# ─── VAPID Web Push — optional ───────────────────────────────────────────────
# Schlüssel generieren: npx web-push generate-vapid-keys
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@example.com

# ─── SMTP-Gateway-Modus — optional ───────────────────────────────────────────
# Relay zu einem vorgelagerten MTA (Exchange on-prem, Postfix, Office 365 …)
GATEWAY_MODE=false
# GATEWAY_UPSTREAM_HOST=smtp.intern.example.com
# GATEWAY_UPSTREAM_PORT=25
# GATEWAY_UPSTREAM_TLS=false
# GATEWAY_UPSTREAM_USER=
# GATEWAY_UPSTREAM_PASS=
# GATEWAY_DOMAINS=example.com,corp.internal
GATEWAY_FILTER=true

# ─── GeoIP / Country-Filtering — optional ────────────────────────────────────
# Kostenloses MaxMind-Konto: https://www.maxmind.com/en/geolite2/signup
MAXMIND_ACCOUNT_ID=
MAXMIND_LICENSE_KEY=

# ─── S/MIME — optional ───────────────────────────────────────────────────────
# SMIME_P12_PASSWORD=

# ─── Integrierter HTTPS-Proxy — optional ─────────────────────────────────────
# true  (Standard) — CoreMail terminiert TLS auf Port 443
# false — Externen Reverse Proxy nutzen; Port 443:443 in docker-compose auskommentieren
# HTTPS_PROXY_ENABLED=false
# HTTPS_PORT=443

# ─── Hostname — optional ─────────────────────────────────────────────────────
# Migrations-Hinweis: wird einmalig in die Datenbank übernommen; danach
# wird der Hostname über BCP → Server-Einstellungen verwaltet.
# MAIL_HOSTNAME=mail.example.com
```

**Wichtige Variablen im Überblick:**

| Variable | Beschreibung | Pflicht |
|----------|-------------|---------|
| `JWT_SECRET` | JWT-Signierungsschlüssel (min. 32 Zeichen) | Ja |
| `PEPPER` | bcrypt-Pepper für Passwort-Hashes (min. 32 Zeichen) | Ja |
| `POSTGRES_PASSWORD` | PostgreSQL-Datenbankpasswort | Ja |
| `REDIS_PASSWORD` | Redis-Authentifizierungspasswort | Ja |
| `MINIO_ROOT_PASSWORD` | MinIO-Administratorpasswort (min. 8 Zeichen) | Ja |
| `LOG_LEVEL` | `error` / `warn` / `info` / `debug` | Nein (`info`) |
| `HTTPS_PROXY_ENABLED` | Integrierter TLS-Proxy aktivieren | Nein (`true`) |
| `GATEWAY_MODE` | SMTP-Gateway-/Relay-Modus | Nein (`false`) |

---

## Datenverwaltung

### Docker Volumes

| Volume | Inhalt | Container |
|--------|--------|----------|
| `pgdata` | PostgreSQL-Datenbankdateien | postgres |
| `redisdata` | Redis-AOF-Persistenz | redis |
| `miniodata` | E-Mail-Anhänge, Quarantäne, Backups | minio |
| `rspamd-data` | Rspamd-Daten, Bayes-Datenbank | rspamd |

### Datenbank-Backup (manuell)

```bash
# PostgreSQL-Dump erstellen
docker exec coremail-postgres pg_dump -U coremail coremail | gzip \
  > coremail-db-$(date +%Y%m%d-%H%M).sql.gz

echo "Backup: coremail-db-$(date +%Y%m%d-%H%M).sql.gz"
```

### Datenbank-Restore

```bash
# Stack stoppen
docker compose -f infra/docker/docker-compose.yml stop

# Backup einspielen
gunzip -c coremail-db-20260516-0200.sql.gz \
  | docker exec -i coremail-postgres psql -U coremail -d coremail

# Stack wieder starten
docker compose -f infra/docker/docker-compose.yml start
```

### Volume-Backup (vollständig)

```bash
# Container stoppen
docker compose -f infra/docker/docker-compose.yml stop

# Volumes sichern
docker run --rm -v pgdata:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/pgdata-$(date +%Y%m%d).tar.gz /data

docker run --rm -v miniodata:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/miniodata-$(date +%Y%m%d).tar.gz /data

# Container wieder starten
docker compose -f infra/docker/docker-compose.yml start
```

### Automatisches Backup (via CoreMail Backup-Service)

- Konfigurierbar über **BCP → Server → Backup**
- Speichert in MinIO (lokal) oder einem externen S3-Bucket
- Point-in-Time Recovery mit konfigurierbarer Retention (`BACKUP_RETENTION_DAYS`)
- Manuell auslösen: `curl -X POST http://localhost:3000/api/v1/admin/backup/trigger -H "Authorization: Bearer $TOKEN"`

---

## Updates

```bash
# 1. Neue Images laden
docker compose -f infra/docker/docker-compose.yml pull

# 2. Stack neu starten (Downtime < 30 Sekunden, Prisma-Migration läuft automatisch)
docker compose -f infra/docker/docker-compose.yml up -d

# 3. Status prüfen
docker compose -f infra/docker/docker-compose.yml ps
curl -s http://localhost:3000/healthz | jq
docker images | grep magpeek
```

**Bestimmte Version einsetzen:**

In `infra/docker/docker-compose.yml` die Image-Zeile anpassen:
```yaml
image: magpeek/coremail-app:3.17.8
```
Dann `docker compose up -d` ausführen.

**Rollback auf vorherige Version:**

```bash
# Image-Tag in docker-compose.yml auf alte Version setzen und neu starten
docker compose -f infra/docker/docker-compose.yml up -d
```

---

## Synology NAS

Für Synology NAS und andere Heimserver existiert eine eigene Compose-Datei (`docker-compose.synology.yml`), die Port-Konflikte mit dem DSM-Webinterface (Port 80/443) vermeidet.

### Voraussetzungen (Synology)

- Synology NAS mit DSM 7.x und Docker-Paket (oder Container Manager)
- SSH-Zugang aktiviert

### Einrichtung

```bash
# Per SSH auf der NAS
ssh admin@<NAS-IP>

# Repository klonen (z. B. nach /volume1/docker/coremail)
git clone https://github.com/MAGPEEK/CoreMail.git /volume1/docker/coremail
cd /volume1/docker/coremail

# Konfiguration
cp .env.example .env
# .env anpassen (Passwörter, ggf. HTTPS_PROXY_ENABLED=false)

# Synology-Stack starten
docker compose -f infra/docker/docker-compose.synology.yml up -d
```

### Ports (Synology)

| Port | Dienst |
|------|--------|
| 8080 | HTTP (CoreMail API + Webinterface) |
| 25 | SMTP |
| 465 / 587 | SMTPS / Submission |
| 143 / 993 | IMAP / IMAPS |
| 110 / 995 | POP3 / POP3S |
| 9001 | MinIO Web-Konsole |

> Port 80 und 443 werden nicht gemappt, da diese vom DSM belegt sind.

### TLS via DSM Application Portal

1. **Synology DSM → Systemsteuerung → Application Portal → Reverse-Proxy** öffnen
2. Neue Regel hinzufügen:
   - Protokoll: HTTPS (443)
   - Ziel: `http://localhost:8080`
3. Im selben Dialog ein Let's Encrypt-Zertifikat für den Hostnamen ausstellen lassen
4. CoreMail ist dann unter `https://<NAS-FQDN>/` erreichbar

### Zugriff (Synology)

```
MWA Webmail:   https://<NAS-FQDN>/        (über DSM Reverse Proxy)
BCP Admin:     https://<NAS-FQDN>/bcp/    (über DSM Reverse Proxy)
MinIO Konsole: http://<NAS-IP>:9001       (nur im lokalen Netz)
```

---

## Fehlerbehebung

### Logs einsehen

```bash
# Alle Container live
docker compose -f infra/docker/docker-compose.yml logs -f

# Nur coremail-Container
docker logs -f coremail

# Letzte 100 Zeilen
docker logs --tail 100 coremail

# Nur Fehler
docker logs coremail 2>&1 | grep -i "error\|fatal\|ERR"
```

### Einzelne Dienste debuggen (supervisord)

```bash
# Status aller Prozesse im Container
docker exec coremail supervisorctl status

# Logs eines bestimmten Dienstes live
docker exec coremail supervisorctl tail -f smtp-server
docker exec coremail supervisorctl tail -f api-gateway

# Dienst neu starten
docker exec coremail supervisorctl restart api-gateway
docker exec coremail supervisorctl restart smtp-server
docker exec coremail supervisorctl restart imap-server

# Alle Dienste neu starten (Container bleibt laufen)
docker exec coremail supervisorctl restart all
```

### Health-Checks

```bash
# CoreMail API
curl -s http://localhost:3000/healthz | jq

# PostgreSQL
docker exec coremail-postgres pg_isready -U coremail -d coremail

# Redis
docker exec coremail-redis redis-cli -a "${REDIS_PASSWORD}" ping

# Ports im Container prüfen
docker exec coremail ss -tlnp
```

### Häufige Probleme

| Problem | Ursache | Lösung |
|---------|---------|--------|
| `coremail` startet nicht sofort | Abhängige Container noch nicht bereit | `depends_on: service_healthy` verzögert den Start — Warten, bis postgres/minio healthy |
| Port 25 belegt | Lokaler MTA (Postfix/Sendmail läuft auf dem Host) | `systemctl stop postfix && systemctl disable postfix` |
| Port 443 belegt | Anderer Dienst nutzt Port 443 | `HTTPS_PROXY_ENABLED=false` setzen + externen Proxy nutzen |
| Langsamer erster Start | Prisma-Migrationen + freshclam-Download (ClamAV) | Normal — nach 60–120 Sekunden bereit |
| BCP nicht erreichbar | Frontend-Bundle noch nicht gebaut | Container-Logs prüfen: `docker logs coremail` |
| `supervisorctl status` zeigt FATAL | Prozess abgestürzt | Logs lesen: `docker exec coremail supervisorctl tail smtp-server` |
| SMTP: „Connection refused" auf Port 25 | Port beim Provider geblockt | Hosting-Provider kontaktieren und Port 25 freischalten lassen |
| Redis-Verbindungsfehler | Falsches `REDIS_PASSWORD` | `.env` prüfen, Stack neu starten |

---

## Produktion — Checkliste

- [ ] Starke zufällige Passwörter in `.env` gesetzt (`openssl rand -hex 32`)
- [ ] `JWT_SECRET` und `PEPPER` auf mindestens 32 Zeichen (empfohlen: 64) gesetzt
- [ ] TLS konfiguriert: integrierter Proxy (Zertifikat im BCP hochgeladen) oder externer Reverse Proxy
- [ ] DNS-Einträge gesetzt: A/AAAA, MX, SPF, DKIM, DMARC — DNS-Check im BCP unter SMTP → DNS prüfen
- [ ] Port 25 beim Hosting-Provider nicht blockiert (ggf. freischalten lassen)
- [ ] Firewall: nur benötigte Ports freigegeben (25, 465, 587, 143, 993, 110, 995, 443)
- [ ] MinIO-Konsole (Port 9001) nach außen gesperrt (localhost-only oder Firewall-Regel)
- [ ] DKIM-Schlüssel im BCP generiert und DNS-Eintrag gesetzt
- [ ] Automatisches Backup konfiguriert und Restore getestet
- [ ] Log-Level auf `warn` oder `error` für Produktion gesetzt
- [ ] VAPID-Schlüssel generiert (für Browser-Push-Benachrichtigungen, optional)
- [ ] GeoIP-Filter konfiguriert (MaxMind-Account, optional)

---

## Weiterführende Dokumentation

- [Kubernetes-Deployment](../infra/k8s/) — Helm Chart für Cluster-Betrieb (HPA, PDB, Redis Cluster, CloudNativePG)
- [COMMANDS.md](../COMMANDS.md) — CLI-Befehlsreferenz (Queues, Benutzer, Backup, Diagnose)
- [CHANGELOG.md](../CHANGELOG.md) — Vollständige Versionshistorie
