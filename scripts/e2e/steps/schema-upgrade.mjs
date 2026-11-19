// Step 15: schema upgrade from the 8.0.0, 9.4.0 and 9.5.x schemas with the image's coremail-schema-sync.
// Run with: node scripts/e2e/run.mjs schema-upgrade   (needs the e2e stack + git in the repo)
//
// Works on scratch databases in the e2e PostgreSQL (the CoreMail database is not
// touched). For each scenario the old schema (`git show <ref>:…`: E2E_SCHEMA_BASE,
// default d5ad681 = v8.0.0; E2E_SCHEMA_BASE_9_4, default 46ec9d80 = v9.4.0;
// E2E_SCHEMA_BASE_9_5, default af6bd185 = v9.5.1) is pushed with the image's
// Prisma CLI, rows are inserted with SQL, then coremail-schema-sync runs inside
// the app container against that database — exactly what the entrypoint / Helm
// init container do:
//  A  8.0.0 → current: tasks get the optional column uid with UNIQUE (userId, uid).
//     Prisma reports a data-loss warning, but only a unique constraint is added →
//     applied automatically (two tasks of one user do not stop it: the new column
//     is NULL; best-effort dump written). The empty room tables are dropped.
//  B  a new unique constraint over existing duplicates (9.5.x database whose
//     tasks_userId_uid_key went missing) → refused, nothing changed — not even the
//     retired room tables next to it.
//  C  a dropped column that holds data → still fail-closed next to the retired
//     room tables (refused, column, room rows and the room's mailbox kept); the
//     run with COREMAIL_ALLOW_SCHEMA_DATA_LOSS then removes the room's mailbox too.
//  D  9.4.0 → current: tasks UNIQUE (userId, uid) over the new optional column
//     uid is applied without a duplicate check, the tasks are kept.
//  E  10.0.0: 9.5.x → current with room rows: the retired room tables are dropped
//     WITHOUT COREMAIL_ALLOW_SCHEMA_DATA_LOSS, after the mandatory pre-migration
//     dump (which holds the room rows); the room's own owner-less mailbox row
//     with its folder, message and attachment is deleted after the dump (a
//     user's mailbox a room row points at, and other mailboxes, are kept);
//     tables and enum gone, other data kept.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, assert, CONTAINER, STATE_DIR } from '../lib.mjs';

const PG = process.env.E2E_PG_CONTAINER ?? 'coremail-e2e-postgres';
const PG_USER = process.env.E2E_PG_USER ?? 'coremail';
const BASE_REF = process.env.E2E_SCHEMA_BASE ?? 'd5ad681';
const BASE_REF_9_4 = process.env.E2E_SCHEMA_BASE_9_4 ?? '46ec9d80';
const BASE_REF_9_5 = process.env.E2E_SCHEMA_BASE_9_5 ?? 'af6bd185';
const PRISMA = 'node /app/packages/storage/node_modules/prisma/build/index.js';
const OLD_SCHEMA = '/tmp/e2e-schema-base.prisma';
const OLD_SCHEMA_9_4 = '/tmp/e2e-schema-base-9.4.prisma';
const OLD_SCHEMA_9_5 = '/tmp/e2e-schema-base-9.5.prisma';
const BACKUP_DIR = '/tmp/e2e-schema-backups';
const DBS = ['e2e_upgrade_a', 'e2e_upgrade_b', 'e2e_upgrade_c', 'e2e_upgrade_d', 'e2e_upgrade_e'];
const ROOM_TABLES = ['resource_mailboxes', 'resource_calendars', 'resource_bookings'];

function pgPassword() {
  const env = readFileSync(process.env.E2E_ENV_FILE ?? join(STATE_DIR, 'e2e.env'), 'utf8');
  const pw = env.match(/^POSTGRES_PASSWORD=(.*)$/m)?.[1]?.trim();
  assert(pw, 'POSTGRES_PASSWORD missing in the e2e env file');
  return pw;
}

