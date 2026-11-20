<p align="center">
  <img src="packages/web-client/public/favicon.svg" width="96" alt="CoreMail-Logo">
</p>

<h1 align="center">CoreMail</h1>

<p align="center">
  <a href="https://github.com/MAGPEEK/CoreMail/releases"><img src="https://img.shields.io/badge/version-10.3.0-brightgreen.svg" alt="Version 10.3.0"></a>
  <a href="https://hub.docker.com/r/magpeek/coremail-app"><img src="https://img.shields.io/docker/pulls/magpeek/coremail-app.svg" alt="Docker Pulls"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="Lizenz: MIT"></a>
</p>

<p align="center">
  Dein eigener Mailserver mit Webmail, Kalender und Kontakten, in einem Docker-Image.
</p>

<p align="center">
  <a href="#schnellstart">Schnellstart</a> ·
  <a href="docs/">Dokumentation</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="docs/version-history.de.md">Versionshistorie</a> ·
  <a href="https://github.com/MAGPEEK/CoreMail/releases">Releases</a> ·
  <a href="https://hub.docker.com/r/magpeek/coremail-app">Docker Hub</a>
</p>

<p align="center">
  🇬🇧 <a href="README.md">English version</a> · 🇩🇪 Deutsche Fassung
</p>

<table>
  <tr>
    <td width="50%" align="center"><img src="docs/images/webmail.png" alt="Webmail"><br><sub>Webmail</sub></td>
    <td width="50%" align="center"><img src="docs/images/admin.png" alt="Admin-Panel (BCP)"><br><sub>Admin-Panel (BCP)</sub></td>
  </tr>
</table>

## Was ist CoreMail?

CoreMail ist ein selbst gehosteter Open-Source-Mailserver. Er bringt ein vollständiges Webmail mit (Mail, Kalender, Kontakte, Aufgaben, Notizen) und ein Admin-Panel (BCP) für Benutzer, Domains, Sicherheit und Zertifikate. Alles läuft in einem Docker-Image neben PostgreSQL und Redis. Desktop-Mailprogramme verbinden sich über MAPI over HTTP oder IMAP, Telefone über ActiveSync, Apple Mail, Thunderbird und andere Apps über IMAP, SMTP, CalDAV/CardDAV oder JMAP.

## Für wen ist CoreMail?

- Kleine und mittlere Unternehmen mit 10–500 Postfächern, die ihre Mails auf dem eigenen Server haben wollen.
- Selfhoster und Homelabs mit eigener Domain.
- IT-Dienstleister, die mehrere Kundendomains auf einem Server betreiben, mit Admins, die nur ihre eigenen Domains sehen.
- Teams, die Desktop-Clients, Telefone und das Webmail mit demselben Postfach nutzen.

Nicht gedacht ist CoreMail für große Anbieter mit Tausenden Postfächern auf einem Host.

## Funktionen

