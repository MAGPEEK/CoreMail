# CoreMail — Command Reference

Quick reference for operating the CoreMail stack from the command line.  
All `curl` commands assume a running stack and require an admin token.

---

## Contents

1. [Containers & services](#1-containers--services)
2. [Get an admin token](#2-get-an-admin-token)
3. [Manage users](#3-manage-users)
4. [Manage domains](#4-manage-domains)
5. [Queues (SMTP queue)](#5-queues-smtp-queue)
6. [Logs & diagnostics](#6-logs--diagnostics)
7. [Message trace](#7-message-trace)
8. [Query the database directly](#8-query-the-database-directly)
9. [Query Redis](#9-query-redis)
10. [Test SMTP](#10-test-smtp)
11. [Backup & restore](#11-backup--restore)
12. [Updates](#12-updates)

---

## 1. Containers & services

### Stack status

```bash
# All containers and their health status
docker compose ps

# Live resource usage (CPU, RAM, network)
docker stats

# CoreMail container only
docker stats coremail
```

### Health check

```bash
# Returns {"ok":true} when the stack is ready
curl -s http://localhost:3000/healthz | jq
```

### Check all internal services (supervisord)

```bash
# Status of all processes in the container
docker exec coremail supervisorctl status
```

Expected output:
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

### Restart a single service

```bash
docker exec coremail supervisorctl restart smtp-server
docker exec coremail supervisorctl restart imap-server
docker exec coremail supervisorctl restart api-gateway
docker exec coremail supervisorctl restart ews-server
```

### Restart all services (container keeps running)

```bash
docker exec coremail supervisorctl restart all
```

---

## 2. Get an admin token

All API commands require a JWT token. Store it once, then use it for all further commands:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@mydomain.com","password":"my-password"}' \
  | jq -r '.accessToken')

echo $TOKEN
```

> Set the token as the shell variable `$TOKEN` — all commands below use this variable.

---

## 3. Manage users

### List all users

```bash
curl -s http://localhost:3000/api/v1/admin/mailboxes \
  -H "Authorization: Bearer $TOKEN" | jq '.users[] | {email, displayName, role, usedBytes}'
```

### Find a specific user

```bash
curl -s "http://localhost:3000/api/v1/admin/mailboxes?search=john.doe" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Create a new user

```bash
curl -s -X POST http://localhost:3000/api/v1/admin/mailboxes \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john.doe@mydomain.com",
    "displayName": "John Doe",
    "password": "secure-password",
    "quotaBytes": 10737418240
  }' | jq
```

> `quotaBytes`: 1 GB = 1073741824, 5 GB = 5368709120, 10 GB = 10737418240

### Change a user's password

```bash
# Look up the user ID first
USER_ID=$(curl -s "http://localhost:3000/api/v1/admin/mailboxes?search=john.doe" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.users[0].id')

curl -s -X PUT "http://localhost:3000/api/v1/admin/mailboxes/$USER_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"password": "new-password"}' | jq
```

### Change a user's quota

```bash
curl -s -X PUT "http://localhost:3000/api/v1/admin/mailboxes/$USER_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"quotaBytes": 21474836480}' | jq   # 20 GB
```

### Change a user's role

```bash
# Available roles:
# USER | HELP_DESK | RECIPIENT_MANAGEMENT | COMPLIANCE_MANAGEMENT
# HYGIENE_MANAGEMENT | SERVER_MANAGEMENT | VIEW_ONLY_ORG | ORGANIZATION_MANAGEMENT

curl -s -X PUT "http://localhost:3000/api/v1/admin/mailboxes/$USER_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role": "ORGANIZATION_MANAGEMENT"}' | jq
```

### Delete a user

```bash
curl -s -X DELETE "http://localhost:3000/api/v1/admin/mailboxes/$USER_ID" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Provision a mailbox manually (create folders)

```bash
curl -s -X POST "http://localhost:3000/api/v1/admin/mailboxes/$USER_ID/provision" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Recalculate the quota of all users

```bash
curl -s -X POST http://localhost:3000/api/v1/admin/mailboxes/recalculate-all-quotas \
  -H "Authorization: Bearer $TOKEN" | jq
```

---

## 4. Manage domains

### List all domains

```bash
curl -s http://localhost:3000/api/v1/admin/domains \
  -H "Authorization: Bearer $TOKEN" | jq '.[] | {name, primary, active}'
```

### Add a new domain

```bash
curl -s -X POST http://localhost:3000/api/v1/admin/domains \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "newdomain.com"}' | jq
```

### Get the DKIM record (for the DNS entry)

```bash
DOMAIN_ID=$(curl -s http://localhost:3000/api/v1/admin/domains \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')

curl -s "http://localhost:3000/api/v1/admin/domains/$DOMAIN_ID/dkim-record" \
  -H "Authorization: Bearer $TOKEN" | jq
```

---

## 5. Queues (SMTP queue)

The SMTP queue uses **BullMQ v5**. Queue name: `smtp-outbound` (no colon — BullMQ v5 forbids colons in queue names).

### Queue overview (count per state)

```bash
curl -s http://localhost:3000/api/v1/admin/queues \
  -H "Authorization: Bearer $TOKEN" | jq '.[] | {name, count}'
```

### Show messages in the outbound queue

```bash
# Outbound queue (active jobs)
curl -s "http://localhost:3000/api/v1/admin/queues/smtp-outbound/jobs?limit=20" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.jobs[] | {index, from: .data.envelope.from, to: .data.envelope.to, subject: .data.subject}'

# Failed jobs (dead letter)
curl -s "http://localhost:3000/api/v1/admin/queues/smtp-outbound/jobs?state=failed&limit=20" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Delete a single message from the queue

```bash
# Take the index from the job list
curl -s -X DELETE "http://localhost:3000/api/v1/admin/queues/smtp-outbound/jobs/0" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Flush the queue (delete all failed messages)

```bash
curl -s -X POST "http://localhost:3000/api/v1/admin/queues/smtp-outbound/flush" \
  -H "Authorization: Bearer $TOKEN" | jq
```

---

## 6. Logs & diagnostics

### Container logs (all services)

```bash
# Live stream
docker logs -f coremail

# Last 100 lines
docker logs --tail 100 coremail

# Error messages only
docker logs coremail 2>&1 | grep -i "error\|fatal\|ERR"
```

### Logs of a specific service

```bash
# supervisord forwards all logs to stdout
docker exec coremail supervisorctl tail -f smtp-server
docker exec coremail supervisorctl tail -f imap-server
docker exec coremail supervisorctl tail -f api-gateway
```

### Check network connections in the container

```bash
# Which ports are listening?
docker exec coremail ss -tlnp

# Active SMTP connections
docker exec coremail ss -tnp | grep :25
```

### Audit log of the latest admin actions

```bash
curl -s "http://localhost:3000/api/v1/admin/audit-log?limit=20" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.entries[] | {timestamp, actorEmail, action, targetName, success}'
```

### Dashboard statistics

```bash
curl -s http://localhost:3000/api/v1/admin/dashboard \
  -H "Authorization: Bearer $TOKEN" | jq
```

---

## 7. Message trace

The message trace logs the complete path of every email through the CoreMail stack — from SMTP acceptance through spam/virus filtering to delivery or rejection.

### Search messages

```bash
# All filters are optional — combine as needed

# Filter by sender
curl -s "http://localhost:3000/api/v1/admin/message-trace?sender=sender@domain.com" \
  -H "Authorization: Bearer $TOKEN" | jq

# Filter by recipient
curl -s "http://localhost:3000/api/v1/admin/message-trace?recipient=recipient@domain.com" \
  -H "Authorization: Bearer $TOKEN" | jq

# Filter by status (DELIVERED | REJECTED | SPAM | QUARANTINED | FAILED | DEFERRED)
curl -s "http://localhost:3000/api/v1/admin/message-trace?status=REJECTED" \
  -H "Authorization: Bearer $TOKEN" | jq

# Narrow down the time range (ISO 8601)
curl -s "http://localhost:3000/api/v1/admin/message-trace?from=2026-05-01T00:00:00Z&to=2026-05-20T23:59:59Z" \
  -H "Authorization: Bearer $TOKEN" | jq

# Combination: sender + status + time range
curl -s "http://localhost:3000/api/v1/admin/message-trace?sender=sender@domain.com&status=DELIVERED&from=2026-05-01T00:00:00Z" \
  -H "Authorization: Bearer $TOKEN" | jq '.messages[] | {timestamp, sender, recipient, subject, status, reason}'
```

### Available filter parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `sender` | Sender address (exact or partial match) | `sender=user@domain.com` |
| `recipient` | Recipient address | `recipient=user@domain.com` |
| `status` | Delivery status | `status=DELIVERED` |
| `from` | Time range from (ISO 8601) | `from=2026-05-01T00:00:00Z` |
| `to` | Time range to (ISO 8601) | `to=2026-05-31T23:59:59Z` |
| `limit` | Maximum number of hits | `limit=100` |
| `offset` | Pagination | `offset=100` |

### CSV export

```bash
# Full export (all fields) as a CSV file
curl -s "http://localhost:3000/api/v1/admin/message-trace/export?sender=sender@domain.com" \
  -H "Authorization: Bearer $TOKEN" \
  -o "message-trace-$(date +%Y%m%d).csv"

# Export with a time range
curl -s "http://localhost:3000/api/v1/admin/message-trace/export?from=2026-05-01T00:00:00Z&to=2026-05-31T23:59:59Z" \
  -H "Authorization: Bearer $TOKEN" \
  -o "message-trace-may-2026.csv"
```

---

## 8. Query the database directly

```bash
# Open a PostgreSQL shell
docker exec -it coremail-postgres psql -U coremail -d coremail

# Or run a single command
docker exec coremail-postgres psql -U coremail -d coremail -c "<SQL>"
```

### Useful SQL queries

```bash
# All users with quota usage
docker exec coremail-postgres psql -U coremail -d coremail -c \
  "SELECT email, display_name, role, used_bytes/1024/1024 AS used_mb, quota_bytes/1024/1024 AS quota_mb FROM users ORDER BY used_bytes DESC;"

# Number of mails per user
docker exec coremail-postgres psql -U coremail -d coremail -c \
  "SELECT u.email, COUNT(m.id) AS mails FROM users u LEFT JOIN mailboxes mb ON mb.user_id = u.id LEFT JOIN folders f ON f.mailbox_id = mb.id LEFT JOIN messages m ON m.folder_id = f.id GROUP BY u.email ORDER BY mails DESC;"

# Largest attachments
docker exec coremail-postgres psql -U coremail -d coremail -c \
  "SELECT filename, size/1024 AS size_kb, mime_type FROM attachments ORDER BY size DESC LIMIT 20;"

# All domains
docker exec coremail-postgres psql -U coremail -d coremail -c \
  "SELECT name, is_primary, active, created_at FROM domains;"

# Last 20 audit log entries
docker exec coremail-postgres psql -U coremail -d coremail -c \
  "SELECT created_at, actor_email, action, target_name, success FROM audit_logs ORDER BY created_at DESC LIMIT 20;"
```

---

## 9. Query Redis

```bash
# Open the Redis CLI (password from .env)
docker exec -it coremail-redis redis-cli -a "${REDIS_PASSWORD}"

# Or run a single command
docker exec coremail-redis redis-cli -a "${REDIS_PASSWORD}" <COMMAND>
```

### Useful Redis commands

```bash
# BullMQ queue lengths (queue name: smtp-outbound)
# BullMQ v5 stores jobs under: bull:{queuename}:*
docker exec coremail-redis redis-cli -a "${REDIS_PASSWORD}" \
  KEYS "bull:smtp-outbound:*" | wc -l

# Count waiting jobs
docker exec coremail-redis redis-cli -a "${REDIS_PASSWORD}" \
  LLEN "bull:smtp-outbound:wait"

# Count failed jobs
docker exec coremail-redis redis-cli -a "${REDIS_PASSWORD}" \
  ZCARD "bull:smtp-outbound:failed"

# Count active sessions
docker exec coremail-redis redis-cli -a "${REDIS_PASSWORD}" KEYS "session:*" | wc -l

# Count greylisting entries
docker exec coremail-redis redis-cli -a "${REDIS_PASSWORD}" KEYS "grey:*" | wc -l

# Show the greylisting whitelist
docker exec coremail-redis redis-cli -a "${REDIS_PASSWORD}" KEYS "grey:white:*"

# Redis memory usage
docker exec coremail-redis redis-cli -a "${REDIS_PASSWORD}" INFO memory | grep used_memory_human
```

---

## 10. Test SMTP

### Simple connection test (without tools)

```bash
# Tests whether port 25 responds
docker exec coremail nc -z localhost 25 && echo "SMTP port 25: OK" || echo "SMTP port 25: FAILED"
docker exec coremail nc -z localhost 587 && echo "SMTP port 587: OK" || echo "SMTP port 587: FAILED"
docker exec coremail nc -z localhost 993 && echo "IMAP port 993: OK" || echo "IMAP port 993: FAILED"
```

### Test the SMTP handshake manually

```bash
# Connect to port 587 (submission)
docker exec -it coremail openssl s_client -connect localhost:587 -starttls smtp
```

### Send a test mail (with swaks — outside the container)

```bash
# Install swaks: brew install swaks (macOS) or apt install swaks (Linux)
swaks \
  --to   recipient@external-domain.com \
  --from sender@mydomain.com \
  --server localhost \
  --port 587 \
  --tls \
  --auth-user sender@mydomain.com \
  --auth-password "password" \
  --header "Subject: Test mail from CoreMail" \
  --body "This test was delivered successfully."
```

### Check DKIM signing (sent mail)

```bash
# Checks whether outbound mails are signed correctly
docker exec coremail-postgres psql -U coremail -d coremail -c \
  "SELECT dkim_selector, LEFT(dkim_private_key, 40) AS key_preview FROM domains WHERE is_primary = true;"
```

---

## 11. Backup & restore

### Create a database backup manually

```bash
# PostgreSQL dump
docker exec coremail-postgres pg_dump -U coremail coremail | gzip \
  > coremail-db-$(date +%Y%m%d-%H%M).sql.gz

echo "Backup created: coremail-db-$(date +%Y%m%d-%H%M).sql.gz"
```

### Restore a database backup

```bash
# Stop the stack, restore the data, restart the stack
docker compose down

gunzip -c coremail-db-20260516-0200.sql.gz \
  | docker exec -i coremail-postgres psql -U coremail -d coremail

docker compose up -d
```

### List MinIO contents (attachments)

```bash
# Install the MinIO client (mc): https://min.io/docs/minio/linux/reference/minio-mc.html
mc alias set coremail http://localhost:9000 minioadmin "${MINIO_ROOT_PASSWORD}"
mc ls coremail/mail-attachments
mc du coremail/mail-attachments
```

### Trigger an admin backup via the API

```bash
curl -s -X POST http://localhost:3000/api/v1/admin/backup/trigger \
  -H "Authorization: Bearer $TOKEN" | jq
```

---

## 12. Updates

### Update to a new version

```bash
# 1. Pull new images
docker compose pull

# 2. Restart the stack (downtime < 30 seconds)
docker compose up -d

# 3. Check versions
docker images | grep magpeek
docker compose ps
curl -s http://localhost:3000/healthz | jq
```

### Deploy a specific version

```bash
# Adjust the image line in docker-compose.yml:
#   image: magpeek/coremail-app:3.17.8
# Then:
docker compose up -d --pull always
```

### Full reinstall (keep data)

```bash
# Remove old containers (volumes are kept!)
docker compose down

# Pull the latest images
docker compose pull

# Restart the stack
docker compose up -d
```

---

## Cheat sheet

```bash
# Start / stop the stack
docker compose up -d
docker compose down

# Health check
curl -s http://localhost:3000/healthz | jq

# Services in the container
docker exec coremail supervisorctl status

# Live logs
docker logs -f coremail

# Admin token
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ADMIN@DOMAIN","password":"PASSWORD"}' | jq -r '.accessToken')

# Create a user
curl -s -X POST http://localhost:3000/api/v1/admin/mailboxes \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"email":"user@domain.com","displayName":"Name","password":"pw","quotaBytes":5368709120}' | jq

# Queue status
curl -s http://localhost:3000/api/v1/admin/queues -H "Authorization: Bearer $TOKEN" | jq

# Message trace
curl -s "http://localhost:3000/api/v1/admin/message-trace?sender=user@domain.com&status=REJECTED" \
  -H "Authorization: Bearer $TOKEN" | jq '.messages[] | {timestamp, recipient, subject, reason}'

# Database shell
docker exec -it coremail-postgres psql -U coremail -d coremail

# BullMQ queue length (smtp-outbound)
docker exec coremail-redis redis-cli -a "${REDIS_PASSWORD}" LLEN "bull:smtp-outbound:wait"

# Update
docker compose pull && docker compose up -d
```