/** psql as the PostgreSQL superuser inside the postgres container. */
function psql(db, sql) {
  return execFileSync('docker', ['exec', PG, 'psql', '-U', PG_USER, '-d', db, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** sh -c <script> in the app container; returns { code, out }. */
function inApp(script, env = {}) {
  const e = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const r = spawnSync('docker', ['exec', ...e, CONTAINER, 'sh', '-c', script], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const urlFor = (db) => `postgresql://${PG_USER}:${pgPassword()}@postgres:5432/${db}`;

function freshDb(db, schemaFile = OLD_SCHEMA) {
  psql('postgres', `DROP DATABASE IF EXISTS ${db}`);
  psql('postgres', `CREATE DATABASE ${db}`);
  const r = inApp(`cd /app/packages/storage && ${PRISMA} db push --skip-generate --schema ${schemaFile}`,
    { DATABASE_URL: urlFor(db), CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' });
  assert(r.code === 0, `old schema push (${schemaFile}) failed: ${r.out.slice(-400)}`);
}

/** Copies the schema.prisma of a git ref into the app container; returns it. */
function copySchema(ref, target) {
  const schema = execFileSync('git', ['show', `${ref}:packages/storage/prisma/schema.prisma`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  execFileSync('docker', ['exec', '-i', CONTAINER, 'sh', '-c', `cat > ${target}`], { input: schema });
  return schema;
}

/** Two tasks of one user (before 9.5 without uid; FK triggers skipped). */
function insertTasks(db) {
  psql(db, `SET session_replication_role = replica; INSERT INTO tasks(id,"userId",subject,"updatedAt") VALUES ('t1','user1','a',now()),('t2','user1','b',now())`);
}

/** 9.5.x: a room with its calendar and two bookings (FK triggers skipped — no domain row needed). */
function insertRoom(db) {
  psql(db, [
    'SET session_replication_role = replica;',
    `INSERT INTO resource_mailboxes(id,email,"displayName","domainId","delegateIds","updatedAt") VALUES ('r1','raum@e2e-upgrade.test','Raum 1','d1','{}',now());`,
    `INSERT INTO resource_calendars(id,"resourceId") VALUES ('rc1','r1');`,
    `INSERT INTO resource_bookings(id,"calendarId",uid,summary,organizer,"dtStart","dtEnd","icalData") VALUES
      ('b1','rc1','u1','Planung','alice@e2e-upgrade.test',now(),now(),''),('b2','rc1','u2','Jour fixe','bob@e2e-upgrade.test',now(),now(),'');`,
  ].join(' '));
}

/**
 * 10.0 lead decision: the room's own mailbox row (with a folder, a message and an
 * attachment) is deleted with the room. A second room points at a USER's mailbox
 * (drifted data) — that mailbox must survive; so must an unrelated owner-less one.
 */
function insertRoomMailboxes(db) {
  psql(db, [
    'SET session_replication_role = replica;',
    `INSERT INTO mailboxes(id) VALUES ('mb-room');`,
    `INSERT INTO mailboxes(id,"userId") VALUES ('mb-user','user1');`,
    `INSERT INTO mailboxes(id) VALUES ('mb-orphan');`,
    `INSERT INTO folders(id,"mailboxId",name,"displayName") VALUES ('f-room','mb-room','INBOX','Posteingang'),('f-user','mb-user','INBOX','Posteingang');`,
    `INSERT INTO messages(id,"folderId",uid,"modSeq",date) VALUES ('m-room','f-room',1,1,now()),('m-user','f-user',1,1,now());`,
    `INSERT INTO attachments(id,"messageId",filename,"mimeType",size,sha256,"storagePath") VALUES ('a-room','m-room','plan.pdf','application/pdf',1,'00','attachments/m-room/00');`,
    `UPDATE resource_mailboxes SET "mailboxId" = 'mb-room' WHERE id = 'r1';`,
    `INSERT INTO resource_mailboxes(id,email,"displayName","domainId","delegateIds","updatedAt","mailboxId") VALUES ('r2','beamer@e2e-upgrade.test','Beamer','d1','{}',now(),'mb-user');`,
  ].join(' '));
}

function schemaSync(db, env = {}) {
  return inApp('/usr/local/bin/coremail-schema-sync', {
    DATABASE_URL: urlFor(db), MAX_ATTEMPTS: '3', COREMAIL_SCHEMA_BACKUP_DIR: BACKUP_DIR,
    CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1', ...env,
  });
}

const indexes = (db, table) => psql(db, `SELECT indexname FROM pg_indexes WHERE tablename = '${table}' ORDER BY 1`).split('\n');
const tableCount = (db, tables) => Number(psql(db, `SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename IN (${tables.map((t) => `'${t}'`).join(',')})`));
const dumps = () => inApp(`ls ${BACKUP_DIR} 2>/dev/null`).out.trim().split('\n').filter((f) => /^pre-migrate-.*\.sql\.gz$/.test(f));

export async function run() {
  let ready = false;
  await check('schema-upgrade: 8.0.0, 9.4.0 and 9.5.x schemas available', async () => {
    copySchema(BASE_REF, OLD_SCHEMA);
    const schema94 = copySchema(BASE_REF_9_4, OLD_SCHEMA_9_4);
    assert(!/@@unique\(\[userId, uid\]\)/.test(schema94), `${BASE_REF_9_4} schema already has tasks UNIQUE (userId, uid)`);
    const schema95 = copySchema(BASE_REF_9_5, OLD_SCHEMA_9_5);
    assert(/model ResourceBooking\b/.test(schema95), `${BASE_REF_9_5} schema has no room tables`);
    const cur = inApp('grep -c "@@map(\\"resource_" /app/packages/storage/prisma/schema.prisma');
    assert(cur.out.trim() === '0', 'image schema still has room tables — rebuild the e2e image');
    inApp(`rm -rf ${BACKUP_DIR}`);
    ready = true;
    return `bases ${BASE_REF} + ${BASE_REF_9_4} + ${BASE_REF_9_5} copied into ${CONTAINER}`;
  });
  if (!ready) return;

  try {
    await check('schema-upgrade: 8.0.0 → current — new unique constraint applied automatically, tasks kept', async () => {
      const db = DBS[0];
      freshDb(db);
      insertTasks(db);
      const r = schemaSync(db);
      assert(r.code === 0, `schema-sync exit ${r.code}: ${r.out.slice(-800)}`);
      assert(/only ADD unique constraints/.test(r.out), 'classifier message missing');
      assert(/tasks: covers a new optional column/.test(r.out), 'tasks (userId, uid) not recognised as a new optional column');
      assert(indexes(db, 'tasks').includes('tasks_userId_uid_key'), 'tasks unique index missing');
      assert(psql(db, 'SELECT count(*) FROM tasks WHERE uid IS NULL') === '2', 'tasks lost');
      assert(tableCount(db, ROOM_TABLES) === 0, 'the empty room tables were not dropped');
      // a second run is a no-op
      const again = schemaSync(db);
      assert(again.code === 0 && /Schema applied \(attempt 1/.test(again.out), `re-run: ${again.out.slice(-300)}`);
      return `applied, tasks kept, dumps ${dumps().length}`;
    });

    await check('schema-upgrade: duplicates for a new unique constraint → refused, nothing changed (room tables kept too)', async () => {
      const db = DBS[1];
      freshDb(db, OLD_SCHEMA_9_5);
      psql(db, 'DROP INDEX "tasks_userId_uid_key"');   // a drifted 9.5.x database
      psql(db, `SET session_replication_role = replica; INSERT INTO tasks(id,"userId",subject,uid,"updatedAt") VALUES ('t1','user1','a','dup',now()),('t2','user1','b','dup',now())`);
      insertRoom(db);
      const r = schemaSync(db);
      assert(r.code !== 0, 'schema-sync succeeded despite duplicates');
      assert(/duplicate value group/.test(r.out), `no duplicate message: ${r.out.slice(-500)}`);
      assert(!indexes(db, 'tasks').includes('tasks_userId_uid_key'), 'constraint was created');
      assert(tableCount(db, ROOM_TABLES) === 3 && psql(db, 'SELECT count(*) FROM resource_bookings') === '2', 'room tables changed');
      return 'refused with a duplicate report';
    });

    await check('schema-upgrade: dropped column with data stays fail-closed, even next to the retired room tables', async () => {
      const db = DBS[2];
      freshDb(db, OLD_SCHEMA_9_5);
      psql(db, 'ALTER TABLE tasks ADD COLUMN e2e_extra text');
      psql(db, `SET session_replication_role = replica; INSERT INTO tasks(id,"userId",subject,"updatedAt",e2e_extra) VALUES ('t1','user1','a',now(),'keep-me')`);
      insertRoom(db);
      insertRoomMailboxes(db);
      const r = schemaSync(db);
      assert(r.code !== 0, 'schema-sync applied a destructive change without COREMAIL_ALLOW_SCHEMA_DATA_LOSS');
      assert(/would DELETE DATA/.test(r.out), `no data-loss refusal: ${r.out.slice(-500)}`);
      assert(psql(db, 'SELECT e2e_extra FROM tasks') === 'keep-me', 'column data lost');
      assert(tableCount(db, ROOM_TABLES) === 3 && psql(db, 'SELECT count(*) FROM resource_bookings') === '2', 'room tables dropped by a refused update');
      assert(psql(db, 'SELECT count(*) FROM mailboxes') === '3' && psql(db, 'SELECT count(*) FROM messages') === '2', 'room mailbox deleted by a refused update');
      // the operator's opt-in: the room mailbox goes with the room tables on this path too
      const allowed = schemaSync(db, { COREMAIL_ALLOW_SCHEMA_DATA_LOSS: 'true' });
      assert(allowed.code === 0, `opt-in run exit ${allowed.code}: ${allowed.out.slice(-600)}`);
      assert(/Removed the mailboxes of the former room\/equipment mailboxes .*: 1 mailbox\(es\)/.test(allowed.out), `no clean-up on the opt-in path: ${allowed.out.slice(-600)}`);
      assert(psql(db, `SELECT string_agg(id, ',' ORDER BY id) FROM mailboxes`) === 'mb-orphan,mb-user', 'wrong mailboxes deleted on the opt-in path');
      assert(tableCount(db, ROOM_TABLES) === 0, 'room tables still present after the opt-in run');
      return 'refused, column, data and room rows kept; the opt-in run removed the room mailbox';
    });

    await check('schema-upgrade: 9.4.0 → current — tasks UNIQUE (userId, uid) over the new optional column is applied, tasks kept', async () => {
      const db = DBS[3];
      freshDb(db, OLD_SCHEMA_9_4);
      insertTasks(db);
      const r = schemaSync(db);
      assert(r.code === 0, `schema-sync exit ${r.code}: ${r.out.slice(-800)}`);
      assert(/tasks: covers a new optional column/.test(r.out), `no new-column message: ${r.out.slice(-500)}`);
      assert(indexes(db, 'tasks').includes('tasks_userId_uid_key'), 'tasks unique index missing');
      assert(psql(db, 'SELECT count(*) FROM tasks WHERE uid IS NULL') === '2', 'tasks lost');
      const again = schemaSync(db);
      assert(again.code === 0 && /Schema applied \(attempt 1/.test(again.out), `re-run: ${again.out.slice(-300)}`);
      return 'applied, 2 tasks of one user kept';
    });

    await check('schema-upgrade (10.0): 9.5.x with room rows → retired tables dropped after the dump, no opt-in needed', async () => {
      const db = DBS[4];
      freshDb(db, OLD_SCHEMA_9_5);
      insertTasks(db);
      insertRoom(db);
      insertRoomMailboxes(db);
      inApp(`rm -rf ${BACKUP_DIR}`);
      const r = schemaSync(db);   // without COREMAIL_ALLOW_SCHEMA_DATA_LOSS
      assert(r.code === 0, `schema-sync exit ${r.code}: ${r.out.slice(-800)}`);
      for (const t of ROOM_TABLES) assert(new RegExp(`Retiring table ${t} \\(\\d+ rows\\)`).test(r.out), `${t} not logged as retired: ${r.out.slice(-600)}`);
      assert(/Removed the mailboxes of the former room\/equipment mailboxes \(retired table resource_mailboxes\): 1 mailbox\(es\), 1 folder\(s\), 1 message\(s\)/.test(r.out),
        `room mailbox clean-up not logged: ${r.out.slice(-600)}`);
      assert(r.out.indexOf('Dump complete') < r.out.indexOf('Removed the mailboxes'), 'clean-up ran before the dump');
      assert(/retired tables dropped/.test(r.out), `no retirement result: ${r.out.slice(-400)}`);
      assert(tableCount(db, ROOM_TABLES) === 0, 'room tables still present');
      assert(psql(db, `SELECT string_agg(id, ',' ORDER BY id) FROM mailboxes`) === 'mb-orphan,mb-user', 'wrong mailboxes deleted');
      assert(psql(db, `SELECT string_agg(id, ',' ORDER BY id) FROM folders`) === 'f-user', 'room folder kept or user folder lost');
      assert(psql(db, `SELECT string_agg(id, ',' ORDER BY id) FROM messages`) === 'm-user', 'room message kept or user message lost');
      assert(psql(db, 'SELECT count(*) FROM attachments') === '0', 'room attachment row kept');
      assert(psql(db, `SELECT count(*) FROM pg_type WHERE typname = 'ResourceType'`) === '0', 'enum ResourceType still present');
      assert(psql(db, 'SELECT count(*) FROM tasks') === '2', 'tasks lost');
      const files = dumps();
      assert(files.length === 1, `expected one pre-migration dump, got ${files.join(', ')}`);
      const inDump = inApp(`zcat ${BACKUP_DIR}/${files[0]} | grep -c -E "^COPY public\\.resource_(mailboxes|calendars|bookings) "`);
      assert(inDump.out.trim() === '3', `dump does not hold the room tables: ${inDump.out.slice(-200)}`);
      const roomMailboxInDump = inApp(`zcat ${BACKUP_DIR}/${files[0]} | grep -c -E "^(mb-room|m-room)[[:space:]]"`);
      assert(roomMailboxInDump.out.trim() === '2', `dump does not hold the room mailbox / message: ${roomMailboxInDump.out.slice(-200)}`);
      const again = schemaSync(db);
      assert(again.code === 0 && /Schema applied \(attempt 1/.test(again.out), `re-run: ${again.out.slice(-300)}`);
      return `room tables retired, dump ${files[0]}`;
    });
  } finally {
    for (const db of DBS) { try { psql('postgres', `DROP DATABASE IF EXISTS ${db}`); } catch { /* ignore */ } }
    inApp(`rm -rf ${BACKUP_DIR} ${OLD_SCHEMA} ${OLD_SCHEMA_9_4} ${OLD_SCHEMA_9_5}`);
  }
}