- **Protokolle:** SMTP (25, 465, 587), IMAP4rev2, POP3, JMAP, ActiveSync 12.1–14.1, CalDAV/CardDAV, Autodiscover und automatische Einrichtung für Thunderbird und Apple-Geräte.
- **Desktop-Clients:** MAPI over HTTP für Mail (Online- und zwischengespeicherter Modus; Opt-in, [docs/mapi.md](docs/mapi.md)), Kalender und Kontakte über CalDAV/CardDAV.
- **Telefone:** ActiveSync synchronisiert Mail, Kalender, Kontakte, Aufgaben und Notizen in beide Richtungen (iOS, Android).
- **Webmail:** Mail, Kalender mit Serienterminen, Kontakte und Kontaktlisten, Aufgaben mit Nachverfolgungs-Flags, Notizen, freigegebene Postfächer, Ordnerberechtigungen, Regeln, Abwesenheitsnotiz, Suche.
- **Mail-Sicherheit:** SPF, DKIM (Signieren und Prüfen), DMARC, ARC, DNSBL, Greylisting, Anhangfilter, Quarantäne; rspamd-Spambewertung und ClamAV-Virenscan als optionale Container.
- **Anmeldung:** Zwei-Faktor-Authentifizierung (TOTP, WebAuthn, Backup-Codes), App-Passwörter für Mail-Apps, SSO über OIDC, LDAP / Active Directory, Sperre bei Brute-Force-Versuchen.
- **Zertifikate:** Let's Encrypt eingebaut, mit automatischer Verlängerung und eingebautem HTTPS-Proxy.
- **Sicherungen:** verschlüsselte Postfach- und Datenbanksicherungen mit Wiederherstellung im Admin-Panel.
- **Verwaltung:** Admin-Rollen, die sich auf Domains beschränken lassen, Audit-Log, Nachrichtenablaufverfolgung, Warteschlangen, Protokollschalter pro Domain und Postfach, Admin-CLI `coremail`.
- **Betrieb:** eigenes Branding (Name, Farben, Logo), Docker-Compose-Varianten von minimal bis voll, Helm-Chart für Kubernetes.

## Schnellstart

Du brauchst Docker 24 oder neuer mit Docker Compose 2.20 oder neuer. Alle Varianten nutzen das Image `magpeek/coremail-app`. Die Mails liegen auf dem Volume `coremail-data`, die Datenbank auf `pgdata` (Compose) bzw. `coremail-pgdata` (`docker run`).

### Minimal — Docker Compose

CoreMail, PostgreSQL und Redis ([docker-compose.minimal.yml](infra/docker/docker-compose.minimal.yml)). Ohne Spam- und Virenscanner; SPF, DKIM, DMARC, DNSBL und Greylisting laufen trotzdem. Passt für bis zu etwa 50 Benutzer mit 2 GB RAM.

```bash
git clone https://github.com/MAGPEEK/CoreMail.git
cd CoreMail
bash scripts/setup.sh --variant minimal      # schreibt .env mit zufälligen Schlüsseln
docker compose -f infra/docker/docker-compose.minimal.yml up -d
```

Ohne `setup.sh` legst du `infra/docker/.env` mit den vier Pflichtwerten selbst an:

```bash
cat > infra/docker/.env <<EOF
JWT_SECRET=$(openssl rand -hex 32)
PEPPER=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 20)
REDIS_PASSWORD=$(openssl rand -hex 20)
EOF
```

Bewahre eine Kopie dieser Datei auf. `PEPPER` darf sich nie ändern, sonst funktioniert kein Passwort mehr.

### Minimal — reines `docker run`

Derselbe Stack ohne Compose und ohne das Repository zu klonen. Die Schlüssel landen in `coremail.env`; bewahre die Datei auf.

```bash
umask 077
PG_PASS=$(openssl rand -hex 20); REDIS_PASS=$(openssl rand -hex 20)
cat > coremail.env <<EOF
JWT_SECRET=$(openssl rand -hex 32)
PEPPER=$(openssl rand -hex 32)
DATABASE_URL=postgresql://coremail:$PG_PASS@coremail-postgres:5432/coremail
REDIS_URL=redis://:$REDIS_PASS@coremail-redis:6379
OBJECT_STORAGE=filesystem
RSPAMD_ENABLED=false
CLAMAV_ENABLED=false
SECURITY_FILTER_URL=http://localhost:3002
EOF

docker network create coremail

docker run -d --name coremail-postgres --network coremail --restart unless-stopped \
  -e POSTGRES_DB=coremail -e POSTGRES_USER=coremail -e POSTGRES_PASSWORD="$PG_PASS" \
  -v coremail-pgdata:/var/lib/postgresql/data \
  postgres:16-alpine

docker run -d --name coremail-redis --network coremail --restart unless-stopped \
  -v coremail-redisdata:/data \
  redis:7-alpine redis-server --appendonly yes --requirepass "$REDIS_PASS"

docker run -d --name coremail --network coremail --restart unless-stopped \
  --env-file coremail.env \
  -p 25:25 -p 465:465 -p 587:587 -p 143:143 -p 993:993 \
  -p 80:3000 -p 443:443 -p 3000:3000 \
  -v coremail-data:/data \
  --security-opt no-new-privileges:true \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add NET_BIND_SERVICE \
  --sysctl net.ipv4.ip_unprivileged_port_start=0 \
  magpeek/coremail-app:10.3.0
```

