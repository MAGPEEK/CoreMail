# Backup and restore

CoreMail has two layers of backup. Use both:

| Layer | What | Where | Restore |
|---|---|---|---|
| **Built-in backups** (backup-service, BCP → Backup & Restore) | Mailboxes (original messages with attachments, folders, flags; contacts/calendar files) and the database (`pg_dump`) | Bucket `coremail-backups` (bundled MinIO or `S3_*`), AES-256-GCM encrypted | Mailboxes: BCP → Wiederherstellen. Database: `pg_restore` (below) |
| **Volume / infrastructure backup** (you) | The mail object store (`coremail-data` volume or S3 bucket), the `.env` file with all secrets, optionally an off-site copy of the backup bucket | wherever your backup tool writes | [docker-compose.md → Backup and restore](docker-compose.md#backup-and-restore), [storage.md](storage.md#backup-and-restore) |

Nothing in the first layer copies the `.env` secrets. Keep `BACKUP_ENCRYPTION_KEY` (and
`JWT_SECRET`, `PEPPER`, `MFA_ENCRYPTION_KEY`, the database password) **off the server** — without
`BACKUP_ENCRYPTION_KEY` the encrypted backups cannot be read, and without `MFA_ENCRYPTION_KEY` (or
`JWT_SECRET` + `PEPPER` when it is not set) a restored database has unreadable 2FA secrets and
certificate private keys ([certificates.md](certificates.md#private-keys-at-rest)).

## 1. Automation (schedules)

Nothing is backed up automatically until a schedule exists. **BCP → Backup & Restore →
Zeitpläne → „Empfohlene Sicherung einrichten"** creates (only what is missing, never silently):

| Schedule | Scope | Default time (UTC) | Retention |
|---|---|---|---|
| Empfohlen: Tägliche System-Sicherung (Datenbank) | `system` | 30 minutes before the full backup (01:30) | `BACKUP_RETENTION_DAYS` (compose default 30, else 14) |
| Empfohlen: Tägliches Vollbackup aller Postfächer | `full` | `BACKUP_SCHEDULE` (default `0 2 * * *`) | same |

`BACKUP_SCHEDULE` and `BACKUP_RETENTION_DAYS` are only the defaults of this button (before 9.3
they were documented as "daily full backup" but nothing read them). The Zeitpläne tab shows what
the configured schedules cover and what they do not. The page warns when no enabled full backup
schedule exists; the backup-service logs the same warning at start.

Scopes: `full` (one encrypted ZIP per active user), `user` (one mailbox, ZIP or MBOX), `system`
(database dump + object-store manifest). Schedules run once per cron fire across all instances
(Redis lock). `retentionDays` removes the schedule's own backups older than that after each
successful run (manual backups are never removed automatically; the newest archive of every
mailbox is always kept).

**Status and notification:** `lastStatus` is the status of the finished job — `COMPLETED`,
`PARTIAL` (some mailboxes of a full backup failed), `FAILED`. When a scheduled run ends `PARTIAL`
or `FAILED`, every active ORGANIZATION_MANAGEMENT / SERVER_MANAGEMENT admin gets a notice in the
INBOX (internal notification, no SMTP; at most once per schedule every 6 hours).

**Watchdog:** running jobs write a heartbeat every minute (`progressMeta.heartbeatAt`); a job
without heartbeat for 15 minutes is marked `FAILED`. Jobs of the restarted host are marked
`FAILED` at start-up. (Before 9.3 every job still running after 30 minutes was failed.)

## 2. Mailbox backups

- **ZIP** (`mail/<folder>/<uid>.eml` = the original raw message, `contacts/*.vcf`,
  `calendar/<name>/*.ics`, and since 9.3 `coremail-manifest.json` with the exact folder name and
  the flags of every message).
- **MBOX** (mboxrd, original messages of all folders; no folders, no flags).
- Object keys: `mailbox/<userId>/<epochMs>.zip|mbox.enc`, full backups
  `full-backup/<day>/<runId>/<email>.zip.enc`.
- Download in the BCP (decrypted on the fly) or offline:
  `BACKUP_ENCRYPTION_KEY=<64 hex> node scripts/decrypt-backup.mjs in.zip.enc out.zip`.

## 3. Restore (BCP → Backup & Restore → Wiederherstellen)

Two ways, both run as a job (scope `restore`, progress and result under „Jobs"):

1. **Aus dem Backup-Archiv** — pick a stored archive (single-mailbox backups and the per-user
   parts of full backups; also the ↺ button in the Jobs and Backup-Archiv tabs). The target is
   the original mailbox by default, or any other mailbox. Encrypted archives are decrypted with
   the configured key; a missing or different key is reported before anything is written
   („Das Backup wurde mit einem anderen Schlüssel verschlüsselt (Schlüssel-ID …)").
2. **Datei hochladen** — a downloaded CoreMail backup (ZIP or MBOX, also `.zip.enc` /
   `.mbox.enc`) or any MBOX file (Thunderbird, another server). Max. `BACKUP_IMPORT_MAX_BYTES`
   (500 MiB). The format is detected from the content.

Target modes:

| Mode | Where the messages go |
|---|---|
| `subfolder` (default) | `Wiederhergestellt <YYYY-MM-DD>` (date of the backup) with the original folder structure below it — nothing is mixed into the live folders |
| `original` | the original folders (created when missing); messages already there are skipped |
| `folder` | everything into one chosen folder of the target mailbox |

Rules:

- Every message is stored with its **original raw octets** and created through the message
  store (UID/modSeq), attachments are indexed as on delivery.
- **Idempotent:** a message is skipped when the target folder already holds a non-deleted message
  with the same content (content-addressed raw object) or the same Message-ID and size. Running
  the same restore again restores nothing twice (`duplicates` in the job result).
- Flags from the ZIP manifest are restored except `\Deleted` and `\Recent`; archives without
  flag information (MBOX, ZIPs from before 9.3) restore as `\Seen`.
- One restore per target mailbox at a time (409 otherwise).
- Contacts and calendar files of ZIP backups are **not** restored (counted as
  „Kontakt-/Kalenderdateien nicht übernommen") — import them in a client.
- Restored messages get the restore time as received time (retention policies count from it).
- Limits: `BACKUP_RESTORE_MAX_BYTES` (decrypted archive, default 20 GiB — the container's temp
  directory needs that much space), `BACKUP_RESTORE_MAX_MESSAGE_BYTES` (default 150 MiB per message).
- MBOX cannot represent a message without a final line break; such messages come back with CRLF
  appended (messages received over SMTP/IMAP always end with one).

API: `POST /api/v1/admin/backups/restore` `{ jobId | key, targetUserId?, mode, folderId? }` →
202 `{ jobId, targetFolder }`; `POST /api/v1/admin/backups/import/:userId?mode=subfolder|original|folder&folderId=`
(raw body) → 202 `{ jobId, format, encrypted }`. Audit action `backup.restore`. Rights:
ORGANIZATION_MANAGEMENT and COMPLIANCE_MANAGEMENT (mailbox content).

## 4. System backup (database)

Scope `system` writes, encrypted, to `system/<day>/<jobId>/`:

- `coremail-db.dump.enc` — `pg_dump --format=custom` of the CoreMail database: users, password
  hashes, settings, certificates and their private keys, DKIM keys, rules, calendars, contacts,
  mail metadata. Connection data come from `DATABASE_URL` (as PG* environment variables, never on
  the command line). The app image ships `pg_dump` 16 — a newer PostgreSQL server cannot be
  dumped with it (the job fails with the pg_dump message).
- `objects-manifest.tsv.enc` — key and size of every object in the mail object store at that
  time, to verify a restored `coremail-data` volume / bucket.

Download (decrypted): BCP → Jobs, **ORGANIZATION_MANAGEMENT only** (also not COMPLIANCE_MANAGEMENT:
the dump contains private keys and password hashes).

**Full server recovery** (new host):

1. Restore `.env` (all secrets, especially `BACKUP_ENCRYPTION_KEY`, `JWT_SECRET`, `PEPPER`).
2. Restore the object store (`coremail-data` volume or S3 bucket) from your volume backup.
3. Start only PostgreSQL, restore the dump:
   `docker exec -i coremail-postgres pg_restore -U coremail -d coremail --clean --if-exists < coremail-db.dump`
   (download the dump decrypted from the BCP of a running instance, or
   `node scripts/decrypt-backup.mjs coremail-db.dump.enc coremail-db.dump` with the key).
4. Start CoreMail; `coremail storage check` must report no missing objects (compare with
   `objects-manifest.tsv`).

If only mailboxes are lost, a restore from the mailbox backups (section 3) is enough.

## 5. What is not covered by the built-in backups

| Not covered | Do this |
|---|---|
| The object store as a whole (needed with the database dump for a full recovery) | Volume backup of `coremail-data` / bucket replication — [docker-compose.md](docker-compose.md#backup-and-restore) |
| `.env` secrets | Copy to a password manager / safe off the server |
| An off-site copy of the backups | With bundled MinIO the bucket is on the same host: copy `miniodata` off-site or use an external `S3_ENDPOINT` |
| Redis (sessions, greylisting, outbound queue) | Optional, see docker-compose.md |

## 6. Tests

- `packages/backup-service`: `restore/restore-roundtrip.test.ts` (export → encrypt → restore into an
  empty mailbox, byte-exact, folders, flags, attachments, second run deduplicated),
  `restore/readers.test.ts` (ZIP/ZIP64/CRC, mboxrd), `restore/source.test.ts`,
  `scheduler/automation.test.ts`.
- e2e step `backup` (docs/e2e.md): mailbox backup of B → restore of the stored archive into A →
  IMAP sees the messages byte-exact with flags, re-run and upload add nothing, recommended schedules,
  system backup run-now (`PGDMP`).
