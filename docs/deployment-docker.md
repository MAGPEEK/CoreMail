# CoreMail — Docker-Deployment

> **2-Container-Architektur** — alle CoreMail-Dienste laufen in genau zwei Docker-Containern.

---

## Übersicht

CoreMail verwendet eine konsolidierte 2-Container-Architektur:

| Container | Image | Inhalt |
|-----------|-------|--------|
| `coremail-app` | `magpeek/coremail-app:0.9.0` | Alle Node.js-Services + nginx Reverse Proxy + OWA/ECP-Frontends |
| `coremail-db` | `magpeek/coremail-db:0.9.0` | PostgreSQL 16 + Redis 7 + MinIO |

### Was ist in `coremail-app`?

Der App-Container enthält **alle CoreMail-Services**, die von `supervisord` verwaltet werden:

| Service | Interner Port | Beschreibung |
|---------|--------------|-------------|
| nginx | 80 / 443 | Reverse Proxy + statische Frontend-Dateien |
| api-gateway | 3000 | REST API + SSE |
| auth-service | 3003 | Authentifizierung (lokal/LDAP/OIDC/MFA) |
| storage-api | 3001 | Datenbankabstraktion (PostgreSQL + MinIO) |
| security-filter | 3002 | SPF/DKIM/DMARC + Anti-Spam |
| smtp-server | 25/465/587 | SMTP Inbound + Outbound |
| imap-server | 143/993 | IMAP4rev1 + IDLE |
| pop3-server | 110/995 | POP3 |
| ews-server | 8080 | Exchange Web Services + MAPI |
| autodiscover | 8081 | Autodiscover v1/v2 |
| caldav-server | 8082 | CalDAV + CardDAV |
| backup-service | 3004 | MBOX/EML-Export + S3-Backup |
| activesync | 3005 | Exchange ActiveSync EAS 14.1 |

Die Frontend-Bundles (OWA Webmail, ECP Admin) sind als statische Dateien eingebaut und werden direkt von nginx ausgeliefert — ohne separaten Container.

---

## Voraussetzungen

- Docker Engine ≥ 24.0 mit Docker Compose v2
- Freie Ports: 80, 443, 25, 465, 587, 143, 993, 110, 995
- Min. 2 GB RAM (empfohlen: 4 GB für komfortablen Betrieb)
- Min. 10 GB freier Speicher (+ Speicherplatz für E-Mails)

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

Pflichtfelder in `.env` anpassen:

```bash
# Hostname des Mailservers (FQDN)
MAIL_HOSTNAME=mail.deine-domain.de

# Starke Passwörter generieren
POSTGRES_PASSWORD=$(openssl rand -hex 20)
REDIS_PASSWORD=$(openssl rand -hex 20)
MINIO_ROOT_PASSWORD=$(openssl rand -hex 20)

# Sicherheitsschlüssel generieren
JWT_SECRET=$(openssl rand -hex 32)
PEPPER=$(openssl rand -hex 32)
```

### 3. TLS-Zertifikat

**Produktion** — Let's Encrypt (empfohlen):
```bash
# Certbot installieren und Zertifikat ausstellen
certbot certonly --standalone -d mail.deine-domain.de

# Zertifikate in nginx-Verzeichnis verlinken
mkdir -p infra/docker/nginx/certs
ln -sf /etc/letsencrypt/live/mail.deine-domain.de/fullchain.pem \
       infra/docker/nginx/certs/fullchain.pem
ln -sf /etc/letsencrypt/live/mail.deine-domain.de/privkey.pem \
       infra/docker/nginx/certs/privkey.pem
```

**Entwicklung** — Self-Signed:
```bash
bash scripts/gen-dev-certs.sh
```

### 4. Starten

```bash
# Beide Container starten (Images werden automatisch gepullt)
docker compose -f infra/docker/docker-compose.yml up -d

# Logs verfolgen
docker compose -f infra/docker/docker-compose.yml logs -f

# Status prüfen
docker compose -f infra/docker/docker-compose.yml ps
```

### 5. Erster Admin-Account anlegen

Nach ca. 60 Sekunden (Startzeit) den ersten Admin anlegen:

```bash
curl -k -X POST https://mail.deine-domain.de/api/v1/admin/setup \
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
| OWA Webmail | `https://mail.deine-domain.de/owa/` |
| ECP Admin-Panel | `https://mail.deine-domain.de/ecp/` |
| MinIO Konsole | `http://mail.deine-domain.de:9001` |