Für POP3 ergänzt du `-p 110:110 -p 995:995`.

### Maximal — Docker Compose

[docker-compose.full.yml](infra/docker/docker-compose.full.yml) ergänzt rspamd (Spambewertung, Bayes-Lernen) und ClamAV (Virenscan), Ressourcenlimits und Log-Rotation für jeden Container sowie optionale Profile: `minio` (mitgeliefertes S3, auch Standardziel der Sicherungen), `backup` (täglicher `pg_dump`) und `geoip` (Datenbank für den Länderfilter). Plane 4 GB RAM ein; ClamAV allein braucht etwa 1 GB.

```bash
git clone https://github.com/MAGPEEK/CoreMail.git
cd CoreMail
bash scripts/setup.sh --variant full         # setzt zusätzlich RSPAMD_CONTROLLER_PASSWORD und OBJECT_STORAGE
docker compose -f infra/docker/docker-compose.full.yml up -d
# mit Profilen:
docker compose -f infra/docker/docker-compose.full.yml --profile minio --profile backup up -d
```

Neben den vier Werten oben sind in der `.env` Pflicht: `RSPAMD_CONTROLLER_PASSWORD` und `OBJECT_STORAGE` (`filesystem`, `minio` oder `s3`); mit dem Profil `minio` zusätzlich `MINIO_ROOT_PASSWORD`. Den Vergleich aller drei Varianten findest du in [docs/docker-compose.md](docs/docker-compose.md).

### Maximal — reines `docker run`

<details>
<summary>rspamd und ClamAV neben dem minimalen Stack</summary>

Starte den minimalen `docker run`-Stack von oben, aber ohne den letzten Befehl (`coremail`). rspamd vertraut nur der Adresse des CoreMail-Containers, deshalb bekommen beide feste Adressen in einem kleinen eigenen Netz. Die rspamd-Konfiguration kommt aus dem Repository (`infra/docker/rspamd/local.d`).

```bash
git clone https://github.com/MAGPEEK/CoreMail.git
RSPAMD_PASS=$(openssl rand -hex 20)
grep -v -e '^RSPAMD_ENABLED=' -e '^CLAMAV_ENABLED=' coremail.env > coremail.env.new && mv coremail.env.new coremail.env
cat >> coremail.env <<EOF
RSPAMD_URL=http://10.253.253.3:11334
CLAMAV_HOST=coremail-clamav
CLAMAV_PORT=3310
EOF

docker network create --subnet 10.253.253.0/29 coremail-rspamd

docker run -d --name coremail-rspamd --network coremail-rspamd --ip 10.253.253.3 --restart unless-stopped \
  -e RSPAMD_CONTROLLER_SECURE_IP=10.253.253.2 -e RSPAMD_CONTROLLER_PASSWORD="$RSPAMD_PASS" \
  -v "$PWD/CoreMail/infra/docker/rspamd/local.d:/etc/rspamd/local.d:ro" \
  -v coremail-rspamd-data:/var/lib/rspamd \
  rspamd/rspamd:4.0.0

docker run -d --name coremail-clamav --network coremail --restart unless-stopped \
  -v coremail-clamav-data:/var/lib/clamav \
  clamav/clamav:stable

docker create --name coremail --network coremail --restart unless-stopped \
  --env-file coremail.env \
  -p 25:25 -p 465:465 -p 587:587 -p 143:143 -p 993:993 \
  -p 80:3000 -p 443:443 -p 3000:3000 \
  -v coremail-data:/data \
  --security-opt no-new-privileges:true \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add NET_BIND_SERVICE \
  --sysctl net.ipv4.ip_unprivileged_port_start=0 \
  magpeek/coremail-app:10.3.0
docker network connect --ip 10.253.253.2 coremail-rspamd coremail
docker start coremail
```

ClamAV lädt beim ersten Start etwa 300 MB Signaturen; der Virenscan beginnt danach. MinIO, den `pg_dump`-Begleiter und GeoIP findest du als Profile in [docker-compose.full.yml](infra/docker/docker-compose.full.yml).

</details>

### Erste Anmeldung

1. Warte etwa eine Minute, bis der Container gesund ist (`docker ps` zeigt `healthy`).
2. Lies das einmalige Setup-Token aus: `docker logs coremail 2>&1 | grep -i "setup token"`
3. Öffne `http://<server-ip>:3000/bcp/` und gib das Token, deine Mail-Domain, die erste Admin-Adresse und ein Passwort ein.
4. Stelle im Admin-Panel unter **Zertifikate** ein Let's-Encrypt-Zertifikat aus und lege die Postfächer an. Das Webmail erreichst du unter `https://<dein-host>/`, das Admin-Panel unter `https://<dein-host>/bcp/`.

| Port | Zweck |
|------|-------|
| 80 → 3000 | HTTP: Let's Encrypt und Weiterleitung auf HTTPS |
| 443 | HTTPS: Webmail, Admin-Panel, ActiveSync, MAPI, CalDAV/CardDAV, JMAP |
| 3000 | HTTP ohne TLS: Ersteinrichtung oder hinter deinem eigenen Reverse Proxy |
| 25 | SMTP von anderen Mailservern |
| 465 / 587 | SMTP-Versand für Mail-Apps (implizites TLS / STARTTLS) |
| 993 / 143 | IMAP (implizites TLS / STARTTLS) |
| 995 / 110 | POP3, optional (implizites TLS / STLS) |

**DNS:** Richte einen A-Record und den MX-Record auf den Server und ergänze SPF, DKIM und DMARC; das Admin-Panel zeigt die genauen Einträge pro Domain unter **Domains** und prüft sie live.

## Aktualisieren

```bash
docker compose -f infra/docker/docker-compose.minimal.yml pull && docker compose -f infra/docker/docker-compose.minimal.yml up -d
```

Mit `docker run` ziehst du das neue Tag, entfernst den Container `coremail` und startest ihn mit demselben Befehl neu. Lies vor einem Major-Upgrade die [Release-Notes](docs/releases/); das Datenbankschema wird beim Start aktualisiert.

## Dokumentation

- [Docker-Compose-Varianten, Speicher und Sicherungen](docs/docker-compose.md)
- [Docker-Betrieb](docs/deployment-docker.md) und [Sicherheitshärtung](docs/deployment-security.md)
- [Client-Einrichtung](docs/clients.md): Desktop-Clients ([MAPI over HTTP](docs/mapi.md)), Telefone ([ActiveSync](docs/activesync.md)), Thunderbird und Apple
- [Zertifikate und Let's Encrypt](docs/certificates.md)
- [Sicherung und Wiederherstellung](docs/backup.md)
- [Admin-Rollen](docs/rbac.md), [Branding](docs/branding.md), [Admin-CLI](docs/cli.md)
- [Kubernetes-Helm-Chart](infra/k8s/README.md)
- [Versionshistorie](docs/version-history.de.md) und [Changelog](CHANGELOG.md)
- Alle Dokumente (englisch): [docs/](docs/)

## Support

Einen Fehler gefunden oder fehlt dir eine Funktion? Eröffne ein Issue auf [GitHub](https://github.com/MAGPEEK/CoreMail/issues).

## Lizenz

MIT — siehe [LICENSE](LICENSE).