---

## Konfigurationsreferenz

### Vollständige `.env`-Datei

```bash
# ─── Betrieb ──────────────────────────────────────────────────────────────────
NODE_ENV=production
LOG_LEVEL=info

# ─── Hostname ─────────────────────────────────────────────────────────────────
MAIL_HOSTNAME=mail.deine-domain.de

# ─── Datenbank ────────────────────────────────────────────────────────────────
POSTGRES_PASSWORD=<generiertes-passwort>

# ─── Redis ────────────────────────────────────────────────────────────────────
REDIS_PASSWORD=<generiertes-passwort>

# ─── MinIO (S3-kompatibler Objektspeicher) ────────────────────────────────────
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=<generiertes-passwort>

# ─── Sicherheit ───────────────────────────────────────────────────────────────
JWT_SECRET=<mindestens-64-zeichen>
PEPPER=<mindestens-32-zeichen>

# ─── Backup ───────────────────────────────────────────────────────────────────
BACKUP_SCHEDULE=0 2 * * *        # täglich 02:00 UTC
BACKUP_RETENTION_DAYS=30

# ─── Observability (optional) ─────────────────────────────────────────────────
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=<sicheres-passwort>

# ─── GeoIP (optional — für Länder-Filterung) ──────────────────────────────────
MAXMIND_ACCOUNT_ID=
MAXMIND_LICENSE_KEY=
```

### Wichtige Umgebungsvariablen (coremail-app)

| Variable | Beschreibung | Standard |
|----------|-------------|---------|
| `MAIL_HOSTNAME` | FQDN des Mailservers | — (Pflichtfeld) |
| `JWT_SECRET` | JWT-Signierungsschlüssel | — (Pflichtfeld) |
| `PEPPER` | bcrypt-Pepper | — (Pflichtfeld) |
| `DATABASE_URL` | PostgreSQL-Connection-String | wird aus anderen Vars gebaut |
| `REDIS_URL` | Redis-Connection-String | wird aus anderen Vars gebaut |
| `LOG_LEVEL` | `error`/`warn`/`info`/`debug` | `info` |

---

## Datenverwaltung

### Volumes

| Volume | Inhalt | Container |
|--------|--------|----------|
| `pgdata` | PostgreSQL-Datenbankdateien | coremail-db |
| `redisdata` | Redis-AOF-Persistenz | coremail-db |
| `miniodata` | E-Mail-Anhänge und Backups | coremail-db |

### Backup

**Datenbank-Backup** (manuell):
```bash
docker exec coremail-db pg_dump -U coremail coremail | gzip > coremail-$(date +%Y%m%d).sql.gz
```

**Vollständiges Volume-Backup**:
```bash
# Container stoppen
docker compose -f infra/docker/docker-compose.yml stop

# Volumes sichern
docker run --rm -v pgdata:/data -v $(pwd):/backup alpine \
  tar czf /backup/pgdata-$(date +%Y%m%d).tar.gz /data

# Container wieder starten
docker compose -f infra/docker/docker-compose.yml start
```

**Automatisches Backup** (über CoreMail Backup-Service):
- Konfigurierbar über ECP → Server → Backup
- Speichert verschlüsselt in MinIO (lokal) oder externem S3-Bucket
- PITR (Point-in-Time Recovery) mit konfigurierbarer Retention

---

## Observability

Optionaler Observability-Stack (Prometheus, Grafana, Loki, Tempo):

```bash
docker compose -f infra/docker/docker-compose.yml \
  --profile observability up -d
```

Zugriff:
- Grafana: `http://localhost:3001` (Admin-Zugangsdaten aus `.env`)
- Prometheus: `http://localhost:9090`
- Alertmanager: `http://localhost:9093`

---

## Updates

```bash
# Neue Images laden
docker compose -f infra/docker/docker-compose.yml pull

# Stack neu starten (Rolling Update — kurze Downtime)
docker compose -f infra/docker/docker-compose.yml up -d
```

---

## Synology NAS / Heimserver

Für Synology NAS und andere Heimserver gibt es ein eigenes Setup, das Portkonflikt mit dem DSM-Webinterface vermeidet:

### Vorbereitung (per SSH auf der NAS)

```bash
# Einrichtungs-Skript ausführen
# NAS_HOSTNAME = IP-Adresse oder Hostname der NAS
NAS_HOSTNAME=192.168.1.100 bash scripts/synology-setup.sh
```

Das Skript:
1. Legt die Verzeichnisstruktur unter `/volume1/docker/coremail/` an
2. Generiert ein selbst-signiertes TLS-Zertifikat (10 Jahre Laufzeit)
3. Kopiert die Compose-Datei und nginx-Konfiguration
4. Startet den Stack automatisch

### Ports (Synology-Setup)

| Port | Dienst |
|------|--------|
| 8080 | HTTP → Redirect zu HTTPS |
| 8443 | HTTPS (OWA, ECP, API, EWS) |
| 25 | SMTP |
| 465/587 | SMTPS / Submission |
| 143/993 | IMAP / IMAPS |
| 110/995 | POP3 / POP3S |
| 9001 | MinIO Web Console |

### Zugriff (Synology)

```
OWA Webmail:   https://192.168.1.100:8443/owa/
ECP Admin:     https://192.168.1.100:8443/ecp/
MinIO Konsole: http://192.168.1.100:9001
```

> **Browser-Warnung**: Da das Zertifikat selbst-signiert ist, zeigt der Browser eine Sicherheitswarnung. Diese kann ignoriert werden (Entwicklung/Heimnetz) oder durch ein gültiges Zertifikat (z. B. von einer eigenen CA) ersetzt werden.

---

## Fehlerbehebung

### Logs einsehen

```bash
# Alle Logs
docker compose -f infra/docker/docker-compose.yml logs -f

# Nur App-Container
docker logs -f coremail-app

# Nur DB-Container
docker logs -f coremail-db
```

### Einzelne Services debuggen

```bash
# supervisorctl im App-Container
docker exec -it coremail-app supervisorctl status
docker exec -it coremail-app supervisorctl restart api-gateway

# PostgreSQL im DB-Container
docker exec -it coremail-db psql -U coremail -d coremail

# Redis im DB-Container
docker exec -it coremail-db redis-cli ping
```

### Health-Checks

```bash
# App-Container Health
curl http://localhost/health

# Datenbankverbindung
docker exec coremail-db pg_isready -U coremail -d coremail

# Redis
docker exec coremail-db redis-cli ping
```

### Häufige Probleme

| Problem | Ursache | Lösung |
|---------|---------|--------|
| `coremail-app` startet nicht | DB noch nicht bereit | Warten — `depends_on: service_healthy` verzögert den Start automatisch |
| Port 25 belegt | Lokaler MTA (Postfix/Sendmail) | `systemctl stop postfix && systemctl disable postfix` |
| TLS-Fehler | Zertifikat fehlt | `bash scripts/gen-dev-certs.sh` ausführen |
| Langsamer erster Start | Prisma-Migration + Verbindungsaufbau | Normal — nach 60–90 Sekunden bereit |

---

## Produktion — Checkliste

- [ ] Sichere Passwörter in `.env` gesetzt (`openssl rand -hex 32`)
- [ ] `JWT_SECRET` und `PEPPER` auf mindestens 64 Zeichen gesetzt
- [ ] Gültiges TLS-Zertifikat (Let's Encrypt oder kommerziell) konfiguriert
- [ ] DNS-Einträge gesetzt: A, MX, SPF, DKIM, DMARC
- [ ] Port 25 beim Hosting-Provider nicht blockiert (ggf. freischalten lassen)
- [ ] Firewall: nur benötigte Ports freigegeben (25, 465, 587, 143, 993, 80, 443)
- [ ] MinIO-Konsole (Port 9001) nach außen gesperrt oder durch nginx-Auth gesichert
- [ ] Automatisches Backup konfiguriert und getestet
- [ ] DKIM-Schlüssel im ECP generiert und DNS-Eintrag gesetzt

---

## Weiterführende Dokumentation

- [Kubernetes-Deployment](../infra/k8s/) — Helm Chart für Cluster-Betrieb
- [EWS-Protokoll-Referenz](ews-protocol/) — SOAP-Operationen und Typen
- [REST API-Referenz](api/) — OpenAPI-Spezifikation
- [CHANGELOG](../CHANGELOG.md) — Versionshistorie
